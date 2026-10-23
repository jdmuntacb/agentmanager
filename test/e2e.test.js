// Drives the real daemon (HTTP + WebSocket + PTYs) against test/fake-claude.js.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmgr-e2e-'));
const claudeLog = path.join(home, 'fake-claude.log');
const port = 20000 + Math.floor(Math.random() * 20000);

process.env.AGENTMGR_HOME = home;
process.env.AGENTMGR_PORT = String(port);
process.env.CLAUDE_CONFIG_DIR = path.join(home, 'claude');
process.env.FAKE_CLAUDE_LOG = claudeLog;
process.env.AGENTMGR_NO_GH = '1';
process.env.AGENTMGR_REMOTE = '0'; // the remote-access test turns it on explicitly
process.env.CODEX_HOME = path.join(home, 'codex');
process.env.FAKE_CODEX_LOG = path.join(home, 'fake-codex.log');
process.env.ANTIGRAVITY_CLI_HOME = path.join(home, 'agy');
process.env.FAKE_AGY_LOG = path.join(home, 'fake-agy.log');
fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({
    claudeBin: process.execPath,
    claudeArgs: [path.join(here, 'fake-claude.js')],
    gitRefreshSec: 1,
    conflictRefreshSec: 0,
    handoffIdleSec: 1,
    shell: '/bin/sh',
    engines: { codex: { bin: path.join(here, 'fake-codex.js') }, antigravity: { bin: path.join(here, 'fake-agy.js') } },
  }),
);

const { startServer } = await import('../src/server.js');
const { server, manager, hubLink } = await startServer({ port });
const base = `http://127.0.0.1:${port}`;

const call = async (method, route, body, headers = { 'x-agentmgr': '1' }) => {
  const res = await fetch(`${base}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const waitFor = async (fn, ms = 8000, label = 'condition') => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const agentNow = async (id) => (await call('GET', `/agents/${id}`)).body;
const launches = () => (fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test.after(async () => {
  hubLink.stop();
  await manager.stopAll({ final: true });
  server.closeAllConnections?.();
  server.close();
});

test('rejects writes without the client header and foreign origins', async () => {
  assert.equal((await call('POST', '/agents', { intent: 'x' }, {})).status, 403);
  assert.equal((await call('GET', '/agents', undefined, { origin: 'https://evil.example' })).status, 403);
});

test('agent lifecycle: spawn, track, terminal, close, resume, fresh session', async () => {
  const repo = path.join(home, 'src-repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });

  const created = await call('POST', '/agents', {
    intents: ['Fix MB-1 login bug https://jira.example.com/browse/MB-1', 'Add pagination'],
    dir: repo,
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.length, 2);
  const [a1, a2] = created.body;
  assert.notEqual(a1.sessionId, a2.sessionId);

  // Two intents on one folder: each gets an isolated worktree + branch.
  const run1 = await waitFor(async () => ((await agentNow(a1.id)).status === 'running' ? agentNow(a1.id) : null));
  const run2 = await waitFor(async () => ((await agentNow(a2.id)).status === 'running' ? agentNow(a2.id) : null));
  assert.ok(run1.worktree && run2.worktree);
  assert.notEqual(run1.workdir, run2.workdir);
  assert.equal(run1.sourceDir, fs.realpathSync(repo));
  assert.match(run1.git.branch, /^agent\/fix-mb-1-login-bug/);
  assert.equal(run1.repo, null);

  // First launch passes our session ID and the intent as the prompt.
  const first = await waitFor(() => launches().find((l) => l.args.includes(a1.sessionId)));
  assert.deepEqual(first.args.slice(-6), ['--session-id', a1.sessionId, '--name', run1.name, '--', a1.intent]);

  // Tracking: session PR link, bug from the intent (manual rank) and one mentioned in the transcript.
  const tracked = await waitFor(async () => {
    const a = (await call('POST', `/agents/${a1.id}/refresh`)).body;
    return a.prs.length && a.bugs.length >= 2 ? a : null;
  });
  assert.deepEqual(tracked.prs.map((p) => [p.number, p.source]), [[7, 'session']]);
  assert.deepEqual(tracked.bugs.map((b) => [b.key, b.source]).sort(), [['MB-1', 'intent'], ['MB-4242', 'mentioned']]);
  assert.equal(tracked.sessions[0].title, 'Fake session title');
  assert.deepEqual(
    [tracked.usage.input, tracked.usage.output, tracked.usage.cacheCreation, tracked.usage.cacheRead, tracked.usage.total],
    [12, 34, 56, 78, 180],
  );
  assert.equal(tracked.usage.io, 46, 'I/O = input + output only');

  // Terminal: backlog replay, input round trip.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${a1.id}`);
  const received = [];
  ws.on('message', (m) => received.push(JSON.parse(m.toString())));
  await new Promise((r) => ws.on('open', r));
  await waitFor(() => received.find((m) => m.t === 'hello'));
  assert.match(received[0].backlog, /fake-claude ready new/);
  ws.send(JSON.stringify({ t: 'i', d: 'hi' }));
  await waitFor(() => received.some((m) => m.t === 'o' && m.d.includes('echo:hi')));

  // Close keeps the session ID; bringing it back resumes it.
  const stopped = (await call('POST', `/agents/${a1.id}/stop`)).body;
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.sessionId, a1.sessionId);
  await waitFor(() => received.some((m) => m.t === 'exit'));

  const resumed = (await call('POST', `/agents/${a1.id}/start`, {})).body;
  assert.equal(resumed.status, 'running');
  await waitFor(() => launches().some((l) => l.args.join(' ').includes(`--resume ${a1.sessionId}`)));
  // The still-open terminal keeps streaming the restarted process.
  await waitFor(() => received.some((m) => m.t === 'o' && m.d.includes('resumed')));

  // Exiting from inside claude marks it exited, not stopped.
  ws.send(JSON.stringify({ t: 'i', d: 'exit' }));
  await waitFor(async () => (await agentNow(a1.id)).status === 'exited');
  ws.close();

  // Fresh session adds a new ID while keeping the old one resumable.
  const fresh = (await call('POST', `/agents/${a1.id}/start`, { fresh: true })).body;
  assert.equal(fresh.sessions.length, 2);
  assert.notEqual(fresh.sessionId, a1.sessionId);
  await call('POST', `/agents/${a1.id}/stop`);
  const back = (await call('POST', `/agents/${a1.id}/start`, { sessionId: a1.sessionId })).body;
  assert.equal(back.sessionId, a1.sessionId);

  // Manual links and dismissals.
  await call('POST', `/agents/${a1.id}/links`, { type: 'bug', value: 'MB-99' });
  let a = (await call('DELETE', `/agents/${a1.id}/links?type=bug&key=MB-4242`)).body;
  assert.deepEqual(a.bugs.map((b) => b.key).sort(), ['MB-1', 'MB-99']);
  a = (await call('POST', `/agents/${a1.id}/refresh`)).body;
  assert.ok(!a.bugs.some((b) => b.key === 'MB-4242'), 'dismissed bug should not come back');

  // Delete removes the worktree agentmgr created but never the user's folder.
  const del = (await call('DELETE', `/agents/${a1.id}?deleteWorkspace=1`)).body;
  assert.deepEqual(del.warnings, []);
  assert.ok(!fs.existsSync(run1.workdir));
  assert.ok(fs.existsSync(repo));
  assert.equal((await call('GET', `/agents/${a1.id}`)).status, 404);

  // State survives a restart of the store (session IDs kept, running -> stopped).
  await call('POST', `/agents/${a2.id}/stop`);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  assert.equal(saved.agents[a2.id].sessionId, a2.sessionId);
});

test('agents record their engine: Claude Code unless told otherwise; unknown engines are refused', async () => {
  assert.equal((await call('POST', '/agents', { intent: 'x', engine: 'nope' })).status, 400);
  const [a] = (await call('POST', '/agents', { intent: 'Engine check' })).body;
  assert.equal(a.engine, 'claude');
  await call('DELETE', `/agents/${a.id}?deleteWorkspace=1`);
});

test('agent without repo or folder gets a scratch workspace', async () => {
  const [a] = (await call('POST', '/agents', { intent: 'Write a haiku', start: false })).body;
  const ready = await waitFor(async () => ((await agentNow(a.id)).status === 'stopped' ? agentNow(a.id) : null));
  assert.ok(ready.workdir.startsWith(path.join(home, 'workspaces')));
  assert.ok(fs.existsSync(ready.workdir));
});

test('repo URL: one shared clone, one worktree + branch per intent', async () => {
  const origin = path.join(home, 'origin.git');
  const seed = path.join(home, 'seed');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, seed]);
  fs.writeFileSync(path.join(seed, 'README.md'), 'hi\n');
  execFileSync('git', ['add', '.'], { cwd: seed });
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed'], { cwd: seed });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: seed });

  const url = `file://${origin}`;
  const created = (await call('POST', '/agents', { intents: ['Task one', 'Task two'], repo: url, start: false })).body;
  const ready = await Promise.all(
    created.map((a) => waitFor(async () => ((await agentNow(a.id)).status === 'stopped' ? agentNow(a.id) : null), 20000)),
  );
  assert.equal(new Set(ready.map((a) => a.sourceDir)).size, 1, 'agents share one clone');
  assert.equal(new Set(ready.map((a) => a.workdir)).size, 2);
  for (const a of ready) {
    assert.equal(a.repo, url);
    assert.ok(fs.existsSync(path.join(a.workdir, 'README.md')));
    assert.match(a.git.branch, /^agent\/task-(one|two)-/);
  }
});

test('general session: no repo or folder, optional first question', async () => {
  const blank = (await call('POST', '/general', {})).body;
  assert.equal(blank.kind, 'general');
  const ran = await waitFor(async () => ((await agentNow(blank.id)).status === 'running' ? agentNow(blank.id) : null));
  assert.equal(ran.workdir, path.join(home, 'general'));
  assert.equal(ran.repo, null);
  const launch = await waitFor(() => launches().find((l) => l.args.includes(blank.sessionId)));
  assert.ok(!launch.args.includes('--'), 'no prompt when no question was given');

  const asked = (await call('POST', '/general', { question: 'What is a B-tree?' })).body;
  const l2 = await waitFor(() => launches().find((l) => l.args.includes(asked.sessionId)));
  assert.deepEqual(l2.args.slice(-2), ['--', 'What is a B-tree?']);
  assert.equal(asked.name, 'what-is-a-b-tree');
  await call('POST', `/agents/${blank.id}/stop`);
  await call('POST', `/agents/${asked.id}/stop`);
});

test("ancillary shell runs in the agent's folder", async () => {
  const [a] = (await call('POST', '/agents', { intent: 'Shell host', start: false })).body;
  const ready = await waitFor(async () => ((await agentNow(a.id)).status === 'stopped' ? agentNow(a.id) : null));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${a.id}?kind=shell`);
  let out = '';
  ws.on('message', (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.t === 'o') out += msg.d;
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'i', d: 'echo "dir=$(pwd -P) sum=$((40+2))"\r' }));
  await waitFor(() => out.includes('sum=42'));
  assert.ok(out.includes(`dir=${fs.realpathSync(ready.workdir)}`));
  assert.equal((await agentNow(a.id)).runtime.shell, true);
  assert.equal((await agentNow(a.id)).status, 'stopped', 'opening a shell does not start claude');
  ws.send(JSON.stringify({ t: 'i', d: 'exit\r' }));
  await waitFor(async () => (await agentNow(a.id)).runtime.shell === false);
  ws.close();
});

test('an agent can have several shells at once', async () => {
  const [a] = (await call('POST', '/agents', { intent: 'Many shells', start: false })).body;
  await waitFor(async () => (await agentNow(a.id)).status === 'stopped');
  const open = async (kind) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${a.id}?kind=${kind}`);
    ws.out = '';
    ws.on('message', (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.t === 'o') ws.out += msg.d;
    });
    await new Promise((r) => ws.on('open', r));
    return ws;
  };
  const one = await open('shell:1');
  assert.equal((await call('POST', `/agents/${a.id}/shell/new`)).body.n, 2);
  const two = await open('shell:2');
  one.send(JSON.stringify({ t: 'i', d: 'echo "pid=$$"\r' }));
  two.send(JSON.stringify({ t: 'i', d: 'echo "pid=$$"\r' }));
  const pid = (ws) => ws.out.match(/pid=(\d+)/)?.[1];
  await waitFor(() => pid(one) && pid(two), 8000, 'both shells');
  assert.notEqual(pid(one), pid(two), 'each tab is its own shell');
  assert.deepEqual((await agentNow(a.id)).runtime.shells, [1, 2]);

  await call('POST', `/agents/${a.id}/shell/drop`, { n: 1 });
  await waitFor(async () => (await agentNow(a.id)).runtime.shells.join() === '2', 8000, 'shell 1 closed');
  assert.equal((await call('POST', `/agents/${a.id}/shell/new`)).body.n, 1, 'freed numbers are reused');
  await call('POST', `/agents/${a.id}/shell/close`);
  await waitFor(async () => (await agentNow(a.id)).runtime.shell === false);
  one.close();
  two.close();
});

test('attached files are saved under the agent and their path returned', async () => {
  const [a] = (await call('POST', '/agents', { intent: 'Attach files', start: false })).body;
  const res = await fetch(`${base}/api/agents/${a.id}/upload?name=${encodeURIComponent('../screen shot.png')}`, {
    method: 'POST',
    headers: { 'x-agentmgr': '1', 'content-type': 'application/octet-stream' },
    body: Buffer.from([137, 80, 78, 71]),
  });
  const saved = await res.json();
  assert.equal(res.status, 200);
  assert.match(path.basename(saved.path), /-screen_shot\.png$/);
  assert.ok(saved.path.startsWith(path.join(home, 'uploads', a.id) + path.sep), 'stays inside the uploads folder');
  assert.deepEqual([...fs.readFileSync(saved.path)], [137, 80, 78, 71]);
  const empty = await fetch(`${base}/api/agents/${a.id}/upload?name=x`, { method: 'POST', headers: { 'x-agentmgr': '1' } });
  assert.equal(empty.status, 400);
});

test('daemon restart resumes running agents, not ones the user closed', async () => {
  const { AgentManager } = await import('../src/manager.js');
  const { Store } = await import('../src/store.js');
  const { loadConfig } = await import('../src/config.js');
  const ids = (await call('POST', '/agents', { intents: ['Keep me running', 'I will be closed'] })).body.map((a) => a.id);
  for (const id of ids) {
    const { sessionId } = await waitFor(async () => ((await agentNow(id)).status === 'running' ? agentNow(id) : null));
    // Wait until claude has actually started (and written its transcript) before shutting down.
    await waitFor(() => launches().some((l) => l.args.includes(sessionId)), 8000, `${id} launch`);
  }
  await call('POST', `/agents/${ids[1]}/stop`); // user closes this one

  await manager.stopAll(); // what a daemon shutdown does
  const stateFile = path.join(home, 'state.json');
  let m2 = new AgentManager({ store: new Store(stateFile), config: loadConfig() });
  test.after(() => m2.stopAll());
  assert.equal(m2.get(ids[0]).status, 'stopped');
  assert.equal(m2.get(ids[0]).desired, 'running');
  assert.equal(m2.get(ids[1]).desired, 'stopped');
  const resumed = await m2.resumeAll({ staggerMs: 0 });
  assert.ok(resumed.includes(ids[0]));
  assert.ok(!resumed.includes(ids[1]));
  const sid = m2.get(ids[0]).sessionId;
  await waitFor(() => launches().some((l) => l.args.join(' ').includes(`--resume ${sid}`)), 8000, 'resume launch');
  assert.equal(m2.get(ids[1]).runtime.running, false);

  // Crash / power loss: state still says "running" and nobody shut down cleanly.
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  await m2.stopAll();
  raw.agents[ids[1]].status = 'running';
  delete raw.agents[ids[1]].desired; // also covers state files from before `desired` existed
  fs.writeFileSync(stateFile, JSON.stringify(raw));
  m2 = new AgentManager({ store: new Store(stateFile), config: loadConfig() });
  assert.equal(m2.get(ids[1]).desired, 'running');
  assert.ok((await m2.resumeAll({ staggerMs: 0 })).includes(ids[1]));
  await m2.stopAll();
});

const makeOrigin = (name) => {
  const origin = path.join(home, `${name}.git`);
  const seed = path.join(home, `${name}-seed`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, seed]);
  fs.writeFileSync(path.join(seed, 'README.md'), 'hi\n');
  execFileSync('git', ['add', '.'], { cwd: seed });
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed'], { cwd: seed });
  execFileSync('git', ['push', '-q', 'origin', 'main'], { cwd: seed });
  return origin;
};
const baseFor = async (url) => {
  const crypto = await import('node:crypto');
  const { repoNameFromUrl } = await import('../src/git.js');
  return path.join(home, 'repos', `${repoNameFromUrl(url)}-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 6)}`);
};

test('clone reports progress, and an interrupted clone is repaired', async () => {
  const url = `file://${makeOrigin('progress')}`;
  // Leave behind what a killed clone looks like: a repo folder with no commits.
  const base = await baseFor(url);
  fs.mkdirSync(base, { recursive: true });
  execFileSync('git', ['init', '-q', base]);

  const events = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
  const phases = new Set();
  events.on('message', (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.t === 'agent' && msg.agent.progress) phases.add(msg.agent.progress.phase);
  });
  await new Promise((r) => events.on('open', r));
  const [a] = (await call('POST', '/agents', { intent: 'Progress check', repo: url, start: false })).body;
  const ready = await waitFor(async () => ((await agentNow(a.id)).status === 'stopped' ? agentNow(a.id) : null), 20000, 'setup');
  events.close();
  assert.ok(phases.has('Cloning') && phases.has('Checking out'), `phases seen: ${[...phases]}`);
  assert.equal(ready.progress, null);
  assert.ok(fs.existsSync(path.join(ready.workdir, 'README.md')));
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: ready.workdir }).toString(), '');
});

test('deleting an agent cancels a clone in progress', async () => {
  // A git server that accepts connections and never answers: the clone hangs.
  const net = await import('node:net');
  const sockets = [];
  const silent = net.createServer((s) => sockets.push(s));
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${silent.address().port}/stuck/repo.git`;
  try {
    const [a] = (await call('POST', '/agents', { intent: 'Never finishes cloning', repo: url })).body;
    await waitFor(() => sockets.length > 0, 8000, 'git to connect');
    assert.equal((await agentNow(a.id)).status, 'preparing');
    const t0 = Date.now();
    const del = await call('DELETE', `/agents/${a.id}`);
    assert.equal(del.status, 200);
    assert.ok(Date.now() - t0 < 5000, 'delete returns promptly');
    assert.equal((await call('GET', `/agents/${a.id}`)).status, 404);
    assert.ok(!fs.existsSync(await baseFor(url)), 'partial clone removed');
    assert.ok(!execFileSync('ps', ['-ax', '-o', 'command']).toString().includes(url), 'git process gone');
  } finally {
    sockets.forEach((s) => s.destroy());
    silent.close();
  }
});

test('failed setup can be retried', async () => {
  const origin = path.join(home, 'later.git');
  const url = `file://${origin}`;
  const [a] = (await call('POST', '/agents', { intent: 'Retry me', repo: url, start: false })).body;
  const failed = await waitFor(async () => ((await agentNow(a.id)).status === 'error' ? agentNow(a.id) : null), 15000, 'error');
  assert.match(failed.error, /git clone failed/);
  fs.renameSync(makeOrigin('later-src'), origin);
  const retried = (await call('POST', `/agents/${a.id}/start`, {})).body;
  assert.equal(retried.status, 'preparing');
  const sid = retried.sessionId;
  await waitFor(() => launches().some((l) => l.args.includes(sid)), 20000, 'launch after retry');
  assert.ok((await agentNow(a.id)).workdir);
  await call('POST', `/agents/${a.id}/stop`);
});

test('Jira keys in intent links are tracked as bugs', async () => {
  const link =
    'https://jira.issues.couchbase.com/jira/polaris/projects/IDEA/ideas/view/d2229b85-2dc4-49b3-b232-65879a8b360e?selectedIssue=IDEA-872';
  const [a] = (await call('POST', '/agents', { intent: `Study this request and propose the fix: ${link}`, start: false })).body;
  assert.deepEqual(a.bugs.map((b) => [b.key, b.url, b.source]), [['IDEA-872', link, 'intent']]);
});

test('setup interrupted by a daemon restart is retried on the next start', async () => {
  const { AgentManager } = await import('../src/manager.js');
  const { Store } = await import('../src/store.js');
  const { loadConfig } = await import('../src/config.js');
  const url = `file://${makeOrigin('interrupted')}`;
  const [a] = (await call('POST', '/agents', { intent: 'Interrupted setup', repo: url })).body;
  await waitFor(async () => (await agentNow(a.id)).status === 'running', 20000, 'first setup');
  await manager.stopAll();

  // Rewrite the saved state as if the daemon died halfway through cloning.
  const stateFile = path.join(home, 'state.json');
  const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  Object.assign(raw.agents[a.id], { status: 'preparing', workdir: null, desired: 'running' });
  fs.writeFileSync(stateFile, JSON.stringify(raw));

  const m3 = new AgentManager({ store: new Store(stateFile), config: loadConfig() });
  test.after(() => m3.stopAll());
  assert.equal(m3.get(a.id).status, 'error');
  assert.ok(m3.get(a.id).setupInterrupted);
  assert.ok((await m3.resumeAll({ staggerMs: 0 })).includes(a.id));
  await waitFor(() => m3.get(a.id).runtime.running, 20000, 'retried setup to launch');
  assert.ok(m3.get(a.id).workdir);
  assert.equal(m3.get(a.id).setupInterrupted, undefined);
});

const claudeJson = () => JSON.parse(fs.readFileSync(path.join(home, 'claude', '.claude.json'), 'utf8'));
const isTrusted = (dir) => Boolean(claudeJson().projects?.[fs.realpathSync(dir)]?.hasTrustDialogAccepted);

test('planning while cloning moves into the repo with the same session', async () => {
  const origin = path.join(home, 'plan-auto.git');
  const url = `file://${origin}`; // does not exist yet, so setup fails and we control when it succeeds
  const [a] = (await call('POST', '/agents', { intent: 'Plan then build', repo: url, plan: true })).body;
  assert.equal(a.runtime.planning, true);
  const planLaunch = await waitFor(() => launches().find((l) => l.args.includes(a.sessionId)), 8000, 'planning launch');
  assert.equal(planLaunch.cwd, fs.realpathSync(path.join(home, 'planning')));
  assert.ok(planLaunch.args.includes('--append-system-prompt'));
  assert.deepEqual(planLaunch.args.slice(-2), ['--', 'Plan then build']);
  assert.ok(isTrusted(path.join(home, 'planning')), 'planning folder pre-trusted');

  // Setup fails; planning keeps running and survives a retry.
  await waitFor(async () => (await agentNow(a.id)).status === 'error', 15000, 'setup error');
  assert.equal((await agentNow(a.id)).runtime.planning, true);
  fs.renameSync(makeOrigin('plan-auto-src'), origin);
  assert.equal((await call('POST', `/agents/${a.id}/start`, {})).body.status, 'preparing');

  // Nobody is attached and the session is idle: it moves into the workspace by itself.
  const moved = await waitFor(
    () => launches().find((l) => l.args.includes('--resume') && l.args.includes(a.sessionId) && !l.cwd.includes('planning')),
    20000,
    'handoff launch',
  );
  const now = await agentNow(a.id);
  assert.equal(moved.cwd, fs.realpathSync(now.workdir));
  assert.match(moved.args.at(-1), /^The repository is ready\. You are now in its working copy/);
  assert.equal(now.sessionId, a.sessionId);
  assert.equal(now.sessions.length, 1);
  assert.ok(now.planning.handedOffAt);
  assert.ok(isTrusted(now.workdir), 'workspace pre-trusted');
  const { transcriptPath } = await import('../src/tracker.js');
  assert.ok(fs.existsSync(transcriptPath(now.workdir, a.sessionId)), 'transcript moved into the workspace');
  await waitFor(async () => (await agentNow(a.id)).status === 'running' && !(await agentNow(a.id)).runtime.planning);
  await call('POST', `/agents/${a.id}/stop`);
});

test('planning waits for "Continue in repo" while a terminal is attached', async () => {
  const origin = path.join(home, 'plan-manual.git');
  const [a] = (await call('POST', '/agents', { intent: 'Plan with me', repo: `file://${origin}`, plan: true })).body;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${a.id}`);
  await new Promise((r) => ws.on('open', r));
  await waitFor(async () => (await agentNow(a.id)).status === 'error', 15000, 'setup error');
  fs.renameSync(makeOrigin('plan-manual-src'), origin);
  await call('POST', `/agents/${a.id}/start`, {});
  const ready = await waitFor(async () => ((await agentNow(a.id)).planning?.ready ? agentNow(a.id) : null), 20000, 'ready flag');
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal((await agentNow(a.id)).runtime.planning, true, 'still planning while attached');
  assert.ok(ready.workdir);

  const handed = (await call('POST', `/agents/${a.id}/handoff`)).body;
  assert.equal(handed.runtime.planning, false);
  assert.equal(handed.status, 'running');
  await waitFor(
    () => launches().some((l) => l.cwd === fs.realpathSync(ready.workdir) && l.args.includes('--resume')),
    8000,
    'resume in workspace',
  );
  ws.close();
  await call('POST', `/agents/${a.id}/stop`);
});

test('worktree option falls back to the folder itself when it is not a git repo', async () => {
  const plain = path.join(home, 'plain-folder');
  fs.mkdirSync(plain);
  const [a] = (await call('POST', '/agents', { intent: 'Plain folder', dir: plain, worktree: true, start: false })).body;
  const ready = await waitFor(async () => (['stopped', 'error'].includes((await agentNow(a.id)).status) ? agentNow(a.id) : null));
  assert.equal(ready.status, 'stopped', ready.error);
  assert.equal(ready.workdir, plain);
  assert.equal(ready.worktree, false);
});

test('agents branch from the fresh default branch, or from a requested base', async () => {
  const g = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd }).toString().trim();
  const origin = makeOrigin('based');
  const seed = path.join(home, 'based-seed');
  g(seed, 'checkout', '-q', '-b', 'release-1');
  fs.writeFileSync(path.join(seed, 'release.txt'), 'r1\n');
  g(seed, 'add', '.');
  g(seed, 'commit', '-q', '-m', 'release work');
  g(seed, 'tag', 'v1');
  g(seed, 'push', '-q', 'origin', 'release-1', 'v1');

  // The user's clone is behind origin/main and checked out on a local feature branch.
  const mine = path.join(home, 'based-mine');
  g(home, 'clone', '-q', origin, mine);
  g(seed, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(seed, 'new-on-main.txt'), 'x\n');
  g(seed, 'add', '.');
  g(seed, 'commit', '-q', '-m', 'newer main');
  g(seed, 'push', '-q', 'origin', 'main');
  g(mine, 'checkout', '-q', '-b', 'my-feature');
  fs.writeFileSync(path.join(mine, 'wip.txt'), 'wip\n');
  g(mine, 'add', '.');
  g(mine, 'commit', '-q', '-m', 'local wip');
  const originMain = g(origin, 'rev-parse', 'main');

  const make = async (body) => {
    const [a] = (await call('POST', '/agents', { dir: mine, worktree: true, start: false, ...body })).body;
    return waitFor(async () => (['stopped', 'error'].includes((await agentNow(a.id)).status) ? agentNow(a.id) : null), 15000);
  };

  const def = await make({ intent: 'Default base' });
  assert.equal(def.status, 'stopped', def.error);
  assert.equal(g(def.workdir, 'rev-parse', 'HEAD'), originMain, 'branched from the freshly fetched origin/main');
  assert.match(def.baseRef, /^origin\/main @ /);
  assert.ok(fs.existsSync(path.join(def.workdir, 'new-on-main.txt')));
  assert.ok(!fs.existsSync(path.join(def.workdir, 'wip.txt')), 'not from the checked-out feature branch');
  assert.throws(() => g(def.workdir, 'rev-parse', '--abbrev-ref', '@{u}'), 'agent branch has no upstream');
  assert.equal(g(mine, 'rev-parse', '--abbrev-ref', 'HEAD'), 'my-feature', "user's checkout untouched");

  const rel = await make({ intent: 'Release base', base: 'release-1' });
  assert.match(rel.baseRef, /^origin\/release-1 @ /);
  assert.ok(fs.existsSync(path.join(rel.workdir, 'release.txt')));

  const tag = await make({ intent: 'Tag base', base: 'v1' });
  assert.match(tag.baseRef, /^v1 @ /);

  const head = await make({ intent: 'Head base', base: 'HEAD' });
  assert.ok(fs.existsSync(path.join(head.workdir, 'wip.txt')), 'HEAD keeps the old behaviour');

  const bad = await make({ intent: 'Bad base', base: 'no-such-branch' });
  assert.equal(bad.status, 'error');
  assert.match(bad.error, /Base "no-such-branch" not found/);

  // Repo URLs honour --base too.
  const [u] = (await call('POST', '/agents', { intent: 'URL base', repo: `file://${origin}`, base: 'release-1', start: false })).body;
  const viaUrl = await waitFor(async () => (['stopped', 'error'].includes((await agentNow(u.id)).status) ? agentNow(u.id) : null), 15000);
  assert.match(viaUrl.baseRef ?? viaUrl.error, /^origin\/release-1 @ /);
});

test('task agents keep a brief and are told to follow skills and hooks; general sessions are not', async () => {
  const [a] = (await call('POST', '/agents', { intent: 'Brief me' })).body;
  const launch = await waitFor(() => launches().find((l) => l.args.includes(a.sessionId)), 8000, 'launch');
  const dir = fs.realpathSync(path.join(home, 'briefs', a.id));
  assert.equal(launch.args[launch.args.indexOf('--add-dir') + 1], dir);
  assert.ok(launch.args.includes(`Write(/${dir}/**)`) && launch.args.includes(`Edit(/${dir}/**)`));
  const sys = launch.args[launch.args.indexOf('--append-system-prompt') + 1];
  assert.match(sys, /## Problem[\s\S]*## Solution[\s\S]*## Diagram[\s\S]*## Checks/);
  assert.match(sys, /CLAUDE\.md[\s\S]*skills[\s\S]*hooks/);
  assert.match(sys, /Reviewed conventions/);

  const withBrief = await waitFor(async () => ((await agentNow(a.id)).brief ? agentNow(a.id) : null), 8000, 'brief');
  assert.equal(withBrief.brief.problem, 'Login fails for **SSO** users.');
  assert.match(withBrief.brief.diagram, /^flowchart LR/);
  assert.deepEqual(withBrief.brief.summary, { passed: 1, failed: 1, running: 1, pending: 1, total: 4 });
  assert.deepEqual(
    withBrief.brief.references.map((r) => [r.label, r.url, r.missing]),
    [
      ['PRD', 'https://confluence.example.com/prd/42', false],
      ['Tech Spec', null, true],
    ],
  );
  assert.match(sys, /## References[\s\S]*PRD and Tech Spec/);
  // Results: the agent's own outcome + blockers, plus tracked facts (its failing check).
  assert.equal(withBrief.results.outcome, 'blocked');
  const delivered = (source) => withBrief.results.delivered.filter((d) => d.source === source);
  assert.deepEqual(delivered('agent').map((d) => d.text), ['Root cause found in `auth/session.go`']);
  // The fake session links PR #7; once tracked it is listed as delivered too, never twice.
  assert.ok(delivered('tracked').every((d) => d.url === 'https://github.com/example/repo/pull/7'));
  assert.ok(delivered('tracked').length <= 1);
  assert.deepEqual(withBrief.results.blockers.map((b) => [b.text, b.source]), [
    ['staging credentials (needs: platform team)', 'agent'],
    ['Failing check: e2e login suite', 'checks'],
  ]);
  assert.match(sys, /## Results[\s\S]*Outcome:[\s\S]*Blocked by/);
  const raw = (await call('GET', `/agents/${a.id}/brief`)).body;
  assert.equal(raw.path, path.join(home, 'briefs', a.id, 'BRIEF.md'));
  assert.match(raw.markdown, /## Checks/);

  // Resumes get the instructions again (they only last for one process).
  await call('POST', `/agents/${a.id}/stop`);
  await call('POST', `/agents/${a.id}/start`, {});
  await waitFor(
    () => launches().filter((l) => l.args.includes(a.sessionId) && l.args.includes('--append-system-prompt')).length >= 2,
    8000,
    'resume with prompts',
  );

  const g = (await call('POST', '/general', { question: 'Just a question' })).body;
  const gl = await waitFor(() => launches().find((l) => l.args.includes(g.sessionId)), 8000, 'general launch');
  assert.ok(!gl.args.includes('--add-dir') && !gl.args.includes('--append-system-prompt'));

  await call('DELETE', `/agents/${a.id}`);
  assert.ok(!fs.existsSync(path.join(home, 'briefs', a.id)), 'brief removed with the agent');
  await call('POST', `/agents/${g.id}/stop`);
});

// ---------------------------------------------------------------- remote access (HTTPS, phone)

const https = await import('node:https');
const httpsReq = (rport, method, route, { headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      // agent: false: a fresh connection per request, so "listener closed" shows up as ECONNREFUSED.
      { host: '127.0.0.1', port: rport, method, path: route, rejectUnauthorized: false, agent: false, headers: { host: `127.0.0.1:${rport}`, ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, text: data, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body));
    else req.end();
  });
/** Read an SSE stream until `until(messages)` is true. */
const sseUntil = (rport, route, cookie, until, ms = 8000) =>
  new Promise((resolve, reject) => {
    const msgs = [];
    const req = https.request(
      { host: '127.0.0.1', port: rport, path: route, rejectUnauthorized: false, headers: { host: `127.0.0.1:${rport}`, cookie } },
      (res) => {
        if (res.statusCode !== 200) return reject(new Error(`SSE status ${res.statusCode}`));
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const line = frame.split('\n').find((l) => l.startsWith('data: '));
            if (line) msgs.push(JSON.parse(line.slice(6)));
          }
          if (until(msgs)) {
            req.destroy();
            resolve(msgs);
          }
        });
      },
    );
    req.on('error', (err) => (err.code === 'ECONNRESET' ? null : reject(err)));
    req.end();
    setTimeout(() => {
      req.destroy();
      reject(new Error(`SSE timed out; got ${JSON.stringify(msgs).slice(0, 300)}`));
    }, ms);
  });

test('remote access: HTTPS, token sign-in, local-only management, SSE terminal, revocation', async () => {
  const remote = await import('../src/remote.js');
  const rport = 20000 + Math.floor(Math.random() * 20000);
  remote.saveSettings({ extraHosts: ['127.0.0.1'] }); // the test connects over loopback
  const st = (await call('POST', '/remote/enable', { port: rport })).body;
  assert.equal(st.running, true);
  assert.equal(st.port, rport);
  assert.match(st.fingerprint, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  // Named curve, not explicit EC parameters (which browsers reject in the TLS handshake).
  const crypto = await import('node:crypto');
  const cert = new crypto.X509Certificate(fs.readFileSync(path.join(home, 'remote', 'cert.pem')));
  assert.ok(cert.raw.includes(Buffer.from('06082a8648ce3d030107', 'hex')), 'P-256 named curve OID present');
  const token = remote.accessToken();
  for (const u of st.urls) {
    assert.equal(u.loginUrl, `${u.url}#login=${token}`);
    assert.match(u.qr, /^<svg/);
  }

  // Page assets need no sign-in; the API does.
  assert.equal((await httpsReq(rport, 'GET', '/')).status, 200);
  assert.equal((await httpsReq(rport, 'GET', '/transport.js')).status, 200);
  assert.equal((await httpsReq(rport, 'GET', '/api/agents')).status, 401);
  assert.deepEqual((await httpsReq(rport, 'GET', '/api/session')).json, { remote: true, authenticated: false });

  // Only this machine's addresses are valid Hosts, and cross-site Origins are refused.
  assert.equal((await httpsReq(rport, 'GET', '/', { headers: { host: `evil.example:${rport}` } })).status, 403);
  assert.equal((await httpsReq(rport, 'GET', '/api/session', { headers: { origin: 'https://evil.example' } })).status, 403);

  const json = { 'content-type': 'application/json', 'x-agentmgr': '1' };
  assert.equal((await httpsReq(rport, 'POST', '/api/login', { headers: json, body: { token: 'nope' } })).status, 401);
  const ok = await httpsReq(rport, 'POST', '/api/login', { headers: json, body: { token } });
  assert.equal(ok.status, 200);
  const setCookie = ok.headers['set-cookie'][0];
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];

  assert.equal((await httpsReq(rport, 'GET', '/api/agents', { headers: { cookie } })).status, 200);
  assert.deepEqual((await httpsReq(rport, 'GET', '/api/session', { headers: { cookie } })).json, { remote: true, authenticated: true });
  // Managing remote access and shutting down are only possible on this computer.
  assert.equal((await httpsReq(rport, 'GET', '/api/remote', { headers: { cookie } })).status, 403);
  assert.equal((await httpsReq(rport, 'POST', '/api/shutdown', { headers: { ...json, cookie } })).status, 403);
  // Writes still need the client header.
  assert.equal((await httpsReq(rport, 'POST', '/api/flush', { headers: { cookie } })).status, 403);

  // The phone's terminal: SSE out, POST in.
  const [a] = (await call('POST', '/agents', { intent: 'Remote terminal' })).body;
  await waitFor(async () => (await agentNow(a.id)).status === 'running', 8000, 'running');
  await waitFor(() => launches().some((l) => l.args.includes(a.sessionId)), 8000, 'launch');
  setTimeout(() => httpsReq(rport, 'POST', `/api/agents/${a.id}/term/input`, { headers: { ...json, cookie }, body: { d: 'from-phone' } }), 500);
  const msgs = await sseUntil(rport, `/api/agents/${a.id}/term/stream`, cookie, (m) =>
    m.some((x) => x.t === 'o' && x.d.includes('echo:from-phone')),
  );
  assert.equal(msgs[0].t, 'hello');
  const events = await sseUntil(rport, '/api/events/stream', cookie, (m) => m.some((x) => x.t === 'snapshot'));
  assert.ok(events[0].agents.some((x) => x.id === a.id));
  await call('POST', `/agents/${a.id}/stop`);

  // Signing a device out, and rotating the token, both end access.
  const device = (await call('GET', '/remote')).body.devices[0];
  await call('DELETE', `/remote/devices/${device.id}`);
  assert.equal((await httpsReq(rport, 'GET', '/api/agents', { headers: { cookie } })).status, 401);
  const again = (await httpsReq(rport, 'POST', '/api/login', { headers: json, body: { token } })).headers['set-cookie'][0].split(';')[0];
  await call('POST', '/remote/rotate');
  assert.equal((await httpsReq(rport, 'GET', '/api/agents', { headers: { cookie: again } })).status, 401);
  assert.equal((await httpsReq(rport, 'POST', '/api/login', { headers: json, body: { token } })).status, 401, 'old token stops working');

  await call('POST', '/remote/disable');
  await assert.rejects(httpsReq(rport, 'GET', '/'), /ECONNREFUSED/);
});

test('browser tabs: any address, saved per agent, suggested from terminal output, relayed to signed-in devices only', async () => {
  const http = await import('node:http');
  const { WebSocketServer } = await import('ws');
  const json = { 'content-type': 'application/json', 'x-agentmgr': '1' };
  // A stand-in dev server on loopback: echoes what it received, redirects, sets a cookie, refuses framing.
  const seen = [];
  const dev = http.createServer((req, res) => {
    seen.push({ url: req.url, host: req.headers.host, cookie: req.headers.cookie ?? null, origin: req.headers.origin ?? null });
    if (req.url === '/redir') return res.writeHead(302, { location: `http://localhost:${dev.address().port}/after` }).end();
    res.writeHead(200, {
      'content-type': 'text/html',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'; script-src 'self'",
      'set-cookie': 'app=2; Domain=localhost; Path=/',
    });
    res.end(`<p>dev page ${req.url}</p>`);
  });
  new WebSocketServer({ server: dev }).on('connection', (ws, req) => {
    seen.push({ ws: true, origin: req.headers.origin, host: req.headers.host });
    ws.on('message', (m) => ws.send(`hmr:${m}`));
  });
  await new Promise((r) => dev.listen(0, '127.0.0.1', r));
  test.after(() => dev.close());
  const tp = dev.address().port;

  // Tabs live on the agent, so another device sees them; any http(s) address works.
  const [a] = (await call('POST', '/agents', { intent: 'Dev server', start: false })).body;
  await waitFor(async () => (await agentNow(a.id)).status === 'stopped');
  const t1 = await call('POST', `/agents/${a.id}/browsers`, { url: '5173' });
  assert.deepEqual(t1.body, { n: 1, url: 'http://localhost:5173/' });
  assert.deepEqual((await call('PATCH', `/agents/${a.id}/browsers/1`, { url: `0.0.0.0:${tp}/app` })).body, { n: 1, url: `http://localhost:${tp}/app` });
  const added = async (url) => (await call('POST', `/agents/${a.id}/browsers`, { url })).body;
  assert.equal((await added('example.com/docs')).url, 'https://example.com/docs');
  assert.equal((await added('10.0.0.5:8080')).url, 'http://10.0.0.5:8080/');
  assert.equal((await added('staging.internal:8443/x')).url, 'http://staging.internal:8443/x');
  assert.equal((await added('127.0.0.1:3000')).n, 5);
  for (const bad of ['ftp://example.com', 'https://user:pw@example.com', 'http://']) {
    assert.equal((await call('POST', `/agents/${a.id}/browsers`, { url: bad })).status, 400, bad);
  }
  assert.deepEqual((await agentNow(a.id)).browsers.map((t) => t.n), [1, 2, 3, 4, 5]);
  for (const n of [2, 3, 4, 5]) await call('DELETE', `/agents/${a.id}/browsers/${n}`);
  assert.deepEqual((await agentNow(a.id)).browsers, [{ n: 1, url: `http://localhost:${tp}/app` }]);

  // Addresses a dev server prints show up as suggestions.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${a.id}?kind=shell`);
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'i', d: 'printf "  \\033[32mLocal:\\033[0m   http://localhost:%s/\\n" 5173\r' }));
  await waitFor(async () => (await call('GET', `/agents/${a.id}/local-urls`)).body.includes('http://localhost:5173/'), 8000, 'suggestion');
  ws.send(JSON.stringify({ t: 'i', d: 'exit\r' }));
  ws.close();

  // On this computer the tab loads the address itself.
  assert.deepEqual((await call('POST', '/preview', { url: `localhost:${tp}/x?y=1` })).body, { src: `http://localhost:${tp}/x?y=1` });

  // From another device: a relay listener per address, behind the same sign-in.
  const remote = await import('../src/remote.js');
  const rport = 20000 + Math.floor(Math.random() * 20000);
  remote.saveSettings({ extraHosts: ['127.0.0.1'] });
  await call('POST', '/remote/enable', { port: rport });
  test.after(() => call('POST', '/remote/disable'));
  assert.equal((await httpsReq(rport, 'POST', '/api/preview', { headers: json, body: { url: String(tp) } })).status, 401);
  const login = await httpsReq(rport, 'POST', '/api/login', { headers: json, body: { token: remote.accessToken() } });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const { src } = (await httpsReq(rport, 'POST', '/api/preview', { headers: { ...json, cookie }, body: { url: `localhost:${tp}/x` } })).json;
  const pp = Number(src.match(/^https:\/\/127\.0\.0\.1:(\d+)\/x$/)?.[1]);
  assert.ok(pp && pp !== tp, src);
  assert.equal((await httpsReq(rport, 'POST', '/api/preview', { headers: { ...json, cookie }, body: { url: `localhost:${tp}/other` } })).json.src, `https://127.0.0.1:${pp}/other`, 'one listener per address');
  const lan = remote.lanAddresses()[0]?.address ?? '127.0.0.1';
  for (const own of [`localhost:${port}`, `localhost:${rport}`, `localhost:${pp}`, `${lan}:${rport}`, `127.0.0.1:${rport}`]) {
    assert.equal((await httpsReq(rport, 'POST', '/api/preview', { headers: { ...json, cookie }, body: { url: own } })).status, 400, `own port ${own}`);
  }
  // Other sites get a relay of their own (nothing is fetched until a device loads it).
  const site = (await httpsReq(rport, 'POST', '/api/preview', { headers: { ...json, cookie }, body: { url: 'https://example.com/docs?q=1' } })).json.src;
  assert.match(site, /^https:\/\/127\.0\.0\.1:\d+\/docs\?q=1$/);
  assert.notEqual(new URL(site).port, String(pp));
  // A server elsewhere on the network (here: this machine's LAN address) sees its own host name...
  const lanSeen = [];
  const lanDev = http.createServer((req, res) => res.end(JSON.stringify(lanSeen.push(req.headers.host) && req.headers.host)));
  await new Promise((r) => lanDev.listen(0, '0.0.0.0', r));
  test.after(() => lanDev.close());
  const lanSrc = (await httpsReq(rport, 'POST', '/api/preview', { headers: { ...json, cookie }, body: { url: `${lan}:${lanDev.address().port}/p` } })).json.src;
  const viaLan = await httpsReq(Number(new URL(lanSrc).port), 'GET', '/p', { headers: { cookie } });
  assert.equal(viaLan.json, `${lan}:${lanDev.address().port}`);
  // ...and, unlike a local dev server, has to present a valid certificate.
  const { key, cert } = remote.certificatePaths();
  const badTls = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (_q, res) => res.end('secret'));
  await new Promise((r) => badTls.listen(0, '0.0.0.0', r));
  test.after(() => badTls.close());
  const tlsSrc = (await httpsReq(rport, 'POST', '/api/preview', { headers: { ...json, cookie }, body: { url: `https://${lan}:${badTls.address().port}/` } })).json.src;
  const refused = await httpsReq(Number(new URL(tlsSrc).port), 'GET', '/', { headers: { cookie } });
  assert.equal(refused.status, 502);
  assert.doesNotMatch(refused.text, /secret/);

  assert.equal((await httpsReq(pp, 'GET', '/x')).status, 401, 'not signed in');
  assert.equal((await httpsReq(pp, 'GET', '/x', { headers: { cookie, host: `evil.example:${pp}` } })).status, 403);
  const page = await httpsReq(pp, 'GET', '/x', { headers: { cookie: `${cookie}; app=1`, origin: `https://127.0.0.1:${pp}` } });
  assert.equal(page.status, 200);
  assert.match(page.text, /dev page \/x/);
  assert.deepEqual(seen.at(-1), { url: '/x', host: `localhost:${tp}`, cookie: 'app=1', origin: `http://localhost:${tp}` }, 'the dev server never sees the Agent Manager cookie');
  assert.equal(page.headers['x-frame-options'], undefined);
  assert.equal(page.headers['content-security-policy'].trim(), "script-src 'self'");
  assert.deepEqual(page.headers['set-cookie'], ['app=2; Path=/']);
  const redir = await httpsReq(pp, 'GET', '/redir', { headers: { cookie } });
  assert.equal(redir.headers.location, `https://127.0.0.1:${pp}/after`);

  // WebSockets (hot reload) go through too.
  const hmr = new WebSocket(`wss://127.0.0.1:${pp}/hmr`, { rejectUnauthorized: false, headers: { cookie, origin: `https://127.0.0.1:${pp}` } });
  const reply = await new Promise((resolve, reject) => {
    hmr.on('open', () => hmr.send('ping'));
    hmr.on('message', (m) => resolve(m.toString()));
    hmr.on('error', reject);
  });
  hmr.close();
  assert.equal(reply, 'hmr:ping');
  assert.deepEqual(seen.find((x) => x.ws), { ws: true, origin: `http://localhost:${tp}`, host: `localhost:${tp}` });
  const noAuth = new WebSocket(`wss://127.0.0.1:${pp}/hmr`, { rejectUnauthorized: false });
  await new Promise((resolve) => noAuth.on('error', resolve).on('unexpected-response', (_q, res) => resolve(assert.equal(res.statusCode, 401))));

  // Nothing listening yet: a readable page, not a hang.
  const idle = await new Promise((r) => {
    const s = http.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => r(p));
    });
  });
  const idleSrc = (await httpsReq(rport, 'POST', '/api/preview', { headers: { ...json, cookie }, body: { url: String(idle) } })).json.src;
  const down = await httpsReq(Number(new URL(idleSrc).port), 'GET', '/', { headers: { cookie } });
  assert.equal(down.status, 502);
  assert.match(down.text, /Nothing is answering/);

  // Turning remote access off closes the relays...
  await call('POST', '/remote/disable');
  await assert.rejects(httpsReq(pp, 'GET', '/x', { headers: { cookie } }), /ECONNREFUSED/);
  // ...and a site gets the same port back afterwards, so devices needn't accept the certificate again.
  await call('POST', '/remote/enable', { port: rport });
  const back = (await httpsReq(rport, 'POST', '/api/preview', { headers: { ...json, cookie }, body: { url: `localhost:${tp}/x` } })).json.src;
  assert.equal(back, src);
  assert.equal((await httpsReq(pp, 'GET', '/x', { headers: { cookie } })).status, 200);
  await call('POST', '/remote/disable');
});

test('flush saves terminal scrollback so a restarted daemon shows it again', async () => {
  const { AgentManager } = await import('../src/manager.js');
  const { Store } = await import('../src/store.js');
  const { loadConfig } = await import('../src/config.js');
  const [a] = (await call('POST', '/agents', { intent: 'Remember my screen' })).body;
  await waitFor(() => launches().some((l) => l.args.includes(a.sessionId)), 8000, 'launch');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${a.id}`);
  let out = '';
  ws.on('message', (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.t === 'o' || msg.t === 'hello') out += msg.d ?? msg.backlog;
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'i', d: 'marker-before-restart' }));
  await waitFor(() => out.includes('echo:marker-before-restart'), 8000, 'echo');
  ws.close();

  // (The automatic 30s flush may already have saved it; either way the file must have it.)
  const r = (await call('POST', '/flush')).body;
  assert.ok(r.at);
  const file = path.join(home, 'scrollback', `${a.id}.log`);
  assert.match(fs.readFileSync(file, 'utf8'), /echo:marker-before-restart/);

  await manager.stopAll();
  const m4 = new AgentManager({ store: new Store(path.join(home, 'state.json')), config: loadConfig() });
  test.after(() => m4.stopAll());
  // Opening the closed agent's terminal shows the saved output...
  const view = m4.attach(a.id, { send() {} });
  assert.match(view.backlog, /echo:marker-before-restart/);
  view.detach();
  // ...and it carries over when the session resumes.
  m4.start(a.id);
  const resumed = m4.attach(a.id, { send() {} });
  assert.match(resumed.backlog, /echo:marker-before-restart[\s\S]*daemon restarted; session resumed/);
  resumed.detach();
});

/** Messages the manager tells agents, recorded before the outbox delivers them. */
function recordTold() {
  const told = [];
  const orig = manager.tell;
  manager.tell = function (ref, text, o) {
    told.push(text);
    return orig.call(this, ref, text, o);
  };
  test.after(() => (manager.tell = orig));
  return { told, restore: () => (manager.tell = orig) };
}

test('Human vs AI: the writer splits and answers the questions, another engine checks it, answers go to the agent', async () => {
  const { told, restore } = recordTold();
  const [a] = (await call('POST', '/agents', { intent: 'Weigh me up', start: false })).body;
  await waitFor(async () => (await agentNow(a.id)).status === 'stopped');
  const res = await call('POST', `/agents/${a.id}/docs/humanai`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const d = res.body.docs.humanai;
  assert.equal(d.data.title, 'Weigh me up');
  assert.equal(d.data.human.length, 5, 'at most five questions for the person');
  assert.equal(d.data.ai[0].answer, 'Safe call: yes.', 'tool-less call, JSON read from inside a code fence');
  assert.match(d.writer, /^Claude Code/);
  assert.match(d.critique.label, /^Codex/, 'a different engine double-checks it');
  assert.equal(d.critique.data.ai[0].verdict, 'disagree', 'the reviewer ran read-only too');
  assert.match(d.markdown, /## For you to decide[\s\S]*Second opinion \(Codex[^)]*\):\*\* ai — The ticket says A\.[\s\S]*## Answered by AI[\s\S]*Who owns the rollout\?/);

  // Answers are kept; sending needs at least one, and tells the agent (with the reviewer's doubts).
  assert.equal((await call('POST', `/agents/${a.id}/humanai/answers`, { answers: {}, send: true })).status, 400);
  const saved = await call('POST', `/agents/${a.id}/humanai/answers`, { answers: { 0: 'Go with A', 9: 'ignored' } });
  assert.deepEqual(saved.body.docs.humanai.answers, { 0: 'Go with A' });
  assert.match(saved.body.docs.humanai.markdown, /Your answer:\*\* Go with A/);
  const sent = await call('POST', `/agents/${a.id}/humanai/answers`, { answers: { 0: 'Go with A', 2: 'B' }, send: true });
  assert.equal(sent.status, 200);
  const msg = told.at(-1);
  restore();
  assert.match(msg, /1\. Human question 1\?\n {3}My answer: Go with A\n3\. Human question 3\?\n {3}My answer: B/);
  assert.match(msg, /second model doubted[\s\S]*Do the tests pass\? \(disagree: The log shows a failing test\.\)/);
  await call('DELETE', `/agents/${a.id}`);
});

test('plan review: the agent writes a plan and waits; approve or send it back from the page', async () => {
  const { told, restore } = recordTold();
  const [a] = (await call('POST', '/agents', { intent: 'Plan before code', planReview: true })).body;
  assert.equal(a.planReview.status, 'writing');
  const launch = await waitFor(() => launches().find((l) => l.args.includes(a.sessionId) && l.args.includes('--append-system-prompt')), 8000, 'launch');
  const sys = launch.args[launch.args.indexOf('--append-system-prompt') + 1];
  const planFile = path.join(fs.realpathSync(path.join(home, 'briefs', a.id)), 'PLAN.md');
  assert.ok(sys.includes(`write the plan to ${planFile}`) && sys.includes('Until a message starting with "Plan approved"'), sys);
  assert.equal((await call('POST', `/agents/${a.id}/plan/approve`, {})).status, 409, 'nothing to approve yet');

  // The agent writes its plan: it waits for review (and shows in the inbox).
  fs.writeFileSync(planFile, '# Plan: do it\n## Goal\nx\n');
  const ready = await waitFor(async () => ((await agentNow(a.id)).planReview.status === 'review' ? agentNow(a.id) : null), 8000, 'plan review');
  assert.match(ready.planReview.markdown, /# Plan: do it/);

  // Send it back: a note is required; the agent revises the file and it waits again.
  assert.equal((await call('POST', `/agents/${a.id}/plan/changes`, { note: ' ' })).status, 400);
  const back = await call('POST', `/agents/${a.id}/plan/changes`, { note: 'Add tests' });
  assert.equal(back.body.planReview.status, 'changes');
  assert.match(told.at(-1), /^Plan changes requested\. [\s\S]*Add tests$/);
  await new Promise((r) => setTimeout(r, 20));
  fs.writeFileSync(planFile, '# Plan: do it, with tests\n');
  await waitFor(async () => (await agentNow(a.id)).planReview.status === 'review', 8000, 'revised plan');

  const ok = await call('POST', `/agents/${a.id}/plan/approve`, { note: 'Ship it' });
  assert.equal(ok.body.planReview.status, 'approved');
  assert.match(told.at(-1), /^Plan approved\. Go ahead and implement it\.\n\nNotes from the review:\nShip it$/);
  // Progress edits after approval don't ask for review again, and a restart says it was approved.
  fs.writeFileSync(planFile, '# Plan: do it, with tests\n- [x] step 1\n');
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal((await agentNow(a.id)).planReview.status, 'approved');
  const { planApprovedPrompt } = await import('../src/brief.js');
  assert.ok(manager.launchOptions(manager.get(a.id)).instructions.includes(planApprovedPrompt(planFile)));

  // Turned on for a running agent: it is told; "Skip review" lets it go ahead.
  const [b] = (await call('POST', `/agents`, { intent: 'Late plan' })).body;
  await waitFor(() => launches().some((l) => l.args.includes(b.sessionId)), 8000, 'launch b');
  const on = await call('POST', `/agents/${b.id}/plan/review`, { on: true });
  assert.equal(on.body.planReview.status, 'writing');
  assert.match(told.at(-1), /^Change of process: The user reviews your implementation plan/);
  const off = await call('POST', `/agents/${b.id}/plan/review`, { on: false });
  assert.equal(off.body.planReview.status, 'approved');
  assert.match(told.at(-1), /^Plan approved\./);
  restore();
  await call('DELETE', `/agents/${a.id}`);
  await call('DELETE', `/agents/${b.id}`);
});

test("Explain summarizes the agent's live session in a separate tool-less Claude call", async () => {
  const [a] = (await call('POST', '/agents', { intent: 'Explain me please' })).body;
  await waitFor(() => launches().some((l) => l.args.includes(a.sessionId)), 8000, 'launch');
  await waitFor(async () => {
    const { transcriptPath } = await import('../src/tracker.js');
    const ag = await agentNow(a.id);
    return ag.workdir && fs.existsSync(transcriptPath(ag.workdir, a.sessionId));
  }, 8000, 'transcript');
  await call('POST', `/agents/${a.id}/stop`);
  const res = await call('POST', `/agents/${a.id}/explain`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const md = res.body.explanation.markdown;
  assert.match(md, /^### The ask\nSafe call\. Intent: Explain me please/);
  assert.match(md, /### Where it stands\nstatus: stopped/);
  assert.match(md, /saw agent text: true/, 'the conversation digest reached the explainer');
  assert.equal(res.body.explanation.pending, false);
  assert.equal(res.body.status, 'stopped', 'explaining did not restart the agent');
  assert.ok(!launches().some((l) => l.args.includes(a.sessionId) && l.args.includes('-p')), 'not run inside the agent session');

  // Insights: same context, Why / What / How / Now, stored separately.
  const ins = (await call('POST', `/agents/${a.id}/insights`)).body;
  assert.match(ins.insights.markdown, /^### Why\n- Safe call: Explain me please[\s\S]*### Now\n- saw agent text: true/);
  assert.match(ins.explanation.markdown, /^### The ask/, 'explanation kept');
});

test('backlog: per-project limit, done → review frees a slot, accept, reopen, pause, priority', async () => {
  const bl = async () => (await call('GET', '/backlog')).body;
  const item = async (id) => (await bl()).items.find((i) => i.id === id);
  const added = (await call('POST', '/backlog', { items: ['task one #done', 'task two', 'task three'], project: 'BL' })).body;
  assert.equal(added.length, 3);
  const [one, two, three] = added.map((i) => i.id);
  assert.ok(added.every((i) => i.projectName === 'BL' && i.worktree === true));

  // Two at a time per project (the default): one and two start, three waits.
  await waitFor(async () => (await item(one)).status !== 'queued' && (await item(two)).status === 'active', 8000, 'two active');
  assert.equal((await item(three)).status, 'queued');
  const a1 = (await item(one)).agent.id;
  assert.equal((await agentNow(a1)).backlogItem, one);
  assert.equal((await agentNow(a1)).projectInfo.name, 'BL');

  // Item one's agent reports done in its brief: review, and three takes the free slot.
  await waitFor(async () => (await item(one)).status === 'review', 10000, 'one in review');
  await waitFor(async () => (await item(three)).status === 'active', 8000, 'three started');

  const accepted = (await call('POST', `/backlog/${one}/accept`)).body;
  assert.equal(accepted.status, 'done');
  assert.ok(accepted.doneAt);

  // Reopen: the same agent session gets the note (typed in; it is still running).
  const reopened = (await call('POST', `/backlog/${one}/reopen`, { note: 'add a test' })).body;
  assert.equal(reopened.status, 'active');
  await waitFor(() => {
    const t = manager.attach(a1, { send() {} });
    t.detach();
    return t.backlog.includes('echo:Reopened from review: add a test');
  }, 8000, 'note typed into the session');

  // Pause: new items wait; "start" overrides; P1 sorts first.
  await call('POST', '/backlog/settings', { autoRun: false });
  const [four] = (await call('POST', '/backlog', { items: ['task four'], project: 'BL', priority: 1 })).body;
  const [five] = (await call('POST', '/backlog', { items: ['task five'], project: 'BL', priority: 3 })).body;
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal((await item(four.id)).status, 'queued');
  const order = (await bl()).items.map((i) => i.id);
  assert.ok(order.indexOf(four.id) < order.indexOf(five.id), 'P1 before P3');
  assert.equal((await call('POST', `/backlog/${four.id}/start`)).body.status, 'active');

  // Removing an agent cancels its item; cancelled items can be removed.
  const a2 = (await item(two)).agent.id;
  await call('DELETE', `/agents/${a2}`);
  assert.equal((await item(two)).status, 'cancelled');
  assert.equal((await call('DELETE', `/backlog/${two}`)).status, 200);
  assert.equal((await call('DELETE', `/backlog/${three}`)).status, 409, 'active items must be cancelled first');

  // Limit per project.
  const v = (await call('POST', '/backlog/settings', { project: 'BL', limit: 1, autoRun: true })).body;
  assert.equal(v.projects.find((p) => p.name === 'BL').limit, 1);
  // Persisted with the rest of the state.
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
  assert.ok(saved.backlog.items[four.id]);
  for (const it of (await bl()).items) if (['queued', 'active', 'review', 'blocked'].includes(it.status)) await call('POST', `/backlog/${it.id}/cancel`);
});

test('Slack alerts: needs input after the delay, once per episode; review; settings are local-only', async () => {
  const http = await import('node:http');
  const got = [];
  const hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      got.push(JSON.parse(b));
      res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${hook.address().port}/services/T/B/x`;
  try {
    const set = (await call('POST', '/notify', { webhookUrl: url, needsInputDelaySec: 0 })).body;
    assert.equal(set.enabled, true, 'configuring Slack turns alerts on');
    assert.ok(!JSON.stringify(set).includes('/services/T/B/x'), 'webhook masked in responses');
    assert.equal((await call('POST', '/notify', { webhookUrl: 'ftp://nope' })).status, 400);
    assert.equal((await call('POST', '/notify/test')).status, 200);
    await waitFor(() => got.some((m) => /Test from Agent Manager/.test(m.text)), 5000, 'test message');

    const [a] = (await call('POST', '/agents', { intent: 'Please #ask me', project: 'Alerts' })).body;
    await waitFor(() => got.some((m) => m.text.includes(a.name) && /needs input: Permission prompt/.test(m.text)), 15000, 'needs-input alert');
    const msg = got.find((m) => m.text.includes(a.name)).text;
    assert.match(msg, /\(Alerts\)/);
    assert.match(msg, new RegExp(`#${a.id}/term\\|Open in Agent Manager`));
    await new Promise((r) => setTimeout(r, 6000));
    assert.equal(got.filter((m) => m.text.includes(a.name) && /needs input/.test(m.text)).length, 1, 'once per episode');
    await call('POST', `/agents/${a.id}/stop`);

    // A backlog item reaching review is announced.
    const [it] = (await call('POST', '/backlog', { items: ['alert me #done'], project: 'Alerts' })).body;
    await waitFor(() => got.some((m) => /ready for your review/.test(m.text) && m.text.includes('alert me')), 15000, 'review alert');
    await call('POST', `/backlog/${it.id}/accept`);
  } finally {
    await call('POST', '/notify', { enabled: false });
    hook.close();
  }
});

test('Slack Workflow Builder webhooks get only the "text" variable, as plain text', async () => {
  const http = await import('node:http');
  const got = [];
  const hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      got.push({ path: req.url, body: JSON.parse(b) });
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  try {
    await call('POST', '/notify', { webhookUrl: `http://127.0.0.1:${hook.address().port}/triggers/T1/123/abc`, needsInputDelaySec: 0, enabled: true });
    assert.equal((await call('GET', '/notify')).body.workflow, true);
    const [a] = (await call('POST', '/agents', { intent: 'Workflow #ask', project: 'WF' })).body;
    await waitFor(() => got.some((m) => m.body.text?.includes(a.name) && /needs input/.test(m.body.text)), 15000, 'workflow alert');
    const m = got.find((x) => x.body.text.includes(a.name) && /needs input/.test(x.body.text));
    assert.deepEqual(Object.keys(m.body), ['text'], 'only the variables a workflow defines');
    assert.match(m.body.text, /needs input: Permission prompt/);
    assert.match(m.body.text, new RegExp(`Open: http://127\\.0\\.0\\.1:\\d+/#${a.id}/term`));
    assert.ok(!/<http[^>]*\|/.test(m.body.text), 'no Slack link markup in workflow text');
    await call('POST', `/agents/${a.id}/stop`);
  } finally {
    await call('POST', '/notify', { enabled: false });
    hook.close();
  }
});

test('agent priority P0-P3: default P2, set on create and later, validated, inherited from the backlog', async () => {
  const [a] = (await call('POST', '/agents', { intent: 'Default prio', start: false })).body;
  assert.equal(a.priority, 2);
  const [b] = (await call('POST', '/agents', { intent: 'Urgent one', start: false, priority: 'P0' })).body;
  assert.equal(b.priority, 0);
  assert.equal((await call('PATCH', `/agents/${a.id}`, { priority: 'P1' })).body.priority, 1);
  assert.equal((await call('PATCH', `/agents/${a.id}`, { priority: 7 })).status, 400);

  const [it] = (await call('POST', '/backlog', { items: ['prio item'], project: 'PRIO', priority: 'P0' })).body;
  assert.equal(it.priority, 0);
  const agentId = await waitFor(async () => (await call('GET', '/backlog')).body.items.find((x) => x.id === it.id)?.agent?.id, 8000, 'dispatch');
  assert.equal((await agentNow(agentId)).priority, 0, 'agent inherits the item priority');
  await call('PATCH', `/backlog/${it.id}`, { priority: 3 });
  assert.equal((await agentNow(agentId)).priority, 3, 'changing the item updates its agent');
  await call('POST', `/backlog/${it.id}/cancel`);
});

test('stakeholder documents: analysis, design, flow, proposal; stored per kind; unknown kinds rejected', async () => {
  const [a] = (await call('POST', '/agents', { intent: 'Doc me', start: false })).body;
  await waitFor(async () => (await agentNow(a.id)).status === 'stopped', 8000, 'ready');
  for (const kind of ['analysis', 'design', 'flow', 'proposal']) {
    const res = await call('POST', `/agents/${a.id}/docs/${kind}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const title = { analysis: 'Analysis', design: 'Design', flow: 'Flow', proposal: 'Proposal' }[kind];
    assert.match(res.body.docs[kind].markdown, new RegExp(`^# ${title}: Doc me\\n## Summary\\nSafe call\\.`));
    assert.equal(res.body.docs[kind].pending, false);
  }
  const all = await agentNow(a.id);
  assert.deepEqual(Object.keys(all.docs).sort(), ['analysis', 'design', 'flow', 'proposal']);
  assert.equal((await call('POST', `/agents/${a.id}/docs/novel`)).status, 400);
  assert.equal((await fetch(`${base}/share.html`)).status, 200);
});

test('documents in the background: returns at once, all five, at most two Claude calls at a time', async () => {
  const [a] = (await call('POST', '/agents', { intent: 'Background docs', start: false })).body;
  await waitFor(async () => (await agentNow(a.id)).status === 'stopped', 8000, 'ready');
  const t0 = Date.now();
  const res = await call('POST', `/agents/${a.id}/docs/all?background=1`);
  assert.equal(res.status, 200);
  assert.ok(Date.now() - t0 < 1500, 'returned without waiting');
  assert.ok(Object.values(res.body.docs).some((d) => d.pending), 'shows as pending');
  assert.ok(manager.summaryRunning <= 2, 'concurrency capped');
  const done = await waitFor(async () => {
    const ag = await agentNow(a.id);
    return ['analysis', 'design', 'flow', 'proposal', 'humanai'].every((k) => ag.docs?.[k]?.markdown && !ag.docs[k].pending) ? ag : null;
  }, 20000, 'all five written');
  assert.match(done.docs.flow.markdown, /^# Flow: Background docs/);
  assert.equal(manager.summaryRunning, 0);
  // A single kind in the background too.
  assert.ok((await call('POST', `/agents/${a.id}/docs/design?background=1`)).body.docs.design.pending);
  await waitFor(async () => !(await agentNow(a.id)).docs.design.pending, 10000, 'design rewritten');
});

test('project shortcuts: auto-assigned, "@cc"-style use fills the repo, rename, register ahead, backlog', async () => {
  const origin = makeOrigin('short-cut');
  const url = `file://${origin}`;
  const [a] = (await call('POST', '/agents', { intent: 'First on the repo', repo: url, start: false })).body;
  const ready = await waitFor(async () => ((await agentNow(a.id)).status === 'stopped' ? agentNow(a.id) : null), 15000, 'ready');
  const sc = ready.projectInfo.shortcut;
  assert.equal(sc, 'sc', 'short-cut -> sc');
  const listed = (await call('GET', '/projects')).body.find((p) => p.shortcut === sc);
  assert.equal(listed.repo, url);

  // Use the shortcut instead of the repo URL.
  const [b] = (await call('POST', '/agents', { intent: 'Second via shortcut', project: '@sc', start: false })).body;
  const b2 = await waitFor(async () => ((await agentNow(b.id)).status === 'stopped' ? agentNow(b.id) : null), 15000, 'second ready');
  assert.equal(b2.repo, url);
  assert.equal(b2.projectInfo.key, ready.projectInfo.key, 'same project');
  assert.equal(b2.project, null, 'not turned into a custom project name');

  // Rename; agents follow.
  assert.equal((await call('PATCH', `/projects/${sc}`, { shortcut: 'Bad Name' })).status, 400);
  assert.equal((await call('PATCH', `/projects/${sc}`, { shortcut: 'shc' })).body.shortcut, 'shc');
  assert.equal((await agentNow(a.id)).projectInfo.shortcut, 'shc');

  // Register ahead of time and use it from the backlog.
  const origin2 = makeOrigin('later-proj');
  assert.equal((await call('POST', '/projects', { shortcut: 'lp', repo: `file://${origin2}`, base: 'main' })).status, 200);
  assert.equal((await call('POST', '/projects', { shortcut: 'lp', repo: 'https://x/y.git' })).status, 409);
  await call('POST', '/backlog/settings', { autoRun: false }); // only checking how it is queued
  const [it] = (await call('POST', '/backlog', { items: ['queued via shortcut'], project: 'lp' })).body;
  assert.equal(it.repo, `file://${origin2}`);
  assert.equal(it.base, 'main');
  await call('POST', `/backlog/${it.id}/cancel`);
  await call('POST', '/backlog/settings', { autoRun: true });
});

// ------------------------------------------------------------------ v0.2: advanced features

const gitc = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd }).toString().trim();
const runningAgent = (id) => waitFor(async () => ((await agentNow(id)).status === 'running' ? agentNow(id) : null), 20000, `agent ${id} running`);

test('tell: a message is typed into the session once the agent is idle', async () => {
  const [a] = (await call('POST', '/agents', { intent: 'Tell me things' })).body;
  await runningAgent(a.id);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/term/${a.id}`);
  let out = '';
  ws.on('message', (m) => {
    const msg = JSON.parse(m.toString());
    if (msg.t === 'o' || msg.t === 'hello') out += msg.d ?? msg.backlog;
  });
  await new Promise((r) => ws.on('open', r));
  const told = (await call('POST', `/agents/${a.id}/tell`, { text: 'Please also update the docs' })).body;
  assert.equal(told.outbox, 1, 'queued');
  await waitFor(() => out.includes('echo:Please also update the docs'), 15000, 'message delivered');
  await waitFor(async () => (await agentNow(a.id)).outbox === 0, 5000, 'outbox drained');
  assert.equal((await call('POST', `/agents/${a.id}/tell`, { text: '  ' })).status, 400);
  ws.close();
  await call('POST', `/agents/${a.id}/stop`);
});

test('decision inbox: questions from QUESTIONS.md, answered back into the session', async () => {
  const [a] = (await call('POST', '/agents', { intent: 'Build the cache #question' })).body;
  await runningAgent(a.id);
  const launch = await waitFor(() => launches().find((l) => l.args.includes(a.sessionId)));
  const sys = launch.args[launch.args.indexOf('--append-system-prompt') + 1];
  assert.match(sys, /QUESTIONS\.md[\s\S]*Answer to your question/);

  const item = await waitFor(async () => (await call('GET', '/inbox')).body.find((i) => i.agentId === a.id && i.kind === 'question'), 8000, 'question in inbox');
  assert.equal(item.question.question, 'Postgres or SQLite for the cache?');
  assert.deepEqual(item.question.options, ['Postgres', 'SQLite']);
  assert.equal(item.question.default, 'SQLite');

  assert.equal((await call('POST', `/agents/${a.id}/answer`, { question: 'nope', text: 'x' })).status, 404);
  const answered = (await call('POST', `/agents/${a.id}/answer`, { question: item.question.id, text: 'Postgres' })).body;
  assert.equal(answered.questions[0].answer.text, 'Postgres');
  assert.ok(!(await call('GET', '/inbox')).body.some((i) => i.key === item.key), 'answered questions leave the inbox');
  await waitFor(async () => (await agentNow(a.id)).outbox === 0, 15000, 'answer delivered');
  await call('POST', `/agents/${a.id}/stop`);
});

test('decision inbox: live prompts list their choices and take a key', async () => {
  const [a] = (await call('POST', '/agents', { intent: 'Needs permission #ask' })).body;
  await runningAgent(a.id);
  const item = await waitFor(async () => (await call('GET', '/inbox')).body.find((i) => i.agentId === a.id && i.kind === 'prompt'), 10000, 'prompt in inbox');
  assert.equal(item.prompt.question, 'Do you want to proceed?');
  assert.deepEqual(item.prompt.choices.map((c) => c.key), ['1', '2']);
  assert.equal((await call('POST', `/agents/${a.id}/prompt-key`, { key: 'rm -rf' })).status, 400);
  assert.equal((await call('POST', `/agents/${a.id}/prompt-key`, { key: '1' })).status, 200);
  await call('POST', `/agents/${a.id}/stop`);
});

test('stuck detection: the same failure three times raises a finding with a nudge', async () => {
  const [a] = (await call('POST', '/agents', { intent: 'Fix auth #stuck' })).body;
  await runningAgent(a.id);
  const stuck = await waitFor(async () => {
    const v = await agentNow(a.id);
    return v.stuck.length ? v : null;
  }, 10000, 'stuck finding');
  const f = stuck.stuck[0];
  assert.equal(f.kind, 'repeat');
  assert.match(f.title, /Same failure 3×/);
  assert.match(f.nudge, /npm test/);
  assert.ok((await call('GET', '/inbox')).body.some((i) => i.kind === 'stuck' && i.agentId === a.id));

  const nudged = (await call('POST', `/agents/${a.id}/stuck/nudge`, { key: f.key })).body;
  assert.equal(nudged.stuck.length, 0, 'sending the nudge also dismisses the finding');
  assert.equal(nudged.outbox, 1);
  await call('POST', `/agents/${a.id}/stop`);
});

test('conflict radar: agents in one repo editing the same lines are flagged, with a merge order', async () => {
  const origin = makeOrigin('radar');
  fs.writeFileSync(path.join(home, 'radar-seed', 'app.js'), 'line1\nline2\nline3\nline4\nline5\n');
  gitc(path.join(home, 'radar-seed'), 'add', '.');
  gitc(path.join(home, 'radar-seed'), 'commit', '-q', '-m', 'app');
  gitc(path.join(home, 'radar-seed'), 'push', '-q', 'origin', 'main');
  const url = `file://${origin}`;
  const [x, y, z] = (await call('POST', '/agents', { intents: ['Change line two', 'Also change line two', 'Unrelated'], repo: url })).body;
  const [rx, ry, rz] = [await runningAgent(x.id), await runningAgent(y.id), await runningAgent(z.id)];
  fs.writeFileSync(path.join(rx.workdir, 'app.js'), 'line1\nLINE TWO\nline3\nline4\nline5\n');
  fs.writeFileSync(path.join(ry.workdir, 'app.js'), 'line1\nline 2!\nline3\nline4\nline5\nline6\n');
  fs.writeFileSync(path.join(rz.workdir, 'other.js'), 'x\n');

  const vx = await waitFor(async () => {
    const v = await agentNow(x.id);
    return v.conflicts.length ? v : null;
  }, 10000, 'conflict detected');
  assert.equal(vx.conflicts[0].agent.id, y.id);
  assert.deepEqual(vx.conflicts[0].files, [{ file: 'app.js', severity: 'lines' }]);
  assert.equal(vx.conflicts[0].mergeFirst, x.id, 'the smaller change lands first');
  assert.equal((await agentNow(z.id)).conflicts.length, 0, 'other files: no conflict');
  const inbox = (await call('GET', '/inbox')).body.filter((i) => i.kind === 'conflict' && [x.id, y.id].includes(i.agentId));
  assert.deepEqual(inbox.map((i) => i.agentId), [y.id], 'one inbox entry, on the agent that should rebase');

  const warned = (await call('POST', `/agents/${y.id}/conflicts/warn`, { with: x.id })).body;
  assert.equal(warned.outbox, 1);
  for (const id of [x.id, y.id, z.id]) await call('DELETE', `/agents/${id}?deleteWorkspace=1`);
  assert.equal((await call('GET', `/agents/${x.id}`)).status, 404);
});

test('checkpoints and forks: same code and conversation in a new worktree, new session ID', async () => {
  const origin = makeOrigin('forky');
  const [a] = (await call('POST', '/agents', { intent: 'Original work', repo: `file://${origin}` })).body;
  const ra = await runningAgent(a.id);
  fs.writeFileSync(path.join(ra.workdir, 'wip.txt'), 'uncommitted work\n');
  fs.writeFileSync(path.join(ra.workdir, 'README.md'), 'changed\n');

  const cp = (await call('POST', `/agents/${a.id}/checkpoint`)).body;
  assert.equal(cp.checkpoints.length, 1);
  assert.match(gitc(ra.workdir, 'show-ref'), new RegExp(`refs/agentmgr/${a.id}/1`));
  fs.writeFileSync(path.join(ra.workdir, 'later.txt'), 'after the checkpoint\n');

  // Fork from the checkpoint: the file written after it must not be there.
  const fork = (await call('POST', `/agents/${a.id}/fork`, { checkpoint: 1, instructions: 'Try a different approach' })).body;
  assert.equal(fork.forkOf.agentId, a.id);
  assert.notEqual(fork.sessionId, a.sessionId);
  const rf = await runningAgent(fork.id);
  assert.notEqual(rf.workdir, ra.workdir);
  assert.equal(fs.readFileSync(path.join(rf.workdir, 'wip.txt'), 'utf8'), 'uncommitted work\n');
  assert.equal(fs.readFileSync(path.join(rf.workdir, 'README.md'), 'utf8'), 'changed\n');
  assert.ok(!fs.existsSync(path.join(rf.workdir, 'later.txt')), 'state as of the checkpoint');
  assert.equal(fs.readFileSync(path.join(ra.workdir, 'later.txt'), 'utf8'), 'after the checkpoint\n', 'source untouched');

  // The fork resumes its own copy of the conversation.
  const { transcriptPath } = await import('../src/tracker.js');
  const copy = fs.readFileSync(transcriptPath(rf.workdir, fork.sessionId), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(copy.length > 0 && copy.every((r) => r.sessionId === fork.sessionId));
  const launch = await waitFor(() => launches().find((l) => l.args.includes(fork.sessionId)));
  assert.equal(launch.args[launch.args.indexOf('--resume') + 1], fork.sessionId);

  // Fork from now picks up later work too.
  const now2 = (await call('POST', `/agents/${a.id}/fork`, {})).body;
  const rn = await runningAgent(now2.id);
  assert.ok(fs.existsSync(path.join(rn.workdir, 'later.txt')));
  assert.equal((await call('POST', `/agents/${a.id}/fork`, { checkpoint: 99 })).status, 404);
  for (const id of [a.id, fork.id, now2.id]) await call('DELETE', `/agents/${id}?deleteWorkspace=1`);
  assert.equal(execFileSync('git', ['for-each-ref', `refs/agentmgr/${a.id}/`], { cwd: await baseFor(`file://${origin}`) }).toString(), '', 'checkpoint refs removed');
});

test('races: variants, scoreboard, tests in each worktree, diff, pick a winner and clean up', async () => {
  const origin = makeOrigin('race');
  assert.equal((await call('POST', '/races', { intent: 'Speed up', variants: [{}], repo: `file://${origin}` })).status, 400);
  const race = (await call('POST', '/races', {
    intent: 'Make it faster',
    repo: `file://${origin}`,
    testCommand: 'test -f ok.txt',
    variants: [{ label: 'opus', model: 'opus' }, { label: 'cache', instructions: 'Use a cache' }],
  })).body;
  assert.equal(race.rows.length, 2);
  const [p, q] = race.rows;
  assert.equal(p.variant.model, 'opus');
  assert.match((await agentNow(q.id)).intent, /Approach for this attempt: Use a cache/);
  const [rp, rq] = [await runningAgent(p.id), await runningAgent(q.id)];
  assert.ok(launches().find((l) => l.args.includes(rp.sessionId)).args.includes('opus'));
  fs.writeFileSync(path.join(rp.workdir, 'ok.txt'), 'yes\n');

  await call('POST', `/races/${race.id}/tests`);
  const done = await waitFor(async () => {
    const v = (await call('GET', `/races/${race.id}`)).body;
    return v.rows.every((r) => ['passed', 'failed'].includes(r.tests?.status)) ? v : null;
  }, 20000, 'tests finished');
  assert.equal(done.rows.find((r) => r.id === p.id).tests.status, 'passed');
  assert.equal(done.rows.find((r) => r.id === q.id).tests.status, 'failed');
  assert.match((await call('GET', `/races/${race.id}/diff/${p.id}`)).body.diff, /\+yes/);

  const picked = (await call('POST', `/races/${race.id}/pick`, { agent: p.id, cleanup: true })).body;
  assert.equal(picked.winner, p.id);
  assert.equal((await call('GET', `/agents/${q.id}`)).status, 404, 'the other attempt is deleted');
  assert.ok(!fs.existsSync(rq.workdir), 'with its worktree');
  assert.deepEqual(picked.rows.map((r) => r.id), [p.id]);
  await call('DELETE', `/races/${race.id}`);
  await call('DELETE', `/agents/${p.id}?deleteWorkspace=1`);
});

test('hub: invite, join, fleet view, signed reconnects, forged runners refused, remove, leave', async () => {
  const { startHub } = await import('../src/hub.js');
  const hubHome = path.join(home, 'hub');
  let hub = await startHub({ port: 0, home: hubHome, name: 'test-hub', log: () => {} });
  const hubPort = hub.server.address().port;
  const hubBase = `http://127.0.0.1:${hubPort}`;
  const hubCall = async (method, route, body, headers = { authorization: `Bearer ${hub.token}` }) => {
    const res = await fetch(`${hubBase}/api${route}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})), headers: res.headers };
  };
  const fleet = async () => (await hubCall('GET', '/fleet')).body;

  // Everything but sign-in and joining needs the token or a session; sessions need the header to write.
  assert.equal((await hubCall('GET', '/fleet', undefined, {})).status, 401);
  assert.equal((await hubCall('POST', '/login', { token: 'nope' }, {})).status, 401);
  const login = await hubCall('POST', '/login', { token: hub.token }, {});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await hubCall('GET', '/fleet', undefined, { cookie })).status, 200);
  assert.equal((await hubCall('POST', '/invites', undefined, { cookie })).status, 403, 'browser writes need x-agentmgr');
  assert.match((await fetch(hubBase)).headers.get('content-security-policy'), /script-src 'self'/);

  // A project-less agent so the fleet has something in it.
  const a = (await call('POST', '/agents', { intent: 'Hub visible work' })).body[0];
  await runningAgent(a.id);

  const inv = (await hubCall('POST', '/invites')).body;
  assert.match(inv.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(inv.command, `agentmgr join ${hubBase} ${inv.code}`);
  assert.equal((await call('POST', '/hub/join', { url: 'http://10.1.2.3:4720', code: inv.code })).status, 400, 'plain http off-tailnet refused');
  const joined = await call('POST', '/hub/join', { url: hubBase, code: inv.code.toLowerCase(), name: 'Mini Mac' });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.name, 'mini-mac');
  assert.deepEqual(joined.body.policy, { allow: ['view'], projects: ['*'] }, 'view only by default');
  const link = JSON.parse(fs.readFileSync(path.join(home, 'hub-link.json'), 'utf8'));
  assert.equal(fs.statSync(path.join(home, 'hub-link.json')).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(hub.store.data).includes('PRIVATE KEY'), 'the hub only ever has the public key');

  const seen = await waitFor(async () => {
    const f = await fleet();
    return f.runners[0]?.online && f.agents.some((x) => x.id === a.id) ? f : null;
  }, 10000, 'agent on the hub');
  assert.equal(seen.runners[0].name, 'mini-mac');
  assert.deepEqual(seen.runners[0].policy.allow, ['view']);
  const remoteAgent = seen.agents.find((x) => x.id === a.id);
  assert.equal(remoteAgent.runnerName, 'mini-mac');
  assert.ok(!('workdir' in remoteAgent) && !('sessionId' in remoteAgent), 'no local paths or session IDs');
  assert.equal((await call('GET', '/hub')).body.connected, true);
  // The link is managed on this computer only.
  assert.equal((await call('POST', '/hub/leave', {}, { 'x-agentmgr': '1', origin: 'https://evil.example' })).status, 403);

  // Codes work once.
  assert.equal((await hubCall('POST', '/join', { code: inv.code, name: 'x', publicKey: 'x' })).status, 401);

  // Someone who knows a runner ID but not its key is refused.
  const forged = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/ws/runner`);
    ws.on('message', (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.t === 'challenge') ws.send(JSON.stringify({ t: 'hello', runnerId: link.runnerId, sig: Buffer.from('x'.repeat(64)).toString('base64') }));
    });
    ws.on('close', (code) => resolve(code));
  });
  assert.equal(forged, 4401);
  assert.equal((await fleet()).runners[0].online, true, 'the real runner stays connected');

  // Hub restart: the runner reconnects by itself and resends its agents.
  await hub.close();
  await waitFor(async () => !(await call('GET', '/hub')).body.connected, 5000, 'link notices the hub is gone');
  hub = await startHub({ port: hubPort, home: hubHome, name: 'test-hub', log: () => {} });
  await waitFor(async () => (await fleet()).agents.some((x) => x.id === a.id), 15000, 'runner back after a hub restart');

  // Removed on the hub: the runner stops retrying and says why.
  assert.equal((await hubCall('DELETE', `/runners/mini-mac`)).status, 200);
  const removed = await waitFor(async () => {
    const st = (await call('GET', '/hub')).body;
    return !st.connected && /Removed/.test(st.lastError ?? '') ? st : null;
  }, 5000, 'runner told it was removed');
  assert.equal(removed.joined, true);
  assert.deepEqual((await fleet()).runners, []);

  // Join again, then leave: the hub forgets it and the key is deleted here.
  const inv2 = (await hubCall('POST', '/invites')).body;
  assert.equal((await call('POST', '/hub/join', { url: hubBase, code: inv2.code, name: 'mini' })).status, 200);
  await waitFor(async () => (await fleet()).runners[0]?.online, 5000, 'rejoined');
  assert.equal((await call('POST', '/hub/leave')).body.joined, false);
  await waitFor(async () => !(await fleet()).runners.length, 5000, 'hub forgot the machine');
  assert.ok(!fs.existsSync(path.join(home, 'hub-link.json')));
  assert.match(fs.readFileSync(path.join(home, 'hub-audit.log'), 'utf8'), /joined hub[\s\S]*connected to hub[\s\S]*refused this machine[\s\S]*left hub/);

  await hub.close();
  await call('DELETE', `/agents/${a.id}?deleteWorkspace=1`);
});

test('hub control: each machine decides; actions, new agents and terminals through the hub', async () => {
  const { startHub } = await import('../src/hub.js');
  const hubHome = path.join(home, 'hub2');
  const hub = await startHub({ port: 0, home: hubHome, name: 'test-hub', log: () => {} });
  const hubPort = hub.server.address().port;
  const hubBase = `http://127.0.0.1:${hubPort}`;
  const hubCall = async (method, route, body) => {
    const res = await fetch(`${hubBase}/api${route}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${hub.token}` }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  try {
    const fleet = async () => (await hubCall('GET', '/fleet')).body;
    const setPolicy = async (hubPolicy) => {
      hubLink.config.hub = hubPolicy;
      // Policy changes take effect when the link reconnects (a daemon restart, in real life).
      hubLink.disconnect();
      hubLink.connect();
      await waitFor(async () => {
        const r = (await fleet()).runners[0]; // one read: the link may drop between two
        return r?.online && JSON.stringify(r.policy?.allow) === JSON.stringify(hubPolicy.allow);
      }, 8000, 'policy on the hub');
    };
    const origin = makeOrigin('hubproj');
    assert.equal((await call('POST', '/projects', { shortcut: 'hubp', repo: `file://${origin}` })).status, 200);

    const [a] = (await call('POST', '/agents', { intent: 'Decide the cache #question' })).body;
    await runningAgent(a.id);
    const inv = (await hubCall('POST', '/invites')).body;
    assert.equal((await call('POST', '/hub/join', { url: hubBase, code: inv.code, name: 'mini' })).status, 200);
    const runner = await waitFor(async () => (await fleet()).runners[0]?.online && (await fleet()).runners[0], 8000, 'joined');
    const act = (action, args) => hubCall('POST', `/runners/${runner.id}/actions`, { action, args });

    // View only (the default): the hub refuses actions up front.
    const refused = await act('tell', { agent: a.id, text: 'hi' });
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /doesn't allow "control"/);
    assert.deepEqual((await fleet()).runners[0].projects, [], 'projects are only shared with "create"');

    await setPolicy({ allow: ['view', 'inbox', 'control', 'create', 'terminal'] });
    assert.ok((await fleet()).runners[0].projects.some((p) => p.shortcut === 'hubp'));

    // Answer a question from the fleet inbox.
    const item = await waitFor(async () => (await fleet()).inbox.find((i) => i.agentId === a.id && i.kind === 'question'), 10000, 'question on the hub');
    assert.equal(item.question.default, 'SQLite');
    const answered = await act('answer', { agent: a.id, question: item.question.id, text: 'Postgres' });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal((await agentNow(a.id)).questions[0].answer.text, 'Postgres');
    await waitFor(async () => !(await fleet()).inbox.some((i) => i.key === item.key), 8000, 'answered question leaves the fleet inbox');

    // Exact IDs only; unknown actions and agents are refused by the machine.
    assert.equal((await act('tell', { agent: a.id.slice(0, 3), text: 'x' })).status, 404);
    assert.equal((await act('rm', { agent: a.id })).status, 400);

    // Terminal: a signed-in browser on this hub's own page only.
    const cookie = (await fetch(`${hubBase}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: hub.token }) })).headers.get('set-cookie').split(';')[0];
    const termUrl = (kind = 'claude') => `ws://127.0.0.1:${hubPort}/ws/term?runner=${runner.id}&agent=${a.id}&kind=${kind}`;
    const refusedUpgrade = await new Promise((resolve) => {
      const ws = new WebSocket(termUrl(), { headers: { cookie, origin: 'https://evil.example' } });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.on('open', () => resolve('opened'));
    });
    assert.equal(refusedUpgrade, 403);
    const ws = new WebSocket(termUrl(), { headers: { cookie, origin: hubBase } });
    let out = '';
    let hello = null;
    ws.on('message', (m) => {
      const msg = JSON.parse(m.toString());
      if (msg.t === 'term-hello') hello = msg;
      if (msg.t === 'term-out') out += msg.d;
    });
    await waitFor(() => hello, 8000, 'terminal hello');
    assert.match(hello.backlog, /fake-claude ready/);
    ws.send(JSON.stringify({ t: 'in', d: 'via-hub' }));
    await waitFor(() => out.includes('echo:via-hub'), 8000, 'input round trip through the hub');
    ws.close();
    // Shells need their own permission.
    const shellErr = await new Promise((resolve) => {
      const s = new WebSocket(termUrl('shell'), { headers: { cookie, origin: hubBase } });
      s.on('message', (m) => JSON.parse(m.toString()).t === 'term-error' && resolve(JSON.parse(m.toString()).error));
    });
    assert.match(shellErr, /doesn't allow "shell"/);

    // Tell, stop, start.
    assert.equal((await act('tell', { agent: a.id, text: 'Also update the docs' })).status, 200);
    assert.equal((await act('stop', { agent: a.id })).status, 200);
    await waitFor(async () => (await agentNow(a.id)).status !== 'running', 8000, 'stopped');
    assert.equal((await act('start', { agent: a.id })).status, 200);
    await runningAgent(a.id);

    // New agents: registered, shared projects only, and never skipping permission prompts.
    assert.equal((await act('create', { project: 'nope', intent: 'x' })).status, 400);
    assert.equal((await act('create', { project: 'hubp', intent: 'x', permissionMode: 'bypassPermissions' })).status, 400);
    const created = await act('create', { project: 'hubp', intent: 'Add a changelog', priority: 1 });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const newId = created.body.agents[0].id;
    assert.equal((await agentNow(newId)).priority, 1);
    await waitFor(async () => (await fleet()).agents.some((x) => x.id === newId), 8000, 'new agent on the hub');

    // The machine checks again: a policy narrowed after the hub last heard it still wins.
    hubLink.config.hub = { allow: ['view'] };
    const late = await act('tell', { agent: a.id, text: 'x' });
    assert.equal(late.status, 403);
    assert.match(late.body.error, /This machine doesn't allow "control"/);
    // Projects too: an agent outside the shared projects is off limits.
    await setPolicy({ allow: ['view', 'control'], projects: ['hubp'] });
    assert.equal((await act('tell', { agent: a.id, text: 'x' })).status, 403);
    assert.ok(!(await fleet()).agents.some((x) => x.id === a.id), 'and not shown');
    assert.equal((await act('tell', { agent: newId, text: 'hello' })).status, 200);

    const auditLog = fs.readFileSync(path.join(home, 'hub-audit.log'), 'utf8');
    assert.match(auditLog, /hub did answer on/);
    assert.match(auditLog, /hub opened the claude terminal of/);
    assert.match(auditLog, /hub was refused tell on .*doesn't allow "control"/);
    assert.match(fs.readFileSync(path.join(hubHome, 'audit.log'), 'utf8'), /bearer did tell on mini\//);

    for (const id of [a.id, newId]) await call('DELETE', `/agents/${id}?deleteWorkspace=1`);
  } finally {
    // Even on failure: an open hub or link would keep the test process alive.
    await call('POST', '/hub/leave');
    delete hubLink.config.hub;
    await hub.close();
  }
});

test('hub sign-in links: only with "signin", one use, a minute, then the machine page is signed in', async () => {
  const { startHub } = await import('../src/hub.js');
  const remote = await import('../src/remote.js');
  const hubHome = path.join(home, 'hub-signin');
  const hub = await startHub({ port: 0, home: hubHome, name: 'test-hub', log: () => {} });
  const hubBase = `http://127.0.0.1:${hub.server.address().port}`;
  const hubCall = async (method, route, body) => {
    const res = await fetch(`${hubBase}/api${route}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${hub.token}` }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const rport = 20000 + Math.floor(Math.random() * 20000);
  remote.saveSettings({ extraHosts: ['127.0.0.1'] });
  try {
    assert.equal((await call('POST', '/remote/enable', { port: rport })).status, 200);
    const fleet = async () => (await hubCall('GET', '/fleet')).body;
    const inv = (await hubCall('POST', '/invites')).body;
    assert.equal((await call('POST', '/hub/join', { url: hubBase, code: inv.code, name: 'mini' })).status, 200);
    const runner = await waitFor(async () => (await fleet()).runners[0]?.online && (await fleet()).runners[0], 8000, 'joined');
    const signin = () => hubCall('POST', `/runners/${runner.id}/actions`, { action: 'signin', args: {} });
    const json = { 'content-type': 'application/json', 'x-agentmgr': '1' };
    const login = (body) => httpsReq(rport, 'POST', '/api/login', { headers: json, body });

    // Off unless the machine allows it, even with everything else.
    hubLink.config.hub = { allow: ['view', 'inbox', 'control', 'create', 'terminal', 'shell'] };
    hubLink.disconnect();
    hubLink.connect();
    await waitFor(async () => (await fleet()).runners[0]?.policy?.allow?.includes('shell'), 8000, 'policy');
    const refused = await signin();
    assert.equal(refused.status, 403);
    assert.match(refused.body.error, /doesn't allow "signin"/);

    hubLink.config.hub = { allow: ['view', 'signin'] };
    hubLink.disconnect();
    hubLink.connect();
    await waitFor(async () => (await fleet()).runners[0]?.policy?.allow?.includes('signin'), 8000, 'signin allowed');
    const got = await signin();
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.match(got.body.ticket, /^[\w-]{40,}$/);

    // A ticket signs a browser in once; the access token isn't needed.
    assert.equal((await login({ ticket: 'made-up' })).status, 401);
    const ok = await login({ ticket: got.body.ticket });
    assert.equal(ok.status, 200);
    const cookie = ok.headers['set-cookie'][0].split(';')[0];
    assert.equal((await httpsReq(rport, 'GET', '/api/agents', { headers: { cookie } })).status, 200);
    const replay = await login({ ticket: got.body.ticket });
    assert.equal(replay.status, 401);
    assert.match(replay.json.error, /used or has expired/);
    assert.ok((await call('GET', '/remote')).body.devices.some((d) => d.via === 'hub'), 'the device list says it came through the hub');

    // Expired after a minute.
    const late = (await signin()).body.ticket;
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      assert.equal((await login({ ticket: late })).status, 401);
    } finally {
      Date.now = realNow;
    }

    assert.match(fs.readFileSync(path.join(home, 'hub-audit.log'), 'utf8'), /hub did signin/);
    assert.match(fs.readFileSync(path.join(hubHome, 'audit.log'), 'utf8'), /bearer did signin on mini/);
  } finally {
    await call('POST', '/hub/leave');
    delete hubLink.config.hub;
    await call('POST', '/remote/disable');
    await hub.close();
  }
});

test('hub backlog: labels, capacity, review from the brief, stalled items, requeue, reopen', async () => {
  const crypto = await import('node:crypto');
  const { startHub } = await import('../src/hub.js');
  const { challengePayload } = await import('../src/fleet.js');
  const hubHome = path.join(home, 'hub3');
  const hub = await startHub({ port: 0, home: hubHome, name: 'test-hub', log: () => {} });
  const hubBase = `http://127.0.0.1:${hub.server.address().port}`;
  const hubCall = async (method, route, body) => {
    const res = await fetch(`${hubBase}/api${route}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${hub.token}` }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  const fleet = async () => (await hubCall('GET', '/fleet')).body;
  const item = async (id) => (await fleet()).backlog.items.find((x) => x.id === id);
  let box = null;
  const made = [];
  try {
    const origin = makeOrigin('hubbl');
    assert.equal((await call('POST', '/projects', { shortcut: 'hbl', repo: `file://${origin}` })).status, 200);
    hubLink.config.hub = { allow: ['view', 'control', 'create'], maxAgents: 4, perProject: 2 };
    const inv = (await hubCall('POST', '/invites')).body;
    assert.equal((await call('POST', '/hub/join', { url: hubBase, code: inv.code, name: 'mini' })).status, 200);
    const mini = await waitFor(async () => (await fleet()).runners.find((r) => r.online && r.projects.some((p) => p.shortcut === 'hbl')), 8000, 'mini shares hbl');
    const ref = mini.projects.find((p) => p.shortcut === 'hbl').ref;
    assert.match(ref, /^name:/, 'local file:// repos are known by name, never by path');

    // A second machine, played by the test: a GPU box with room for one agent.
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const joined = (await hubCall('POST', '/join', { code: (await hubCall('POST', '/invites')).body.code, name: 'gpu-box', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) })).body;
    const boxAgents = [];
    const rpcs = [];
    const boxState = () => ({
      t: 'state',
      agents: boxAgents,
      inbox: [],
      projects: [{ shortcut: 'bl', name: 'hubbl', ref, warm: true }],
      capacity: { max: 1, perProject: 1, busy: 0 },
      labels: ['os:linux', 'gpu'],
    });
    box = new WebSocket(`${hubBase.replace('http', 'ws')}/ws/runner`);
    box.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.t === 'challenge') {
        const sig = crypto.sign(null, challengePayload(m.nonce, joined.runnerId), privateKey).toString('base64');
        box.send(JSON.stringify({ t: 'hello', runnerId: joined.runnerId, sig, version: '0.3.0', policy: { allow: ['view', 'create'], projects: ['*'] } }));
      } else if (m.t === 'welcome') box.send(JSON.stringify(boxState()));
      else if (m.t === 'rpc') {
        rpcs.push(m);
        const id = `b0000${rpcs.length}`;
        boxAgents.push({ id, name: m.args.intent.slice(0, 20), status: 'running', project: 'hubbl', createdAt: new Date().toISOString() });
        box.send(JSON.stringify({ t: 'rpc-result', id: m.id, ok: true, result: { ok: true, agents: [{ id, name: m.args.intent }] } }));
        box.send(JSON.stringify(boxState()));
      }
    });
    await waitFor(async () => (await fleet()).backlog.projects.find((p) => p.ref === ref)?.machines.length === 2, 8000, 'both machines share the project');

    assert.equal((await hubCall('POST', '/backlog', { items: ['x'], project: 'nope' })).status, 400);
    assert.equal((await hubCall('POST', '/backlog', { items: ['x'], project: 'hbl', permissionMode: 'bypassPermissions' })).status, 400);

    // Labels: only the GPU box has "gpu" (and the project shortcut differs per machine).
    const [gpu] = (await hubCall('POST', '/backlog', { items: ['Train the model'], project: 'hbl', labels: 'gpu' })).body;
    await waitFor(async () => (await item(gpu.id)).status === 'active', 8000, 'gpu item started');
    assert.equal((await item(gpu.id)).runnerName, 'gpu-box');
    assert.equal(rpcs[0].action, 'create');
    assert.equal(rpcs[0].args.project, 'bl');

    // Capacity: the box is full now, so the next item goes to mini, and its agent's brief
    // saying done moves the item to review.
    const [doc] = (await hubCall('POST', '/backlog', { items: ['Write the changelog #done'], project: 'hbl', priority: 1 })).body;
    await waitFor(async () => (await item(doc.id)).status !== 'queued', 8000, 'doc item started');
    const started = await item(doc.id);
    assert.equal(started.runnerName, 'mini');
    made.push(started.agentId);
    assert.equal((await agentNow(started.agentId)).priority, 1);
    await waitFor(async () => (await item(doc.id)).status === 'review', 15000, 'doc item in review');
    assert.equal((await hubCall('POST', `/backlog/${doc.id}/accept`)).body.status, 'done');

    // Reopen: the note goes into the same session on mini (needs "control" there).
    assert.equal((await hubCall('POST', `/backlog/${doc.id}/reopen`, { note: 'add a date' })).body.status, 'active');
    await waitFor(() => {
      const t = manager.attach(started.agentId, { send() {} });
      t.detach();
      return t.backlog.includes('echo:Reopened from review: add a date');
    }, 8000, 'note typed into the session');

    // A third item waits, and says why: the box is full and mini lacks the label.
    const [wait] = (await hubCall('POST', '/backlog', { items: ['Another GPU job'], project: 'hbl', labels: ['gpu'] })).body;
    await waitFor(async () => /gpu-box is full/.test((await item(wait.id)).waiting ?? ''), 8000, 'waiting reason');
    assert.match((await item(wait.id)).waiting, /mini lacks gpu/);

    // The box drops: its item is stalled, not re-run elsewhere on its own.
    box.terminate();
    await waitFor(async () => (await item(gpu.id)).stalled, 8000, 'stalled');
    assert.equal((await item(gpu.id)).status, 'active');
    const requeued = (await hubCall('POST', `/backlog/${gpu.id}/requeue`)).body;
    assert.equal(requeued.status, 'queued');
    assert.deepEqual(requeued.avoid, [joined.runnerId]);

    const audit = fs.readFileSync(path.join(hubHome, 'audit.log'), 'utf8');
    assert.match(audit, /backlog started .* on gpu-box\/b00001/);
    assert.match(audit, /bearer queued /);
    assert.ok(fs.readFileSync(path.join(home, 'hub-audit.log'), 'utf8').includes('hub did create'));
    // Kept with the hub's state.
    assert.ok(JSON.parse(fs.readFileSync(path.join(hubHome, 'state.json'), 'utf8')).backlog.items[doc.id]);
  } finally {
    box?.terminate();
    for (const id of made) await call('DELETE', `/agents/${id}?deleteWorkspace=1`);
    await call('POST', '/hub/leave');
    delete hubLink.config.hub;
    await hub.close();
  }
});

test('hub Google sign-in: PKCE, state and nonce, allowed accounts only; the token still works', async () => {
  const http = await import('node:http');
  const crypto = await import('node:crypto');
  const { startHub } = await import('../src/hub.js');
  // A stand-in for Google's token endpoint: checks PKCE, returns an ID token for whoever we choose.
  let who = 'me@example.com';
  let nonceOverride = null;
  const challenges = new Map();
  const google = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const q = new URLSearchParams(body);
      const expect = challenges.get(q.get('code'));
      const ok = expect && crypto.createHash('sha256').update(q.get('code_verifier') ?? '').digest('base64url') === expect.challenge && q.get('client_secret') === 'secret';
      res.setHeader('content-type', 'application/json');
      if (!ok) return res.end(JSON.stringify({ error: 'invalid_grant' }), (res.statusCode = 400));
      const claims = { iss: 'https://accounts.google.com', aud: 'cid', exp: Math.floor(Date.now() / 1000) + 300, nonce: nonceOverride ?? expect.nonce, email: who, email_verified: true };
      res.end(JSON.stringify({ id_token: `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig` }));
    });
  });
  await new Promise((r) => google.listen(0, '127.0.0.1', r));
  const gUrl = `http://127.0.0.1:${google.address().port}`;
  const hub = await startHub({
    port: 0,
    home: path.join(home, 'hub-google'),
    log: () => {},
    google: { clientId: 'cid', clientSecret: 'secret', emails: ['me@example.com'], authUrl: `${gUrl}/auth`, tokenUrl: `${gUrl}/token` },
  });
  const hubBase = `http://127.0.0.1:${hub.server.address().port}`;
  const signIn = async ({ tamperState = false } = {}) => {
    const start = await fetch(`${hubBase}/api/auth/google`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const to = new URL(start.headers.get('location'));
    assert.equal(to.origin + to.pathname, `${gUrl}/auth`);
    assert.equal(to.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(to.searchParams.get('redirect_uri'), `${hubBase}/api/auth/google/callback`);
    const code = crypto.randomBytes(8).toString('hex');
    challenges.set(code, { challenge: to.searchParams.get('code_challenge'), nonce: to.searchParams.get('nonce') });
    const flowCookie = start.headers.get('set-cookie').split(';')[0];
    const state = tamperState ? 'forged' : to.searchParams.get('state');
    const cb = await fetch(`${hubBase}/api/auth/google/callback?code=${code}&state=${state}`, { headers: { cookie: flowCookie }, redirect: 'manual' });
    const session = (cb.headers.getSetCookie?.() ?? []).find((c) => c.startsWith('agentmgr_hub='));
    return { page: await cb.text(), session: session?.split(';')[0] ?? null, raw: session };
  };
  try {
    assert.equal((await (await fetch(`${hubBase}/api/session`)).json()).google, true);

    const ok = await signIn();
    assert.ok(ok.session, ok.page);
    assert.match(ok.raw, /HttpOnly; SameSite=Strict/);
    assert.match(ok.page, /http-equiv="refresh" content="0;url=\/"/);
    assert.equal((await fetch(`${hubBase}/api/fleet`, { headers: { cookie: ok.session } })).status, 200);

    // Not on the list, forged state, replayed nonce: no session.
    who = 'someone@else.com';
    const refused = await signIn();
    assert.equal(refused.session, null);
    assert.match(decodeURIComponent(refused.page), /someone@else\.com is not allowed/);
    who = 'me@example.com';
    assert.equal((await signIn({ tamperState: true })).session, null);
    nonceOverride = 'old';
    assert.match(decodeURIComponent((await signIn()).page), /expired or replayed/);
    nonceOverride = null;

    // The access token still signs in too.
    const t = await fetch(`${hubBase}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: hub.token }) });
    assert.equal(t.status, 200);
    assert.match(fs.readFileSync(path.join(home, 'hub-google', 'audit.log'), 'utf8'), /Google sign-in by me@example\.com[\s\S]*refused Google sign-in by someone@else\.com/);
  } finally {
    await hub.close();
    google.close();
  }
});

test('Codex agents: launch with instructions, adopt the session Codex picks, usage, prompts, trust, resume, Explain', async () => {
  const codexLaunches = () => (fs.existsSync(process.env.FAKE_CODEX_LOG) ? fs.readFileSync(process.env.FAKE_CODEX_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const dir = fs.mkdtempSync(path.join(home, 'codex-proj-'));
  assert.equal((await call('POST', '/agents', { intent: 'x', engine: 'codex', permissionMode: 'bogus' })).status, 400);
  const [a] = (await call('POST', '/agents', { intent: 'Fix the login #ask #stuck', dir, engine: 'codex', plan: true })).body;
  assert.equal(a.engine, 'codex');
  await runningAgent(a.id);

  // One launch: Codex options, the brief folder, and the instructions in the first message.
  const first = await waitFor(() => codexLaunches()[0], 8000, 'codex launched');
  assert.deepEqual(first.args.slice(0, 5), ['--no-alt-screen', '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request']);
  assert.ok(first.args.includes('--add-dir'));
  assert.match(first.args.at(-1), /BRIEF\.md[\s\S]*Your task:\nFix the login/);

  // Codex picked the session ID; the agent adopts it, and its log feeds usage, links and stuck detection.
  const v = await waitFor(async () => {
    const x = await agentNow(a.id);
    return x.usage.io > 0 && x.prs.length && x.stuck.length ? x : null;
  }, 15000, 'session adopted and scanned');
  const sid = v.sessionId;
  assert.ok(fs.readdirSync(path.join(process.env.CODEX_HOME, 'sessions'), { recursive: true }).some((f) => String(f).endsWith(`-${sid}.jsonl`)));
  assert.equal(v.usage.input, 40, 'cached tokens are counted apart');
  assert.equal(v.usage.cacheRead, 60);
  assert.equal(v.costUsd, null, 'Codex records no cost');
  assert.ok(v.prs.some((p) => p.url === 'https://github.com/example/repo/pull/9'));
  assert.ok(v.bugs.some((b) => b.key === 'MB-77'));
  assert.equal(v.stuck[0].kind, 'repeat');

  // Its approval menu reaches the inbox with Codex's own choices.
  const prompted = await waitFor(async () => ((await agentNow(a.id)).runtime.prompt?.choices.length ? agentNow(a.id) : null), 10000, 'codex prompt');
  assert.equal(prompted.runtime.attention, 'Permission prompt');
  assert.deepEqual(prompted.runtime.prompt.choices.map((c) => c.label), ['Yes, proceed', "Yes, and don't ask again for commands that start with `npm test`", 'No, and tell Codex what to do differently']);

  // The folder is pre-trusted in Codex's own config.
  assert.ok(fs.readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8').includes(`[projects."${fs.realpathSync(v.workdir)}"]`));

  // Stop and start: Codex resumes the same session.
  await call('POST', `/agents/${a.id}/stop`);
  await waitFor(async () => (await agentNow(a.id)).status !== 'running', 8000, 'stopped');
  await call('POST', `/agents/${a.id}/start`);
  await runningAgent(a.id);
  const again = await waitFor(() => codexLaunches().length > 1 && codexLaunches().at(-1), 8000, 'codex resumed');
  assert.equal(again.args[0], 'resume');
  assert.ok(again.args.includes(sid));
  assert.equal((await agentNow(a.id)).sessionId, sid);

  // Explain runs through codex exec (read-only, unsaved), over the Codex session.
  const ex = await call('POST', `/agents/${a.id}/explain`);
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.match(JSON.stringify(ex.body), /Safe call\.[\s\S]*saw: true/);

  // Not available for Codex yet.
  assert.equal((await call('POST', `/agents/${a.id}/fork`, {})).status, 409);
  await call('DELETE', `/agents/${a.id}?deleteWorkspace=1`);
});

test('Antigravity agents: instructions in the first message, adopt the conversation agy picks, prompts, trust, resume, Explain', async () => {
  const agyLaunches = () => (fs.existsSync(process.env.FAKE_AGY_LOG) ? fs.readFileSync(process.env.FAKE_AGY_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const dir = fs.mkdtempSync(path.join(home, 'agy-proj-'));
  const [a] = (await call('POST', '/agents', { intent: 'Fix the login #ask #stuck', dir, engine: 'antigravity', permissionMode: 'acceptEdits' })).body;
  assert.equal(a.engine, 'antigravity');
  await runningAgent(a.id);

  const first = await waitFor(() => agyLaunches()[0], 8000, 'agy launched');
  assert.deepEqual(first.args.slice(0, 2), ['--mode', 'accept-edits']);
  assert.ok(first.args.includes('--add-dir'));
  assert.match(first.args.at(-1), /^--prompt-interactive=[\s\S]*BRIEF\.md[\s\S]*Your task:\nFix the login/);

  // agy picked the conversation ID; the agent adopts it, and its transcript feeds usage, links and stuck detection.
  const v = await waitFor(async () => {
    const x = await agentNow(a.id);
    return x.usage.io > 0 && x.prs.length && x.stuck.length ? x : null;
  }, 15000, 'conversation adopted and scanned');
  const sid = v.sessionId;
  assert.ok(fs.existsSync(path.join(process.env.ANTIGRAVITY_CLI_HOME, 'brain', sid)));
  assert.equal(v.usage.cacheRead, 60 * 4, 'cached tokens are counted apart');
  assert.equal(v.costUsd, null);
  assert.ok(v.prs.some((p) => p.url === 'https://github.com/example/repo/pull/9'));
  assert.ok(v.bugs.some((b) => b.key === 'MB-77'));
  assert.equal(v.stuck[0].kind, 'repeat');

  // Its command menu reaches the inbox with agy's own choices.
  const prompted = await waitFor(async () => ((await agentNow(a.id)).runtime.prompt?.choices.length ? agentNow(a.id) : null), 10000, 'agy prompt');
  assert.equal(prompted.runtime.attention, 'Permission prompt');
  assert.equal(prompted.runtime.prompt.question, 'Run this command? npm test');
  assert.equal(prompted.runtime.prompt.choices.length, 4);
  assert.equal(prompted.runtime.prompt.choices[0].label, 'Yes, run command');

  // The folder is pre-trusted in agy's settings.
  const settings = JSON.parse(fs.readFileSync(path.join(process.env.ANTIGRAVITY_CLI_HOME, 'settings.json'), 'utf8'));
  assert.ok(settings.trustedWorkspaces.includes(fs.realpathSync(v.workdir)));

  // Stop and start: agy resumes the same conversation.
  await call('POST', `/agents/${a.id}/stop`);
  await waitFor(async () => (await agentNow(a.id)).status !== 'running', 8000, 'stopped');
  await call('POST', `/agents/${a.id}/start`);
  await runningAgent(a.id);
  const again = await waitFor(() => agyLaunches().length > 1 && agyLaunches().at(-1), 8000, 'agy resumed');
  assert.deepEqual(again.args.slice(0, 2), ['--conversation', sid]);
  assert.equal((await agentNow(a.id)).sessionId, sid);

  // Explain runs in agy's print mode, in plan mode, over the transcript.
  const ex = await call('POST', `/agents/${a.id}/explain`);
  assert.equal(ex.status, 200, JSON.stringify(ex.body));
  assert.match(JSON.stringify(ex.body), /Safe call\.[\s\S]*saw: true/);

  assert.equal((await call('POST', `/agents/${a.id}/fork`, {})).status, 409);
  await call('DELETE', `/agents/${a.id}?deleteWorkspace=1`);
});

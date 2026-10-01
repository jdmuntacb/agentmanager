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
fs.writeFileSync(
  path.join(home, 'config.json'),
  JSON.stringify({
    claudeBin: process.execPath,
    claudeArgs: [path.join(here, 'fake-claude.js')],
    gitRefreshSec: 1,
    handoffIdleSec: 1,
    shell: '/bin/sh',
  }),
);

const { startServer } = await import('../src/server.js');
const { server, manager } = await startServer({ port });
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
  await manager.stopAll();
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
    await waitFor(() => got.some((m) => m.body.text?.includes(a.name)), 15000, 'workflow alert');
    const m = got.find((x) => x.body.text.includes(a.name));
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

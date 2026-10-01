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

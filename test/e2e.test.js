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
  JSON.stringify({ claudeBin: process.execPath, claudeArgs: [path.join(here, 'fake-claude.js')], gitRefreshSec: 1 }),
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
const waitFor = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
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

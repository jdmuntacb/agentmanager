import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { repoNameFromUrl, isRemoteUrl } from '../src/git.js';
import { slugify } from '../src/manager.js';
import { Store } from '../src/store.js';
import { claudeProjectDir, extractRefs, scanTranscript } from '../src/tracker.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentmgr-unit-'));

test('slugify', () => {
  assert.equal(slugify('Fix the flaky Login test!!'), 'fix-the-flaky-login-test');
  assert.equal(slugify('***'), 'agent');
  assert.ok(slugify('a'.repeat(100)).length <= 30);
});

test('repo helpers', () => {
  assert.equal(repoNameFromUrl('https://github.com/org/my-repo.git'), 'my-repo');
  assert.equal(repoNameFromUrl('git@github.com:org/other.git'), 'other');
  assert.ok(isRemoteUrl('git@github.com:org/other.git'));
  assert.ok(isRemoteUrl('https://github.com/org/x'));
  assert.ok(!isRemoteUrl('~/projects/x'));
  assert.ok(!isRemoteUrl('/abs/path'));
});

test('claudeProjectDir encodes the cwd the way Claude Code does', () => {
  const d = tmp();
  const real = fs.realpathSync(d);
  assert.ok(claudeProjectDir(d).endsWith(real.replace(/[^a-zA-Z0-9]/g, '-')));
});

test('extractRefs finds PR, Jira, GitHub issue and custom bug refs', () => {
  const text = `Opened https://github.com/acme/api/pull/12 for https://acme.atlassian.net/browse/PROJ-9,
    see https://github.com/acme/api/issues/5 and MB-777. UTF-8 is not a bug.`;
  const { prs, bugs } = extractRefs(text, ['\\bMB-\\d+\\b']);
  assert.deepEqual(prs.map((p) => [p.repo, p.number]), [['acme/api', 12]]);
  assert.deepEqual(bugs.map((b) => b.key).sort(), ['MB-777', 'PROJ-9', 'acme/api#5']);
});

test('extractRefs finds Jira keys in board, Polaris and issue links', () => {
  const polaris =
    'https://jira.issues.couchbase.com/jira/polaris/projects/IDEA/ideas/view/d2229b85-2dc4-49b3-b232-65879a8b360e?selectedIssue=IDEA-872';
  const text = `Study this request and propose the fix: ${polaris}. Also https://acme.atlassian.net/jira/software/projects/PROJ/issues/PROJ-12, see (https://acme.atlassian.net/browse/OPS-3).`;
  const { bugs } = extractRefs(text);
  assert.deepEqual(
    bugs.map((b) => [b.key, b.url]),
    [
      ['IDEA-872', polaris],
      ['PROJ-12', 'https://acme.atlassian.net/jira/software/projects/PROJ/issues/PROJ-12'],
      ['OPS-3', 'https://acme.atlassian.net/browse/OPS-3'],
    ],
  );
  // A custom pattern does not duplicate a key already found in a link.
  assert.equal(extractRefs(`${polaris} IDEA-872`, ['\\bIDEA-\\d+\\b']).bugs.length, 1);
});

test('parseProgress reads git progress lines', async () => {
  const { parseProgress } = await import('../src/git.js');
  assert.deepEqual(parseProgress('Receiving objects:  45% (10/22), 2.10 GiB | 2.40 MiB/s'), {
    step: 'Receiving objects',
    percent: 45,
    size: '2.10 GiB',
    rate: '2.40 MiB/s',
  });
  assert.equal(parseProgress('remote: Counting objects:  12% (1/8)').percent, 12);
  assert.equal(parseProgress('Cloning into x...'), null);
});

test('scanTranscript reads incrementally and ignores partial lines', () => {
  const file = path.join(tmp(), 's.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'ai-title', aiTitle: 'T1' }) + '\n{"type":"pr-li');
  const cursor = { offset: 0 };
  let r = scanTranscript(file, cursor);
  assert.equal(r.title, 'T1');
  assert.equal(r.prs.length, 0);
  fs.appendFileSync(file, 'nk","prNumber":3,"prUrl":"https://github.com/a/b/pull/3"}\n');
  r = scanTranscript(file, cursor);
  assert.equal(r.title, null);
  assert.deepEqual(r.prs.map((p) => [p.number, p.source]), [[3, 'session']]);
  assert.equal(scanTranscript(file, cursor).prs.length, 0);
});

test('Store persists and resolves by id, prefix and name', () => {
  const file = path.join(tmp(), 'state.json');
  const s = new Store(file);
  s.put({ id: 'abc123', name: 'alpha', createdAt: '2026-01-01' });
  s.put({ id: 'abd456', name: 'beta', createdAt: '2026-01-02' });
  const s2 = new Store(file);
  assert.equal(s2.resolve('abc123').name, 'alpha');
  assert.equal(s2.resolve('abd').name, 'beta');
  assert.equal(s2.resolve('ab'), undefined); // ambiguous prefix
  assert.equal(s2.resolve('beta').id, 'abd456');
});

test('trustFolder pre-accepts the trust prompt without touching other settings', async () => {
  const cfg = tmp();
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const { trustFolder } = await import('../src/trust.js');
    const file = path.join(cfg, '.claude.json');
    fs.writeFileSync(file, JSON.stringify({ theme: 'dark', projects: { '/x': { allowedTools: ['Read'] } } }));
    const dir = tmp();
    assert.equal(trustFolder(dir), true);
    assert.equal(trustFolder(dir), false, 'second call is a no-op');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(data.theme, 'dark');
    assert.deepEqual(data.projects['/x'], { allowedTools: ['Read'] });
    assert.equal(data.projects[fs.realpathSync(dir)].hasTrustDialogAccepted, true);
    assert.ok(fs.existsSync(`${file}.agentmgr-backup`));
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
});

test('token usage counts each API response once and includes subagents', async () => {
  const { sumUsage } = await import('../src/tracker.js');
  const file = path.join(tmp(), 'u.jsonl');
  const line = (id, out) =>
    JSON.stringify({
      type: 'assistant',
      message: { id, usage: { input_tokens: 10, output_tokens: out, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } },
    }) + '\n';
  // msg_1 is split over two lines (two content blocks); the last line has the final output count.
  fs.writeFileSync(file, line('msg_1', 5) + line('msg_1', 7) + line('msg_2', 3));
  const cursor = { offset: 0 };
  scanTranscript(file, cursor);
  const sub = path.join(tmp(), 'sub.jsonl');
  fs.writeFileSync(sub, line('msg_s', 1));
  const subCursor = { offset: 0 };
  scanTranscript(sub, subCursor);
  assert.deepEqual(sumUsage(cursor.usage, subCursor.usage), {
    input: 30,
    output: 11,
    cacheCreation: 300,
    cacheRead: 3000,
    requests: 3,
    io: 41,
    total: 3341,
  });
});

test('parseBrief reads the four sections, check states and the mermaid block', async () => {
  const { parseBrief } = await import('../src/brief.js');
  const b = parseBrief(`# Brief
## Problem Statement
Users can't log in.

## Approach
Refresh tokens **before** expiry.

## Design / Flow / Architecture
\`\`\`mermaid
sequenceDiagram
  A->>B: refresh
\`\`\`
Notes under the diagram.

## Verification
- [x] unit tests
- [!] e2e
- [~] lint
- [ ] manual check
- not a check line

## Something else
ignored
`);
  assert.equal(b.problem, "Users can't log in.");
  assert.equal(b.solution, 'Refresh tokens **before** expiry.');
  assert.equal(b.diagram, 'sequenceDiagram\n  A->>B: refresh');
  assert.equal(b.diagramNotes, 'Notes under the diagram.');
  assert.deepEqual(b.checks.map((c) => c.state), ['passed', 'failed', 'running', 'pending']);
  assert.deepEqual(b.summary, { passed: 1, failed: 1, running: 1, pending: 1, total: 4 });
  assert.equal(parseBrief('## Diagram\nno code block here').diagram, null);
});

test('parseBrief reads PRD / Tech Spec references from the linked Jira issue', async () => {
  const { parseBrief } = await import('../src/brief.js');
  const b = parseBrief(`## Problem
x
## References
- **PRD**: [Fusion rebalance PRD](https://confluence.example.com/prd/123) — must finish within 30 minutes
- **Tech Spec**: none on IDEA-872
- **Design doc**: https://docs.example.com/d/9 - sequence of the accelerator handoff
- Related: [MB-1](https://jira.example.com/browse/MB-1)
`);
  assert.deepEqual(
    b.references.map((r) => [r.label, r.title, r.url, r.highlight, r.key, r.missing]),
    [
      ['PRD', 'Fusion rebalance PRD', 'https://confluence.example.com/prd/123', 'must finish within 30 minutes', true, false],
      ['Tech Spec', null, null, 'none on IDEA-872', true, true],
      ['Design doc', null, 'https://docs.example.com/d/9', 'sequence of the accelerator handoff', true, false],
      ['Related', 'MB-1', 'https://jira.example.com/browse/MB-1', '', false, false],
    ],
  );
});

test('sessionDigest keeps the ask, the agent\'s words and one line per action', async () => {
  const { sessionDigest } = await import('../src/tracker.js');
  const file = path.join(tmp(), 'd.jsonl');
  const rec = (type, content, extra = {}) => JSON.stringify({ type, message: { content }, ...extra }) + '\n';
  fs.writeFileSync(
    file,
    rec('user', 'Fix the login bug <system-reminder>noise</system-reminder>') +
      rec('assistant', [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'Plan: 1) reproduce 2) fix' }]) +
      rec('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'go test ./auth', description: 'Run auth tests' } }]) +
      rec('user', [{ type: 'tool_result', content: 'huge output' }]) +
      rec('assistant', [{ type: 'tool_use', name: 'Edit', input: { file_path: '/r/auth/session.go' } }]) +
      rec('assistant', [{ type: 'tool_use', name: 'Read', input: { file_path: '/r/x.go' } }]) +
      rec('assistant', [{ type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Keep the old API?' }] } }]) +
      rec('user', 'meta', { isMeta: true }),
  );
  const d = sessionDigest(file);
  assert.deepEqual(d.digest.split('\n'), [
    '[user] Fix the login bug',
    '[agent] Plan: 1) reproduce 2) fix',
    '[action] ran: Run auth tests',
    '[action] edited /r/auth/session.go',
    '[action] asked the user: Keep the old API?',
  ]);
  assert.deepEqual(d.edited, ['/r/auth/session.go']);
  // Over budget: the first request stays, the oldest of the rest are dropped.
  const small = sessionDigest(file, { maxChars: 90 }).digest.split('\n');
  assert.equal(small[0], '[user] Fix the login bug');
  assert.match(small[1], /earlier events omitted/);
  assert.equal(small.at(-1), '[action] asked the user: Keep the old API?');
});

test('projectOf groups by repo across URL forms, then folder, general and other', async () => {
  const { projectOf } = await import('../src/manager.js');
  const https = projectOf({ repo: 'https://github.com/couchbasecloud/couchbase-cloud.git' });
  const ssh = projectOf({ git: { remote: 'git@github.com:couchbasecloud/couchbase-cloud.git' } });
  assert.equal(https.key, ssh.key, 'URL and a clone of the same repo group together');
  assert.equal(https.name, 'couchbase-cloud');
  assert.equal(https.full, 'couchbasecloud/couchbase-cloud');
  assert.equal(projectOf({ kind: 'general' }).name, 'General');
  assert.equal(projectOf({ sourceDir: '/Users/me/src/tools', workdir: '/x' }).name, 'tools');
  assert.equal(projectOf({ workdir: '/Users/me/notes' }).name, 'notes');
  assert.equal(projectOf({}).name, 'Other');
  assert.deepEqual(projectOf({ project: 'Fusion', repo: 'https://github.com/a/b' }), { key: 'custom:fusion', name: 'Fusion', source: 'custom' });
});

test('parseBrief reads the status line', async () => {
  const { parseBrief } = await import('../src/brief.js');
  assert.equal(parseBrief('# Brief\nStatus: done\n## Problem\nx').status, 'done');
  assert.equal(parseBrief('**Status:** Blocked\n## Problem\nx').status, 'blocked');
  assert.equal(parseBrief('## Problem\nStatus: done is not the status line').status, null);
});

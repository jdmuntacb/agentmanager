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

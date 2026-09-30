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

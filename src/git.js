import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Never wait on a username/password prompt nobody can see; fail instead.
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });

export function run(cmd, args, { cwd, timeout = 60_000, signal, env } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, signal, env: env ? { ...ENV, ...env } : ENV, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        if (signal?.aborted) return reject(cancelled());
        err.message = `${cmd} ${args.join(' ')} failed: ${(stderr || err.message).trim()}`;
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

const git = (cwd, ...args) => run('git', args, { cwd });

export async function isGitRepo(dir) {
  if (!fs.existsSync(dir)) return false;
  try {
    return (await git(dir, 'rev-parse', '--is-inside-work-tree')) === 'true';
  } catch {
    return false;
  }
}

/** "https://github.com/org/my-repo.git" -> "my-repo" */
export function repoNameFromUrl(url) {
  const last = url.replace(/[/\\]+$/, '').split(/[/:\\]/).pop() || 'repo';
  return last.replace(/\.git$/, '') || 'repo';
}

/** Looks like something git can clone rather than a local path. */
export function isRemoteUrl(s) {
  return /^(https?|ssh|git|file):\/\//.test(s) || /^[\w.-]+@[\w.-]+:/.test(s);
}

const PROGRESS =
  /^(?:remote: )?(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Checking out files):\s+(\d+)%(?:\s+\(\d+\/\d+\))?(?:,\s*([\d.]+\s*[KMGT]iB))?(?:\s*\|\s*([\d.]+\s*[KMGT]iB\/s))?/;

/** Parse one git --progress line, e.g. "Receiving objects:  45% (10/22), 2.10 GiB | 2.40 MiB/s". */
export function parseProgress(line) {
  const m = line.trim().match(PROGRESS);
  return m ? { step: m[1], percent: Number(m[2]), size: m[3] ?? null, rate: m[4] ?? null } : null;
}

/** Run git, reporting `--progress` output as it streams (git writes it to stderr, split by \r). */
function gitProgress(args, { cwd, signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    // Own process group, so cancelling also kills git's helpers (git-remote-http etc.).
    // Killing only git leaves them holding stderr open, and 'close' would never come.
    const child = spawn('git', args, { cwd, env: ENV, stdio: ['ignore', 'ignore', 'pipe'], detached: true });
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    };
    if (signal?.aborted) kill();
    else signal?.addEventListener('abort', kill, { once: true });
    let pending = '';
    let tail = '';
    child.stderr.on('data', (buf) => {
      const text = pending + buf.toString();
      const parts = text.split(/[\r\n]/);
      pending = parts.pop();
      tail = (tail + text).slice(-2000);
      for (const line of parts) {
        const p = parseProgress(line);
        if (p) onProgress?.(p);
      }
    });
    child.on('error', () => {}); // reported through 'close'
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      if (code === 0) return resolve();
      if (signal?.aborted) return reject(cancelled());
      const msg = tail
        .split(/[\r\n]/)
        .filter((l) => l.trim() && !parseProgress(l))
        .slice(-3)
        .join(' ');
      reject(new Error(`git ${args[0]} failed: ${msg || `exit code ${code}`}`));
    });
  });
}

/**
 * Clone with progress. `filter` (e.g. "blob:none") makes a partial clone that
 * downloads file contents only when checked out; `noCheckout` skips the
 * checkout (for shared clones only used to make worktrees). A failed or
 * cancelled clone never leaves a half-written folder behind.
 */
export async function clone(url, dest, { filter, noCheckout = false, signal, onProgress } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const existed = fs.existsSync(dest);
  const args = ['clone', '--progress'];
  if (filter) args.push(`--filter=${filter}`);
  if (noCheckout) args.push('--no-checkout');
  try {
    await gitProgress([...args, url, dest], { signal, onProgress });
  } catch (err) {
    if (!existed) fs.rmSync(dest, { recursive: true, force: true });
    throw err;
  }
}

/** A clone with at least one commit (an interrupted clone is not). */
export async function isValidClone(dir) {
  if (!fs.existsSync(dir)) return false;
  return run('git', ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { cwd: dir }).then(
    () => true,
    () => false,
  );
}

export async function fetch(dir, { signal } = {}) {
  await run('git', ['fetch', '--prune', 'origin'], { cwd: dir, timeout: 10 * 60_000, signal });
}

/**
 * Create a worktree on `branch` (created or reset; it is agent-owned) and check
 * it out with progress. Cleans up after itself if it fails or is cancelled.
 */
export async function addWorktree(repoDir, dest, branch, ref = 'HEAD', { signal, onProgress } = {}) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true }); // left by an interrupted attempt
  await git(repoDir, 'worktree', 'prune');
  try {
    // --no-track: the agent's branch must not adopt origin/main as its upstream, or a
    // plain "git push" from it would be refused; its first push sets its own upstream.
    await run('git', ['worktree', 'add', '--no-checkout', '--no-track', '-B', branch, dest, ref], { cwd: repoDir, signal });
    await gitProgress(['checkout', '--progress', '-f'], { cwd: dest, signal, onProgress });
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true });
    await git(repoDir, 'worktree', 'prune').catch(() => {});
    throw err;
  }
}

export async function removeWorktree(repoDir, dest) {
  await git(repoDir, 'worktree', 'remove', '--force', dest);
}

export async function remoteRef(dir) {
  try {
    return await git(dir, 'rev-parse', '--abbrev-ref', 'origin/HEAD');
  } catch {
    return 'HEAD';
  }
}

const commitOf = (dir, ref) =>
  run('git', ['rev-parse', '--verify', '-q', `${ref}^{commit}`], { cwd: dir }).catch(() => null);

export async function hasRemote(dir, name = 'origin') {
  return run('git', ['remote', 'get-url', name], { cwd: dir }).then(
    () => true,
    () => false,
  );
}

/**
 * Pick the commit a new agent branch starts from.
 * - `base` given: origin/<base> (fresh remote branch), else <base> as a local branch, tag or SHA.
 * - no base: the remote's default branch (origin/HEAD, origin/main, origin/master), falling
 *   back to local main/master and finally the folder's current HEAD (repos with no remote).
 * Returns { ref, sha }.
 */
export async function resolveBase(dir, base) {
  // "HEAD" means the folder's current checkout, never the remote's origin/HEAD.
  const candidates = base
    ? base === 'HEAD'
      ? ['HEAD']
      : [`origin/${base}`, base]
    : [
        await run('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd: dir }).catch(() => null),
        'origin/main',
        'origin/master',
        'main',
        'master',
        'HEAD',
      ].filter(Boolean);
  for (const ref of candidates) {
    const sha = await commitOf(dir, ref);
    if (sha) return { ref, sha };
  }
  throw new Error(`Base "${base}" not found (tried ${candidates.join(', ')})`);
}

export async function gitInfo(dir) {
  if (!(await isGitRepo(dir))) return null;
  const safe = (p) => p.catch(() => '');
  const [branch, remote, head, status] = await Promise.all([
    safe(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')),
    safe(git(dir, 'remote', 'get-url', 'origin')),
    safe(git(dir, 'log', '-1', '--format=%h%x09%s%x09%cI')),
    safe(git(dir, 'status', '--porcelain')),
  ]);
  const [sha, subject, committedAt] = head.split('\t');
  return {
    branch,
    remote: remote || null,
    head: sha ? { sha, subject, committedAt } : null,
    dirtyFiles: status ? status.split('\n').length : 0,
    updatedAt: new Date().toISOString(),
  };
}

/** What changed in a worktree: uncommitted files, and commits/diffstat since `baseSha`. */
export async function changeSummary(dir, baseSha) {
  if (!(await isGitRepo(dir))) return null;
  const safe = (p) => p.catch(() => '');
  const [status, commits, stat] = await Promise.all([
    safe(git(dir, 'status', '--porcelain')),
    baseSha ? safe(git(dir, 'log', '--oneline', '--no-decorate', '-n', '30', `${baseSha}..HEAD`)) : '',
    baseSha ? safe(git(dir, 'diff', '--stat', '--stat-width=120', baseSha)) : safe(git(dir, 'diff', '--stat', '--stat-width=120')),
  ]);
  return {
    uncommitted: status ? status.split('\n').slice(0, 40) : [],
    commits: commits ? commits.split('\n') : [],
    diffstat: stat.split('\n').slice(-25).join('\n'),
  };
}

/**
 * What a worktree changed relative to `baseSha` (commits plus uncommitted and untracked
 * files): per file, lines added/removed and the base-side line ranges touched.
 * Returns { files: { path: { added, removed, ranges: [[from, to]], untracked? } } }.
 */
export async function changes(dir, baseSha) {
  if (!baseSha || !(await isGitRepo(dir))) return null;
  const opts = { cwd: dir, timeout: 30_000 };
  const [numstat, diff, untracked] = await Promise.all([
    run('git', ['diff', '--numstat', '--no-renames', baseSha], opts),
    run('git', ['diff', '-U0', '--no-color', '--no-renames', '--no-ext-diff', baseSha], opts),
    run('git', ['ls-files', '--others', '--exclude-standard'], opts).catch(() => ''),
  ]);
  const files = {};
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [add, del, file] = line.split('\t');
    files[file] = { added: add === '-' ? 0 : Number(add), removed: del === '-' ? 0 : Number(del), ranges: [] };
  }
  let cur = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('--- ')) cur = line.slice(4) === '/dev/null' ? null : line.slice(6);
    else if (line.startsWith('+++ ')) cur = line.slice(4) === '/dev/null' ? cur : line.slice(6);
    else if (line.startsWith('@@') && cur && files[cur]) {
      // "@@ -start,len +..." — len 0 is a pure insertion after line `start`.
      const m = /^@@ -(\d+)(?:,(\d+))?/.exec(line);
      if (m) {
        const start = Number(m[1]);
        const len = m[2] === undefined ? 1 : Number(m[2]);
        files[cur].ranges.push([start, start + Math.max(len, 1) - 1]);
      }
    }
  }
  for (const file of untracked.split('\n').filter(Boolean)) {
    // New files count as all lines added (skipping big or binary ones).
    let added = 0;
    try {
      const full = path.join(dir, file);
      if (fs.statSync(full).size < 1_000_000) {
        const buf = fs.readFileSync(full);
        if (!buf.subarray(0, 8000).includes(0)) added = buf.toString('utf8').split('\n').filter((l, i, all) => l || i < all.length - 1).length;
      }
    } catch {}
    files[file] ??= { added, removed: 0, ranges: [[1, 1e9]], untracked: true };
  }
  return { files };
}

const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: 'Agent Manager',
  GIT_AUTHOR_EMAIL: 'agentmgr@localhost',
  GIT_COMMITTER_NAME: 'Agent Manager',
  GIT_COMMITTER_EMAIL: 'agentmgr@localhost',
};

/**
 * A commit holding the folder's whole working state (tracked edits and untracked files),
 * made without touching its index, branch or files. Returns { sha, tree, head }.
 */
export async function snapshot(dir, message = 'agentmgr checkpoint') {
  const opts = { cwd: dir, timeout: 120_000 };
  const head = await run('git', ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], opts).catch(() => null);
  if (!head) return null;
  // Start from a copy of the real index so unchanged files aren't re-hashed.
  const indexPath = path.resolve(dir, await run('git', ['rev-parse', '--git-path', 'index'], opts));
  const tmp = path.join(path.dirname(indexPath), `agentmgr-snap-${process.pid}-${Date.now()}`);
  try {
    if (fs.existsSync(indexPath)) fs.copyFileSync(indexPath, tmp);
    const env = { ...SNAPSHOT_ENV, GIT_INDEX_FILE: tmp };
    if (!fs.existsSync(indexPath)) await run('git', ['read-tree', head], { ...opts, env });
    await run('git', ['add', '-A'], { ...opts, env });
    const tree = await run('git', ['write-tree'], { ...opts, env });
    const sha = await run('git', ['commit-tree', tree, '-p', head, '-m', message], { ...opts, env });
    return { sha, tree, head };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Make the working tree match a snapshot commit (index and branch stay on HEAD). */
export async function restoreSnapshot(dir, sha) {
  await run('git', ['restore', `--source=${sha}`, '--worktree', '--', '.'], { cwd: dir, timeout: 120_000 });
}

export async function setRef(dir, ref, sha) {
  await run('git', ['update-ref', ref, sha], { cwd: dir });
}

/** Delete every ref under `prefix` (e.g. refs/agentmgr/<id>/). */
export async function deleteRefs(dir, prefix) {
  const refs = (await run('git', ['for-each-ref', '--format=%(refname)', prefix], { cwd: dir }).catch(() => '')).split('\n').filter(Boolean);
  for (const ref of refs) await run('git', ['update-ref', '-d', ref], { cwd: dir }).catch(() => {});
}

/** Unified diff of a worktree against `baseSha`, untracked files included, capped at `max` bytes. */
export async function fullDiff(dir, baseSha, max = 400_000) {
  const opts = { cwd: dir, timeout: 30_000 };
  let out = await run('git', ['diff', '--no-color', '--no-ext-diff', baseSha], opts).catch(() => '');
  const untracked = (await run('git', ['ls-files', '--others', '--exclude-standard'], opts).catch(() => '')).split('\n').filter(Boolean);
  for (const f of untracked) {
    if (out.length > max) break;
    // --no-index exits 1 when the files differ, which is always here.
    const patch = await new Promise((resolve) =>
      execFile('git', ['diff', '--no-color', '--no-index', '--', '/dev/null', f], { ...opts, env: ENV, maxBuffer: 10 * 1024 * 1024 }, (_e, stdout) => resolve(stdout ?? '')),
    );
    out += `\n${patch}`;
  }
  return out.length > max ? `${out.slice(0, max)}\n… (diff truncated)` : out;
}

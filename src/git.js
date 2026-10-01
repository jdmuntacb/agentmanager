import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Never wait on a username/password prompt nobody can see; fail instead.
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });

export function run(cmd, args, { cwd, timeout = 60_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, signal, env: ENV, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
    const child = spawn('git', args, { cwd, signal, env: ENV, stdio: ['ignore', 'ignore', 'pipe'] });
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

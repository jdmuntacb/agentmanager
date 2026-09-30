import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function run(cmd, args, { cwd, timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
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

export async function clone(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await run('git', ['clone', url, dest], { timeout: 30 * 60_000 });
}

export async function fetch(dir) {
  await run('git', ['fetch', '--prune', 'origin'], { cwd: dir, timeout: 10 * 60_000 });
}

export async function addWorktree(repoDir, dest, branch, ref = 'HEAD') {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await git(repoDir, 'worktree', 'add', '-b', branch, dest, ref);
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

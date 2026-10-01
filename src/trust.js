// Pre-accepts Claude Code's "Do you trust this folder?" prompt for agent folders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function claudeConfigFile() {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(os.homedir(), '.claude.json');
}

/**
 * Mark `dir` as trusted (projects[<realpath>].hasTrustDialogAccepted), the same
 * record Claude Code writes when you answer "Yes, I trust this folder".
 * The file is shared with running Claude processes, so it is re-read right
 * before writing, only written when something changes, and replaced atomically.
 * Returns true if it changed anything.
 */
export function trustFolder(dir) {
  const real = fs.realpathSync(dir);
  const file = claudeConfigFile();
  let raw = '{}';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const data = JSON.parse(raw || '{}');
  data.projects ??= {};
  if (data.projects[real]?.hasTrustDialogAccepted) return false;
  data.projects[real] = { ...data.projects[real], hasTrustDialogAccepted: true };

  const backup = `${file}.agentmgr-backup`;
  if (raw !== '{}' && !fs.existsSync(backup)) fs.writeFileSync(backup, raw, { mode: 0o600 });
  const tmp = `${file}.agentmgr-${process.pid}.tmp`;
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tmp, file);
  return true;
}

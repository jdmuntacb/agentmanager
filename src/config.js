import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = process.env.AGENTMGR_HOME || path.join(os.homedir(), '.agentmanager');
export const HOST = '127.0.0.1';
export const PORT = Number(process.env.AGENTMGR_PORT || 4717);

export const paths = {
  home: HOME,
  state: path.join(HOME, 'state.json'),
  config: path.join(HOME, 'config.json'),
  log: path.join(HOME, 'daemon.log'),
  pid: path.join(HOME, 'daemon.pid'),
  workspaces: path.join(HOME, 'workspaces'),
  repos: path.join(HOME, 'repos'),
};

const DEFAULTS = {
  // Binary used to launch agents. Override to test with a stub.
  claudeBin: process.env.AGENTMGR_CLAUDE_BIN || 'claude',
  // Extra args appended to every claude launch, e.g. ["--model", "opus"].
  claudeArgs: [],
  // Default --permission-mode for new agents ("default" passes nothing).
  permissionMode: 'default',
  // Extra regexes (strings) that identify bug keys in transcripts, e.g. ["\\bMB-\\d+\\b"].
  bugPatterns: [],
  // Terminal output kept in memory per agent so a re-opened terminal shows history.
  scrollbackBytes: 1024 * 1024,
  // How often (seconds) running agents get git / PR info refreshed.
  gitRefreshSec: 15,
  prRefreshSec: 120,
};

export function ensureHome() {
  for (const dir of [paths.home, paths.workspaces, paths.repos]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadConfig() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(paths.config, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`Invalid ${paths.config}: ${err.message}`);
  }
  return { ...DEFAULTS, ...user };
}

export function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

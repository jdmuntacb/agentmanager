import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHome, HOST, paths, PORT } from './config.js';

export const BASE = `http://${HOST}:${PORT}`;
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agentmgr.js');

export async function api(method, route, body) {
  const res = await fetch(`${BASE}/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-agentmgr': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${route} failed with HTTP ${res.status}`);
  return data;
}

export async function isRunning() {
  try {
    await api('GET', '/health');
    return true;
  } catch {
    return false;
  }
}

/** Start the daemon in the background if it is not already listening. */
export async function ensureDaemon({ quiet = false } = {}) {
  if (await isRunning()) return false;
  ensureHome();
  const log = fs.openSync(paths.log, 'a');
  const child = spawn(process.execPath, [BIN, 'serve'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await isRunning()) {
      if (!quiet) process.stderr.write(`agentmgr: started daemon at ${BASE} (log: ${paths.log})\n`);
      return true;
    }
  }
  throw new Error(`Daemon did not start; see ${paths.log}`);
}

// The agent engines Agent Manager can run. Each agent records its engine; agents from
// before engines existed are Claude Code agents.
import fs from 'node:fs';
import path from 'node:path';
import antigravity from './antigravity.js';
import claude from './claude.js';
import codex from './codex.js';

export const ENGINES = { claude, codex, antigravity };
export const DEFAULT_ENGINE = 'claude';

/** Whether an engine's command is on this machine (an absolute path, or found on PATH). */
export function installed(engine, config) {
  const bin = engine.bin(config);
  if (path.isAbsolute(bin)) return fs.existsSync(bin);
  return (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));
}

/** Every engine, with whether it can run here, for pickers and the hub. */
export function listEngines(config) {
  return Object.values(ENGINES).map((e) => ({ id: e.id, label: e.label, installed: installed(e, config), permissionModes: e.permissionModes, supports: e.supports }));
}

/** The engine for an agent (or an engine id). */
export function engineOf(ref) {
  const id = typeof ref === 'string' ? ref : ref?.engine ?? DEFAULT_ENGINE;
  const engine = Object.hasOwn(ENGINES, id) ? ENGINES[id] : null;
  if (!engine) throw Object.assign(new Error(`Unknown engine "${String(id).slice(0, 30)}" (known: ${Object.keys(ENGINES).join(', ')})`), { status: 400 });
  return engine;
}

// OpenAI's Codex CLI as an agent engine (checked against codex-cli 0.163.0; fixtures in
// test/fixtures/codex). Differences from Claude Code that shape this adapter:
//   - Codex picks its own session IDs; the manager adopts the one it creates (adoptSessions).
//   - Sessions live in $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, and the
//     first line (session_meta) records the folder it ran in.
//   - No flag for extra instructions: they go in the first message of a new session.
//   - Token counts but no cost figure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { norm, tailOf } from '../stuck.js';
import { extractRefs } from '../tracker.js';

const home = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const sessionsDir = () => path.join(home(), 'sessions');
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const ANSI = /\x1b(\[[0-9;?<>=]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[()][0-9A-B]|[=>78c])/g;

/** Day folders from `sinceMs` to today (sessions are filed by local start date). */
function dayDirs(sinceMs) {
  const out = [];
  const d = new Date(Math.min(sinceMs, Date.now()));
  d.setHours(0, 0, 0, 0);
  for (let i = 0; i < 400 && d.getTime() <= Date.now(); i++, d.setDate(d.getDate() + 1)) {
    out.push(path.join(sessionsDir(), String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')));
  }
  return out;
}

const idOf = (name) => /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(name)?.[1] ?? null;

/** The folder a session ran in, from its first line. */
function sessionCwd(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      // The first line carries Codex's own instructions too, so it is often tens of KB.
      const buf = Buffer.alloc(512 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, n).toString('utf8');
      const first = head.split('\n')[0];
      try {
        const rec = JSON.parse(first);
        return rec.type === 'session_meta' ? rec.payload?.cwd ?? null : null;
      } catch {
        // Longer than we read: the session_meta's cwd is the first one in the line.
        if (!first.includes('"session_meta"')) return null;
        const m = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(first);
        return m ? JSON.parse(m[1]) : null;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

const found = new Map(); // session id -> file
function findSession(sessionId) {
  const hit = found.get(sessionId);
  if (hit && fs.existsSync(hit)) return hit;
  // Newest days first; a session started long ago and resumed today is still filed under its start day.
  let years;
  try {
    years = fs.readdirSync(sessionsDir()).sort().reverse();
  } catch {
    return null;
  }
  for (const y of years) {
    for (const m of fs.readdirSync(path.join(sessionsDir(), y)).sort().reverse()) {
      for (const d of fs.readdirSync(path.join(sessionsDir(), y, m)).sort().reverse()) {
        const dir = path.join(sessionsDir(), y, m, d);
        const name = fs.readdirSync(dir).find((n) => idOf(n) === sessionId);
        if (name) {
          found.set(sessionId, path.join(dir, name));
          return found.get(sessionId);
        }
      }
    }
  }
  return null;
}

/** Read the complete lines added since the cursor's offset. */
function newRecords(file, cursor) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size, mtime } = fs.fstatSync(fd);
    cursor.lastActivity = mtime.toISOString();
    if (size < cursor.offset) cursor.offset = 0;
    if (size === cursor.offset) return [];
    const buf = Buffer.alloc(size - cursor.offset);
    fs.readSync(fd, buf, 0, buf.length, cursor.offset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return [];
    const start = cursor.offset;
    cursor.offset += lastNl + 1;
    const out = [];
    let at = start;
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
      const here = at;
      at += Buffer.byteLength(line) + 1;
      if (!line) continue;
      try {
        out.push({ rec: JSON.parse(line), at: here });
      } catch {}
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

const itemText = (item) =>
  (Array.isArray(item?.content) ? item.content : [])
    .map((c) => (typeof c?.text === 'string' ? c.text : ''))
    .join('\n');
const commandOf = (item) => (Array.isArray(item?.command) ? (item.command.length >= 3 && /sh$/.test(item.command[0]) ? item.command.at(-1) : item.command.join(' ')) : String(item?.command ?? ''));
/** Files a FileChange item touched (its shape varies between versions). */
const changedFiles = (item) => {
  const c = item?.changes ?? item?.files ?? [];
  if (Array.isArray(c)) return c.map((x) => (typeof x === 'string' ? x : x?.path ?? x?.file)).filter(Boolean);
  return Object.keys(c);
};

/** Approval modes in Codex terms: sandbox plus when to ask. The hub never starts the last one. */
const MODES = {
  default: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
  acceptEdits: ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'],
  plan: ['--sandbox', 'read-only', '--ask-for-approval', 'on-request'],
  bypassPermissions: ['--dangerously-bypass-approvals-and-sandbox'],
};

export default {
  id: 'codex',
  label: 'Codex',
  supports: { chooseSessionId: false, cost: false, planHandoff: false, fork: false, oneShot: true },
  permissionModes: Object.keys(MODES),
  rulesFiles: ['AGENTS.md'],

  bin: (config) => config.engines?.codex?.bin ?? 'codex',
  extraArgs: (config) => [...(config.engines?.codex?.args ?? [])],

  /** Full arguments for a launch. Codex takes options after `resume`, and instructions only as text. */
  launchArgs({ extra = [], permissionMode, model, writableDir, instructions, sessionId, resume, prompt }) {
    // Inline mode keeps the conversation in the terminal's scrollback, which Agent Manager replays.
    const opts = [...extra, '--no-alt-screen', ...(MODES[permissionMode] ?? MODES.default)];
    if (model) opts.push('--model', model);
    if (writableDir) opts.push('--add-dir', writableDir);
    if (resume) return ['resume', ...opts, sessionId, ...(prompt ? [prompt] : [])];
    const first = [instructions, prompt && (instructions ? `Your task:\n${prompt}` : prompt)].filter(Boolean).join('\n\n---\n\n');
    return [...opts, ...(first ? [first] : [])];
  },

  sessionFile: (cwd, sessionId) => findSession(sessionId) ?? path.join(sessionsDir(), `missing-${sessionId}.jsonl`),
  hasSession: (cwd, sessionId) => Boolean(findSession(sessionId)),
  subagentFiles: () => [],

  /** Sessions Codex started in this folder since a time; the manager adopts a new one. */
  recentSessions(cwd, sinceMs) {
    const want = real(cwd);
    const out = [];
    for (const dir of dayDirs(sinceMs)) {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        const id = idOf(n);
        if (!id) continue;
        const file = path.join(dir, n);
        const st = fs.statSync(file);
        if (st.mtimeMs < sinceMs) continue;
        const where = sessionCwd(file);
        if (!where || real(where) !== want) continue;
        found.set(id, file);
        out.push({ sessionId: id, file, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs });
      }
    }
    return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  },

  /** Usage (one entry per model response), PR and bug links from messages and command output. */
  scan(file, cursor, bugPatterns = []) {
    const result = { prs: [], bugs: [], title: null, lastPrompt: null, cost: null, lastActivity: null };
    cursor.usage ??= new Map();
    cursor.offset ??= 0;
    const recs = newRecords(file, cursor);
    result.lastActivity = cursor.lastActivity ?? null;
    if (!recs) return result;
    for (const { rec, at } of recs) {
      const p = rec.payload ?? {};
      if (p.type === 'token_count' && p.info?.last_token_usage) {
        const u = p.info.last_token_usage;
        const cached = u.cached_input_tokens ?? 0;
        // Codex counts cached tokens inside input_tokens; Claude Code counts them apart.
        cursor.usage.set(`r${at}`, {
          input: Math.max(0, (u.input_tokens ?? 0) - cached),
          output: u.output_tokens ?? 0,
          cacheCreation: u.cache_write_input_tokens ?? 0,
          cacheRead: cached,
        });
      } else if (p.type === 'item_completed') {
        const item = p.item ?? {};
        const text = item.type === 'CommandExecution' ? String(item.aggregated_output ?? '') : itemText(item);
        if (item.type === 'UserMessage' && text) result.lastPrompt = text.slice(0, 500);
        const refs = extractRefs(text, bugPatterns);
        result.prs.push(...refs.prs);
        result.bugs.push(...refs.bugs);
      }
    }
    return result;
  },

  /** Commands and file edits, for stuck detection. */
  activity(file, state) {
    state.events ??= [];
    state.offset ??= 0;
    const recs = newRecords(file, state);
    if (!recs) return state;
    for (const { rec } of recs) {
      const item = rec.payload?.type === 'item_completed' ? rec.payload.item : null;
      if (!item) continue;
      const t = Date.parse(rec.timestamp ?? '') || Date.now();
      if (item.type === 'CommandExecution') {
        const out = String(item.aggregated_output ?? '');
        state.events.push({ t, kind: 'cmd', cmd: norm(commandOf(item)).slice(0, 300), failed: Number(item.exit_code ?? 0) !== 0, result: tailOf(out), shown: out.replace(/\s+/g, ' ').trim().slice(-160) });
      } else if (item.type === 'FileChange') {
        // Each change's diff becomes one (removed, added) pair, so edits that undo earlier ones show up.
        const changes = item.changes && !Array.isArray(item.changes) ? item.changes : {};
        for (const f of changedFiles(item)) {
          const diff = String(changes[f]?.unified_diff ?? '').split('\n');
          const side = (c) => norm(diff.filter((l) => l.startsWith(c) && !l.startsWith(c.repeat(3))).map((l) => l.slice(1)).join('\n'));
          state.events.push({ t, kind: 'edit', file: f, edits: diff.length > 1 ? [[side('-'), side('+')]] : [] });
        }
      }
    }
    if (state.events.length > 400) state.events = state.events.slice(-400);
    return state;
  },

  /** A readable digest of the conversation, for Explain and documents. */
  digest(file, { maxChars = 24_000 } = {}) {
    const events = [];
    const edited = new Set();
    for (const { rec } of newRecords(file, { offset: 0 }) ?? []) {
      const item = rec.payload?.type === 'item_completed' ? rec.payload.item : null;
      if (!item) continue;
      if (item.type === 'UserMessage') events.push(`[user] ${itemText(item).slice(0, 1200)}`);
      else if (item.type === 'AgentMessage') events.push(`[agent] ${itemText(item).slice(0, 1800)}`);
      else if (item.type === 'CommandExecution') events.push(`[action] ran \`${commandOf(item).slice(0, 200)}\`${Number(item.exit_code ?? 0) ? ` (exit ${item.exit_code})` : ''}`);
      else if (item.type === 'FileChange') for (const f of changedFiles(item)) edited.add(f), events.push(`[action] edited ${f}`);
    }
    const head = events.find((e) => e.startsWith('[user]'));
    const tail = [];
    let used = head?.length ?? 0;
    for (let i = events.length - 1; i >= 0 && events[i] !== head; i--) {
      if (used + events[i].length > maxChars) {
        tail.unshift('… (earlier events omitted) …');
        break;
      }
      tail.unshift(events[i]);
      used += events[i].length + 1;
    }
    return { digest: [head, ...tail].filter(Boolean).join('\n'), events: events.length, edited: [...edited] };
  },

  copySession: () => false,

  attention: [
    [/Trustthisfolder\?/i, 'Folder trust prompt'],
    [/Wouldyouliketo(run|make|apply|allow|grant)/i, 'Permission prompt'],
  ],

  /** Codex's menus: "› 1. Yes, proceed (y)" ... "3. No, and tell Codex what to do differently (esc)". */
  promptChoices(screen) {
    const text = String(screen ?? '')
      .replace(/\x1b\[(\d*)C/g, ' ')
      .replace(ANSI, ' ')
      .replace(/\s+/g, ' ');
    const at = Math.max(text.lastIndexOf('Would you like'), text.lastIndexOf('Trust this folder'));
    if (at < 0) return { question: '', choices: [] };
    const tail = text.slice(at);
    const question = (/^(.*?\?)/.exec(tail)?.[1] ?? '').slice(0, 200);
    const choices = new Map();
    for (const m of tail.matchAll(/(?:›\s*)?\b(\d)\.\s*(.+?)(?=\s+(?:›\s*)?\d\.\s|\s+Press enter|\s+enter continue|$)/g)) {
      if (!choices.has(m[1])) choices.set(m[1], m[2].replace(/\s*\(\s*(?:y|p|esc|n|a)\s*\)\s*$/, '').trim().slice(0, 80));
    }
    return { question, choices: [...choices.entries()].sort(([a], [b]) => a - b).map(([key, label]) => ({ key, label })) };
  },

  /**
   * Mark the folder trusted in $CODEX_HOME/config.toml, the record Codex writes for
   * "Trust and continue". Appends a table only when the folder isn't listed yet.
   */
  trust(dir) {
    const file = path.join(home(), 'config.toml');
    const key = real(dir).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (raw.includes(`[projects."${key}"]`)) return false;
    const backup = `${file}.agentmgr-backup`;
    if (raw && !fs.existsSync(backup)) fs.writeFileSync(backup, raw, { mode: 0o600 });
    fs.mkdirSync(home(), { recursive: true });
    fs.appendFileSync(file, `${raw && !raw.endsWith('\n') ? '\n' : ''}\n[projects."${key}"]\ntrust_level = "trusted"\n`);
    return true;
  },

  /** One-shot, read-only and not saved; the prompt goes on stdin and only the answer is printed. */
  oneShotArgs: (config, { model } = {}) => ['exec', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', ...(model ? ['--model', model] : []), '-'],

  stripEnv: [],
};

// Google's Antigravity CLI (`agy`) as an agent engine (checked against agy 1.4.3; fixtures in
// test/fixtures/antigravity). It replaced Gemini CLI for personal Google accounts. Differences
// from Claude Code that shape this adapter:
//   - agy picks its own conversation IDs; the manager adopts the one it creates. agy keeps
//     the latest conversation per folder in cache/last_conversations.json.
//   - Each conversation's log is brain/<id>/.system_generated/logs/transcript_full.jsonl:
//     one record per step (USER_INPUT, PLANNER_RESPONSE with tool_calls and token counts,
//     GENERIC with each tool's result).
//   - No flag for extra instructions: they go in the first message of a new conversation.
//   - Token counts but no cost figure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { norm, tailOf } from '../stuck.js';
import { extractRefs } from '../tracker.js';

// ANTIGRAVITY_CLI_HOME is Agent Manager's own override (tests); agy itself always uses this folder.
const home = () => process.env.ANTIGRAVITY_CLI_HOME || path.join(os.homedir(), '.gemini', 'antigravity-cli');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const transcript = (id) => path.join(home(), 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const ANSI = /\x1b(\[[0-9;?<>=]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[()][0-9A-B]|[=>78c])/g;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
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
    cursor.offset += lastNl + 1;
    const out = [];
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** The user's words without agy's wrapper (<USER_REQUEST>, metadata, settings notes). */
const userText = (step) => {
  const s = String(step.content ?? '');
  return (/<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/.exec(s)?.[1] ?? s).trim();
};
const calls = (step) => (Array.isArray(step.tool_calls) ? step.tool_calls : []);
const commandOf = (call) => String(call?.args?.CommandLine ?? call?.args?.command ?? '');
const fileOf = (call) => {
  const a = call?.args ?? {};
  return String(a.Path ?? a.TargetFile ?? a.AbsolutePath ?? a.path ?? '') || null;
};
const isEdit = (call) => Boolean(fileOf(call)) && /write|edit|replace|create|patch/i.test(String(call?.name ?? ''));
/** A tool result: "Command exited with code N.\n\nCommand output:\n...". */
const exitCode = (text) => {
  const m = /Command exited with code (-?\d+)/.exec(text);
  return m ? Number(m[1]) : null;
};
const outputOf = (text) => text.split(/\nCommand output:\n/)[1] ?? '';

/** agy's modes. Default asks before commands and file changes; the hub never starts the last one. */
const MODES = {
  default: [],
  acceptEdits: ['--mode', 'accept-edits'],
  plan: ['--mode', 'plan'],
  auto: ['--mode', 'auto'],
  bypassPermissions: ['--dangerously-skip-permissions'],
};

export default {
  id: 'antigravity',
  label: 'Antigravity',
  supports: { chooseSessionId: false, cost: false, planHandoff: false, fork: false, oneShot: true },
  permissionModes: Object.keys(MODES),
  // Rules files it reads (agy also reads GEMINI.md), for the conventions note.
  rulesFiles: ['AGENTS.md', 'GEMINI.md'],

  bin: (config) => config.engines?.antigravity?.bin ?? 'agy',
  extraArgs: (config) => [...(config.engines?.antigravity?.args ?? [])],

  /** Full arguments for a launch. Instructions go in the first message; resume is --conversation. */
  launchArgs({ extra = [], permissionMode, model, writableDir, instructions, sessionId, resume, prompt }) {
    const opts = [...extra, ...(MODES[permissionMode] ?? MODES.default)];
    if (model) opts.push('--model', model);
    if (writableDir) opts.push('--add-dir', writableDir);
    // "--flag=value" so a message starting with "-" isn't read as a flag.
    if (resume) return ['--conversation', sessionId, ...opts, ...(prompt ? [`--prompt-interactive=${prompt}`] : [])];
    const first = [instructions, prompt && (instructions ? `Your task:\n${prompt}` : prompt)].filter(Boolean).join('\n\n---\n\n');
    return [...opts, ...(first ? [`--prompt-interactive=${first}`] : [])];
  },

  sessionFile: (cwd, sessionId) => transcript(UUID.test(String(sessionId)) ? sessionId : 'missing'),
  hasSession: (cwd, sessionId) => UUID.test(String(sessionId)) && fs.existsSync(transcript(sessionId)),
  subagentFiles: () => [],

  /** The conversation agy started in this folder since a time; the manager adopts a new one. */
  recentSessions(cwd, sinceMs) {
    const want = real(cwd);
    const map = readJson(path.join(home(), 'cache', 'last_conversations.json')) ?? {};
    const out = [];
    for (const [dir, id] of Object.entries(map)) {
      if (!UUID.test(String(id)) || real(dir) !== want) continue;
      let st;
      try {
        st = fs.statSync(transcript(id));
      } catch {
        continue;
      }
      if (st.mtimeMs < sinceMs) continue;
      out.push({ sessionId: id, file: transcript(id), mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs });
    }
    return out;
  },

  /** Usage (one entry per model step), PR and bug links from messages and command output. */
  scan(file, cursor, bugPatterns = []) {
    const result = { prs: [], bugs: [], title: null, lastPrompt: null, cost: null, lastActivity: null };
    cursor.usage ??= new Map();
    cursor.offset ??= 0;
    const steps = newRecords(file, cursor);
    result.lastActivity = cursor.lastActivity ?? null;
    if (!steps) return result;
    for (const step of steps) {
      if (step.type === 'PLANNER_RESPONSE' && (step.input_tokens || step.output_tokens)) {
        const cached = step.cache_read_tokens ?? 0;
        // Gemini counts cached tokens inside the prompt tokens; Claude Code counts them apart.
        cursor.usage.set(`s${step.step_index}`, {
          input: Math.max(0, (step.input_tokens ?? 0) - cached),
          output: step.output_tokens ?? 0,
          cacheCreation: 0,
          cacheRead: cached,
        });
      }
      const text = step.type === 'USER_INPUT' ? userText(step) : String(step.content ?? '');
      if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT' && text) result.lastPrompt = text.slice(0, 500);
      if (step.type === 'SYSTEM_MESSAGE' || !text) continue;
      const refs = extractRefs(text, bugPatterns);
      result.prs.push(...refs.prs);
      result.bugs.push(...refs.bugs);
    }
    return result;
  },

  /** Commands (with the result step that follows) and file writes, for stuck detection. */
  activity(file, state) {
    state.events ??= [];
    state.offset ??= 0;
    const steps = newRecords(file, state);
    if (!steps) return state;
    for (const step of steps) {
      const t = Date.parse(step.created_at ?? '') || Date.now();
      if (step.type === 'PLANNER_RESPONSE') {
        for (const call of calls(step)) {
          if (commandOf(call) && /command/i.test(String(call.name ?? ''))) {
            state.pending = { t, cmd: norm(commandOf(call)).slice(0, 300) };
          } else if (isEdit(call)) {
            const a = call.args ?? {};
            const before = a.TargetContent ?? a.OldString ?? '';
            const after = a.ReplacementContent ?? a.NewString ?? a.Content ?? a.CodeContent ?? '';
            state.events.push({ t, kind: 'edit', file: fileOf(call), edits: after || before ? [[norm(String(before)), norm(String(after))]] : [] });
          }
        }
      } else if (step.type === 'GENERIC' && state.pending) {
        const text = String(step.content ?? '');
        const code = exitCode(text);
        if (code === null && !text.includes('Command output:')) continue;
        const out = outputOf(text);
        state.events.push({ ...state.pending, kind: 'cmd', failed: code !== null && code !== 0, result: tailOf(out), shown: out.replace(/\s+/g, ' ').trim().slice(-160) });
        state.pending = null;
      }
    }
    if (state.events.length > 400) state.events = state.events.slice(-400);
    return state;
  },

  /** A readable digest of the conversation, for Explain and documents. */
  digest(file, { maxChars = 24_000 } = {}) {
    const events = [];
    const edited = new Set();
    let lastCmd = null;
    for (const step of newRecords(file, { offset: 0 }) ?? []) {
      if (step.type === 'USER_INPUT' && step.source === 'USER_EXPLICIT') events.push(`[user] ${userText(step).slice(0, 1200)}`);
      else if (step.type === 'PLANNER_RESPONSE') {
        if (step.content) events.push(`[agent] ${String(step.content).slice(0, 1800)}`);
        for (const call of calls(step)) {
          if (isEdit(call)) edited.add(fileOf(call)), events.push(`[action] edited ${fileOf(call)}`);
          else if (commandOf(call)) lastCmd = events.push(`[action] ran \`${commandOf(call).slice(0, 200)}\``) - 1;
        }
      } else if (step.type === 'GENERIC' && lastCmd !== null) {
        const code = exitCode(String(step.content ?? ''));
        if (code) events[lastCmd] += ` (exit ${code})`;
        lastCmd = null;
      }
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
    [/Doyoutrustthecontentsofthisproject\?/i, 'Folder trust prompt'],
    [/Runthiscommand\?/i, 'Permission prompt'],
    // "Allow creation of this file?", "Allow access to this file?", ...: any Allow question with a menu.
    [/Allow[a-z]{0,40}\?>?1\.Yes/i, 'Permission prompt'],
  ],

  /** agy's menus: "Run this command? > 1. Yes, run command 2. ... 4. No, cancel ↑/↓ Navigate". */
  promptChoices(screen) {
    const text = String(screen ?? '')
      .replace(/\x1b\[(\d*)C/g, ' ')
      .replace(ANSI, ' ')
      .replace(/\s+/g, ' ');
    const cmdAt = text.lastIndexOf('Requesting permission for:');
    const allowAt = [...text.matchAll(/Allow [a-z ]{0,50}\?(?= >? ?1\. )/g)].at(-1)?.index ?? -1;
    const askAt = Math.max(text.lastIndexOf('Run this command?'), allowAt);
    if (askAt < 0) return { question: '', choices: [] };
    const tail = text.slice(askAt);
    let question = (/^(.*?\?)/.exec(tail)?.[1] ?? '').trim();
    if (question === 'Run this command?' && cmdAt >= 0 && cmdAt < askAt) question = `Run this command? ${text.slice(cmdAt + 26, askAt).trim()}`;
    const choices = new Map();
    for (const m of tail.matchAll(/(?:>\s*)?\b(\d)\.\s*(.+?)(?=\s+(?:>\s*)?\d\.\s|\s+↑\/↓|\s+esc to cancel|$)/g)) {
      if (!choices.has(m[1])) choices.set(m[1], m[2].trim().slice(0, 100));
    }
    return { question: question.slice(0, 200), choices: [...choices.entries()].sort(([a], [b]) => a - b).map(([key, label]) => ({ key, label })) };
  },

  /** Add the folder to agy's trustedWorkspaces (what "Yes, I trust this folder" records). */
  trust(dir) {
    const file = path.join(home(), 'settings.json');
    const want = real(dir);
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const settings = raw ? JSON.parse(raw) : {};
    const list = Array.isArray(settings.trustedWorkspaces) ? settings.trustedWorkspaces : [];
    if (list.some((w) => typeof w === 'string' && (want === real(w) || want.startsWith(real(w) + path.sep)))) return false;
    const backup = `${file}.agentmgr-backup`;
    if (raw && !fs.existsSync(backup)) fs.writeFileSync(backup, raw, { mode: 0o600 });
    settings.trustedWorkspaces = [...list, want];
    fs.mkdirSync(home(), { recursive: true });
    const tmp = `${file}.agentmgr-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  },

  /**
   * One-shot in print mode, in plan mode: print mode can't ask for permission, so commands
   * and file changes are refused. The prompt is attached to the flag (agy doesn't read stdin).
   */
  oneShotArgs: (config, { model, prompt = '' } = {}) => ['--mode', 'plan', ...(model ? ['--model', model] : []), '--print-timeout', '280s', `--print=${prompt}`],
  oneShotStdin: false,

  stripEnv: [],
};

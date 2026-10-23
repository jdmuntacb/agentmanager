// Claude Code as an agent engine: how to launch and resume it, where its sessions live,
// and how to read them. Other engines implement the same shape (see docs/engines.md).
import fs from 'node:fs';
import path from 'node:path';
import { promptChoices } from '../inbox.js';
import { scanActivity } from '../stuck.js';
import { recentSessionFiles, scanTranscript, sessionDigest, subagentTranscripts, transcriptPath } from '../tracker.js';
import { trustFolder } from '../trust.js';

export default {
  id: 'claude',
  label: 'Claude Code',
  // What the UI may offer for this engine's agents.
  supports: { chooseSessionId: true, cost: true, planHandoff: true, fork: true, oneShot: true },
  permissionModes: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],

  bin: (config) => config.engines?.claude?.bin ?? config.claudeBin ?? 'claude',
  extraArgs: (config) => [...(config.engines?.claude?.args ?? config.claudeArgs ?? [])],

  /** Options for every launch: permissions, model, a folder it may write to, extra instructions. */
  optionArgs({ permissionMode, model, writableDir, instructions }) {
    const args = [];
    if (permissionMode && permissionMode !== 'default') args.push('--permission-mode', permissionMode);
    if (model) args.push('--model', model);
    if (writableDir) args.push('--add-dir', writableDir, '--allowedTools', `Write(/${writableDir}/**)`, `Edit(/${writableDir}/**)`);
    if (instructions) args.push('--append-system-prompt', instructions);
    return args;
  },

  /** Full arguments for a launch: options, then the session. */
  launchArgs({ extra = [], permissionMode, model, writableDir, instructions, sessionId, resume, name, prompt }) {
    return [...extra, ...this.optionArgs({ permissionMode, model, writableDir, instructions }), ...this.sessionArgs({ sessionId, resume, name, prompt })];
  },

  /** A new session under the ID we chose, or a resumed one; prompt is the first (or next) message. */
  sessionArgs({ sessionId, resume, name, prompt }) {
    const args = resume ? ['--resume', sessionId] : ['--session-id', sessionId, '--name', name];
    if (prompt) args.push('--', prompt);
    return args;
  },

  sessionFile: (cwd, sessionId) => transcriptPath(cwd, sessionId),
  hasSession: (cwd, sessionId) => fs.existsSync(transcriptPath(cwd, sessionId)),
  subagentFiles: (cwd, sessionId) => subagentTranscripts(cwd, sessionId),
  /** Sessions started in this folder since a time (Claude may switch IDs mid-run, e.g. /clear). */
  recentSessions: (cwd, sinceMs) => recentSessionFiles(cwd, sinceMs),

  /** Incremental read of a session log: usage, cost, PR and bug links. */
  scan: (file, cursor, bugPatterns) => scanTranscript(file, cursor, bugPatterns),
  /** Tool calls and results, for stuck detection. */
  activity: (file, state) => scanActivity(file, state),
  /** A readable digest of the conversation, for Explain and documents. */
  digest: (file) => sessionDigest(file),

  /** Copy a session into another folder (planning handoff), optionally as a new session (fork). */
  copySession({ fromCwd, toCwd, fromId, toId = fromId, bytes }) {
    const from = transcriptPath(fromCwd, fromId);
    const to = transcriptPath(toCwd, toId);
    if (!fs.existsSync(from) || fs.existsSync(to)) return false;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (toId === fromId && !bytes) {
      fs.copyFileSync(from, to);
      return true;
    }
    const raw = fs.readFileSync(from).subarray(0, bytes || undefined).toString('utf8');
    const lines = raw.split('\n').filter(Boolean).map((line) => {
      try {
        const rec = JSON.parse(line);
        if (rec.sessionId) rec.sessionId = toId;
        if (rec.cwd === fromCwd) rec.cwd = toCwd;
        return JSON.stringify(rec);
      } catch {
        return line;
      }
    });
    fs.writeFileSync(to, `${lines.join('\n')}\n`);
    return true;
  },

  /** Screens that need the user (whitespace removed before matching). */
  attention: [
    [/trustthisfolder/i, 'Folder trust prompt'],
    [/Doyouwantto(proceed|make|create|allow|run|overwrite)/i, 'Permission prompt'],
  ],
  promptChoices: (screen) => promptChoices(screen),

  trust: (dir) => trustFolder(dir),

  /** A one-shot, tool-less call; the prompt goes on stdin and the answer comes back as text. */
  oneShotArgs: (config, { model } = {}) => {
    const args = ['-p', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'text'];
    if (model) args.push('--model', model);
    return args;
  },

  /** Variables a nested Claude session would otherwise inherit from a parent one. */
  stripEnv: ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT'],
};

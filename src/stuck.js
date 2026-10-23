// Stuck detection: spot an agent going in circles from its transcript.
//   repeat  - the same command failing the same way again and again
//   thrash  - edits that undo earlier edits, or one file rewritten over and over
//   drift   - lots of activity for a long time without changing any file
// Each finding carries a suggested nudge the user can send with one click.
import fs from 'node:fs';

const WINDOW_MS = 45 * 60_000;
export const STUCK_DEFAULTS = { repeatFailures: 3, thrashReverts: 2, thrashEdits: 10, driftMinutes: 20, driftActions: 25 };

export const norm = (s) =>
  String(s ?? '')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\d+(\.\d+)?\s*(ms|s|sec|seconds)\b/g, 'N')
    .replace(/0x[0-9a-f]+|\b\d{3,}\b/gi, 'N')
    .replace(/\s+/g, ' ')
    .trim();
export const tailOf = (s, n = 300) => norm(s).slice(-n);
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b.type === 'text' ? b.text : '')).join('\n') : '');

/**
 * Incrementally read new transcript lines into `state.events` (tool calls with their results).
 * state: { offset, events: [{ t, kind: 'cmd'|'edit'|'other', ... }], pending: Map(id -> event) }.
 */
export function scanActivity(file, state) {
  state.offset ??= 0;
  state.events ??= [];
  state.pending ??= new Map();
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return state;
  }
  try {
    const { size } = fs.fstatSync(fd);
    if (size < state.offset) Object.assign(state, { offset: 0, events: [], pending: new Map() });
    if (size === state.offset) return state;
    const buf = Buffer.alloc(size - state.offset);
    fs.readSync(fd, buf, 0, buf.length, state.offset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return state;
    state.offset += lastNl + 1;
    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.isSidechain) continue;
      const t = Date.parse(rec.timestamp ?? '') || Date.now();
      const blocks = Array.isArray(rec.message?.content) ? rec.message.content : [];
      for (const b of blocks) {
        if (rec.type === 'assistant' && b.type === 'tool_use') {
          const ev = eventFor(b, t);
          state.events.push(ev);
          state.pending.set(b.id, ev);
        } else if (rec.type === 'user' && b.type === 'tool_result') {
          const ev = state.pending.get(b.tool_use_id);
          if (!ev) continue;
          state.pending.delete(b.tool_use_id);
          const out = textOf(b.content);
          ev.failed = Boolean(b.is_error) || /^Exit code [1-9]/m.test(out);
          ev.result = tailOf(out); // normalized, for matching repeats
          ev.shown = out.replace(/\s+/g, ' ').trim().slice(-160); // as it was, for people
        }
      }
    }
    // Only recent history matters.
    const cutoff = Date.now() - 2 * WINDOW_MS;
    if (state.events.length > 400 || state.events[0]?.t < cutoff) state.events = state.events.filter((e) => e.t >= cutoff).slice(-400);
  } finally {
    fs.closeSync(fd);
  }
  return state;
}

function eventFor(b, t) {
  const input = b.input ?? {};
  if (b.name === 'Bash') return { t, kind: 'cmd', cmd: norm(input.command).slice(0, 300) };
  if (['Edit', 'MultiEdit', 'Write'].includes(b.name)) {
    const edits = b.name === 'MultiEdit' ? input.edits ?? [] : b.name === 'Edit' ? [{ old_string: input.old_string, new_string: input.new_string }] : [];
    return { t, kind: 'edit', file: input.file_path ?? '', edits: edits.map((e) => [norm(e.old_string), norm(e.new_string)]) };
  }
  return { t, kind: 'other', name: b.name };
}

/** Findings for an agent's recent activity, most important first. */
export function detectStuck(events, { now = Date.now(), opts = STUCK_DEFAULTS } = {}) {
  const recent = events.filter((e) => now - e.t <= WINDOW_MS);
  const found = [];

  // repeat: one command failing with the same output N times in a row (among its own runs).
  const runs = new Map();
  for (const e of recent) if (e.kind === 'cmd' && e.cmd && e.result !== undefined) (runs.get(e.cmd) ?? runs.set(e.cmd, []).get(e.cmd)).push(e);
  for (const [cmd, list] of runs) {
    let streak = 0;
    for (let i = list.length - 1; i >= 0 && list[i].failed && list[i].result === list.at(-1).result; i--) streak++;
    if (streak >= opts.repeatFailures) {
      found.push({
        kind: 'repeat',
        key: `repeat:${cmd}`,
        title: `Same failure ${streak}× in a row`,
        detail: `\`${cmd.slice(0, 120)}\` keeps failing with the same output: ${list.at(-1).shown ?? list.at(-1).result.slice(-160)}`,
        since: new Date(list[list.length - streak].t).toISOString(),
        nudge:
          `You've run \`${cmd.slice(0, 120)}\` ${streak} times and it fails the same way each time. Stop retrying. ` +
          'Write down what you have tried and why each attempt failed, list two or three different hypotheses for the root cause, ' +
          'then test the most likely one with a small experiment before changing more code. If you need something from me, ask.',
      });
    }
  }

  // thrash: edits that put back what an earlier edit removed, or one file edited over and over.
  const byFile = new Map();
  for (const e of recent) if (e.kind === 'edit' && e.file) (byFile.get(e.file) ?? byFile.set(e.file, []).get(e.file)).push(e);
  for (const [file, list] of byFile) {
    let reverts = 0;
    const seen = [];
    for (const e of list) {
      for (const [oldS, newS] of e.edits) {
        if (oldS && newS && seen.some(([o, n]) => o === newS && n === oldS)) reverts++;
        seen.push([oldS, newS]);
      }
    }
    const short = file.split('/').slice(-2).join('/');
    if (reverts >= opts.thrashReverts || list.length >= opts.thrashEdits) {
      found.push({
        kind: 'thrash',
        key: `thrash:${file}`,
        title: reverts >= opts.thrashReverts ? `Undoing its own edits in ${short}` : `${list.length} edits to ${short}`,
        detail: reverts >= opts.thrashReverts ? `${reverts} edits put back code an earlier edit removed.` : `The same file was edited ${list.length} times in the last ${Math.round(WINDOW_MS / 60_000)} minutes.`,
        since: new Date(list[0].t).toISOString(),
        nudge:
          `You're going back and forth on ${short}. Pause editing it. Explain in a few sentences what the code there must do, ` +
          'what constraint keeps pulling it in two directions, and which version you will commit to and why. Then make one deliberate change.',
      });
    }
  }

  // drift: busy for a long time, many actions, no file changed.
  const lastEdit = [...recent].reverse().find((e) => e.kind === 'edit');
  const sinceEdit = recent.filter((e) => !lastEdit || e.t > lastEdit.t);
  const span = sinceEdit.length ? now - sinceEdit[0].t : 0;
  const active = recent.length && now - recent.at(-1).t < 5 * 60_000; // still at it, not idle for hours
  if (active && sinceEdit.length >= opts.driftActions && span >= opts.driftMinutes * 60_000) {
    found.push({
      kind: 'drift',
      key: 'drift',
      title: `${Math.round(span / 60_000)} min without changing a file`,
      detail: `${sinceEdit.length} actions (searches, reads, commands) since the last edit.`,
      since: new Date(sinceEdit[0].t).toISOString(),
      nudge:
        'Quick check-in: you have spent a while exploring without changing anything. Summarize what you have learned so far, ' +
        'state the next concrete change you will make, and make it. If you are blocked or unsure what I want, ask me now.',
    });
  }
  return found;
}

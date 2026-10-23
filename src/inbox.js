// Decision inbox: questions agents ask without stopping, answered from one place.
// Agents append questions to QUESTIONS.md next to their brief; answers go back into
// their session as a message. Live prompts (permission menus) are answered with keys.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { briefDir } from './brief.js';

export const QUESTIONS_FILE = 'QUESTIONS.md';
export const questionsPath = (agentId) => path.join(briefDir(agentId), QUESTIONS_FILE);

export const questionsPrompt = (file) =>
  `When you need a decision from the user that doesn't have to stop all your work (a choice between options, ` +
  `a preference, a missing detail), don't wait in the terminal: add it to ${file} and keep going on whatever you can ` +
  'do meanwhile, using your best default. Agent Manager collects these into the user\'s inbox. One question per heading, ' +
  'never edit or remove earlier ones:\n' +
  '## <the question, one line>\n' +
  'Options: <option A> | <option B>   (optional)\n' +
  'Default: <what you will assume until answered>   (optional)\n' +
  '<one or two lines of context>   (optional)\n' +
  'Answers arrive in this session as a message starting with "Answer to your question". Apply them when they come. ' +
  'Use the terminal (or your question tool) only when you truly cannot continue without the answer.';

const qid = (text) => crypto.createHash('sha1').update(text.trim().toLowerCase()).digest('hex').slice(0, 10);

/** Parse QUESTIONS.md into [{ id, question, options, default, context }]. */
export function parseQuestions(markdown) {
  const out = [];
  let cur = null;
  for (const raw of String(markdown ?? '').split('\n')) {
    const line = raw.trimEnd();
    const h = /^#{2,3}\s+(?:Q\d*[:.]\s*)?(.+)$/.exec(line);
    if (h) {
      cur = { id: qid(h[1]), question: h[1].trim(), options: [], default: null, context: '' };
      if (!out.some((q) => q.id === cur.id)) out.push(cur);
      else cur = null;
      continue;
    }
    if (!cur) continue;
    const opt = /^\s*options?\s*:\s*(.+)$/i.exec(line);
    const def = /^\s*(?:default|proceeding with|assuming)\s*:\s*(.+)$/i.exec(line);
    if (opt) cur.options = opt[1].split('|').map((s) => s.trim()).filter(Boolean).slice(0, 6);
    else if (def) cur.default = def[1].trim();
    else if (line.trim()) cur.context = `${cur.context ? `${cur.context} ` : ''}${line.trim()}`.slice(0, 600);
  }
  return out;
}

const cache = new Map(); // file -> { mtimeMs, questions }
export function loadQuestions(agentId) {
  const file = questionsPath(agentId);
  try {
    const { mtimeMs } = fs.statSync(file);
    const hit = cache.get(file);
    if (hit?.mtimeMs === mtimeMs) return hit.questions;
    const questions = parseQuestions(fs.readFileSync(file, 'utf8'));
    cache.set(file, { mtimeMs, questions });
    return questions;
  } catch {
    cache.delete(file);
    return [];
  }
}

export const answerMessage = (q, text) => `Answer to your question "${q.question}": ${text}`;

/**
 * Answer choices visible in a live prompt: numbered menu lines ("❯ 1. Yes", "2. No").
 * `screen` is recent terminal output; cursor moves become spaces before matching.
 */
export function promptChoices(screen) {
  const text = String(screen ?? '')
    .replace(/\x1b\[(\d*)C/g, (_, n) => ' '.repeat(Math.min(Number(n || 1), 8)))
    .replace(/\x1b\[[0-9;]*[ABDGHJKfm]/g, '\n')
    .replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\r/g, '\n');
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  // The last menu on screen wins: walk back from the end, collecting "N. label" lines.
  const choices = new Map();
  let question = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(?:[❯>›]\s*)?(\d)[.)]\s+(.{1,80})$/.exec(lines[i]);
    if (m) {
      if (!choices.has(m[1])) choices.set(m[1], m[2].trim());
    } else if (choices.size && lines[i]) {
      question = lines[i].slice(0, 200);
      break;
    }
  }
  return {
    question,
    choices: [...choices.entries()].sort(([a], [b]) => a - b).map(([key, label]) => ({ key, label })),
  };
}

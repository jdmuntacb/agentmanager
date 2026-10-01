import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './git.js';

/** Claude Code stores transcripts at ~/.claude/projects/<cwd with non-alphanumerics as '-'>/<session>.jsonl */
export function claudeProjectDir(cwd) {
  let real = cwd;
  try {
    real = fs.realpathSync(cwd);
  } catch {}
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'));
}

export function transcriptPath(cwd, sessionId) {
  return path.join(claudeProjectDir(cwd), `${sessionId}.jsonl`);
}

/** Transcripts of subagents a session spawned (their tokens count toward the session). */
export function subagentTranscripts(cwd, sessionId) {
  const dir = path.join(claudeProjectDir(cwd), sessionId, 'subagents');
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

const emptyUsage = () => ({ input: 0, output: 0, cacheCreation: 0, cacheRead: 0, requests: 0 });

/** Sum per-request usage (keyed by API message id, so repeated lines count once). */
export function sumUsage(...maps) {
  const total = emptyUsage();
  for (const map of maps) {
    for (const u of map.values()) {
      total.input += u.input;
      total.output += u.output;
      total.cacheCreation += u.cacheCreation;
      total.cacheRead += u.cacheRead;
      total.requests += 1;
    }
  }
  total.total = total.input + total.output + total.cacheCreation + total.cacheRead;
  return total;
}

/** Session files in the agent's project dir modified at/after `sinceMs`, newest first. */
export function recentSessionFiles(cwd, sinceMs) {
  const dir = claudeProjectDir(cwd);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => {
      const file = path.join(dir, n);
      const st = fs.statSync(file);
      return { sessionId: n.slice(0, -6), file, mtimeMs: st.mtimeMs, birthtimeMs: st.birthtimeMs };
    })
    .filter((f) => f.mtimeMs >= sinceMs)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

const URL_TOKEN = /https?:\/\/[^\s"'<>`\\)\]]+/g;
const PR_PATH = /^https?:\/\/[\w.-]+\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const GH_ISSUE_PATH = /^https?:\/\/[\w.-]+\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)(?:[/?#]|$)/;
// Jira keys in links: /browse/KEY-1, ?selectedIssue=KEY-1 (boards, Polaris ideas), /issues/KEY-1.
const JIRA_KEY = /(?:\/browse\/|[?&]selectedIssue=|\/issues\/)([A-Z][A-Z0-9_]+-\d+)\b/;

const trimUrl = (url) => url.replace(/[.,;:!?'"]+$/, '');

export function prFromUrl(url, source) {
  const m = url.match(PR_PATH);
  return { url, repo: m?.[1] ?? null, number: m ? Number(m[2]) : null, source };
}

/** A bug from a key ("MB-123") or a Jira / GitHub issue URL. */
export function bugFromRef(ref, source) {
  if (/^https?:\/\//.test(ref)) {
    const url = trimUrl(ref);
    const jira = url.match(JIRA_KEY);
    if (jira) return { key: jira[1], url, source };
    const gh = url.match(GH_ISSUE_PATH);
    if (gh) return { key: `${gh[1]}#${gh[2]}`, url, source };
    return { key: url, url, source };
  }
  return { key: ref, url: null, source };
}

/** Extract PR and bug references from free text. */
export function extractRefs(text, bugPatterns = []) {
  const prs = [];
  const bugs = [];
  for (const [raw] of text.matchAll(URL_TOKEN)) {
    const url = trimUrl(raw);
    const pr = url.match(PR_PATH);
    if (pr) prs.push(prFromUrl(pr[0], 'mentioned'));
    else if (JIRA_KEY.test(url) || GH_ISSUE_PATH.test(url)) bugs.push(bugFromRef(url, 'mentioned'));
  }
  for (const pattern of bugPatterns) {
    const re = new RegExp(pattern, 'g');
    for (const m of text.matchAll(re)) {
      if (!bugs.some((b) => b.key === m[0])) bugs.push({ key: m[0], url: null, source: 'mentioned' });
    }
  }
  return { prs, bugs };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return JSON.stringify(b.input ?? {});
      if (b.type === 'tool_result') return textOf(b.content);
      return '';
    })
    .join('\n');
}

/**
 * Incrementally scans a session transcript. `cursor` ({offset}) is advanced so
 * subsequent calls only parse newly appended lines.
 */
export function scanTranscript(file, cursor, bugPatterns = []) {
  const result = { prs: [], bugs: [], title: null, lastPrompt: null, cost: null, lastActivity: null };
  // Token usage per API response, kept on the cursor so incremental scans accumulate.
  cursor.usage ??= new Map();
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return result;
  }
  try {
    const { size, mtime } = fs.fstatSync(fd);
    result.lastActivity = mtime.toISOString();
    if (size < cursor.offset) cursor.offset = 0; // file was rewritten
    if (size === cursor.offset) return result;
    const buf = Buffer.alloc(size - cursor.offset);
    fs.readSync(fd, buf, 0, buf.length, cursor.offset);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return result; // no complete line yet
    cursor.offset += lastNl + 1;

    for (const line of buf.subarray(0, lastNl).toString('utf8').split('\n')) {
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      switch (rec.type) {
        case 'pr-link':
          if (rec.prUrl) result.prs.push({ ...prFromUrl(rec.prUrl, 'session'), number: rec.prNumber ?? null });
          break;
        case 'ai-title':
          result.title = rec.aiTitle ?? result.title;
          break;
        case 'last-prompt':
          result.lastPrompt = rec.lastPrompt ?? result.lastPrompt;
          break;
        case 'cost-state':
          result.cost = {
            usd: rec.totalCostUSD ?? null,
            linesAdded: rec.totalLinesAdded ?? null,
            linesRemoved: rec.totalLinesRemoved ?? null,
          };
          break;
        case 'assistant': {
          const u = rec.message?.usage;
          if (u) {
            // One response is written as several lines (one per content block); the last has final counts.
            const key = rec.message.id ?? rec.requestId ?? rec.uuid;
            cursor.usage.set(key, {
              input: u.input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              cacheCreation: u.cache_creation_input_tokens ?? 0,
              cacheRead: u.cache_read_input_tokens ?? 0,
            });
          }
          const refs = extractRefs(textOf(rec.message?.content), bugPatterns);
          result.prs.push(...refs.prs);
          result.bugs.push(...refs.bugs);
          break;
        }
        case 'user': {
          const refs = extractRefs(textOf(rec.message?.content), bugPatterns);
          result.prs.push(...refs.prs);
          result.bugs.push(...refs.bugs);
          break;
        }
      }
    }
  } finally {
    fs.closeSync(fd);
  }
  return result;
}

/** PRs whose head is `branch`, via the gh CLI. Returns [] when gh is missing or unauthenticated. */
export async function prsForBranch(cwd, branch) {
  if (process.env.AGENTMGR_NO_GH) return [];
  if (!branch || branch === 'HEAD' || ['main', 'master', 'develop', 'trunk'].includes(branch)) return [];
  try {
    const out = await run(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '20', '--json', 'number,title,url,state,isDraft'],
      { cwd, timeout: 30_000 },
    );
    return JSON.parse(out || '[]').map((p) => ({ ...prFromUrl(p.url, 'branch'), ...p }));
  } catch {
    return [];
  }
}

/** Fill in title/state for a PR URL. */
export async function prDetails(url) {
  if (process.env.AGENTMGR_NO_GH) return null;
  try {
    const out = await run('gh', ['pr', 'view', url, '--json', 'number,title,url,state,isDraft'], { timeout: 30_000 });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- session digest (for Explain)

const stripNoise = (s) =>
  s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<(command-[\w-]+|local-command-[\w-]+)>[\s\S]*?<\/\1>/g, '')
    .trim();
const cap = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One line for a tool call: what the agent did, not its raw output. */
function describeTool(name, input = {}) {
  if (name === 'Bash') return `ran: ${cap(input.description || input.command || '', 160)}`;
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return `edited ${input.file_path ?? input.notebook_path ?? ''}`;
  if (name === 'AskUserQuestion') return `asked the user: ${(input.questions ?? []).map((q) => q.question).join(' / ')}`;
  if (name === 'Skill') return `used skill ${input.skill ?? ''}`;
  if (name === 'Agent' || name === 'Task') return `delegated to a subagent: ${cap(input.description || input.prompt || '', 160)}`;
  if (name === 'TodoWrite') return `updated plan: ${(input.todos ?? []).map((t) => `[${t.status}] ${t.content}`).join('; ')}`;
  if (name === 'ExitPlanMode') return `proposed plan: ${cap(input.plan ?? '', 1500)}`;
  if (name.startsWith('mcp__')) return `called ${name.split('__').slice(-1)[0]} (${name.split('__')[1]})`;
  if (['Read', 'Grep', 'Glob', 'ToolSearch', 'Monitor', 'TaskStop', 'LS'].includes(name)) return null; // too noisy to matter
  return `used ${name}`;
}

/**
 * A compact, chronological digest of a session for a model to summarize: the
 * user's messages, the agent's own words (where plans and conclusions live) and
 * one line per meaningful action. Keeps the first request in full and fills the
 * rest of the budget with the most recent events.
 */
export function sessionDigest(file, { maxChars = 24_000 } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { digest: '', events: 0, edited: [], asked: [] };
  }
  const events = [];
  const edited = new Set();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if ((rec.type !== 'user' && rec.type !== 'assistant') || rec.isMeta || rec.isSidechain) continue;
    const content = rec.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text) {
        const t = stripNoise(b.text);
        if (t) events.push(rec.type === 'user' ? `[user] ${cap(t, 1200)}` : `[agent] ${cap(t, 1800)}`);
      } else if (b.type === 'tool_use' && rec.type === 'assistant') {
        if (['Edit', 'Write', 'MultiEdit'].includes(b.name) && b.input?.file_path) edited.add(b.input.file_path);
        const d = describeTool(b.name, b.input);
        if (d) events.push(`[action] ${d}`);
      }
    }
  }
  const firstUser = events.findIndex((e) => e.startsWith('[user]'));
  const head = firstUser >= 0 ? [events[firstUser]] : [];
  const tail = [];
  let used = head.join('\n').length;
  for (let i = events.length - 1; i > firstUser; i--) {
    if (used + events[i].length + 1 > maxChars) {
      tail.unshift(`… (${i - firstUser} earlier events omitted) …`);
      break;
    }
    tail.unshift(events[i]);
    used += events[i].length + 1;
  }
  return { digest: [...head, ...tail].join('\n'), events: events.length, edited: [...edited] };
}

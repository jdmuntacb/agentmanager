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

const PR_URL = /https?:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g;
const ISSUE_URL = /https?:\/\/[\w.-]+\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/g;
const JIRA_URL = /https?:\/\/[\w.-]+\/browse\/([A-Z][A-Z0-9]+-\d+)/g;

export function prFromUrl(url, source) {
  const m = url.match(/https?:\/\/[\w.-]+\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
  return { url, repo: m?.[1] ?? null, number: m ? Number(m[2]) : null, source };
}

export function bugFromRef(ref, source) {
  const jira = ref.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/);
  if (jira) return { key: jira[1], url: ref, source };
  const gh = ref.match(/https?:\/\/[\w.-]+\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/);
  if (gh) return { key: `${gh[1]}#${gh[2]}`, url: ref, source };
  return { key: ref, url: /^https?:\/\//.test(ref) ? ref : null, source };
}

/** Extract PR and bug references from free text. */
export function extractRefs(text, bugPatterns = []) {
  const prs = [...text.matchAll(PR_URL)].map((m) => prFromUrl(m[0], 'mentioned'));
  const bugs = [
    ...[...text.matchAll(JIRA_URL)].map((m) => bugFromRef(m[0], 'mentioned')),
    ...[...text.matchAll(ISSUE_URL)].map((m) => bugFromRef(m[0], 'mentioned')),
  ];
  for (const pattern of bugPatterns) {
    const re = new RegExp(pattern, 'g');
    for (const m of text.matchAll(re)) bugs.push({ key: m[0], url: null, source: 'mentioned' });
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
        case 'user':
        case 'assistant': {
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

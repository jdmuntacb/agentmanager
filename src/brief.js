// The agent's living brief: Problem, Solution, Diagram and Checks, written by
// Claude to a Markdown file outside the repository and shown in the UI.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

export const BRIEF_FILE = 'BRIEF.md';

export function briefDir(agentId) {
  return path.join(paths.briefs, agentId);
}

export function briefPath(agentId) {
  return path.join(briefDir(agentId), BRIEF_FILE);
}

export const briefPrompt = (file) =>
  `Keep a short, living brief of this task in ${file} (Markdown). Agent Manager shows it to the user ` +
  'next to your terminal. Use exactly these four sections:\n' +
  '## Problem\nWhat is wrong or what is needed, and why (2-5 sentences).\n' +
  '## Solution\nThe approach and the key changes (files, components). Keep it current as the plan evolves.\n' +
  '## Diagram\nOne ```mermaid code block showing the flow, sequence or architecture of the solution. ' +
  'Keep it small and valid Mermaid syntax.\n' +
  '## Checks\nA task list of how the work is verified, one line per check with the command or evidence: ' +
  '"- [ ]" pending, "- [~]" running, "- [x]" passed, "- [!]" failed.\n' +
  'Add a fifth section only when the task links Jira issues (or other tickets):\n' +
  '## References\nLook each linked issue up (use your Jira / Atlassian tools if you have them) and list the ' +
  'documents its fields point to, above all its PRD and Tech Spec fields, plus design docs or Confluence pages. ' +
  'One line per document: "- **PRD**: [title](url) — the 1-2 points that matter for this task". If a field is ' +
  'empty, say so ("- **Tech Spec**: none on IDEA-872"). If you cannot reach Jira, say that in one line. ' +
  'Read the PRD and Tech Spec before settling the Solution.\n' +
  'Write it as soon as you understand the task, then update it when the plan changes and whenever a check ' +
  'runs. Keep it concise. The file is outside the repository: never copy it into the repo or commit it.';

const SECTION_ALIASES = {
  problem: ['problem', 'problem statement', 'issue', 'context'],
  solution: ['solution', 'approach', 'proposed solution', 'plan'],
  diagram: ['diagram', 'design', 'flow', 'architecture', 'design/flow/architecture', 'design / flow / architecture'],
  checks: ['checks', 'verification', 'tests', 'testing', 'validation'],
  references: ['references', 'links', 'documents', 'docs', 'specs', 'prd / tech spec', 'prd/tech spec'],
};

// "- **PRD**: [Title](https://...) — highlight", tolerating ":" / "-" / "–" separators and bare URLs.
const REF_LINE =
  /^\s*[-*]\s+(?:\*\*|__)?([^*_:\[\]]+?)(?:\*\*|__)?\s*:\s*(?:\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|<?(https?:\/\/[^\s>]+)>?)?\s*(?:[—–-]\s*)?(.*)$/;

export function parseReference(line) {
  const m = line.match(REF_LINE);
  if (!m) return null;
  const [, label, title, url1, url2, rest] = m;
  const url = url1 ?? url2 ?? null;
  const highlight = rest.trim();
  // A key spec document (PRD / tech spec / design) is highlighted in the UI.
  const key = /\b(prd|product requirements?|tech(nical)? spec|design (doc|spec)|architecture)\b/i.test(label);
  return { label: label.trim(), title: title ?? null, url, highlight, key, missing: !url && /^none\b|^n\/a\b|^not (set|filled)/i.test(highlight) };
}

function sectionKey(heading) {
  const h = heading.toLowerCase().replace(/[`*_:]/g, '').trim();
  for (const [key, names] of Object.entries(SECTION_ALIASES)) {
    if (names.includes(h) || names.some((n) => h.startsWith(`${n} `))) return key;
  }
  return null;
}

const CHECK_STATES = { ' ': 'pending', '~': 'running', x: 'passed', X: 'passed', '!': 'failed' };

/** Parse the brief Markdown into its four sections. Unknown sections are ignored. */
export function parseBrief(markdown) {
  const out = { problem: '', solution: '', diagram: null, diagramNotes: '', checks: [], references: [] };
  const parts = markdown.split(/^##\s+(.+?)\s*#*\s*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const key = sectionKey(parts[i]);
    const body = (parts[i + 1] ?? '').trim();
    if (!key) continue;
    if (key === 'diagram') {
      const m = body.match(/```mermaid\s*\n([\s\S]*?)```/);
      out.diagram = m ? m[1].trim() : null;
      out.diagramNotes = (m ? body.replace(m[0], '') : body).trim();
    } else if (key === 'references') {
      for (const line of body.split('\n')) {
        const ref = parseReference(line);
        if (ref) out.references.push(ref);
      }
    } else if (key === 'checks') {
      for (const line of body.split('\n')) {
        const m = line.match(/^\s*[-*]\s+\[([ xX!~])\]\s+(.+?)\s*$/);
        if (m) out.checks.push({ state: CHECK_STATES[m[1]], text: m[2] });
      }
    } else {
      out[key] = body;
    }
  }
  const count = (s) => out.checks.filter((c) => c.state === s).length;
  out.summary = {
    passed: count('passed'),
    failed: count('failed'),
    running: count('running'),
    pending: count('pending'),
    total: out.checks.length,
  };
  return out;
}

/** Re-read the brief if it changed since `prev` (by mtime). Returns the new brief, or null if unchanged. */
export function loadBrief(agentId, prev) {
  let st;
  try {
    st = fs.statSync(briefPath(agentId));
  } catch {
    return null;
  }
  if (prev && prev.mtimeMs === st.mtimeMs) return null;
  const markdown = fs.readFileSync(briefPath(agentId), 'utf8');
  return { ...parseBrief(markdown), mtimeMs: st.mtimeMs, updatedAt: st.mtime.toISOString() };
}

/** Ask the agent to learn and follow the project's and user's own rules before working. */
export const conventionsPrompt = ({ withBrief }) =>
  'Before you change anything, learn the rules this project and user have set up, and follow them throughout:\n' +
  '- Read the CLAUDE.md and AGENTS.md files (repository root, the folders you work in, and ~/.claude/CLAUDE.md) ' +
  'and any CONTRIBUTING guide.\n' +
  '- Review the available skills: the ones listed to you, plus SKILL.md files under .claude/skills/ in the ' +
  'repository and ~/.claude/skills/. Read the ones relevant to this task and use them rather than improvising.\n' +
  '- Review hooks and permissions in .claude/settings.json, .claude/settings.local.json and ~/.claude/settings.json, ' +
  'so you know what runs automatically (formatters, linters, checks) and work with it, not around it.\n' +
  '- Check .claude/commands/ and .claude/agents/ for project workflows.\n' +
  'If the repository is not available yet, review the user-level ones now and the repository ones as soon as it is.' +
  (withBrief
    ? '\nRecord what applies as the first item under Checks in the brief, for example: ' +
      '"- [x] Reviewed conventions: skills go-testing, release-notes; hooks: gofmt on edit".'
    : '');

/** Prompt for a one-off, tool-less "explain this task" call. */
export function explainPrompt({ intent, briefMarkdown }) {
  return [
    'You are helping someone quickly understand a software task that an AI agent is working on.',
    "Explain it in plain language for a busy engineer or manager who hasn't read the details.",
    '',
    'Write Markdown with exactly these sections:',
    '### In one line',
    '### The intent',
    'What is being asked and why it matters: who benefits and what changes for them.',
    '### The problem, explained',
    'The key insight: the root cause or core constraint, in simple terms. Use an analogy only if it really helps.',
    '### The solution, explained',
    "Why this approach works, the main trade-offs, and what it deliberately doesn't do.",
    '### Terms',
    'A short glossary of the jargon and acronyms used above (omit the section if there are none).',
    '### Open questions & risks',
    'What is still uncertain or could go wrong.',
    '',
    'Rules: use only the information below. If something is unclear or missing (for example the agent has not',
    'worked out a solution yet), say so plainly instead of guessing. Keep it under about 350 words.',
    '',
    '<intent>',
    intent || '(none)',
    '</intent>',
    '<brief>',
    briefMarkdown || '(the agent has not written its brief yet)',
    '</brief>',
  ].join('\n');
}

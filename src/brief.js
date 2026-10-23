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
  'next to your terminal. Start it with one status line, then use exactly these four sections:\n' +
  'Status: planning | working | blocked | done\n' +
  'Set "done" only when the task is complete and its checks pass; set "blocked" when you need the user.\n' +
  '## Problem\nWhat is wrong or what is needed, and why (2-5 sentences).\n' +
  '## Solution\nThe approach and the key changes (files, components). Keep it current as the plan evolves.\n' +
  '## Diagram\nOne ```mermaid code block showing the flow, sequence or architecture of the solution. ' +
  'Keep it small and valid Mermaid syntax.\n' +
  '## Checks\nA task list of how the work is verified, one line per check with the command or evidence: ' +
  '"- [ ]" pending, "- [~]" running, "- [x]" passed, "- [!]" failed.\n' +
  '## Results\nThe end result so far. First line "Outcome: in progress | partial | done | blocked". Then bullets:\n' +
  '"- Delivered: ..." for each concrete result (PR or commit links, files, documents, answers), and\n' +
  '"- Blocked by: ... (needs: who or what)" for anything blocking progress. Keep it current; it is what reviewers read first.\n' +
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
  results: ['results', 'result', 'outcome', 'status and results', 'results and status'],
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
  const out = { status: null, problem: '', solution: '', diagram: null, diagramNotes: '', checks: [], references: [], results: null };
  const st = markdown.split(/^##\s/m)[0].match(/^\s*\**status\**\s*:\s*\**\s*(planning|working|blocked|done)\b/im);
  if (st) out.status = st[1].toLowerCase();
  const parts = markdown.split(/^##\s+(.+?)\s*#*\s*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const key = sectionKey(parts[i]);
    const body = (parts[i + 1] ?? '').trim();
    if (!key) continue;
    if (key === 'diagram') {
      const m = body.match(/```mermaid\s*\n([\s\S]*?)```/);
      out.diagram = m ? m[1].trim() : null;
      out.diagramNotes = (m ? body.replace(m[0], '') : body).trim();
    } else if (key === 'results') {
      const outcome = body.match(/^\s*\**outcome\**\s*:\s*\**\s*(in progress|in-progress|partial|done|blocked)\b/im)?.[1];
      const lines = body.split('\n');
      const pick = (re) => lines.map((l) => l.match(re)?.[1]?.trim()).filter(Boolean);
      out.results = {
        outcome: outcome ? outcome.toLowerCase().replace('-', ' ') : null,
        // Tolerates "Delivered:", "**Delivered:**" and "**Delivered**:".
        delivered: pick(/^\s*[-*]\s+\**\s*delivered\s*\**\s*:\s*\**\s*(.+)$/i),
        blockers: pick(/^\s*[-*]\s+\**\s*blocked by\s*\**\s*:\s*\**\s*(.+)$/i),
        notes: lines
          .filter((l) => !/^\s*\**\s*outcome\s*\**\s*:/i.test(l) && !/^\s*[-*]\s+\**\s*(delivered|blocked by)\s*\**\s*:/i.test(l))
          .join('\n')
          .trim(),
      };
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

/**
 * Ask the agent to learn and follow the project's and user's own rules before working.
 * Claude Code gets the full list of its own files; other engines get their rules files
 * (`rulesFiles` on the adapter) and a plain warning against turning this into research,
 * which a smaller model otherwise did (it searched the whole disk for Claude's settings).
 */
export const conventionsPrompt = ({ withBrief, rulesFiles = null }) =>
  (rulesFiles
    ? 'Before you change anything, take a quick look at the rules this project has set up, and follow them throughout:\n' +
      `- Read ${rulesFiles.join(', ')} and any CONTRIBUTING guide in the repository root and the folders you work in, if they exist.\n` +
      '- If the repository has SKILL.md files under .claude/skills/, read the ones relevant to this task.\n' +
      "This is a quick check, not an investigation: don't search outside the repository, and if there's nothing, go straight to the task." +
      (withBrief ? '\nRecord what applies as the first item under Checks in the brief, for example: "- [x] Reviewed conventions: AGENTS.md".' : '')
    : conventionsClaude({ withBrief }));

const conventionsClaude = ({ withBrief }) =>
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

/**
 * Prompt for a one-off, tool-less "explain what this agent is doing" call, built
 * from the agent's live context: its conversation and actions, repository
 * changes, status and brief.
 */
export function explainPrompt({ intent, status, digest, repo, briefMarkdown }) {
  return [
    "You are briefing a busy engineer on an AI coding agent's work so far. Use the context below (the agent's",
    'actual conversation, actions and repository changes) and explain in plain language what it is doing.',
    '',
    'Write Markdown with exactly these sections:',
    '### The ask',
    'What the user asked for, in one or two sentences, including any later change of direction.',
    '### Where it stands',
    'One or two lines: the phase (planning, investigating, implementing, testing, done, blocked), what it is',
    'doing right now, and whether it is waiting for the user and on what.',
    '### Planned work',
    'The plan as a short checklist, each step marked ✅ done, 🔄 in progress or ⏳ next, based on what the agent',
    'said it would do and what it actually did.',
    '### Solution',
    'The approach and why, and the concrete changes so far: files or components touched, commits, PRs.',
    '### Conclusions so far',
    'Findings, decisions, answers and results (including test results). Write "None yet." if nothing is settled.',
    '### Needs from you',
    'Questions or decisions the agent is waiting on, plus risks and blockers. Write "Nothing right now." if none.',
    '',
    'Rules: rely only on the context. Clearly separate what was done from what was only planned. If the',
    'context is thin or unclear, say so instead of guessing. No preamble. Keep it under about 400 words.',
    '',
    '<agent_status>',
    status,
    '</agent_status>',
    '<intent>',
    intent || '(none)',
    '</intent>',
    '<conversation>',
    digest || '(no conversation recorded yet)',
    '</conversation>',
    '<repository>',
    repo || '(no repository changes recorded)',
    '</repository>',
    '<brief>',
    briefMarkdown || '(the agent has not written a brief yet)',
    '</brief>',
  ].join('\n');
}

/** Prompt for "Insights": Why / What / How / Now, three tidy points each. */
export function insightsPrompt({ intent, status, digest, repo, briefMarkdown }) {
  return [
    "Give a human the four insights that matter about an AI coding agent's work, from its ask and live",
    'context below. Write Markdown with exactly these four sections, in this order:',
    '### Why',
    'Why this work matters: the motivation, the user or business need, or the root cause of the problem.',
    '### What',
    'What is being done or delivered: the scope and the outcome.',
    '### How',
    'How it is being done: the approach, the key mechanism or the main changes.',
    '### Now',
    'Where it stands now and the next step, including anything waiting on the user.',
    '',
    'Style rules, strictly:',
    '- Each section has 1 to 3 bullets, never more. Fewer is better when it is enough.',
    '- Each bullet is one short, concrete line of at most 12 words: easy to remember and repeat.',
    '- Lead with the key word; no filler, no hedging, no nested bullets, no preamble or closing text.',
    '- Use only the context. If something is not known yet, write "Unclear yet" as the bullet.',
    '',
    '<agent_status>',
    status,
    '</agent_status>',
    '<intent>',
    intent || '(none)',
    '</intent>',
    '<conversation>',
    digest || '(no conversation recorded yet)',
    '</conversation>',
    '<repository>',
    repo || '(no repository changes recorded)',
    '</repository>',
    '<brief>',
    briefMarkdown || '(the agent has not written a brief yet)',
    '</brief>',
  ].join('\n');
}

/** Stakeholder documents built from an agent's live context. */
export const DOC_KINDS = {
  analysis: {
    title: 'Analysis',
    sections: [
      ['Summary', 'Two or three sentences a stakeholder can read on their own.'],
      ['Context', 'The background and why this came up (link the ticket or idea if there is one).'],
      ['Findings', 'What was learned from the code, docs and discussion, as specific facts.'],
      ['Root cause / core problem', 'The real problem or constraint behind the request.'],
      ['Constraints and assumptions', 'Limits, dependencies and assumptions that shape any solution.'],
      ['Options considered', 'The options, each with pros and cons, and which one is favoured and why.'],
      ['Open questions', 'What still needs an answer, and from whom.'],
    ],
    diagram: 'Include a diagram only if it clarifies the problem.',
  },
  design: {
    title: 'Design',
    sections: [
      ['Summary', 'What is being built and the key design decision, in two or three sentences.'],
      ['Goals and non-goals', 'Bullets.'],
      ['Architecture', 'Components and how they interact, with one ```mermaid flowchart or graph of the architecture.'],
      ['Components and changes', 'Each component or module touched: its responsibility and the change.'],
      ['Interfaces and data', 'APIs, configuration, schemas or data flows that change.'],
      ['Trade-offs and alternatives', 'What was chosen over what, and why.'],
      ['Risks and mitigations', 'Bullets.'],
      ['Testing and rollout', 'How it is verified and released (flags, phases, rollback).'],
    ],
    diagram: 'Include exactly one architecture diagram.',
  },
  flow: {
    title: 'Flow',
    sections: [
      ['Summary', 'What the flow covers, in one or two sentences.'],
      ['End-to-end flow', 'A ```mermaid flowchart of the main path, then a numbered step-by-step walk-through.'],
      ['Key interactions', 'A ```mermaid sequenceDiagram of the most important interaction between components or services.'],
      ['Failure and edge cases', 'What happens when steps fail or inputs are unusual.'],
    ],
    diagram: 'Use two diagrams: a flowchart and a sequenceDiagram.',
  },
  proposal: {
    title: 'Proposal',
    sections: [
      ['Summary', 'The recommendation in two or three sentences, written for a decision-maker.'],
      ['Problem', 'What is wrong or needed and why it matters now.'],
      ['Recommendation', 'The proposed approach and why it is the best option.'],
      ['Scope', 'In scope and out of scope.'],
      ['Plan', 'Phases or milestones with what each delivers.'],
      ['Effort and dependencies', 'Rough size, teams or systems involved, prerequisites.'],
      ['Risks', 'Main risks with mitigations.'],
      ['Decisions needed', 'The specific decisions or approvals requested from reviewers, as a list.'],
    ],
    diagram: 'Include one small diagram if it helps the decision.',
  },
};

export function docPrompt(kind, { intent, status, digest, repo, briefMarkdown, agentName }) {
  const d = DOC_KINDS[kind];
  return [
    `Write a ${d.title} document about an AI coding agent's work, for stakeholders who will review it.`,
    'Base it only on the context below: the original ask, the agent conversation and actions, repository changes',
    'and its brief. Write for reviewers, not for the agent: no mention of the agent, its tools or this prompt.',
    '',
    `Start with a level-1 title: "# ${d.title}: <short name of the work>". Then these sections, as level-2 headings, in order:`,
    ...d.sections.map(([h, what]) => `## ${h}\n${what}`),
    '',
    'Rules:',
    `- ${d.diagram} Diagrams go in \`\`\`mermaid code blocks with valid Mermaid syntax; keep node labels short and quote labels that contain punctuation.`,
    '- Be specific: name the real files, components, tickets and documents from the context.',
    '- Separate facts from proposals. Where the context does not say, write "To be confirmed" rather than guessing.',
    '- Clear, neutral, professional prose; bullets where they help. Roughly 400-900 words.',
    '- Output only the Markdown document.',
    '',
    '<agent_status>',
    status,
    '</agent_status>',
    '<intent>',
    intent || '(none)',
    '</intent>',
    '<conversation>',
    digest || '(no conversation recorded yet)',
    '</conversation>',
    '<repository>',
    repo || '(no repository changes recorded)',
    '</repository>',
    '<brief>',
    briefMarkdown || '(no brief yet)',
    '</brief>',
  ].join('\n');
}

// ------------------------------------------------------------------ Human vs AI

const contextBlock = ({ intent, status, digest, repo, briefMarkdown }) => [
  '<agent_status>',
  status,
  '</agent_status>',
  '<intent>',
  intent || '(none)',
  '</intent>',
  '<conversation>',
  digest || '(no conversation recorded yet)',
  '</conversation>',
  '<repository>',
  repo || '(no repository changes recorded)',
  '</repository>',
  '<brief>',
  briefMarkdown || '(no brief yet)',
  '</brief>',
];

/**
 * Human vs AI: split the open questions about an agent's work into the few that need a
 * person's judgment and the ones a model can answer by reasoning over the evidence, and
 * answer those. JSON, so the page can lay it out and collect the person's answers.
 */
export function humanAiPrompt(ctx) {
  return [
    "You help a person supervise an AI coding agent. From the context below, work out the open questions about this work and split them by who should answer them.",
    '',
    '1. "human": the 5 most important questions only a person should answer, most important first. They need judgment the',
    '   context cannot supply: intent and priorities, product or user knowledge, risk appetite, trade-offs between goods,',
    '   ethics, policy or accountability. For each give:',
    '   - "question": one sentence.',
    '   - "why_human": why a model should not decide this, in one short sentence.',
    '   - "stakes": what goes wrong if it is answered badly or not at all, in one short sentence.',
    '   - "options": 2 or 3 short, concrete options.',
    '   - "lean": what the context already suggests, in one short sentence, or null. Never decide for them.',
    '2. "ai": up to 5 questions a model can answer by reasoning over the context and evaluating the work: correctness,',
    '   edge cases, consistency with the ask, test coverage, risks in the changes, what is left to do. Answer each:',
    '   - "question": one sentence.',
    '   - "answer": 1 to 3 sentences.',
    '   - "confidence": "high", "medium" or "low".',
    '   - "evidence": the files, commits, commands, test results or quotes from the context it rests on.',
    '   - "check": how a person could verify it in a minute or two.',
    '',
    'Rules:',
    '- Specific to this work: name the real files, tickets and decisions. No generic questions that fit any project.',
    '- Use only the context. Where it does not say, answer that and use low confidence; do not guess.',
    '- Do not put a question in "ai" if answering it means choosing what the person wants.',
    '- Output only one JSON object, no code fence and no other text:',
    '  {"title": "<short name of the work>", "human": [...], "ai": [...]}',
    '',
    ...contextBlock(ctx),
  ].join('\n');
}

/** A second model double-checks the split and every AI answer, against the same context. */
export function critiquePrompt(ctx, draft) {
  return [
    'You are an independent reviewer double-checking another model. It looked at an AI coding agent\'s work (context below)',
    'and split the open questions into ones only a person should answer ("human") and ones it answered itself ("ai").',
    'Check its work against the context, sceptically. Do not trust its evidence without finding it in the context.',
    '',
    'Return:',
    '- "ai": one entry per AI answer, in the same order: {"verdict": "agree" | "partly" | "disagree", "note": "..."}.',
    '  The note says why in one or two sentences; when you disagree or partly agree, give the corrected answer.',
    '- "human": one entry per human question, in the same order: {"verdict": "keep" | "ai" | "reword", "note": "..."}.',
    '  "ai" means a model could answer it from the context (say what the answer is); "reword" means it is unclear,',
    '  leading or not the real decision (give a better wording).',
    '- "missing": up to 3 important questions both lists missed: {"question": "...", "for": "human" | "ai", "why": "..."}.',
    '- "summary": one or two sentences on how far the person can rely on the AI answers.',
    '',
    'Output only one JSON object with those four keys, no code fence and no other text.',
    '',
    '<review>',
    JSON.stringify(draft, null, 2),
    '</review>',
    ...contextBlock(ctx),
  ].join('\n');
}

/** The first JSON object in a model's reply (tolerates a code fence or a sentence around it). */
export function parseJsonReply(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The reply had no JSON in it');
  return JSON.parse(s.slice(start, end + 1));
}

/** Markdown version, for Copy / Download / Print and the CLI. */
export function humanAiMarkdown({ data, critique, answers = {} }) {
  const out = [`# Human vs AI: ${data.title ?? 'review'}`, ''];
  const c = critique?.data;
  out.push('## For you to decide', '');
  (data.human ?? []).forEach((q, i) => {
    out.push(`### ${i + 1}. ${q.question}`, '');
    if (q.why_human) out.push(`- **Why you:** ${q.why_human}`);
    if (q.stakes) out.push(`- **Stakes:** ${q.stakes}`);
    if (q.options?.length) out.push(`- **Options:** ${q.options.join(' · ')}`);
    if (q.lean) out.push(`- **The work so far suggests:** ${q.lean}`);
    if (c?.human?.[i]) out.push(`- **Second opinion (${critique.label}):** ${c.human[i].verdict} — ${c.human[i].note}`);
    out.push(`- **Your answer:** ${answers[i]?.trim() || '_not answered yet_'}`, '');
  });
  out.push('## Answered by AI', '');
  (data.ai ?? []).forEach((q, i) => {
    out.push(`### ${i + 1}. ${q.question}`, '', q.answer, '');
    out.push(`- **Confidence:** ${q.confidence}`);
    if (q.evidence) out.push(`- **Evidence:** ${Array.isArray(q.evidence) ? q.evidence.join('; ') : q.evidence}`);
    if (q.check) out.push(`- **How to check:** ${q.check}`);
    if (c?.ai?.[i]) out.push(`- **Second opinion (${critique.label}):** ${c.ai[i].verdict} — ${c.ai[i].note}`);
    out.push('');
  });
  if (c) {
    out.push(`## Second opinion: ${critique.label}`, '', c.summary ?? '', '');
    for (const m of c.missing ?? []) out.push(`- **Missed (${m.for}):** ${m.question} — ${m.why}`);
  } else if (critique?.error) {
    out.push('## Second opinion', '', `Not available: ${critique.error}`);
  }
  return out.join('\n').trim();
}

/** What "Send my answers" tells the agent. */
export function humanAiMessage({ data, critique, answers = {} }) {
  const lines = ['Answers to the open questions from my Human vs AI review:'];
  (data.human ?? []).forEach((q, i) => {
    const a = answers[i]?.trim();
    if (a) lines.push(`${i + 1}. ${q.question}`, `   My answer: ${a}`);
  });
  const doubts = (data.ai ?? []).map((q, i) => [q, critique?.data?.ai?.[i]]).filter(([, v]) => v && v.verdict !== 'agree');
  if (doubts.length) {
    lines.push('', 'A second model doubted these conclusions about the work. Check them before relying on them:');
    for (const [q, v] of doubts) lines.push(`- ${q.question} (${v.verdict}: ${v.note})`);
  }
  lines.push('', 'Take these into account and continue. If an answer changes the plan, say how before going further.');
  return lines.join('\n');
}

// ------------------------------------------------------------------ plan review

export const PLAN_FILE = 'PLAN.md';
export const planPath = (agentId) => path.join(briefDir(agentId), PLAN_FILE);

/** For agents whose plan the user reviews first: plan, write it down, then wait. */
export const planReviewPrompt = (file) =>
  'The user reviews your implementation plan before you implement anything. First investigate as much as you need ' +
  `(reading code, docs and running read-only commands is fine), then write the plan to ${file} (Markdown) with these sections:\n` +
  '# Plan: <short name>\n## Goal\n## Approach\n## Steps\nNumbered, each small enough to check.\n## Files to change\n' +
  '## Tests and verification\n## Risks and open questions\n' +
  'Then stop and wait. Until a message starting with "Plan approved" arrives, do not edit, create or delete files in ' +
  'the repository, commit, or run commands that change anything. If a message starting with "Plan changes requested" ' +
  `arrives, revise ${file} the same way and wait again. Once approved, implement the plan; if you have to depart from ` +
  `it, update ${file} and say why.`;

export const planApprovedPrompt = (file) =>
  `Your implementation plan in ${file} has been approved by the user. Implement it; if you have to depart from it, update the file and say why.`;

/** PLAN.md if it changed since `prev` (same shape as the brief: markdown + times). */
export function loadPlanFile(agentId, prev) {
  let st;
  try {
    st = fs.statSync(planPath(agentId));
  } catch {
    return null;
  }
  if (prev && prev.mtimeMs === st.mtimeMs) return null;
  return { markdown: fs.readFileSync(planPath(agentId), 'utf8').slice(0, 200_000), mtimeMs: st.mtimeMs, updatedAt: st.mtime.toISOString() };
}

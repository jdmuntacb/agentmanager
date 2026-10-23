import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/xterm-addon-fit/lib/addon-fit.mjs';
import { marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';
import { touchScroll } from '/touchscroll.js';
import { openStream, post, REMOTE } from '/transport.js';

const $ = (sel) => document.querySelector(sel);
const agents = new Map();
let backlogState = { items: [], projects: [], autoRun: true, defaultLimit: 2 };
let projectsState = [];
let sideTab = 'agents';
let showCompleted = false;
const races = new Map(); // race id -> scoreboard
let openRaceId = null;
let raceDiff = null; // { agentId, text }
// #<id> selects an agent; #<id>/term also opens its terminal.
const loginHash = location.hash.match(/(?:^#|&)login=([\w-]+)/)?.[1] ?? null;
// From the hub: #ticket=<one-time ticket>&go=<agent>/term
const ticketHash = location.hash.match(/(?:^#|&)ticket=([\w-]+)/)?.[1] ?? null;
const goHash = ticketHash ? decodeURIComponent(location.hash.match(/(?:^#|&)go=([^&]*)/)?.[1] ?? '') : '';
const [hashId, hashView] = loginHash ? [null, null] : (ticketHash ? goHash : location.hash.slice(1)).split('/');
let selectedId = hashId || null;
let openTermOnLoad = hashView === 'term' || isShell(hashView) || isBrowser(hashView);
let filterText = '';

// ------------------------------------------------------------------ helpers

// Terminal kinds: 'claude' (the agent's session) or 'shell:N' (shell N in its folder).
function isShell(kind) {
  return /^shell(:\d+)?$/.test(kind ?? '');
}
const shellNum = (kind) => Number((kind ?? '').split(':')[1] || 1);
// 'browser:N' is browser tab N (a page this machine serves); 'browser:new' is the address prompt.
function isBrowser(kind) {
  return /^browser:(\d+|new)$/.test(kind ?? '');
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

async function api(method, route, body) {
  const res = await fetch(`/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-agentmgr': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg, ms = 2600, action) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  if (action) {
    const b = Object.assign(document.createElement('button'), { className: 'small primary', textContent: action.label });
    b.onclick = () => {
      el.remove();
      action.run();
    };
    el.append(' ', b);
  }
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

async function act(fn, okMsg) {
  try {
    const res = await fn();
    if (okMsg) toast(okMsg);
    return res;
  } catch (err) {
    toast(`Error: ${err.message}`, 5000);
  }
}

function statusOf(a) {
  if (a.runtime.planning) return a.runtime.attention ? 'attention' : 'planning';
  if (a.status === 'running') {
    if (a.runtime.attention) return 'attention';
    return a.runtime.busy ? 'working' : 'waiting';
  }
  return a.status;
}

/** 1234 -> "1.2k", 3456789 -> "3.5M" */
function fmtTokens(n) {
  if (!n) return '0';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
}

const ioOf = (u) => (u ? (u.io ?? u.input + u.output) : 0);

function usageTitle(u) {
  return `I/O ${ioOf(u).toLocaleString()} (input ${u.input.toLocaleString()} + output ${u.output.toLocaleString()}) · cache write ${u.cacheCreation.toLocaleString()} · cache read ${u.cacheRead.toLocaleString()} · total incl. cache ${u.total.toLocaleString()} · ${u.requests} API requests`;
}

const tokensOpen = new Set(); // agents whose token breakdown is expanded

// ------------------------------------------------------------------ brief

// Agent-written Markdown: render, then sanitize (this page also drives terminals).
const md = (text) => DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: false }));

const CHECK_ICON = { passed: '✓', failed: '✗', running: '◔', pending: '○' };

function checksSummary(b) {
  if (!b?.summary?.total) return '';
  const { passed, failed, running, pending } = b.summary;
  return [passed && `${passed} passed`, failed && `${failed} failed`, running && `${running} running`, pending && `${pending} pending`]
    .filter(Boolean)
    .join(' · ');
}

const diagrams = new Map(); // mermaid source -> rendered SVG (or an error)
const expanded = new Set(); // "<agent id>:<section>" the user opened with Show more

/** Long sections are clamped; Show more toggles them. */
const clamp = (a, key, html) =>
  `<div class="clamp ${expanded.has(`${a.id}:${key}`) ? 'open' : ''}" data-clamp="${a.id}:${key}"><div class="md">${html}</div>` +
  `<button class="link more" data-more="${a.id}:${key}"></button></div>`;

function markOverflow(root) {
  for (const el of root.querySelectorAll('.clamp')) {
    const inner = el.querySelector('.md');
    el.classList.toggle('overflowing', el.classList.contains('open') || inner.scrollHeight > inner.clientHeight + 4);
    el.querySelector('.more').textContent = el.classList.contains('open') ? 'Show less' : 'Show more';
  }
}
let mermaidLib = null;

async function renderDiagrams(root) {
  const slots = [...root.querySelectorAll('[data-mermaid]')];
  if (!slots.length) return;
  for (const slot of slots) {
    const src = slot.dataset.mermaid;
    if (!diagrams.has(src)) {
      try {
        if (!mermaidLib) {
          mermaidLib = (await import('/vendor/mermaid/mermaid.esm.min.mjs')).default;
          const dark = matchMedia('(prefers-color-scheme: dark)').matches;
          mermaidLib.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' });
        }
        const { svg } = await mermaidLib.render(`mmd-${diagrams.size}-${Date.now()}`, src);
        diagrams.set(src, { svg });
      } catch (err) {
        diagrams.set(src, { error: String(err?.message || err).split('\n')[0] });
      }
    }
    const out = diagrams.get(src);
    // The detail pane may have re-rendered while we were drawing; fill whichever slot is current.
    for (const el of document.querySelectorAll('[data-mermaid]')) {
      if (el.dataset.mermaid !== src || el.dataset.filled) continue;
      el.dataset.filled = '1';
      if (out.svg) el.innerHTML = out.svg;
      else el.innerHTML = `<div class="hint">Diagram could not be drawn (${esc(out.error)}). Source:</div><pre>${esc(src)}</pre>`;
    }
  }
}

function explainBox(a) {
  const ex = a.explanation;
  const label = ex?.pending ? 'Explaining…' : ex?.markdown ? 'Explain again' : 'Explain';
  const button = `<button class="small ${ex?.markdown ? '' : 'primary'}" data-act="explain" ${ex?.pending ? 'disabled' : ''}
    title="What this agent is doing: the ask, where it stands, planned work, solution, conclusions and what it needs from you. Built from its live session by a separate one-off Claude call (does not interrupt the agent)">${label}</button>`;
  if (!ex?.markdown && !ex?.error) return { button, box: '' };
  const stale = ex.markdown && a.brief?.updatedAt && ex.briefUpdatedAt !== a.brief.updatedAt;
  const box = `<div class="explain">
      ${ex.error ? `<p class="error">Couldn't explain: ${esc(ex.error)}</p>` : ''}
      ${ex.markdown
        ? `${stale ? '<p class="hint">The brief has changed since this explanation; use <b>Explain again</b> to refresh it.</p>' : ''}
           ${clamp(a, 'explain', md(ex.markdown))}
           <p class="hint">Explained ${ago(ex.at)}.</p>`
        : ''}
    </div>`;
  return { button, box };
}

const INSIGHT_ICONS = { why: '🎯', what: '📦', how: '🛠', now: '📍' };

// ------------------------------------------------------------------ stakeholder documents

const DOCS = { analysis: 'Analysis', design: 'Design', flow: 'Flow', proposal: 'Proposal', humanai: 'Human vs AI' };
const DOC_TITLES = { ...DOCS, plan: 'Implementation plan' };
/** What the document dialog shows: a stakeholder document, or the agent's plan under review. */
const docOf = (a, kind) => (kind === 'plan' ? a?.planReview && { markdown: a.planReview.markdown, at: a.planReview.updatedAt } : a?.docs?.[kind]);

const VERDICT = { agree: '✓ Agrees', partly: '≈ Partly agrees', disagree: '✗ Disagrees', keep: '✓ Keep', ai: '🤖 AI could answer', reword: '✎ Reword' };
const CONFIDENCE = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

/** Human vs AI: your questions with answer boxes, the AI's answers, and the second model's checks. */
function humanAiHtml(d) {
  const c = d.critique?.data;
  const second = (v) =>
    v ? `<p class="second ${esc(v.verdict)}"><span class="verdict">${VERDICT[v.verdict] ?? esc(v.verdict)}</span> <span class="hint">${esc(d.critique.label)}:</span> ${esc(v.note)}</p>` : '';
  const evidence = (e) => (Array.isArray(e) ? e.join('; ') : e ?? '');
  const human = (d.data.human ?? [])
    .map(
      (q, i) => `<section class="ha-card human">
      <h4>${i + 1}. ${esc(q.question)}</h4>
      ${q.why_human ? `<p><b>Why you:</b> ${esc(q.why_human)}</p>` : ''}
      ${q.stakes ? `<p><b>Stakes:</b> ${esc(q.stakes)}</p>` : ''}
      ${q.options?.length ? `<p class="ha-options">${q.options.map((o) => `<button type="button" class="small" data-ha-pick="${i}" data-text="${esc(o)}">${esc(o)}</button>`).join(' ')}</p>` : ''}
      ${q.lean ? `<p class="hint">The work so far suggests: ${esc(q.lean)}</p>` : ''}
      ${second(c?.human?.[i])}
      <textarea data-ha="${i}" rows="2" placeholder="Your answer…">${esc(d.answers?.[i] ?? '')}</textarea>
    </section>`,
    )
    .join('');
  const ai = (d.data.ai ?? [])
    .map(
      (q, i) => `<section class="ha-card ai">
      <h4>${i + 1}. ${esc(q.question)} <span class="tag conf-${esc(q.confidence)}">${CONFIDENCE[q.confidence] ?? esc(q.confidence)}</span></h4>
      <div class="md">${md(q.answer ?? '')}</div>
      ${q.evidence ? `<p class="hint"><b>Evidence:</b> ${esc(evidence(q.evidence))}</p>` : ''}
      ${q.check ? `<p class="hint"><b>How to check:</b> ${esc(q.check)}</p>` : ''}
      ${second(c?.ai?.[i])}
    </section>`,
    )
    .join('');
  const missing = c?.missing?.length
    ? `<ul>${c.missing.map((m) => `<li><b>${m.for === 'human' ? 'For you' : 'For AI'}:</b> ${esc(m.question)} <span class="hint">${esc(m.why)}</span></li>`).join('')}</ul>`
    : '';
  const review = c
    ? `<section class="ha-second"><h3>Second opinion · ${esc(d.critique.label)}</h3><p>${esc(c.summary ?? '')}</p>${missing ? `<p class="hint">Questions both lists missed:</p>${missing}` : ''}</section>`
    : d.critique?.error
      ? `<p class="error">Second opinion not available (${esc(d.critique.label)}): ${esc(d.critique.error)}</p>`
      : '';
  return `<h1>Human vs AI: ${esc(d.data.title ?? '')}</h1>
    <h2>🧑 For you to decide</h2><p class="hint">Judgment calls the agent shouldn't make for you. Answer what you can and send them to the agent.</p>${human}
    <h2>🤖 Answered by AI</h2><p class="hint">Reasoning and evaluation from the agent's session and changes, each checked by a second model.</p>${ai}
    ${review}`;
}

/** Markdown with ```mermaid blocks drawn as diagrams (everything else sanitized). */
function docHtml(markdown) {
  const blocks = [];
  const text = (markdown ?? '').replace(/```mermaid\s*\n([\s\S]*?)```/g, (_, src) => {
    blocks.push(src.trim());
    return `\n\nMERMAIDBLOCK${blocks.length - 1}\n\n`;
  });
  return md(text).replace(/<p>MERMAIDBLOCK(\d+)<\/p>/g, (_, i) => `<div class="diagram" data-mermaid="${esc(blocks[Number(i)])}"></div>`);
}

function docButtons(a) {
  const missing = Object.keys(DOCS).filter((k) => !a.docs?.[k]?.markdown && !a.docs?.[k]?.pending);
  const all = missing.length
    ? `<button class="small ghost" data-doc-all title="Write ${missing.map((k) => DOCS[k]).join(', ')} in the background; you'll be told when each is ready">Write all in background</button>`
    : '';
  return `<span class="doc-buttons" title="Documents to share with stakeholders">${all}${Object.entries(DOCS)
    .map(([k, label]) => {
      const d = a.docs?.[k];
      const stale = d?.markdown && a.brief?.updatedAt && d.briefUpdatedAt !== a.brief.updatedAt;
      return `<button class="small doc-btn ${d?.markdown ? 'has' : ''}" data-doc="${k}" ${d?.pending ? 'disabled' : ''}
        title="${d?.markdown ? `Open the ${label.toLowerCase()} document${stale ? ' (the brief changed since)' : ''}` : `Write a ${label.toLowerCase()} document for stakeholders`}">${d?.pending ? `${label}…` : label}${d?.markdown ? (stale ? ' •' : ' ✓') : ''}</button>`;
    })
    .join('')}</span>`;
}

let docView = null; // { agentId, kind }

function renderDocDialog() {
  if (!docView) return;
  const a = agents.get(docView.agentId);
  const d = docOf(a, docView.kind);
  const label = DOC_TITLES[docView.kind];
  const plan = docView.kind === 'plan';
  $('#doc-title').textContent = `${label} · ${a?.name ?? ''}`;
  const body = $('#doc-body');
  if (d?.pending) {
    body.innerHTML = `<p class="hint">${docView.kind === 'humanai' ? 'Splitting the open questions and answering the AI ones, then asking a second model to check…' : `Writing the ${label.toLowerCase()} document from the agent's work so far…`}</p>`;
    body.dataset.rendered = '';
  } else if (d?.error) body.innerHTML = `<p class="error">Couldn't write it: ${esc(d.error)}</p>`;
  else if (plan && !d?.markdown) body.innerHTML = '<p class="hint">The agent is investigating and hasn\'t written its plan yet. You\'ll see it here (and in the inbox) when it has.</p>';
  else if (d?.markdown) {
    if (body.dataset.rendered !== d.at) {
      body.innerHTML = d.data ? humanAiHtml(d) : docHtml(d.markdown);
      body.dataset.rendered = d.at;
      renderDiagrams(body);
    }
  }
  const stale = !plan && d?.markdown && a.brief?.updatedAt && d.briefUpdatedAt !== a.brief.updatedAt;
  const by = d?.writer ? ` by ${d.writer}${d.critique ? `, checked by ${d.critique.label}` : ''}` : '';
  $('#doc-meta').textContent = d?.markdown ? `${plan ? `Plan · ${PLAN_LABEL[a.planReview.status]} · updated` : 'Written'} ${ago(d.at)}${by}${stale ? ' · the brief has changed since; Regenerate for the latest' : ''}` : '';
  for (const id of ['doc-copy', 'doc-download', 'doc-print']) $(`#${id}`).disabled = !d?.markdown;
  $('#doc-print').hidden = plan;
  $('#doc-regen').hidden = plan;
  $('#doc-regen').disabled = Boolean(d?.pending);
  $('#doc-bg').hidden = !d?.pending;
  // Footer: send your answers (Human vs AI), or approve / send back the plan.
  const foot = $('#doc-foot');
  const reviewing = plan && ['review', 'changes'].includes(a?.planReview?.status) && d?.markdown;
  foot.hidden = !(reviewing || (docView.kind === 'humanai' && d?.data));
  if (foot.dataset.mode !== (plan ? 'plan' : 'humanai')) {
    foot.dataset.mode = plan ? 'plan' : 'humanai';
    foot.innerHTML = plan
      ? `<textarea id="plan-note" rows="2" placeholder="Notes for the agent (required to request changes, optional when approving)"></textarea>
         <div class="doc-foot-actions"><button type="button" class="small" data-plan="changes">Request changes</button><button type="button" class="small primary" data-plan="approve">Approve and implement</button></div>`
      : `<span class="hint">Your answers are kept with the agent.</span><div class="doc-foot-actions"><button type="button" class="small" data-ha-act="save">Save</button><button type="button" class="small primary" data-ha-act="send">Send my answers to the agent</button></div>`;
  }
}

function openDoc(agentId, kind) {
  docView = { agentId, kind };
  $('#doc-body').dataset.rendered = '';
  $('#doc-dialog').showModal();
  const a = agents.get(agentId);
  if (kind !== 'plan' && !a.docs?.[kind]?.markdown && !a.docs?.[kind]?.pending) generateDoc();
  renderDocDialog();
}

function generateDoc() {
  const { agentId, kind } = docView;
  act(async () => upsert(await api('POST', `/agents/${agentId}/docs/${kind}`)));
}

$('#doc-close').onclick = () => {
  docView = null;
  $('#doc-dialog').close();
};
$('#doc-bg').onclick = () => {
  toast(`Writing ${DOCS[docView.kind].toLowerCase()} in the background; you'll be told when it's ready`, 3500);
  docView = null;
  $('#doc-dialog').close();
};

// Tell the user when a document finishes while they're not looking at it.
const docsSeen = new Map(); // "<agent>:<kind>" -> pending?
function watchDocs(a) {
  for (const k of Object.keys(DOCS)) {
    const key = `${a.id}:${k}`;
    const d = a.docs?.[k];
    const was = docsSeen.get(key);
    docsSeen.set(key, Boolean(d?.pending));
    if (!was || d?.pending) continue;
    const viewing = docView && docView.agentId === a.id && docView.kind === k;
    if (viewing) continue;
    if (d?.markdown && !d.error) toast(`${DOCS[k]} for ${a.name} is ready`, 10000, { label: 'Open', run: () => openDoc(a.id, k) });
    else if (d?.error) toast(`${DOCS[k]} for ${a.name} failed: ${d.error}`, 8000);
  }
}
$('#doc-regen').onclick = () => generateDoc();
$('#doc-copy').onclick = async () => {
  const d = docOf(agents.get(docView.agentId), docView.kind);
  await navigator.clipboard.writeText(d.markdown).then(
    () => toast('Markdown copied; paste into Confluence, Google Docs, Slack or a PR'),
    () => toast('Copy failed: your browser blocked clipboard access'),
  );
};
$('#doc-download').onclick = () => {
  const a = agents.get(docView.agentId);
  const blob = new Blob([docOf(a, docView.kind).markdown], { type: 'text/markdown' });
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${a.slug}-${docView.kind}.md` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};
const haAnswers = () => Object.fromEntries([...document.querySelectorAll('#doc-body [data-ha]')].map((t) => [t.dataset.ha, t.value]));
$('#doc-body').addEventListener('click', (e) => {
  const pick = e.target.closest('[data-ha-pick]');
  if (!pick) return;
  const box = $(`#doc-body [data-ha="${pick.dataset.haPick}"]`);
  box.value = box.value.trim() ? `${box.value.trim()} ${pick.dataset.text}` : pick.dataset.text;
  box.focus();
});
$('#doc-body').addEventListener('change', (e) => {
  if (e.target.dataset.ha === undefined || !docView) return;
  api('POST', `/agents/${docView.agentId}/humanai/answers`, { answers: haAnswers() }).then(upsert).catch(() => {});
});
$('#doc-foot').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ha-act], [data-plan]');
  if (!b || !docView) return;
  const id = docView.agentId;
  if (b.dataset.haAct) {
    const send = b.dataset.haAct === 'send';
    return act(async () => upsert(await api('POST', `/agents/${id}/humanai/answers`, { answers: haAnswers(), send })), send ? 'Sent to the agent' : 'Saved');
  }
  const note = $('#plan-note').value;
  act(async () => {
    upsert(await api('POST', `/agents/${id}/plan/${b.dataset.plan}`, { note }));
    $('#plan-note').value = '';
    if (b.dataset.plan === 'approve') $('#doc-close').click();
  }, b.dataset.plan === 'approve' ? 'Approved; the agent is implementing it' : 'Sent back to the agent');
});
function openPlan(agentId) {
  docView = { agentId, kind: 'plan' };
  $('#doc-body').dataset.rendered = '';
  $('#doc-dialog').showModal();
  renderDocDialog();
}

const PLAN_LABEL = { writing: 'being written', review: 'waiting for your review', changes: 'changes requested', approved: 'approved' };
/** The plan-review row in the brief card: status, open, approve; or the switch to turn review on. */
function planRow(a) {
  if (a.kind === 'general') return '';
  const p = a.planReview;
  if (!p) {
    return a.status === 'done' ? '' : `<div class="plan-row"><button class="small ghost" data-act="plan-on" title="The agent writes an implementation plan and waits for your approval before changing anything">Review its plan first</button></div>`;
  }
  return `<div class="plan-row ${p.status}"><b>Plan</b> <span class="tag plan-${p.status}">${PLAN_LABEL[p.status]}</span>
    <button class="small ${p.status === 'review' ? 'primary' : ''}" data-act="plan-open" ${p.markdown ? '' : 'disabled'}>${p.status === 'review' ? 'Review plan' : 'Open plan'}</button>
    ${p.status !== 'approved' ? '<button class="small ghost" data-act="plan-skip" title="Stop waiting for review; the agent goes ahead">Skip review</button>' : ''}</div>`;
}
$('#doc-print').onclick = () => window.open(`/share.html#${docView.agentId}/${docView.kind}`, '_blank', 'noopener');

/** Why / What / How / Now as four cards. */
function insightsBox(a) {
  const ins = a.insights;
  const button = `<button class="small ${ins?.markdown ? '' : 'primary'}" data-act="insights" ${ins?.pending ? 'disabled' : ''}
    title="Why, What, How and Now in three memorable points each, from the agent's ask and live session (a separate one-off Claude call)">${ins?.pending ? 'Thinking…' : ins?.markdown ? 'Refresh insights' : 'Insights'}</button>`;
  if (!ins?.markdown && !ins?.error) return { button, box: '' };
  const sections = {};
  for (const part of (ins.markdown ?? '').split(/^###\s+/m).slice(1)) {
    const [head, ...rest] = part.split('\n');
    const key = head.trim().toLowerCase().replace(/[^a-z]/g, '');
    if (INSIGHT_ICONS[key]) sections[key] = rest.join('\n').trim();
  }
  const stale = ins.markdown && a.brief?.updatedAt && ins.briefUpdatedAt !== a.brief.updatedAt;
  const box = `<div class="insights">
      ${ins.error ? `<p class="error">Couldn't get insights: ${esc(ins.error)}</p>` : ''}
      ${ins.markdown
        ? Object.keys(sections).length
          ? `<div class="insight-grid">${Object.keys(INSIGHT_ICONS)
              .map((k) => `<section class="insight ${k}"><h4>${INSIGHT_ICONS[k]} ${k[0].toUpperCase()}${k.slice(1)}</h4><div class="md">${md(sections[k] || 'Unclear yet')}</div></section>`)
              .join('')}</div>`
          : `<div class="md">${md(ins.markdown)}</div>`
        : ''}
      ${ins.markdown ? `<p class="hint">${stale ? 'The brief has changed since; refresh for the latest. · ' : ''}From ${ago(ins.at)}.</p>` : ''}
    </div>`;
  return { button, box };
}

const OUTCOME = {
  done: ['✅', 'Done'],
  partial: ['🟡', 'Partial'],
  blocked: ['⛔', 'Blocked'],
  'in progress': ['🔄', 'In progress'],
};

/** End result, status and blockers: first thing a reviewer reads. */
function resultsCard(a) {
  const r = a.results;
  if (!r) return '';
  const [icon, label] = OUTCOME[r.outcome] ?? ['🔄', r.outcome];
  const item = (x, cls) => `<li class="${cls}">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${md(x.text).replace(/^<p>|<\/p>\s*$/g, '')}</a>` : md(x.text).replace(/^<p>|<\/p>\s*$/g, '')}</li>`;
  return `<div class="results ${r.outcome.replace(' ', '-')}">
    <h4>Results <span class="outcome">${icon} ${label}</span>${r.fromAgent ? '' : ' <span class="hint">(from what Agent Manager can see; the agent adds its own when it next updates its brief)</span>'}</h4>
    ${r.blockers.length ? `<ul class="blockers">${r.blockers.map((x) => item(x, 'blocker')).join('')}</ul>` : ''}
    ${r.delivered.length ? `<ul class="delivered">${r.delivered.map((x) => item(x, 'delivered')).join('')}</ul>` : '<p class="hint">Nothing delivered yet.</p>'}
    ${r.notes ? `<div class="md">${md(r.notes)}</div>` : ''}
  </div>`;
}

function briefPanel(a) {
  if (a.kind === 'general') return '';
  const b = a.brief;
  const ex = explainBox(a);
  const ins = insightsBox(a);
  if (!b) {
    return `<div class="card brief">
      <h3>Brief <span class="brief-actions">${ins.button} ${ex.button}</span></h3>
      ${planRow(a)}
      <div class="share-row"><span class="hint">Share for review:</span> ${docButtons(a)}</div>
      ${resultsCard(a)}
      ${ins.box}
      ${ex.box}
      <p class="hint">Problem, solution, diagram and checks appear here once the agent writes its brief.
      ${a.lastStartedAt && !a.runtime.running ? ' Agents started before this feature write one after their next resume.' : ''}</p>
    </div>`;
  }
  const checks = b.checks.length
    ? `<ul class="checks">${b.checks
        .map((c) => `<li class="${c.state}"><span class="icon" title="${c.state}">${CHECK_ICON[c.state]}</span><span>${md(c.text).replace(/^<p>|<\/p>\s*$/g, '')}</span></li>`)
        .join('')}</ul>`
    : '<p class="hint">No checks yet.</p>';
  return `<div class="card brief">
    <h3>Brief <span class="brief-actions"><span title="${esc(b.updatedAt)}">updated ${ago(b.updatedAt)}</span> ${ins.button} ${ex.button}</span></h3>
    ${planRow(a)}
    <div class="share-row"><span class="hint">Share for review:</span> ${docButtons(a)}</div>
    ${resultsCard(a)}
    ${ins.box}
    ${ex.box}
    <div class="brief-grid">
      <section><h4>Problem</h4>${b.problem ? clamp(a, 'problem', md(b.problem)) : '<p class="hint">—</p>'}</section>
      <section><h4>Solution</h4>${b.solution ? clamp(a, 'solution', md(b.solution)) : '<p class="hint">—</p>'}</section>
      ${b.references?.length
        ? `<section class="wide"><h4>References <span class="hint">from the linked issue</span></h4>
            <ul class="refs">${b.references
              .map(
                (r) => `<li class="${r.key ? 'key' : ''} ${r.missing ? 'missing' : ''}">
                  <span class="ref-label">${esc(r.label)}</span>
                  ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title || r.url)}</a>` : ''}
                  ${r.highlight ? `<span class="ref-hl">${md(r.highlight).replace(/^<p>|<\/p>\s*$/g, '')}</span>` : ''}
                </li>`,
              )
              .join('')}</ul>
          </section>`
        : ''}
      <section class="wide"><h4>Design / flow</h4>
        ${b.diagram ? `<div class="diagram" data-mermaid="${esc(b.diagram)}"></div>` : '<p class="hint">No diagram yet.</p>'}
        ${b.diagramNotes ? `<div class="md">${md(b.diagramNotes)}</div>` : ''}
      </section>
      <section class="wide"><h4>Checks <span class="hint">${esc(checksSummary(b))}</span></h4>${checks}</section>
    </div>
  </div>`;
}

const pillText = (st) => (st === 'attention' ? 'needs input' : st);

/** "Cloning · Receiving objects 45% · 2.10 GiB · 2.40 MiB/s" */
function progressText(p) {
  if (!p) return '';
  const parts = [p.phase];
  if (p.step) parts.push(`${p.step} ${p.percent}%`);
  if (p.size) parts.push(p.size);
  if (p.rate) parts.push(p.rate);
  return parts.join(' · ');
}

function ago(iso) {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const copyBtn = (value) => `<button class="link" data-copy="${esc(value)}" title="Copy">⧉</button>`;

// ------------------------------------------------------------------ list

/** Agents waiting on you first, then running ones, then the rest. */
const rank = (a) => (a.runtime.attention ? 0 : a.runtime.running ? 1 : 2);

// Projects the user collapsed in the tree (kept per browser).
const collapsed = new Set(
  (() => {
    try {
      return JSON.parse(localStorage.getItem('agentmgr.collapsed') || '[]');
    } catch {
      return [];
    }
  })(),
);
function saveCollapsed() {
  try {
    localStorage.setItem('agentmgr.collapsed', JSON.stringify([...collapsed]));
  } catch {}
}

/** P0 solid red, P1 red outline, P3 muted; P2 (the default) only shown where asked. */
const prioChip = (p, { always = false } = {}) =>
  p === 2 && !always ? '' : `<span class="prio p${p}" title="Priority P${p}">P${p}</span>`;

function agentItem(a) {
  const st = statusOf(a);
  return `<li data-id="${a.id}" class="agent pr${a.priority ?? 2} ${a.id === selectedId ? 'selected' : ''}">
    <div class="line1">${prioChip(a.priority ?? 2)}${a.results?.outcome === 'blocked' ? '<span class="outcome-mark" title="Blocked">⛔</span>' : a.results?.outcome === 'done' ? '<span class="outcome-mark" title="Done">✅</span>' : ''}<span class="name">${esc(a.name)}</span>${flags(a)}<span class="pill ${st}">${pillText(st)}</span></div>
    <div class="intent">${a.kind === 'general' ? '<span class="tag">general</span> ' : ''}${a.engine && a.engine !== 'claude' ? `<span class="tag engine">${esc(ENGINE_LABEL[a.engine] ?? a.engine)}</span> ` : ''}${esc(a.intent || 'General session')}</div>
    ${a.status === 'preparing' && a.progress ? `<div class="progress-line">${esc(progressText(a.progress))}</div>` : ''}
    <div class="meta">
      <span class="mono">${a.id}</span>
      ${a.git?.branch ? `<span class="branch" title="${esc(a.git.branch)}">⎇ ${esc(a.git.branch)}</span>` : ''}
      ${a.prs.length ? `<span>${a.prs.length} PR</span>` : ''}
      ${a.bugs.length ? `<span>${a.bugs.length} bug</span>` : ''}
      ${a.usage?.total ? `<span title="${esc(usageTitle(a.usage))}">${fmtTokens(ioOf(a.usage))} tok</span>` : ''}
      ${(a.brief?.references ?? []).filter((r) => r.key && r.url).map((r) => `<span class="tag key-ref" title="${esc(r.title || r.url)}">${esc(r.label)}</span>`).join('')}
      ${a.brief?.summary?.total
        ? `<span class="${a.brief.summary.failed ? 'fail' : ''}" title="${esc(checksSummary(a.brief))}">✓${a.brief.summary.passed}/${a.brief.summary.total}${a.brief.summary.failed ? ` ✗${a.brief.summary.failed}` : ''}</span>`
        : ''}
      ${a.runtime.clients ? `<span title="terminals attached">◉ ${a.runtime.clients}</span>` : ''}
    </div>
  </li>`;
}

/** Agents grouped into projects, busiest and most urgent first. */
function projectGroups(list) {
  const groups = new Map();
  for (const a of list) {
    const p = a.projectInfo ?? { key: 'other', name: 'Other' };
    if (!groups.has(p.key)) groups.set(p.key, { ...p, agents: [] });
    if (p.shortcut) groups.get(p.key).shortcut = p.shortcut;
    groups.get(p.key).agents.push(a);
  }
  const out = [...groups.values()];
  for (const g of out) {
    // Highest priority first, then agents needing you, then running ones, then newest.
    g.agents.sort((a, b) => (a.priority ?? 2) - (b.priority ?? 2) || rank(a) - rank(b) || b.createdAt.localeCompare(a.createdAt));
    g.top = Math.min(...g.agents.map((a) => a.priority ?? 2));
    g.running = g.agents.filter((a) => a.runtime.running).length;
    g.waiting = g.agents.filter((a) => a.runtime.attention).length;
    g.tokens = g.agents.reduce((n, a) => n + (a.usage?.total ?? 0), 0);
  }
  // Two different repos with the same name: show org/name to tell them apart.
  const byName = Map.groupBy ? Map.groupBy(out, (g) => g.name) : null;
  for (const g of out) {
    const same = byName ? byName.get(g.name).length : out.filter((x) => x.name === g.name).length;
    g.label = same > 1 && g.full ? g.full : g.name;
  }
  const special = (g) => (g.key === 'general' ? 1 : g.key === 'other' ? 2 : 0);
  return out.sort(
    (a, b) => special(a) - special(b) || a.top - b.top || b.waiting - a.waiting || b.running - a.running || a.label.localeCompare(b.label),
  );
}

function renderList() {
  const waiting = [...agents.values()].filter((a) => a.runtime.attention).length;
  document.title = waiting ? `(${waiting}) Agent Manager` : 'Agent Manager';
  // "@cc" shows one project; any other text also matches shortcuts.
  const at = filterText.startsWith('@') ? filterText.slice(1) : null;
  const list = [...agents.values()].filter((a) =>
    !filterText
      ? true
      : at !== null
        ? (a.projectInfo?.shortcut ?? '') === at || (at && (a.projectInfo?.shortcut ?? '').startsWith(at))
        : `${a.name} ${a.intent} ${a.repo ?? ''} ${a.workdir ?? ''} ${a.id} ${a.projectInfo?.name ?? ''} ${a.projectInfo?.shortcut ?? ''}`
            .toLowerCase()
            .includes(filterText),
  );
  $('#empty').hidden = agents.size > 0;

  const all = [...agents.values()];
  const projects = new Set(all.map((a) => a.projectInfo?.key ?? 'other')).size;
  const running = all.filter((a) => a.runtime.running).length;
  $('#counts').innerHTML = agents.size
    ? `<span title="Projects">${projects} project${projects === 1 ? '' : 's'}</span><span>${agents.size} agents</span><span>${running} running</span>
       ${waiting ? `<span class="fail">${waiting} need${waiting === 1 ? 's' : ''} input</span>` : ''}
       <span class="spacer"></span><button class="link" id="flush-btn" title="Save session IDs, terminal scrollback and state to disk now (also automatic every 30s)">Save now</button>`
    : '';

  $('#agent-list').innerHTML = projectGroups(list)
    .map((g) => {
      // While filtering, show every match; otherwise respect collapsed projects.
      const open = filterText || !collapsed.has(g.key) || g.agents.some((a) => a.id === selectedId);
      return `<li class="project ${open ? 'open' : ''}">
        <button class="project-head" data-toggle="${esc(g.key)}" aria-expanded="${open}" title="${esc(g.full || g.name)}">
          <span class="caret">${open ? '▾' : '▸'}</span>
          ${g.shortcut ? `<span class="shortcut" data-rename="${esc(g.shortcut)}" title="Shortcut: type @${esc(g.shortcut)} to filter, or use it as the project when adding agents (click to rename)">${esc(g.shortcut)}</span>` : ''}
          <span class="pname">${esc(g.label)}</span>
          <span class="pcounts">
            ${g.top <= 1 ? prioChip(g.top) : ''}
            ${g.waiting ? `<span class="pill attention" title="needs input">${g.waiting}</span>` : ''}
            <span title="running / agents">${g.running}/${g.agents.length}</span>
          </span>
        </button>
        ${open ? `<ul class="project-agents">${g.agents.map(agentItem).join('')}</ul>` : ''}
      </li>`;
    })
    .join('');
}

// ------------------------------------------------------------------ backlog

const ITEM_ACTIONS = {
  queued: [['up', '▲', 'Move up'], ['down', '▼', 'Move down'], ['start', 'Start now', 'Start now, even if the project is at its limit'], ['cancel', 'Cancel', '']],
  active: [['open', 'Open', 'Open its agent'], ['accept', 'Done', 'Mark done now'], ['cancel', 'Cancel', '']],
  review: [['accept', 'Accept', 'Accept the work: done'], ['reopen', 'Reopen', 'Send it back to the same agent with a note'], ['open', 'Open', 'Open its agent']],
  blocked: [['start', 'Retry', 'Retry the agent'], ['open', 'Open', 'Open its agent'], ['cancel', 'Cancel', '']],
  done: [['reopen', 'Reopen', ''], ['open', 'Open', ''], ['remove', '✕', 'Remove from the list']],
  cancelled: [['remove', '✕', 'Remove from the list']],
};

function renderBacklog() {
  const open = backlogState.items.filter((i) => ['queued', 'active', 'review', 'blocked'].includes(i.status));
  const review = backlogState.items.filter((i) => i.status === 'review').length;
  $('#backlog-count').textContent = open.length ? String(open.length) : '';
  $('#backlog-count').className = `badge ${review ? 'attention' : ''}`;
  if (sideTab !== 'backlog') return;

  const items = backlogState.items.filter((i) => showCompleted || !['done', 'cancelled'].includes(i.status));
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.projectKey)) groups.set(it.projectKey, { key: it.projectKey, name: it.projectName, items: [] });
    groups.get(it.projectKey).items.push(it);
  }
  const proj = Object.fromEntries(backlogState.projects.map((p) => [p.key, p]));
  const count = (s) => backlogState.items.filter((i) => i.status === s).length;
  $('#backlog-view').innerHTML = `
    <div class="counts">
      <span>${count('queued')} queued</span><span>${count('active')} active</span>
      ${count('review') ? `<span class="fail">${count('review')} to review</span>` : '<span>0 to review</span>'}
      <span class="spacer"></span>
      <button class="link" data-bl="toggle-run" title="${backlogState.autoRun ? 'Stop starting new items (running ones continue)' : 'Start picking up queued items again'}">${backlogState.autoRun ? '⏸ Pause' : '▶ Resume'}</button>
      <button class="link" data-bl="add">+ Add</button>
    </div>
    ${!backlogState.autoRun ? '<p class="hint bl-paused">Paused: queued items wait until you resume.</p>' : ''}
    ${items.length
      ? `<ul class="agent-list">${[...groups.values()]
          .map((g) => {
            const p = proj[g.key] ?? { limit: backlogState.defaultLimit };
            return `<li class="project open">
              <div class="project-head bl-head">
                ${p.shortcut ? `<span class="shortcut">${esc(p.shortcut)}</span>` : ''}
                <span class="pname">${esc(g.name)}</span>
                <button class="link" data-bl="limit" data-project="${esc(g.key)}" data-name="${esc(g.name)}" title="How many items of this project agents work on at once">${p.limit} at a time ✎</button>
              </div>
              <ul class="project-agents">${g.items.map(itemRow).join('')}</ul>
            </li>`;
          })
          .join('')}</ul>`
      : `<div class="empty"><p>The backlog is empty.</p><p>Add asks with <b>+ Add</b> (or <b>+ New agents</b> → Queue in backlog). Agents pick them up one by one, ${backlogState.defaultLimit} at a time per project, until each is done.</p></div>`}
    <p class="hint bl-foot"><label><input type="checkbox" data-bl="completed" ${showCompleted ? 'checked' : ''}/> Show done and cancelled</label></p>`;
}

function itemRow(it) {
  const a = it.agent;
  const st = it.status === 'active' && a?.attention ? 'attention' : it.status;
  return `<li class="agent bl-item ${it.status}" data-item="${it.id}">
    <div class="line1">
      <button class="prio p${it.priority}" data-bl="prio" title="Priority (click to change)">P${it.priority}</button>
      <span class="name">${esc(it.title)}</span>
      <span class="pill ${st === 'review' ? 'waiting' : st === 'active' ? 'working' : st}">${st === 'attention' ? 'needs input' : st}</span>
    </div>
    <div class="meta">
      <span class="mono">${it.id}</span>
      ${a ? `<span>agent <a href="#${a.id}" data-bl="open">${esc(a.name)}</a>${a.briefStatus ? ` · brief: ${esc(a.briefStatus)}` : ''}</span>` : ''}
      ${it.base ? `<span>⎇ from ${esc(it.base)}</span>` : ''}
      ${it.doneAt ? `<span>done ${ago(it.doneAt)}</span>` : it.reviewAt ? `<span>ready ${ago(it.reviewAt)}</span>` : it.startedAt ? `<span>started ${ago(it.startedAt)}</span>` : `<span>added ${ago(it.createdAt)}</span>`}
    </div>
    <div class="bl-actions">${(ITEM_ACTIONS[it.status] ?? []).map(([act, label, title]) => `<button class="small" data-bl="${act}" title="${esc(title)}">${label}</button>`).join('')}</div>
  </li>`;
}

function showTab(tab) {
  sideTab = tab;
  for (const b of document.querySelectorAll('.side-tab')) b.classList.toggle('active', b.dataset.tab === tab);
  $('#agents-view').hidden = tab !== 'agents';
  $('#backlog-view').hidden = tab !== 'backlog';
  $('#inbox-view').hidden = tab !== 'inbox';
  renderBacklog();
  renderInbox();
}
for (const b of document.querySelectorAll('.side-tab')) b.onclick = () => showTab(b.dataset.tab);

$('#backlog-view').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-bl]');
  if (!el) return;
  const what = el.dataset.bl;
  const id = el.closest('[data-item]')?.dataset.item;
  const it = backlogState.items.find((x) => x.id === id);
  if (what === 'completed') {
    showCompleted = el.checked;
    return renderBacklog();
  }
  e.preventDefault();
  const blApi = (method, route, body) => act(() => api(method, route, body));
  switch (what) {
    case 'toggle-run':
      return blApi('POST', '/backlog/settings', { autoRun: !backlogState.autoRun });
    case 'add':
      return openNewDialog('backlog');
    case 'limit': {
      const n = prompt(`How many "${el.dataset.name}" items should agents work on at once?`, el.textContent.split(' ')[0]);
      if (n === null) return;
      return blApi('POST', '/backlog/settings', { project: el.dataset.project, limit: Number(n) });
    }
    case 'prio':
      return blApi('PATCH', `/backlog/${id}`, { priority: (it.priority + 1) % 4 });
    case 'up':
    case 'down':
      return blApi('POST', `/backlog/${id}/move`, { where: what });
    case 'start':
      return blApi('POST', `/backlog/${id}/start`);
    case 'accept':
      return blApi('POST', `/backlog/${id}/accept`);
    case 'reopen': {
      const note = prompt('What still needs doing? (sent to the same agent)', '');
      if (note === null) return;
      return blApi('POST', `/backlog/${id}/reopen`, { note });
    }
    case 'cancel':
      if (!confirm('Cancel this item? Its agent (if any) keeps its session; close or delete it separately.')) return;
      return blApi('POST', `/backlog/${id}/cancel`);
    case 'remove':
      return blApi('DELETE', `/backlog/${id}`);
    case 'open': {
      const agentId = it?.agent?.id;
      if (!agentId) return;
      showTab('agents');
      return select(agentId);
    }
  }
});

// ------------------------------------------------------------------ needs you (inbox)

/** Small markers in the agent list: stuck, overlapping, asking, racing, forked. */
function flags(a) {
  const q = (a.questions ?? []).filter((x) => !x.answer).length;
  return [
    a.stuck?.length ? `<span class="flag warn" title="May be stuck: ${esc(a.stuck[0].title)}">↻</span>` : '',
    a.conflicts?.length ? `<span class="flag warn" title="Changes the same files as ${esc(a.conflicts.map((c) => c.agent.name).join(', '))}">⚔</span>` : '',
    q ? `<span class="flag ask" title="${q} open question${q > 1 ? 's' : ''}">?${q > 1 ? q : ''}</span>` : '',
    a.raceId ? `<span class="flag" title="Race attempt${a.variant?.label ? `: ${esc(a.variant.label)}` : ''}">🏁</span>` : '',
    a.forkOf ? `<span class="flag" title="Fork of ${esc(a.forkOf.name)}">⑂</span>` : '',
  ].join('');
}

const NEED_ORDER = { prompt: 0, plan: 1, question: 1, stuck: 2, conflict: 3 };
/** What an agent needs from the user. `both`: overlaps on both agents (detail), else only the one that should rebase (inbox). */
function needsFor(a, { both = false } = {}) {
  const items = [];
  if (a.runtime.attention) items.push({ a, kind: 'prompt', key: `prompt:${a.id}` });
  if (a.planReview?.status === 'review') items.push({ a, kind: 'plan', key: `plan:${a.id}` });
  for (const q of a.questions ?? []) if (!q.answer) items.push({ a, kind: 'question', key: `q:${a.id}:${q.id}`, q });
  for (const f of a.stuck ?? []) items.push({ a, kind: 'stuck', key: `stuck:${a.id}:${f.key}`, f });
  for (const g of a.conflicts ?? []) if (both || g.mergeFirst !== a.id) items.push({ a, kind: 'conflict', key: `conflict:${a.id}:${g.agent.id}`, g });
  return items;
}
function inboxItems() {
  return [...agents.values()]
    .flatMap((a) => needsFor(a))
    .sort((x, y) => NEED_ORDER[x.kind] - NEED_ORDER[y.kind] || (x.a.priority ?? 2) - (y.a.priority ?? 2));
}

const NEED_LABEL = { prompt: 'Needs input', plan: 'Plan review', question: 'Question', stuck: 'Stuck?', conflict: 'Overlap' };
function needCard(it, { inDetail = false } = {}) {
  const { a } = it;
  const who = inDetail
    ? ''
    : `<a href="#${a.id}" class="need-agent" data-goto="${a.id}">${prioChip(a.priority ?? 2)}${esc(a.name)}</a>${a.projectInfo?.name ? ` <span class="hint">${esc(a.projectInfo.name)}</span>` : ''}`;
  const head = `<div class="need-head"><span class="need-kind ${it.kind}">${NEED_LABEL[it.kind]}</span>${who}</div>`;
  const draft = (k, fallback = '') => esc(needDrafts.get(`${it.key}:${k}`) ?? fallback);
  let body = '';
  if (it.kind === 'prompt') {
    const p = a.runtime.prompt;
    body = `<p class="need-title">${esc(p?.question || a.runtime.attention)}</p>
      <div class="need-actions">
        ${(p?.choices ?? []).map((c) => `<button class="small ${c.key === '1' ? 'primary' : ''}" data-ib="key" data-key="${c.key}">${c.key}. ${esc(c.label)}</button>`).join('')}
        <button class="small" data-ib="key" data-key="esc" title="Escape">Esc</button>
        <button class="small ghost" data-ib="terminal">Open terminal</button>
      </div>`;
  } else if (it.kind === 'plan') {
    const title = a.planReview.markdown?.match(/^#\s+(.+)$/m)?.[1] ?? 'Implementation plan';
    body = `<p class="need-title">${esc(title)}</p>
      <p class="hint">Written ${ago(a.planReview.updatedAt)}. The agent waits for your approval before changing anything.</p>
      <div class="need-actions"><button class="small primary" data-ib="plan-open">Review plan</button><button class="small" data-ib="plan-approve">Approve as is</button></div>`;
  } else if (it.kind === 'question') {
    const q = it.q;
    body = `<p class="need-title">${esc(q.question)}</p>
      ${q.context ? `<p class="hint">${esc(q.context)}</p>` : ''}
      ${q.default ? `<p class="hint">Proceeding with <b>${esc(q.default)}</b> until you answer.</p>` : ''}
      <div class="need-actions">${q.options.map((o) => `<button class="small" data-ib="answer" data-text="${esc(o)}">${esc(o)}</button>`).join('')}</div>
      <form class="need-reply" data-ib-form="answer" data-q="${q.id}">
        <input data-draft="${esc(it.key)}:text" placeholder="Or type an answer…" value="${draft('text')}" />
        <button class="small primary">Send</button>
      </form>`;
  } else if (it.kind === 'stuck') {
    const f = it.f;
    body = `<p class="need-title">${esc(f.title)} <span class="hint">since ${ago(f.since)}</span></p>
      <p class="hint">${esc(f.detail)}</p>
      <form class="need-reply col" data-ib-form="nudge" data-k="${esc(f.key)}">
        <textarea rows="3" data-draft="${esc(it.key)}:text">${draft('text', f.nudge)}</textarea>
        <div class="need-actions"><button class="small primary">Send nudge</button><button type="button" class="small ghost" data-ib="dismiss">Dismiss</button></div>
      </form>`;
  } else {
    const g = it.g;
    const lines = g.files.filter((f) => f.severity === 'lines').length;
    const first = g.mergeFirst === a.id ? `${esc(a.name)} lands first; ${esc(g.agent.name)} rebases onto it` : `${esc(g.agent.name)} lands first; ${esc(a.name)} rebases onto it`;
    body = `<p class="need-title">Changes the same ${g.files.length === 1 ? 'file' : 'files'} as <a href="#${g.agent.id}" data-goto="${g.agent.id}">${esc(g.agent.name)}</a>${lines ? ` <span class="tag fail">${lines} on the same lines</span>` : ''}</p>
      <ul class="need-files">${g.files.slice(0, 8).map((f) => `<li><code>${esc(f.file)}</code>${f.severity === 'lines' ? ' <span class="hint">same lines</span>' : ''}</li>`).join('')}${g.files.length > 8 ? `<li class="hint">…and ${g.files.length - 8} more</li>` : ''}</ul>
      <p class="hint">Suggested order: ${first}.</p>
      <div class="need-actions">
        <button class="small" data-ib="warn" data-with="${g.agent.id}" title="Tell ${esc(a.name)} about the overlap">Tell ${esc(a.name)}</button>
        <button class="small" data-ib="warn-both" data-with="${g.agent.id}" title="Tell both agents">Tell both</button>
      </div>`;
  }
  return `<div class="need ${it.kind}" data-need="${esc(it.key)}" data-agent="${a.id}">${head}${body}</div>`;
}

const needDrafts = new Map(); // typed text survives live re-renders
document.addEventListener('input', (e) => {
  if (e.target.dataset?.draft) needDrafts.set(e.target.dataset.draft, e.target.value);
});

function renderInbox() {
  const items = inboxItems();
  const urgent = items.filter((i) => i.kind === 'prompt' || i.kind === 'question').length;
  $('#inbox-count').textContent = items.length ? String(items.length) : '';
  $('#inbox-count').className = `badge ${urgent ? 'attention' : ''}`;
  if (sideTab !== 'inbox') return;
  const view = $('#inbox-view');
  if (view.contains(document.activeElement) && document.activeElement.dataset.draft) return; // don't yank the field being typed in
  view.innerHTML = items.length
    ? `<div class="counts"><span>${items.length} waiting on you</span></div><div class="needs inbox">${items.map((it) => needCard(it)).join('')}</div>`
    : `<div class="empty"><p>Nothing needs you right now.</p><p>Prompts waiting for an answer, questions agents ask, agents that seem stuck and agents editing the same files show up here.</p></div>`;
}

async function onNeed(e) {
  const goto = e.target.closest('[data-goto]');
  if (goto) {
    e.preventDefault();
    showTab('agents');
    return select(goto.dataset.goto);
  }
  const el = e.target.closest('[data-ib]');
  if (!el) return;
  e.preventDefault();
  const card = el.closest('[data-need]');
  const id = card.dataset.agent;
  const key = card.dataset.need;
  switch (el.dataset.ib) {
    case 'key':
      return act(() => api('POST', `/agents/${id}/prompt-key`, { key: el.dataset.key }), 'Sent');
    case 'terminal':
      showTab('agents');
      select(id);
      return term.open(id);
    case 'answer': {
      const q = key.split(':')[2];
      return act(async () => upsert(await api('POST', `/agents/${id}/answer`, { question: q, text: el.dataset.text })), 'Answer sent');
    }
    case 'plan-open':
      return openPlan(id);
    case 'plan-approve':
      return act(async () => upsert(await api('POST', `/agents/${id}/plan/approve`, {})), 'Approved; the agent is implementing it');
    case 'dismiss':
      return act(async () => upsert(await api('POST', `/agents/${id}/stuck/dismiss`, { key: card.querySelector('[data-k]').dataset.k })));
    case 'warn':
      return act(async () => upsert(await api('POST', `/agents/${id}/conflicts/warn`, { with: el.dataset.with })), 'Queued for the agent');
    case 'warn-both':
      return act(async () => {
        upsert(await api('POST', `/agents/${id}/conflicts/warn`, { with: el.dataset.with }));
        upsert(await api('POST', `/agents/${el.dataset.with}/conflicts/warn`, { with: id }));
      }, 'Queued for both agents');
  }
}
async function onNeedSubmit(e) {
  const form = e.target.closest('[data-ib-form]');
  if (!form) return;
  e.preventDefault();
  const card = form.closest('[data-need]');
  const id = card.dataset.agent;
  const field = form.querySelector('[data-draft]');
  const text = field.value.trim();
  if (!text) return;
  const done = () => needDrafts.delete(field.dataset.draft);
  if (form.dataset.ibForm === 'answer') {
    await act(async () => upsert(await api('POST', `/agents/${id}/answer`, { question: form.dataset.q, text })), 'Answer sent');
  } else {
    await act(async () => upsert(await api('POST', `/agents/${id}/stuck/nudge`, { key: form.dataset.k, text })), 'Nudge queued');
  }
  done();
}
for (const root of [$('#inbox-view'), $('#detail-body')]) {
  root.addEventListener('click', onNeed);
  root.addEventListener('submit', onNeedSubmit);
}

// ------------------------------------------------------------------ checkpoints and forks

function checkpointsCard(a) {
  if (a.kind === 'general' || !a.git?.branch) return '';
  const cps = [...(a.checkpoints ?? [])].reverse();
  const forks = [...agents.values()].filter((x) => x.forkOf?.agentId === a.id);
  return `<div class="card">
    <h3>Checkpoints <span>${cps.length || ''}</span> <span class="spacer"></span><button class="small" data-act="checkpoint" title="Save the code and conversation as they are now">Save now</button></h3>
    <p class="hint">Saved at the end of each turn: the code (including uncommitted work) and the conversation up to that point. Fork from one to try a different direction from there.</p>
    ${cps.length
      ? `<ul class="links checkpoints">${cps
          .slice(0, 12)
          .map((c) => `<li><span class="mono">#${c.n}</span><span class="grow" title="${esc(c.prompt ?? '')}">${esc(c.prompt ?? 'checkpoint')}</span><span class="hint">${ago(c.at)}</span><button class="small" data-fork-cp="${c.n}">Fork from here</button></li>`)
          .join('')}</ul>`
      : '<p class="none">None yet: the first one is saved when the agent finishes a turn.</p>'}
    ${forks.length ? `<p class="hint">Forks: ${forks.map((f) => `<a href="#${f.id}" data-goto="${f.id}">${esc(f.name)}</a>`).join(', ')}</p>` : ''}
  </div>`;
}

$('#detail-body').addEventListener('click', (e) => {
  const cp = e.target.closest('[data-fork-cp]');
  if (cp) forkAgent(selectedId, Number(cp.dataset.forkCp));
  const race = e.target.closest('[data-race-open]');
  if (race) openRace(race.dataset.raceOpen);
});

function forkAgent(id, checkpoint) {
  const how = prompt(
    `Fork ${agents.get(id)?.name}${checkpoint ? ` from checkpoint ${checkpoint}` : ''}: a new agent with the same code and conversation.\n\nWhat should the fork do differently? (optional, sent as its first message)`,
    '',
  );
  if (how === null) return;
  act(async () => {
    const fork = await api('POST', `/agents/${id}/fork`, { checkpoint, instructions: how || undefined });
    upsert(fork);
    select(fork.id);
  }, 'Fork created');
}

// ------------------------------------------------------------------ races

function raceBanner(a) {
  if (!a.raceId) return '';
  const r = races.get(a.raceId);
  const n = r?.rows.length ?? 0;
  return `<div class="bl-banner race">🏁 Race attempt${a.variant?.label ? ` <b>${esc(a.variant.label)}</b>` : ''}${n ? ` · ${n} attempts` : ''}${r?.winner === a.id ? ' · <b>winner</b>' : ''}
    <span class="spacer"></span><button class="small primary" data-race-open="${a.raceId}">Compare</button></div>`;
}

function openRace(id) {
  openRaceId = id;
  raceDiff = null;
  renderRace();
  if (!$('#race-dialog').open) $('#race-dialog').showModal();
  act(async () => races.set(id, await api('GET', `/races/${id}`)));
}

const fmtCost = (c) => (c ? `$${c.toFixed(2)}` : '—');
const testCell = (t) =>
  !t ? '<span class="hint">—</span>' : `<span class="test ${t.status}" title="${esc(t.output ?? '')}">${{ passed: '✓ passed', failed: '✗ failed', running: '… running', queued: 'queued', error: '⚠ error' }[t.status] ?? t.status}${t.seconds != null ? ` <span class="hint">${t.seconds}s</span>` : ''}</span>`;

function renderRace() {
  const dlg = $('#race-dialog');
  if (!dlg.open && !openRaceId) return;
  const r = races.get(openRaceId);
  if (!r) {
    $('#race-body').innerHTML = '<p class="hint">Loading…</p>';
    return;
  }
  if ($('#race-body').contains(document.activeElement) && document.activeElement.name === 'testCommand') return;
  $('#race-title').textContent = `Race: ${r.intent.split('\n')[0].slice(0, 80)}`;
  // Tag a row only when it is strictly the best of several.
  const uniqueMin = (vals) => {
    const v = vals.filter((x) => x != null && x > 0);
    const m = Math.min(...v);
    return v.length > 1 && v.filter((x) => x === m).length === 1 ? m : null;
  };
  const cheapest = uniqueMin(r.rows.map((x) => x.costUsd));
  const smallest = uniqueMin(r.rows.map((x) => x.added + x.removed));
  $('#race-body').innerHTML = `
    <form class="race-tests" id="race-tests">
      <label>Test command <input name="testCommand" value="${esc(r.testCommand ?? '')}" placeholder="npm test" /></label>
      <button class="small primary">Run in every attempt</button>
    </form>
    <div class="race-table-wrap"><table class="race-table">
      <tr><th>Attempt</th><th>Status</th><th>Outcome</th><th>Checks</th><th>Change</th><th>Tests</th><th>Cost</th><th>Time</th><th></th></tr>
      ${r.rows
        .map((x) => {
          const a = agents.get(x.id);
          const st = a ? statusOf(a) : x.status;
          return `<tr class="${r.winner === x.id ? 'winner' : ''} ${raceDiff?.agentId === x.id ? 'diffing' : ''}">
            <td><a href="#${x.id}" data-race-goto="${x.id}"><b>${esc(x.variant?.label ?? x.name)}</b></a>${x.variant?.model ? ` <span class="tag">${esc(x.variant.model)}</span>` : ''}${x.variant?.instructions ? `<div class="hint">${esc(x.variant.instructions)}</div>` : ''}</td>
            <td><span class="pill ${st}">${pillText(st)}</span></td>
            <td>${x.outcome ? esc(x.outcome) : '<span class="hint">—</span>'}</td>
            <td>${x.checks.total ? `✓${x.checks.passed}/${x.checks.total}${x.checks.failed ? ` <span class="fail">✗${x.checks.failed}</span>` : ''}` : '<span class="hint">—</span>'}</td>
            <td>${x.files ? `${x.files} file${x.files > 1 ? 's' : ''} <span class="add">+${x.added}</span> <span class="del">−${x.removed}</span>${x.added + x.removed === smallest ? ' <span class="tag">smallest</span>' : ''}` : '<span class="hint">no changes</span>'}</td>
            <td>${testCell(x.tests)}</td>
            <td>${fmtCost(x.costUsd)}${x.costUsd === cheapest ? ' <span class="tag">cheapest</span>' : ''}</td>
            <td>${x.minutes != null ? `${x.minutes} min` : '—'}</td>
            <td class="race-acts">
              <button class="small" data-race-diff="${x.id}">Diff</button>
              ${r.winner === x.id ? '<span class="tag open">winner</span>' : `<button class="small" data-race-pick="${x.id}">Pick</button>`}
            </td>
          </tr>`;
        })
        .join('')}
    </table></div>
    ${raceDiff
      ? `<div class="race-diff"><div class="need-head"><b>Changes in ${esc(r.rows.find((x) => x.id === raceDiff.agentId)?.variant?.label ?? '')}</b><span class="spacer"></span><button class="small ghost" data-race-diff-close>Close diff</button></div>
         <pre class="diff">${raceDiff.text ? diffHtml(raceDiff.text) : '<span class="hint">No changes yet.</span>'}</pre></div>`
      : '<p class="hint">Pick a winner when you have seen enough. You can delete the other attempts and their worktrees at the same time.</p>'}`;
}

function diffHtml(text) {
  return text
    .split('\n')
    .map((l) => {
      const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') ? 'meta' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '';
      return `<span class="${cls}">${esc(l)}</span>`;
    })
    .join('\n');
}

$('#race-close').onclick = () => {
  openRaceId = null;
  $('#race-dialog').close();
};
$('#race-delete').onclick = () => {
  if (!confirm('Forget this race? Its agents stay; only the comparison is removed.')) return;
  const id = openRaceId;
  act(async () => {
    await api('DELETE', `/races/${id}`);
    races.delete(id);
    openRaceId = null;
    $('#race-dialog').close();
    render();
  });
};
$('#race-body').addEventListener('submit', (e) => {
  e.preventDefault();
  const command = new FormData(e.target).get('testCommand');
  act(async () => races.set(openRaceId, await api('POST', `/races/${openRaceId}/tests`, { command })), 'Running tests');
});
$('#race-body').addEventListener('click', (e) => {
  const t = e.target;
  const go = t.closest('[data-race-goto]');
  if (go) {
    e.preventDefault();
    openRaceId = null;
    $('#race-dialog').close();
    showTab('agents');
    return select(go.dataset.raceGoto);
  }
  if (t.closest('[data-race-diff-close]')) {
    raceDiff = null;
    return renderRace();
  }
  const d = t.closest('[data-race-diff]');
  if (d) {
    return act(async () => {
      raceDiff = { agentId: d.dataset.raceDiff, text: (await api('GET', `/races/${openRaceId}/diff/${d.dataset.raceDiff}`)).diff };
      renderRace();
    });
  }
  const p = t.closest('[data-race-pick]');
  if (p) {
    const r = races.get(openRaceId);
    const label = r.rows.find((x) => x.id === p.dataset.racePick)?.variant?.label;
    if (!confirm(`Pick "${label}" as the winner?`)) return;
    const cleanup = r.rows.length > 1 && confirm('Also close and delete the other attempts, including their worktrees? (Cancel keeps them.)');
    return act(async () => races.set(openRaceId, await api('POST', `/races/${openRaceId}/pick`, { agent: p.dataset.racePick, cleanup })), 'Winner picked');
  }
});

// ------------------------------------------------------------------ detail

function prRow(a, p) {
  const state = p.isDraft ? 'draft' : (p.state ?? '').toLowerCase();
  const label = p.number ? `#${p.number}` : 'PR';
  return `<li>
    ${state ? `<span class="tag ${state}">${state}</span>` : ''}
    <a class="grow" href="${esc(p.url)}" target="_blank" rel="noopener" title="${esc(p.url)}">${label} ${esc(p.title ?? p.repo ?? p.url)}</a>
    <span class="tag" title="How this was found">${esc(p.source)}</span>
    <button class="link" data-unlink="pr" data-key="${esc(p.url)}" title="Remove">✕</button>
  </li>`;
}

function bugRow(a, b) {
  const inner = b.url ? `<a href="${esc(b.url)}" target="_blank" rel="noopener">${esc(b.key)}</a>` : esc(b.key);
  return `<li>
    <span class="grow">${inner}${b.title ? ` <span class="hint">${esc(b.title)}</span>` : ''}</span>
    <span class="tag">${esc(b.source)}</span>
    <button class="link" data-unlink="bug" data-key="${esc(b.key)}" title="Remove">✕</button>
  </li>`;
}

function renderDetail() {
  const a = agents.get(selectedId);
  $('#placeholder').hidden = Boolean(a);
  const body = $('#detail-body');
  body.hidden = !a;
  if (!a) return;

  // Keep whatever the user is typing across live re-renders.
  const active = document.activeElement;
  const keepAttr = active?.dataset?.field ? 'field' : active?.dataset?.draft ? 'draft' : null;
  const keep = body.contains(active) && keepAttr ? { attr: keepAttr, field: active.dataset[keepAttr], value: active.value, pos: active.selectionStart } : null;
  const drafts = Object.fromEntries([...body.querySelectorAll('[data-field]')].map((el) => [el.dataset.field, el.value]));

  const st = statusOf(a);
  const running = a.runtime.running;
  const totalCost = a.costUsd ?? 0;
  const u = a.usage ?? { total: 0 };
  const current = a.sessions.find((s) => s.id === a.sessionId);

  body.innerHTML = `
    <div class="d-head">
      <div class="d-title">
        <h2>
          <select class="prio-select p${a.priority ?? 2}" data-priority="${a.id}" title="Priority: P0 most urgent … P3 lowest">
            ${[0, 1, 2, 3].map((p) => `<option value="${p}" ${p === (a.priority ?? 2) ? 'selected' : ''}>P${p}</option>`).join('')}
          </select>
          ${esc(a.name)} <span class="pill ${st}">${pillText(st)}</span>${a.kind === 'general' ? ' <span class="tag">general</span>' : ''}</h2>
        <p class="intent">${esc(a.intent || (a.kind === 'general' ? 'General session: ask Claude anything in the terminal.' : ''))}</p>
      </div>
      <div class="d-actions">
        ${a.status === 'error' && !a.workdir
          ? `<button class="primary" data-act="start" title="Run the clone / worktree setup again">Retry setup</button>
             ${running ? '<button data-act="terminal">Open terminal</button>' : ''}`
          : a.status === 'preparing' && !running
            ? `<button class="primary" data-act="plan" title="Talk the task through with Claude while the workspace is prepared">Plan while it clones</button>`
            : `<button class="primary" data-act="terminal">${running ? 'Open terminal' : 'Resume & open terminal'}</button>`}
        ${running
          ? `<button data-act="stop" title="Close the claude process; the session ID is kept">Close session</button>`
          : a.status === 'error' && !a.workdir
            ? ''
            : `<button data-act="start" ${a.status === 'preparing' ? 'disabled' : ''}>Resume in background</button>`}
        <button data-act="fresh" ${running || a.status === 'preparing' ? 'disabled' : ''} title="Start over with a new session ID (old ones are kept)">New session</button>
        <button data-act="shell" ${a.workdir && a.status !== 'preparing' ? '' : 'disabled'} title="A separate terminal in this agent's folder for running commands by hand">Open shell</button>
        <button data-act="fork" ${a.workdir && a.git?.branch ? '' : 'disabled'} title="A new agent with this one's code and conversation, in its own worktree, to try another approach">Fork</button>
        <button data-act="refresh" title="Re-scan git, PRs and transcripts">Refresh</button>
        <button class="danger" data-act="delete">Delete</button>
      </div>
    </div>
    ${(() => {
      const it = a.backlogItem && backlogState.items.find((x) => x.id === a.backlogItem);
      if (!it) return '';
      return `<div class="bl-banner ${it.status}">Backlog item <code>${it.id}</code>: <b>${esc(it.status)}</b>
        ${it.status === 'review' ? `<span class="spacer"></span><button class="small primary" data-backlog-accept="${it.id}">Accept</button> <button class="small" data-backlog-reopen="${it.id}">Reopen</button>` : ''}</div>`;
    })()}
    ${a.error ? `<div class="error-box">${esc(a.error)}</div>` : ''}
    ${a.status === 'preparing'
      ? `<div class="progress-box">
          <div>${esc(progressText(a.progress) || 'Preparing workspace…')}</div>
          ${a.progress?.step ? `<div class="bar"><span style="width:${a.progress.percent}%"></span></div>` : ''}
          <div class="hint">${a.runtime.planning
            ? 'A planning session is running in the terminal. It moves into the repo, with the whole conversation, once the workspace is ready.'
            : 'Claude starts as soon as the workspace is ready. Use <b>Plan while it clones</b> to clarify the task with Claude meanwhile. Deleting the agent cancels setup.'}</div>
        </div>`
      : ''}
    ${a.runtime.planning && a.workdir && a.status !== 'preparing'
      ? `<div class="ready-box">
          <span>The workspace is ready. The planning session moves into the repo when you leave the terminal, or now:</span>
          <button class="primary small" data-act="handoff">Continue in repo</button>
        </div>`
      : ''}
    ${a.runtime.attention ? `<div class="error-box">${esc(a.runtime.attention)}: the agent is waiting for an answer. Open its terminal to respond.</div>` : ''}
    ${raceBanner(a)}
    ${a.forkOf ? `<div class="bl-banner">⑂ Forked from <a href="#${a.forkOf.agentId}" data-goto="${a.forkOf.agentId}">${esc(a.forkOf.name)}</a>${a.forkOf.checkpoint ? ` at checkpoint ${a.forkOf.checkpoint}` : ''} ${ago(a.forkOf.at)}</div>` : ''}
    ${(() => {
      const items = needsFor(a, { both: true });
      return items.length ? `<div class="needs">${items.map((it) => needCard(it, { inDetail: true })).join('')}</div>` : '';
    })()}
    ${a.outbox ? `<div class="hint outbox-note">✉ ${a.outbox} message${a.outbox > 1 ? 's' : ''} waiting to be typed into the session when the agent is idle</div>` : ''}

    ${briefPanel(a)}

    <div class="grid">
      <div class="card">
        <h3>Session</h3>
        <dl class="kv">
          <dt>Session ID</dt><dd><code>${esc(a.sessionId)}</code>${copyBtn(a.sessionId)}</dd>
          <dt>Title</dt><dd>${esc(current?.title ?? '—')}</dd>
          <dt>Agent ID</dt><dd><code>${a.id}</code></dd>
          <dt>Last output</dt><dd>${a.runtime.lastOutputAt ? ago(a.runtime.lastOutputAt) : current?.lastActivity ? ago(current.lastActivity) : '—'}</dd>
          <dt>Tokens</dt><dd class="tokens">${u.total
            ? `<button class="link tok-toggle" data-tokens="${a.id}" title="Input + output tokens. Click for the full breakdown.">${fmtTokens(ioOf(u))} I/O ${tokensOpen.has(a.id) ? '▾' : '▸'}</button>
               ${tokensOpen.has(a.id)
                 ? `<div class="tok-detail">${fmtTokens(u.input)} in · ${fmtTokens(u.output)} out · ${fmtTokens(u.cacheRead)} cache read · ${fmtTokens(u.cacheCreation)} cache write
                    <br>${fmtTokens(u.total)} total incl. cache · ${u.requests} requests</div>`
                 : ''}`
            : '—'}</dd>
          <dt>Cost</dt><dd>${totalCost ? `$${totalCost.toFixed(2)} <span class="hint">(reported by Claude Code)</span>` : '—'}</dd>
          <dt>Mode</dt><dd>${esc(a.permissionMode)}${a.model ? ` · ${esc(a.model)}` : ''}</dd>
        </dl>
      </div>

      <div class="card">
        <h3>Workspace</h3>
        <dl class="kv">
          <dt>Folder</dt><dd><code>${esc(a.workdir ?? (a.status === 'preparing' ? 'preparing…' : '—'))}</code>${a.workdir ? copyBtn(a.workdir) : ''}</dd>
          <dt>Project</dt><dd>${esc(a.projectInfo?.full || a.projectInfo?.name || '—')} <button class="link" data-act="project" title="Group this agent under a different project name">✎</button></dd>
          <dt>Repo</dt><dd>${a.repo ? `<code>${esc(a.repo)}</code>` : '—'}</dd>
          <dt>Branch</dt><dd>${a.git?.branch ? `<code>${esc(a.git.branch)}</code>` : '—'}${a.git?.dirtyFiles ? ` <span class="tag">${a.git.dirtyFiles} changed</span>` : ''}</dd>
          <dt>Head</dt><dd>${a.git?.head ? `<code>${esc(a.git.head.sha)}</code> ${esc(a.git.head.subject)}` : '—'}</dd>
          ${a.baseRef ? `<dt>Branched from</dt><dd><code>${esc(a.baseRef)}</code></dd>` : ''}
          ${a.worktree ? `<dt>Worktree of</dt><dd><code>${esc(a.sourceDir)}</code></dd>` : ''}
        </dl>
      </div>

      <div class="card">
        <h3>Pull requests <span>${a.prs.length || ''}</span></h3>
        <ul class="links">${a.prs.length ? a.prs.map((p) => prRow(a, p)).join('') : '<li class="none">None detected yet</li>'}</ul>
        <form class="add-link" data-link="pr">
          <input data-field="pr" placeholder="Link a PR URL" value="${esc(drafts.pr ?? '')}" />
          <button class="small">Add</button>
        </form>
      </div>

      <div class="card">
        <h3>Bugs <span>${a.bugs.length || ''}</span></h3>
        <ul class="links">${a.bugs.length ? a.bugs.map((b) => bugRow(a, b)).join('') : '<li class="none">None detected yet</li>'}</ul>
        <form class="add-link" data-link="bug">
          <input data-field="bug" placeholder="Bug key or URL, e.g. PROJ-123" value="${esc(drafts.bug ?? '')}" />
          <button class="small">Add</button>
        </form>
      </div>

      <div class="card">
        <h3>Session history <span>${a.sessions.length}</span></h3>
        <table class="sessions">
          <tr><th>ID</th><th>Title</th><th title="Input + output tokens">I/O tokens</th><th>Active</th><th></th></tr>
          ${[...a.sessions]
            .reverse()
            .map(
              (s) => `<tr class="${s.id === a.sessionId ? 'current' : ''}">
              <td><code title="${esc(s.id)}">${s.id.slice(0, 8)}</code>${copyBtn(s.id)}</td>
              <td>${esc(s.title ?? '')}</td>
              <td title="${s.usage ? esc(usageTitle(s.usage)) : ''}">${s.usage ? fmtTokens(ioOf(s.usage)) : ''}</td>
              <td>${ago(s.lastActivity ?? s.lastStartedAt)}</td>
              <td>${s.id === a.sessionId ? 'current' : running ? '' : `<button class="small" data-resume-session="${s.id}">Resume</button>`}</td>
            </tr>`,
            )
            .join('')}
        </table>
      </div>

      ${checkpointsCard(a)}

      <div class="card">
        <h3>Notes</h3>
        <textarea class="notes" data-field="notes" placeholder="Anything worth remembering about this agent">${esc(drafts.notes ?? a.notes ?? '')}</textarea>
      </div>
    </div>`;

  renderDiagrams(body);
  markOverflow(body);

  if (keep) {
    const el = body.querySelector(`[data-${keep.attr}="${CSS.escape(keep.field)}"]`);
    if (el) {
      el.value = keep.value;
      el.focus();
      el.setSelectionRange?.(keep.pos, keep.pos);
    }
  }
}

function render() {
  renderList();
  renderBacklog();
  renderInbox();
  renderRace();
  renderDocDialog();
  renderDetail();
  term.syncOverlay();
}

function select(id) {
  selectedId = id;
  history.replaceState(null, '', id ? `#${id}` : '#');
  if (term.agentId && term.agentId !== id) term.close();
  render();
}

// ------------------------------------------------------------------ terminal


const term = {
  agentId: null,
  ws: null,
  xterm: null,
  fit: null,

  ensure() {
    if (this.xterm) return;
    this.xterm = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      scrollback: 10000,
      theme: { background: '#0f1117' },
      allowProposedApi: true,
    });
    this.fit = new FitAddon();
    this.xterm.loadAddon(this.fit);
    this.xterm.open($('#terminal'));
    this.xterm.onData((d) => this.send({ t: 'i', d }));
    this.xterm.onResize(({ cols, rows }) => this.send({ t: 'r', cols, rows }));
    new ResizeObserver(() => this.refit()).observe($('#terminal'));
    touchScroll($('#terminal'), this.xterm);
  },

  send(msg) {
    this.conn?.send(msg);
  },

  refit() {
    if (!this.agentId) return;
    try {
      this.fit.fit();
    } catch {}
  },

  kind: 'claude', // 'claude' = the agent's session, 'shell:N' = shell N in its folder
  shellExited: false,

  open(id, kind = 'claude') {
    if (isBrowser(kind)) return this.openBrowser(id, kind);
    $('#term-wrap').classList.remove('browsing');
    if (isShell(kind)) kind = `shell:${shellNum(kind)}`;
    history.replaceState(null, '', `#${id}/${isShell(kind) ? kind : 'term'}`);
    $('#term-wrap').hidden = false;
    $('#detail').classList.add('with-term');
    this.ensure();
    if (this.agentId === id && this.kind === kind && this.conn) {
      this.xterm.focus();
      return;
    }
    this.disconnect();
    this.agentId = id;
    this.kind = kind;
    this.shellExited = false;
    this.xterm.reset();
    this.syncOverlay();
    requestAnimationFrame(() => this.refit());

    const conn = openStream(
      { agentId: id, kind },
      {
        onOpen: () => {
          this.refit();
          this.send({ t: 'r', cols: this.xterm.cols, rows: this.xterm.rows });
        },
        onMessage: (msg) => this.conn === conn && this.onMessage(msg),
        onClose: (ev) => {
          if (this.conn !== conn) return;
          this.conn = null;
          if (ev.code === 1008) toast(`Terminal unavailable: ${ev.reason}`, 5000);
        },
      },
    );
    this.conn = conn;
  },

  onMessage(msg) {
    {
      if (msg.t === 'hello') {
        // Also sent again after a reconnect: start from a clean screen and replay.
        this.xterm.reset();
        this.xterm.write(msg.backlog);
        if (!matchMedia('(pointer: coarse)').matches) this.xterm.focus();
      } else if (msg.t === 'error') {
        toast(`Terminal unavailable: ${msg.error}`, 5000);
      } else if (msg.t === 'o') {
        this.xterm.write(msg.d);
      } else if (msg.t === 'exit') {
        if (isShell(this.kind)) this.shellExited = true;
        else this.xterm.write(`\r\n\x1b[2m[claude exited with code ${msg.code}; session kept]\x1b[0m\r\n`);
      }
      this.syncOverlay();
    }
  },

  syncOverlay() {
    if (isBrowser(this.kind)) return this.renderTabs();
    const a = this.agentId && agents.get(this.agentId);
    const shell = isShell(this.kind);
    const closed = shell ? this.shellExited : a && !a.runtime.running && a.status !== 'preparing';
    $('#term-overlay').hidden = !a || !closed;
    $('#term-overlay-msg').textContent = shell ? 'The shell has exited.' : "This agent's session is closed.";
    $('#term-resume').textContent = shell ? 'Start a new shell' : 'Resume session';
    this.renderTabs();
    if (a) {
      $('#term-title').textContent = shell ? `shell ${shellNum(this.kind)} · ${a.workdir}` : `${a.name} · session ${a.sessionId}`;
    }
  },

  /** One tab per running shell, plus the one being viewed even if it has exited. */
  renderTabs() {
    const a = this.agentId && agents.get(this.agentId);
    const nums = new Set(a?.runtime.shells ?? []);
    if (isShell(this.kind)) nums.add(shellNum(this.kind));
    $('#shell-tabs').innerHTML = [...nums]
      .sort((x, y) => x - y)
      .map((n) => `<button class="term-tab" data-kind="shell:${n}" role="tab" title="Shell ${n} in the agent's folder">Shell ${n}<span class="x" data-close="${n}" title="Close this shell">×</span></button>`)
      .join('');
    $('#browser-tabs').innerHTML = (a?.browsers ?? [])
      .map((t) => `<button class="term-tab" data-kind="browser:${t.n}" role="tab" title="${esc(t.url)}">🌐 ${esc(browserLabel(t.url))}<span class="x" data-drop-browser="${t.n}" title="Close this browser tab">×</span></button>`)
      .join('');
    for (const tab of document.querySelectorAll('.term-tab[data-kind]')) tab.classList.toggle('active', tab.dataset.kind === this.kind);
    $('#browser-new').classList.toggle('active', this.kind === 'browser:new');
    $('#shell-new').disabled = !a?.workdir || a.status === 'preparing';
    if (isBrowser(this.kind) && this.kind !== 'browser:new' && !a?.browsers?.some((t) => `browser:${t.n}` === this.kind)) {
      // Closed on another device.
      this.kind = null;
      this.open(this.agentId, 'claude');
    }
  },

  // Browser tabs: one iframe per tab, kept while the panel is open so switching back doesn't reload it.
  frames: new Map(), // "<agent>:<n>" -> iframe

  openBrowser(id, kind) {
    history.replaceState(null, '', `#${id}/${kind}`);
    $('#term-wrap').hidden = false;
    $('#detail').classList.add('with-term');
    $('#term-wrap').classList.add('browsing');
    this.ensure();
    if (this.agentId !== id) this.dropFrames();
    this.disconnect();
    this.agentId = id;
    this.kind = kind;
    $('#term-overlay').hidden = true;
    this.renderTabs();
    const tab = agents.get(id)?.browsers?.find((t) => `browser:${t.n}` === kind);
    for (const [key, f] of this.frames) f.hidden = key !== `${id}:${tab?.n}`;
    $('#browser-start').hidden = Boolean(tab);
    $('#browser-cert').hidden = true;
    const open = tab && this.frames.get(`${id}:${tab.n}`);
    Object.assign($('#browser-pop'), { href: open?.dataset.src ?? '#', hidden: !open });
    // Here the tab loads the site itself, so its own "don't frame me" header applies; the relay
    // used from other devices drops that header.
    $('#browser-hint').hidden = REMOTE || !tab || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(tab.url);
    $('#browser-url').value = tab?.url ?? '';
    $('#term-title').textContent = tab ? tab.url : 'Open a page as this machine sees it';
    if (!tab) {
      $('#browser-pop').hidden = true;
      this.suggest(id);
      requestAnimationFrame(() => $('#browser-url').focus());
      return;
    }
    this.loadFrame(id, tab);
  },

  async loadFrame(id, tab, force = false) {
    const key = `${id}:${tab.n}`;
    let frame = this.frames.get(key);
    if (frame && frame.dataset.url === tab.url && !force) return;
    let src;
    try {
      ({ src } = await api('POST', '/preview', { url: tab.url }));
    } catch (err) {
      return toast(`Can't open ${tab.url}: ${err.message}`, 5000);
    }
    const viewing = () => this.kind === `browser:${tab.n}` && this.agentId === id;
    if (viewing()) Object.assign($('#browser-pop'), { href: src, hidden: false });
    // From another device the tab goes through its own relay port. A browser accepts a
    // self-signed certificate per port and can't ask inside a frame, so check first and
    // offer to accept it in a tab of its own instead of showing a blank page.
    if (REMOTE && !(await reachable(src))) {
      frame?.remove();
      this.frames.delete(key);
      if (viewing()) {
        $('#browser-cert-open').href = src;
        $('#browser-cert').hidden = false;
      }
      return;
    }
    if (viewing()) $('#browser-cert').hidden = true;
    if (!frame) {
      frame = Object.assign(document.createElement('iframe'), { className: 'browser-frame', title: tab.url });
      frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
      $('#browser-frames').append(frame);
      this.frames.set(key, frame);
    }
    frame.dataset.url = tab.url;
    frame.dataset.src = src;
    frame.hidden = !viewing();
    frame.src = src;
  },

  dropFrames(key) {
    for (const [k, f] of this.frames) {
      if (key && k !== key) continue;
      f.remove();
      this.frames.delete(k);
    }
  },

  async suggest(id) {
    const urls = await api('GET', `/agents/${id}/local-urls`).catch(() => []);
    if (this.agentId !== id || this.kind !== 'browser:new') return;
    $('#browser-suggest').innerHTML = urls.length
      ? `<span class="muted">Seen in this agent's terminals:</span> ${urls.map((u) => `<button type="button" class="small" data-url="${esc(u)}">${esc(u)}</button>`).join(' ')}`
      : '<span class="muted">Type a port (5173) or an address (localhost:3000/app, example.com). Local addresses the agent prints, like a dev server\'s, show up here.</span>';
  },

  /** Upload files to the daemon and paste their paths, the way a native terminal pastes a dropped file. */
  async attachFiles(files) {
    const id = this.agentId;
    if (!id || !files.length) return;
    const saved = [];
    for (const file of files) {
      const name = file.name || `pasted-${Date.now()}.${(file.type.split('/')[1] || 'bin').replace(/\W/g, '')}`;
      try {
        const res = await fetch(`/api/agents/${id}/upload?name=${encodeURIComponent(name)}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream', 'x-agentmgr': '1' },
          body: file,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        saved.push(data.path);
      } catch (err) {
        toast(`Could not attach ${name}: ${err.message}`, 5000);
      }
    }
    if (!saved.length || this.agentId !== id) return;
    // Backslash-escape like a terminal drop, so Claude Code (and shells) read each as one path.
    this.xterm.paste(saved.map((p) => p.replace(/([\s'"\\()&;|<>$`!*?[\]{}#~])/g, '\\$1')).join(' ') + ' ');
    this.xterm.focus();
    toast(saved.length === 1 ? 'Attached 1 file' : `Attached ${saved.length} files`);
  },

  disconnect() {
    this.conn?.close();
    this.conn = null;
  },

  close() {
    if (this.agentId) history.replaceState(null, '', `#${this.agentId}`);
    this.disconnect();
    this.dropFrames();
    this.agentId = null;
    $('#term-wrap').hidden = true;
    $('#detail').classList.remove('with-term');
  },
};

$('#term-close').onclick = () => term.close();
$('#term-fit').onclick = () => term.refit();
$('#term-resume').onclick = () => {
  const id = term.agentId;
  if (isShell(term.kind)) {
    term.disconnect();
    return term.open(id, term.kind);
  }
  act(async () => {
    upsert(await api('POST', `/agents/${id}/start`, {}));
    term.xterm.focus();
  });
};
$('.term-tabs').addEventListener('click', async (e) => {
  const id = term.agentId;
  if (!id) return;
  const dropBrowser = e.target.closest('[data-drop-browser]');
  if (dropBrowser) {
    e.stopPropagation();
    const n = Number(dropBrowser.dataset.dropBrowser);
    return act(async () => {
      await api('DELETE', `/agents/${id}/browsers/${n}`);
      term.dropFrames(`${id}:${n}`);
      if (term.kind === `browser:${n}`) {
        term.kind = null;
        term.open(id, 'claude');
      }
    });
  }
  if (e.target.closest('#browser-new')) return term.open(id, 'browser:new');
  const close = e.target.closest('[data-close]');
  if (close) {
    e.stopPropagation();
    const n = Number(close.dataset.close);
    const viewing = term.kind === `shell:${n}`;
    await act(async () => {
      await api('POST', `/agents/${id}/shell/drop`, { n });
      if (viewing) {
        const rest = (agents.get(id)?.runtime.shells ?? []).filter((x) => x !== n);
        term.kind = null; // force a reconnect
        term.open(id, rest.length ? `shell:${rest[0]}` : 'claude');
      } else term.renderTabs();
    });
    return;
  }
  if (e.target.closest('#shell-new')) {
    return act(async () => term.open(id, `shell:${(await api('POST', `/agents/${id}/shell/new`)).n}`));
  }
  const tab = e.target.closest('.term-tab[data-kind]');
  if (!tab) return;
  const a = agents.get(id);
  if (tab.dataset.kind === 'claude' && a && !a.runtime.running) {
    await act(async () => upsert(await api('POST', `/agents/${id}/start`, {})));
  }
  term.open(id, tab.dataset.kind);
});

const browserLabel = (url) => {
  const u = new URL(url);
  return u.host + (u.pathname === '/' ? '' : u.pathname);
};
async function openAddress(url) {
  const id = term.agentId;
  if (!id || !url.trim()) return;
  await act(async () => {
    if (term.kind === 'browser:new') {
      const tab = await api('POST', `/agents/${id}/browsers`, { url });
      upsertBrowsers(id, tab.n, tab.url);
      const n = tab.n;
      term.open(id, `browser:${n}`);
    } else {
      const n = Number(term.kind.split(':')[1]);
      const tab = await api('PATCH', `/agents/${id}/browsers/${n}`, { url });
      upsertBrowsers(id, n, tab.url);
      term.open(id, term.kind);
    }
  });
}
// Don't wait for the change event to show a tab that was just opened.
function upsertBrowsers(id, n, url) {
  const a = agents.get(id);
  if (!a) return;
  const tabs = (a.browsers ?? []).filter((t) => t.n !== n);
  a.browsers = [...tabs, { n, url }].sort((x, y) => x.n - y.n);
}
$('#browser-bar').addEventListener('submit', (e) => {
  e.preventDefault();
  openAddress($('#browser-url').value);
});
$('#browser-suggest').addEventListener('click', (e) => {
  const b = e.target.closest('[data-url]');
  if (b) openAddress(b.dataset.url);
});
/** Whether this device can load `src` at all (a no-cors probe fails on an untrusted certificate). */
async function reachable(src) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    await fetch(src, { mode: 'no-cors', credentials: 'include', cache: 'no-store', signal: ctl.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
$('#browser-cert-retry').onclick = () => $('#browser-reload').click();
$('#browser-reload').onclick = () => {
  const tab = agents.get(term.agentId)?.browsers?.find((t) => `browser:${t.n}` === term.kind);
  if (tab) term.loadFrame(term.agentId, tab, true);
};

// Attachments: the 📎 button, dropping files on the terminal, or pasting a file / screenshot.
$('#term-attach').onclick = () => $('#term-file').click();
$('#term-file').onchange = (e) => {
  term.attachFiles([...e.target.files]);
  e.target.value = '';
};
{
  const wrap = $('#term-wrap');
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  wrap.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    $('#term-drop').hidden = false;
  });
  wrap.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  wrap.addEventListener('dragleave', () => {
    if (--depth <= 0) {
      depth = 0;
      $('#term-drop').hidden = true;
    }
  });
  wrap.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    $('#term-drop').hidden = true;
    term.attachFiles([...e.dataTransfer.files]);
  });
  // Capture phase, so it runs before xterm turns the paste into (empty) text.
  $('#terminal').addEventListener(
    'paste',
    (e) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      term.attachFiles(files);
    },
    true,
  );
}

// ------------------------------------------------------------------ events

function upsert(a) {
  agents.set(a.id, a);
  render();
  if (a.id === term.agentId) term.renderTabs();
}

$('#counts').addEventListener('click', (e) => {
  if (e.target.id !== 'flush-btn') return;
  act(async () => {
    const r = await api('POST', '/flush');
    toast(`Saved ${r.agents} agents · scrollback for ${r.scrollback}`);
  });
});

$('#agent-list').addEventListener('click', (e) => {
  const rename = e.target.closest('[data-rename]');
  if (rename) {
    e.stopPropagation();
    const old = rename.dataset.rename;
    const next = prompt(`New shortcut for this project (lowercase letters, digits, "-"):`, old);
    if (!next || next === old) return;
    return act(() => api('PATCH', `/projects/${encodeURIComponent(old)}`, { shortcut: next.trim().toLowerCase() }), `Shortcut is now ${next}`);
  }
  const head = e.target.closest('[data-toggle]');
  if (head) {
    const key = head.dataset.toggle;
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    saveCollapsed();
    return renderList();
  }
  const li = e.target.closest('li[data-id]');
  if (li) select(li.dataset.id);
});

$('#detail-body').addEventListener('click', async (e) => {
  const a = agents.get(selectedId);
  if (!a) return;
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.dataset.backlogAccept) return act(() => api('POST', `/backlog/${btn.dataset.backlogAccept}/accept`), 'Accepted: done');
  if (btn.dataset.backlogReopen) {
    const note = prompt('What still needs doing? (sent to this agent)', '');
    if (note === null) return;
    return act(() => api('POST', `/backlog/${btn.dataset.backlogReopen}/reopen`, { note }), 'Reopened');
  }
  if (btn.dataset.doc) return openDoc(a.id, btn.dataset.doc);
  if ('docAll' in btn.dataset) {
    return act(async () => {
      upsert(await api('POST', `/agents/${a.id}/docs/all?background=1`));
      toast(`Writing the documents for ${a.name} in the background (2 at a time); you'll be told as each is ready`, 4500);
    });
  }
  if (btn.dataset.tokens) {
    const id = btn.dataset.tokens;
    if (tokensOpen.has(id)) tokensOpen.delete(id);
    else tokensOpen.add(id);
    return renderDetail();
  }
  if (btn.dataset.more) {
    const key = btn.dataset.more;
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    return renderDetail();
  }
  if (btn.dataset.copy) {
    await navigator.clipboard.writeText(btn.dataset.copy).catch(() => {});
    return toast('Copied');
  }
  if (btn.dataset.unlink) {
    return act(async () =>
      upsert(await api('DELETE', `/agents/${a.id}/links?type=${btn.dataset.unlink}&key=${encodeURIComponent(btn.dataset.key)}`)),
    );
  }
  if (btn.dataset.resumeSession) {
    return act(async () => {
      upsert(await api('POST', `/agents/${a.id}/start`, { sessionId: btn.dataset.resumeSession }));
      term.open(a.id);
    });
  }

  switch (btn.dataset.act) {
    case 'terminal':
      if (!a.runtime.running) await act(async () => upsert(await api('POST', `/agents/${a.id}/start`, {})));
      term.open(a.id);
      break;
    case 'plan':
      act(async () => {
        upsert(await api('POST', `/agents/${a.id}/plan`));
        term.open(a.id);
      });
      break;
    case 'handoff':
      act(async () => {
        upsert(await api('POST', `/agents/${a.id}/handoff`));
        term.open(a.id);
      }, 'Moved into the repository');
      break;
    case 'project': {
      const name = prompt('Project name for this agent (leave empty to use its repo):', a.project ?? a.projectInfo?.name ?? '');
      if (name === null) return;
      act(async () => upsert(await api('PATCH', `/agents/${a.id}`, { project: name })));
      break;
    }
    case 'plan-open':
      return openPlan(a.id);
    case 'plan-on':
      return act(async () => upsert(await api('POST', `/agents/${a.id}/plan/review`, { on: true })), 'The agent will write a plan and wait for your review');
    case 'plan-skip':
      return act(async () => upsert(await api('POST', `/agents/${a.id}/plan/review`, { on: false })), 'Review skipped; the agent goes ahead');
    case 'insights':
      btn.disabled = true;
      btn.textContent = 'Thinking…';
      act(async () => upsert(await api('POST', `/agents/${a.id}/insights`)));
      break;
    case 'explain':
      btn.disabled = true;
      btn.textContent = 'Explaining…';
      act(async () => upsert(await api('POST', `/agents/${a.id}/explain`)));
      break;
    case 'shell':
      term.open(a.id, 'shell:1');
      break;
    case 'fork':
      forkAgent(a.id);
      break;
    case 'checkpoint':
      act(async () => upsert(await api('POST', `/agents/${a.id}/checkpoint`)), 'Checkpoint saved');
      break;
    case 'start':
      act(
        async () => upsert(await api('POST', `/agents/${a.id}/start`, {})),
        a.workdir ? 'Resumed in the background' : 'Retrying setup',
      );
      break;
    case 'fresh':
      if (!confirm('Start a new claude session for this agent? Earlier session IDs are kept and can be resumed.')) return;
      act(async () => {
        upsert(await api('POST', `/agents/${a.id}/start`, { fresh: true }));
        term.open(a.id);
      });
      break;
    case 'stop':
      btn.disabled = true;
      act(async () => upsert(await api('POST', `/agents/${a.id}/stop`)), 'Session closed; the ID is kept for resuming');
      break;
    case 'refresh':
      act(async () => upsert(await api('POST', `/agents/${a.id}/refresh`)), 'Refreshed');
      break;
    case 'delete': {
      const cancelNote = a.status === 'preparing' ? '\n\nThis also cancels the workspace setup (clone / checkout) in progress.' : '';
      if (!confirm(`Delete agent "${a.name}"? Its session IDs will be forgotten by Agent Manager.${cancelNote}`)) return;
      const del = a.worktree && confirm('Also remove the git worktree Agent Manager created for it?\n(Uncommitted changes there will be lost.)');
      act(async () => {
        const res = await api('DELETE', `/agents/${a.id}${del ? '?deleteWorkspace=1' : ''}`);
        if (res.warnings?.length) toast(res.warnings.join('; '), 6000);
      });
      break;
    }
  }
});

$('#detail-body').addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target.closest('form[data-link]');
  const input = form.querySelector('input');
  const value = input.value.trim();
  if (!value) return;
  act(async () => {
    upsert(await api('POST', `/agents/${selectedId}/links`, { type: form.dataset.link, value }));
    form.querySelector('input').value = '';
    renderDetail();
  });
});

let notesTimer;
$('#detail-body').addEventListener('change', (e) => {
  const id = e.target.dataset.priority;
  if (!id) return;
  act(async () => upsert(await api('PATCH', `/agents/${id}`, { priority: Number(e.target.value) })), `Priority set to P${e.target.value}`);
});

$('#detail-body').addEventListener('input', (e) => {
  if (e.target.dataset.field !== 'notes') return;
  const id = selectedId;
  const notes = e.target.value;
  clearTimeout(notesTimer);
  notesTimer = setTimeout(() => act(() => api('PATCH', `/agents/${id}`, { notes })), 600);
});

$('#filter').addEventListener('input', (e) => {
  filterText = e.target.value.trim().toLowerCase();
  renderList();
});

// ------------------------------------------------------------------ new agents dialog

const dialog = $('#new-dialog');
function renderProjectOptions() {
  $('#project-options').innerHTML = projectsState
    .map((p) => `<option value="${esc(p.shortcut)}">${esc(p.name)}${p.repo ? ` · ${esc(p.repo)}` : p.dir ? ` · ${esc(p.dir)}` : ''}</option>`)
    .join('');
}

function openNewDialog(mode = 'now') {
  renderProjectOptions();
  $('#new-error').hidden = true;
  dialog.querySelector(`input[name="when"][value="${mode}"]`).checked = true;
  syncWhen();
  dialog.showModal();
  dialog.querySelector('textarea').focus();
}
function syncWhen() {
  const when = dialog.querySelector('input[name="when"]:checked').value;
  dialog.querySelector('.now-only').hidden = when !== 'now';
  dialog.querySelector('.race-only').hidden = when !== 'race';
  dialog.querySelector('button[type=submit]').textContent = when === 'backlog' ? 'Add to backlog' : when === 'race' ? 'Start race' : 'Create agents';
}
for (const r of dialog.querySelectorAll('input[name="when"]')) r.addEventListener('change', syncWhen);
$('#new-btn').onclick = () => openNewDialog('now');
$('#new-cancel').onclick = () => dialog.close();
$('#new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const intents = String(f.get('intents'))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (f.get('when') === 'race') {
    // "model", "model | approach" or "| approach", one attempt per line.
    const variants = String(f.get('variants') || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [model, ...rest] = l.split('|');
        return { model: model.trim() || undefined, instructions: rest.join('|').trim() || undefined };
      });
    try {
      const race = await api('POST', '/races', {
        intent: intents.join('\n'),
        variants,
        testCommand: f.get('testCommand') || undefined,
        repo: f.get('repo') || undefined,
        dir: f.get('dir') || undefined,
        base: f.get('base') || undefined,
        project: f.get('project') || undefined,
        permissionMode: f.get('permissionMode') || undefined,
        model: f.get('model') || undefined,
        priority: Number(f.get('priority')),
      });
      races.set(race.id, race);
      dialog.close();
      e.target.reset();
      syncWhen();
      openRace(race.id);
      toast(`Race started: ${race.rows.length} attempts`);
    } catch (err) {
      $('#new-error').textContent = err.message;
      $('#new-error').hidden = false;
    }
    return;
  }
  if (f.get('when') === 'backlog') {
    try {
      const added = await api('POST', '/backlog', {
        items: intents,
        repo: f.get('repo') || undefined,
        dir: f.get('dir') || undefined,
        base: f.get('base') || undefined,
        project: f.get('project') || undefined,
        permissionMode: f.get('permissionMode') || undefined,
        model: f.get('model') || undefined,
        engine: f.get('engine') || undefined,
        worktree: f.get('worktree') ? true : undefined,
        plan: Boolean(f.get('plan')),
        planReview: Boolean(f.get('planReview')),
        priority: Number(f.get('priority')),
      });
      dialog.close();
      e.target.reset();
      showTab('backlog');
      toast(`Queued ${added.length} item${added.length > 1 ? 's' : ''}`);
    } catch (err) {
      $('#new-error').textContent = err.message;
      $('#new-error').hidden = false;
    }
    return;
  }
  try {
    const created = await api('POST', '/agents', {
      priority: Number(f.get('priority')),
      intents,
      repo: f.get('repo') || undefined,
      dir: f.get('dir') || undefined,
      permissionMode: f.get('permissionMode') || undefined,
      model: f.get('model') || undefined,
      engine: f.get('engine') || undefined,
      worktree: f.get('worktree') ? true : undefined,
      base: f.get('base') || undefined,
      project: f.get('project') || undefined,
      plan: Boolean(f.get('plan')),
      planReview: Boolean(f.get('planReview')),
      start: Boolean(f.get('start')),
    });
    created.forEach((a) => agents.set(a.id, a));
    dialog.close();
    e.target.reset();
    select(created[0].id);
    toast(`Created ${created.length} agent${created.length > 1 ? 's' : ''}`);
    if (created.length === 1 && created[0].runtime.planning) term.open(created[0].id);
  } catch (err) {
    $('#new-error').textContent = err.message;
    $('#new-error').hidden = false;
  }
});

// ------------------------------------------------------------------ ask (general session)

const askDialog = $('#ask-dialog');
$('#ask-btn').onclick = () => {
  $('#ask-error').hidden = true;
  askDialog.showModal();
  askDialog.querySelector('textarea').focus();
};
$('#ask-cancel').onclick = () => askDialog.close();
$('#ask-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const a = await api('POST', '/general', {
      question: String(f.get('question') || '').trim() || undefined,
      name: String(f.get('name') || '').trim() || undefined,
    });
    agents.set(a.id, a);
    askDialog.close();
    e.target.reset();
    select(a.id);
    // The shared general folder is ready almost immediately; open the terminal once it runs.
    const t0 = Date.now();
    const wait = setInterval(() => {
      const cur = agents.get(a.id);
      if (cur?.runtime.running || Date.now() - t0 > 10000) {
        clearInterval(wait);
        if (cur?.runtime.running && selectedId === a.id) term.open(a.id);
      }
    }, 150);
  } catch (err) {
    $('#ask-error').textContent = err.message;
    $('#ask-error').hidden = false;
  }
});
$('#ask-form textarea').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('#ask-form').requestSubmit();
});

// ------------------------------------------------------------------ live updates

function handleEvent(msg) {
  if (msg.t === 'snapshot') {
    agents.clear();
    msg.agents.forEach((a) => agents.set(a.id, a));
    if (msg.backlog) backlogState = msg.backlog;
    if (msg.projects) projectsState = msg.projects;
    races.clear();
    for (const r of msg.races ?? []) races.set(r.id, r);
    msg.agents.forEach(watchDocs);
    if (selectedId && !agents.has(selectedId)) selectedId = null;
    if (openTermOnLoad && selectedId) {
      if (isShell(hashView) || isBrowser(hashView)) term.open(selectedId, hashView);
      else if (agents.get(selectedId).runtime.running) term.open(selectedId);
    }
    openTermOnLoad = false;
  } else if (msg.t === 'agent') {
    agents.set(msg.agent.id, msg.agent);
    watchDocs(msg.agent);
    if (msg.agent.id === term.agentId) term.renderTabs();
  } else if (msg.t === 'removed') {
    agents.delete(msg.id);
    if (selectedId === msg.id) select(null);
  } else if (msg.t === 'race') {
    races.set(msg.race.id, msg.race);
  } else if (msg.t === 'race-removed') {
    races.delete(msg.id);
  } else if (msg.t === 'backlog') {
    backlogState = msg.backlog;
  } else if (msg.t === 'projects') {
    projectsState = msg.projects;
    renderProjectOptions();
  }
  render();
}

function connectEvents() {
  openStream(
    { events: true },
    {
      onOpen: () => {
        $('#conn').textContent = REMOTE ? 'connected (remote)' : 'daemon connected';
        $('#conn').className = 'conn ok';
      },
      onMessage: handleEvent,
      onClose: async () => {
        $('#conn').textContent = 'daemon offline, retrying…';
        $('#conn').className = 'conn bad';
        if (REMOTE && !(await sessionOk())) return showLogin();
        setTimeout(connectEvents, 2000);
      },
    },
  );
}

// ------------------------------------------------------------------ phone keys and reply box

const KEYS = {
  esc: '\x1b', tab: '\t', stab: '\x1b[Z', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  enter: '\r', ctrlc: '\x03', 1: '1', 2: '2', 3: '3', 4: '4',
};
$('#keybar').addEventListener('click', (e) => {
  const key = e.target.closest('[data-key]')?.dataset.key;
  if (key) term.send({ t: 'i', d: KEYS[key] });
});
// Keep the on-screen keyboard from popping up when tapping keybar buttons.
$('#keybar').addEventListener('mousedown', (e) => e.preventDefault());

$('#compose').addEventListener('submit', (e) => {
  e.preventDefault();
  const box = $('#compose-text');
  const text = box.value;
  if (!text.trim()) return;
  term.send({ t: 'i', d: text });
  // Enter separately, so Claude reads the text as typed input and then submits it.
  setTimeout(() => term.send({ t: 'i', d: '\r' }), 150);
  box.value = '';
  box.style.height = '';
});
$('#compose-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#compose').requestSubmit();
  }
});
$('#compose-text').addEventListener('input', (e) => {
  e.target.style.height = '';
  e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
});

// ------------------------------------------------------------------ remote access (from this computer)

async function renderRemote() {
  const box = $('#remote-content');
  let st;
  try {
    st = await api('GET', '/remote');
  } catch (err) {
    box.textContent = err.message;
    return;
  }
  const phoneUrls = st.urls.filter((u) => !u.vpn);
  const vpnUrls = st.urls.filter((u) => u.vpn);
  box.innerHTML = `
    <p class="remote-state">
      ${st.enabled && st.running ? `<span class="pill working">on</span> HTTPS on port <b>${st.port}</b>` : '<span class="pill">off</span> Not reachable from other devices.'}
      <button id="remote-toggle" class="${st.enabled ? '' : 'primary'}">${st.enabled ? 'Turn off' : 'Turn on'}</button>
    </p>
    ${st.enabled && st.running
      ? `${phoneUrls.length
          ? phoneUrls
              .map(
                (u) => `<div class="remote-url">
                  <div class="qr">${u.qr}</div>
                  <div>
                    <div><b>Scan with your phone's camera</b> to open and sign in.</div>
                    <code>${esc(u.url)}</code> <span class="hint">(${esc(u.iface)})</span>
                    <div><button class="small" data-copy="${esc(u.loginUrl)}">Copy sign-in link</button></div>
                  </div>
                </div>`,
              )
              .join('')
          : '<p class="error">This computer has no network address a phone can reach. Join Wi-Fi or your phone\'s Personal Hotspot.</p>'}
        ${vpnUrls.length ? `<p class="hint">Over the VPN only (a phone usually can't reach these): ${vpnUrls.map((u) => `<code>${esc(u.url)}</code>`).join(' ')}</p>` : ''}
        <ul class="remote-notes hint">
          <li>The phone must be on the <b>same network</b> as this computer: the same Wi-Fi, or this computer joined to the phone's <b>Personal Hotspot</b>. Office Wi-Fi often blocks device-to-device traffic.</li>
          <li>The first visit warns about the certificate (it's self-signed). Check the fingerprint below, then choose <i>Show Details → visit this website</i> (Safari) or <i>Advanced → Proceed</i> (Chrome).</li>
          <li>If macOS asks whether <b>node</b> may accept incoming connections, choose Allow.</li>
        </ul>
        <p class="hint">Certificate SHA-256: <code class="fp">${esc(st.fingerprint ?? '')}</code></p>
        <h3>Signed-in devices</h3>
        ${st.devices.length
          ? `<table class="devices"><tr><th>Device</th><th>Address</th><th>Last seen</th><th></th></tr>${st.devices
              .map(
                (d) => `<tr><td title="${esc(d.ua)}">${esc(deviceName(d.ua))}</td><td>${esc(d.ip ?? '')}</td><td>${ago(d.lastSeen)}</td>
                  <td><button class="small danger" data-revoke="${esc(d.id)}">Sign out</button></td></tr>`,
              )
              .join('')}</table>`
          : '<p class="hint">None yet.</p>'}
        <p><button id="remote-rotate" class="danger">New access token</button> <span class="hint">Signs out every device; scan the new QR code to sign in again.</span></p>`
      : ''}`;
}

function deviceName(ua = '') {
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : 'Device';
  const browser = /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '';
  return [os, browser].filter(Boolean).join(' · ');
}

$('#remote-btn').onclick = () => {
  $('#remote-dialog').showModal();
  renderRemote();
};
$('#remote-close').onclick = () => $('#remote-dialog').close();
$('#remote-content').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.copy) {
    await navigator.clipboard.writeText(btn.dataset.copy).catch(() => {});
    return toast('Sign-in link copied. It contains the access token; share it only with your own devices.', 4000);
  }
  if (btn.id === 'remote-toggle') {
    const on = btn.textContent === 'Turn on';
    await act(() => api('POST', on ? '/remote/enable' : '/remote/disable'), on ? 'Remote access on' : 'Remote access off');
  } else if (btn.id === 'remote-rotate') {
    if (!confirm('Create a new access token? Every signed-in device is signed out.')) return;
    await act(() => api('POST', '/remote/rotate'), 'New token created; all devices signed out');
  } else if (btn.dataset.revoke) {
    await act(() => api('DELETE', `/remote/devices/${btn.dataset.revoke}`), 'Device signed out');
  }
  renderRemote();
});

// ------------------------------------------------------------------ Slack alerts (from this computer)

async function loadAlerts() {
  const n = await api('GET', '/notify');
  const f = $('#alerts-form');
  f.webhookUrl.value = '';
  f.botToken.value = '';
  f.channel.value = n.slack.channel ?? '';
  f.webhookUrl.placeholder = n.slack.webhookUrl ?? 'https://hooks.slack.com/services/…';
  f.botToken.placeholder = n.slack.botToken ?? 'xoxb-…';
  for (const k of Object.keys(n.events)) if (f[`ev_${k}`]) f[`ev_${k}`].checked = n.events[k];
  f.needsInputDelaySec.value = n.needsInputDelaySec;
  f.waitingDelaySec.value = n.waitingDelaySec;
  f.skipWhenWatching.checked = n.skipWhenWatching;
  f.includeIntent.checked = n.includeIntent;
  f.enabled.checked = n.enabled;
  $('#alerts-current').textContent = n.configured
    ? `Configured: ${n.slack.channel ? `bot token → ${n.slack.channel}` : `webhook ${n.slack.webhookUrl}`}. Leave the fields empty to keep it.`
    : 'Not configured yet.';
  $('#alerts-recent').innerHTML = n.recent.length
    ? `Recent: ${n.recent.slice(0, 5).map((r) => `${esc(r.kind)} · ${esc(r.agent)} · ${r.error ? `<span class="error">${esc(r.error)}</span>` : 'sent'} · ${ago(r.at)}`).join('<br>')}`
    : '';
  $('#alerts-error').hidden = true;
}

$('#alerts-btn').onclick = async () => {
  $('#alerts-dialog').showModal();
  await loadAlerts().catch((err) => toast(err.message));
};
$('#alerts-close').onclick = () => $('#alerts-dialog').close();
$('#alerts-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    events: Object.fromEntries([...f.querySelectorAll('input[name^="ev_"]')].map((el) => [el.name.slice(3), el.checked])),
    needsInputDelaySec: Number(f.needsInputDelaySec.value),
    waitingDelaySec: Number(f.waitingDelaySec.value),
    skipWhenWatching: f.skipWhenWatching.checked,
    includeIntent: f.includeIntent.checked,
    enabled: f.enabled.checked,
    channel: f.channel.value.trim() || undefined,
  };
  if (f.webhookUrl.value.trim()) body.webhookUrl = f.webhookUrl.value.trim();
  if (f.botToken.value.trim()) body.botToken = f.botToken.value.trim();
  try {
    await api('POST', '/notify', body);
    toast('Alert settings saved');
    await loadAlerts();
  } catch (err) {
    $('#alerts-error').textContent = err.message;
    $('#alerts-error').hidden = false;
  }
});
$('#alerts-test').onclick = async () => {
  try {
    await api('POST', '/notify/test');
    toast('Test message sent to Slack');
  } catch (err) {
    $('#alerts-error').textContent = err.message;
    $('#alerts-error').hidden = false;
  }
};

// ------------------------------------------------------------------ remote sign-in

async function sessionOk() {
  try {
    return (await (await fetch('/api/session', { credentials: 'same-origin' })).json()).authenticated;
  } catch {
    return true; // offline, not signed out: keep retrying
  }
}

async function login(token, kind = 'token') {
  const res = await post('/api/login', { [kind]: token });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
}

function showLogin(message) {
  const dlg = $('#login-dialog');
  $('#login-error').hidden = !message;
  $('#login-error').textContent = message ?? '';
  if (!dlg.open) dlg.showModal();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = new FormData(e.target).get('token').trim().replace(/^.*#login=/, '');
  try {
    await login(token);
    $('#login-dialog').close();
    connectEvents();
  } catch (err) {
    showLogin(err.message);
  }
});

// Engines this machine can run; the New agent form offers a choice once there's more than Claude.
const ENGINE_LABEL = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
async function loadEngines() {
  try {
    const list = (await api('GET', '/engines')).filter((e) => e.installed && e.id !== 'claude');
    const sel = document.querySelector('#engine-field select');
    for (const e of list) sel.append(Object.assign(document.createElement('option'), { value: e.id, textContent: e.label }));
    $('#engine-field').hidden = !list.length;
  } catch {}
}

async function boot() {
  if (REMOTE) {
    document.body.classList.add('remote');
    if (loginHash) {
      history.replaceState(null, '', location.pathname); // drop the token from the address bar
      try {
        await login(loginHash);
      } catch (err) {
        return showLogin(err.message);
      }
    }
    if (ticketHash) {
      history.replaceState(null, '', location.pathname + (goHash ? `#${goHash}` : '')); // the ticket is single-use anyway
      if (!(await sessionOk())) {
        try {
          await login(ticketHash, 'ticket');
        } catch (err) {
          return showLogin(err.message);
        }
      }
    }
    if (!(await sessionOk())) return showLogin();
  }
  connectEvents();
  loadEngines();
}

boot();
setInterval(renderDetail, 30_000); // keep "x ago" labels fresh

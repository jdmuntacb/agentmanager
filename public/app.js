import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/xterm-addon-fit/lib/addon-fit.mjs';
import { marked } from '/vendor/marked/marked.esm.js';
import DOMPurify from '/vendor/dompurify/purify.es.mjs';
import { openStream, post, REMOTE } from '/transport.js';

const $ = (sel) => document.querySelector(sel);
const agents = new Map();
let backlogState = { items: [], projects: [], autoRun: true, defaultLimit: 2 };
let projectsState = [];
let sideTab = 'agents';
let showCompleted = false;
// #<id> selects an agent; #<id>/term also opens its terminal.
const loginHash = location.hash.match(/(?:^#|&)login=([\w-]+)/)?.[1] ?? null;
const [hashId, hashView] = loginHash ? [null, null] : location.hash.slice(1).split('/');
let selectedId = hashId || null;
let openTermOnLoad = hashView === 'term' || hashView === 'shell';
let filterText = '';

// ------------------------------------------------------------------ helpers

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

const DOCS = { analysis: 'Analysis', design: 'Design', flow: 'Flow', proposal: 'Proposal' };

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
  const d = a?.docs?.[docView.kind];
  const label = DOCS[docView.kind];
  $('#doc-title').textContent = `${label} · ${a?.name ?? ''}`;
  const body = $('#doc-body');
  if (d?.pending) body.innerHTML = `<p class="hint">Writing the ${label.toLowerCase()} document from the agent's work so far…</p>`;
  else if (d?.error) body.innerHTML = `<p class="error">Couldn't write it: ${esc(d.error)}</p>`;
  else if (d?.markdown) {
    if (body.dataset.rendered !== d.at) {
      body.innerHTML = docHtml(d.markdown);
      body.dataset.rendered = d.at;
      renderDiagrams(body);
    }
  }
  const stale = d?.markdown && a.brief?.updatedAt && d.briefUpdatedAt !== a.brief.updatedAt;
  $('#doc-meta').textContent = d?.markdown ? `Written ${ago(d.at)}${stale ? ' · the brief has changed since; Regenerate for the latest' : ''}` : '';
  for (const id of ['doc-copy', 'doc-download', 'doc-print']) $(`#${id}`).disabled = !d?.markdown;
  $('#doc-regen').disabled = Boolean(d?.pending);
  $('#doc-bg').hidden = !d?.pending;
}

function openDoc(agentId, kind) {
  docView = { agentId, kind };
  $('#doc-body').dataset.rendered = '';
  $('#doc-dialog').showModal();
  const a = agents.get(agentId);
  if (!a.docs?.[kind]?.markdown && !a.docs?.[kind]?.pending) generateDoc();
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
  const d = agents.get(docView.agentId)?.docs?.[docView.kind];
  await navigator.clipboard.writeText(d.markdown).then(
    () => toast('Markdown copied; paste into Confluence, Google Docs, Slack or a PR'),
    () => toast('Copy failed: your browser blocked clipboard access'),
  );
};
$('#doc-download').onclick = () => {
  const a = agents.get(docView.agentId);
  const blob = new Blob([a.docs[docView.kind].markdown], { type: 'text/markdown' });
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${a.slug}-${docView.kind}.md` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};
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

function briefPanel(a) {
  if (a.kind === 'general') return '';
  const b = a.brief;
  const ex = explainBox(a);
  const ins = insightsBox(a);
  if (!b) {
    return `<div class="card brief">
      <h3>Brief <span class="brief-actions">${ins.button} ${ex.button}</span></h3>
      <div class="share-row"><span class="hint">Share for review:</span> ${docButtons(a)}</div>
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
    <div class="share-row"><span class="hint">Share for review:</span> ${docButtons(a)}</div>
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
    <div class="line1">${prioChip(a.priority ?? 2)}<span class="name">${esc(a.name)}</span><span class="pill ${st}">${pillText(st)}</span></div>
    <div class="intent">${a.kind === 'general' ? '<span class="tag">general</span> ' : ''}${esc(a.intent || 'General session')}</div>
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
  renderBacklog();
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
  const keep = body.contains(active) && active.dataset.field ? { field: active.dataset.field, value: active.value, pos: active.selectionStart } : null;
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
          <input data-field="bug" placeholder="Bug key or URL, e.g. MB-12345" value="${esc(drafts.bug ?? '')}" />
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

      <div class="card">
        <h3>Notes</h3>
        <textarea class="notes" data-field="notes" placeholder="Anything worth remembering about this agent">${esc(drafts.notes ?? a.notes ?? '')}</textarea>
      </div>
    </div>`;

  renderDiagrams(body);
  markOverflow(body);

  if (keep) {
    const el = body.querySelector(`[data-field="${keep.field}"]`);
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

  kind: 'claude', // 'claude' = the agent's session, 'shell' = ancillary shell in its folder
  shellExited: false,

  open(id, kind = 'claude') {
    const a = agents.get(id);
    history.replaceState(null, '', `#${id}/${kind === 'shell' ? 'shell' : 'term'}`);
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
        if (this.kind === 'shell') this.shellExited = true;
        else this.xterm.write(`\r\n\x1b[2m[claude exited with code ${msg.code}; session kept]\x1b[0m\r\n`);
      }
      this.syncOverlay();
    }
  },

  syncOverlay() {
    const a = this.agentId && agents.get(this.agentId);
    const shell = this.kind === 'shell';
    const closed = shell ? this.shellExited : a && !a.runtime.running && a.status !== 'preparing';
    $('#term-overlay').hidden = !a || !closed;
    $('#term-overlay-msg').textContent = shell ? 'The shell has exited.' : "This agent's session is closed.";
    $('#term-resume').textContent = shell ? 'Start a new shell' : 'Resume session';
    for (const tab of document.querySelectorAll('.term-tab')) tab.classList.toggle('active', tab.dataset.kind === this.kind);
    if (a) {
      $('#term-title').textContent = shell ? `shell · ${a.workdir}` : `${a.name} · session ${a.sessionId}`;
    }
  },

  disconnect() {
    this.conn?.close();
    this.conn = null;
  },

  close() {
    if (this.agentId) history.replaceState(null, '', `#${this.agentId}`);
    this.disconnect();
    this.agentId = null;
    $('#term-wrap').hidden = true;
    $('#detail').classList.remove('with-term');
  },
};

$('#term-close').onclick = () => term.close();
$('#term-fit').onclick = () => term.refit();
$('#term-resume').onclick = () => {
  const id = term.agentId;
  if (term.kind === 'shell') {
    term.disconnect();
    return term.open(id, 'shell');
  }
  act(async () => {
    upsert(await api('POST', `/agents/${id}/start`, {}));
    term.xterm.focus();
  });
};
for (const tab of document.querySelectorAll('.term-tab')) {
  tab.onclick = async () => {
    const id = term.agentId;
    const a = agents.get(id);
    if (tab.dataset.kind === 'claude' && a && !a.runtime.running) {
      await act(async () => upsert(await api('POST', `/agents/${id}/start`, {})));
    }
    term.open(id, tab.dataset.kind);
  };
}

// ------------------------------------------------------------------ events

function upsert(a) {
  agents.set(a.id, a);
  render();
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
      term.open(a.id, 'shell');
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
  const queue = dialog.querySelector('input[name="when"]:checked').value === 'backlog';
  dialog.querySelector('.now-only').hidden = queue;
  dialog.querySelector('button[type=submit]').textContent = queue ? 'Add to backlog' : 'Create agents';
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
        worktree: f.get('worktree') ? true : undefined,
        plan: Boolean(f.get('plan')),
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
      worktree: f.get('worktree') ? true : undefined,
      base: f.get('base') || undefined,
      project: f.get('project') || undefined,
      plan: Boolean(f.get('plan')),
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
    msg.agents.forEach(watchDocs);
    if (selectedId && !agents.has(selectedId)) selectedId = null;
    if (openTermOnLoad && selectedId) {
      if (hashView === 'shell') term.open(selectedId, 'shell');
      else if (agents.get(selectedId).runtime.running) term.open(selectedId);
    }
    openTermOnLoad = false;
  } else if (msg.t === 'agent') {
    agents.set(msg.agent.id, msg.agent);
    watchDocs(msg.agent);
  } else if (msg.t === 'removed') {
    agents.delete(msg.id);
    if (selectedId === msg.id) select(null);
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
  for (const k of Object.keys(n.events)) f[`ev_${k}`].checked = n.events[k];
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
    events: { needsInput: f.ev_needsInput.checked, review: f.ev_review.checked, error: f.ev_error.checked, waiting: f.ev_waiting.checked },
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

async function login(token) {
  const res = await post('/api/login', { token });
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
    if (!(await sessionOk())) return showLogin();
  }
  connectEvents();
}

boot();
setInterval(renderDetail, 30_000); // keep "x ago" labels fresh

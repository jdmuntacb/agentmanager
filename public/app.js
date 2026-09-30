import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/xterm-addon-fit/lib/addon-fit.mjs';

const $ = (sel) => document.querySelector(sel);
const agents = new Map();
// #<id> selects an agent; #<id>/term also opens its terminal.
const [hashId, hashView] = location.hash.slice(1).split('/');
let selectedId = hashId || null;
let openTermOnLoad = hashView === 'term';
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

function toast(msg, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
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
  if (a.status === 'running') {
    if (a.runtime.attention) return 'attention';
    return a.runtime.busy ? 'working' : 'waiting';
  }
  return a.status;
}

const pillText = (st) => (st === 'attention' ? 'needs input' : st);

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

function renderList() {
  const list = [...agents.values()]
    .filter((a) => !filterText || `${a.name} ${a.intent} ${a.repo ?? ''} ${a.workdir ?? ''} ${a.id}`.toLowerCase().includes(filterText))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('#empty').hidden = agents.size > 0;

  const counts = { running: 0, stopped: 0, other: 0 };
  for (const a of agents.values()) {
    if (a.status === 'running') counts.running++;
    else if (a.status === 'stopped' || a.status === 'exited') counts.stopped++;
    else counts.other++;
  }
  $('#counts').innerHTML = agents.size
    ? `<span>${agents.size} agents</span><span>${counts.running} running</span><span>${counts.stopped} closed</span>`
    : '';

  $('#agent-list').innerHTML = list
    .map((a) => {
      const st = statusOf(a);
      return `<li data-id="${a.id}" class="${a.id === selectedId ? 'selected' : ''}">
        <div class="line1"><span class="name">${esc(a.name)}</span><span class="pill ${st}">${pillText(st)}</span></div>
        <div class="intent">${esc(a.intent)}</div>
        <div class="meta">
          <span class="mono">${a.id}</span>
          ${a.git?.branch ? `<span>⎇ ${esc(a.git.branch)}</span>` : ''}
          ${a.prs.length ? `<span>${a.prs.length} PR</span>` : ''}
          ${a.bugs.length ? `<span>${a.bugs.length} bug</span>` : ''}
          ${a.runtime.clients ? `<span title="terminals attached">◉ ${a.runtime.clients}</span>` : ''}
        </div>
      </li>`;
    })
    .join('');
}

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
  const totalCost = a.sessions.reduce((s, x) => s + (x.cost?.usd ?? 0), 0);
  const current = a.sessions.find((s) => s.id === a.sessionId);

  body.innerHTML = `
    <div class="d-head">
      <div class="d-title">
        <h2>${esc(a.name)} <span class="pill ${st}">${pillText(st)}</span></h2>
        <p class="intent">${esc(a.intent)}</p>
      </div>
      <div class="d-actions">
        <button class="primary" data-act="terminal" ${a.status === 'preparing' ? 'disabled' : ''}>${running ? 'Open terminal' : 'Resume & open terminal'}</button>
        ${running
          ? `<button data-act="stop" title="Close the claude process; the session ID is kept">Close session</button>`
          : `<button data-act="start" ${a.status === 'preparing' ? 'disabled' : ''}>Resume in background</button>`}
        <button data-act="fresh" ${running || a.status === 'preparing' ? 'disabled' : ''} title="Start over with a new session ID (old ones are kept)">New session</button>
        <button data-act="refresh" title="Re-scan git, PRs and transcripts">Refresh</button>
        <button class="danger" data-act="delete">Delete</button>
      </div>
    </div>
    ${a.error ? `<div class="error-box">${esc(a.error)}</div>` : ''}
    ${a.runtime.attention ? `<div class="error-box">${esc(a.runtime.attention)}: the agent is waiting for an answer. Open its terminal to respond.</div>` : ''}

    <div class="grid">
      <div class="card">
        <h3>Session</h3>
        <dl class="kv">
          <dt>Session ID</dt><dd><code>${esc(a.sessionId)}</code>${copyBtn(a.sessionId)}</dd>
          <dt>Title</dt><dd>${esc(current?.title ?? '—')}</dd>
          <dt>Agent ID</dt><dd><code>${a.id}</code></dd>
          <dt>Last output</dt><dd>${a.runtime.lastOutputAt ? ago(a.runtime.lastOutputAt) : current?.lastActivity ? ago(current.lastActivity) : '—'}</dd>
          <dt>Cost</dt><dd>${totalCost ? `$${totalCost.toFixed(2)}` : '—'}</dd>
          <dt>Mode</dt><dd>${esc(a.permissionMode)}${a.model ? ` · ${esc(a.model)}` : ''}</dd>
        </dl>
      </div>

      <div class="card">
        <h3>Workspace</h3>
        <dl class="kv">
          <dt>Folder</dt><dd><code>${esc(a.workdir ?? 'preparing…')}</code>${a.workdir ? copyBtn(a.workdir) : ''}</dd>
          <dt>Repo</dt><dd>${a.repo ? `<code>${esc(a.repo)}</code>` : '—'}</dd>
          <dt>Branch</dt><dd>${a.git?.branch ? `<code>${esc(a.git.branch)}</code>` : '—'}${a.git?.dirtyFiles ? ` <span class="tag">${a.git.dirtyFiles} changed</span>` : ''}</dd>
          <dt>Head</dt><dd>${a.git?.head ? `<code>${esc(a.git.head.sha)}</code> ${esc(a.git.head.subject)}` : '—'}</dd>
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
          <tr><th>ID</th><th>Title</th><th>Active</th><th></th></tr>
          ${[...a.sessions]
            .reverse()
            .map(
              (s) => `<tr class="${s.id === a.sessionId ? 'current' : ''}">
              <td><code title="${esc(s.id)}">${s.id.slice(0, 8)}</code>${copyBtn(s.id)}</td>
              <td>${esc(s.title ?? '')}</td>
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
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  },

  refit() {
    if (!this.agentId) return;
    try {
      this.fit.fit();
    } catch {}
  },

  open(id) {
    const a = agents.get(id);
    history.replaceState(null, '', `#${id}/term`);
    $('#term-wrap').hidden = false;
    $('#detail').classList.add('with-term');
    $('#term-title').textContent = `${a.name} · ${a.sessionId}`;
    this.ensure();
    if (this.agentId === id && this.ws) {
      this.xterm.focus();
      return;
    }
    this.disconnect();
    this.agentId = id;
    this.xterm.reset();
    requestAnimationFrame(() => this.refit());

    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term/${id}`);
    this.ws = ws;
    ws.onopen = () => {
      this.refit();
      this.send({ t: 'r', cols: this.xterm.cols, rows: this.xterm.rows });
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'hello') {
        this.xterm.write(msg.backlog);
        this.xterm.focus();
      } else if (msg.t === 'o') {
        this.xterm.write(msg.d);
      } else if (msg.t === 'exit') {
        this.xterm.write(`\r\n\x1b[2m[claude exited with code ${msg.code}; session kept]\x1b[0m\r\n`);
      }
      this.syncOverlay();
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
    };
  },

  syncOverlay() {
    const a = this.agentId && agents.get(this.agentId);
    $('#term-overlay').hidden = !a || a.runtime.running || a.status === 'preparing';
    if (a) $('#term-title').textContent = `${a.name} · session ${a.sessionId}`;
  },

  disconnect() {
    this.ws?.close();
    this.ws = null;
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
  act(async () => {
    upsert(await api('POST', `/agents/${id}/start`, {}));
    term.xterm.focus();
  });
};

// ------------------------------------------------------------------ events

function upsert(a) {
  agents.set(a.id, a);
  render();
}

$('#agent-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (li) select(li.dataset.id);
});

$('#detail-body').addEventListener('click', async (e) => {
  const a = agents.get(selectedId);
  if (!a) return;
  const btn = e.target.closest('button');
  if (!btn) return;

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
    case 'start':
      act(async () => upsert(await api('POST', `/agents/${a.id}/start`, {})), 'Resumed in the background');
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
      if (!confirm(`Delete agent "${a.name}"? Its session IDs will be forgotten by Agent Manager.`)) return;
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
$('#new-btn').onclick = () => {
  $('#new-error').hidden = true;
  dialog.showModal();
  dialog.querySelector('textarea').focus();
};
$('#new-cancel').onclick = () => dialog.close();
$('#new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const intents = String(f.get('intents'))
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    const created = await api('POST', '/agents', {
      intents,
      repo: f.get('repo') || undefined,
      dir: f.get('dir') || undefined,
      permissionMode: f.get('permissionMode') || undefined,
      model: f.get('model') || undefined,
      worktree: f.get('worktree') ? true : undefined,
      start: Boolean(f.get('start')),
    });
    created.forEach((a) => agents.set(a.id, a));
    dialog.close();
    e.target.reset();
    select(created[0].id);
    toast(`Created ${created.length} agent${created.length > 1 ? 's' : ''}`);
  } catch (err) {
    $('#new-error').textContent = err.message;
    $('#new-error').hidden = false;
  }
});

// ------------------------------------------------------------------ live updates

function connectEvents() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/events`);
  ws.onopen = () => {
    $('#conn').textContent = 'daemon connected';
    $('#conn').className = 'conn ok';
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.t === 'snapshot') {
      agents.clear();
      msg.agents.forEach((a) => agents.set(a.id, a));
      if (selectedId && !agents.has(selectedId)) selectedId = null;
      if (openTermOnLoad && selectedId && agents.get(selectedId).runtime.running) term.open(selectedId);
      openTermOnLoad = false;
    } else if (msg.t === 'agent') {
      agents.set(msg.agent.id, msg.agent);
    } else if (msg.t === 'removed') {
      agents.delete(msg.id);
      if (selectedId === msg.id) select(null);
    }
    render();
  };
  ws.onclose = () => {
    $('#conn').textContent = 'daemon offline, retrying…';
    $('#conn').className = 'conn bad';
    setTimeout(connectEvents, 2000);
  };
}

connectEvents();
setInterval(renderDetail, 30_000); // keep "x ago" labels fresh

// Hub UI: every machine's agents and what they're waiting on, and (where a machine allows
// it) answering, messaging, starting and stopping them, new agents, and live terminals.
// Everything shown comes from runners, so it is only ever set as text, never as HTML.
import { closeTerminal, openTerminal, syncTerminal } from './term.js';
const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
};

const state = { fleet: null, tab: 'inbox', machine: null, query: '', confirmRemove: null, open: new Set() };
const drafts = new Map(); // typed text survives live re-renders
const busy = new Set(); // actions in flight, by key
try {
  state.tab = localStorage.getItem('hub.tab') || 'inbox';
} catch {}

async function call(method, route, body) {
  const res = await fetch(`/api${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-agentmgr': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), bad ? 6000 : 2500);
}

const ENGINE_LABEL = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' };
/** Engines a machine reports installed (its engine:* labels). */
const enginesOf = (runner) => (runner?.labels ?? []).filter((l) => l.startsWith('engine:')).map((l) => l.slice(7));
/** Fill an engine picker; hidden while Claude Code is the only choice. */
function fillEngines(field, select, engines) {
  const prev = select.value;
  const list = [...new Set(['claude', ...engines])];
  select.replaceChildren(...list.map((e) => el('option', { value: e === 'claude' ? '' : e }, ENGINE_LABEL[e] ?? e)));
  if ([...select.options].some((o) => o.value === prev)) select.value = prev;
  $(field).hidden = list.length < 2;
}

const allows = (runner, perm) => Boolean(runner?.online && runner.policy?.allow?.includes(perm));

/** Run an action on a machine; the button shows progress, and the result comes as a toast. */
async function act(runnerId, action, args, { key = `${runnerId}:${action}:${args.agent ?? ''}`, done } = {}) {
  if (busy.has(key)) return;
  busy.add(key);
  render(true);
  try {
    await call('POST', `/runners/${encodeURIComponent(runnerId)}/actions`, { action, args });
    toast(done ?? 'Done');
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  } finally {
    busy.delete(key);
    render(true);
  }
}

const btn = (label, onclick, { primary = false, key, title, cls = '' } = {}) =>
  el('button', { class: `${primary ? 'primary ' : ''}${cls}`.trim() || null, disabled: key && busy.has(key), title, onclick: (e) => (e.stopPropagation(), onclick(e)) }, label);

/** A text box whose value survives re-renders (drafts are keyed). */
function draftInput(key, { placeholder, area = false, initial = '' } = {}) {
  const box = el(area ? 'textarea' : 'input', { placeholder, rows: area ? 3 : null, 'data-draft': key });
  box.value = drafts.get(key) ?? initial;
  box.addEventListener('input', () => drafts.set(key, box.value));
  return box;
}

// ------------------------------------------------------------------ time

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ------------------------------------------------------------------ sign in

async function boot() {
  const login = location.hash.match(/^#login=(.+)$/);
  if (login) {
    history.replaceState(null, '', location.pathname); // keep the token out of history
    await call('POST', '/login', { token: decodeURIComponent(login[1]) }).catch(() => {});
  }
  const failed = location.hash.match(/^#error=(.+)$/);
  if (failed) history.replaceState(null, '', location.pathname);
  const s = await call('GET', '/session').catch(() => ({ authenticated: false }));
  if (s.name) $('#hub-name').textContent = s.name;
  // With Google set up, the token is the fallback, folded away.
  $('#google-btn').hidden = !s.google;
  $('#token-box').open = !s.google;
  $('#token-summary').textContent = s.google ? 'Or use the access token' : 'Use the access token';
  if (!s.authenticated) return showLogin(failed ? decodeURIComponent(failed[1]) : undefined);
  showApp();
}

function showLogin(message) {
  $('#app').hidden = true;
  $('#top-actions').hidden = true;
  $('#login').hidden = false;
  $('#login-error').hidden = !message;
  $('#login-error').textContent = message ?? '';
  if ($('#token-box').open) $('#token').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await call('POST', '/login', { token: $('#token').value.trim() });
    $('#token').value = '';
    showApp();
  } catch (err) {
    showLogin(err.message);
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await call('POST', '/logout').catch(() => {});
  stream?.close();
  closeTerminal();
  showLogin();
});

// ------------------------------------------------------------------ live data

let stream = null;
function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#top-actions').hidden = false;
  connect();
}

function connect() {
  stream?.close();
  stream = new EventSource('/api/events');
  stream.onopen = () => setConn(true);
  stream.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.t === 'fleet') {
      state.fleet = msg.fleet;
      render();
    }
  };
  stream.onerror = async () => {
    setConn(false);
    // EventSource retries by itself; a signed-out session would retry forever, so check.
    const s = await call('GET', '/session').catch(() => null);
    if (s && !s.authenticated) {
      stream.close();
      showLogin('Signed out; sign in again');
    }
  };
}

function setConn(ok) {
  $('#conn').className = `conn ${ok ? 'ok' : 'bad'}`;
  $('#conn').textContent = ok ? 'live' : 'reconnecting…';
}

// ------------------------------------------------------------------ render

let deferred = false;
function render(force = false) {
  const f = state.fleet;
  if (!f) return;
  // Don't rebuild the list under someone typing; catch up when they leave the box.
  const typing = document.activeElement?.dataset?.draft;
  if (typing && !force) {
    deferred = true;
    return;
  }
  deferred = false;
  const focus = typing ? { key: typing, at: document.activeElement.selectionStart } : null;
  syncTerminal(f);
  const canCreate = f.runners.some((r) => allows(r, 'create') && r.projects?.length);
  $('#new-btn').hidden = !canCreate;
  $('#hub-name').textContent = f.hub.name;
  if (state.machine && !f.runners.some((r) => r.id === state.machine)) state.machine = null;
  renderMachines(f);
  const inbox = filtered(f.inbox, (i) => [i.agentName, i.title, i.project, i.runnerName]);
  const agents = filtered(f.agents, (a) => [a.name, a.intent, a.project, a.branch, a.runnerName, a.id]);
  $('#inbox-count').textContent = f.inbox.length;
  $('#inbox-count').classList.toggle('hot', f.inbox.some((i) => i.online));
  $('#agents-count').textContent = f.agents.length;
  const open = f.backlog.items.filter((x) => OPEN_ITEM.has(x.status));
  $('#backlog-count').textContent = open.length;
  $('#backlog-count').classList.toggle('hot', open.some((x) => x.status === 'review' || x.stalled || x.status === 'blocked'));
  for (const b of document.querySelectorAll('[role="tab"]')) b.classList.toggle('active', b.dataset.tab === state.tab);
  $('#tab-inbox').hidden = state.tab !== 'inbox';
  $('#tab-agents').hidden = state.tab !== 'agents';
  $('#tab-backlog').hidden = state.tab !== 'backlog';
  const chip = $('#filter-chip');
  const m = f.runners.find((r) => r.id === state.machine);
  chip.hidden = !m;
  chip.className = 'chip clear';
  chip.textContent = m ? `on ${m.name}` : '';
  if (state.tab === 'inbox') renderInbox(inbox, f);
  else if (state.tab === 'backlog') renderBacklog(f);
  else renderAgents(agents, f);
  if (focus) {
    const box = document.querySelector(`[data-draft="${CSS.escape(focus.key)}"]`);
    box?.focus();
    box?.setSelectionRange?.(focus.at, focus.at);
  }
}
document.addEventListener('focusout', () => setTimeout(() => deferred && render(), 0));

function filtered(items, fields) {
  const q = state.query.toLowerCase();
  return items.filter(
    (x) => (!state.machine || x.runnerId === state.machine) && (!q || fields(x).some((v) => String(v ?? '').toLowerCase().includes(q))),
  );
}

function renderMachines(f) {
  const box = $('#machines');
  box.replaceChildren();
  if (!f.runners.length) {
    box.append(
      el(
        'div',
        { class: 'card empty-machines' },
        el('p', {}, el('b', {}, 'No machines yet.')),
        el('p', { class: 'muted' }, 'Add your first Mac: click ', el('b', {}, 'Add machine'), ' and run the command it shows on that Mac.'),
      ),
    );
    return;
  }
  for (const r of f.runners) {
    const confirming = state.confirmRemove === r.id;
    const card = el(
      'div',
      {
        class: `machine${r.online ? '' : ' offline'}${state.machine === r.id ? ' selected' : ''}`,
        role: 'button',
        tabindex: '0',
        title: state.machine === r.id ? 'Show all machines' : `Show only ${r.name}`,
        onclick: () => {
          state.machine = state.machine === r.id ? null : r.id;
          render();
        },
        onkeydown: (e) => e.key === 'Enter' && e.currentTarget.click(),
      },
      el('div', { class: 'm-head' }, el('span', { class: `dot${r.online ? ' on' : ''}` }), el('span', { class: 'm-name' }, r.name), el('span', { class: 'muted small' }, r.online ? 'online' : `offline${r.lastSeen ? ` · ${ago(r.lastSeen)}` : ''}`)),
      el(
        'div',
        { class: 'm-stats' },
        el('span', {}, el('b', {}, r.agents), ' agents'),
        el('span', {}, el('b', {}, r.working), ' working'),
        el('span', { class: r.needs ? 'needs' : '' }, el('b', {}, r.needs), ' need you'),
      ),
      el(
        'div',
        { class: 'm-foot' },
        el('span', { class: 'chips' }, ...(r.policy?.allow ?? []).map((p) => el('span', { class: 'chip', title: 'What this machine lets the hub do' }, p)), r.version ? el('span', { class: 'chip' }, `v${r.version}`) : null),
        el(
          'span',
          { class: 'chips' },
          openLink(r, null, 'Open'),
          confirming
            ? el('button', { class: 'link', onclick: (e) => (e.stopPropagation(), removeMachine(r)) }, 'Remove for sure?')
            : el('button', { class: 'link', title: 'Remove from the hub', onclick: (e) => (e.stopPropagation(), (state.confirmRemove = r.id), render(), setTimeout(() => { if (state.confirmRemove === r.id) { state.confirmRemove = null; render(); } }, 4000)) }, 'Remove'),
        ),
      ),
    );
    box.append(card);
  }
}

async function removeMachine(r) {
  state.confirmRemove = null;
  await call('DELETE', `/runners/${encodeURIComponent(r.id)}`).catch((err) => alertLine(err.message));
}

function alertLine(msg) {
  const p = el('p', { class: 'error' }, msg);
  $('#app').prepend(p);
  setTimeout(() => p.remove(), 5000);
}

/** "Open" goes to the machine's own UI (remote access), at the agent's terminal. */
function openLink(runner, agentId, label = `Open on ${runner?.name ?? 'machine'}`) {
  const u = runner?.urls?.[0]?.url;
  if (!u) {
    return el('span', { class: 'open disabled', title: `Turn on remote access on ${runner?.name ?? 'that machine'} (agentmgr remote on) to open it from here` }, label);
  }
  const base = `${u.replace(/\/$/, '')}/`;
  const go = agentId ? `${encodeURIComponent(agentId)}/term` : '';
  const href = `${base}${go ? `#${go}` : ''}`;
  const onclick = (e) => {
    e.stopPropagation();
    if (!allows(runner, 'signin') || e.metaKey || e.ctrlKey || e.shiftKey) return;
    // Signed in on the way: the machine hands out a one-time ticket for its own page.
    e.preventDefault();
    const w = window.open('about:blank', '_blank');
    if (w) w.opener = null;
    call('POST', `/runners/${encodeURIComponent(runner.id)}/actions`, { action: 'signin', args: {} })
      .then((r) => `${base}#ticket=${encodeURIComponent(r.ticket)}${go ? `&go=${encodeURIComponent(decodeURIComponent(go))}` : ''}`)
      .catch((err) => (toast(`Opening without sign-in: ${err.message}`, true), href))
      .then((url) => (w ? (w.location.href = url) : (location.href = url)));
  };
  return el('a', { class: 'open', href, target: '_blank', rel: 'noopener noreferrer', onclick, title: allows(runner, 'signin') ? 'Opens signed in (one-time link)' : `Signs in with ${runner.name}'s own access token. Allow "signin" on it to skip that.` }, `${label} ↗`);
}

const runnerOf = (f, id) => f.runners.find((r) => r.id === id);
const KIND_LABEL = { prompt: 'Needs input', question: 'Question', stuck: 'Stuck?', conflict: 'Overlap' };

function renderInbox(items, f) {
  const box = $('#tab-inbox');
  box.replaceChildren();
  if (!items.length) {
    box.append(el('div', { class: 'empty' }, f.inbox.length ? 'Nothing matches the filter.' : f.runners.length ? 'Nothing needs you right now. 🎉' : 'Add a machine to see what its agents need.'));
    return;
  }
  for (const it of items) {
    const runner = runnerOf(f, it.runnerId);
    const sub =
      it.kind === 'stuck'
        ? it.detail
        : it.kind === 'conflict'
          ? `Same files as ${it.with}: ${(it.files ?? []).join(', ')}${it.mergeFirst ? ` · suggested: ${it.mergeFirst === it.agentId ? it.agentName : it.with} lands first` : ''}`
          : it.kind === 'question'
            ? [it.question?.context, it.question?.default && `Proceeding with ${it.question.default} until you answer.`, !allows(runner, 'inbox') && it.question?.options?.length && `Options: ${it.question.options.join(' · ')}`].filter(Boolean).join(' ') || null
            : null;
    box.append(
      el(
        'div',
        { class: `row${it.online ? '' : ' offline'}` },
        el('div', { class: 'r-title' }, el('span', { class: `kind ${it.kind}` }, KIND_LABEL[it.kind]), el('span', { class: 'tag machine' }, it.runnerName), el('span', { class: 'name' }, it.agentName), it.priority <= 1 ? el('span', { class: `tag p${it.priority}` }, `P${it.priority}`) : null, it.project ? el('span', { class: 'tag' }, it.project) : null),
        el('div', { class: 'r-sub' }, it.title),
        sub ? el('div', { class: 'r-meta' }, sub) : null,
        allows(runner, 'inbox') ? inboxActions(it, runner) : it.kind === 'prompt' && it.choices?.length ? el('div', { class: 'choices' }, ...it.choices.map((c) => el('span', {}, `${c.key}. ${c.label}`))) : null,
        el('div', { class: 'r-actions' }, it.at ? el('span', { class: 'muted small' }, ago(it.at)) : null, termButton(runner, it.agentId, it.agentName), openLink(runner, it.agentId)),
      ),
    );
  }
}

function statusOf(a) {
  if (!a.online) return ['offline', 'machine offline'];
  if (a.attention) return ['attention', 'needs input'];
  if (a.planning) return ['planning', 'planning'];
  if (a.status === 'running') return a.working ? ['working', 'working'] : ['waiting', 'waiting'];
  return [a.status, a.status];
}

function renderAgents(agents, f) {
  const box = $('#tab-agents');
  box.replaceChildren();
  if (!agents.length) {
    box.append(el('div', { class: 'empty' }, f.agents.length ? 'Nothing matches the filter.' : 'No agents on any machine yet.'));
    return;
  }
  const rank = (a) => (a.attention ? 0 : a.working ? 1 : a.status === 'running' ? 2 : 3);
  const byMachine = new Map();
  for (const a of agents) {
    if (!byMachine.has(a.runnerId)) byMachine.set(a.runnerId, []);
    byMachine.get(a.runnerId).push(a);
  }
  for (const [rid, list] of byMachine) {
    const runner = runnerOf(f, rid);
    box.append(el('div', { class: 'group-title' }, el('span', { class: `dot${runner?.online ? ' on' : ''}` }), runner?.name ?? rid, el('span', { class: 'count' }, list.length)));
    list.sort((a, b) => b.online - a.online || rank(a) - rank(b) || a.priority - b.priority || String(b.updatedAt).localeCompare(String(a.updatedAt)));
    for (const a of list) {
      const [cls, label] = statusOf(a);
      const needs = [a.questions && `${a.questions} question${a.questions > 1 ? 's' : ''}`, a.stuck && 'stuck?', a.conflicts && 'overlap'].filter(Boolean);
      box.append(
        el(
          'div',
          { class: `row${a.online ? '' : ' offline'}` },
          el('div', { class: 'r-title' }, el('span', { class: `pill ${cls}` }, label), el('span', { class: 'name' }, a.name), a.priority <= 1 ? el('span', { class: `tag p${a.priority}` }, `P${a.priority}`) : null, a.project ? el('span', { class: 'tag' }, a.project) : null, a.engine && a.engine !== 'claude' ? el('span', { class: 'tag label' }, ENGINE_LABEL[a.engine] ?? a.engine) : null, ...needs.map((n) => el('span', { class: 'kind stuck' }, n))),
          a.intent ? el('div', { class: 'r-sub' }, a.intent.length > 220 ? `${a.intent.slice(0, 219)}…` : a.intent) : null,
          el(
            'div',
            { class: 'r-meta' },
            el('span', { class: 'mono' }, `${a.runnerName}/${a.id}`),
            a.branch ? el('span', { class: 'branch', title: a.branch }, a.branch) : null,
            ...a.prs.map((p) => el('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer', class: `tag ${String(p.state ?? '').toLowerCase()}`, title: p.title ?? '' }, `#${p.number ?? '?'}${p.state ? ` ${p.state.toLowerCase()}` : ''}`)),
            a.outcome && a.outcome !== 'in progress' ? el('span', {}, a.outcome) : null,
            a.costUsd != null ? el('span', {}, `$${a.costUsd.toFixed(2)}`) : null,
            a.lastOutputAt || a.updatedAt ? el('span', {}, `active ${ago(a.lastOutputAt ?? a.updatedAt)}`) : null,
            a.error ? el('span', { class: 'error' }, a.error) : null,
          ),
          el('div', { class: 'r-actions' }, termButton(runner, a.id, a.name), openLink(runner, a.id)),
          allows(runner, 'control') && a.online ? agentActions(a, runner) : null,
          state.open.has(`tell:${a.runnerId}:${a.id}`) ? tellForm(a) : null,
        ),
      );
    }
  }
}

// ------------------------------------------------------------------ backlog

const OPEN_ITEM = new Set(['queued', 'active', 'review', 'blocked']);
const ITEM_RANK = { review: 0, blocked: 1, active: 2, queued: 3, done: 4, cancelled: 5 };

/** A backlog operation; the button shows progress and the result comes as a toast. */
async function itemOp(it, op, body, done) {
  const key = `item:${it.id}:${op}`;
  if (busy.has(key)) return false;
  busy.add(key);
  render(true);
  try {
    if (op === 'remove') await call('DELETE', `/backlog/${encodeURIComponent(it.id)}`);
    else await call('POST', `/backlog/${encodeURIComponent(it.id)}/${op}`, body ?? {});
    toast(done);
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  } finally {
    busy.delete(key);
    render(true);
  }
}

function itemPill(it) {
  if (it.stalled) return ['attention', `stalled on ${it.runnerName ?? 'a machine'}`];
  if (it.status === 'active') return it.agent?.attention ? ['attention', 'needs input'] : it.agent?.working ? ['working', 'working'] : ['waiting', 'active'];
  if (it.status === 'review') return ['attention', 'review'];
  if (it.status === 'blocked') return ['error', 'blocked'];
  return [it.status, it.status];
}

function renderBacklog(f) {
  const box = $('#tab-backlog');
  box.replaceChildren();
  const bl = f.backlog;
  const q = state.query.toLowerCase();
  const items = bl.items
    .filter((x) => (!state.machine || x.runnerId === state.machine) && (!q || [x.title, x.projectName, x.runnerName, x.id, ...x.labels].some((v) => String(v ?? '').toLowerCase().includes(q))))
    .sort((a, b) => (a.stalled ? 1 : ITEM_RANK[a.status]) - (b.stalled ? 1 : ITEM_RANK[b.status]) || a.priority - b.priority || a.order - b.order);
  box.append(
    el(
      'div',
      { class: 'backlog-head' },
      bl.projects.length ? btn('Add work', openQueue, { primary: true }) : el('span', { class: 'muted small' }, 'To queue work, a machine must allow "create" in its hub settings.'),
      el(
        'label',
        { class: 'toggle', title: 'Start queued items automatically on machines with room' },
        el('input', {
          type: 'checkbox',
          checked: bl.autoRun,
          onchange: (e) => call('POST', '/backlog/settings', { autoRun: e.target.checked }).catch((err) => toast(err.message, true)),
        }),
        'Auto-start',
      ),
    ),
  );
  if (!items.length) {
    box.append(el('div', { class: 'empty' }, bl.items.length ? 'Nothing matches the filter.' : 'Nothing queued. Work added here starts on whichever machine has room.'));
    return;
  }
  const finished = items.filter((x) => !OPEN_ITEM.has(x.status));
  const shown = [...items.filter((x) => OPEN_ITEM.has(x.status)), ...finished.slice(0, state.open.has('backlog:done') ? finished.length : 5)];
  for (const it of shown) {
    const runner = it.runnerId ? runnerOf(f, it.runnerId) : null;
    const [cls, label] = itemPill(it);
    box.append(
      el(
        'div',
        { class: `row${OPEN_ITEM.has(it.status) ? '' : ' offline'}` },
        el('div', { class: 'r-title' }, el('span', { class: `pill ${cls}` }, label), el('span', { class: 'name' }, it.title.length > 160 ? `${it.title.slice(0, 159)}…` : it.title), it.priority <= 1 ? el('span', { class: `tag p${it.priority}` }, `P${it.priority}`) : null, el('span', { class: 'tag' }, it.projectName), ...it.labels.map((l) => el('span', { class: 'tag label' }, l))),
        el(
          'div',
          { class: 'r-meta' },
          el('span', { class: 'mono' }, it.agentId ? `${it.runnerName}/${it.agentId}` : it.id),
          it.waiting ? el('span', {}, `waiting: ${it.waiting}`) : null,
          it.stalled ? el('span', {}, 'Its machine is offline. Wait for it, or requeue to start over on another machine.') : null,
          it.error ? el('span', { class: 'error' }, it.error) : null,
          el('span', {}, ago(it.doneAt ?? it.reviewAt ?? it.startedAt ?? it.createdAt)),
        ),
        itemActions(it, runner),
        state.open.has(`reopen:${it.id}`) ? reopenForm(it) : null,
      ),
    );
  }
  if (finished.length > 5) {
    box.append(btn(state.open.has('backlog:done') ? 'Show fewer' : `Show all ${finished.length} finished`, () => (state.open.has('backlog:done') ? state.open.delete('backlog:done') : state.open.add('backlog:done'), render(true)), { cls: 'ghost' }));
  }
}

function itemActions(it, runner) {
  const k = (op) => `item:${it.id}:${op}`;
  const b = [];
  if (it.status === 'queued') {
    b.push(btn('Start now', () => itemOp(it, 'start', {}, 'Starting'), { key: k('start'), title: 'Start it now, even past the machines\' limits' }));
    b.push(btn('Remove', () => itemOp(it, 'remove', null, 'Removed'), { key: k('remove'), cls: 'ghost' }));
  }
  if (it.status === 'review') {
    b.push(btn('Accept', () => itemOp(it, 'accept', {}, 'Done'), { primary: true, key: k('accept') }));
    if (allows(runner, 'control')) b.push(btn('Reopen…', () => (state.open.has(`reopen:${it.id}`) ? state.open.delete(`reopen:${it.id}`) : state.open.add(`reopen:${it.id}`), render(true)), { title: 'Send it back to the same agent with a note' }));
  }
  if (it.stalled || it.status === 'blocked' || it.status === 'cancelled') b.push(btn('Requeue', () => itemOp(it, 'requeue', {}, 'Back in the queue'), { key: k('requeue'), title: it.runnerName ? `Start over on another machine than ${it.runnerName}` : 'Back in the queue' }));
  if (it.status === 'active' || it.status === 'blocked') b.push(btn('Cancel', () => itemOp(it, 'cancel', {}, 'Cancelled; its agent is left as it is'), { key: k('cancel'), cls: 'ghost' }));
  if (it.status === 'done' || it.status === 'cancelled') b.push(btn('Remove', () => itemOp(it, 'remove', null, 'Removed'), { key: k('remove'), cls: 'ghost' }));
  if (it.agentId && runner?.online) b.push(termButton(runner, it.agentId, it.agent?.name ?? it.agentId), openLink(runner, it.agentId));
  return b.length ? el('div', { class: 'actions' }, ...b) : null;
}

function reopenForm(it) {
  const dk = `reopen:${it.id}:text`;
  const box = draftInput(dk, { area: true, placeholder: 'What still needs doing?' });
  const send = async () => {
    if (await itemOp(it, 'reopen', { note: box.value.trim() }, 'Sent back to its agent')) {
      drafts.delete(dk);
      state.open.delete(`reopen:${it.id}`);
      render(true);
    }
  };
  return el('form', { class: 'reply col', onsubmit: (e) => (e.preventDefault(), send()) }, box, el('div', { class: 'actions' }, el('button', { class: 'primary', disabled: busy.has(`item:${it.id}:reopen`) }, 'Reopen')));
}

function openQueue() {
  const sel = $('#queue-project');
  const prev = sel.value;
  sel.replaceChildren(
    ...state.fleet.backlog.projects.map((p) => el('option', { value: p.ref }, `${p.name} · ${p.machines.map((m) => `${m.name}${m.warm ? '' : ' (not cloned)'}`).join(', ')}`)),
  );
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  fillEngines('#queue-engine-field', $('#queue-engine'), state.fleet.runners.filter((r) => allows(r, 'create')).flatMap(enginesOf));
  $('#queue-error').hidden = true;
  $('#queue-dialog').showModal();
  $('#queue-titles').focus();
}
$('#queue-cancel').addEventListener('click', () => $('#queue-dialog').close());
$('#queue-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const items = $('#queue-titles').value.split('\n').map((x) => x.trim()).filter(Boolean);
  const body = { items, project: $('#queue-project').value, labels: $('#queue-labels').value, priority: Number($('#queue-priority').value) };
  if ($('#queue-mode').value) body.permissionMode = $('#queue-mode').value;
  if ($('#queue-engine').value) body.engine = $('#queue-engine').value;
  const submit = e.submitter ?? $('#queue-form button.primary');
  submit.disabled = true;
  try {
    const added = await call('POST', '/backlog', body);
    $('#queue-titles').value = '';
    $('#queue-dialog').close();
    toast(`Queued ${added.length} item${added.length > 1 ? 's' : ''}`);
  } catch (err) {
    $('#queue-error').textContent = err.message;
    $('#queue-error').hidden = false;
  } finally {
    submit.disabled = false;
  }
});

function inboxActions(it, runner) {
  const r = runner.id;
  const agent = it.agentId;
  const key = (k) => `${r}:${it.key}:${k}`;
  if (it.kind === 'prompt') {
    return el(
      'div',
      { class: 'actions' },
      ...(it.choices ?? []).map((c) => btn(`${c.key}. ${c.label}`, () => act(r, 'prompt-key', { agent, key: c.key }, { key: key(c.key), done: `Sent ${c.key} to ${it.agentName}` }), { primary: c.key === '1', key: key(c.key) })),
      btn('Esc', () => act(r, 'prompt-key', { agent, key: 'esc' }, { key: key('esc'), done: 'Sent Esc' }), { key: key('esc'), title: 'Escape' }),
    );
  }
  if (it.kind === 'question') {
    const dk = `${r}:${it.key}:text`;
    const send = (text) =>
      act(r, 'answer', { agent, question: it.question.id, text }, { key: key('answer'), done: `Answer queued for ${it.agentName}` }).then((ok) => ok && drafts.delete(dk));
    const box = draftInput(dk, { placeholder: 'Or type an answer…' });
    return el(
      'div',
      { class: 'reply col' },
      it.question?.options?.length ? el('div', { class: 'actions' }, ...it.question.options.map((o) => btn(o, () => send(o), { key: key('answer') }))) : null,
      el('form', { class: 'reply', onsubmit: (e) => (e.preventDefault(), box.value.trim() && send(box.value.trim())) }, box, el('button', { class: 'primary', disabled: busy.has(key('answer')) }, 'Send')),
    );
  }
  if (it.kind === 'stuck') {
    const dk = `${r}:${it.key}:nudge`;
    const box = draftInput(dk, { area: true, initial: it.nudge ?? '' });
    return el(
      'div',
      { class: 'reply col' },
      box,
      el(
        'div',
        { class: 'actions' },
        btn('Send nudge', () => act(r, 'nudge', { agent, key: it.stuckKey, text: box.value }, { key: key('nudge'), done: `Nudge queued for ${it.agentName}` }).then((ok) => ok && drafts.delete(dk)), { primary: true, key: key('nudge') }),
        btn('Dismiss', () => act(r, 'dismiss-stuck', { agent, key: it.stuckKey }, { key: key('dismiss'), done: 'Dismissed' }), { key: key('dismiss'), cls: 'ghost' }),
      ),
    );
  }
  if (it.kind === 'conflict' && it.withId) {
    return el(
      'div',
      { class: 'actions' },
      btn(`Tell ${it.agentName}`, () => act(r, 'warn-conflict', { agent, with: it.withId }, { key: key('warn'), done: `Told ${it.agentName}` }), { key: key('warn') }),
      btn('Tell both', async () => {
        await act(r, 'warn-conflict', { agent, with: it.withId }, { key: key('warn'), done: 'Told both' });
        await act(r, 'warn-conflict', { agent: it.withId, with: agent }, { key: key('warn2'), done: 'Told both' });
      }, { key: key('warn') }),
    );
  }
  return null;
}

function agentActions(a, runner) {
  const r = runner.id;
  const key = (k) => `${r}:${a.id}:${k}`;
  const running = a.status === 'running';
  const tellKey = `tell:${a.runnerId}:${a.id}`;
  return el(
    'div',
    { class: 'actions' },
    btn('Message', () => (state.open.has(tellKey) ? state.open.delete(tellKey) : state.open.add(tellKey), render(true), document.querySelector(`[data-draft="${CSS.escape(`${tellKey}:text`)}"]`)?.focus()), { title: 'Type a message into its session (sent when it is idle; resumes it if closed)' }),
    running
      ? btn('Stop', () => act(r, 'stop', { agent: a.id }, { key: key('stop'), done: `Stopping ${a.name}; its session is kept` }), { key: key('stop'), cls: 'ghost' })
      : a.status !== 'preparing'
        ? btn('Start', () => act(r, 'start', { agent: a.id }, { key: key('start'), done: `Starting ${a.name}` }), { key: key('start') })
        : null,
  );
}

function tellForm(a) {
  const tellKey = `tell:${a.runnerId}:${a.id}`;
  const dk = `${tellKey}:text`;
  const box = draftInput(dk, { area: true, placeholder: `Message for ${a.name}…` });
  const send = async () => {
    if (!box.value.trim()) return;
    const ok = await act(a.runnerId, 'tell', { agent: a.id, text: box.value.trim() }, { key: `${a.runnerId}:${a.id}:tell`, done: `Queued for ${a.name}: typed in when it's idle` });
    if (ok) {
      drafts.delete(dk);
      state.open.delete(tellKey);
      render(true);
    }
  };
  box.addEventListener('keydown', (e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && (e.preventDefault(), send()));
  return el('form', { class: 'reply col', onsubmit: (e) => (e.preventDefault(), send()) }, box, el('div', { class: 'actions' }, el('button', { class: 'primary', disabled: busy.has(`${a.runnerId}:${a.id}:tell`) }, 'Send'), el('span', { class: 'muted small' }, '⌘⏎ to send')));
}

function termButton(runner, agentId, agentName) {
  if (!allows(runner, 'terminal')) return null;
  return btn('Terminal', () => openTerminal({ runnerId: runner.id, runnerName: runner.name, agentId, agentName, kind: 'claude' }), { title: 'Live terminal, through the hub' });
}

// ------------------------------------------------------------------ controls

for (const b of document.querySelectorAll('[role="tab"]')) {
  b.addEventListener('click', () => {
    state.tab = b.dataset.tab;
    try {
      localStorage.setItem('hub.tab', state.tab);
    } catch {}
    render();
  });
}
$('#search').addEventListener('input', (e) => {
  state.query = e.target.value.trim();
  render();
});
$('#filter-chip').addEventListener('click', () => {
  state.machine = null;
  render();
});

let expiryTimer = null;
$('#invite-btn').addEventListener('click', async () => {
  try {
    const inv = await call('POST', '/invites');
    $('#invite-cmd').textContent = inv.command;
    const tick = () => {
      const left = Math.max(0, Date.parse(inv.expiresAt) - Date.now());
      $('#invite-expiry').textContent = left ? `Works once, for ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')} more.` : 'Expired: close and click Add machine again.';
    };
    tick();
    clearInterval(expiryTimer);
    expiryTimer = setInterval(tick, 1000);
    $('#invite-dialog').showModal();
  } catch (err) {
    alertLine(err.message);
  }
});
$('#invite-dialog').addEventListener('close', () => clearInterval(expiryTimer));
$('#copy-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#invite-cmd').textContent);
    $('#copy-btn').textContent = 'Copied';
  } catch {
    getSelection().selectAllChildren($('#invite-cmd'));
    $('#copy-btn').textContent = 'Press ⌘C';
  }
  setTimeout(() => ($('#copy-btn').textContent = 'Copy'), 1500);
});

// ------------------------------------------------------------------ new agent

function creatable() {
  return (state.fleet?.runners ?? []).filter((r) => allows(r, 'create') && r.projects?.length);
}
function fillProjects() {
  const r = creatable().find((x) => x.id === $('#new-machine').value);
  const sel = $('#new-project');
  const prev = sel.value;
  sel.replaceChildren(...(r?.projects ?? []).map((p) => el('option', { value: p.shortcut }, p.name && p.name !== p.shortcut ? `${p.name} (@${p.shortcut})` : `@${p.shortcut}`)));
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  fillEngines('#new-engine-field', $('#new-engine'), enginesOf(r));
}
$('#new-btn').addEventListener('click', () => {
  const list = creatable();
  const sel = $('#new-machine');
  sel.replaceChildren(...list.map((r) => el('option', { value: r.id }, r.name)));
  if (state.machine && list.some((r) => r.id === state.machine)) sel.value = state.machine;
  fillProjects();
  $('#new-error').hidden = true;
  $('#new-dialog').showModal();
  $('#new-intent').focus();
});
$('#new-machine').addEventListener('change', fillProjects);
$('#new-cancel').addEventListener('click', () => $('#new-dialog').close());
$('#new-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const runnerId = $('#new-machine').value;
  const args = { project: $('#new-project').value, intent: $('#new-intent').value.trim(), priority: Number($('#new-priority').value) };
  if ($('#new-mode').value) args.permissionMode = $('#new-mode').value;
  if ($('#new-engine').value) args.engine = $('#new-engine').value;
  const submit = e.submitter ?? $('#new-form button.primary');
  submit.disabled = true;
  try {
    await call('POST', `/runners/${encodeURIComponent(runnerId)}/actions`, { action: 'create', args });
    $('#new-intent').value = '';
    $('#new-dialog').close();
    toast('Agent starting; it appears in a moment');
    state.tab = 'agents';
    render(true);
  } catch (err) {
    $('#new-error').textContent = err.message;
    $('#new-error').hidden = false;
  } finally {
    submit.disabled = false;
  }
});

// Relative times ("5m ago") stay current.
setInterval(() => state.fleet && !document.hidden && render(), 30_000);

boot();

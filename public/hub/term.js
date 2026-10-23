// A machine's agent terminal, relayed by the hub: browser <-> hub <-> machine.
import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/xterm-addon-fit/lib/addon-fit.mjs';
import { touchScroll } from '/touchscroll.js';

const $ = (sel) => document.querySelector(sel);
const KEYS = {
  esc: '\x1b', tab: '\t', stab: '\x1b[Z', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D',
  enter: '\r', ctrlc: '\x03', 1: '1', 2: '2', 3: '3', 4: '4',
};

let xterm = null;
let fit = null;
let ws = null;
let target = null; // { runnerId, runnerName, agentId, agentName, kind }
let retry = null;

function ensure() {
  if (xterm) return;
  xterm = new Terminal({
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: matchMedia('(max-width: 640px)').matches ? 11 : 13,
    scrollback: 10000,
    theme: { background: '#0f1117' },
    allowProposedApi: true,
  });
  fit = new FitAddon();
  xterm.loadAddon(fit);
  xterm.open($('#term'));
  xterm.onData((d) => send({ t: 'in', d }));
  xterm.onResize(({ cols, rows }) => send({ t: 'resize', cols, rows }));
  new ResizeObserver(() => refit()).observe($('#term'));
  touchScroll($('#term'), xterm);
}

const send = (m) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
function refit() {
  if (!target) return;
  try {
    fit.fit();
  } catch {}
}
function status(text, bad = false) {
  $('#term-status').textContent = text;
  $('#term-status').classList.toggle('bad', bad);
}

export function openTerminal(t) {
  closeTerminal();
  target = t;
  $('#term-title').textContent = `${t.runnerName}/${t.agentName}${t.kind === 'claude' ? '' : ` · ${t.kind}`}`;
  $('#term-overlay').hidden = false;
  document.body.classList.add('term-open');
  ensure();
  xterm.reset();
  refit();
  connect();
}

function connect() {
  clearTimeout(retry);
  const t = target;
  status('connecting…');
  const q = new URLSearchParams({ runner: t.runnerId, agent: t.agentId, kind: t.kind, cols: xterm.cols, rows: xterm.rows });
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/term?${q}`);
  ws = sock;
  let fatal = false;
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'term-hello') {
      xterm.reset();
      xterm.write(m.backlog ?? '');
      status(m.running ? 'live' : 'not running: Start it from the hub, or type to see its last screen', !m.running);
      send({ t: 'resize', cols: xterm.cols, rows: xterm.rows });
      if (!matchMedia('(pointer: coarse)').matches) xterm.focus();
    } else if (m.t === 'term-out') {
      xterm.write(m.d);
    } else if (m.t === 'term-msg') {
      if (m.msg?.t === 'exit') {
        if (target?.kind === 'claude') xterm.write(`\r\n\x1b[2m[claude exited with code ${m.msg.code}; session kept]\x1b[0m\r\n`);
        status(target?.kind === 'claude' ? 'not running: Start it from the hub' : 'shell exited', true);
      }
    } else if (m.t === 'term-error') {
      fatal = true;
      status(m.error, true);
    } else if (m.t === 'term-end') {
      fatal = true;
      status('terminal closed', true);
    }
  };
  sock.onclose = (e) => {
    if (ws !== sock || target !== t) return;
    ws = null;
    if (fatal || e.code === 1008) return;
    // Network blip, or this browser fell behind: reconnect for a fresh screen.
    status('reconnecting…', true);
    retry = setTimeout(connect, e.code === 1013 ? 200 : 2000);
  };
}

/** Keep the status line in step with the agent as the fleet view updates. */
export function syncTerminal(fleet) {
  if (!target || !ws || target.kind !== 'claude') return;
  const a = fleet.agents.find((x) => x.runnerId === target.runnerId && x.id === target.agentId);
  if (!a) return;
  if (!a.online) status('machine offline', true);
  else if (a.status === 'running') status(a.attention ? 'live · needs input' : 'live');
}

export const terminalTarget = () => target;

export function closeTerminal() {
  clearTimeout(retry);
  target = null;
  const sock = ws;
  ws = null;
  sock?.close();
  $('#term-overlay').hidden = true;
  document.body.classList.remove('term-open');
}

$('#term-close').addEventListener('click', closeTerminal);
document.addEventListener('keydown', (e) => {
  // Esc belongs to Claude while typing in the terminal; close with the button or Cmd+.
  if (target && e.key === '.' && (e.metaKey || e.ctrlKey)) closeTerminal();
});
$('#term-keys').addEventListener('click', (e) => {
  const key = e.target.closest('[data-key]')?.dataset.key;
  if (key) send({ t: 'in', d: KEYS[key] });
});
$('#term-keys').addEventListener('mousedown', (e) => e.preventDefault());
$('#term-compose').addEventListener('submit', (e) => {
  e.preventDefault();
  const box = $('#term-text');
  if (!box.value.trim()) return;
  send({ t: 'in', d: box.value });
  // Enter separately, so Claude reads the text as typed input and then submits it.
  setTimeout(() => send({ t: 'in', d: '\r' }), 150);
  box.value = '';
});
$('#term-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('#term-compose').requestSubmit();
  }
});

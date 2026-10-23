// This machine's link to a hub (see hub.js). The daemon connects out, proves who it is
// with the key it made when it joined, and pushes a whitelisted view of its agents and
// inbox whenever they change. What the hub may see or do is decided here, by the "hub"
// section of config.json, never by the hub (see hubactions.js for the permissions).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { paths } from './config.js';
import { challengePayload, checkHubUrl, fleetState, isTailscaleHost, projectRef, PROTOCOL } from './fleet.js';
import { ENGINES, installed } from './engines/index.js';
import { agentFor, runAction, terminalPermission } from './hubactions.js';

const LINK = () => path.join(paths.home, 'hub-link.json');
const AUDIT = () => path.join(paths.home, 'hub-audit.log');
const SEND_EVERY_MS = 2_000;
const PING_EVERY_MS = 15_000;
const MAX_CHANNELS = 16;
const MAX_RPCS = 8;
const BACKLOG_BYTES = 256 * 1024; // history sent when a hub terminal opens
// Flow control: a hub that can't keep up loses output, then gets a fresh screen once it drains.
const LAG_HIGH = 2 * 1024 * 1024;
const LAG_LOW = 256 * 1024;
export const DEFAULT_HUB_POLICY = { allow: ['view'], projects: ['*'] };

const now = () => new Date().toISOString();
const err = (status, message) => Object.assign(new Error(message), { status });

function readLink() {
  try {
    return JSON.parse(fs.readFileSync(LINK(), 'utf8'));
  } catch {
    return null;
  }
}

function writeLink(link) {
  const tmp = `${LINK()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(link, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, LINK());
}

export function audit(line) {
  try {
    fs.appendFileSync(AUDIT(), `${now()} ${line}\n`, { mode: 0o600 });
  } catch {}
}

export function hubPolicy(config) {
  const h = config.hub ?? {};
  return {
    allow: Array.isArray(h.allow) ? h.allow.map(String) : DEFAULT_HUB_POLICY.allow,
    projects: Array.isArray(h.projects) && h.projects.length ? h.projects.map(String) : DEFAULT_HUB_POLICY.projects,
  };
}

export class HubLink {
  /** urls(): this machine's UI addresses for "Open on <machine>" links (remote access). */
  constructor({ manager, config, version, urls = () => [], backlog = null }) {
    this.manager = manager;
    this.backlog = backlog;
    this.config = config;
    this.version = version;
    this.urls = urls;
    this.ws = null;
    this.connected = false;
    this.lastError = null;
    this.retry = 0;
    this.timers = {};
    this.lastSent = null;
    this.channels = new Map(); // hub terminal channel -> { agentId, kind, session, pending, timer, lagging }
    this.rpcs = 0;
    this.onChange = () => this.schedule();
    manager.on('change', this.onChange);
    manager.on('removed', this.onChange);
  }

  get link() {
    return readLink();
  }

  policy() {
    return hubPolicy(this.config);
  }

  status() {
    const l = this.link;
    if (!l) return { joined: false, policy: this.policy() };
    return {
      joined: true,
      url: l.url,
      name: l.name,
      runnerId: l.runnerId,
      hubName: l.hubName,
      joinedAt: l.joinedAt,
      connected: this.connected,
      lastError: this.lastError,
      policy: this.policy(),
    };
  }

  start() {
    if (this.link) this.connect();
  }

  /** Enroll with a one-time code from the hub; makes this machine's key pair. */
  async join(rawUrl, code, name) {
    const url = checkHubUrl(rawUrl);
    if (!String(code ?? '').trim()) throw err(400, 'Invite code is required');
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const res = await fetch(`${url}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        name: name || os.hostname().replace(/\.local$/i, ''),
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
        version: this.version,
      }),
    }).catch((e) => {
      throw err(502, `Cannot reach the hub at ${url}: ${e.cause?.message ?? e.message}`);
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.runnerId) throw err(res.status === 401 ? 401 : 502, body.error || `The hub refused to join (HTTP ${res.status})`);
    this.disconnect();
    writeLink({
      url,
      runnerId: body.runnerId,
      name: body.name,
      hubName: body.hubName,
      joinedAt: now(),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    });
    audit(`joined hub ${url} as ${body.name} (${body.runnerId}); policy ${JSON.stringify(this.policy())}`);
    this.retry = 0;
    this.connect();
    return this.status();
  }

  /** Leave the hub: it forgets this machine, and the key is deleted here. */
  async leave() {
    const l = this.link;
    if (!l) return this.status();
    if (this.connected) {
      this.ws.send(JSON.stringify({ t: 'leave' }));
      await new Promise((r) => setTimeout(r, 200));
    }
    this.disconnect();
    fs.rmSync(LINK(), { force: true });
    audit(`left hub ${l.url}`);
    this.lastError = null;
    return this.status();
  }

  connect() {
    const l = this.link;
    if (!l || this.ws) return;
    const wsUrl = `${l.url.replace(/^http/, 'ws')}/ws/runner`;
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 10_000, maxPayload: 1024 * 1024 });
    this.ws = ws;
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.t === 'challenge') {
        const sig = crypto.sign(null, challengePayload(String(msg.nonce), l.runnerId), l.privateKey).toString('base64');
        ws.send(
          JSON.stringify({
            t: 'hello',
            runnerId: l.runnerId,
            sig,
            protocol: PROTOCOL,
            version: this.version,
            platform: `${process.platform}-${process.arch}`,
            policy: this.policy(),
            urls: this.urls(),
          }),
        );
      } else if (msg.t === 'welcome') {
        this.connected = true;
        this.lastError = null;
        this.retry = 0;
        audit(`connected to hub ${l.url}`);
        this.lastSent = null;
        this.send(true);
        this.timers.ping = setInterval(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'ping' })), PING_EVERY_MS);
      } else if (!this.connected || msg.t === 'pong') {
        // nothing to do
      } else if (msg.t === 'rpc') {
        this.onRpc(ws, msg);
      } else if (typeof msg.t === 'string' && msg.t.startsWith('term-')) {
        this.onTerm(ws, msg);
      } else {
        audit(`refused "${String(msg.t).slice(0, 30)}" from hub: unknown message`);
      }
    });
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      const was = this.connected;
      this.cleanup();
      if (code === 4401 || code === 4403) {
        // The hub doesn't know this machine any more: stop retrying until it joins again.
        this.lastError = code === 4403 ? 'Removed from the hub; join again to reconnect' : 'The hub did not recognize this machine; join again';
        audit(`hub ${l.url} refused this machine (${code} ${reason})`);
        return;
      }
      if (was) audit(`disconnected from hub ${l.url} (${code})`);
      this.lastError ??= `Disconnected (${code}${reason?.length ? ` ${reason}` : ''})`;
      this.reconnectLater();
    });
    ws.on('error', (e) => {
      this.lastError = e.message;
    });
  }

  reconnectLater() {
    if (this.timers.retry || !this.link) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.retry++) * (0.7 + Math.random() * 0.6);
    this.timers.retry = setTimeout(() => {
      this.timers.retry = null;
      this.connect();
    }, delay);
  }

  // ------------------------------------------------------------- actions

  async onRpc(ws, msg) {
    const reply = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ t: 'rpc-result', id: msg.id, ...m }));
    const action = String(msg.action ?? '').slice(0, 40);
    const args = msg.args && typeof msg.args === 'object' && !Array.isArray(msg.args) ? msg.args : {};
    const where = args.agent ? ` on ${String(args.agent).slice(0, 40)}` : args.project ? ` in ${String(args.project).slice(0, 40)}` : '';
    if (this.rpcs >= MAX_RPCS) return reply({ ok: false, status: 429, error: 'Too many actions at once' });
    this.rpcs++;
    try {
      const result = await runAction(this.manager, this.policy(), action, args);
      audit(`hub did ${action}${where}`);
      reply({ ok: true, result });
      this.schedule();
    } catch (e) {
      audit(`hub ${e.status === 403 ? 'was refused' : 'failed'} ${action}${where}: ${e.message}`);
      reply({ ok: false, status: e.status || 500, error: e.message });
    } finally {
      this.rpcs--;
    }
  }

  // ------------------------------------------------------------- terminals

  onTerm(ws, msg) {
    const ch = Number(msg.ch);
    if (!Number.isInteger(ch) || ch < 0) return;
    const out = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ ...m, ch }));
    const c = this.channels.get(ch);
    if (msg.t === 'term-open') {
      if (c) return out({ t: 'term-error', error: 'Channel in use' });
      try {
        if (this.channels.size >= MAX_CHANNELS) throw Object.assign(new Error('Too many terminals open from the hub'), { status: 429 });
        const { kind, perm } = terminalPermission(msg.kind);
        const policy = this.policy();
        if (!policy.allow.includes(perm)) throw Object.assign(new Error(`This machine doesn't allow "${perm}" from the hub`), { status: 403 });
        const agent = agentFor(this.manager, policy, msg.agent);
        const chan = { agentId: agent.id, kind, session: null, pending: '', timer: null, lagging: false };
        this.channels.set(ch, chan);
        this.attachChannel(ws, ch, chan);
        if (msg.cols > 0 && msg.rows > 0) this.manager.resize(agent.id, msg.cols | 0, msg.rows | 0, kind);
        audit(`hub opened the ${kind} terminal of ${agent.id}`);
      } catch (e) {
        audit(`hub was refused a terminal on ${String(msg.agent).slice(0, 40)}: ${e.message}`);
        out({ t: 'term-error', error: e.message });
      }
      return;
    }
    if (!c) return;
    if (msg.t === 'term-in' && typeof msg.d === 'string') this.manager.write(c.agentId, msg.d.slice(0, 64 * 1024), c.kind);
    else if (msg.t === 'term-resize') this.manager.resize(c.agentId, msg.cols | 0, msg.rows | 0, c.kind);
    else if (msg.t === 'term-close') {
      this.closeChannel(ch);
      audit(`hub closed the ${c.kind} terminal of ${c.agentId}`);
    }
  }

  attachChannel(ws, ch, chan) {
    const out = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ ...m, ch }));
    const flush = () => {
      chan.timer = null;
      if (!chan.pending) return;
      const d = chan.pending;
      chan.pending = '';
      if (chan.lagging) return;
      if (ws.bufferedAmount > LAG_HIGH) {
        chan.lagging = true;
        // Once caught up, start over with the current screen instead of leaving a gap.
        chan.lagTimer = setInterval(() => {
          if (ws.readyState !== ws.OPEN) return clearInterval(chan.lagTimer);
          if (ws.bufferedAmount < LAG_LOW) {
            clearInterval(chan.lagTimer);
            this.reattach(ws, ch, chan);
          }
        }, 500);
        return;
      }
      out({ t: 'term-out', d });
    };
    const client = {
      send: (m) => {
        if (m.t === 'o') {
          chan.pending += m.d;
          chan.timer ??= setTimeout(flush, 30);
        } else {
          flush();
          out({ t: 'term-msg', msg: m });
        }
      },
      close: () => {
        this.closeChannel(ch);
        out({ t: 'term-end' });
      },
    };
    const n = chan.kind.startsWith('shell:') ? Number(chan.kind.slice(6)) : 0;
    chan.session = n ? this.manager.attachShell(chan.agentId, client, n) : this.manager.attach(chan.agentId, client);
    let backlog = chan.session.backlog ?? '';
    if (backlog.length > BACKLOG_BYTES) {
      // Start at a line boundary so the cut doesn't land inside an escape sequence.
      const cut = backlog.length - BACKLOG_BYTES;
      const nl = backlog.indexOf('\n', cut);
      backlog = backlog.slice(nl === -1 ? cut : nl + 1);
    }
    out({ t: 'term-hello', kind: chan.kind, running: chan.session.running, backlog });
  }

  reattach(ws, ch, chan) {
    chan.session?.detach();
    chan.lagging = false;
    chan.pending = '';
    this.attachChannel(ws, ch, chan);
  }

  closeChannel(ch) {
    const c = this.channels.get(ch);
    if (!c) return;
    clearTimeout(c.timer);
    clearInterval(c.lagTimer);
    c.session?.detach();
    this.channels.delete(ch);
  }

  cleanup() {
    for (const ch of [...this.channels.keys()]) this.closeChannel(ch);
    clearInterval(this.timers.ping);
    clearTimeout(this.timers.send);
    this.timers.ping = this.timers.send = null;
    this.ws = null;
    this.connected = false;
  }

  disconnect() {
    clearTimeout(this.timers.retry);
    this.timers.retry = null;
    const ws = this.ws;
    this.cleanup();
    ws?.removeAllListeners('close');
    ws?.on('error', () => {});
    ws?.close();
  }

  /** At most one state frame per SEND_EVERY_MS, and only when something changed. */
  schedule() {
    if (!this.connected || this.timers.send) return;
    this.timers.send = setTimeout(() => {
      this.timers.send = null;
      this.send();
    }, SEND_EVERY_MS);
  }

  state() {
    const policy = this.policy();
    if (!policy.allow.includes('view')) return { agents: [], inbox: [] };
    const create = policy.allow.includes('create');
    const projects = create ? this.manager.listProjects().map((p) => ({ ...p, warm: this.manager.projectWarm(p) })) : [];
    return fleetState(
      { agents: this.manager.list(), inbox: this.manager.inbox(), projects, capacity: create ? this.capacity() : null, labels: this.labels() },
      policy,
    );
  }

  /** Labels the hub's backlog can require: config "hub.labels" plus os and arch. */
  labels() {
    const os = { darwin: 'mac', linux: 'linux', win32: 'windows' }[process.platform] ?? process.platform;
    const engines = Object.values(ENGINES).filter((e) => installed(e, this.config)).map((e) => `engine:${e.id}`);
    return [`os:${os}`, `arch:${process.arch}`, ...engines, ...(Array.isArray(this.config.hub?.labels) ? this.config.hub.labels : [])];
  }

  /** Room for the hub's backlog: this machine's limits, minus its own backlog's active items. */
  capacity() {
    const busyBy = {};
    let busy = 0;
    for (const it of this.backlog?.items() ?? []) {
      if (it.status !== 'active') continue;
      busy++;
      const entry = Object.values(this.manager.store.data.projects ?? {}).find((p) => p.key === it.projectKey);
      const ref = projectRef(entry ?? { key: it.projectKey, name: it.projectName });
      busyBy[ref] = (busyBy[ref] ?? 0) + 1;
    }
    return {
      max: this.config.hub?.maxAgents ?? this.config.backlogMaxActive ?? 4,
      perProject: this.config.hub?.perProject ?? this.config.backlogParallel ?? 2,
      busy,
      busyBy,
    };
  }

  send(force = false) {
    if (!this.connected) return;
    const raw = JSON.stringify({ t: 'state', ...this.state() });
    if (!force && raw === this.lastSent) return;
    this.lastSent = raw;
    this.ws.send(raw);
  }

  stop() {
    this.manager.off('change', this.onChange);
    this.manager.off('removed', this.onChange);
    this.disconnect();
  }
}

/** UI addresses for the hub's links: remote-access URLs, Tailscale ones first. */
export function linkUrls(remoteUrls) {
  return remoteUrls
    .map((u) => ({ url: u.url, label: isTailscaleHost(u.address) ? 'tailscale' : u.iface, tailscale: isTailscaleHost(u.address), vpn: u.vpn }))
    .sort((a, b) => b.tailscale - a.tailscale || a.vpn - b.vpn)
    .map(({ vpn, ...u }) => u);
}

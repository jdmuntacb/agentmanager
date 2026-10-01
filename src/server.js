import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { ensureHome, HOST, loadConfig, paths, PORT } from './config.js';
import { AgentManager } from './manager.js';
import { Backlog } from './backlog.js';
import { Notifier, isWorkflowUrl, loadNotify, publicNotify, saveNotify, sendSlack } from './notify.js';
import * as remote from './remote.js';
import { Store } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const CLIENT_HEADER = 'x-agentmgr';

/**
 * The API drives real terminals, so callers are restricted.
 *
 * Local listener (127.0.0.1): Host must be loopback (blocks DNS rebinding), a
 * browser Origin must be this server (blocks cross-site WebSockets), and writes
 * need a custom header (browsers cannot send one cross-origin without a CORS
 * preflight we never grant).
 *
 * Remote listener (opt-in HTTPS on the LAN): the same, with this machine's own
 * addresses as the only valid Host, and a signed-in device session on every API
 * call except login. Managing remote access and shutting down stay local-only.
 */
function isLocalHost(host, port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);
}
function isAllowedOrigin(origin, port) {
  return !origin || [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin);
}

const PUBLIC_REMOTE_API = new Set(['POST /api/login', 'GET /api/session']);
const LOCAL_ONLY_API = /^\/api\/(remote(\/|$)|notify(\/|$)|shutdown$)/;

export async function startServer({ port = PORT, host = HOST } = {}) {
  ensureHome();
  const config = loadConfig();
  const store = new Store(paths.state);
  const manager = new AgentManager({ store, config });
  const backlog = new Backlog({ manager, store, config });
  // Alerts link to the phone address when remote access is on, else the local UI.
  const notifier = new Notifier({
    manager,
    backlog,
    linkFor: (id) => {
      const phone = remoteServer ? remote.remoteUrls(remotePort).find((u) => !u.vpn) : null;
      return `${phone ? phone.url : `http://127.0.0.1:${port}/`}#${id}/term`;
    },
  });
  let remoteServer = null;
  let remotePort = null;

  /** Returns an error string if the request may not proceed, else null. Sets req.device for remote sessions. */
  function denied(req) {
    const host = (req.headers.host ?? '').toLowerCase();
    const origin = req.headers.origin;
    if (!req.remote) {
      if (!isLocalHost(host, port) || !isAllowedOrigin(origin, port)) return 'Forbidden';
      return null;
    }
    if (!remote.allowedRemoteHosts(remotePort).has(host)) return 'Unknown host';
    if (origin && origin !== `https://${host}`) return 'Forbidden origin';
    const pathname = req.url.split('?')[0];
    const isApi = pathname.startsWith('/api/') || pathname.startsWith('/ws/');
    if (!isApi) return null; // page, scripts and styles: no secrets
    if (LOCAL_ONLY_API.test(pathname)) return 'Only available on this computer';
    if (PUBLIC_REMOTE_API.has(`${req.method} ${pathname}`)) return null;
    const cookie = remote.parseCookies(req.headers.cookie)[remote.SESSION_COOKIE];
    req.device = remote.checkSession(cookie);
    return req.device ? null : 'Sign in required';
  }

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const why = denied(req);
    if (why) return res.status(why === 'Sign in required' ? 401 : 403).json({ error: why });
    if (!['GET', 'HEAD'].includes(req.method) && req.headers[CLIENT_HEADER] !== '1') {
      return res.status(403).json({ error: `Missing ${CLIENT_HEADER} header` });
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  // Package root, found from its entry point (not every package exports package.json).
  const pkgDir = (name) => {
    let dir = path.dirname(require.resolve(name));
    while (!fs.existsSync(path.join(dir, 'package.json')) || JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name !== name) {
      const up = path.dirname(dir);
      if (up === dir) throw new Error(`Cannot find package root for ${name}`);
      dir = up;
    }
    return dir;
  };
  app.use('/vendor/xterm', express.static(pkgDir('@xterm/xterm')));
  app.use('/vendor/xterm-addon-fit', express.static(pkgDir('@xterm/addon-fit')));
  app.use('/vendor/marked', express.static(path.join(pkgDir('marked'), 'lib')));
  app.use('/vendor/dompurify', express.static(path.join(pkgDir('dompurify'), 'dist')));
  app.use('/vendor/mermaid', express.static(path.join(pkgDir('mermaid'), 'dist')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const api = express.Router();
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  };
  const fail = (status, message) => Object.assign(new Error(message), { status });

  api.get('/health', wrap(() => ({ ok: true, pid: process.pid, home: paths.home, claudeBin: config.claudeBin })));
  api.get('/agents', wrap(() => manager.list()));
  api.post(
    '/agents',
    wrap((req) => {
      const { intents, intent, ...opts } = req.body ?? {};
      return manager.createMany(Array.isArray(intents) ? intents : [intent], opts);
    }),
  );
  api.post('/general', wrap((req) => manager.createGeneral(req.body ?? {})));
  api.get('/agents/:id/brief', wrap((req) => manager.briefFile(req.params.id)));
  // ?background=1 starts the work and returns at once (watch the agent's events for the result).
  const bg = (req) => req.query.background === '1' || req.body?.background === true;
  api.post('/agents/:id/explain', wrap((req) => (bg(req) ? manager.summarizeInBackground(req.params.id, ['explain']) : manager.explain(req.params.id))));
  api.post('/agents/:id/insights', wrap((req) => (bg(req) ? manager.summarizeInBackground(req.params.id, ['insights']) : manager.insights(req.params.id))));
  const DOC_LIST = ['analysis', 'design', 'flow', 'proposal'];
  api.post(
    '/agents/:id/docs/:kind',
    wrap((req) => {
      const kinds = req.params.kind === 'all' ? DOC_LIST : [req.params.kind];
      if (bg(req) || kinds.length > 1) return manager.summarizeInBackground(req.params.id, kinds);
      return manager.document(req.params.id, req.params.kind);
    }),
  );
  api.post('/agents/:id/plan', wrap((req) => manager.startPlanning(req.params.id)));
  api.post('/agents/:id/handoff', wrap((req) => manager.maybeHandoff(manager.mustGet(req.params.id).id, { force: true })));
  api.post('/agents/:id/shell/close', wrap((req) => manager.closeShell(req.params.id)));
  api.get(
    '/agents/:id',
    wrap((req) => {
      const agent = manager.get(req.params.id);
      if (!agent) throw fail(404, `No agent matches "${req.params.id}"`);
      return agent;
    }),
  );
  api.patch('/agents/:id', wrap((req) => manager.update(req.params.id, req.body ?? {})));
  api.delete(
    '/agents/:id',
    wrap((req) => manager.remove(req.params.id, { deleteWorkspace: req.query.deleteWorkspace === '1' })),
  );
  api.post('/agents/:id/start', wrap((req) => manager.start(req.params.id, req.body ?? {})));
  api.post('/agents/:id/stop', wrap((req) => manager.stop(req.params.id)));
  api.post('/agents/:id/refresh', wrap((req) => manager.refresh(req.params.id, { withPrs: true })));
  api.post('/agents/:id/links', wrap((req) => manager.addLink(req.params.id, req.body ?? {})));
  api.delete('/agents/:id/links', wrap((req) => manager.removeLink(req.params.id, req.query)));
  api.post('/flush', wrap(() => manager.flush()));

  // ---------------------------------------------------------- Slack alerts (local only)
  const okUrl = (u) => /^https:\/\/[\w.-]+\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u);
  api.get('/notify', wrap(() => ({ ...publicNotify(), workflow: isWorkflowUrl(loadNotify().slack.webhookUrl), recent: notifier.log })));
  api.post(
    '/notify',
    wrap((req) => {
      const b = req.body ?? {};
      const slack = {};
      if (b.webhookUrl !== undefined) {
        if (b.webhookUrl && !okUrl(b.webhookUrl)) throw fail(400, 'The webhook URL must be https://…');
        slack.webhookUrl = b.webhookUrl || null;
      }
      if (b.botToken !== undefined) slack.botToken = b.botToken || null;
      if (b.channel !== undefined) slack.channel = b.channel || null;
      const patch = { slack };
      for (const k of ['enabled', 'skipWhenWatching', 'includeIntent']) if (typeof b[k] === 'boolean') patch[k] = b[k];
      for (const k of ['needsInputDelaySec', 'waitingDelaySec']) if (Number(b[k]) >= 0) patch[k] = Number(b[k]);
      if (b.events && typeof b.events === 'object') patch.events = b.events;
      const next = saveNotify(patch);
      // Configuring Slack for the first time turns alerts on.
      if (b.enabled === undefined && (slack.webhookUrl || (slack.botToken && (b.channel ?? next.slack.channel)))) saveNotify({ enabled: true });
      return { ...publicNotify(), recent: notifier.log };
    }),
  );
  api.post(
    '/notify/test',
    wrap(async () => {
      await sendSlack(':wave: Test from Agent Manager: alerts will arrive here when an agent needs you.', loadNotify());
      return { ok: true };
    }),
  );

  // ---------------------------------------------------------- backlog
  api.get('/backlog', wrap(() => backlog.view()));
  api.post(
    '/backlog',
    wrap((req) => {
      const { items, item, ...opts } = req.body ?? {};
      return backlog.add(Array.isArray(items) ? items : [item], opts);
    }),
  );
  api.post('/backlog/settings', wrap((req) => backlog.settings(req.body ?? {})));
  api.patch('/backlog/:id', wrap((req) => backlog.update(req.params.id, req.body ?? {})));
  api.delete('/backlog/:id', wrap((req) => backlog.remove(req.params.id)));
  api.post('/backlog/:id/start', wrap((req) => backlog.start(req.params.id)));
  api.post('/backlog/:id/accept', wrap((req) => backlog.accept(req.params.id)));
  api.post('/backlog/:id/reopen', wrap((req) => backlog.reopen(req.params.id, req.body ?? {})));
  api.post('/backlog/:id/cancel', wrap((req) => backlog.cancel(req.params.id)));
  api.post('/backlog/:id/move', wrap((req) => backlog.move(req.params.id, req.body?.where)));
  api.post(
    '/shutdown',
    wrap(() => {
      setTimeout(() => shutdown('api'), 50);
      return { ok: true };
    }),
  );

  // ---------------------------------------------------------- sessions (remote sign-in)

  api.get('/session', wrap((req) => ({ remote: Boolean(req.remote), authenticated: !req.remote || Boolean(
    remote.checkSession(remote.parseCookies(req.headers.cookie)[remote.SESSION_COOKIE]),
  ) })));
  api.post(
    '/login',
    wrap((req, res) => {
      if (!req.remote) return { ok: true };
      const ip = req.socket.remoteAddress;
      if (!remote.loginAllowed(ip)) throw fail(429, 'Too many attempts; try again in 15 minutes');
      if (!remote.checkToken(req.body?.token)) {
        remote.loginFailed(ip);
        throw fail(401, 'Wrong or expired access token');
      }
      const { secret, maxAgeSec } = remote.createSession({ ua: req.headers['user-agent'], ip });
      res.setHeader(
        'Set-Cookie',
        `${remote.SESSION_COOKIE}=${secret}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Strict`,
      );
      return { ok: true };
    }),
  );
  api.post(
    '/logout',
    wrap((req, res) => {
      remote.endSession(remote.parseCookies(req.headers.cookie)[remote.SESSION_COOKIE]);
      res.setHeader('Set-Cookie', `${remote.SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
      return { ok: true };
    }),
  );

  // ---------------------------------------------------------- remote access management (local only)

  const remoteStatus = async () => {
    const settings = remote.loadSettings();
    const urls = remote.remoteUrls(settings.port);
    return {
      ...settings,
      running: Boolean(remoteServer),
      fingerprint: remote.certificateFingerprint(),
      hostname: remote.localHostname(),
      urls: await Promise.all(
        urls.map(async (u) => ({ ...u, loginUrl: remote.loginLink(u.url), qr: await remote.qrSvg(remote.loginLink(u.url)) })),
      ),
      devices: remote.listSessions(),
    };
  };
  api.get('/remote', wrap(remoteStatus));
  api.post(
    '/remote/enable',
    wrap(async (req) => {
      const p = Number(req.body?.port) || remote.loadSettings().port;
      remote.saveSettings({ enabled: true, port: p });
      await startRemote();
      return remoteStatus();
    }),
  );
  api.post(
    '/remote/disable',
    wrap(async () => {
      remote.saveSettings({ enabled: false });
      await stopRemote();
      return remoteStatus();
    }),
  );
  api.post(
    '/remote/rotate',
    wrap(() => {
      remote.rotateToken();
      return remoteStatus();
    }),
  );
  api.delete(
    '/remote/devices/:id',
    wrap((req) => {
      remote.revokeSession(req.params.id);
      return remoteStatus();
    }),
  );

  // ---------------------------------------------------------- streaming over plain HTTP (SSE)
  // iOS Safari applies an accepted self-signed certificate to pages and fetches but not to
  // WebSockets, so the phone UI streams with Server-Sent Events and sends input with POSTs.

  const sse = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => clearInterval(ping));
    return (msg) => res.write(`data: ${JSON.stringify(msg)}\n\n`);
  };

  const eventSinks = new Set();
  api.get('/events/stream', (req, res) => {
    const send = sse(req, res);
    send({ t: 'snapshot', agents: manager.list(), backlog: backlog.view() });
    eventSinks.add(send);
    req.on('close', () => eventSinks.delete(send));
  });

  const termKind = (q) => (q === 'shell' ? 'shell' : 'claude');
  api.get('/agents/:id/term/stream', (req, res) => {
    let agent;
    try {
      agent = manager.mustGet(req.params.id);
    } catch (err) {
      return res.status(404).json({ error: err.message });
    }
    const kind = termKind(req.query.kind);
    const send = sse(req, res);
    // Batch output so a busy terminal is a few events per second, not one per chunk.
    let pending = '';
    let timer = null;
    const flush = () => {
      timer = null;
      if (pending) send({ t: 'o', d: pending });
      pending = '';
    };
    const client = {
      send: (msg) => {
        if (msg.t === 'o') {
          pending += msg.d;
          timer ??= setTimeout(flush, 30);
        } else {
          flush();
          send(msg);
        }
      },
      close: () => res.end(),
    };
    let session;
    try {
      session = kind === 'shell' ? manager.attachShell(agent.id, client) : manager.attach(agent.id, client);
    } catch (err) {
      send({ t: 'error', error: err.message });
      return res.end();
    }
    send({ t: 'hello', id: agent.id, kind, running: session.running, backlog: session.backlog });
    req.on('close', () => {
      clearTimeout(timer);
      session.detach();
    });
  });
  api.post(
    '/agents/:id/term/input',
    wrap((req) => {
      const agent = manager.mustGet(req.params.id);
      if (typeof req.body?.d !== 'string') throw fail(400, 'd (string) is required');
      manager.write(agent.id, req.body.d, termKind(req.body.kind));
      return { ok: true };
    }),
  );
  api.post(
    '/agents/:id/term/resize',
    wrap((req) => {
      const agent = manager.mustGet(req.params.id);
      manager.resize(agent.id, req.body?.cols | 0, req.body?.rows | 0, termKind(req.body?.kind));
      return { ok: true };
    }),
  );
  app.use('/api', api);

  // ---------------------------------------------------------- WebSockets (local UI and CLI)

  const wss = new WebSocketServer({ noServer: true });
  const onUpgrade = (isRemote) => (req, socket, head) => {
    req.remote = isRemote;
    if (denied(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };

  const eventClients = new Set();
  const broadcast = (msg) => {
    const raw = JSON.stringify(msg);
    for (const ws of eventClients) ws.send(raw);
    for (const send of eventSinks) send(msg);
  };
  manager.on('change', (agent) => broadcast({ t: 'agent', agent }));
  manager.on('removed', (id) => broadcast({ t: 'removed', id }));
  backlog.on('change', (view) => broadcast({ t: 'backlog', backlog: view }));

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/ws/events') {
      eventClients.add(ws);
      ws.send(JSON.stringify({ t: 'snapshot', agents: manager.list(), backlog: backlog.view() }));
      ws.on('close', () => eventClients.delete(ws));
      return;
    }

    const m = url.pathname.match(/^\/ws\/term\/([\w-]+)$/);
    if (!m) return ws.close(1008, 'unknown endpoint');
    let session;
    try {
      const agent = manager.mustGet(m[1]);
      const client = {
        send: (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg)),
        close: () => ws.close(1000, 'agent removed'),
      };
      const kind = termKind(url.searchParams.get('kind'));
      session = kind === 'shell' ? manager.attachShell(agent.id, client) : manager.attach(agent.id, client);
      client.send({ t: 'hello', id: agent.id, kind, running: session.running, backlog: session.backlog });
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.t === 'i' && typeof msg.d === 'string') manager.write(agent.id, msg.d, kind);
        else if (msg.t === 'r') manager.resize(agent.id, msg.cols | 0, msg.rows | 0, kind);
      });
      ws.on('close', () => session.detach());
    } catch (err) {
      ws.close(1008, err.message.slice(0, 120));
    }
  });

  // ---------------------------------------------------------- listeners

  const server = http.createServer(app);
  // Outlive clients' idle keep-alive sockets (Node fetch keeps them ~4s+): with the 5s
  // default, a request sent on a socket just as the server closes it fails with ECONNRESET.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.on('upgrade', onUpgrade(false));

  async function startRemote() {
    const settings = remote.loadSettings();
    if (remoteServer && remotePort === settings.port) return;
    await stopRemote();
    const { key, cert } = await remote.ensureCertificate();
    remote.accessToken(); // make sure one exists
    const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
      req.remote = true;
      app(req, res);
    });
    srv.keepAliveTimeout = 65_000;
    srv.headersTimeout = 66_000;
    srv.on('upgrade', onUpgrade(true));
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(settings.port, '0.0.0.0', resolve);
    });
    remoteServer = srv;
    remotePort = settings.port;
    console.log(`[agentmgr] remote access on ${remote.remoteUrls(settings.port).map((u) => u.url).join(', ')}`);
  }

  async function stopRemote() {
    if (!remoteServer) return;
    const srv = remoteServer;
    remoteServer = null;
    remotePort = null;
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(() => r()));
  }

  let closing = false;
  async function shutdown(reason) {
    if (closing) return;
    closing = true;
    console.log(`[agentmgr] shutting down (${reason}); closing agents so their sessions are saved`);
    await manager.stopAll();
    await manager.flush().catch((err) => console.error(`[agentmgr] final flush failed: ${err.message}`));
    try {
      if (fs.readFileSync(paths.pid, 'utf8').trim() === String(process.pid)) fs.unlinkSync(paths.pid);
    } catch {}
    await stopRemote();
    server.close();
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  fs.writeFileSync(paths.pid, String(process.pid));
  if (remote.loadSettings().enabled) {
    await startRemote().catch((err) => console.error(`[agentmgr] remote access not started: ${err.message}`));
  }
  if (config.autoResume) {
    manager.resumeAll().then((ids) => {
      if (ids.length) console.log(`[agentmgr] resumed ${ids.length} agent(s) from before the restart: ${ids.join(', ')}`);
    });
  }
  manager.refreshAll().catch(() => {});
  return {
    server,
    manager,
    backlog,
    url: `http://${host}:${port}`,
    startRemote,
    stopRemote,
    get remoteServer() {
      return remoteServer;
    },
  };
}

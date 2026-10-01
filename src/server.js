import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { ensureHome, HOST, loadConfig, paths, PORT } from './config.js';
import { AgentManager } from './manager.js';
import { Store } from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const CLIENT_HEADER = 'x-agentmgr';

/**
 * The API drives real terminals, so only same-machine, same-origin callers are
 * allowed: Host must be loopback (blocks DNS rebinding), browser Origin must be
 * this server (blocks cross-site WebSockets), and writes need a custom header
 * (browsers cannot send one cross-origin without a CORS preflight we never grant).
 */
function isLocalHost(host, port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);
}
function isAllowedOrigin(origin, port) {
  return !origin || [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin);
}

export async function startServer({ port = PORT, host = HOST } = {}) {
  ensureHome();
  const config = loadConfig();
  const store = new Store(paths.state);
  const manager = new AgentManager({ store, config });

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!isLocalHost(req.headers.host, port) || !isAllowedOrigin(req.headers.origin, port)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!['GET', 'HEAD'].includes(req.method) && req.headers[CLIENT_HEADER] !== '1') {
      return res.status(403).json({ error: `Missing ${CLIENT_HEADER} header` });
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
  app.use('/vendor/xterm', express.static(pkgDir('@xterm/xterm')));
  app.use('/vendor/xterm-addon-fit', express.static(pkgDir('@xterm/addon-fit')));
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const api = express.Router();
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  };

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
  api.post('/agents/:id/shell/close', wrap((req) => manager.closeShell(req.params.id)));
  api.get(
    '/agents/:id',
    wrap((req) => {
      const agent = manager.get(req.params.id);
      if (!agent) throw Object.assign(new Error(`No agent matches "${req.params.id}"`), { status: 404 });
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
  api.post(
    '/shutdown',
    wrap(() => {
      setTimeout(() => shutdown('api'), 50);
      return { ok: true };
    }),
  );
  app.use('/api', api);

  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!isLocalHost(req.headers.host, port) || !isAllowedOrigin(req.headers.origin, port)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  const eventClients = new Set();
  manager.on('change', (agent) => {
    const msg = JSON.stringify({ t: 'agent', agent });
    for (const ws of eventClients) ws.send(msg);
  });
  manager.on('removed', (id) => {
    const msg = JSON.stringify({ t: 'removed', id });
    for (const ws of eventClients) ws.send(msg);
  });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/ws/events') {
      eventClients.add(ws);
      ws.send(JSON.stringify({ t: 'snapshot', agents: manager.list() }));
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
      const kind = url.searchParams.get('kind') === 'shell' ? 'shell' : 'claude';
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

  let closing = false;
  async function shutdown(reason) {
    if (closing) return;
    closing = true;
    console.log(`[agentmgr] shutting down (${reason}); closing agents so their sessions are saved`);
    await manager.stopAll();
    try {
      if (fs.readFileSync(paths.pid, 'utf8').trim() === String(process.pid)) fs.unlinkSync(paths.pid);
    } catch {}
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
  if (config.autoResume) {
    manager.resumeAll().then((ids) => {
      if (ids.length) console.log(`[agentmgr] resumed ${ids.length} agent(s) from before the restart: ${ids.join(', ')}`);
    });
  }
  manager.refreshAll().catch(() => {});
  return { server, manager, url: `http://${host}:${port}` };
}

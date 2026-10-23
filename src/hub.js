// The hub: one place to see and drive every machine's agents. Runners (agentmgr daemons)
// connect out to it over a WebSocket and push a whitelisted view of their agents (see
// fleet.js). The hub never connects to a runner; it asks over that same socket (actions,
// terminal channels), and each runner checks its own policy before doing anything.
//
// Standalone on purpose (node built-ins, express, ws, and xterm for the browser): it runs
// on a Mac next to a daemon, on a tailnet box, or on Railway without node-pty or Claude.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { challengePayload, fleetState, fleetUrls, PROTOCOL } from './fleet.js';
import { HubBacklog } from './hubbacklog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const HUB_PORT = 4720;
export const HUB_HOME = process.env.AGENTMGR_HUB_HOME || path.join(process.env.AGENTMGR_HOME || path.join(os.homedir(), '.agentmanager'), 'hub');
export const hubStateFile = (home = HUB_HOME) => path.join(home, 'state.json');
const SESSION_COOKIE = 'agentmgr_hub';
const SESSION_DAYS = 30;
const INVITE_MINUTES = 10;
const OFFLINE_AFTER_MS = 45_000;
const HELLO_TIMEOUT_MS = 10_000;
const RPC_TIMEOUT_MS = 20_000;
const BROWSER_LAG_BYTES = 4 * 1024 * 1024;
// Which permission each action needs on the machine (it checks again; this is for the UI and errors).
export const ACTION_PERMS = {
  answer: 'inbox', 'prompt-key': 'inbox', nudge: 'inbox', 'dismiss-stuck': 'inbox', 'warn-conflict': 'inbox',
  tell: 'control', start: 'control', stop: 'control', checkpoint: 'control', priority: 'control', create: 'create',
  signin: 'signin',
};

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const secret = () => crypto.randomBytes(32).toString('base64url');
const now = () => new Date().toISOString();
const fail = (status, message) => Object.assign(new Error(message), { status });
const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(Buffer.from(sha256(a)), Buffer.from(sha256(b)));

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

/** Invite codes: 12 characters people can read aloud (no 0/O, 1/I/L), shown as XXXX-XXXX-XXXX. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  const bytes = crypto.randomBytes(12);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return chars.match(/.{4}/g).join('-');
}
const normalizeCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Google sign-in settings from the environment, or null when not configured. */
export function googleFromEnv(env = process.env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    emails: String(env.AGENTMGR_HUB_GOOGLE_EMAILS ?? '').split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean),
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
  };
}

/** Hub state on disk: admin token, browser sessions, pending invites, enrolled runners. */
class HubStore {
  constructor(home) {
    this.home = home;
    this.file = hubStateFile(home);
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Cannot read ${this.file}: ${err.message}`);
      this.data = {};
    }
    this.data = { sessions: {}, invites: {}, runners: {}, ...this.data };
  }

  save() {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

/**
 * Start the hub. token: admin token (default: AGENTMGR_HUB_TOKEN, else one generated and
 * kept in the hub's state file). trustProxy: behind Railway or another TLS proxy, so the
 * client address and https come from X-Forwarded-* headers.
 */
export async function startHub({
  port = HUB_PORT,
  host = '127.0.0.1',
  home = HUB_HOME,
  token = process.env.AGENTMGR_HUB_TOKEN || null,
  publicUrl = process.env.AGENTMGR_HUB_URL || null,
  name = process.env.AGENTMGR_HUB_NAME || os.hostname().replace(/\.local$/i, ''),
  trustProxy = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.AGENTMGR_HUB_TRUST_PROXY === '1'),
  google = googleFromEnv(),
  log = (m) => console.log(`[hub] ${m}`),
} = {}) {
  if (google && !google.emails.length) {
    log('Google sign-in is off: set AGENTMGR_HUB_GOOGLE_EMAILS to the accounts allowed in');
    google = null;
  }
  const store = new HubStore(home);
  let createdToken = false;
  if (!token) {
    if (!store.data.token) {
      store.data.token = secret();
      store.data.tokenCreatedAt = now();
      store.save();
      createdToken = true;
    }
    token = store.data.token;
  }
  const live = new Map(); // runnerId -> { ws, hello, state, connectedAt, lastSeen }
  const cached = new Map(); // runnerId -> last state from a runner now offline (memory only)

  // ------------------------------------------------------------- sign-in
  const failures = new Map();
  const loginAllowed = (ip) => {
    const recent = (failures.get(ip) ?? []).filter((t) => Date.now() - t < 15 * 60_000);
    failures.set(ip, recent);
    return recent.length < 10;
  };
  const loginFailed = (ip) => failures.set(ip, [...(failures.get(ip) ?? []), Date.now()]);

  const cookies = (header = '') =>
    Object.fromEntries(
      header.split(';').map((p) => p.trim().split('=')).filter(([k, v]) => k && v !== undefined).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]),
    );
  function sessionFor(req) {
    const s = cookies(req.headers.cookie)[SESSION_COOKIE];
    if (!s) return null;
    const sess = store.data.sessions[sha256(s)];
    if (!sess) return null;
    if (Date.now() - Date.parse(sess.lastSeen) > SESSION_DAYS * 86400_000) {
      delete store.data.sessions[sha256(s)];
      store.save();
      return null;
    }
    if (Date.now() - Date.parse(sess.lastSeen) > 60_000) {
      sess.lastSeen = now();
      store.save();
    }
    return sess;
  }
  /** A browser session: a 30-day cookie, stored hashed. */
  function newSession(req, res, { via, email = null }) {
    const s = secret();
    store.data.sessions[sha256(s)] = { id: crypto.randomBytes(4).toString('hex'), via, email, ua: String(req.headers['user-agent'] ?? '').slice(0, 200), ip: req.ip, createdAt: now(), lastSeen: now() };
    store.save();
    const cookie = `${SESSION_COOKIE}=${s}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Strict${req.secure ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', [cookie, ...[res.getHeader('Set-Cookie') ?? []].flat()]);
  }

  /** 'bearer' (CLI with the admin token), 'session' (signed-in browser) or null. */
  function authOf(req) {
    const m = (req.headers.authorization ?? '').match(/^Bearer\s+(\S+)$/i);
    if (m) return sameSecret(m[1], token) ? 'bearer' : null;
    return sessionFor(req) ? 'session' : null;
  }

  // ------------------------------------------------------------- fleet view
  function runnerView(id) {
    const r = store.data.runners[id];
    const l = live.get(id);
    const st = l?.state ?? cached.get(id) ?? { agents: [], inbox: [] };
    return {
      id,
      name: r.name,
      online: Boolean(l?.hello),
      enrolledAt: r.enrolledAt,
      connectedAt: l?.connectedAt ?? null,
      lastSeen: l?.lastSeen ? new Date(l.lastSeen).toISOString() : r.lastSeen ?? null,
      version: l?.hello?.version ?? r.version ?? null,
      platform: l?.hello?.platform ?? r.platform ?? null,
      policy: l?.hello?.policy ?? null,
      urls: l?.hello?.urls ?? r.urls ?? [],
      agents: st.agents.length,
      working: st.agents.filter((a) => a.working).length,
      needs: st.inbox.length,
      stale: !l?.hello && cached.has(id),
      projects: l?.hello ? st.projects ?? [] : [],
      labels: l?.hello ? st.labels ?? [] : [],
    };
  }
  function fleet() {
    const runners = Object.keys(store.data.runners).map(runnerView).sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
    const agents = [];
    const inbox = [];
    for (const r of runners) {
      const st = live.get(r.id)?.state ?? cached.get(r.id);
      if (!st) continue;
      for (const a of st.agents) agents.push({ ...a, runnerId: r.id, runnerName: r.name, online: r.online });
      for (const i of st.inbox) inbox.push({ ...i, runnerId: r.id, runnerName: r.name, online: r.online });
    }
    const order = { prompt: 0, question: 1, stuck: 2, conflict: 3 };
    inbox.sort((a, b) => b.online - a.online || order[a.kind] - order[b.kind] || a.priority - b.priority);
    return { hub: { name, version: version(), protocol: PROTOCOL }, runners, agents, inbox, backlog: backlog.view(), at: now() };
  }

  const sinks = new Set();
  let pushTimer = null;
  const changed = () => {
    pushTimer ??= setTimeout(() => {
      pushTimer = null;
      if (!sinks.size) return;
      const msg = `data: ${JSON.stringify({ t: 'fleet', fleet: fleet() })}\n\n`;
      for (const res of sinks) res.write(msg);
    }, 250);
  };

  // ------------------------------------------------------------- HTTP
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Runner-supplied text is rendered here; nothing but our own scripts may run.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public', 'hub')));
  const pkgDir = (name) => {
    let dir = path.dirname(require.resolve(name));
    while (!fs.existsSync(path.join(dir, 'package.json')) || JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name !== name) dir = path.dirname(dir);
    return dir;
  };
  app.use('/vendor/xterm', express.static(pkgDir('@xterm/xterm')));
  app.use('/vendor/xterm-addon-fit', express.static(pkgDir('@xterm/addon-fit')));
  app.get('/touchscroll.js', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'touchscroll.js')));

  const api = express.Router();
  const wrap = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  };
  const PUBLIC = new Set(['GET /health', 'GET /session', 'POST /login', 'POST /logout', 'POST /join', 'GET /auth/google', 'GET /auth/google/callback']);
  api.use((req, res, next) => {
    if (PUBLIC.has(`${req.method} ${req.path}`)) return next();
    req.auth = authOf(req);
    if (!req.auth) return res.status(401).json({ error: 'Sign in required' });
    // A browser can't add this header cross-site without a CORS preflight we never grant.
    if (req.auth === 'session' && !['GET', 'HEAD'].includes(req.method) && req.headers['x-agentmgr'] !== '1') {
      return res.status(403).json({ error: 'Missing x-agentmgr header' });
    }
    next();
  });

  api.get('/health', wrap(() => ({ ok: true, hub: true, version: version() })));
  api.get('/session', wrap((req) => ({ authenticated: Boolean(authOf(req)), name, google: Boolean(google) })));

  // ------------------------------------------------------------- Google sign-in (OpenID Connect)
  // Authorization code flow with PKCE, state and nonce. The ID token comes straight from
  // Google's token endpoint over TLS, so its claims are checked without fetching keys
  // (OpenID Connect Core 3.1.3.7). Only accounts listed in AGENTMGR_HUB_GOOGLE_EMAILS get in.
  const OAUTH_COOKIE = 'agentmgr_oauth';
  const callbackUrl = (req) => `${hubUrl(req)}/api/auth/google/callback`;
  const back = (res, error) => {
    // A same-site hop, so the SameSite=Strict session cookie is sent on the next load.
    const to = error ? `/#error=${encodeURIComponent(error)}` : '/';
    res.setHeader('Set-Cookie', [...[res.getHeader('Set-Cookie') ?? []].flat(), `${OAUTH_COOKIE}=; Path=/api/auth; Max-Age=0; HttpOnly; SameSite=Lax`]);
    res.type('html').send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${to}"><a href="${to}">Continue</a>`);
  };
  api.get('/auth/google', (req, res) => {
    if (!google) return res.status(404).json({ error: 'Google sign-in is not set up on this hub' });
    const flow = { state: secret(), nonce: secret(), verifier: secret() };
    const challenge = crypto.createHash('sha256').update(flow.verifier).digest('base64url');
    // Lax, not Strict: it must come back on Google's cross-site redirect to the callback.
    res.setHeader('Set-Cookie', `${OAUTH_COOKIE}=${Buffer.from(JSON.stringify(flow)).toString('base64url')}; Path=/api/auth; Max-Age=600; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`);
    const q = new URLSearchParams({
      client_id: google.clientId,
      redirect_uri: callbackUrl(req),
      response_type: 'code',
      scope: 'openid email',
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    res.redirect(302, `${google.authUrl}?${q}`);
  });
  api.get('/auth/google/callback', async (req, res) => {
    if (!google) return res.status(404).json({ error: 'Google sign-in is not set up on this hub' });
    if (!loginAllowed(req.ip)) return back(res, 'Too many attempts; try again in 15 minutes');
    let flow;
    try {
      flow = JSON.parse(Buffer.from(cookies(req.headers.cookie)[OAUTH_COOKIE] ?? '', 'base64url').toString('utf8'));
    } catch {}
    if (!flow?.state || !sameSecret(String(req.query.state ?? ''), flow.state)) return back(res, 'Sign-in expired or came from elsewhere; try again');
    if (req.query.error) return back(res, `Google: ${String(req.query.error).slice(0, 100)}`);
    try {
      const r = await fetch(google.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code: String(req.query.code ?? ''),
          client_id: google.clientId,
          client_secret: google.clientSecret,
          redirect_uri: callbackUrl(req),
          grant_type: 'authorization_code',
          code_verifier: flow.verifier,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || !body.id_token) throw new Error(body.error_description || body.error || `token endpoint said ${r.status}`);
      const claims = JSON.parse(Buffer.from(String(body.id_token).split('.')[1] ?? '', 'base64url').toString('utf8'));
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || !aud.includes(google.clientId)) throw new Error('ID token is not for this hub');
      if (!(claims.exp * 1000 > Date.now()) || claims.nonce !== flow.nonce) throw new Error('ID token expired or replayed');
      const email = String(claims.email ?? '').toLowerCase();
      if (!email || claims.email_verified !== true) throw new Error('Google did not confirm an email address');
      if (!google.emails.includes(email)) {
        loginFailed(req.ip);
        audit(`refused Google sign-in by ${email}`);
        return back(res, `${email} is not allowed on this hub`);
      }
      newSession(req, res, { via: 'google', email });
      audit(`Google sign-in by ${email}`);
      log(`signed in with Google: ${email}`);
      return back(res, null);
    } catch (e) {
      loginFailed(req.ip);
      return back(res, `Google sign-in failed: ${String(e.message).slice(0, 200)}`);
    }
  });
  api.post(
    '/login',
    wrap((req, res) => {
      if (!loginAllowed(req.ip)) throw fail(429, 'Too many attempts; try again in 15 minutes');
      if (!sameSecret(req.body?.token, token)) {
        loginFailed(req.ip);
        throw fail(401, 'Wrong access token');
      }
      newSession(req, res, { via: 'token' });
      return { ok: true };
    }),
  );
  api.post(
    '/logout',
    wrap((req, res) => {
      const s = cookies(req.headers.cookie)[SESSION_COOKIE];
      if (s && store.data.sessions[sha256(s)]) {
        delete store.data.sessions[sha256(s)];
        store.save();
      }
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`);
      return { ok: true };
    }),
  );

  api.get('/fleet', wrap(() => fleet()));
  api.get('/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`retry: 3000\n\ndata: ${JSON.stringify({ t: 'fleet', fleet: fleet() })}\n\n`);
    sinks.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      sinks.delete(res);
    });
  });

  const hubUrl = (req) => publicUrl || `${req.protocol}://${req.get('host')}`;
  api.post(
    '/invites',
    wrap((req) => {
      const code = newCode();
      const expiresAt = new Date(Date.now() + INVITE_MINUTES * 60_000).toISOString();
      for (const [k, v] of Object.entries(store.data.invites)) if (Date.parse(v.expiresAt) < Date.now()) delete store.data.invites[k];
      store.data.invites[sha256(normalizeCode(code))] = { createdAt: now(), expiresAt };
      store.save();
      const url = hubUrl(req);
      return { code, expiresAt, hubUrl: url, command: `agentmgr join ${url} ${code}` };
    }),
  );

  api.post(
    '/join',
    wrap((req) => {
      if (!loginAllowed(req.ip)) throw fail(429, 'Too many attempts; try again in 15 minutes');
      const key = sha256(normalizeCode(req.body?.code));
      const invite = store.data.invites[key];
      if (!invite || Date.parse(invite.expiresAt) < Date.now()) {
        loginFailed(req.ip);
        throw fail(401, 'Invite code is wrong, used or expired; create a new one on the hub');
      }
      let publicKey;
      try {
        const k = crypto.createPublicKey(String(req.body?.publicKey ?? ''));
        if (k.asymmetricKeyType !== 'ed25519') throw new Error();
        publicKey = k.export({ type: 'spki', format: 'pem' });
      } catch {
        throw fail(400, 'publicKey must be an Ed25519 public key (PEM)');
      }
      delete store.data.invites[key]; // single use
      const base = String(req.body?.name ?? '').toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'machine';
      const taken = new Set(Object.values(store.data.runners).map((r) => r.name));
      let runnerName = base;
      for (let i = 2; taken.has(runnerName); i++) runnerName = `${base}-${i}`;
      const id = crypto.randomBytes(4).toString('hex');
      store.data.runners[id] = { id, name: runnerName, publicKey, enrolledAt: now(), lastSeen: null, version: String(req.body?.version ?? '').slice(0, 20) || null };
      store.save();
      log(`runner ${runnerName} (${id}) joined from ${req.ip}`);
      changed();
      return { runnerId: id, name: runnerName, hubName: name };
    }),
  );

  const auditFile = path.join(home, 'audit.log');
  const audit = (line) => {
    try {
      fs.appendFileSync(auditFile, `${now()} ${line}\n`, { mode: 0o600 });
    } catch {}
  };

  /** Ask a machine to do something; resolves with its reply. */
  function rpc(runnerId, action, args) {
    const l = live.get(runnerId);
    if (!l?.hello) return Promise.reject(fail(409, 'That machine is offline'));
    const perm = ACTION_PERMS[action];
    if (!perm) return Promise.reject(fail(400, `Unknown action "${String(action).slice(0, 40)}"`));
    if (!l.hello.policy.allow.includes(perm)) return Promise.reject(fail(403, `${store.data.runners[runnerId]?.name} doesn't allow "${perm}" from the hub`));
    const id = ++l.nextRpc;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        l.rpcs.delete(id);
        reject(fail(504, 'The machine did not answer in time'));
      }, RPC_TIMEOUT_MS);
      l.rpcs.set(id, { resolve, reject, timer });
      l.ws.send(JSON.stringify({ t: 'rpc', id, action, args }));
    });
  }

  const backlog = new HubBacklog({
    store,
    runners: () =>
      Object.values(store.data.runners).map((r) => {
        const l = live.get(r.id);
        return { id: r.id, name: r.name, online: Boolean(l?.hello), policy: l?.hello?.policy ?? null, state: l?.state ?? null };
      }),
    rpc,
    changed: () => changed(),
    audit: (line) => audit(line),
    log,
  });

  api.post(
    '/backlog',
    wrap((req) => {
      const { items, item, ...opts } = req.body ?? {};
      const added = backlog.add(Array.isArray(items) ? items : [item], opts);
      audit(`${req.auth} queued ${added.map((x) => x.id).join(', ')} in ${added[0].projectName}`);
      return added;
    }),
  );
  api.post('/backlog/settings', wrap((req) => backlog.settings(req.body ?? {})));
  const ITEM_OPS = { start: (id) => backlog.start(id), accept: (id) => backlog.accept(id), cancel: (id) => backlog.cancel(id), requeue: (id) => backlog.requeue(id), reopen: (id, body) => backlog.reopen(id, body) };
  api.post(
    '/backlog/:id/:op',
    wrap(async (req) => {
      const op = Object.hasOwn(ITEM_OPS, req.params.op) ? ITEM_OPS[req.params.op] : null;
      if (!op) throw fail(404, `Unknown backlog operation "${String(req.params.op).slice(0, 20)}"`);
      const out = await op(req.params.id, req.body ?? {});
      audit(`${req.auth} did backlog ${req.params.op} on ${req.params.id}`);
      return out;
    }),
  );
  api.delete(
    '/backlog/:id',
    wrap((req) => {
      const out = backlog.remove(req.params.id);
      audit(`${req.auth} removed backlog item ${req.params.id}`);
      return out;
    }),
  );

  api.post(
    '/runners/:id/actions',
    wrap(async (req) => {
      const r = store.data.runners[req.params.id];
      if (!r) throw fail(404, `No machine ${req.params.id}`);
      const { action, args = {} } = req.body ?? {};
      const what = `${String(action).slice(0, 40)}${args.agent ? ` on ${r.name}/${String(args.agent).slice(0, 40)}` : ` on ${r.name}`}`;
      try {
        const out = await rpc(r.id, action, args);
        audit(`${req.auth} did ${what}`);
        log(`${what}: ok`);
        return out;
      } catch (e) {
        audit(`${req.auth} failed ${what}: ${e.message}`);
        throw e;
      }
    }),
  );

  api.delete(
    '/runners/:id',
    wrap((req) => {
      const r = store.data.runners[req.params.id] ?? Object.values(store.data.runners).find((x) => x.name === req.params.id);
      if (!r) throw fail(404, `No machine ${req.params.id}`);
      delete store.data.runners[r.id];
      store.save();
      const gone = live.get(r.id);
      if (gone) {
        endLive(gone, 'The machine was removed from the hub');
        gone.ws.close(4403, 'removed from the hub');
      }
      live.delete(r.id);
      cached.delete(r.id);
      log(`runner ${r.name} (${r.id}) removed`);
      changed();
      return { ok: true };
    }),
  );
  app.use('/api', api);

  // ------------------------------------------------------------- runners (WebSocket)
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    if (pathname === '/ws/runner') return wss.handleUpgrade(req, socket, head, (ws) => onRunner(ws, req));
    if (pathname === '/ws/term') {
      // Browsers only: a signed-in session, from a page on this hub (blocks cross-site WebSockets).
      const origin = req.headers.origin;
      const proto = trustProxy ? String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() : req.socket.encrypted ? 'https' : 'http';
      if (!sessionFor(req) || !origin || origin !== `${proto}://${req.headers.host}`) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      return browserWss.handleUpgrade(req, socket, head, (ws) => onBrowserTerm(ws, req));
    }
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  });

  // ------------------------------------------------------------- terminals (browser <-> hub <-> machine)
  const browserWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  function onBrowserTerm(ws, req) {
    const q = new URL(req.url, 'http://x').searchParams;
    const r = store.data.runners[q.get('runner')];
    const l = r && live.get(r.id);
    const send = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    if (!l?.hello) {
      send({ t: 'term-error', error: 'That machine is offline' });
      return ws.close(1011, 'offline');
    }
    const kind = String(q.get('kind') ?? 'claude').slice(0, 12);
    const perm = kind === 'claude' ? 'terminal' : 'shell';
    if (!l.hello.policy.allow.includes(perm)) {
      send({ t: 'term-error', error: `${r.name} doesn't allow "${perm}" from the hub. Add it to "hub.allow" in that machine's config.json.` });
      return ws.close(1008, 'not allowed');
    }
    const agent = String(q.get('agent') ?? '').slice(0, 40);
    const ch = ++l.nextCh;
    l.terms.set(ch, ws);
    audit(`session opened the ${kind} terminal of ${r.name}/${agent}`);
    l.ws.send(JSON.stringify({ t: 'term-open', ch, agent, kind, cols: Number(q.get('cols')) || 0, rows: Number(q.get('rows')) || 0 }));
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const cur = live.get(r.id);
      if (!cur || cur.terms.get(ch) !== ws) return;
      if (m.t === 'in' && typeof m.d === 'string') cur.ws.send(JSON.stringify({ t: 'term-in', ch, d: m.d.slice(0, 64 * 1024) }));
      else if (m.t === 'resize') cur.ws.send(JSON.stringify({ t: 'term-resize', ch, cols: m.cols | 0, rows: m.rows | 0 }));
    });
    ws.on('close', () => {
      const cur = live.get(r.id);
      if (cur?.terms.get(ch) === ws) {
        cur.terms.delete(ch);
        cur.ws.send(JSON.stringify({ t: 'term-close', ch }));
      }
    });
    ws.on('error', () => {});
  }

  /** Frames for a terminal channel, from the machine to the browser that opened it. */
  function relayTerm(l, msg) {
    const ws = l.terms.get(Number(msg.ch));
    if (!ws) return;
    if (ws.bufferedAmount > BROWSER_LAG_BYTES) {
      // This browser can't keep up; it reconnects and gets a fresh screen.
      l.terms.delete(Number(msg.ch));
      l.ws.send(JSON.stringify({ t: 'term-close', ch: Number(msg.ch) }));
      return ws.close(1013, 'too slow');
    }
    const { ch, ...rest } = msg;
    ws.send(JSON.stringify(rest));
    if (msg.t === 'term-error' || msg.t === 'term-end') {
      l.terms.delete(Number(ch));
      ws.close(1000, msg.t);
    }
  }

  /** A machine's connection ended: fail its pending actions and close its terminals. */
  function endLive(l, why) {
    for (const p of l.rpcs.values()) {
      clearTimeout(p.timer);
      p.reject(fail(409, why));
    }
    l.rpcs.clear();
    for (const ws of l.terms.values()) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'term-error', error: why }));
      ws.close(1011, 'machine disconnected');
    }
    l.terms.clear();
  }

  function onRunner(ws, req) {
    const nonce = crypto.randomBytes(24).toString('base64url');
    let runnerId = null;
    const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
    const helloTimer = setTimeout(() => ws.close(4408, 'hello timeout'), HELLO_TIMEOUT_MS);
    send({ t: 'challenge', nonce, protocol: PROTOCOL, hub: name });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!runnerId) {
        if (msg.t !== 'hello') return ws.close(4400, 'expected hello');
        const r = store.data.runners[msg.runnerId];
        let ok = false;
        try {
          ok = Boolean(r) && crypto.verify(null, challengePayload(nonce, msg.runnerId), r.publicKey, Buffer.from(String(msg.sig ?? ''), 'base64'));
        } catch {}
        if (!ok) {
          log(`refused a runner connection from ${req.socket.remoteAddress} (unknown machine or bad signature)`);
          return ws.close(4401, 'unknown machine or bad signature; join the hub again');
        }
        clearTimeout(helloTimer);
        runnerId = r.id;
        const old = live.get(runnerId);
        if (old) {
          endLive(old, 'The machine reconnected');
          old.ws.close(4409, 'replaced by a newer connection');
        }
        const policy = {
          allow: (Array.isArray(msg.policy?.allow) ? msg.policy.allow : []).map((x) => String(x).slice(0, 20)).slice(0, 10),
          projects: (Array.isArray(msg.policy?.projects) ? msg.policy.projects : ['*']).map((x) => String(x).slice(0, 60)).slice(0, 50),
        };
        const hello = {
          version: String(msg.version ?? '').slice(0, 20) || null,
          platform: String(msg.platform ?? '').slice(0, 40) || null,
          protocol: Number(msg.protocol) || null,
          urls: fleetUrls(msg.urls),
          policy,
        };
        live.set(runnerId, { ws, hello, state: cached.get(runnerId) ?? { agents: [], inbox: [] }, connectedAt: now(), lastSeen: Date.now(), rpcs: new Map(), nextRpc: 0, terms: new Map(), nextCh: 0 });
        Object.assign(r, { lastSeen: now(), version: hello.version, platform: hello.platform, urls: hello.urls });
        store.save();
        send({ t: 'welcome', runnerId, name: r.name, hub: name, protocol: PROTOCOL });
        log(`runner ${r.name} connected (agentmgr ${hello.version ?? '?'}, allows ${policy.allow.join(', ') || 'nothing'})`);
        return changed();
      }
      const l = live.get(runnerId);
      if (!l || l.ws !== ws) return;
      l.lastSeen = Date.now();
      if (msg.t === 'ping') return send({ t: 'pong' });
      if (msg.t === 'rpc-result') {
        const p = l.rpcs.get(msg.id);
        if (!p) return;
        l.rpcs.delete(msg.id);
        clearTimeout(p.timer);
        return msg.ok ? p.resolve(msg.result ?? { ok: true }) : p.reject(fail(Number(msg.status) || 500, String(msg.error ?? 'Failed').slice(0, 500)));
      }
      if (typeof msg.t === 'string' && msg.t.startsWith('term-')) return relayTerm(l, msg);
      if (msg.t === 'state') {
        // The runner applies its own policy (it knows its project shortcuts); the hub
        // re-trims the fields, and drops everything if the runner said it doesn't share views.
        l.state = l.hello.policy.allow.includes('view') ? fleetState(msg) : { agents: [], inbox: [] };
        backlog.onState(runnerId);
        return changed();
      }
      if (msg.t === 'leave') {
        const r = store.data.runners[runnerId];
        delete store.data.runners[runnerId];
        store.save();
        endLive(l, 'The machine left the hub');
        live.delete(runnerId);
        cached.delete(runnerId);
        log(`runner ${r?.name ?? runnerId} left the hub`);
        changed();
        return ws.close(1000, 'left');
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      const l = runnerId && live.get(runnerId);
      if (!l || l.ws !== ws) return;
      live.delete(runnerId);
      endLive(l, 'The machine disconnected');
      cached.set(runnerId, l.state);
      const r = store.data.runners[runnerId];
      if (r) {
        r.lastSeen = new Date(l.lastSeen).toISOString();
        store.save();
        log(`runner ${r.name} disconnected`);
      }
      changed();
    });
    ws.on('error', () => {});
  }

  // Runners ping every 15 s; one silent for longer than OFFLINE_AFTER_MS is dropped.
  const sweep = setInterval(() => {
    for (const l of live.values()) if (Date.now() - l.lastSeen > OFFLINE_AFTER_MS) l.ws.terminate();
  }, 5_000);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const url = `http://${shown}:${server.address().port}`;
  return {
    server,
    url,
    token,
    createdToken,
    store,
    fleet,
    backlog,
    async close() {
      backlog.stop();
      clearInterval(sweep);
      clearTimeout(pushTimer);
      for (const res of sinks) res.end();
      for (const l of live.values()) {
        endLive(l, 'The hub is shutting down');
        l.ws.terminate();
      }
      server.closeAllConnections?.();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

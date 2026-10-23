// Browser tabs: look at a page as this machine sees it (the agent's dev server on
// http://localhost:5173, a staging site on the VPN, any URL) from another device.
//
// On this computer the tab loads the URL directly. From another device each site gets its
// own HTTPS listener (same certificate and sign-in as remote access) that relays everything
// to it at the root path, so apps that use absolute paths, redirects and WebSockets (hot
// reload) keep working. This daemon's own ports are never relayed, and the Agent Manager
// session cookie is stripped before forwarding.
import http from 'node:http';
import https from 'node:https';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);
const MAX_LISTENERS = 20;
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'upgrade'];

export const isLoopback = (url) => LOOPBACK.has(url.hostname);

/**
 * "5173", "localhost:5173/app", "10.0.0.7:8080" or "example.com/docs" -> a normalized URL.
 * Without a scheme, local and numbered addresses and ones with a port get http, names https.
 */
export function parseUrl(input) {
  let s = String(input ?? '').trim();
  if (/^\d{1,5}$/.test(s)) s = `localhost:${s}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const host = s.split(/[/?#]/)[0];
    const plain = /^(localhost|0\.0\.0\.0|[\d.]+|\[[\da-f:]+\])(:\d+)?$/i.test(host) || /:\d+$/.test(host);
    s = `${plain ? 'http' : 'https'}://${s}`;
  }
  let url;
  try {
    url = new URL(s);
  } catch {
    throw Object.assign(new Error('Enter an address, like localhost:5173, 3000 or example.com'), { status: 400 });
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw Object.assign(new Error('Only http and https addresses can be opened'), { status: 400 });
  if (url.username || url.password) throw Object.assign(new Error("Addresses can't carry a user name or password"), { status: 400 });
  if (url.hostname === '0.0.0.0') url.hostname = 'localhost';
  return url;
}

const targetPort = (url) => Number(url.port || (url.protocol === 'https:' ? 443 : 80));

/** Local URLs mentioned in terminal output ("Local: http://localhost:5173/"), newest first. */
export function findLocalUrls(text) {
  const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
  const out = [];
  for (const m of plain.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}(?:\/[^\s'"<>)\]]*)?/g)) {
    try {
      const href = parseUrl(m[0].replace(/[.,;:]+$/, '')).href;
      const i = out.indexOf(href);
      if (i >= 0) out.splice(i, 1);
      out.push(href);
    } catch {}
  }
  return out.reverse().slice(0, 8);
}

export class Previews {
  /**
   * @param {object} o
   * @param {() => {key: Buffer, cert: Buffer}} o.tls
   * @param {(port: number) => Set<string>} o.allowedHosts  Host headers the listener answers to
   * @param {(cookieHeader: string) => boolean} o.signedIn
   * @param {string} o.cookieName  stripped before forwarding
   * @param {() => number[]} o.reserved  this daemon's own ports, never relayed
   * @param {() => Set<string>} o.ownHosts  this machine's own names and addresses (besides loopback)
   * @param {() => object} [o.savedPorts]  site -> relay port from before; a device accepts the
   *   self-signed certificate per port, so a site keeps its port across restarts
   * @param {(ports: object) => void} [o.savePorts]
   */
  constructor({ tls, allowedHosts, signedIn, cookieName, reserved, ownHosts = () => new Set(), savedPorts = () => ({}), savePorts = () => {} }) {
    Object.assign(this, { tls, allowedHosts, signedIn, cookieName, reserved, ownHosts, savedPorts, savePorts });
    this.listeners = new Map(); // "http://localhost:5173" -> { server, port, target }
    this.okCookies = new Map(); // cookie header -> checked until (ms)
  }

  /** The address another device uses for `input`, e.g. https://mini:53122/app. */
  async frameUrl(input, requestHost) {
    const url = parseUrl(input);
    const port = await this.listen(url);
    const host = String(requestHost ?? '').replace(/:\d+$/, '');
    return `https://${host}:${port}${url.pathname}${url.search}${url.hash}`;
  }

  async listen(url) {
    const tport = targetPort(url);
    const own = new Set([...this.reserved(), ...[...this.listeners.values()].map((l) => l.port)]);
    const self = isLoopback(url) || this.ownHosts().has(url.hostname.replace(/^\[|\]$/g, '').toLowerCase());
    if (self && own.has(tport)) throw Object.assign(new Error("That is Agent Manager's own port"), { status: 400 });
    const key = `${url.protocol}//${url.hostname}:${tport}`;
    const existing = this.listeners.get(key);
    if (existing) return existing.port;
    if (this.listeners.size >= MAX_LISTENERS) throw Object.assign(new Error(`At most ${MAX_LISTENERS} sites can be open at once`), { status: 400 });

    const target = { protocol: url.protocol, host: url.hostname.replace(/^\[|\]$/g, ''), port: tport, label: url.host, loopback: isLoopback(url) };
    const { key: k, cert } = this.tls();
    const server = https.createServer({ key: k, cert });
    const entry = { server, port: 0, target };
    server.on('request', (req, res) => this.relay(entry, req, res));
    server.on('upgrade', (req, socket, head) => this.relayUpgrade(entry, req, socket, head));
    server.on('clientError', (_err, socket) => socket.destroy());
    const listenOn = (p) =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, '0.0.0.0', () => {
          server.off('error', reject);
          resolve();
        });
      });
    const saved = this.savedPorts();
    const before = Number(saved[key]) || 0;
    try {
      if (!before || own.has(before)) throw new Error('no saved port');
      await listenOn(before);
    } catch {
      await listenOn(0); // taken by something else now: a new port (and one more certificate prompt)
    }
    entry.port = server.address().port;
    this.listeners.set(key, entry);
    if (entry.port !== before) this.savePorts({ ...saved, [key]: entry.port });
    return entry.port;
  }

  async stopAll() {
    const all = [...this.listeners.values()];
    this.listeners.clear();
    await Promise.all(
      all.map(({ server }) => {
        server.closeAllConnections?.();
        return new Promise((r) => server.close(() => r()));
      }),
    );
  }

  /** Why this request may not go through, or null. */
  refuse(entry, req) {
    const host = (req.headers.host ?? '').toLowerCase();
    if (!this.allowedHosts(entry.port).has(host)) return [403, 'Unknown host'];
    const cookies = req.headers.cookie ?? '';
    const until = this.okCookies.get(cookies);
    if (until && until > Date.now()) return null;
    if (!this.signedIn(cookies)) return [401, 'Sign in to Agent Manager on this machine first, then open this tab again.'];
    if (this.okCookies.size > 100) this.okCookies.clear();
    this.okCookies.set(cookies, Date.now() + 10_000);
    return null;
  }

  /** Request headers as the local server expects them: its own Host and Origin, no Agent Manager cookie. */
  forwardHeaders(entry, req, upgrade) {
    const { target } = entry;
    const self = `${target.protocol}//${target.label}`;
    const viewer = `https://${req.headers.host}`;
    const headers = { ...req.headers };
    for (const h of HOP) if (!(upgrade && (h === 'connection' || h === 'upgrade'))) delete headers[h];
    headers.host = target.label;
    if (headers.origin) headers.origin = self;
    if (headers.referer?.startsWith(viewer)) headers.referer = self + headers.referer.slice(viewer.length);
    const cookie = (headers.cookie ?? '')
      .split(';')
      .filter((c) => c.trim() && !c.trim().startsWith(`${this.cookieName}=`))
      .join(';');
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;
    return headers;
  }

  request(entry, req, upgrade) {
    const { target } = entry;
    const mod = target.protocol === 'https:' ? https : http;
    return mod.request({
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: this.forwardHeaders(entry, req, upgrade),
      autoSelectFamily: true, // "localhost" may be ::1 or 127.0.0.1, whichever the dev server took
      rejectUnauthorized: !target.loopback, // a local dev server may use its own self-signed certificate
    });
  }

  relay(entry, req, res) {
    const no = this.refuse(entry, req);
    if (no) return page(res, no[0], no[1]);
    const preq = this.request(entry, req, false);
    preq.on('response', (pres) => {
      res.writeHead(pres.statusCode, pres.statusMessage, this.responseHeaders(entry, req, pres.headers));
      pres.pipe(res);
    });
    preq.on('error', (err) => {
      if (res.headersSent) return res.destroy();
      page(res, 502, err.code === 'ECONNREFUSED' ? `Nothing is answering on ${entry.target.label} yet. Start the server, then reload.` : `Could not reach ${entry.target.label}: ${err.message}`);
    });
    req.pipe(preq);
  }

  /** Let the page load inside the tab and keep its redirects and cookies on this address. */
  responseHeaders(entry, req, headers) {
    const out = { ...headers };
    for (const h of HOP) delete out[h];
    delete out['x-frame-options'];
    if (out['content-security-policy']) {
      out['content-security-policy'] = String(out['content-security-policy'])
        .split(';')
        .filter((d) => !/^\s*frame-ancestors\b/i.test(d))
        .join(';');
    }
    const { target } = entry;
    if (out.location) {
      const selves = [`${target.protocol}//${target.label}`];
      if (target.loopback) selves.push(`${target.protocol}//localhost:${target.port}`, `${target.protocol}//127.0.0.1:${target.port}`);
      for (const self of selves) {
        if (out.location.startsWith(self)) out.location = `https://${req.headers.host}${out.location.slice(self.length)}`;
      }
    }
    if (out['set-cookie']) out['set-cookie'] = [].concat(out['set-cookie']).map((c) => c.replace(/;\s*domain=[^;]*/gi, ''));
    return out;
  }

  relayUpgrade(entry, req, socket, head) {
    socket.on('error', () => {});
    const no = this.refuse(entry, req);
    if (no) {
      socket.end(`HTTP/1.1 ${no[0]} ${http.STATUS_CODES[no[0]]}\r\nConnection: close\r\n\r\n`);
      return;
    }
    const preq = this.request(entry, req, true);
    preq.on('upgrade', (pres, psock, phead) => {
      psock.on('error', () => socket.destroy());
      const lines = [`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage}`];
      for (let i = 0; i < pres.rawHeaders.length; i += 2) lines.push(`${pres.rawHeaders[i]}: ${pres.rawHeaders[i + 1]}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
      if (phead?.length) socket.write(phead);
      if (head?.length) psock.write(head);
      psock.pipe(socket).pipe(psock);
      socket.on('close', () => psock.destroy());
    });
    preq.on('response', (pres) => {
      socket.end(`HTTP/1.1 ${pres.statusCode} ${pres.statusMessage}\r\nConnection: close\r\n\r\n`);
      pres.resume();
    });
    preq.on('error', () => socket.destroy());
    preq.end();
  }
}

function page(res, status, message) {
  const esc = message.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font:15px system-ui;color:#c9d1d9;background:#0f1117;padding:24px"><p>${esc}</p></body>`);
}

// Remote (phone) access: an opt-in HTTPS listener on the local network with
// token login. Everything here is local state under ~/.agentmanager/remote/.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
import { paths } from './config.js';

const DIR = path.join(paths.home, 'remote');
const STATE = path.join(DIR, 'state.json');
const KEY = path.join(DIR, 'key.pem');
const CERT = path.join(DIR, 'cert.pem');
export const SESSION_COOKIE = 'agentmgr_session';
const SESSION_DAYS = 30;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newSecret = () => crypto.randomBytes(32).toString('base64url');

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch {
    return { token: null, sessions: {} };
  }
}

function save(state) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const tmp = `${STATE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE);
}

// ------------------------------------------------------------- addresses

/**
 * IPv4 addresses a phone could use. VPN/tunnel interfaces (utun, ppp, ipsec) are
 * listed separately: a phone on the same Wi-Fi isn't on the corporate VPN.
 */
export function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      out.push({ iface: name, address: a.address, vpn: /^(utun|ppp|ipsec|tun|tap|gif|stf)/.test(name) });
    }
  }
  return out.sort((a, b) => a.vpn - b.vpn || a.iface.localeCompare(b.iface));
}

export function localHostname() {
  const h = os.hostname().replace(/\.local$/i, '');
  return `${h}.local`.toLowerCase();
}

/** Host headers the remote listener answers to: this machine's own addresses only (blocks DNS rebinding). */
export function allowedRemoteHosts(port) {
  const names = [...lanAddresses().map((a) => a.address), localHostname(), ...(loadSettings().extraHosts ?? [])];
  return new Set(names.map((n) => `${n.toLowerCase()}:${port}`));
}

// ------------------------------------------------------------- certificate

function openssl() {
  // Prefer the one macOS ships, so nothing needs installing.
  return fs.existsSync('/usr/bin/openssl') ? '/usr/bin/openssl' : 'openssl';
}

/** Self-signed certificate for the remote listener, created once with the system openssl. */
/**
 * A usable certificate names its curve (P-256). LibreSSL otherwise writes explicit curve
 * parameters, which Chrome, Safari and LibreSSL clients reject during the handshake.
 */
const P256_OID = Buffer.from('06082a8648ce3d030107', 'hex');

function certificateUsable() {
  try {
    const x = new crypto.X509Certificate(fs.readFileSync(CERT));
    // Node reports "prime256v1" even for explicit parameters, so look for the curve's OID
    // (1.2.840.10045.3.1.7) in the certificate itself.
    return x.raw.includes(P256_OID) && new Date(x.validTo) > new Date();
  } catch {
    return false;
  }
}

export async function ensureCertificate() {
  if (fs.existsSync(KEY) && fs.existsSync(CERT) && certificateUsable()) return { key: KEY, cert: CERT };
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const san = [
    ...new Set([...lanAddresses().map((a) => `IP:${a.address}`), 'IP:127.0.0.1', `DNS:${localHostname()}`]),
  ].join(',');
  await new Promise((resolve, reject) =>
    execFile(
      openssl(),
      [
        'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
        '-pkeyopt', 'ec_param_enc:named_curve', '-nodes',
        '-keyout', KEY, '-out', CERT, '-days', '397', '-subj', '/CN=agentmgr',
        '-addext', `subjectAltName=${san}`, '-addext', 'extendedKeyUsage=serverAuth',
      ],
      (err, _out, stderr) => (err ? reject(new Error(`openssl failed: ${stderr || err.message}`)) : resolve()),
    ),
  );
  fs.chmodSync(KEY, 0o600);
  return { key: KEY, cert: CERT };
}

export function certificateFingerprint() {
  try {
    const x = new crypto.X509Certificate(fs.readFileSync(CERT));
    return x.fingerprint256;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- settings, token, sessions

export function loadSettings() {
  const s = load();
  return { enabled: Boolean(s.enabled), port: s.port ?? 4718, extraHosts: s.extraHosts ?? [] };
}

export function saveSettings(patch) {
  const s = load();
  Object.assign(s, patch);
  save(s);
  return loadSettings();
}

/** The access token (created on first use). Kept like an SSH key: readable only by you. */
export function accessToken() {
  const s = load();
  if (!s.token) {
    s.token = newSecret();
    s.tokenCreatedAt = new Date().toISOString();
    save(s);
  }
  return s.token;
}

/** New token, and every signed-in device is signed out. */
export function rotateToken() {
  const s = load();
  s.token = newSecret();
  s.tokenCreatedAt = new Date().toISOString();
  s.sessions = {};
  save(s);
  return s.token;
}

export function checkToken(candidate) {
  const token = load().token;
  if (!token || typeof candidate !== 'string') return false;
  const a = Buffer.from(sha256(candidate));
  const b = Buffer.from(sha256(token));
  return crypto.timingSafeEqual(a, b);
}

export function createSession({ ua, ip }) {
  const s = load();
  const secret = newSecret();
  const id = crypto.randomBytes(4).toString('hex');
  s.sessions ??= {};
  s.sessions[sha256(secret)] = { id, ua: String(ua ?? '').slice(0, 200), ip, createdAt: new Date().toISOString(), lastSeen: new Date().toISOString() };
  save(s);
  return { secret, maxAgeSec: SESSION_DAYS * 86400 };
}

let lastSeenWrite = 0;
/** Validate a session cookie value; slides its expiry. */
export function checkSession(secret) {
  if (!secret) return null;
  const s = load();
  const key = sha256(secret);
  const sess = s.sessions?.[key];
  if (!sess) return null;
  const age = Date.now() - new Date(sess.lastSeen).getTime();
  if (age > SESSION_DAYS * 86400 * 1000) {
    delete s.sessions[key];
    save(s);
    return null;
  }
  if (Date.now() - lastSeenWrite > 60_000) {
    lastSeenWrite = Date.now();
    sess.lastSeen = new Date().toISOString();
    save(s);
  }
  return sess;
}

export function endSession(secret) {
  const s = load();
  delete s.sessions?.[sha256(secret ?? '')];
  save(s);
}

export function listSessions() {
  return Object.values(load().sessions ?? {}).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export function revokeSession(id) {
  const s = load();
  for (const [k, v] of Object.entries(s.sessions ?? {})) if (v.id === id) delete s.sessions[k];
  save(s);
}

// ------------------------------------------------------------- login throttling

const failures = new Map(); // ip -> [timestamps]
/** At most 10 failed logins per address per 15 minutes. */
export function loginAllowed(ip) {
  const recent = (failures.get(ip) ?? []).filter((t) => Date.now() - t < 15 * 60_000);
  failures.set(ip, recent);
  return recent.length < 10;
}
export function loginFailed(ip) {
  failures.set(ip, [...(failures.get(ip) ?? []), Date.now()]);
}

// ------------------------------------------------------------- links

export function remoteUrls(port) {
  return lanAddresses().map((a) => ({ ...a, url: `https://${a.address}:${port}/` }));
}

/** Sign-in link: the token rides in the #fragment, which browsers never send to servers or logs. */
export const loginLink = (url) => `${url}#login=${accessToken()}`;

export const qrSvg = (text) => QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
export const qrTerminal = (text) => QRCode.toString(text, { type: 'terminal', small: true });

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

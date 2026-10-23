// What a runner tells its hub: a small, whitelisted view of each agent and of what is
// waiting on the user. No transcripts, terminal output, file contents or local paths.
// The hub runs the same functions again on what it receives, so a misbehaving runner
// can't push arbitrary fields or huge strings into the fleet UI.

export const PROTOCOL = 1;
const MAX_AGENTS = 500;
const MAX_INBOX = 500;

const str = (v, n = 200) => (v == null ? null : String(v).slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const iso = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v.slice(0, 40) : null);
// Busy agents print constantly; to the minute is enough, and keeps unchanged states unsent.
const minute = (v) => (iso(v) ? new Date(Math.floor(Date.parse(v) / 60_000) * 60_000).toISOString() : null);
const httpUrl = (v) => (typeof v === 'string' && /^https?:\/\/[^\s"'<>]+$/i.test(v) ? v.slice(0, 500) : null);
const list = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);

/** One agent, from a manager view (runner side) or a received fleet agent (hub side). */
export function fleetAgent(a) {
  if (!a || typeof a !== 'object') return null;
  const rt = a.runtime ?? {};
  return {
    id: str(a.id, 40),
    name: str(a.name, 120),
    status: str(a.status, 20),
    kind: str(a.kind, 20),
    engine: str(a.engine ?? 'claude', 20),
    intent: str(a.intent, 600),
    project: str(a.projectInfo ? (a.projectInfo.key === 'other' ? null : a.projectInfo.name) : a.project, 60),
    repo: httpUrl(a.repo) ?? (typeof a.repo === 'string' && /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(a.repo) ? a.repo.slice(0, 300) : null),
    branch: str(a.git?.branch ?? a.branch, 200),
    priority: num(a.priority) ?? 2,
    working: Boolean(rt.busy ?? a.working),
    planning: Boolean(rt.planning ?? a.planning),
    attention: str(rt.attention ?? a.attention, 120),
    outcome: str(a.results?.outcome ?? a.outcome, 40),
    briefStatus: str(a.brief?.status ?? a.briefStatus, 40),
    briefAt: iso(a.brief?.updatedAt ?? a.briefAt),
    prs: list(a.prs, 20)
      .map((p) => ({ url: httpUrl(p?.url), number: num(p?.number), state: str(p?.state, 20), title: str(p?.title, 200) }))
      .filter((p) => p.url),
    costUsd: num(a.costUsd),
    tokens: num(a.usage?.io ?? a.tokens) ?? 0,
    questions: Array.isArray(a.questions) ? a.questions.filter((q) => !q.answer).length : num(a.questions) ?? 0,
    stuck: Array.isArray(a.stuck) ? a.stuck.length : num(a.stuck) ?? 0,
    conflicts: Array.isArray(a.conflicts) ? a.conflicts.length : num(a.conflicts) ?? 0,
    raceId: str(a.raceId, 20),
    error: str(a.error, 300),
    createdAt: iso(a.createdAt),
    updatedAt: iso(a.updatedAt),
    lastOutputAt: minute(rt.lastOutputAt ?? a.lastOutputAt),
  };
}

/** One inbox item (see AgentManager.inbox), trimmed to what the fleet inbox shows. */
export function fleetInboxItem(it) {
  if (!it || typeof it !== 'object' || !['prompt', 'question', 'stuck', 'conflict'].includes(it.kind)) return null;
  const out = {
    kind: it.kind,
    key: str(it.key, 200),
    agentId: str(it.agentId, 40),
    agentName: str(it.agentName, 120),
    project: str(it.project, 60),
    priority: num(it.priority) ?? 2,
    title: str(it.title, 500),
    at: iso(it.at),
  };
  if (it.kind === 'prompt') out.choices = list(it.prompt?.choices ?? it.choices, 9).map((c) => ({ key: str(c?.key, 4), label: str(c?.label, 120) }));
  if (it.kind === 'question') {
    const q = it.question ?? {};
    out.question = { id: str(q.id, 40), options: list(q.options, 10).map((o) => str(o, 200)), context: str(q.context, 500), default: str(q.default, 200) };
  }
  if (it.kind === 'stuck') {
    out.detail = str(it.finding?.detail ?? it.detail, 500);
    out.stuckKey = str(it.finding?.key ?? it.stuckKey, 100);
    out.nudge = str(it.finding?.nudge ?? it.nudge, 2000);
  }
  if (it.kind === 'conflict') {
    const c = it.conflict ?? {};
    out.with = str(c.agent?.name ?? it.with, 120);
    out.withId = str(c.agent?.id ?? it.withId, 40);
    out.mergeFirst = str(c.mergeFirst ?? it.mergeFirst, 40);
    out.files = list(c.files ?? it.files, 20).map((f) => str(typeof f === 'string' ? f : f?.file, 300));
  }
  return out;
}

/** Projects a runner shares with the hub: ["*"] for all, else project names or shortcuts ("cc"). */
export function allowedProject(projects, ...names) {
  const allow = Array.isArray(projects) && projects.length ? projects : ['*'];
  return allow.includes('*') || names.some((n) => n != null && allow.includes(n));
}

/** A whole runner state, as sent in a `state` frame. Inbox items follow their agent's project. */
export function fleetState({ agents = [], inbox = [], projects: registered = [], capacity = null, labels = [] } = {}, { projects } = {}) {
  const shared = list(agents, MAX_AGENTS).filter((a) => allowedProject(projects, a?.projectInfo?.name ?? a?.project, a?.projectInfo?.shortcut));
  const out = shared.map(fleetAgent).filter((a) => a?.id);
  const byId = new Map(out.map((a) => [a.id, a]));
  return {
    agents: out,
    inbox: list(inbox, MAX_INBOX)
      .map(fleetInboxItem)
      .filter((i) => i?.agentId && byId.has(i.agentId))
      .map((i) => ({ ...i, project: byId.get(i.agentId).project })),
    // Projects new agents can be started in (sent only when the machine allows "create").
    // ref names the project across machines (its repo, else its name); warm: already cloned here.
    projects: list(registered, 200)
      .filter((p) => p && allowedProject(projects, p.name, p.shortcut))
      .map((p) => ({ shortcut: str(p.shortcut, 16), name: str(p.name, 60), ref: projectRef(p), warm: p.warm !== false }))
      .filter((p) => p.shortcut),
    capacity: fleetCapacity(capacity),
    labels: list(labels, 20).map((l) => label(l)).filter(Boolean),
  };
}

/** A label for scheduling, like "os:mac", "gpu" or "fast-net". */
export const label = (v) => {
  const s = String(v ?? '').trim().toLowerCase().slice(0, 40);
  return /^[a-z0-9][\w.:-]*$/.test(s) ? s : null;
};

/**
 * How a project is known across machines: its repo ("github.com/org/repo"), so two clones
 * of one repo match, else "name:<name>". Never a local path.
 */
export function projectRef(p) {
  if (typeof p?.ref === 'string' && /^(repo|name):[^\s]{1,200}$/.test(p.ref)) return p.ref.toLowerCase().slice(0, 205);
  if (typeof p?.key === 'string' && p.key.startsWith('repo:') && !p.key.startsWith('repo:/')) return p.key.toLowerCase().slice(0, 205);
  return `name:${String(p?.name ?? '').toLowerCase().slice(0, 60)}`;
}

/** Room for scheduled work: limits in total and per project, and what is busy outside the hub. */
function fleetCapacity(c) {
  if (!c || typeof c !== 'object') return null;
  const n = (v, d) => Math.max(0, Math.min(50, Math.floor(num(v) ?? d)));
  const busyBy = {};
  for (const [k, v] of Object.entries(c.busyBy ?? {}).slice(0, 200)) busyBy[projectRef({ ref: k })] = n(v, 0);
  return { max: n(c.max, 4), perProject: n(c.perProject, 2), busy: n(c.busy, 0), busyBy };
}

/** The UI addresses a runner reports (its remote-access URLs), for "Open on <machine>". */
export function fleetUrls(urls) {
  return list(urls, 10)
    .map((u) => ({ url: httpUrl(u?.url), label: str(u?.label, 40), tailscale: Boolean(u?.tailscale) }))
    .filter((u) => u.url);
}

/** Tailscale (CGNAT 100.64.0.0/10) addresses and MagicDNS names. */
export function isTailscaleHost(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  if (h.endsWith('.ts.net')) return true;
  const m = h.match(/^100\.(\d+)\.\d+\.\d+$/);
  return Boolean(m && Number(m[1]) >= 64 && Number(m[1]) <= 127);
}

const isLoopback = (h) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(String(h).toLowerCase());

/**
 * Hub URLs a runner accepts: https anywhere; plain http only on this machine or over
 * Tailscale, which already encrypts the traffic.
 */
export function checkHubUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    throw Object.assign(new Error('Hub URL must look like https://hub.example.com'), { status: 400 });
  }
  if (u.protocol === 'https:' || (u.protocol === 'http:' && (isLoopback(u.hostname) || isTailscaleHost(u.hostname)))) {
    return u.origin;
  }
  throw Object.assign(new Error('Use https:// for the hub (plain http only for localhost or a Tailscale address)'), { status: 400 });
}

/** Signed by the runner's key on every connection, so the hub knows which runner it is. */
export const challengePayload = (nonce, runnerId) => Buffer.from(`agentmgr-hub-v${PROTOCOL}:${nonce}:${runnerId}`);

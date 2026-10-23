// What a hub may ask this machine to do, and the permission each needs. The list is fixed
// here (no generic API proxy), every call is checked against this machine's own policy,
// and agents are matched by exact ID only, within the projects the policy shares.
//
// Permissions (config.json "hub.allow"):
//   view      see agents and the inbox (phase 1)
//   inbox     answer questions, pick prompt choices, send stuck nudges, warn about overlaps
//   control   message, start, stop, checkpoint, change priority
//   create    start new agents in registered projects
//   terminal  live Claude terminals
//   shell     shells in an agent's folder (runs any command: grant with care)
//   signin    one-time sign-in links to this machine's own page (full access there: grant with care)
import { engineOf, installed } from './engines/index.js';
import { allowedProject } from './fleet.js';
import { createTicket } from './remote.js';

export const PERMISSIONS = ['view', 'inbox', 'control', 'create', 'terminal', 'shell', 'signin'];
// The hub may not start agents that skip permission prompts.
const HUB_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan']);

const err = (status, message) => Object.assign(new Error(message), { status });
const text = (v, n = 20_000) => {
  const s = String(v ?? '').trim();
  if (!s) throw err(400, 'Text is required');
  return s.slice(0, n);
};

/** The agent an action targets: exact ID, and in a project this machine shares. */
function agentFor(manager, policy, id) {
  const agent = manager.store.get(String(id ?? ''));
  if (!agent) throw err(404, 'No such agent on this machine');
  const info = manager.projectInfo(agent);
  if (!allowedProject(policy.projects, info.key === 'other' ? null : info.name, info.shortcut)) throw err(403, 'This machine does not share that project with the hub');
  return agent;
}

export const ACTIONS = {
  answer: { perm: 'inbox', run: (m, a, args) => m.answerQuestion(a.id, String(args.question ?? ''), text(args.text)) },
  'prompt-key': {
    perm: 'inbox',
    run: (m, a, args) => {
      const key = String(args.key ?? '');
      if (!/^(\d|esc)$/.test(key)) throw err(400, 'Key must be a digit or esc');
      return m.answerPrompt(a.id, key);
    },
  },
  nudge: { perm: 'inbox', run: (m, a, args) => m.nudge(a.id, String(args.key ?? ''), args.text ? text(args.text) : undefined) },
  'dismiss-stuck': { perm: 'inbox', run: (m, a, args) => m.dismissStuck(a.id, String(args.key ?? '')) },
  'warn-conflict': { perm: 'inbox', run: (m, a, args) => m.warnConflict(a.id, String(args.with ?? '')) },
  tell: { perm: 'control', run: (m, a, args) => m.tell(a.id, text(args.text)) },
  start: { perm: 'control', run: (m, a) => m.start(a.id) },
  stop: { perm: 'control', run: (m, a) => m.stop(a.id) },
  checkpoint: { perm: 'control', run: async (m, a) => (m.lastCheckpointTry?.delete(a.id), await m.checkpoint(a.id), m.get(a.id)) },
  priority: { perm: 'control', run: (m, a, args) => m.update(a.id, { priority: args.priority }) },
  create: { perm: 'create', agentless: true, run: (m, _a, args, policy) => createAgent(m, args, policy) },
  signin: { perm: 'signin', agentless: true, run: () => ({ ticket: createTicket() }) },
};

function createAgent(manager, args, policy) {
  const entry = manager.resolveProject(String(args.project ?? ''));
  if (!entry) throw err(400, 'Pick one of the projects this machine shares');
  if (!allowedProject(policy.projects, entry.name, entry.shortcut)) throw err(403, 'This machine does not share that project with the hub');
  let engine;
  if (args.engine) {
    engine = engineOf(String(args.engine)).id;
    if (!installed(engineOf(engine), manager.config)) throw err(400, `${engineOf(engine).label} isn't installed on this machine`);
  }
  const mode = args.permissionMode ?? undefined;
  if (mode !== undefined && !HUB_PERMISSION_MODES.has(mode)) throw err(400, `Permission mode must be one of ${[...HUB_PERMISSION_MODES].join(', ')} from the hub`);
  return manager.createMany([text(args.intent, 10_000)], {
    project: entry.shortcut,
    priority: args.priority,
    model: args.model ? String(args.model).slice(0, 60) : undefined,
    permissionMode: mode,
    engine,
  });
}

/** Run one hub action. Throws {status, message} on refusal; returns a small result. */
export async function runAction(manager, policy, action, args = {}) {
  const def = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
  if (!def) throw err(400, `Unknown action "${String(action).slice(0, 40)}"`);
  if (!policy.allow.includes(def.perm)) throw err(403, `This machine doesn't allow "${def.perm}" from the hub`);
  const agent = def.agentless ? null : agentFor(manager, policy, args.agent);
  const out = await def.run(manager, agent, args, policy);
  // Enough for the hub to confirm; the next state frame carries the rest.
  if (out?.ticket) return { ok: true, ticket: out.ticket };
  if (Array.isArray(out)) return { ok: true, agents: out.map((a) => ({ id: a.id, name: a.name })) };
  return { ok: true, agent: out?.id ? { id: out.id, name: out.name, status: out.status } : undefined };
}

/** Terminal kinds the hub may open: the Claude session, or shell N. */
export function terminalPermission(kind) {
  const k = String(kind ?? 'claude');
  if (k === 'claude') return { kind: 'claude', perm: 'terminal' };
  const m = k.match(/^shell(?::(\d{1,3}))?$/);
  if (m && Number(m[1] ?? 1) >= 1) return { kind: `shell:${Number(m[1] ?? 1)}`, perm: 'shell' };
  throw err(400, 'Unknown terminal');
}

export { agentFor };

// The hub's shared backlog: work queued once and started on whichever machine has room.
// Each item becomes one agent on one machine, created through that machine's own "create"
// action (so its policy and audit log apply), and then followed through the machine's
// state frames like the local backlog follows its agents.
//
// Placement, in order: hard constraints (online, allows "create", shares the project, has
// every required label), capacity (the machine's limits in total and per project), warm
// start (the repo is already cloned there), then spread (fewest running agents).
import crypto from 'node:crypto';
import { label } from './fleet.js';

const now = () => new Date().toISOString();
const fail = (status, message) => Object.assign(new Error(message), { status });
const OPEN = new Set(['queued', 'active', 'review', 'blocked']);
const MODES = new Set(['default', 'acceptEdits', 'plan']);
// An agent the machine hasn't reported this long after creating it is treated as removed.
const MISSING_GRACE_MS = 30_000;
// After a machine refuses an item, try it elsewhere first.
const REFUSED_COOLDOWN_MS = 60_000;

const priorityOf = (v, d = 2) => {
  const n = Number(String(v ?? '').replace(/^p/i, ''));
  return Number.isInteger(n) && n >= 0 && n <= 4 ? n : d;
};

/** Scheduling labels a machine has: what it reports, plus machine:<name>. */
export const runnerLabels = (r) => new Set([...(r.state?.labels ?? []), `machine:${r.name}`]);

/** Items the hub has started on a machine and that still hold one of its slots. */
const holding = (items, runnerId) => items.filter((x) => x.runnerId === runnerId && (x.status === 'active' || x.starting));

/**
 * Pick the machine for one item, or explain why none fits. runners: [{ id, name, online,
 * policy, state }], items: every hub backlog item (for capacity), cooldown(runnerId).
 */
export function pickRunner(item, runners, items, { cooldown = () => false, ignoreCapacity = false } = {}) {
  const reasons = [];
  const fits = [];
  for (const r of runners) {
    if (!r.online) continue;
    if (!r.policy?.allow?.includes('create')) {
      reasons.push(`${r.name} doesn't allow "create"`);
      continue;
    }
    const project = (r.state?.projects ?? []).find((p) => p.ref === item.project);
    if (!project) continue;
    const labels = runnerLabels(r);
    const missing = item.labels.filter((l) => !labels.has(l));
    if (missing.length) {
      reasons.push(`${r.name} lacks ${missing.join(', ')}`);
      continue;
    }
    if (item.avoid?.includes(r.id)) {
      reasons.push(`${r.name} is skipped for this item`);
      continue;
    }
    if (cooldown(r.id)) {
      reasons.push(`${r.name} refused it a moment ago`);
      continue;
    }
    const cap = r.state?.capacity ?? { max: 4, perProject: 2, busy: 0, busyBy: {} };
    const mine = holding(items, r.id);
    const total = cap.busy + mine.length;
    const inProject = (cap.busyBy?.[item.project] ?? 0) + mine.filter((x) => x.project === item.project).length;
    if (!ignoreCapacity && (total >= cap.max || inProject >= cap.perProject)) {
      reasons.push(`${r.name} is full (${total >= cap.max ? `${total}/${cap.max} in total` : `${inProject}/${cap.perProject} in this project`})`);
      continue;
    }
    const running = (r.state?.agents ?? []).filter((a) => a.status === 'running').length;
    fits.push({ runner: r, project, warm: project.warm !== false, load: total + running / 100 });
  }
  fits.sort((a, b) => b.warm - a.warm || a.load - b.load || a.runner.name.localeCompare(b.runner.name));
  if (fits.length) return { runner: fits[0].runner, shortcut: fits[0].project.shortcut, warm: fits[0].warm };
  return { runner: null, why: reasons.length ? reasons.join('; ') : 'No online machine shares this project' };
}

export class HubBacklog {
  /** runners(): live runner views; rpc(runnerId, action, args); changed(): push the fleet. */
  constructor({ store, runners, rpc, changed, audit = () => {}, log = () => {} }) {
    this.store = store;
    this.runners = runners;
    this.rpc = rpc;
    this.notify = changed;
    this.audit = audit;
    this.log = log;
    store.data.backlog ??= { items: {}, autoRun: true };
    this.data = store.data.backlog;
    for (const it of Object.values(this.data.items)) delete it.starting; // a start cut short by a restart
    this.refused = new Map(); // `${itemId}:${runnerId}` -> time
    this.waiting = new Map(); // itemId -> why it can't start yet (memory only)
    this.dispatching = false;
    this.timer = setInterval(() => this.dispatch().catch(() => {}), 3000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  changed() {
    this.store.save();
    this.notify();
  }

  items() {
    return Object.values(this.data.items).sort((a, b) => a.priority - b.priority || a.order - b.order || a.createdAt.localeCompare(b.createdAt));
  }

  get(id) {
    const it = this.data.items[id];
    if (!it) throw fail(404, `No backlog item "${id}"`);
    return it;
  }

  /** Projects any online machine can start agents in, grouped across machines. */
  projects() {
    const out = new Map();
    for (const r of this.runners()) {
      if (!r.online || !r.policy?.allow?.includes('create')) continue;
      for (const p of r.state?.projects ?? []) {
        const e = out.get(p.ref) ?? { ref: p.ref, name: p.name, machines: [] };
        e.machines.push({ runnerId: r.id, name: r.name, shortcut: p.shortcut, warm: p.warm !== false });
        out.set(p.ref, e);
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The project an item names: a ref, or a name or shortcut on any online machine. */
  resolveProject(ref) {
    const r = String(ref ?? '').trim().replace(/^@/, '').toLowerCase();
    if (!r) throw fail(400, 'Pick a project');
    const all = this.projects();
    const hit =
      all.find((p) => p.ref === r) ??
      all.find((p) => p.name.toLowerCase() === r) ??
      all.find((p) => p.machines.some((m) => m.shortcut === r));
    if (!hit) throw fail(400, `No online machine that allows "create" shares a project called "${ref}"`);
    return hit;
  }

  view() {
    const runners = new Map(this.runners().map((r) => [r.id, r]));
    const items = this.items().map((it) => {
      const r = it.runnerId ? runners.get(it.runnerId) : null;
      const a = r?.state?.agents?.find((x) => x.id === it.agentId);
      return {
        ...it,
        runnerName: r?.name ?? it.runnerName ?? null,
        // Its machine went away mid-item. Not re-run elsewhere on its own: the work in that
        // machine's worktree would be lost or duplicated. You choose: wait, or requeue.
        stalled: (it.status === 'active' || it.status === 'blocked') && !r?.online,
        waiting: it.status === 'queued' ? this.waiting.get(it.id) ?? null : null,
        agent: a ? { id: a.id, name: a.name, status: a.status, working: a.working, attention: a.attention, briefStatus: a.briefStatus } : null,
      };
    });
    return { autoRun: this.data.autoRun, projects: this.projects(), items };
  }

  // ------------------------------------------------------------ editing

  add(titles, { project, labels = [], priority = 2, permissionMode, model, engine } = {}) {
    const list = (Array.isArray(titles) ? titles : [titles]).map((t) => String(t ?? '').trim().slice(0, 10_000)).filter(Boolean).slice(0, 50);
    if (!list.length) throw fail(400, 'At least one item is required');
    const p = this.resolveProject(project);
    if (permissionMode && !MODES.has(permissionMode)) throw fail(400, `Permission mode must be one of ${[...MODES].join(', ')}`);
    const want = (Array.isArray(labels) ? labels : String(labels).split(',')).map(label).filter(Boolean).slice(0, 10);
    const eng = engine ? label(engine) : null;
    // An engine is a label like any other: only machines that have it installed qualify.
    if (eng) want.push(`engine:${eng}`);
    const order = Math.max(0, ...Object.values(this.data.items).map((i) => i.order ?? 0)) + 1;
    const added = list.map((title, i) => {
      const it = {
        id: crypto.randomBytes(3).toString('hex'),
        title,
        project: p.ref,
        projectName: p.name,
        labels: [...new Set(want)],
        priority: priorityOf(priority),
        permissionMode: permissionMode || null,
        model: model ? String(model).slice(0, 60) : null,
        engine: eng,
        status: 'queued',
        order: order + i,
        runnerId: null,
        runnerName: null,
        agentId: null,
        avoid: [],
        error: null,
        createdAt: now(),
        startedAt: null,
        activeSince: null,
        reviewAt: null,
        doneAt: null,
      };
      this.data.items[it.id] = it;
      return it;
    });
    this.changed();
    this.dispatch().catch(() => {});
    return added;
  }

  remove(id) {
    const it = this.get(id);
    if (it.status === 'active' && !this.view().items.find((x) => x.id === id)?.stalled) throw fail(409, 'Cancel the item first (its agent is working on it)');
    delete this.data.items[id];
    this.changed();
    return { id };
  }

  settings({ autoRun } = {}) {
    if (typeof autoRun === 'boolean') this.data.autoRun = autoRun;
    this.changed();
    this.dispatch().catch(() => {});
    return { autoRun: this.data.autoRun };
  }

  // ------------------------------------------------------------ lifecycle

  /** Start now: skips the queue and the capacity limits, not the machine's own rules. */
  async start(id) {
    const it = this.get(id);
    if (it.status !== 'queued') throw fail(409, `Item is ${it.status}`);
    const pick = pickRunner(it, this.runners(), this.items(), { ignoreCapacity: true });
    if (!pick.runner) throw fail(409, pick.why);
    await this.launch(it, pick);
    return it;
  }

  async launch(it, { runner, shortcut, warm }) {
    it.starting = true;
    try {
      const out = await this.rpc(runner.id, 'create', {
        project: shortcut,
        intent: it.title,
        priority: it.priority,
        permissionMode: it.permissionMode ?? undefined,
        model: it.model ?? undefined,
        engine: it.engine ?? undefined,
      });
      const agent = out?.agents?.[0];
      if (!agent?.id) throw fail(502, `${runner.name} did not report the new agent`);
      Object.assign(it, { status: 'active', runnerId: runner.id, runnerName: runner.name, agentId: agent.id, error: null, startedAt: now(), activeSince: now(), briefSeen: null });
      this.waiting.delete(it.id);
      this.audit(`backlog started ${it.id} on ${runner.name}/${agent.id}${warm ? '' : ' (cold: needs a clone)'}`);
      this.log(`backlog item ${it.id} started on ${runner.name} as ${agent.id}`);
    } catch (e) {
      if (e.status === 504) {
        // It may have started anyway; don't risk a second copy.
        Object.assign(it, { status: 'blocked', runnerId: runner.id, runnerName: runner.name, error: `${runner.name} did not answer in time; check it before requeueing` });
      } else {
        this.refused.set(`${it.id}:${runner.id}`, Date.now());
        it.error = `${runner.name}: ${e.message}`;
      }
      this.audit(`backlog could not start ${it.id} on ${runner.name}: ${e.message}`);
      throw e;
    } finally {
      delete it.starting;
      this.changed();
    }
  }

  accept(id) {
    const it = this.get(id);
    if (!['review', 'active', 'blocked'].includes(it.status)) throw fail(409, `Item is ${it.status}`);
    Object.assign(it, { status: 'done', doneAt: now() });
    this.changed();
    return it;
  }

  cancel(id) {
    const it = this.get(id);
    if (!OPEN.has(it.status)) throw fail(409, `Item is ${it.status}`);
    it.status = 'cancelled';
    this.changed();
    return it;
  }

  /** Back to the queue, for a stalled or blocked item. Its old machine is skipped next time. */
  requeue(id) {
    const it = this.get(id);
    if (!['active', 'blocked', 'review', 'cancelled'].includes(it.status)) throw fail(409, `Item is ${it.status}`);
    if (it.runnerId && !it.avoid.includes(it.runnerId)) it.avoid.push(it.runnerId);
    Object.assign(it, { status: 'queued', runnerId: null, agentId: null, briefSeen: null, error: null, startedAt: null, activeSince: null, reviewAt: null, doneAt: null });
    this.changed();
    this.dispatch().catch(() => {});
    return it;
  }

  /** Send it back to the same agent with a note (needs "control" on its machine). */
  async reopen(id, { note } = {}) {
    const it = this.get(id);
    if (!['review', 'done', 'blocked'].includes(it.status)) throw fail(409, `Item is ${it.status}`);
    if (!it.agentId || !it.runnerId) return this.requeue(id);
    const message = `Reopened from review${note ? `: ${String(note).slice(0, 4000)}` : '.'} Please continue until the task is complete, and set the brief's Status back to done when it is.`;
    // "tell" resumes a closed agent and types the note in once it is idle.
    await this.rpc(it.runnerId, 'tell', { agent: it.agentId, text: message });
    const a = this.runners().find((r) => r.id === it.runnerId)?.state?.agents?.find((x) => x.id === it.agentId);
    Object.assign(it, { status: 'active', reviewAt: null, doneAt: null, activeSince: now(), briefSeen: a?.briefAt ?? null });
    this.changed();
    return it;
  }

  // ------------------------------------------------------------ automation

  /** A machine sent new state: move its items along, like the local backlog does. */
  onState(runnerId) {
    const r = this.runners().find((x) => x.id === runnerId);
    if (!r?.online) return;
    let dirty = false;
    for (const it of Object.values(this.data.items)) {
      if (it.runnerId !== runnerId || !it.agentId || !['active', 'blocked'].includes(it.status)) continue;
      const a = r.state?.agents?.find((x) => x.id === it.agentId);
      let next = it.status;
      if (!a) {
        if (Date.now() - Date.parse(it.startedAt ?? it.activeSince ?? 0) > MISSING_GRACE_MS) {
          next = 'cancelled';
          it.error = `The agent is gone from ${r.name} (removed, or no longer shared)`;
        }
      } else if (it.status === 'active') {
        if (a.status === 'error') next = 'blocked';
        // A brief marked done since the item (re)started. Compared with the brief time seen
        // then, not the hub's clock, so clock skew between machines doesn't matter.
        else if (a.briefStatus === 'done' && a.briefAt && a.briefAt !== (it.briefSeen ?? null)) next = 'review';
        else if (a.status === 'exited') next = 'review';
      } else if (a.status === 'running') {
        next = 'active';
        it.activeSince = now();
        it.briefSeen = a.briefAt ?? null;
        it.error = null;
      }
      if (next !== it.status) {
        it.status = next;
        if (next === 'review') it.reviewAt = now();
        dirty = true;
      }
    }
    if (dirty) this.changed();
    this.dispatch().catch(() => {});
  }

  /** Start queued items on machines with room. */
  async dispatch() {
    if (!this.data.autoRun || this.dispatching) return [];
    this.dispatching = true;
    const started = [];
    try {
      const runners = this.runners();
      let explained = false;
      for (const it of this.items()) {
        if (it.status !== 'queued' || it.starting) continue;
        const cooldown = (rid) => Date.now() - (this.refused.get(`${it.id}:${rid}`) ?? 0) < REFUSED_COOLDOWN_MS;
        const pick = pickRunner(it, runners, this.items(), { cooldown });
        if (!pick.runner) {
          if (this.waiting.get(it.id) !== pick.why) {
            this.waiting.set(it.id, pick.why);
            explained = true;
          }
          continue;
        }
        try {
          await this.launch(it, pick);
          started.push(it.id);
        } catch {}
      }
      if (explained) this.notify();
      return started;
    } finally {
      this.dispatching = false;
    }
  }
}

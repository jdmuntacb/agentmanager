// The backlog: work orders that agents pick up automatically, one item per
// agent, up to a parallel limit per project, until each item is complete.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { parsePriority, projectOf } from './manager.js';

const now = () => new Date().toISOString();
const err = (status, message) => Object.assign(new Error(message), { status });

// queued → active → review → done; blocked / cancelled on the side.
const OPEN = new Set(['queued', 'active', 'review', 'blocked']);

export class Backlog extends EventEmitter {
  constructor({ manager, store, config }) {
    super();
    this.manager = manager;
    this.store = store;
    this.config = config;
    store.data.backlog ??= { items: {}, limits: {}, autoRun: true };
    this.data = store.data.backlog;
    this.dispatching = false;

    manager.on('change', (agent) => this.onAgent(agent));
    manager.on('removed', (id) => this.onAgentRemoved(id));
    this.timer = setInterval(() => this.dispatch().catch(() => {}), 2000);
    this.timer.unref();
  }

  // ------------------------------------------------------------ queries

  defaultLimit() {
    return this.config.backlogParallel ?? 2;
  }

  limitFor(projectKey) {
    return this.data.limits[projectKey] ?? this.defaultLimit();
  }

  items() {
    return Object.values(this.data.items).sort(
      (a, b) => a.priority - b.priority || a.order - b.order || a.createdAt.localeCompare(b.createdAt),
    );
  }

  view() {
    const items = this.items().map((it) => {
      const agent = it.agentId ? this.store.get(it.agentId) : null;
      return {
        ...it,
        agent: agent
          ? {
              id: agent.id,
              name: agent.name,
              status: agent.status,
              briefStatus: agent.brief?.status ?? null,
              attention: this.manager.view(agent).runtime.attention,
            }
          : null,
      };
    });
    const projects = {};
    for (const it of items) {
      const shortcut = Object.values(this.store.data.projects ?? {}).find((x) => x.key === it.projectKey)?.shortcut ?? null;
      const p = (projects[it.projectKey] ??= { key: it.projectKey, name: it.projectName, shortcut, limit: this.limitFor(it.projectKey), counts: {} });
      p.counts[it.status] = (p.counts[it.status] ?? 0) + 1;
    }
    return {
      autoRun: this.data.autoRun,
      defaultLimit: this.defaultLimit(),
      maxActive: this.config.backlogMaxActive ?? 4,
      projects: Object.values(projects),
      items,
    };
  }

  changed() {
    this.store.save();
    this.emit('change', this.view());
  }

  get(id) {
    const it = this.data.items[id];
    if (!it) throw err(404, `No backlog item "${id}"`);
    return it;
  }

  // ------------------------------------------------------------ editing

  /** Queue one item per title. Options are what an agent would take (repo, dir, base, project, ...). */
  add(titles, { repo, dir, base, project, worktree, permissionMode, model, plan, planReview, engine, priority = 2 } = {}) {
    const list = titles.map((t) => String(t ?? '').trim()).filter(Boolean);
    if (!list.length) throw err(400, 'At least one item is required');
    const pr = parsePriority(priority);
    // A project shortcut fills in the repo / folder / base branch.
    const entry = project ? this.manager.resolveProject(project) : null;
    if (entry) {
      if (!repo && !dir) {
        repo = entry.repo ?? undefined;
        dir = entry.dir ?? undefined;
      }
      base ??= entry.base ?? undefined;
      project = entry.key.startsWith('custom:') ? entry.name : undefined;
    }
    const p = projectOf({ project: project?.trim() || null, repo: repo?.trim() || null, requestedDir: dir?.trim() || null });
    const order = Math.max(0, ...Object.values(this.data.items).map((i) => i.order ?? 0)) + 1;
    const added = list.map((title, i) => {
      const it = {
        id: crypto.randomBytes(3).toString('hex'),
        title,
        projectKey: p.key,
        projectName: p.name,
        project: project?.trim() || null,
        repo: repo?.trim() || null,
        dir: dir?.trim() || null,
        base: base?.trim() || null,
        // Parallel agents on one folder must not trample each other.
        worktree: worktree ?? true,
        permissionMode: permissionMode || null,
        model: model || null,
        engine: engine || null,
        plan: Boolean(plan),
        planReview: planReview ?? null,
        priority: pr,
        order: order + i,
        status: 'queued',
        agentId: null,
        notes: '',
        createdAt: now(),
        startedAt: null,
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

  update(id, fields) {
    const it = this.get(id);
    if ('title' in fields && it.status === 'queued') it.title = String(fields.title).trim() || it.title;
    if ('priority' in fields) {
      it.priority = parsePriority(fields.priority, it.priority);
      if (it.agentId && this.store.get(it.agentId)) this.manager.update(it.agentId, { priority: it.priority });
    }
    if ('notes' in fields) it.notes = String(fields.notes ?? '');
    this.changed();
    return it;
  }

  /** Reorder within the queue: "up", "down", "top" or "bottom" among items of the same priority. */
  move(id, where) {
    const it = this.get(id);
    const peers = this.items().filter((x) => x.priority === it.priority && x.status === 'queued');
    const i = peers.findIndex((x) => x.id === id);
    if (i < 0) throw err(409, 'Only queued items can be reordered');
    const j = { up: i - 1, down: i + 1, top: 0, bottom: peers.length - 1 }[where];
    if (j === undefined) throw err(400, 'where must be up, down, top or bottom');
    const target = Math.max(0, Math.min(peers.length - 1, j));
    peers.splice(target, 0, ...peers.splice(i, 1));
    const base = Math.min(...peers.map((x) => x.order));
    peers.forEach((x, k) => (x.order = base + k));
    this.changed();
    return it;
  }

  remove(id) {
    const it = this.get(id);
    if (it.status === 'active') throw err(409, 'Cancel the item first (its agent is working on it)');
    delete this.data.items[id];
    this.changed();
    return { id };
  }

  settings({ autoRun, limits, project, limit } = {}) {
    if (typeof autoRun === 'boolean') this.data.autoRun = autoRun;
    if (limits && typeof limits === 'object') Object.assign(this.data.limits, limits);
    if (project !== undefined && limit !== undefined) {
      const key =
        this.manager.resolveProject(project)?.key ??
        this.items().find((x) => x.projectKey === project || x.projectName === project)?.projectKey ??
        project;
      const n = Number(limit);
      if (!(n >= 0 && n <= 20)) throw err(400, 'limit must be 0-20');
      this.data.limits[key] = n;
    }
    this.changed();
    this.dispatch().catch(() => {});
    return this.view();
  }

  // ------------------------------------------------------------ lifecycle

  /** Start an item now, even if its project is at its limit or the backlog is paused. */
  start(id) {
    const it = this.get(id);
    if (it.status !== 'queued' && it.status !== 'blocked') throw err(409, `Item is ${it.status}`);
    if (it.status === 'blocked' && it.agentId && this.store.get(it.agentId)) {
      this.manager.start(it.agentId); // retries a failed setup
      Object.assign(it, { status: 'active', activeSince: now() });
      this.changed();
      return it;
    }
    return this.launch(it);
  }

  launch(it) {
    const agent = this.manager.create({
      intent: it.title,
      repo: it.repo,
      dir: it.dir,
      base: it.base,
      worktree: it.worktree,
      project: it.project,
      permissionMode: it.permissionMode,
      model: it.model,
      engine: it.engine ?? undefined,
      plan: it.plan,
      planReview: it.planReview ?? undefined,
      priority: it.priority,
      name: undefined,
    });
    Object.assign(it, { status: 'active', agentId: agent.id, startedAt: now(), activeSince: now() });
    this.store.patch(agent.id, { backlogItem: it.id });
    this.changed();
    return it;
  }

  /** Accept the agent's work: the item is done. */
  accept(id) {
    const it = this.get(id);
    if (!['review', 'active', 'blocked'].includes(it.status)) throw err(409, `Item is ${it.status}`);
    Object.assign(it, { status: 'done', doneAt: now() });
    this.changed();
    return it;
  }

  /** Send it back: the same agent session continues, with the reviewer's note. */
  reopen(id, { note } = {}) {
    const it = this.get(id);
    if (!['review', 'done', 'blocked'].includes(it.status)) throw err(409, `Item is ${it.status}`);
    if (!it.agentId || !this.store.get(it.agentId)) {
      Object.assign(it, { status: 'queued', agentId: null, reviewAt: null, doneAt: null });
      this.changed();
      return it;
    }
    // Only a brief update after this point counts as "done" again.
    Object.assign(it, { status: 'active', reviewAt: null, doneAt: null, activeSince: now() });
    this.changed();
    const agentId = it.agentId;
    const message = `Reopened from review${note ? `: ${note}` : '.'} Please continue until the task is complete, and set the brief's Status back to done when it is.`;
    // Resume if closed, then type the note into its session.
    Promise.resolve(this.manager.start(agentId))
      .then(() => new Promise((r) => setTimeout(r, 1500)))
      .then(() => {
        this.manager.write(agentId, message);
        setTimeout(() => this.manager.write(agentId, '\r'), 200);
      })
      .catch(() => {});
    return it;
  }

  cancel(id) {
    const it = this.get(id);
    if (!OPEN.has(it.status)) throw err(409, `Item is ${it.status}`);
    it.status = 'cancelled';
    this.changed();
    return it;
  }

  // ------------------------------------------------------------ automation

  /** Follow the agent: its brief saying "done", or the agent ending, sends the item to review. */
  onAgent(agent) {
    const it = agent.backlogItem && this.data.items[agent.backlogItem];
    if (!it) return;
    let next = it.status;
    if (it.status === 'active') {
      if (agent.status === 'error') next = 'blocked';
      else if (agent.brief?.status === 'done' && agent.brief.updatedAt > (it.activeSince ?? '')) next = 'review';
      else if (agent.status === 'exited' || (agent.status === 'stopped' && agent.desired === 'stopped')) next = 'review';
    } else if (it.status === 'blocked' && agent.status === 'running') {
      next = 'active';
      it.activeSince = now();
    }
    if (next !== it.status) {
      it.status = next;
      if (next === 'review') it.reviewAt = now();
      this.changed();
      if (next !== 'active') this.dispatch().catch(() => {});
    }
  }

  onAgentRemoved(id) {
    for (const it of Object.values(this.data.items)) {
      if (it.agentId === id && OPEN.has(it.status) && it.status !== 'queued') {
        it.status = 'cancelled';
        this.changed();
      }
    }
  }

  /** Start queued items wherever a project has a free slot (and the global cap allows). */
  async dispatch() {
    if (!this.data.autoRun || this.dispatching || this.manager.closing) return [];
    this.dispatching = true;
    try {
      const started = [];
      const items = this.items();
      let active = items.filter((x) => x.status === 'active').length;
      const max = this.config.backlogMaxActive ?? 4;
      for (const it of items) {
        if (active >= max) break;
        if (it.status !== 'queued') continue;
        const busy = items.filter((x) => x.projectKey === it.projectKey && x.status === 'active').length;
        if (busy >= this.limitFor(it.projectKey)) continue;
        this.launch(it);
        started.push(it.id);
        active++;
      }
      return started;
    } finally {
      this.dispatching = false;
    }
  }
}

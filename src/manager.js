import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import pty from 'node-pty';
import { expandHome, paths } from './config.js';
import * as git from './git.js';
import {
  bugFromRef,
  extractRefs,
  prDetails,
  prFromUrl,
  prsForBranch,
  recentSessionFiles,
  scanTranscript,
  transcriptPath,
} from './tracker.js';

// Per-session markers a parent Claude Code session sets. Inherited, they make the
// agent think it is a nested child session (which, among other things, turns
// transcript saving off, so the session could never be resumed).
const STRIP_ENV = [
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
];
// Prompts that block a background agent until someone answers in its terminal.
// Matched against output with ANSI codes and all whitespace removed, because
// Claude's TUI positions words with cursor moves instead of spaces.
const ATTENTION = [
  [/trustthisfolder/i, 'Folder trust prompt'],
  [/Doyouwantto(proceed|make|create|allow|run|overwrite)/i, 'Permission prompt'],
];
const ANSI = /\x1b(\[[0-9;?<>=]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[()][0-9A-B]|[=>78c])/g;
// When a link is found from several sources, the higher-ranked source is kept.
const SOURCE_RANK = { manual: 5, intent: 4, session: 3, branch: 2, mentioned: 1 };
const BUSY_IDLE_MS = 3000;

export function slugify(text, max = 30) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || 'agent'
  );
}

const now = () => new Date().toISOString();

export class AgentManager extends EventEmitter {
  constructor({ store, config }) {
    super();
    this.store = store;
    this.config = config;
    this.runtimes = new Map(); // agent id -> { pty, chunks, size, clients, lastOutputAt, busy, stopping, exited }
    this.shells = new Map(); // agent id -> ancillary shell runtime in the agent's folder
    this.cursors = new Map(); // session id -> transcript scan cursor
    this.locks = new Map();
    this.refreshing = new Set();
    this.lastPrCheck = new Map();

    // Processes do not survive a daemon restart, but their session IDs do.
    // `desired` records whether the user wants the agent running; a restart,
    // crash or reboot leaves it alone, so resumeAll() can bring agents back.
    for (const agent of store.list()) {
      if (!agent.desired) store.patch(agent.id, { desired: agent.status === 'running' ? 'running' : 'stopped' });
      if (agent.status === 'running' || agent.status === 'preparing') {
        const interrupted = agent.status === 'preparing';
        store.patch(agent.id, {
          status: interrupted ? 'error' : 'stopped',
          error: interrupted ? 'Workspace setup was interrupted by a daemon restart' : agent.error,
          // resumeAll() retries interrupted setups the user still wants running.
          setupInterrupted: interrupted || undefined,
          pid: null,
        });
      }
      if (agent.progress) store.patch(agent.id, { progress: null });
    }
    this.preparing = new Map(); // agent id -> { controller, done } for workspace setup in flight

    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
    this.tickCount = 0;
  }

  // ---------------------------------------------------------------- queries

  list() {
    return this.store.list().map((a) => this.view(a));
  }

  get(ref) {
    const agent = this.store.resolve(ref);
    return agent && this.view(agent);
  }

  mustGet(ref) {
    const agent = this.store.resolve(ref);
    if (!agent) throw Object.assign(new Error(`No agent matches "${ref}"`), { status: 404 });
    return agent;
  }

  view(agent) {
    const rt = this.runtimes.get(agent.id);
    return {
      ...agent,
      prs: Object.values(agent.prs ?? {}),
      bugs: Object.values(agent.bugs ?? {}),
      runtime: {
        running: Boolean(rt?.pty),
        busy: Boolean(rt?.pty && rt.busy),
        attention: (rt?.pty && !rt.busy && rt.attention) || null,
        clients: rt?.clients.size ?? 0,
        shell: Boolean(this.shells.get(agent.id)?.pty),
        lastOutputAt: rt?.lastOutputAt ? new Date(rt.lastOutputAt).toISOString() : null,
      },
    };
  }

  changed(agent) {
    this.emit('change', this.view(agent));
  }

  patch(id, fields) {
    const agent = this.store.patch(id, fields);
    if (agent) this.changed(agent);
    return agent;
  }

  // --------------------------------------------------------------- creation

  /** Create one agent per intent. Workspace prep and launch continue in the background. */
  createMany(intents, opts = {}) {
    const list = intents.map((i) => i.trim()).filter(Boolean);
    if (!list.length) throw Object.assign(new Error('At least one intent is required'), { status: 400 });
    // Several intents against one folder would trample each other; isolate them.
    const worktree = opts.worktree ?? (list.length > 1 && Boolean(opts.dir));
    return list.map((intent, i) =>
      this.create({ ...opts, intent, worktree, name: list.length > 1 && opts.name ? `${opts.name}-${i + 1}` : opts.name }),
    );
  }

  /** A general Claude session with no repo or folder; the question (if any) is its first prompt. */
  createGeneral({ question, name, permissionMode, model } = {}) {
    return this.create({ kind: 'general', intent: question, name, permissionMode, model });
  }

  create({ kind = 'task', intent, name, repo, dir, worktree = false, permissionMode, model, start = true }) {
    intent = (intent ?? '').trim();
    const general = kind === 'general';
    if (!intent && !general) throw Object.assign(new Error('Intent is required'), { status: 400 });
    const id = crypto.randomBytes(3).toString('hex');
    const sessionId = crypto.randomUUID();
    const slug = name || intent ? slugify(name || intent) : `general-${id}`;
    const refs = extractRefs(intent, this.config.bugPatterns);

    const agent = {
      id,
      kind: general ? 'general' : 'task',
      name: name?.trim() || slug,
      slug,
      intent,
      repo: general ? null : repo?.trim() || null,
      requestedDir: general ? null : dir?.trim() || null,
      workdir: null,
      sourceDir: null,
      branch: null,
      worktree: !general && Boolean(worktree),
      permissionMode: permissionMode || this.config.permissionMode,
      model: model || null,
      status: 'preparing',
      desired: start ? 'running' : 'stopped',
      error: null,
      exitCode: null,
      pid: null,
      sessionId,
      sessions: [{ id: sessionId, createdAt: now(), starts: 0 }],
      git: null,
      prs: {},
      bugs: {},
      dismissed: [],
      notes: '',
      createdAt: now(),
      updatedAt: now(),
      lastStartedAt: null,
      stoppedAt: null,
    };
    for (const pr of refs.prs) agent.prs[pr.url] = { ...pr, source: 'intent' };
    for (const bug of refs.bugs) agent.bugs[bug.key] = { ...bug, source: 'intent' };
    this.store.put(agent);
    this.changed(agent);

    this.prepare(agent, { start }).catch(() => {});
    return this.view(agent);
  }

  prepare(agent, { start }) {
    const controller = new AbortController();
    const { signal } = controller;
    // Progress is transient: broadcast it, but don't rewrite state.json for every tick.
    let last = 0;
    const progress = (p) => {
      const cur = this.store.get(agent.id);
      if (!cur) return;
      const t = Date.now();
      if (t - last < 500 && p.percent !== 100 && cur.progress?.phase === p.phase) return;
      last = t;
      cur.progress = { ...p, at: new Date(t).toISOString() };
      this.changed(cur);
    };
    const done = (async () => {
      try {
        const ws = await this.prepareWorkspace(agent, { signal, progress });
        progress({ phase: 'Reading git info' });
        const info = await git.gitInfo(ws.workdir);
        if (!this.store.get(agent.id)) return;
        this.patch(agent.id, {
          ...ws,
          repo: ws.repo || agent.repo || info?.remote || null,
          git: info,
          status: 'stopped',
          progress: null,
          setupInterrupted: undefined,
        });
        if (start) this.start(agent.id);
      } catch (err) {
        if (this.store.get(agent.id)) {
          this.patch(agent.id, { status: 'error', error: err.message, progress: null, setupInterrupted: undefined });
        }
        throw err;
      } finally {
        this.preparing.delete(agent.id);
      }
    })();
    this.preparing.set(agent.id, { controller, done });
    return done;
  }

  /** Re-run workspace setup for an agent whose setup failed or was interrupted. */
  retrySetup(ref) {
    const agent = this.mustGet(ref);
    if (agent.status !== 'error' || agent.workdir) {
      throw Object.assign(new Error('Only agents whose setup failed can be retried'), { status: 409 });
    }
    this.patch(agent.id, { status: 'preparing', error: null, desired: 'running' });
    this.prepare(agent, { start: true }).catch(() => {});
    return this.view(agent);
  }

  withLock(key, fn) {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(key, next);
    return next;
  }

  async prepareWorkspace(agent, { signal, progress = () => {} } = {}) {
    const { id, slug } = agent;
    const cloneOpts = (phase) => ({
      signal,
      filter: this.config.cloneFilter || undefined,
      onProgress: (p) => progress({ phase, ...p }),
    });
    if (agent.kind === 'general') {
      fs.mkdirSync(paths.general, { recursive: true });
      return { workdir: paths.general };
    }
    let repo = agent.repo;
    let dir = agent.requestedDir ? path.resolve(expandHome(agent.requestedDir)) : null;
    const branch = `agent/${slug}-${id}`;

    // A "repo" that is really a local path is treated as the folder.
    if (repo && !git.isRemoteUrl(repo)) {
      dir ??= path.resolve(expandHome(repo));
      repo = null;
    }

    if (repo && !dir) {
      // One shared clone per repo; each agent gets its own worktree + branch off it.
      const name = git.repoNameFromUrl(repo);
      const hash = crypto.createHash('sha1').update(repo).digest('hex').slice(0, 6);
      const base = path.join(paths.repos, `${name}-${hash}`);
      if (this.locks.has(base)) progress({ phase: 'Waiting for another agent to finish cloning' });
      await this.withLock(base, async () => {
        signal?.throwIfAborted();
        // A clone interrupted by a crash or restart is unusable; start it over.
        if (fs.existsSync(base) && !(await git.isValidClone(base))) fs.rmSync(base, { recursive: true, force: true });
        if (!fs.existsSync(base)) {
          progress({ phase: 'Cloning' });
          await git.clone(repo, base, { ...cloneOpts('Cloning'), noCheckout: true });
        } else {
          progress({ phase: 'Fetching' });
          await git.fetch(base, { signal }).catch((err) => {
            if (err.cancelled) throw err;
          });
        }
      });
      const workdir = path.join(paths.workspaces, `${name}-${slug}-${id}`);
      await this.withLock(base, async () => {
        signal?.throwIfAborted();
        progress({ phase: 'Checking out' });
        await git.addWorktree(base, workdir, branch, await git.remoteRef(base), cloneOpts('Checking out'));
      });
      return { workdir, sourceDir: base, branch, worktree: true, repo };
    }

    if (repo && dir && !fs.existsSync(dir)) {
      progress({ phase: 'Cloning' });
      await git.clone(repo, dir, cloneOpts('Cloning'));
      return { workdir: dir, repo };
    }

    if (!dir) {
      const workdir = path.join(paths.workspaces, `${slug}-${id}`);
      fs.mkdirSync(workdir, { recursive: true });
      return { workdir, repo };
    }

    fs.mkdirSync(dir, { recursive: true });
    if (agent.worktree) {
      if (!(await git.isGitRepo(dir))) throw new Error(`Worktree requested but ${dir} is not a git repository`);
      const top = await git.run('git', ['rev-parse', '--show-toplevel'], { cwd: dir });
      const workdir = path.join(paths.workspaces, `${path.basename(top)}-${slug}-${id}`);
      progress({ phase: 'Checking out' });
      await this.withLock(top, () => git.addWorktree(top, workdir, branch, 'HEAD', cloneOpts('Checking out')));
      return { workdir, sourceDir: top, branch, worktree: true, repo };
    }
    return { workdir: dir, repo };
  }

  // -------------------------------------------------------------- lifecycle

  /**
   * Launch (or re-launch) claude for an agent. Resumes the current session if
   * its transcript exists; `fresh` starts a new session ID, `sessionId` switches
   * back to an earlier one.
   */
  start(ref, { fresh = false, sessionId } = {}) {
    const agent = this.mustGet(ref);
    if (this.runtimes.get(agent.id)?.pty) return this.view(agent);
    if (agent.status === 'preparing') throw Object.assign(new Error('Workspace is still being prepared'), { status: 409 });
    if (agent.status === 'error' && !agent.workdir) return this.retrySetup(agent.id);
    if (!agent.workdir || !fs.existsSync(agent.workdir)) {
      throw Object.assign(new Error(`Working folder ${agent.workdir} no longer exists`), { status: 409 });
    }

    if (sessionId) {
      if (!agent.sessions.some((s) => s.id === sessionId)) {
        throw Object.assign(new Error(`Session ${sessionId} does not belong to this agent`), { status: 400 });
      }
      agent.sessionId = sessionId;
    } else if (fresh) {
      agent.sessionId = crypto.randomUUID();
      agent.sessions.push({ id: agent.sessionId, createdAt: now(), starts: 0 });
    }

    const sid = agent.sessionId;
    const resuming = fs.existsSync(transcriptPath(agent.workdir, sid));
    const args = [...(this.config.claudeArgs ?? [])];
    if (agent.permissionMode && agent.permissionMode !== 'default') args.push('--permission-mode', agent.permissionMode);
    if (agent.model) args.push('--model', agent.model);
    if (resuming) {
      args.push('--resume', sid);
    } else {
      args.push('--session-id', sid, '--name', agent.name);
      if (agent.intent) args.push('--', agent.intent);
    }

    const env = this.childEnv(agent);
    const prev = this.runtimes.get(agent.id);
    const rt = {
      pty: null,
      chunks: prev?.chunks ?? [],
      size: prev?.size ?? 0,
      clients: prev?.clients ?? new Set(),
      cols: prev?.cols ?? 120,
      rows: prev?.rows ?? 34,
      lastOutputAt: null,
      busy: false,
      stopping: false,
      startedAt: Date.now(),
      tail: '',
      attention: null,
    };
    if (prev?.pty === null && rt.size) this.appendOutput(rt, '\r\n\x1b[2m── agent restarted ──\x1b[0m\r\n');

    let proc;
    try {
      proc = pty.spawn(this.config.claudeBin, args, {
        name: 'xterm-256color',
        cols: rt.cols,
        rows: rt.rows,
        cwd: agent.workdir,
        env,
      });
    } catch (err) {
      this.patch(agent.id, { status: 'error', error: `Failed to launch ${this.config.claudeBin}: ${err.message}` });
      throw err;
    }
    rt.pty = proc;
    this.runtimes.set(agent.id, rt);

    proc.onData((data) => {
      rt.lastOutputAt = Date.now();
      rt.tail = (rt.tail + data).slice(-4000);
      this.appendOutput(rt, data);
      this.broadcast(rt, { t: 'o', d: data });
      if (!rt.busy) {
        rt.busy = true;
        const a = this.store.get(agent.id);
        if (a) this.changed(a);
      }
    });
    proc.onExit(({ exitCode, signal }) => {
      clearTimeout(rt.killTimer);
      rt.pty = null;
      rt.busy = false;
      rt.attention = null;
      this.broadcast(rt, { t: 'exit', code: exitCode, signal });
      const a = this.store.get(agent.id);
      if (!a) return;
      this.patch(agent.id, {
        status: rt.stopping ? 'stopped' : 'exited',
        // Claude exiting by itself (e.g. /exit) is a deliberate close; don't auto-resume it.
        ...(rt.stopping ? {} : { desired: 'stopped' }),
        exitCode,
        pid: null,
        stoppedAt: now(),
      });
      this.refresh(agent.id, { withPrs: true }).catch(() => {});
    });

    const session = agent.sessions.find((s) => s.id === sid);
    if (session) {
      session.starts = (session.starts ?? 0) + 1;
      session.lastStartedAt = now();
    }
    this.patch(agent.id, {
      status: 'running',
      desired: 'running',
      error: null,
      exitCode: null,
      pid: proc.pid,
      lastStartedAt: now(),
      sessions: agent.sessions,
      sessionId: sid,
    });
    return this.view(this.store.get(agent.id));
  }

  /**
   * Close the claude process. Session IDs are kept so it can be resumed later.
   * `keepDesired` is for daemon shutdown: the agent comes back on next start.
   */
  stop(ref, { timeoutMs = 5000, keepDesired = false } = {}) {
    const agent = this.mustGet(ref);
    if (!keepDesired && agent.desired !== 'stopped') this.patch(agent.id, { desired: 'stopped' });
    const rt = this.runtimes.get(agent.id);
    if (!rt?.pty) return Promise.resolve(this.view(agent));
    rt.stopping = true;
    return new Promise((resolve) => {
      const done = rt.pty.onExit(() => {
        done.dispose();
        resolve(this.view(this.store.get(agent.id) ?? agent));
      });
      rt.pty.kill('SIGHUP');
      rt.killTimer = setTimeout(() => rt.pty?.kill('SIGKILL'), timeoutMs);
    });
  }

  /** Daemon shutdown: close everything but remember which agents should come back. */
  async stopAll() {
    for (const id of this.shells.keys()) this.closeShell(id);
    await Promise.all(
      [...this.runtimes.entries()].filter(([, rt]) => rt.pty).map(([id]) => this.stop(id, { keepDesired: true })),
    );
  }

  /** Bring back every agent that was running when the daemon last stopped. */
  async resumeAll({ staggerMs = 400 } = {}) {
    const resumed = [];
    for (const agent of this.store.list()) {
      const retry = agent.setupInterrupted && !agent.workdir;
      if (agent.desired !== 'running' || (!agent.workdir && !retry) || this.runtimes.get(agent.id)?.pty) continue;
      try {
        this.start(agent.id);
        resumed.push(agent.id);
      } catch (err) {
        this.patch(agent.id, { status: 'error', error: `Auto-resume failed: ${err.message}` });
      }
      await new Promise((r) => setTimeout(r, staggerMs));
    }
    return resumed;
  }

  childEnv(agent) {
    const env = { ...process.env, AGENTMGR_AGENT_ID: agent.id, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const key of STRIP_ENV) delete env[key];
    return env;
  }

  async remove(ref, { deleteWorkspace = false } = {}) {
    const agent = this.mustGet(ref);
    const setup = this.preparing.get(agent.id);
    if (setup) {
      // Cancel the clone / checkout; git helpers clean up their partial output.
      setup.controller.abort();
      await setup.done.catch(() => {});
    }
    await this.stop(agent.id);
    const warnings = [];
    if (deleteWorkspace && agent.workdir) {
      try {
        if (agent.worktree && agent.sourceDir) {
          await git.removeWorktree(agent.sourceDir, agent.workdir);
        } else if (agent.workdir.startsWith(paths.workspaces + path.sep)) {
          fs.rmSync(agent.workdir, { recursive: true, force: true });
        } else {
          warnings.push(`Kept ${agent.workdir}: it is a folder you provided, not one agentmgr created`);
        }
      } catch (err) {
        warnings.push(err.message);
      }
    }
    this.closeShell(agent.id);
    for (const client of this.shells.get(agent.id)?.clients ?? []) client.close?.();
    this.shells.delete(agent.id);
    for (const s of agent.sessions) this.cursors.delete(s.id);
    for (const client of this.runtimes.get(agent.id)?.clients ?? []) client.close?.();
    this.runtimes.delete(agent.id);
    this.store.remove(agent.id);
    this.emit('removed', agent.id);
    return { id: agent.id, warnings };
  }

  update(ref, fields) {
    const agent = this.mustGet(ref);
    const allowed = {};
    for (const key of ['name', 'notes', 'permissionMode', 'model']) if (key in fields) allowed[key] = fields[key];
    return this.view(this.patch(agent.id, allowed));
  }

  // --------------------------------------------------------------- terminal

  appendOutput(rt, data) {
    rt.chunks.push(data);
    rt.size += data.length;
    const max = this.config.scrollbackBytes;
    while (rt.size > max && rt.chunks.length > 1) rt.size -= rt.chunks.shift().length;
  }

  broadcast(rt, msg) {
    for (const client of rt.clients) client.send(msg);
  }

  /** Attach a terminal client ({ send(msg), close() }). Returns the scrollback and a detach fn. */
  attach(ref, client) {
    const agent = this.mustGet(ref);
    let rt = this.runtimes.get(agent.id);
    if (!rt) {
      rt = { pty: null, chunks: [], size: 0, clients: new Set(), cols: 120, rows: 34 };
      this.runtimes.set(agent.id, rt);
    }
    rt.clients.add(client);
    this.changed(agent);
    return {
      backlog: rt.chunks.join(''),
      running: Boolean(rt.pty),
      detach: () => {
        rt.clients.delete(client);
        const a = this.store.get(agent.id);
        if (a) this.changed(a);
      },
    };
  }

  write(id, data, kind = 'claude') {
    (kind === 'shell' ? this.shells : this.runtimes).get(id)?.pty?.write(data);
  }

  resize(id, cols, rows, kind = 'claude') {
    const rt = (kind === 'shell' ? this.shells : this.runtimes).get(id);
    if (!rt || !(cols > 0 && rows > 0)) return;
    rt.cols = cols;
    rt.rows = rows;
    try {
      rt.pty?.resize(cols, rows);
    } catch {}
  }

  // ------------------------------------------------------- ancillary shell

  /** Start (if needed) a login shell in the agent's folder, for running commands by hand. */
  openShell(ref) {
    const agent = this.mustGet(ref);
    const prev = this.shells.get(agent.id);
    if (prev?.pty) return prev;
    if (!agent.workdir || !fs.existsSync(agent.workdir)) {
      throw Object.assign(new Error('The working folder is not ready yet'), { status: 409 });
    }
    const rt = {
      pty: null,
      chunks: prev?.chunks ?? [],
      size: prev?.size ?? 0,
      clients: prev?.clients ?? new Set(),
      cols: prev?.cols ?? 120,
      rows: prev?.rows ?? 34,
    };
    if (rt.size) this.appendOutput(rt, '\r\n\x1b[2m── new shell ──\x1b[0m\r\n');
    const proc = pty.spawn(this.config.shell, ['-l'], {
      name: 'xterm-256color',
      cols: rt.cols,
      rows: rt.rows,
      cwd: agent.workdir,
      env: this.childEnv(agent),
    });
    rt.pty = proc;
    this.shells.set(agent.id, rt);
    proc.onData((data) => {
      this.appendOutput(rt, data);
      this.broadcast(rt, { t: 'o', d: data });
    });
    proc.onExit(({ exitCode }) => {
      rt.pty = null;
      this.broadcast(rt, { t: 'exit', code: exitCode });
      const a = this.store.get(agent.id);
      if (a) this.changed(a);
    });
    this.changed(agent);
    return rt;
  }

  attachShell(ref, client) {
    const agent = this.mustGet(ref);
    const rt = this.openShell(agent.id);
    rt.clients.add(client);
    return {
      backlog: rt.chunks.join(''),
      running: true,
      detach: () => rt.clients.delete(client),
    };
  }

  closeShell(ref) {
    const rt = this.shells.get(this.store.resolve(ref)?.id ?? ref);
    rt?.pty?.kill('SIGHUP');
    return { ok: true };
  }

  // --------------------------------------------------------------- tracking

  addLink(ref, { type, value, title }) {
    const agent = this.mustGet(ref);
    value = (value ?? '').trim();
    if (!value) throw Object.assign(new Error('Link value is required'), { status: 400 });
    if (type === 'pr') {
      const pr = { ...prFromUrl(value, 'manual'), ...(title ? { title } : {}) };
      agent.prs[pr.url] = { ...agent.prs[pr.url], ...pr };
      agent.dismissed = agent.dismissed.filter((k) => k !== pr.url);
    } else if (type === 'bug') {
      const bug = { ...bugFromRef(value, 'manual'), ...(title ? { title } : {}) };
      agent.bugs[bug.key] = { ...agent.bugs[bug.key], ...bug };
      agent.dismissed = agent.dismissed.filter((k) => k !== bug.key);
    } else {
      throw Object.assign(new Error('type must be "pr" or "bug"'), { status: 400 });
    }
    this.store.save();
    this.changed(agent);
    if (type === 'pr') this.refresh(agent.id, { withPrs: true }).catch(() => {});
    return this.view(agent);
  }

  removeLink(ref, { type, key }) {
    const agent = this.mustGet(ref);
    const bag = type === 'pr' ? agent.prs : agent.bugs;
    if (bag[key]) {
      delete bag[key];
      if (!agent.dismissed.includes(key)) agent.dismissed.push(key);
      this.store.save();
      this.changed(agent);
    }
    return this.view(agent);
  }

  mergeLinks(agent, bag, items, keyOf) {
    let changed = false;
    for (const item of items) {
      const key = keyOf(item);
      if (!key || agent.dismissed.includes(key)) continue;
      const cur = bag[key];
      if (!cur) {
        bag[key] = item;
        changed = true;
        continue;
      }
      const merged = { ...cur };
      for (const [k, v] of Object.entries(item)) {
        if (k === 'source') continue;
        if (v != null && merged[k] !== v) merged[k] = v;
      }
      if ((SOURCE_RANK[item.source] ?? 0) > (SOURCE_RANK[cur.source] ?? 0)) merged.source = item.source;
      if (JSON.stringify(merged) !== JSON.stringify(cur)) {
        bag[key] = merged;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Claude may switch to a new session ID mid-run (e.g. /clear). Adopt a new
   * transcript in this agent's folder if nothing else claims it.
   */
  adoptSessions(agent) {
    const rt = this.runtimes.get(agent.id);
    if (!rt?.pty) return false;
    const known = new Set(this.store.list().flatMap((a) => a.sessions.map((s) => s.id)));
    const candidates = recentSessionFiles(agent.workdir, rt.startedAt - 1000).filter((f) => !known.has(f.sessionId));
    if (candidates.length !== 1) return false;
    const [cand] = candidates;
    let currentMtime = 0;
    try {
      currentMtime = fs.statSync(transcriptPath(agent.workdir, agent.sessionId)).mtimeMs;
    } catch {}
    if (currentMtime > cand.mtimeMs) return false;
    agent.sessions.push({ id: cand.sessionId, createdAt: now(), starts: 1, lastStartedAt: now(), adopted: true });
    agent.sessionId = cand.sessionId;
    return true;
  }

  async refresh(ref, { withPrs = false } = {}) {
    const id = this.mustGet(ref).id;
    if (this.refreshing.has(id)) return this.view(this.store.get(id));
    this.refreshing.add(id);
    try {
      const agent = this.store.get(id);
      if (!agent?.workdir) return agent && this.view(agent);
      let changed = this.adoptSessions(agent);

      const info = await git.gitInfo(agent.workdir);
      if (!this.store.get(id)) return null;
      if (JSON.stringify({ ...info, updatedAt: 0 }) !== JSON.stringify({ ...agent.git, updatedAt: 0 })) {
        agent.git = info;
        changed = true;
      }

      for (const session of agent.sessions) {
        const cursor = this.cursors.get(session.id) ?? { offset: 0 };
        this.cursors.set(session.id, cursor);
        const res = scanTranscript(transcriptPath(agent.workdir, session.id), cursor, this.config.bugPatterns);
        for (const key of ['title', 'lastPrompt', 'cost', 'lastActivity']) {
          if (res[key] != null && JSON.stringify(session[key]) !== JSON.stringify(res[key])) {
            session[key] = res[key];
            changed = true;
          }
        }
        const prs = res.prs.map((p) => ({ ...p, sessionId: session.id }));
        changed = this.mergeLinks(agent, agent.prs, prs, (p) => p.url) || changed;
        changed = this.mergeLinks(agent, agent.bugs, res.bugs, (b) => b.key) || changed;
      }

      if (withPrs) {
        this.lastPrCheck.set(id, Date.now());
        const branchPrs = await prsForBranch(agent.workdir, info?.branch);
        changed = this.mergeLinks(agent, agent.prs, branchPrs, (p) => p.url) || changed;
        // Fill in title/state for PRs we only know by URL, and keep open ones current.
        const stale = Object.values(agent.prs).filter(
          (p) => p.source !== 'branch' && (!p.state || p.state === 'OPEN'),
        );
        for (const pr of stale.slice(0, 10)) {
          const d = await prDetails(pr.url);
          if (d) changed = this.mergeLinks(agent, agent.prs, [{ ...d, source: pr.source }], (p) => p.url) || changed;
        }
      }

      if (changed && this.store.get(id)) {
        agent.updatedAt = now();
        this.store.save();
        this.changed(agent);
      }
      return this.view(agent);
    } finally {
      this.refreshing.delete(id);
    }
  }

  tick() {
    this.tickCount++;
    const t = Date.now();
    for (const [id, rt] of this.runtimes) {
      if (rt.busy && t - rt.lastOutputAt > BUSY_IDLE_MS) {
        rt.busy = false;
        const screen = rt.tail.slice(-1500).replace(ANSI, '').replace(/\s+/g, '');
        rt.attention = ATTENTION.find(([re]) => re.test(screen))?.[1] ?? null;
        const a = this.store.get(id);
        if (a) this.changed(a);
      }
    }
    if (this.tickCount % this.config.gitRefreshSec !== 0) return;
    for (const [id, rt] of this.runtimes) {
      if (!rt.pty || !this.store.get(id)) continue;
      const withPrs = t - (this.lastPrCheck.get(id) ?? 0) > this.config.prRefreshSec * 1000;
      this.refresh(id, { withPrs }).catch(() => {});
    }
  }

  /** One-off refresh of every agent (on daemon start), staggered to avoid a burst of gh calls. */
  async refreshAll({ withPrs = true } = {}) {
    for (const agent of this.store.list()) {
      if (agent.workdir) await this.refresh(agent.id, { withPrs }).catch(() => {});
    }
  }
}

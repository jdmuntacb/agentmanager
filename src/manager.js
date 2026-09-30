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
    this.cursors = new Map(); // session id -> transcript scan cursor
    this.locks = new Map();
    this.refreshing = new Set();
    this.lastPrCheck = new Map();

    // Processes do not survive a daemon restart, but their session IDs do.
    for (const agent of store.list()) {
      if (agent.status === 'running' || agent.status === 'preparing') {
        store.patch(agent.id, {
          status: agent.status === 'running' ? 'stopped' : 'error',
          error: agent.status === 'preparing' ? 'Daemon restarted while preparing workspace' : agent.error,
          pid: null,
        });
      }
    }

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

  create({ intent, name, repo, dir, worktree = false, permissionMode, model, start = true }) {
    intent = (intent ?? '').trim();
    if (!intent) throw Object.assign(new Error('Intent is required'), { status: 400 });
    const id = crypto.randomBytes(3).toString('hex');
    const sessionId = crypto.randomUUID();
    const slug = slugify(name || intent);
    const refs = extractRefs(intent, this.config.bugPatterns);

    const agent = {
      id,
      name: name?.trim() || slug,
      slug,
      intent,
      repo: repo?.trim() || null,
      requestedDir: dir?.trim() || null,
      workdir: null,
      sourceDir: null,
      branch: null,
      worktree: Boolean(worktree),
      permissionMode: permissionMode || this.config.permissionMode,
      model: model || null,
      status: 'preparing',
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

  async prepare(agent, { start }) {
    try {
      const ws = await this.prepareWorkspace(agent);
      const info = await git.gitInfo(ws.workdir);
      this.patch(agent.id, {
        ...ws,
        repo: ws.repo || agent.repo || info?.remote || null,
        git: info,
        status: 'stopped',
      });
      if (start) this.start(agent.id);
    } catch (err) {
      this.patch(agent.id, { status: 'error', error: err.message });
      throw err;
    }
  }

  withLock(key, fn) {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(key, next);
    return next;
  }

  async prepareWorkspace(agent) {
    const { id, slug } = agent;
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
      await this.withLock(base, async () => {
        if (!fs.existsSync(base)) await git.clone(repo, base);
        else await git.fetch(base).catch(() => {});
      });
      const workdir = path.join(paths.workspaces, `${name}-${slug}-${id}`);
      await this.withLock(base, async () => git.addWorktree(base, workdir, branch, await git.remoteRef(base)));
      return { workdir, sourceDir: base, branch, worktree: true, repo };
    }

    if (repo && dir && !fs.existsSync(dir)) {
      await git.clone(repo, dir);
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
      await this.withLock(top, () => git.addWorktree(top, workdir, branch, 'HEAD'));
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
      args.push('--session-id', sid, '--name', agent.name, '--', agent.intent);
    }

    const env = { ...process.env, AGENTMGR_AGENT_ID: agent.id, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const key of STRIP_ENV) delete env[key];

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
      error: null,
      exitCode: null,
      pid: proc.pid,
      lastStartedAt: now(),
      sessions: agent.sessions,
      sessionId: sid,
    });
    return this.view(this.store.get(agent.id));
  }

  /** Close the claude process. Session IDs are kept so it can be resumed later. */
  stop(ref, { timeoutMs = 5000 } = {}) {
    const agent = this.mustGet(ref);
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

  async stopAll() {
    await Promise.all([...this.runtimes.entries()].filter(([, rt]) => rt.pty).map(([id]) => this.stop(id)));
  }

  async remove(ref, { deleteWorkspace = false } = {}) {
    const agent = this.mustGet(ref);
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

  write(id, data) {
    this.runtimes.get(id)?.pty?.write(data);
  }

  resize(id, cols, rows) {
    const rt = this.runtimes.get(id);
    if (!rt || !(cols > 0 && rows > 0)) return;
    rt.cols = cols;
    rt.rows = rows;
    try {
      rt.pty?.resize(cols, rows);
    } catch {}
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

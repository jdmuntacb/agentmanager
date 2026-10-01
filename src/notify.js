// Slack alerts when an agent needs you: an unanswered prompt, a backlog item
// ready for review, an error, or (optionally) an agent sitting idle.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

const FILE = path.join(paths.home, 'notify.json');

export const EVENT_DEFAULTS = {
  needsInput: true, // trust / permission prompt or a question menu, unanswered
  review: true, // backlog item moved to review
  error: true, // workspace setup or launch failed
  blocked: true, // the agent reports it is blocked (brief status / results outcome)
  waiting: false, // finished its turn and idle (can be noisy)
};

export function loadNotify() {
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {}
  return {
    slack: { webhookUrl: s.slack?.webhookUrl ?? null, botToken: s.slack?.botToken ?? null, channel: s.slack?.channel ?? null },
    events: { ...EVENT_DEFAULTS, ...s.events },
    needsInputDelaySec: s.needsInputDelaySec ?? 60,
    waitingDelaySec: s.waitingDelaySec ?? 120,
    skipWhenWatching: s.skipWhenWatching ?? true,
    includeIntent: s.includeIntent ?? true,
    enabled: s.enabled ?? Boolean(s.slack?.webhookUrl || (s.slack?.botToken && s.slack?.channel)),
  };
}

export function saveNotify(patch) {
  const cur = loadNotify();
  const next = {
    ...cur,
    ...patch,
    slack: { ...cur.slack, ...patch.slack },
    events: { ...cur.events, ...patch.events },
  };
  fs.mkdirSync(paths.home, { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 }); // holds a webhook / token
  fs.renameSync(tmp, FILE);
  return next;
}

/** Settings safe to show in a UI: secrets masked. */
export function publicNotify() {
  const n = loadNotify();
  const mask = (v) => (v ? `${v.slice(0, 24)}…${v.slice(-4)}` : null);
  return {
    ...n,
    slack: { webhookUrl: mask(n.slack.webhookUrl), botToken: mask(n.slack.botToken), channel: n.slack.channel },
    configured: Boolean(n.slack.webhookUrl || (n.slack.botToken && n.slack.channel)),
  };
}

/** Workflow Builder webhook ("From a webhook" trigger) rather than an app's incoming webhook. */
export const isWorkflowUrl = (url) => /^https:\/\/hooks\.slack\.com\/triggers\//.test(url ?? '') || /\/triggers\//.test(url ?? '');

/**
 * Post one message: via a bot token (chat.postMessage), an incoming webhook, or a
 * Workflow Builder webhook. `text` may use Slack link markup (<url|label>);
 * `plain` is the same message without it, for workflows, which insert the
 * "text" variable verbatim and only accept the variables they define.
 */
export async function sendSlack(text, n = loadNotify(), plain = text) {
  const { webhookUrl, botToken, channel } = n.slack;
  if (botToken && channel) {
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${botToken}` },
      body: JSON.stringify({ channel, text, unfurl_links: false }),
    });
    const body = await res.json().catch(() => ({}));
    if (!body.ok) throw new Error(`Slack: ${body.error || `HTTP ${res.status}`}`);
    return;
  }
  if (!webhookUrl) throw new Error('Slack is not configured (set a webhook URL, or a bot token and channel)');
  const workflow = isWorkflowUrl(webhookUrl);
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workflow ? { text: plain } : { text, unfurl_links: false }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 160);
    const hint = workflow && res.status === 400 ? ' (does the workflow define exactly one variable named "text"?)' : '';
    throw new Error(`Slack ${workflow ? 'workflow' : 'webhook'}: HTTP ${res.status} ${detail}${hint}`);
  }
}

/**
 * Watches agents and the backlog and sends each alert once per episode (an
 * episode ends when the condition clears, e.g. the prompt is answered).
 */
export class Notifier {
  constructor({ manager, backlog, linkFor }) {
    this.manager = manager;
    this.backlog = backlog;
    this.linkFor = linkFor; // (agentId) => URL to open it
    this.state = new Map(); // agentId -> { attentionSince, idleSince, worked, sent: Set }
    this.reviewed = new Set(); // backlog item ids already announced
    this.log = []; // recent sends, for the settings view
    manager.on('change', (a) => this.observe(a));
    backlog?.on('change', (v) => this.observeBacklog(v));
    this.timer = setInterval(() => this.tick().catch(() => {}), 5000);
    this.timer.unref();
  }

  st(id) {
    if (!this.state.has(id)) this.state.set(id, { attentionSince: null, idleSince: null, worked: false, sent: new Set() });
    return this.state.get(id);
  }

  observe(a) {
    const s = this.st(a.id);
    const rt = a.runtime ?? {};
    if (rt.attention) s.attentionSince ??= Date.now();
    else {
      s.attentionSince = null;
      s.sent.delete('needsInput');
    }
    if (rt.busy) {
      s.worked = true;
      s.idleSince = null;
      s.sent.delete('waiting');
    } else if (rt.running && !rt.attention) {
      s.idleSince ??= Date.now();
    } else {
      s.idleSince = null;
    }
    const blocked = a.brief?.status === 'blocked' || a.brief?.results?.outcome === 'blocked';
    if (blocked) {
      if (!s.sent.has('blocked')) {
        s.sent.add('blocked');
        const why = a.brief?.results?.blockers?.[0];
        this.send('blocked', a, `is blocked${why ? `: ${why}` : ''}`);
      }
    } else s.sent.delete('blocked');
    if (a.status === 'error') {
      if (!s.sent.has('error')) {
        s.sent.add('error');
        this.send('error', a, `failed: ${a.error ?? 'unknown error'}`);
      }
    } else s.sent.delete('error');
  }

  observeBacklog(view) {
    for (const it of view.items) {
      if (it.status === 'review' && !this.reviewed.has(it.id)) {
        this.reviewed.add(it.id);
        const agent = it.agentId && this.manager.get(it.agentId);
        this.send('review', agent ?? { id: it.agentId, name: it.title, intent: it.title }, `finished backlog item *${it.title}*; ready for your review`);
      } else if (it.status !== 'review') this.reviewed.delete(it.id);
    }
  }

  async tick() {
    const n = loadNotify();
    for (const [id, s] of this.state) {
      const a = this.manager.get(id);
      if (!a) {
        this.state.delete(id);
        continue;
      }
      const watching = n.skipWhenWatching && a.runtime.clients > 0;
      if (s.attentionSince && !s.sent.has('needsInput') && Date.now() - s.attentionSince >= n.needsInputDelaySec * 1000 && !watching) {
        s.sent.add('needsInput');
        this.send('needsInput', a, `needs input: ${a.runtime.attention}`);
      }
      if (s.idleSince && s.worked && !s.sent.has('waiting') && Date.now() - s.idleSince >= n.waitingDelaySec * 1000 && !watching) {
        s.sent.add('waiting');
        this.send('waiting', a, 'is waiting for your next instruction');
      }
    }
  }

  send(kind, agent, what) {
    const n = loadNotify();
    if (!n.enabled || !n.events[kind]) return;
    const icon = { needsInput: ':raised_hand:', review: ':white_check_mark:', error: ':x:', waiting: ':hourglass_flowing_sand:', blocked: ':no_entry:' }[kind];
    const project = agent.projectInfo?.name ? ` (${agent.projectInfo.name})` : '';
    const link = this.linkFor(agent.id);
    const intent = n.includeIntent && agent.intent ? `\n> ${agent.intent.replace(/\s+/g, ' ').slice(0, 200)}` : '';
    const prio = agent.priority <= 1 ? `[P${agent.priority}] ` : '';
    const text = `${icon} ${prio ? `*${prio.trim()}* ` : ''}*${agent.name}*${project} ${what}${intent}${link ? `\n<${link}|Open in Agent Manager>` : ''}`;
    const plain = `${icon} ${prio}${agent.name}${project} ${what.replace(/\*/g, '')}${intent}${link ? `\nOpen: ${link}` : ''}`;
    sendSlack(text, n, plain)
      .then(() => this.record(kind, agent, null))
      .catch((err) => this.record(kind, agent, err.message));
  }

  record(kind, agent, error) {
    this.log.unshift({ at: new Date().toISOString(), kind, agent: agent.name, error });
    this.log.length = Math.min(this.log.length, 20);
    if (error) console.error(`[agentmgr] Slack alert failed: ${error}`);
  }
}

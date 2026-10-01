import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { Command, Option } from 'commander';
import WebSocket from 'ws';
import { HOST, PORT } from './config.js';
import { api, BASE, ensureDaemon, isRunning } from './client.js';

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = c('2');
const bold = c('1');
const green = c('32');
const yellow = c('33');
const red = c('31');
const cyan = c('36');

const STATUS_COLOR = { running: green, preparing: yellow, stopped: dim, exited: yellow, error: red };

function statusLabel(a) {
  const color = STATUS_COLOR[a.status] ?? ((s) => s);
  if (a.runtime?.planning) {
    if (a.runtime.attention) return red('needs input');
    return cyan(a.workdir && a.status !== 'preparing' ? 'planning (repo ready)' : 'planning');
  }
  if (a.status === 'preparing' && a.progress) {
    const p = a.progress;
    return color(p.step ? `${p.phase.toLowerCase()} ${p.percent}%` : p.phase.toLowerCase());
  }
  if (a.status === 'running') {
    if (a.runtime?.attention) return red('needs input');
    return color(a.runtime?.busy ? 'working' : 'waiting');
  }
  return color(a.status);
}

function fmtTokens(n) {
  if (!n) return '';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
}

function truncate(s, n) {
  s = String(s ?? '').replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function table(rows, headers) {
  const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => strip(r[i]).length)));
  const line = (cells) => cells.map((cell, i) => String(cell) + ' '.repeat(widths[i] - strip(cell).length)).join('  ');
  console.log(bold(line(headers)));
  for (const r of rows) console.log(line(r));
}

async function daemon() {
  await ensureDaemon();
}

async function resolveAgent(ref) {
  return api('GET', `/agents/${encodeURIComponent(ref)}`);
}

function printAgent(a) {
  const kv = (k, v) => v != null && v !== '' && console.log(`  ${dim(k.padEnd(12))} ${v}`);
  console.log(`${bold(a.name)} ${dim(`(${a.id})`)}  ${statusLabel(a)}`);
  kv('intent', a.intent);
  kv('session', cyan(a.sessionId));
  kv('folder', a.workdir);
  kv('repo', a.repo);
  if (a.git) kv('branch', `${a.git.branch}${a.git.dirtyFiles ? yellow(` (+${a.git.dirtyFiles} changed)`) : ''}`);
  if (a.git?.head) kv('head', `${a.git.head.sha} ${a.git.head.subject}`);
  kv('branched from', a.baseRef);
  kv('worktree of', a.worktree ? a.sourceDir : null);
  kv('permissions', a.permissionMode !== 'default' ? a.permissionMode : null);
  kv('error', a.error && red(a.error));
  if (a.status === 'preparing' && a.progress) {
    const p = a.progress;
    kv('setup', [p.phase, p.step && `${p.step} ${p.percent}%`, p.size, p.rate].filter(Boolean).join(' · '));
  }
  if (a.status === 'error' && !a.workdir) kv('retry', `agentmgr start ${a.id}`);
  kv('attention', a.runtime.attention && red(`${a.runtime.attention}: run "agentmgr attach ${a.id}" to answer`));
  const u = a.usage;
  if (u?.total) {
    kv('tokens', `${u.total.toLocaleString()} total: ${u.input.toLocaleString()} in, ${u.output.toLocaleString()} out, ` +
      `${u.cacheRead.toLocaleString()} cache read, ${u.cacheCreation.toLocaleString()} cache write (${u.requests} requests)`);
  }
  kv('cost', a.costUsd ? `$${a.costUsd.toFixed(2)} ${dim('(reported by Claude Code)')}` : null);
  if (a.brief) {
    const b = a.brief;
    const icon = { passed: green('✓'), failed: red('✗'), running: yellow('◔'), pending: dim('○') };
    console.log(`  ${dim('Brief')} ${dim(`(updated ${b.updatedAt}; full text: agentmgr brief ${a.id})`)}`);
    if (b.problem) console.log(`    ${bold('Problem')}   ${truncate(b.problem, 200)}`);
    if (b.solution) console.log(`    ${bold('Solution')}  ${truncate(b.solution, 200)}`);
    if (b.diagram) console.log(`    ${bold('Diagram')}   ${dim(`mermaid, ${b.diagram.split('\n').length} lines (rendered in the UI)`)}`);
    for (const r of b.references ?? []) {
      console.log(`    ${r.key ? cyan(r.label) : r.label}: ${r.url ?? ''}${r.highlight ? ` ${dim(`— ${r.highlight}`)}` : ''}`);
    }
    for (const c of b.checks) console.log(`    ${icon[c.state]} ${c.text}`);
  }
  if (a.prs.length) {
    console.log(`  ${dim('PRs')}`);
    for (const p of a.prs) {
      console.log(`    ${p.state ? `[${p.state.toLowerCase()}] ` : ''}${p.url}${p.title ? ` ${dim(p.title)}` : ''} ${dim(`(${p.source})`)}`);
    }
  }
  if (a.bugs.length) {
    console.log(`  ${dim('Bugs')}`);
    for (const b of a.bugs) console.log(`    ${b.key}${b.url && b.url !== b.key ? ` ${dim(b.url)}` : ''} ${dim(`(${b.source})`)}`);
  }
  console.log(`  ${dim('Sessions')}`);
  for (const s of a.sessions) {
    const cur = s.id === a.sessionId ? green('*') : ' ';
    console.log(`   ${cur} ${s.id}  ${dim(s.title ?? '')} ${dim(s.lastActivity ? `last active ${s.lastActivity}` : '')}`);
  }
}

/** Interactive attach: pipes this terminal to the agent's PTY (or its shell). Ctrl-] detaches. */
async function attach(ref, { resume = true, kind = 'claude' } = {}) {
  let agent = await resolveAgent(ref);
  const shell = kind === 'shell';
  if (!shell && !agent.runtime.running && resume) {
    process.stderr.write(dim(`Resuming ${agent.name} (session ${agent.sessionId})…\n`));
    agent = await api('POST', `/agents/${agent.id}/start`, {});
  }
  if (!process.stdin.isTTY) throw new Error('attach needs an interactive terminal');

  const ws = new WebSocket(`ws://${HOST}:${PORT}/ws/term/${agent.id}${shell ? '?kind=shell' : ''}`);
  const what = shell ? `shell for ${agent.name}` : agent.name;
  const send = (msg) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
  const sendSize = () => send({ t: 'r', cols: process.stdout.columns, rows: process.stdout.rows });

  return new Promise((resolve) => {
    let finished = false;
    const finish = (message) => {
      if (finished) return;
      finished = true;
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.off('resize', sendSize);
      // Undo terminal modes claude may have enabled (bracketed paste, focus events, mouse).
      process.stdout.write('\x1b[?2004l\x1b[?1004l\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?25h\x1b[0m\r\n');
      if (message) process.stderr.write(`${message}\n`);
      ws.close();
      resolve();
    };

    ws.on('open', () => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdout.on('resize', sendSize);
      sendSize();
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'hello') {
        process.stdout.write('\x1b[2J\x1b[H');
        process.stdout.write(msg.backlog);
        process.stderr.write(dim(`\x1b]0;agent ${agent.name}\x07`));
      } else if (msg.t === 'o') {
        process.stdout.write(msg.d);
      } else if (msg.t === 'exit') {
        finish(
          dim(
            shell
              ? '[shell exited]'
              : `[agent exited (code ${msg.code}). Session ${agent.sessionId} kept; run "agentmgr attach ${agent.id}" to resume]`,
          ),
        );
      }
    });
    ws.on('close', () => finish(dim(`[detached from ${what}; it keeps running in the background]`)));
    ws.on('error', (err) => finish(red(`connection error: ${err.message}`)));

    process.stdin.on('data', (buf) => {
      const i = buf.indexOf(0x1d); // Ctrl-]
      if (i >= 0) {
        if (i > 0) send({ t: 'i', d: buf.subarray(0, i).toString('utf8') });
        return finish(dim(`[detached from ${what}; it keeps running in the background]`));
      }
      send({ t: 'i', d: buf.toString('utf8') });
    });
  });
}

function readIntentsFile(file) {
  const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

export async function main(argv) {
  const program = new Command();
  program
    .name('agentmgr')
    .description('Run and track background Claude Code agents, one per intent.')
    .showHelpAfterError();

  program
    .command('serve')
    .description('Run the agent daemon (API + web UI) in the foreground')
    .action(async () => {
      if (await isRunning()) {
        // Clean exit, so a login service doesn't keep retrying while another daemon owns the port.
        return console.log(`[agentmgr] a daemon is already running at ${BASE}; not starting another`);
      }
      const { startServer } = await import('./server.js');
      const { url } = await startServer();
      console.log(`[agentmgr] listening on ${url}`);
    });

  program
    .command('ui')
    .description('Open the web UI (starts the daemon if needed)')
    .action(async () => {
      await daemon();
      console.log(BASE);
      execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [BASE], () => {});
    });

  program
    .command('add')
    .description('Spawn one agent per intent')
    .argument('[intents...]', 'intents, each a quoted string')
    .option('-r, --repo <url>', 'git repository URL to clone (each agent gets its own worktree)')
    .option('-d, --dir <path>', 'existing working folder')
    .option('-f, --file <path>', 'read intents from a file, one per line ("-" for stdin)')
    .option('-n, --name <name>', 'display name')
    .option('-w, --worktree', 'give each agent its own git worktree of --dir')
    .option('-b, --base <ref>', "branch each agent from this branch, tag or SHA (default: the repo's default branch, fetched)")
    .option('--no-worktree', 'run all agents directly in --dir')
    .addOption(
      new Option('-p, --permission-mode <mode>', 'claude permission mode').choices([
        'default',
        'acceptEdits',
        'plan',
        'auto',
        'bypassPermissions',
      ]),
    )
    .option('-m, --model <model>', 'claude model')
    .option('--plan', 'while a repo URL clones, plan the task with Claude (moves into the repo when ready)')
    .option('--no-start', 'create without launching')
    .option('-a, --attach', 'attach to the agent after launch (single intent only)')
    .action(async (intents, opts, cmd) => {
      if (opts.file) intents = [...intents, ...readIntentsFile(opts.file)];
      if (!intents.length) throw new Error('Give at least one intent, or --file');
      await daemon();
      // commander sets worktree=true for --no-worktree's default; only send it when the user chose.
      const worktreeSource = cmd.getOptionValueSource('worktree');
      const created = await api('POST', '/agents', {
        intents,
        repo: opts.repo,
        dir: opts.dir,
        name: opts.name,
        worktree: worktreeSource === 'cli' ? opts.worktree : undefined,
        base: opts.base,
        permissionMode: opts.permissionMode,
        model: opts.model,
        start: opts.start,
        plan: opts.plan,
      });
      for (const a of created) console.log(`${green('+')} ${bold(a.name)} ${dim(a.id)}  session ${cyan(a.sessionId)}`);
      console.log(dim(`Workspace setup and launch continue in the background. "agentmgr ls" shows status.`));
      if (opts.attach && created.length === 1) {
        let a = created[0];
        for (let i = 0; i < 600 && a.status === 'preparing' && !a.runtime.running; i++) {
          await new Promise((r) => setTimeout(r, 500));
          a = await resolveAgent(a.id);
        }
        if (a.status === 'error') throw new Error(a.error);
        await attach(a.id);
      }
    });

  program
    .command('ask')
    .description('Open a general Claude session (no repo or folder) and attach to it')
    .argument('[question...]', 'optional first question')
    .option('-n, --name <name>', 'display name')
    .option('-m, --model <model>', 'claude model')
    .option('--no-attach', 'start it in the background only')
    .action(async (words, opts) => {
      await daemon();
      let a = await api('POST', '/general', { question: words.join(' '), name: opts.name, model: opts.model });
      console.log(`${green('+')} ${bold(a.name)} ${dim(a.id)}  session ${cyan(a.sessionId)}`);
      for (let i = 0; i < 100 && a.status === 'preparing'; i++) {
        await new Promise((r) => setTimeout(r, 100));
        a = await resolveAgent(a.id);
      }
      if (opts.attach) await attach(a.id);
    });

  program
    .command('brief')
    .description("Print the agent's brief (Problem, Solution, Diagram, Checks) as Markdown")
    .argument('<agent>')
    .action(async (ref) => {
      await daemon();
      const a = await resolveAgent(ref);
      const res = await api('GET', `/agents/${a.id}/brief`);
      if (!res.markdown) return console.log(dim(`No brief yet (${res.path})`));
      process.stdout.write(res.markdown.endsWith('\n') ? res.markdown : `${res.markdown}\n`);
    });

  program
    .command('plan')
    .description('While the workspace is still being prepared, plan the task with Claude and attach')
    .argument('<agent>')
    .action(async (ref) => {
      await daemon();
      const a = await resolveAgent(ref);
      await api('POST', `/agents/${a.id}/plan`);
      await attach(a.id, { resume: false });
    });

  program
    .command('handoff')
    .description('Move a planning session into its ready workspace now')
    .argument('<agent>')
    .action(async (ref) => {
      await daemon();
      const a = await resolveAgent(ref);
      const res = await api('POST', `/agents/${a.id}/handoff`);
      console.log(`${green('▶')} ${res.name} continues in ${res.workdir} (session ${cyan(res.sessionId)})`);
    });

  program
    .command('shell')
    .description("Open a shell in the agent's folder, for running commands by hand. Ctrl-] detaches.")
    .argument('<agent>')
    .action(async (ref) => {
      await daemon();
      await attach(ref, { kind: 'shell' });
    });

  const service = program.command('service').description('Start the daemon at login so agents come back after a reboot');
  service
    .command('install')
    .description('Register the daemon with launchd (macOS) or systemd --user (Linux) and start it')
    .action(async () => {
      const svc = await import('./service.js');
      if (await isRunning()) {
        // Hand over to the service-managed daemon; running agents are resumed by it.
        await api('POST', '/shutdown');
        for (let i = 0; i < 50 && (await isRunning()); i++) await new Promise((r) => setTimeout(r, 200));
      }
      const res = await svc.install();
      for (let i = 0; i < 100 && !(await isRunning()); i++) await new Promise((r) => setTimeout(r, 200));
      console.log(`${green('✓')} installed ${res.manager} service: ${res.file}`);
      console.log((await isRunning()) ? `  daemon is up at ${BASE}` : yellow('  daemon did not come up yet; check the log'));
      if (res.note) console.log(`  ${res.note}`);
    });
  service
    .command('uninstall')
    .description('Remove the login service (stops the daemon; agents resume next time it starts)')
    .action(async () => {
      const res = await (await import('./service.js')).uninstall();
      console.log(`removed ${res.file}`);
    });
  service
    .command('status')
    .description('Show whether the login service is installed and running')
    .action(async () => {
      const st = await (await import('./service.js')).status();
      console.log(`service ${st.installed ? green('installed') : dim('not installed')}${st.installed ? `, ${st.loaded ? green('loaded') : yellow('not loaded')}` : ''}  ${dim(st.file ?? '')}`);
      console.log(`daemon  ${(await isRunning()) ? green(`running at ${BASE}`) : dim('not running')}`);
    });

  program
    .command('ls')
    .alias('list')
    .description('List agents')
    .option('--json', 'machine-readable output')
    .action(async (opts) => {
      await daemon();
      const agents = await api('GET', '/agents');
      if (opts.json) return console.log(JSON.stringify(agents, null, 2));
      if (!agents.length) return console.log('No agents yet. Try: agentmgr add "fix the flaky login test" -d .');
      table(
        agents.map((a) => [
          a.id,
          truncate(a.kind === 'general' ? `${a.name} (general)` : a.name, 28),
          statusLabel(a),
          a.git?.branch ?? '',
          String(a.prs.length || ''),
          String(a.bugs.length || ''),
          fmtTokens(a.usage?.total),
          a.sessionId.slice(0, 8),
          truncate(a.workdir ?? '', 50),
        ]),
        ['ID', 'NAME', 'STATUS', 'BRANCH', 'PRS', 'BUGS', 'TOKENS', 'SESSION', 'FOLDER'],
      );
    });

  program
    .command('show')
    .description('Show everything tracked for an agent')
    .argument('<agent>', 'agent id, id prefix or name')
    .option('--json', 'machine-readable output')
    .action(async (ref, opts) => {
      await daemon();
      const a = await resolveAgent(ref);
      if (opts.json) return console.log(JSON.stringify(a, null, 2));
      printAgent(a);
    });

  program
    .command('attach')
    .description('Open the agent terminal here (resumes it if closed). Ctrl-] detaches.')
    .argument('<agent>')
    .option('--no-resume', 'do not resume a closed agent')
    .action(async (ref, opts) => {
      await daemon();
      await attach(ref, opts);
    });

  program
    .command('start')
    .alias('resume')
    .description('Bring a closed agent back, resuming its session')
    .argument('<agent>')
    .option('--fresh', 'start a new session (the old session IDs are kept)')
    .option('-s, --session <id>', 'resume a specific earlier session of this agent')
    .action(async (ref, opts) => {
      await daemon();
      const a = await resolveAgent(ref);
      const res = await api('POST', `/agents/${a.id}/start`, { fresh: opts.fresh, sessionId: opts.session });
      console.log(`${green('▶')} ${res.name} running session ${cyan(res.sessionId)}`);
    });

  program
    .command('stop')
    .alias('close')
    .description('Close agent sessions (session IDs are kept for resuming)')
    .argument('[agents...]')
    .option('--all', 'stop every running agent')
    .action(async (refs, opts) => {
      await daemon();
      const targets = opts.all ? (await api('GET', '/agents')).filter((a) => a.runtime.running) : await Promise.all(refs.map(resolveAgent));
      if (!targets.length) throw new Error('Nothing to stop');
      for (const a of targets) {
        await api('POST', `/agents/${a.id}/stop`);
        console.log(`${yellow('■')} ${a.name} closed; resume with: agentmgr start ${a.id}`);
      }
    });

  program
    .command('rm')
    .description('Forget agents (optionally deleting worktrees agentmgr created)')
    .argument('<agents...>')
    .option('--delete-workspace', 'also remove the worktree / folder agentmgr created')
    .action(async (refs, opts) => {
      await daemon();
      for (const ref of refs) {
        const a = await resolveAgent(ref);
        const res = await api('DELETE', `/agents/${a.id}${opts.deleteWorkspace ? '?deleteWorkspace=1' : ''}`);
        console.log(`${red('×')} removed ${a.name}`);
        for (const w of res.warnings) console.log(`  ${yellow(w)}`);
      }
    });

  program
    .command('sessions')
    .description('List all session IDs an agent has used')
    .argument('<agent>')
    .action(async (ref) => {
      await daemon();
      const a = await resolveAgent(ref);
      table(
        a.sessions.map((s) => [
          s.id === a.sessionId ? green(`${s.id} *`) : s.id,
          truncate(s.title ?? '', 40),
          fmtTokens(s.usage?.total),
          s.cost?.usd != null ? `$${s.cost.usd.toFixed(2)}` : '',
          s.lastActivity ?? '',
        ]),
        ['SESSION', 'TITLE', 'TOKENS', 'COST', 'LAST ACTIVITY'],
      );
      console.log(dim(`\nOutside agentmgr: cd ${a.workdir} && claude --resume <session>`));
    });

  program
    .command('link')
    .description('Associate a PR or bug with an agent')
    .argument('<agent>')
    .option('--pr <url>', 'pull request URL')
    .option('--bug <ref>', 'bug key or URL (e.g. MB-12345)')
    .option('--title <title>')
    .action(async (ref, opts) => {
      if (!opts.pr && !opts.bug) throw new Error('Give --pr or --bug');
      await daemon();
      const a = await resolveAgent(ref);
      if (opts.pr) await api('POST', `/agents/${a.id}/links`, { type: 'pr', value: opts.pr, title: opts.title });
      if (opts.bug) await api('POST', `/agents/${a.id}/links`, { type: 'bug', value: opts.bug, title: opts.title });
      console.log(`linked to ${a.name}`);
    });

  program
    .command('unlink')
    .description('Remove a PR or bug association')
    .argument('<agent>')
    .option('--pr <url>')
    .option('--bug <key>')
    .action(async (ref, opts) => {
      await daemon();
      const a = await resolveAgent(ref);
      if (opts.pr) await api('DELETE', `/agents/${a.id}/links?type=pr&key=${encodeURIComponent(opts.pr)}`);
      if (opts.bug) await api('DELETE', `/agents/${a.id}/links?type=bug&key=${encodeURIComponent(opts.bug)}`);
      console.log(`unlinked from ${a.name}`);
    });

  program
    .command('refresh')
    .description('Re-scan git, PRs and transcripts for an agent now')
    .argument('<agent>')
    .action(async (ref) => {
      await daemon();
      const a = await resolveAgent(ref);
      printAgent(await api('POST', `/agents/${a.id}/refresh`));
    });

  program
    .command('shutdown')
    .description('Stop the daemon (running agents are closed; sessions are kept)')
    .action(async () => {
      if (!(await isRunning())) return console.log('Daemon is not running');
      await api('POST', '/shutdown');
      console.log('Daemon stopped');
    });

  try {
    await program.parseAsync(argv);
  } catch (err) {
    console.error(red(`agentmgr: ${err.message}`));
    process.exitCode = 1;
  }
}

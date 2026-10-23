#!/usr/bin/env node
// Stand-in for the codex CLI (0.163 shapes, see test/fixtures/codex): records its argv,
// writes a session log where Codex would ($CODEX_HOME/sessions/YYYY/MM/DD), picks its own
// session ID, echoes input, and draws Codex's approval menu for "#ask".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME;
const WITH_VALUE = new Set(['--sandbox', '-s', '--ask-for-approval', '-a', '--model', '-m', '--add-dir', '-c', '--config', '--color']);

if (args[0] === 'exec') {
  // Explain / documents: one read-only, unsaved call; the prompt arrives on stdin.
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    const safe = args.includes('--ephemeral') && args[args.indexOf('--sandbox') + 1] === 'read-only';
    if (input.startsWith('You are an independent reviewer')) {
      const review = JSON.parse(input.match(/<review>\n([\s\S]*?)\n<\/review>/)[1]);
      const reply = {
        ai: review.ai.map(() => ({ verdict: safe ? 'disagree' : 'agree', note: 'The log shows a failing test.' })),
        human: review.human.map((_, i) => ({ verdict: i === 0 ? 'ai' : 'keep', note: i === 0 ? 'The ticket says A.' : 'Fine.' })),
        missing: [{ question: 'Who owns the rollout?', for: 'human', why: 'Not in the context.' }],
        summary: 'Check the tests yourself.',
      };
      process.stdout.write(JSON.stringify(reply), () => process.exit(0));
      return;
    }
    const intent = input.match(/<intent>\n([\s\S]*?)\n<\/intent>/)?.[1] ?? '';
    process.stdout.write(`### The ask\n${safe ? 'Safe call.' : 'UNSAFE call.'} Intent: ${intent}\n### Where it stands\nfrom codex\n### Conclusions so far\nsaw: ${input.includes('[agent] Working on it')}\n`, () => process.exit(0));
  });
  await new Promise(() => {});
}

const resume = args[0] === 'resume';
const rest = resume ? args.slice(1) : args;
const positional = [];
const opt = {};
for (let i = 0; i < rest.length; i++) {
  if (WITH_VALUE.has(rest[i])) opt[rest[i]] = rest[++i];
  else if (rest[i].startsWith('-')) opt[rest[i]] = true;
  else positional.push(rest[i]);
}
fs.appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ cwd: process.cwd(), args }) + '\n');

const now = new Date();
let sid;
let file;
if (resume) {
  sid = positional[0];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  file = walk(path.join(home, 'sessions')).find((f) => f.endsWith(`-${sid}.jsonl`));
} else {
  sid = crypto.randomUUID();
  const dir = path.join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, `rollout-${now.toISOString().slice(0, 19).replace(/:/g, '-')}-${sid}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ timestamp: now.toISOString(), type: 'session_meta', payload: { id: sid, cwd: process.cwd(), cli_version: 'fake', source: 'cli', base_instructions: { text: 'x'.repeat(40_000) } } }) + '\n');
}
const write = (payload) => fs.appendFileSync(file, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg', payload }) + '\n');
const item = (it) => write({ type: 'item_completed', item: it });
const prompt = resume ? positional[1] ?? '' : positional[0] ?? '';
const task = prompt.split('Your task:\n').at(-1);

if (prompt) item({ type: 'UserMessage', content: [{ type: 'text', text: prompt }] });
item({ type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'gh pr create --fill'], aggregated_output: 'https://github.com/example/repo/pull/9\n', exit_code: 0 });
write({ type: 'token_count', info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 0, output_tokens: 7, total_tokens: 107 } } });
item({ type: 'AgentMessage', content: [{ type: 'Text', text: 'Working on it, see https://jira.example.com/browse/MB-77' }] });
if (task.includes('#stuck')) {
  for (let i = 0; i < 3; i++) item({ type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'npm test'], aggregated_output: 'FAIL auth.test.js: expected 200, got 401\n', exit_code: 1 });
}
const briefDir = opt['--add-dir'];
if (briefDir && !resume) {
  fs.writeFileSync(path.join(briefDir, 'BRIEF.md'), `# Brief\n${task.includes('#done') ? 'Status: done' : 'Status: working'}\n## Problem\nFrom Codex.\n`);
}
if (task.includes('#ask')) {
  setTimeout(
    () =>
      process.stdout.write(
        '\r\n  Would you like to run the following command?\r\n\r\n  $ npm test\r\n\r\n› 1. Yes, proceed (y)\r\n  2. Yes, and don\'t ask again for commands that start with `npm test` (p)\r\n  3. No, and tell Codex what to do differently (esc)\r\n\r\n  Press enter to confirm or esc to cancel\r\n',
      ),
    200,
  );
}
process.stdout.write(`fake-codex ready ${resume ? 'resumed' : 'new'} ${sid}\r\n`);
process.stdin.setRawMode?.(true);
process.stdin.on('data', (d) => {
  const s = d.toString();
  if (s.includes('exit')) process.exit(3);
  process.stdout.write(`echo:${s}`);
});
process.on('SIGHUP', () => process.exit(0));

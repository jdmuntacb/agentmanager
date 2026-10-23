#!/usr/bin/env node
// Stand-in for Antigravity CLI (agy 1.4.3 shapes, see test/fixtures/antigravity): records its
// argv, writes a conversation transcript where agy would ($ANTIGRAVITY_CLI_HOME/brain/<id>/...),
// keeps cache/last_conversations.json, echoes input, and draws agy's command menu for "#ask".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const home = process.env.ANTIGRAVITY_CLI_HOME;
const WITH_VALUE = new Set(['--conversation', '--mode', '--model', '--add-dir', '--print-timeout', '-i', '--prompt-interactive', '-p', '--print']);
const opt = {};
for (let i = 0; i < args.length; i++) {
  const eq = args[i].indexOf('=');
  if (args[i].startsWith('-') && eq > 0) opt[args[i].slice(0, eq)] = args[i].slice(eq + 1);
  else if (WITH_VALUE.has(args[i])) opt[args[i]] = args[++i];
  else if (args[i].startsWith('-')) opt[args[i]] = true;
}
fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify({ cwd: process.cwd(), args }) + '\n');

const printPrompt = opt['--print'] ?? opt['-p'];
if (printPrompt !== undefined) {
  // Explain / documents: print mode, plan mode, prompt attached to the flag.
  const safe = opt['--mode'] === 'plan';
  const intent = printPrompt.match(/<intent>\n([\s\S]*?)\n<\/intent>/)?.[1] ?? '';
  process.stdout.write(`### The ask\n${safe ? 'Safe call.' : 'UNSAFE call.'} Intent: ${intent}\n### Where it stands\nfrom agy\n### Conclusions so far\nsaw: ${printPrompt.includes('[agent] Working on it')}\n`, () => process.exit(0));
} else {
  const resume = Boolean(opt['--conversation']);
  const id = resume ? opt['--conversation'] : crypto.randomUUID();
  const file = path.join(home, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cacheFile = path.join(home, 'cache', 'last_conversations.json');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  cache[process.cwd()] = id;
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));

  let step = resume ? fs.readFileSync(file, 'utf8').trim().split('\n').length : 0;
  const write = (rec) => fs.appendFileSync(file, JSON.stringify({ step_index: step++, status: 'DONE', created_at: new Date().toISOString(), ...rec }) + '\n');
  const prompt = opt['--prompt-interactive'] ?? opt['-i'] ?? '';
  const task = prompt.split('Your task:\n').at(-1);
  const command = (cmd, code, output) => {
    write({ source: 'MODEL', type: 'PLANNER_RESPONSE', input_tokens: 100, cache_read_tokens: 60, output_tokens: 7, tool_calls: [{ name: 'run_command', args: { CommandLine: cmd, WaitMsBeforeAsync: 5000 } }] });
    write({ source: 'MODEL', type: 'GENERIC', content: `Created At: x\nCompleted At: x\nCommand exited with code ${code}.\n\nCommand output:\n${output}` });
  };

  if (prompt) write({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: x.\n</ADDITIONAL_METADATA>` });
  command('gh pr create --fill', 0, 'https://github.com/example/repo/pull/9\r\n');
  write({ source: 'MODEL', type: 'PLANNER_RESPONSE', input_tokens: 0, output_tokens: 0, content: 'Working on it, see https://jira.example.com/browse/MB-77' });
  if (task.includes('#stuck')) for (let i = 0; i < 3; i++) command('npm test', 1, 'FAIL auth.test.js: expected 200, got 401\r\n');
  const briefDir = opt['--add-dir'];
  if (briefDir && !resume) fs.writeFileSync(path.join(briefDir, 'BRIEF.md'), `# Brief\n${task.includes('#done') ? 'Status: done' : 'Status: working'}\n## Problem\nFrom Antigravity.\n`);
  if (task.includes('#ask')) {
    setTimeout(
      () =>
        process.stdout.write(
          '\r\n Command \r\n────────────\r\n Requesting permission for: \r\n npm test \r\n Run this command? \r\n > 1. Yes, run command \r\n 2. Yes, and always allow in this conversation for commands that start with \'npm\' \r\n 3. Yes, and always allow for commands that start with \'npm\' (Persist to settings.json) \r\n 4. No, cancel \r\n ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command \r\n esc to cancel Gemini 3.8 Flash · high \r\n',
        ),
      200,
    );
  }
  process.stdout.write(`fake-agy ready ${resume ? 'resumed' : 'new'} ${id}\r\n`);
  process.stdin.setRawMode?.(true);
  process.stdin.on('data', (d) => {
    const s = d.toString();
    if (s.includes('exit')) process.exit(3);
    process.stdout.write(`echo:${s}`);
  });
  process.on('SIGHUP', () => process.exit(0));
}

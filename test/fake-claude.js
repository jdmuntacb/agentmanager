#!/usr/bin/env node
// Stand-in for the claude CLI: records its argv, writes a transcript where
// Claude Code would, echoes input, and exits on "exit" or SIGHUP.
import fs from 'node:fs';
import path from 'node:path';
import { transcriptPath } from '../src/tracker.js';

const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const sid = flag('--session-id') ?? flag('--resume');
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ cwd: process.cwd(), args }) + '\n');

const file = transcriptPath(process.cwd(), sid);
fs.mkdirSync(path.dirname(file), { recursive: true });
const write = (rec) => fs.appendFileSync(file, JSON.stringify({ sessionId: sid, ...rec }) + '\n');
write({ type: 'ai-title', aiTitle: 'Fake session title' });
write({
  type: 'assistant',
  message: {
    id: `msg_${Date.now()}`,
    usage: { input_tokens: 12, output_tokens: 34, cache_creation_input_tokens: 56, cache_read_input_tokens: 78 },
    content: [{ type: 'text', text: 'Looking at https://jira.example.com/browse/MB-4242 now' }],
  },
});
write({ type: 'pr-link', prNumber: 7, prUrl: 'https://github.com/example/repo/pull/7' });

process.stdout.write(`fake-claude ready ${args.includes('--resume') ? 'resumed' : 'new'} ${sid}\r\n`);
process.stdin.setRawMode?.(true);
process.stdin.on('data', (d) => {
  const s = d.toString();
  if (s.includes('exit')) process.exit(3);
  process.stdout.write(`echo:${s}`);
});
process.on('SIGHUP', () => process.exit(0));

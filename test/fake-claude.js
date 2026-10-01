#!/usr/bin/env node
// Stand-in for the claude CLI: records its argv, writes a transcript where
// Claude Code would, echoes input, and exits on "exit" or SIGHUP.
import fs from 'node:fs';
import path from 'node:path';
import { transcriptPath } from '../src/tracker.js';

const args = process.argv.slice(2);
if (args.includes('-p')) {
  // Explain: a one-shot call that must have no tools and no MCP servers.
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    const ok = args[args.indexOf('--tools') + 1] === '' && args.includes('--strict-mcp-config');
    const intent = input.match(/<intent>\n([\s\S]*?)\n<\/intent>/)?.[1];
    process.stdout.write(`### In one line\n${ok ? 'Safe call.' : 'UNSAFE call.'} Intent: ${intent}\n### The intent\nx\n`, () => process.exit(0));
  });
  await new Promise(() => {});
}
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

const briefDir = flag('--add-dir');
if (briefDir) {
  fs.writeFileSync(
    path.join(briefDir, 'BRIEF.md'),
    [
      '# Brief',
      '## Problem',
      'Login fails for **SSO** users.',
      '## Solution',
      'Fix the token refresh in `auth/session.go`.',
      '## Diagram',
      '```mermaid',
      'flowchart LR',
      '  A[Browser] --> B[Auth service]',
      '```',
      'Token flow after the fix.',
      '## References',
      '- **PRD**: [SSO login PRD](https://confluence.example.com/prd/42) — sessions must survive token rotation',
      '- **Tech Spec**: none on MB-4242',
      '## Checks',
      '- [x] go test ./auth/...',
      '- [!] e2e login suite',
      '- [~] lint',
      '- [ ] manual SSO login',
      '',
    ].join('\n'),
  );
}
process.stdout.write(`fake-claude ready ${args.includes('--resume') ? 'resumed' : 'new'} ${sid}\r\n`);
process.stdin.setRawMode?.(true);
process.stdin.on('data', (d) => {
  const s = d.toString();
  if (s.includes('exit')) process.exit(3);
  process.stdout.write(`echo:${s}`);
});
process.on('SIGHUP', () => process.exit(0));

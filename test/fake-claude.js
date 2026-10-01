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
    const section = (tag) => input.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`))?.[1] ?? '';
    const conv = section('conversation');
    const doc = input.match(/^Write a (\w+) document/)?.[1];
    if (doc) {
      process.stdout.write(
        `# ${doc}: ${section('intent')}\n## Summary\n${ok ? 'Safe call.' : 'UNSAFE call.'}\n## Architecture\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n`,
        () => process.exit(0),
      );
      return;
    }
    if (/Why[\s\S]*What[\s\S]*How[\s\S]*Now/.test(input.split('<agent_status>')[0])) {
      process.stdout.write(
        `### Why\n- ${ok ? 'Safe call' : 'UNSAFE'}: ${section('intent')}\n### What\n- One\n### How\n- Two\n### Now\n- saw agent text: ${conv.includes('[agent] Looking at')}\n`,
        () => process.exit(0),
      );
      return;
    }
    process.stdout.write(
      `### The ask\n${ok ? 'Safe call.' : 'UNSAFE call.'} Intent: ${section('intent')}\n` +
        `### Where it stands\n${section('agent_status').split('\n')[0]}\n` +
        `### Conclusions so far\nsaw agent text: ${conv.includes('[agent] Looking at')}; repo: ${section('repository').split('\n')[0]}\n`,
      () => process.exit(0),
    );
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
      // "#done" in the intent: act as if the task is finished.
      (args.includes('--') && args[args.indexOf('--') + 1]?.includes('#done')) || process.env.FAKE_DONE ? 'Status: done' : 'Status: working',
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
      '## Results',
      'Outcome: blocked',
      '- Delivered: Root cause found in `auth/session.go`',
      '- Blocked by: staging credentials (needs: platform team)',
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
if (args.includes('--') && args[args.indexOf('--') + 1]?.includes('#ask')) {
  setTimeout(() => process.stdout.write('\r\nDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\n'), 200);
}
process.stdout.write(`fake-claude ready ${args.includes('--resume') ? 'resumed' : 'new'} ${sid}\r\n`);
process.stdin.setRawMode?.(true);
process.stdin.on('data', (d) => {
  const s = d.toString();
  if (s.includes('exit')) process.exit(3);
  process.stdout.write(`echo:${s}`);
});
process.on('SIGHUP', () => process.exit(0));

# Design: several agent engines (Claude Code, Codex CLI, Gemini CLI)

Status: phase 1, Codex and Antigravity built. Gemini CLI dropped: since June 18, 2026 it no longer serves personal Google accounts, and Antigravity CLI (`agy`, `src/engines/antigravity.js`, checked against 1.4.3, fixtures in `test/fixtures/antigravity/`) replaced it. 0.4 (branch `v0.4-engines`) · 2026-10-18. Targets the current releases of each CLI, checked in phase 1.

Agent Manager runs every agent with Claude Code. If Anthropic has an outage, a rate limit hits, or prices change, every agent stops at once. Running agents on other engines as well makes the fleet resilient across providers, and lets each task use the engine that suits it.

## Goals

- **Same workflow, any engine:** create, watch, answer, message, review and merge agents the same way whether they run Claude Code, OpenAI's Codex CLI or Google's Gemini CLI.
- **Choose per agent:** a default engine, overridable per agent, per project and per backlog item.
- **Fail over:** when an engine is down or rate-limited, new work goes to another engine instead of waiting.
- **Honest UI:** features an engine can't support (for example a cost figure) are hidden for its agents, not faked.

## Non-goals

- **Moving a live conversation between engines.** Conversations stay with their engine. A task can continue on another engine through a handoff (below), which carries the work but not the chat history.
- **Editor-based agents** (Antigravity, Cursor, and so on). Agent Manager drives command-line agents in a terminal.
- **Running models directly through APIs.** Each engine keeps its own CLI, sign-in, tools and safety settings.

## What is Claude-specific today

| Area | Where | What it relies on |
| --- | --- | --- |
| Launch and resume | `manager.js` `start`, `baseArgs`, `spawnClaude` | `--session-id` (an ID we choose up front), `--resume`, `--name`, `--permission-mode`, `--model`, `--add-dir`, `--allowedTools`, `--append-system-prompt` |
| Transcripts | `tracker.js`, `stuck.js` | `~/.claude/projects/<cwd>/<session>.jsonl`: tokens, cost, PR and bug links, activity, subagents |
| Planning handoff | `manager.js` `moveTranscript` | Moving a transcript between folders so the same session continues in the repo |
| Inbox prompts | `inbox.js` `promptChoices` | The layout of Claude Code's numbered choice prompts on screen |
| Folder trust | `trust.js` | `~/.claude.json` `hasTrustDialogAccepted` |
| Brief and questions | `brief.js`, `inbox.js` | Claude writing `BRIEF.md` / `QUESTIONS.md` in a folder outside the repo that it was allowed to write to |
| Explain, insights, documents | `brief.js` prompts, run through `claude -p` | A tool-less one-shot call |
| Config | `config.js` | `claudeBin`, `claudeArgs`, `permissionMode` |

Everything else is engine-neutral: clones, worktrees and branches, the backlog, PR tracking, the conflict radar (git diffs), races, checkpoints (git; the transcript copy is engine-specific), terminals and the hub.

## The engine adapter

Each engine is one module in `src/engines/` that implements the same small interface. The manager calls the adapter instead of building Claude flags itself.

```js
export default {
  id: 'codex',                       // 'claude' | 'codex' | 'gemini'
  label: 'Codex',
  bin: (config) => config.engines?.codex?.bin ?? 'codex',

  // What the UI may offer for this engine's agents.
  supports: { resume: true, chooseSessionId: false, cost: false, tokens: true, prompts: true,
              planHandoff: false, fork: false, permissionModes: ['default', 'acceptEdits', 'plan'] },

  /** Arguments for a new session, or for resuming one. */
  launch({ agent, workdir, sessionId, resume, prompt, instructions, writableDirs }) { /* -> { args, env } */ },

  /** After a new launch: find the session the engine created (for engines that pick their own IDs). */
  discoverSession({ workdir, startedAt }) { /* -> sessionId | null */ },

  /** Incremental scan of the session log: usage, links, activity events for stuck detection. */
  scan({ workdir, sessionId, cursor }) { /* -> { cursor, usage, prs, bugs, events, lastActivityAt } */ },

  /** A numbered choice prompt visible on screen, if any: [{ key, label }]. */
  promptChoices(screenText) {},

  /** Make the folder trusted for the engine, if it asks. */
  trust(dir) {},

  /** One-shot, tool-less call for Explain and documents. */
  oneShot({ prompt, model }) { /* -> { args } */ },

  /** Is the engine usable right now? Installed, signed in, not rate-limited. */
  async health() {},
};
```

`claude.js` is today's behaviour moved behind the interface, so nothing changes for existing agents. Each agent gets an `engine` field (default `claude`, so existing state needs no migration).

## The engines

Gemini CLI flags are checked against 0.64.0 (`test/fixtures/gemini/help-0.64.0.txt`) and Codex against codex-cli 0.163.0 (`test/fixtures/codex/`: help texts, a scrubbed session log, and recorded trust and approval screens). Both CLIs change quickly, so adapters check `--version` and the fixtures are refreshed on upgrades.

| | Claude Code | Codex CLI | Gemini CLI |
| --- | --- | --- | --- |
| Start with a task | `claude --session-id <id> -- "<task>"` | `codex --no-alt-screen … "<task>"` | `gemini --session-id <uuid> -i "<task>"` (interactive after the first prompt) |
| Resume | `--resume <id>` | `codex resume [options] <id>` | `--resume <id or index>` |
| Session ID | Chosen by us | Picked by Codex; adopted from the new session log in the agent's folder (its first line, `session_meta`, records the folder and is often 20+ KB) | Chosen by us (`--session-id <uuid>`, 0.64) |
| Session logs | `~/.claude/projects/…/*.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `~/.gemini/tmp/<project hash>/chats/` |
| Project instructions | `CLAUDE.md` | `AGENTS.md` | `GEMINI.md` |
| Extra instructions per launch | `--append-system-prompt` | none: config override, or the first message | none: the first message (`GEMINI_SYSTEM_MD` replaces the whole system prompt, so it isn't used) |
| Extra writable folder | `--add-dir` + `--allowedTools` | `--add-dir` (newer versions) or sandbox `writable_roots` | `--include-directories`, plus a `--policy` file allowing writes there |
| Folder trust | `~/.claude.json` | `~/.codex/config.toml` trusted projects | `--skip-trust` (this session only) |
| Model | `--model` | `-m` | `-m` |
| Cost | Recorded by Claude Code | Tokens only (`token_count` events; cached input is counted inside input, so it is subtracted) | Tokens only |
| Rate limits | — | In every `token_count` event (`rate_limits.primary.used_percent`, `rate_limit_reached_type`): the input for fail over | — |

### Permission modes

Agent Manager's three modes map to each engine's own approval settings. The hub's rule stays: no mode that skips all prompts can be started from the hub.

| Agent Manager | Claude Code | Codex CLI | Gemini CLI |
| --- | --- | --- | --- |
| `default` (ask) | `default` | `--sandbox workspace-write --ask-for-approval on-request` (0.163 only has `on-request` and `never`) | `--approval-mode default` |
| `acceptEdits` | `acceptEdits` | the same: edits inside the workspace never ask | `--approval-mode auto_edit` |
| `plan` | `plan` | `--sandbox read-only --ask-for-approval on-request` | `--approval-mode plan` (read-only) |
| skip all (local only) | `bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` | `--yolo` |

### Briefs and questions

The brief and questions files are what make an agent reviewable from the inbox, so every engine needs them.

- **Instructions:** today they go in `--append-system-prompt`. Codex and Gemini have no per-launch system prompt flag, so the instructions go in the first message of a new session, and are repeated briefly on resume (in the resume message where the engine accepts one). Writing them into the repo's `AGENTS.md`/`GEMINI.md` is rejected: that would change the user's repo.
- **Writing outside the repo:** Codex's sandbox only writes inside the workspace by default. Options, in order of preference:
  1. Allow the brief folder as an extra writable root (`--add-dir` or `writable_roots`).
  2. Have the agent write `.agentmgr/BRIEF.md` inside its worktree, add `.agentmgr/` to the worktree's local git excludes (`.git/info/exclude` of the worktree, never the repo's `.gitignore`), and have Agent Manager read it from there.
- **Parsing** (`parseBrief`, `parseQuestions`) is already engine-neutral.

### Usage, activity and stuck detection

`scan()` turns each engine's log into the same events: usage totals, PR and bug links from tool output, and tool-call/result pairs for stuck detection (`stuck.js` takes events, not Claude records). Engines without a cost figure show tokens only. If an engine's log format can't be read, the agent still works, without usage and stuck findings, and the UI says so.

### Inbox prompts

`promptChoices` reads the terminal screen. Each adapter gets its own pattern, backed by recorded screen fixtures in the tests. Pressing a digit or Esc goes through the same `prompt-key` action, so the hub needs no change.

### Explain and documents

These one-shot calls default to the agent's own engine (`oneShot`), and fall back to any healthy engine, since they only need the transcript digest and brief.

## Fail over across providers

- **Engine health:** each daemon checks every configured engine: installed, signed in, and recent failures. A run of authentication errors, rate-limit messages or crashes on launch marks it *degraded* for a cool-down. The adapter supplies the patterns it recognizes.
- **New work:** an item can ask for one engine, a preference list (`["claude", "codex"]`), or `any`. The local backlog and the hub's shared backlog skip degraded engines, and each machine reports its engines to the hub as labels (`engine:codex`), so placement works as it does for other labels.
- **Running agents:** never moved automatically. When an agent's engine is degraded, the inbox shows **Continue on Codex** (or another engine), which performs a handoff:
  1. Checkpoint the worktree (commit on the agent's branch, as checkpoints do today).
  2. Start a new session of the other engine in the same worktree and branch.
  3. Its first message says what the task is, points to the brief, the questions and the commit log, and asks it to continue from there.
  The old session is kept, so the agent can switch back later.

## Config

```json
{
  "engine": "claude",
  "engines": {
    "claude": { "bin": "claude" },
    "codex":  { "bin": "codex", "args": [] },
    "gemini": { "bin": "gemini", "args": [] }
  },
  "projects": { "web": { "engine": "codex" } },
  "failover": ["claude", "codex", "gemini"]
}
```

`claudeBin` and `claudeArgs` keep working as aliases of `engines.claude`.

## UI and CLI

- **Engine picker** in New agent, Add to backlog and race variants; a small engine tag on each agent.
- **Races across engines:** the same intent on Claude, Codex and Gemini, scored the same way. This comes almost for free and is a good way to compare engines on real work.
- **CLI:** `agentmgr add --engine codex …`, `agentmgr engines` (installed, signed in, healthy), `agentmgr continue <agent> --engine gemini`.
- **Hub:** `engine` joins the fleet whitelist; machines report their engines; the shared backlog takes an engine preference.

## Testing

The e2e suite uses a fake Claude (`test/fake-claude.js`). Each engine gets its own fake that writes sessions in that engine's log format and draws its prompts, so the adapters are tested without accounts. Phase 1 adds a manual check script that runs each real CLI once, records its flags, log format and prompt screens, and stores them as fixtures.

## Plan

| Phase | Delivers |
| --- | --- |
| 1. Adapter seam ✅ | `src/engines/claude.js` with today's behaviour behind the interface; `engine` on agents; real CLIs checked and recorded as fixtures |
| 2. Antigravity CLI ✅ | Replaces Gemini CLI. `src/engines/antigravity.js`: launch with instructions in the first message, adoption of the conversation agy picks (`cache/last_conversations.json`), resume with `--conversation`, usage, commands and writes from `brain/<id>/.system_generated/logs/transcript_full.jsonl`, command / file / access menus, trust in `settings.json` `trustedWorkspaces`, Explain in print mode (`--mode plan`, prompt attached to `--print=`). Non-Claude engines get a shorter conventions note: a smaller model turned the Claude-specific one into a search of the whole disk. |
| 3. Codex CLI ✅ | `src/engines/codex.js`: launch and resume, session adoption, brief folder (`--add-dir`), usage, stuck detection, prompts, trust, Explain through `codex exec`; engine pickers in the CLI, the page and the hub; machines report `engine:*` labels for the shared backlog. Not yet: planning while cloning and forks. Built before Gemini, which waits on a sign-in. |
| 4. Fail over | Engine health, preference lists in both backlogs, engines reported to the hub, **Continue on…** handoff |

## Open questions

1. **Order:** Gemini first (you named it), then Codex?
2. **Default engine** for new agents stays Claude, with others chosen per agent or project?
3. **Fail over:** automatic for new work only, with running agents switched only when you click **Continue on…**?
4. **Accounts:** Gemini CLI signed in with a Google account (free tier limits) or an API key / Vertex AI? Codex with a ChatGPT plan or an API key? This affects rate limits and the health checks.

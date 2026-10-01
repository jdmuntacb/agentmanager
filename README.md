# Agent Manager

Run one background [Claude Code](https://claude.com/claude-code) agent per intent, and keep track of them from a web UI or the `agentmgr` CLI.

- **Intents in, agents out.** Give one intent or a list (one per line). Each becomes its own `claude` process.
- **Repo or folder.** Give a git URL (cloned once, then each agent gets its own worktree and branch) or a local folder.
  - **Fast clones.** URLs are cloned as partial clones (`--filter=blob:none`): history now, file contents only for what's checked out.
  - **Progress.** Clone and checkout progress shows in the UI and `agentmgr ls`.
  - **Cancel and retry.** Deleting an agent during setup cancels the clone. A failed or interrupted setup can be retried.
  - **Big repo you already have?** `-d <your clone> -w` gives each agent its own worktree of it in seconds.
  - **Plan while it clones.** A planning session lets you talk the task through with Claude while the clone runs. The same session then moves into the repo with the whole conversation.
- **Background terminals.** Agents run inside the daemon's PTYs. Open any agent's live terminal in the browser (**Open terminal**) or in your shell (`agentmgr attach`). Closing the view leaves the agent running.
- **Session IDs are kept.** Each agent is started with a known `--session-id`. **Close session** stops the process but keeps the ID, and bringing it back runs `claude --resume <id>`. **New session** adds another ID to the agent's history; earlier ones stay resumable.
- **Tracking.** For each agent you see its session ID, working folder, repo, branch, head commit, uncommitted changes, PRs and bugs.
- **Tokens and cost.** Input, output and cache tokens are tracked per session, subagents included, alongside the cost Claude Code reports.
- **No trust prompt.** Folders agents run in are pre-trusted, so Claude's "trust this folder" prompt doesn't block them.
- **Survives restarts and reboots.** Agents that were running when the daemon stopped (restart, crash or reboot) are resumed with the same session IDs when it starts again. `agentmgr service install` starts the daemon at login.
- **Shell next to each agent.** **Open shell** gives a second terminal in the agent's folder for running commands by hand.
- **General sessions.** **Ask Claude** starts a session with no repo, folder or intent, for questions. It is tracked and resumable like any other agent.

## Install

```sh
npm install
npm link            # optional: puts `agentmgr` on your PATH
```

Requires Node 20+, `git`, and the `claude` CLI. `gh` (authenticated) is optional; it enables PR discovery by branch and PR state.

## Use

```sh
agentmgr ui                                   # start the daemon and open http://127.0.0.1:4717
agentmgr service install                      # start the daemon at login (launchd / systemd --user)

agentmgr add "Fix the flaky login test" -d ~/src/app
agentmgr add -r https://github.com/org/repo.git \
  "Add pagination to /users" "Investigate MB-12345 and open a fix PR"
agentmgr add -f intents.txt -r git@github.com:org/repo.git -p acceptEdits
agentmgr add --plan -a -r https://github.com/org/big-repo.git "Fix MB-123"   # plan with Claude while it clones

agentmgr ls                                   # status, branch, PR/bug counts, session
agentmgr show <agent>                         # everything tracked for one agent
agentmgr attach <agent>                       # live terminal here; Ctrl-] detaches (resumes a closed agent)
agentmgr shell <agent>                        # a shell in the agent's folder; Ctrl-] detaches
agentmgr plan <agent>                         # plan with Claude while the workspace is still being prepared
agentmgr handoff <agent>                      # move a planning session into its ready workspace now
agentmgr ask ["question"]                     # general session with no repo or folder
agentmgr stop <agent> | --all                 # close the session, keep its ID
agentmgr start <agent> [--fresh | -s <session>]
agentmgr sessions <agent>                     # every session ID this agent has used
agentmgr link <agent> --pr <url> --bug MB-123
agentmgr rm <agent> [--delete-workspace]
agentmgr shutdown
agentmgr service status | uninstall
```

`<agent>` can be the ID, a unique ID prefix, or the name. Every command starts the daemon if it isn't already running.

### Statuses

| Status | Meaning |
| --- | --- |
| `preparing` | Cloning or checking out the worktree (with progress) |
| `planning` | A planning session is running while the workspace is prepared |
| `working` | Claude is producing output |
| `waiting` | Claude is idle, waiting for its next instruction |
| `needs input` | A trust or permission prompt is blocking the agent. Open its terminal to answer. |
| `stopped` | Closed by you or by a daemon restart. Resumable. |
| `exited` | Claude exited on its own (for example `/exit`). Resumable. |
| `error` | Workspace setup or launch failed. See the error message. If setup failed, **Retry setup** (or `agentmgr start <agent>`) runs it again. Setup interrupted by a daemon restart is retried automatically. |

Agent folders are pre-trusted (see below), so new agents don't stop at Claude's "trust this folder" prompt.

## Restarts and reboots

Every agent records whether you want it running:

- Starting or resuming it means **running**.
- **Close session** / `agentmgr stop`, or Claude exiting on its own (`/exit`), means **stopped**.
- A daemon restart, a crash or a reboot changes nothing.

When the daemon starts, it resumes every agent you left running with `claude --resume <session-id>`. Set `"autoResume": false` in the config to turn that off.

To have that happen after a reboot, install the login service once:

```sh
agentmgr service install     # macOS: ~/Library/LaunchAgents/com.agentmgr.daemon.plist
agentmgr service status
```

- **Environment.** The service runs the daemon through your login and interactive shell (`$SHELL -l -i`), so agents see the same environment as your terminal, including tokens exported in `~/.zshrc` such as `GITHUB_TOKEN`.
- **Restarts.** launchd restarts the daemon if it crashes, but not after `agentmgr shutdown`.
- **Linux.** It installs a systemd user unit instead. Run `loginctl enable-linger $USER` if it should start at boot before you log in.

## Where things come from

| Field | Source |
| --- | --- |
| Session ID | Assigned by agentmgr (`--session-id`). If Claude switches sessions mid-run (`/clear`), the new transcript in the agent's folder is adopted. |
| Folder / repo / branch | The workspace agentmgr prepared, plus `git` in that folder |
| PRs | `pr-link` records in the session transcript (PRs Claude created), `gh pr list --head <branch>`, PR URLs mentioned in the conversation, and links you add |
| Bugs | Refs in the intent and the conversation (Jira links with `/browse/KEY-1`, `?selectedIssue=KEY-1` or `/issues/KEY-1`; GitHub issue URLs), custom `bugPatterns`, and links you add |
| Title / cost | `ai-title` and `cost-state` records in the transcript |

Removing a detected link dismisses it, so it doesn't come back on the next scan.

## Planning while a repo clones

Cloning a big repo can take a while. Tick **Plan with Claude while the repo clones** (the default in the UI), or use `add --plan`. For an agent that is already cloning, click **Plan while it clones** or run `agentmgr plan <agent>`.

1. **Planning.** Claude runs in `~/.agentmanager/planning` with the agent's own session ID. It is told the repo isn't there yet and to clarify the task with you: ask questions, gather requirements, agree on a plan. It doesn't edit files.
2. **Handoff.** When the workspace is ready, the session's transcript is copied into the repo folder and the same session resumes there (`claude --resume <id>`). Claude gets the message "The repository is ready … continue with the plan we agreed on" and has the whole planning conversation. The session ID doesn't change.
3. **Timing.** It moves by itself once Claude has been idle for `handoffIdleSec` and no terminal is attached. If you have the terminal open, it waits for **Continue in repo** (or `agentmgr handoff <agent>`), so it never cuts you off mid-sentence.

If setup fails while you're planning, the planning session keeps running and **Retry setup** tries again.

## Folder trust

Before launching Claude in a folder, agentmgr marks that folder as trusted in Claude Code's config (`~/.claude.json`, `projects[<path>].hasTrustDialogAccepted`). That is the same record Claude writes when you choose "Yes, I trust this folder". It only does this for the folders agents run in: workspaces, the planning folder, general sessions and folders you pass with `-d`.

The first change keeps a backup at `~/.claude.json.agentmgr-backup`. Trusting a folder lets Claude load that repo's project settings and hooks without asking, so set `"trustAgentFolders": false` if you'd rather review repos first.

## Tokens and cost

Usage comes from the session transcripts and is refreshed every few seconds while an agent runs:

- **Sources.** Input, output, cache-write and cache-read tokens for every API request, including the session's subagents.
- **Where it shows.** Per session in **Session history** and `agentmgr sessions`, and summed per agent in the list, the session card, `agentmgr ls` (TOKENS) and `agentmgr show`.
- **Cost.** The figure Claude Code records itself (`cost-state`), shown once it has written one.

## Shell and general sessions

- **Open shell** (or `agentmgr shell <agent>`) starts `$SHELL -l` in the agent's working folder. It shows as a **Shell** tab next to the **Claude** tab in the terminal pane. It lives as long as the daemon and doesn't start Claude.
- **Ask Claude** (or `agentmgr ask`) creates a `general` agent. All general sessions share `~/.agentmanager/general`, so Claude's folder-trust prompt only appears the first time.

## Configuration

State lives in `~/.agentmanager/` (`state.json`, `daemon.log`, `repos/` for shared clones, `workspaces/` for worktrees). Set `AGENTMGR_HOME` or `AGENTMGR_PORT` to change the location or port. Optional `~/.agentmanager/config.json`:

```json
{
  "claudeArgs": ["--model", "opus"],
  "permissionMode": "acceptEdits",
  "bugPatterns": ["\\bMB-\\d+\\b"],
  "gitRefreshSec": 15,
  "prRefreshSec": 120,
  "autoResume": true,
  "trustAgentFolders": true,
  "handoffIdleSec": 5,
  "cloneFilter": "blob:none",
  "shell": "/bin/zsh"
}
```

## Security

The daemon drives real terminals, so it is locked down to this machine:

- It listens on `127.0.0.1` only.
- It rejects requests whose `Host` is not loopback, which blocks DNS rebinding.
- It rejects browser requests from any other origin, which blocks cross-site WebSockets.
- Every write needs an `x-agentmgr` header, which browsers can't send cross-origin.

Anyone with a shell on the machine as your user can still use it.

## Notes

- Agents live in the daemon process. A daemon restart closes them, saving their sessions, and resumes them when it starts again. The terminal scrollback starts fresh; Claude redraws the conversation when it resumes.
- Child `claude` processes get a clean environment. The markers a parent Claude Code session sets (such as `CLAUDE_CODE_CHILD_SESSION`) are removed, because inherited markers switch transcript saving off and then the session can't be resumed.
- `rm --delete-workspace` only deletes worktrees and folders agentmgr created, never a folder you passed with `-d`.

## Development

```sh
npm test    # unit tests + end-to-end daemon tests against a stub claude (test/fake-claude.js)
```

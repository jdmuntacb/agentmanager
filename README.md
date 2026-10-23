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
- **Results.** The end result at a glance: ✅ done, 🟡 partial, ⛔ blocked or 🔄 in progress, with what was delivered and what's blocking it.
- **Brief per agent.** Each agent keeps a living brief that the UI shows next to its terminal:
  - **Problem**, **Solution**, a **design / flow diagram** (Mermaid) and **Checks** (passed / failed / running / pending);
  - when the intent links a Jira issue, **References** with its **PRD** and **Tech Spec** links and the points that matter.
- **Projects.** The sidebar is a tree, project → agents, so you see how many projects are in flight and how many parallel sessions each has.
- **Project shortcuts.** Each project gets a short name, such as `cc` for couchbase-cloud. Use it instead of the repo URL: `agentmgr add @cc "…"`, `agentmgr ls cc`, `@cc` in the UI filter.
- **Backlog.** Queue asks as work orders. Agents pick them up one by one, up to N in parallel per project, until each is done. You accept or reopen each one.
- **Slack alerts.** A message in your channel when an agent needs input, finishes a backlog item, or fails.
- **Priority.** Mark agents P0–P3. P0 and P1 are highlighted, and lists sort by priority.
- **Share for review.** One click writes an **Analysis**, **Design**, **Flow** or **Proposal** document from the agent's work. Copy it as Markdown, download it, or print it to PDF with diagrams.
- **Human vs AI.** It splits the open questions about the work into the top 5 that need your judgment and the ones a model can answer from the evidence. It answers those, then a second model double-checks every answer.
- **Plan review.** Optionally, the agent writes an implementation plan and waits for your approval before changing anything.
- **Insights.** Why, What, How and Now for any agent, three memorable points each.
- **Explain.** One click gives a plain-language explanation of the intent and the insight behind the problem and solution. It comes from a separate tool-less Claude call, so the agent isn't interrupted.
- **From your phone.** On by default: HTTPS access on your local network at a plain `https://<ip>:<port>`. Sign in with a QR code, and answer Claude's prompts with a key bar and reply box. Nothing to install.
- **Never loses state.** `agentmgr flush` (also every 30 s and on shutdown) saves session IDs, terminal scrollback and usage. `agentmgr restart` brings everything back.
- **Follows your conventions.** Before changing anything, agents review `CLAUDE.md` / `AGENTS.md`, skills, hooks and settings (repo and `~/.claude`), and follow them.
- **Tokens and cost.** Input, output and cache tokens are tracked per session, subagents included, alongside the cost Claude Code reports.
- **No trust prompt.** Folders agents run in are pre-trusted, so Claude's "trust this folder" prompt doesn't block them.
- **Survives restarts and reboots.** Agents that were running when the daemon stopped (restart, crash or reboot) are resumed with the same session IDs when it starts again. `agentmgr service install` starts the daemon at login.
- **Shells next to each agent.** **Open shell** gives a terminal in the agent's folder for running commands by hand. **+ Shell** opens as many more as you need, each in its own tab.
- **Browser tabs.** **+ Browser** opens a page as this machine sees it, in a tab next to the agent's terminals. That can be the agent's dev server on `localhost:5173`, a site on its network or VPN, or any address. Local addresses the agent prints are offered as suggestions. It works from your phone or laptop too (see below).
- **Attach files and screenshots.** Drop files on the terminal, paste a screenshot, or use **📎 Attach**. The file is saved on the daemon's machine and its path is pasted into the terminal, which is how Claude Code picks up images and files.
- **General sessions.** **Ask Claude** starts a session with no repo, folder or intent, for questions. It is tracked and resumable like any other agent.

New in 0.2, for running many agents at once:

- **Decision inbox.** One **Inbox** tab for everything waiting on you, across agents: prompts that need an answer (answer them with one click), questions agents ask without stopping, agents that seem stuck, and overlapping changes. Answers are typed into the agent's session for you.
- **Conflict radar.** Agents in the same repo that change the same files are flagged while they work, not at merge time, with "same lines" called out and a suggested merge order. **Tell both** lets each agent know.
- **Stuck detection.** Spots an agent going in circles (the same failure again and again, undoing its own edits, a long stretch with no file changed) and offers a ready-made nudge to send.
- **Checkpoints and forks.** The code (uncommitted work included) and the conversation are saved at the end of every turn. **Fork** starts a new agent from now or from any checkpoint, in its own worktree, to try another direction without losing the first.
- **Races.** Send one intent to several agents with different models or approaches. Compare their outcome, checks, size of change, cost and a test command run in each worktree, read their diffs side by side, then pick a winner and delete the rest.

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
agentmgr add -d ~/src/big-repo -w -b release-1 "Backport the fix"          # worktree of your clone, branched from release-1

agentmgr ls [cc]                              # status, branch, PR/bug counts, session (optionally one project)
agentmgr add @cc "Fix the flaky test"         # use a project shortcut instead of -r / -d
agentmgr project ls | add | rename | base | rm  # manage project shortcuts
agentmgr show <agent>                         # everything tracked for one agent
agentmgr attach <agent>                       # live terminal here; Ctrl-] detaches (resumes a closed agent)
agentmgr shell <agent> [-n 2]                 # a shell in the agent's folder (-n picks another one); Ctrl-] detaches
agentmgr brief <agent>                        # print the agent's brief (Markdown)
agentmgr priority <agent> P0                  # P0 urgent, P1 high, P2 normal (default), P3 low
agentmgr doc <agent> proposal -o p.md         # analysis | design | flow | proposal, for stakeholders
agentmgr doc <agent> all --background         # write all four in the background
agentmgr insights <agent>                     # Why / What / How / Now, three points each
agentmgr explain <agent>                      # full briefing: ask, status, plan, solution, conclusions, needs
agentmgr remote on | off | status | rotate    # phone / remote access (see below)
agentmgr backlog add "ask" -r <repo> [-p 1]   # queue work; also: ls, start, accept, reopen, move, limit, pause
agentmgr notify slack --webhook <url>         # Slack alerts; also: test, status, on, off, event <name> on|off
agentmgr inbox                                # prompts, questions, stuck agents and overlaps waiting on you
agentmgr answer <agent> <question-id> "…"     # answer a question from the inbox
agentmgr tell <agent> "…"                     # send a message into the session (when it's idle)
agentmgr fork <agent> [-c 3] [-m "…"]         # new agent from now (or checkpoint 3), its own worktree
agentmgr checkpoints <agent>                  # snapshots saved at the end of each turn
agentmgr race start "intent" -v opus -v "sonnet|keep it small" -r <repo> -t "npm test"
agentmgr race show [race] | test <race> | pick <race> <agent> [--cleanup]
agentmgr flush                                # save session IDs, scrollback, usage and state now
agentmgr restart                              # flush, stop and start the daemon; agents resume
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

## Sharing one big repo between agents

Every agent gets **its own worktree and its own branch** (`agent/<name>-<id>`) of one shared clone. Git history is stored once, and each agent only adds its checked-out files, so a new agent on a repo that's already there starts in seconds.

- **Repo URL** (`-r <url>`): the first agent clones it into `~/.agentmanager/repos/`. Later agents with the same URL reuse that clone after a quick fetch.
- **A clone you already have** (`-d <folder> -w`, or the folder field with the worktree box ticked, which is the UI default): agents get worktrees of your clone. Your own checkout and branch are never touched.

**Where branches start.** By default each agent branches from the repo's **default branch, freshly fetched** (`origin/HEAD`, usually `origin/main`). That holds even if your clone is checked out on another branch or is behind. To start somewhere else, use `--base <ref>` (or the **Base branch** field):

- a branch name such as `release-1`, which uses `origin/release-1` when the remote has it;
- a tag or a SHA;
- `HEAD` for the folder's current checkout.

**Other details:**

- **Offline.** If the fetch fails (offline, no access), the refs already present are used.
- **No upstream.** Agent branches are created without an upstream, so Claude's first `git push -u origin <branch>` sets the right one. They never accidentally track `origin/main`.
- **Where it shows.** The agent shows **Branched from** with the ref and commit it started at.

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

## The brief

Every task agent is told, on each launch, to keep a short brief in `~/.agentmanager/briefs/<id>/BRIEF.md`. The file is outside the repository, so it never gets committed. The sections are:

| Section | Contents |
| --- | --- |
| `## Problem` | What's wrong or needed, and why |
| `## Solution` | The approach and key changes, kept current |
| `## Diagram` | One ` ```mermaid ` block: flow, sequence or architecture |
| `## Checks` | `- [ ]` pending, `- [~]` running, `- [x]` passed, `- [!]` failed, with the command or evidence |
| `## Results` | `Outcome: in progress \| partial \| done \| blocked`, then `- Delivered: …` (PRs, commits, files, docs, answers) and `- Blocked by: … (needs: who/what)` |
| `## References` | Only when the intent links Jira issues. The agent looks them up with its own Jira / Atlassian tools (no credentials in agentmgr) and lists the **PRD** and **Tech Spec** fields as links with highlights, plus other design docs. Empty fields are listed as "none". |

How it behaves:

- **Display.** The UI shows the brief as a panel with a rendered diagram, check icons and highlighted PRD / Tech Spec links. The agent list shows check counts and PRD / Tech Spec chips. `agentmgr show` summarizes it, and `agentmgr brief <agent>` prints it.
- **Updates.** Changes show up within a second while the agent runs.
- **Planning.** Planning sessions start the brief too, so Problem, the proposed Solution and the References can be filled in before the clone finishes.
- **Permissions.** Claude gets `--add-dir` access plus `Write` / `Edit` permission rules for its brief folder only, so writing the brief never stops at a permission prompt. Everything else keeps your normal permission mode.
- **Safety.** Markdown is sanitized (DOMPurify) and diagrams render with Mermaid's `strict` security level.
- **Conventions.** With `reviewConventions` on (the default), agents are also told to read `CLAUDE.md` / `AGENTS.md`, the relevant skills (`.claude/skills`, `~/.claude/skills`), hooks and permissions (`.claude/settings*.json`, `~/.claude/settings.json`), and project commands and agents before working. They record what applies as the first check.
- **Off switch.** Set `"brief": false` or `"reviewConventions": false` to turn these off. Neither applies to general sessions.
- **Existing agents.** Agents started before this version pick it up on their next resume.

## Priority

Every agent has a priority, **P0** (urgent) to **P3** (low). **P2** is the default.

- **Look.** P0 shows a solid red chip and a red bar on the agent. P1 shows a red outline chip, and P3 a muted chip. P2 shows nothing, to keep the list calm.
- **Ordering.** Within a project, agents sort by priority, then needs-input, then running. Projects holding a P0 or P1 agent move to the top and show the chip in their header.
- **Setting it.** Use the selector next to the agent's name, the New agents dialog, `add --priority P1`, or `agentmgr priority <agent> P0`.
- **Backlog.** Items use the same P0–P3 scale and pass it on to their agents.
- **Slack.** Alerts are tagged `[P0]` / `[P1]`.

## Share for review: Analysis, Design, Flow, Proposal, Human vs AI

The Brief panel's **Share for review** buttons, or `agentmgr doc <agent> <kind>`, write a stakeholder document from the agent's live context: its ask, conversation and actions, repository changes and brief.

| Document | Sections |
| --- | --- |
| **Analysis** | Summary, context, findings, root cause, constraints and assumptions, options considered, open questions |
| **Design** | Summary, goals and non-goals, architecture (with a diagram), components and changes, interfaces and data, trade-offs, risks, testing and rollout |
| **Flow** | Summary, end-to-end flowchart with a step-by-step walk-through, key interactions as a sequence diagram, failure and edge cases |
| **Proposal** | Summary, problem, recommendation, scope, plan, effort and dependencies, risks, decisions needed |
| **Human vs AI** | Your top 5 decisions, each with why it needs you, the stakes, options and what the work suggests, plus a box for your answer. Up to 5 questions the AI answers, each with its confidence, evidence and how to check it. A second model's verdict on each. |

**Human vs AI.** This review takes two separate read-only calls.
1. **The split.** The agent's engine splits the open questions. *For you to decide* covers judgment calls such as intent, priorities, risk appetite and trade-offs. *Answered by AI* covers reasoning and evaluation: correctness, edge cases, test coverage and what's left.
2. **The second opinion.** Another model reviews that split against the same context. It marks each AI answer *agrees*, *partly* or *disagrees*, with a correction where needed. It marks each of your questions *keep*, *AI could answer* or *reword*, and lists questions both lists missed.

The second model is another installed engine by default (Codex or Antigravity for a Claude agent), because a different provider tends to catch different mistakes. Without one, it's Claude with a different model. Set `"critique": { "engine": "codex", "model": "…" }` in config.json to choose.

Type your answers in the viewer, or tap an option to fill one in. **Send my answers to the agent** passes them on, together with any AI conclusions the second model doubted, so the agent re-checks those.

**How they're written.** Documents name the real files, tickets and docs, separate facts from proposals, and say "To be confirmed" where the context doesn't. They're written for reviewers: no mention of the agent or its tools.

**Sharing.** Each document opens in a viewer:

- **Copy Markdown** pastes cleanly into Confluence, Google Docs, Slack or a PR.
- **Download .md** saves the file.
- **Print / PDF** opens a print-ready page with the Mermaid diagrams rendered. Use your browser's *Save as PDF*.

**In the background.**

- **Starting.** While a document is being written, **Continue in background** closes the viewer, and the writing carries on in the daemon. **Write all in background** starts every document that doesn't exist yet. You get a notification with an **Open** button as each one is ready.
- **CLI.** `agentmgr doc <agent> <kind|all> --background` returns at once. `agentmgr doc <agent> <kind> --cached` prints the result later.
- **Queueing.** At most `summaryConcurrency` (2) of these one-off Claude calls run at once, Explain and Insights included. The rest queue.

**Behaviour.** Documents are kept per agent and marked out of date when the brief changes. They come from the same separate, tool-less Claude call as Explain, so the agent isn't interrupted. On the phone link, the print page needs sign-in like everything else.

## Plan review

Tick **Review the implementation plan first** in New agent (or the backlog), or press **Review its plan first** on a running agent. The agent investigates, writes `PLAN.md` (goal, approach, steps, files, tests, risks) next to its brief, and stops. It doesn't edit, commit or run anything that changes the repo until you approve.

- **Where it shows.** The plan appears in the inbox as **Plan review** and in the Brief panel, with a notification.
- **Approve and implement** sends it ahead, optionally with notes.
- **Request changes** sends your notes back. The agent revises the plan and waits again.
- **Skip review** stops waiting.
- **After approval**, edits to the plan count as progress updates and don't ask again. A restarted agent is told its plan was approved.
- **Default.** Set `"planReview": true` in config.json to turn it on for every new agent.

## Insights

**Insights** in the Brief panel, or `agentmgr insights <agent>`, shows the agent's work as four cards built from its ask and live context:

| Card | Answers |
| --- | --- |
| 🎯 **Why** | Why it matters: the motivation, the need, or the root cause |
| 📦 **What** | What is being done or delivered: scope and outcome |
| 🛠 **How** | The approach, the key mechanism, the main changes |
| 📍 **Now** | Where it stands and the next step, including anything waiting on you |

Each card has at most **three points of about 12 words each**, so they're easy to remember and repeat. Insights uses the same context and the same separate, tool-less Claude call as Explain, so the agent isn't interrupted. Use Insights for a quick glance and Explain for the full briefing.

## Results

The **Results** card is the first thing in the Brief panel, and `agentmgr show` lists it too. It shows:

- **The outcome:** ✅ Done, 🟡 Partial, ⛔ Blocked or 🔄 In progress.
- **Blockers first, in red.**
- **What was delivered.**

It combines what the agent wrote under `## Results` with what Agent Manager tracks itself:

- PRs (with their state).
- Failing checks.
- An unanswered prompt.
- A setup error.
- The brief's `Status:` line.

So agents that haven't written Results yet still get one. Blocked and done agents show ⛔ / ✅ in the agent list, and the **blocked** Slack alert (on by default) fires when an agent reports it's blocked.

## Explain

**Explain** in the Brief panel, or `agentmgr explain <agent>`, briefs you on what the agent is doing, built from its live context.

**Context it reads:**

- **The conversation:** your requests and the agent's own replies.
- **Its actions:** commands run, files edited, questions asked, skills and subagents used, Jira and Drive calls.
- **The repository:** commits and changes since its base branch.
- **Live status:** working, waiting on you, or blocked.
- **The brief.**

**What it writes:**

| Section | Contents |
| --- | --- |
| The ask | What was requested, including later changes of direction |
| Where it stands | Phase (planning / investigating / implementing / testing / done / blocked), what it's doing now, whether it's waiting on you |
| Planned work | Checklist with ✅ done, 🔄 in progress, ⏳ next |
| Solution | The approach and the concrete changes so far (files, commits, PRs) |
| Conclusions so far | Findings, decisions, results |
| Needs from you | Questions or decisions it's waiting on, risks, blockers |

**How it runs:**

- **Separate call.** `claude -p --tools "" --strict-mcp-config --no-session-persistence`, with no tools and no MCP servers. It never runs inside the agent's session, so the agent isn't interrupted and its context doesn't grow.
- **Large sessions.** They are condensed to the first request plus the most recent activity, about 24k characters.
- **Stale flag.** The result is stored with the agent and marked out of date when the brief changes.
- **Model.** Set `"explainModel"` to pick one.

## Projects

The sidebar groups agents into projects, shown as a tree:

- **How agents are grouped.**
  - By repo: a URL and a local clone of the same repo land together.
  - Otherwise by folder.
  - General sessions under *General*, scratch work under *Other*.
  - Set your own name with `--project` or the ✎ next to *Project* in the agent's Workspace card.
- **Counts.** Each project shows running/total agents and how many need input.
- **Shortcuts.** Every project gets a **shortcut**, shown as a badge in the tree.
  - **Assignment:** from the name's initials (`couchbase-cloud` → `cc`, `ai-gateway` → `ag`) or its first letters (`agentmanager` → `age`), with a number added when two would clash. Click the badge, or run `agentmgr project rename cc cbc`, to change it.
  - **Where it works:**
    - `agentmgr add @cc "…"` or `--project cc` uses the project's repo or clone and its default base branch. A local clone always gets a new worktree.
    - `agentmgr ls cc` lists that project.
    - Type `@cc` in the UI filter to show just it.
    - The New agents **Project** field suggests your shortcuts.
    - `backlog add --project cc` queues work for it.
  - **Ahead of time:** register a project before it has agents with `agentmgr project add cc -r <url> [-b main]`. Set a default base branch with `agentmgr project base cc release-1`.
- **Ordering.** Projects needing you sort first. Collapsed projects stay collapsed.
- **CLI.** `agentmgr ls` groups by project too.

## Backlog

Queue asks instead of starting them. Use **+ Add** in the Backlog tab, **Queue in backlog** in the New agents dialog, or `agentmgr backlog add`. Each item is one ask, plus where to do it (repo or folder, base branch, project) and a priority from P1 (high) to P3 (low).

**How items flow:**

1. **Queued → active.** Items are picked up by priority, then queue order. Up to `backlogParallel` (2) items per project run at once, and `backlogMaxActive` (4) overall. Change a project's limit with "*N at a time* ✎" or `agentmgr backlog limit <project> <n>`. Each item gets its own agent, worktree and branch.
2. **Active → review.** When the agent sets its brief's first line to `Status: done` (its checks pass), the item moves to **review** and frees its slot for the next one. An agent that exits or that you close also sends its item to review. Setup errors make it **blocked** (Retry restarts it).
3. **Review → done.** **Accept** marks it done. **Reopen** types your note into the same agent session and puts the item back to work.

**Other controls:**

- **Pause / Resume** stops or restarts picking up new items. Active ones continue.
- **Start now** starts an item regardless of limits.
- **Reorder** with ▲▼, or `backlog move`. Click **P1–P3** to change priority.
- Deleting an agent cancels its item.

The backlog is saved with the rest of the state.

## Decision inbox

The **Inbox** tab (and `agentmgr inbox`) lists what needs you, across all agents:

| Kind | What it is | How you answer |
| --- | --- | --- |
| Needs input | A permission prompt or question menu is open in the agent's terminal | Click a choice (1, 2, 3, Esc); no need to open the terminal |
| Question | The agent asked something without stopping | Click an option or type an answer |
| Stuck? | The agent seems to be going in circles | Send the suggested nudge (edit it first if you like) or dismiss |
| Overlap | It changes the same files as another agent | Tell one or both agents; see the suggested merge order |

**Questions without stopping.** Task agents are told to write questions that don't block all their work to `QUESTIONS.md` next to their brief, with options and the default they'll assume meanwhile, and then keep going:

```markdown
## Postgres or SQLite for the cache?
Options: Postgres | SQLite
Default: SQLite
The data set is small.
```

**How answers reach the agent.** Answers, nudges and overlap warnings go into a per-agent queue. Each message is typed into the session as if you sent it, once the agent is idle: not mid-turn, and with no prompt open. A closed agent is resumed first. `agentmgr tell <agent> "…"` uses the same queue.

## Conflict radar

For each agent with its own branch, Agent Manager works out which files and line ranges its branch changed since it branched, including uncommitted and new files. Agents working in the same repository (the same shared clone or source folder) that touch the same file are flagged:

- **same lines**: both edit the same region, within a few lines (likely a merge conflict). Only judged when both branched from the same commit.
- **same file**: both edit the file, in different places.

The suggested merge order puts an agent whose PR is merged or open first; otherwise the smaller change lands first, so the other has less to rebase. **Tell** sends an agent a short note naming the other agent, the files and the order. Attempts in one race, and a fork and its source, are expected to overlap, so they aren't flagged.

## Stuck detection

From the transcript, while an agent runs:

| Finding | Rule (defaults) |
| --- | --- |
| Same failure N× in a row | One command failing with the same output 3 times running |
| Undoing its own edits | 2 edits that put back what an earlier edit removed, or 10 edits to one file, within 45 minutes |
| N min without changing a file | 25+ actions over 20+ minutes since the last edit, while still active |

Each finding comes with a suggested nudge. Sending it also dismisses the finding; a dismissed finding comes back only if the agent gets stuck again. Tune the thresholds with `"stuck": { "repeatFailures": 3, "thrashReverts": 2, "thrashEdits": 10, "driftMinutes": 20, "driftActions": 25 }` in `config.json`.

## Checkpoints and forks

At the end of each turn, Agent Manager snapshots the agent's working tree as a commit under `refs/agentmgr/<agent>/<n>`. This doesn't touch the agent's branch, index or files. It records how far the conversation had got alongside. The last 40 are kept (`maxCheckpoints`); deleting the agent removes them.

**Fork** (or `agentmgr fork <agent> [-c n]`) creates a new agent:

- **Code:** a new worktree and branch at the same commit, with the same uncommitted changes as the source had at that point.
- **Conversation:** a copy of the transcript up to that point, under the fork's own session ID. The fork resumes it, so it knows everything the source knew.
- **Direction:** an optional first message, such as "try a different approach: …".

The source agent keeps running untouched.

## Races

**+ New agents → Race variants** (or `agentmgr race start`) creates one agent per variant. Each runs in its own worktree. A variant is a model, an approach, or both: `opus`, `sonnet | keep the change minimal`, `| use a cache`. **Compare** opens the scoreboard:

- **Status and outcome**, from each agent's brief, plus its checks
- **Change**: files and lines added and removed, with the smallest marked
- **Tests**: the race's test command, run in every attempt's worktree two at a time (15-minute limit each)
- **Cost and time**
- **Diff**: each attempt's full changes against where it started

**Pick** marks the winner and can close and delete the other attempts, worktrees included.

## Slack alerts

**Three ways to connect Slack:**

- **Workflow Builder.** Needs no app install, and can message you directly.
  1. In Slack, open *Workflows* (or *Automations*) and create a new workflow that starts **From a webhook**.
  2. Add **one variable**: name `text`, type *Text*.
  3. Add a step, **Send a message to a person** (yourself) or **…to a channel**, and insert the `text` variable as the message.
  4. Publish it and copy the web request URL (`https://hooks.slack.com/triggers/…`).
- **Incoming webhook.** Create an app at api.slack.com/apps → *Incoming Webhooks* → *Add New Webhook*, then pick a channel. Your workspace may require admin approval.
- **Bot token and channel.** If you already have a Slack app.

Then:

```sh
agentmgr notify slack --webhook https://hooks.slack.com/triggers/…   # Workflow Builder webhook
agentmgr notify slack --webhook https://hooks.slack.com/services/…   # or an app's incoming webhook
agentmgr notify slack --token xoxb-… --channel '#agents'            # or a bot token + channel
agentmgr notify test
```

Or use **Alerts** in the header (on this computer only). Settings, including the webhook or token, are stored in `~/.agentmanager/notify.json` (mode 0600) and masked in the UI and API.

| Alert | Default | When |
| --- | --- | --- |
| needs input | on | A trust or permission prompt or a question menu is still unanswered after 60 s |
| review | on | A backlog item finished and is ready for your review |
| error | on | Workspace setup or launch failed |
| waiting | off | The agent finished its turn and has been idle 2 min |
| blocked | on | The agent reports it is blocked (brief status or Results outcome) |
| stuck | on | The agent seems to be going in circles (see Stuck detection) |
| conflict | on | It changes the same files as another agent in the same repo (sent once per pair) |
| question | on | It asked a question in the decision inbox |

**Message behaviour:**

- **Once per episode.** Each alert is sent once, and again only after the condition clears and comes back.
- **Skipped while watching.** Alerts are skipped while you have that agent's terminal open.
- **Contents.** Messages include the agent, project, the intent (optional) and a link. The link uses your phone address when remote access is on.

## Phone and remote access

Remote access is **on by default**. Each daemon listens on its local port + 1 (4717 → 4718). If you turn it off, it stays off.

```sh
agentmgr remote status    # prints https://<this-mac-ip>:4718/ and the sign-in QR code
agentmgr remote off       # turn it off (agentmgr remote on to turn it back on)
```

Or use **Remote access** in the header of the UI on this computer.

**Connecting a phone:**

1. **Scan the QR code** with the phone camera. It opens the address and signs the phone in. The token rides in the `#fragment`, so it never reaches the server's logs, and the page removes it from the address bar.
2. **Accept the certificate warning** on the first visit. The certificate is self-signed and generated with macOS's built-in `/usr/bin/openssl`. Check the SHA-256 fingerprint shown by `agentmgr remote status`, then use *Show Details → visit this website* in Safari or *Advanced → Proceed* in Chrome.
3. **Use it.** On the phone, the terminal goes full screen with a key bar (Esc, Tab, ⇧Tab, arrows, Enter, ^C, 1–4 for Claude's menus) and a reply box. Agents that need input sort to the top, and the page title shows how many are waiting.

**Reachability.** Nothing extra is installed and no relay or tunnel is used, so the phone must be able to reach this computer directly:

- **Same network.** Use the same Wi-Fi, or join this computer to the phone's Personal Hotspot. Office Wi-Fi often blocks device-to-device traffic.
- **Corporate VPN.** A full-tunnel VPN usually routes even local-network traffic into the tunnel, so other devices can't reach the Mac while it's connected. If the phone can't load the page, disconnect the VPN (where policy allows) or use the hotspot.
- **Public IP.** A public address only works if your network forwards the port, which home routers can do and corporate networks won't. Ask IT before exposing it.

**Security.**

- **Separate listener.** Remote access is a second listener on HTTPS, all interfaces, with the local port + 1 by default. The local `127.0.0.1:4717` listener is unchanged. Set `AGENTMGR_REMOTE=0` in the environment to start a daemon with it off when you haven't chosen either way.
- **What needs sign-in.** Every API call except sign-in needs a device session (HttpOnly, Secure, SameSite=Strict cookie, 30 days, sliding). Only this machine's own addresses are accepted as `Host`, and cross-site origins are refused. Failed sign-ins are rate limited.
- **Local only.** Turning remote access on or off, the token and devices, and shutting down can only be done from this computer.
- **Devices.** `agentmgr remote rotate` (or **New access token**) signs every device out. Devices are listed with their address and last-seen time and can be signed out one by one.
- **Firewall.** If the macOS firewall is off, the port is open to your whole network while remote access is on. Turn it off when you don't need it.
- **Streaming.** The phone UI streams with Server-Sent Events plus plain HTTPS requests. iOS Safari doesn't apply an accepted self-signed certificate to WebSockets.

## Engines: Claude Code, Codex and Antigravity

Agents run Claude Code by default. With OpenAI's Codex CLI installed (`npm i -g @openai/codex`, signed in), an agent can run Codex instead: `agentmgr add --engine codex …`, or the **Engine** picker in New agent (shown once a second engine is installed). Everything else works the same way: worktrees, the brief and questions, the inbox (Codex's approval menus included), token usage, stuck detection, PR tracking, Explain, the backlog and the hub. Codex records no cost, and planning while a repo clones and forks are Claude-only for now. Set `"engine": "codex"` in config.json to make it the default; `engines.codex.bin` points at another binary. On the hub, each machine reports the engines it has (`engine:codex`), so shared backlog work can ask for one. See [docs/engines.md](docs/engines.md).

Google's **Antigravity CLI** (`agy`, signed in with your Google account) works the same way: `--engine antigravity`. It replaced Gemini CLI for personal Google accounts in June 2026. Agent Manager adopts the conversation agy starts, resumes it with `--conversation`, reads token usage, commands and file writes from its transcript, shows its permission menus (commands, file changes, access outside the folder) in the inbox, pre-trusts agent folders in agy's settings, and runs Explain in agy's print mode. agy asks before writing the brief too, unless the agent runs in `acceptEdits` mode. `engines.antigravity.bin` points at another binary.

## Several machines: the hub

With agents on more than one Mac, a **hub** shows all of them in one place: every machine's agents and one inbox of what needs you. Where a machine allows it, you can also act from the hub: answer, message, start and stop agents, start new ones, and open live terminals. Each Mac keeps running its own daemon. It connects out to the hub, so no ports need opening on it, and the hub's requests travel back over that same connection.

```sh
# Where the hub runs (any Mac that stays on, or later Railway):
agentmgr hub serve --host <this-mac-tailscale-ip>   # prints a sign-in link
agentmgr hub invite                                  # one-time code, valid 10 minutes

# On each Mac to add:
agentmgr join http://<hub-tailscale-ip>:4720 ABCD-EFGH-JKLM --name laptop

agentmgr fleet           # agents on every machine, and what needs you
agentmgr fleet answer laptop/3f2a1c q1 "Postgres"
agentmgr fleet tell laptop/3f2a1c "Also update the docs"
agentmgr fleet start laptop/3f2a1c          # or stop
agentmgr fleet new laptop web "Add a dark mode toggle"
agentmgr fleet backlog add web "Fix the footer links" "Add a sitemap"   # runs where there's room
agentmgr fleet backlog   # shared backlog: where each item runs, what waits and why
agentmgr hub machines    # online/offline, versions, what each allows
agentmgr hub status      # this Mac's link to its hub
agentmgr leave           # the hub forgets this Mac
```

**Addresses.** Use `https://` for the hub, or plain `http://` only on this machine or over Tailscale, which already encrypts traffic. **Open** links go to each Mac's remote-access address, its Tailscale one first, so remote access must be on there (`agentmgr remote on`).

**Each Mac decides what the hub may do.** A new machine shares `view` only. More is opt-in, per machine, in its `~/.agentmanager/config.json` (restart its daemon after changing it):

```json
{ "hub": { "allow": ["view", "inbox", "control", "create", "terminal"], "projects": ["cc", "web"], "labels": ["gpu"], "maxAgents": 4, "perProject": 2 } }
```

| Permission | The hub may |
| --- | --- |
| `view` | See agents (name, status, intent, branch, PRs, cost) and inbox items. Never code, transcripts or local paths. |
| `inbox` | Answer questions, pick a prompt's choice (this can approve a tool), send stuck nudges, warn about overlaps |
| `control` | Message an agent, start, stop, checkpoint, change priority |
| `create` | Start new agents in this machine's registered projects. Never with permission prompts skipped. |
| `terminal` | Open the live Claude terminal |
| `shell` | Open shells in an agent's folder. These run any command, so grant with care. |
| `signin` | Open this machine's own page already signed in: **Open on <machine>** asks for a one-time link (single use, valid for a minute) instead of the access token. That page has full control, beyond the rest of this policy, so grant it only on a hub that only you can sign in to. |

`projects` (names or shortcuts) limits all of it to those projects: other agents aren't shown and can't be touched. `"allow": []` stops sharing but stays joined. The machine checks every request itself, even if the hub thinks it's allowed, matches agents by exact ID, and only runs a fixed list of actions (deleting agents isn't one). Each request, and every refusal, is written to `~/.agentmanager/hub-audit.log`; the hub keeps its own `audit.log` too.

**The shared backlog.** Work you queue on the hub (the **Backlog** tab, or `agentmgr fleet backlog add`) starts on whichever machine can take it, one agent per item. Each item has to land on a machine that is online, allows `create` and shares the project, and that has every label the item asks for. Among those, it goes to one with room, preferring a machine that already has the repo cloned, then the least busy.

- **Projects across machines.** A project matches across machines by its repo, even under different shortcuts; projects without a remote repo match by name.
- **Room.** Each machine sets its own limits: `hub.maxAgents` in total (default `backlogMaxActive`, 4) and `hub.perProject` (default `backlogParallel`, 2). Items from its own local backlog count against them too.
- **Labels.** `os:mac` and `arch:arm64` come automatically, `machine:<name>` pins an item to one machine, and anything else comes from that machine's `hub.labels`, for example `["gpu", "fast-net"]`.
- **Review.** As with the local backlog, an agent whose brief says done moves to **review**: **Accept** finishes it, and **Reopen** sends a note back to the same agent (this needs `control` on that machine). An item waiting for room says why, for example `laptop is full (2/2 in this project)`.
- **When a machine drops mid-item.** Its item shows as **stalled** and isn't restarted elsewhere on its own, because the work in that machine's worktree would be lost or duplicated. Wait for the machine, or **Requeue** to start over on a different one.
- **Pausing.** `agentmgr fleet backlog pause` (or **Auto-start** off) stops new starts; **Start now** runs one item past the limits.

**How machines prove who they are.** Joining makes an Ed25519 key pair on the Mac. The private key stays in `~/.agentmanager/hub-link.json` (mode 600), and the hub keeps only the public key. Each connection signs a fresh challenge from the hub. Invite codes work once. **Remove** on the hub (or `agentmgr hub remove <machine>`) disconnects a machine, and it stops retrying until it joins again.

**Signing in with Google.** Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (a Web application OAuth client whose redirect URI is `<hub address>/api/auth/google/callback`) and `AGENTMGR_HUB_GOOGLE_EMAILS` (comma-separated accounts allowed in). The sign-in page then offers **Sign in with Google**, with the access token folded away below it. It uses the authorization code flow with PKCE, state and nonce, and accepts only verified emails on that list. Without the list, Google sign-in stays off.

**Signing in to the hub.** The hub has one access token: `AGENTMGR_HUB_TOKEN`, or one it generates and prints as a sign-in link (`agentmgr hub token` shows it again). Browsers get a 30-day session cookie. The CLI sends the token: on the hub's own Mac it is read from the hub's state, elsewhere set `AGENTMGR_HUB_TOKEN` and `AGENTMGR_HUB_URL`, or rely on the hub this Mac joined.

**On Railway (later).** `hub/Dockerfile` builds the hub alone, with no node-pty and no Claude. Set `RAILWAY_DOCKERFILE_PATH=hub/Dockerfile`, `AGENTMGR_HUB_TOKEN`, `AGENTMGR_HUB_URL` (its https address) and, for Google sign-in, the three variables above; add a volume at `/data` so enrollments survive redeploys, and join with the `https://…up.railway.app` address.

## Saving state: flush and restart

- **What's saved immediately.** Agent records (session IDs, settings, links) are written to `state.json` on every change, fsynced, then atomically replaced. Claude writes each conversation to its own transcript as it goes.
- **What flush adds.** Each agent's terminal scrollback (restored into the terminal after a restart), session IDs Claude switched to mid-run (`/clear`), and token usage.
- **When it runs.** Every `flushSec` (30 s), on shutdown, and on demand: **Save now** in the agent list, or `agentmgr flush`.
- **Restart.** `agentmgr restart` flushes, stops the daemon (closing agents so Claude saves its sessions), and starts it again, through the login service when installed. Agents that were running resume with the same session IDs.

## Folder trust

Before launching Claude in a folder, agentmgr marks that folder as trusted in Claude Code's config (`~/.claude.json`, `projects[<path>].hasTrustDialogAccepted`). That is the same record Claude writes when you choose "Yes, I trust this folder". It only does this for the folders agents run in: workspaces, the planning folder, general sessions and folders you pass with `-d`.

The first change keeps a backup at `~/.claude.json.agentmgr-backup`. Trusting a folder lets Claude load that repo's project settings and hooks without asking, so set `"trustAgentFolders": false` if you'd rather review repos first.

## Tokens and cost

Usage comes from the session transcripts and is refreshed every few seconds while an agent runs:

- **Sources.** Input, output, cache-write and cache-read tokens for every API request, including the session's subagents.
- **Where it shows.** Per session in **Session history** and `agentmgr sessions`, and summed per agent in the list, the session card, `agentmgr ls` (TOKENS) and `agentmgr show`.
- **Cost.** The figure Claude Code records itself (`cost-state`), shown once it has written one.

## Shell and general sessions

- **Open shell** (or `agentmgr shell <agent>`) starts `$SHELL -l` in the agent's working folder. It shows as a **Shell 1** tab next to the **Claude** tab in the terminal pane; **+ Shell** (or `agentmgr shell <agent> -n 2`) opens more, and **×** on a tab closes that shell. Shells live as long as the daemon and don't start Claude.
- **+ Browser** opens a tab on an address: a port (`5173`), a local address (`localhost:3000/app`), something on the machine's network (`10.0.0.7:8080`, `staging.internal`) or any site (`example.com`, which defaults to https). Tabs are kept with the agent, so every device sees them, and **×** closes one.
  - **On this computer** the tab loads the address directly. Many public sites refuse to appear inside another page, so use **↗** for those.
  - **From another device** (remote access), Agent Manager gives each site its own HTTPS port. That port relays to the site as the machine sees it, so you can check from your phone what the agent built or what the machine can reach. Absolute links, redirects and hot-reload WebSockets on the same site keep working, and the site's "don't show me in a frame" headers are dropped. A link or redirect to a different site leaves the relay.
  - **Safety:** the relay serves only signed-in devices. It never relays to Agent Manager's own ports on any of the machine's addresses, and it removes Agent Manager's sign-in cookie before forwarding. Sites other than localhost must present a valid certificate. The relays close when remote access is turned off.
  - If a tab stays blank on a device, open it once with **↗** and accept the certificate there.
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
  "brief": true,
  "explainModel": null,
  "summaryConcurrency": 2,
  "flushSec": 30,
  "backlogParallel": 2,
  "backlogMaxActive": 4,
  "reviewConventions": true,
  "handoffIdleSec": 5,
  "cloneFilter": "blob:none",
  "shell": "/bin/zsh",
  "inbox": true,
  "maxCheckpoints": 40,
  "raceTestTimeoutSec": 900,
  "conflictRefreshSec": 60,
  "stuck": { "repeatFailures": 3, "thrashReverts": 2, "thrashEdits": 10, "driftMinutes": 20, "driftActions": 25 },
  "hub": { "allow": ["view"], "projects": ["*"] }
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

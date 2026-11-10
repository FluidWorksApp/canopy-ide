# T3 Connect parity

What Canopy does on a Canopy host, and the T3 method that could do it on a T3
Code machine. Method names come from the server bundled in T3 Code (Beta) (the
RPC names in its desktop app); argument and result shapes were **not** read, so
each row is a lead, not a design. Canopy declares the methods it calls in `T3_METHODS`
(`src/t3connect/contracts.ts`) and asks for read, filesystem, terminal and
`orchestration:operate` scopes. The pairing link decides what is granted, so a
machine paired before `orchestration:operate` was asked for lacks it and must
be paired again to start threads.

| Canopy feature | On a Canopy host | T3 method that could back it | Status |
|---|---|---|---|
| Files, tree, editor | `fs_*` | `projects.listEntries / readFile / writeFile / searchEntries / searchContents` | works (search has no UI) |
| Terminal | pty_* | `terminal.open / attach / write / resize / close` | works |
| Start an agent (picker) | launch + CLI | `orchestration.launchThread`, `dispatchCommand`; provider and model from `server.getConfig` | **built**: ＋ Agent opens a shell and types the CLI; ＋ Thread starts a T3 thread (provider, access level, first message) and shows it in a tab. Launch, a follow-up message and Stop were checked against a real T3 0.1.7 server; none of its providers was signed in, so no agent reply was seen |
| Agent card: branch, state | digest, `git_status` | `orchestration.subscribeThread`, `getThreadProjection` | partly: a thread tab shows status, branch, messages, follow-ups and Stop; approvals are answered in T3 Code |
| Agent card: changes | digest files | `getTurnDiff`, `getFullThreadDiff` | not built |
| Agent card: lineage / sub-agents | session activity | `getThreadFamily`, `getNativeChildWork` | not built |
| Worktrees | `git_worktree_*` | `vcs.createWorktree / removeWorktree`, `orchestration.getWorktreeThreadIds` | not built |
| Branch, pull | `git_*` | `vcs.listRefs / switchRef / pull / refreshStatus` | not built |
| PR flow | `gh_pr_*`, commit-push-PR | `git.resolvePullRequest`, `git.preparePullRequestThread`, `git.runStackedAction` | not built |
| Plan usage / Automatic account | `plan_usage` | `server.getUsageSummary` | not built |
| Teleport | `teleport_*` | no transcript export or import seen | not possible yet |
| Preview of a server on the machine | `workspace_forward_*` | no port forward seen | not possible yet |

Next steps if parity matters: answer approvals and input requests in a thread
(`runtime-request.respond`), then the diff (`getTurnDiff`) and lineage
(`getThreadFamily`) parts of the agent card.

Checking it without T3 Code installed: the server inside the app bundle runs
with `node bin.mjs`, and `T3_BIN=<wrapper that execs it> npx vitest run
src/t3connect/t3server.integration.test.ts` starts one on a temporary folder.

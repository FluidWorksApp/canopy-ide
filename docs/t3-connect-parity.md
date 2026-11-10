# T3 Connect parity

What Canopy does on a Canopy host, and the T3 method that could do it on a T3
Code machine. Method names come from the server bundled in T3 Code (Beta) (the
RPC names in its desktop app); argument and result shapes were **not** read, so
each row is a lead, not a design. Canopy today declares only `T3_METHODS` in
`src/t3connect/contracts.ts` and asks for read, filesystem and terminal scopes
only (never `orchestration:operate`).

| Canopy feature | On a Canopy host | T3 method that could back it | Status |
|---|---|---|---|
| Files, tree, editor | `fs_*` | `projects.listEntries / readFile / writeFile / searchEntries / searchContents` | works (search has no UI) |
| Terminal | pty_* | `terminal.open / attach / write / resize / close` | works |
| Start an agent (picker) | launch + CLI | `orchestration.launchThread`, `orchestration.dispatchCommand`; provider via `provider.switch` and `server.getConfig` | shell launch only (PR #757); thread launch needs `orchestration:operate` |
| Agent card: branch, state | digest, `git_status` | `orchestration.subscribeThread`, `getThreadProjection` | not built |
| Agent card: changes | digest files | `getTurnDiff`, `getFullThreadDiff` | not built |
| Agent card: lineage / sub-agents | session activity | `getThreadFamily`, `getNativeChildWork` | not built |
| Worktrees | `git_worktree_*` | `vcs.createWorktree / removeWorktree`, `orchestration.getWorktreeThreadIds` | not built |
| Branch, pull | `git_*` | `vcs.listRefs / switchRef / pull / refreshStatus` | not built |
| PR flow | `gh_pr_*`, commit-push-PR | `git.resolvePullRequest`, `git.preparePullRequestThread`, `git.runStackedAction` | not built |
| Plan usage / Automatic account | `plan_usage` | `server.getUsageSummary` | not built |
| Teleport | `teleport_*` | no transcript export or import seen | not possible yet |
| Preview of a server on the machine | `workspace_forward_*` | no port forward seen | not possible yet |

Next step if parity matters: request `orchestration:operate` at pairing, read
the argument shapes for `launchThread`, `subscribeThread` and `getTurnDiff`
from T3's contracts, and build thread launch plus a T3 branch of the agent card.

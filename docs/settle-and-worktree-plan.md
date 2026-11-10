# Settled sessions, merged PRs and worktree cleanup: plan

Status: plan only, nothing built. Source read: pingdotgg/t3code `main` @ 73fb49d0b3a6.

## What T3 Code does (verified in source)

- **Thread state.** A thread carries `settledOverride` (`settled` | `active` | none), `settledAt`/`unsettledAt`, `snoozedUntil`, `pinnedAt`, `archivedAt` and `autoSettleDisabledAt`. "Working" is not stored: it is derived from active runs, subagents and watched PRs.
- **Becoming settled.** Manually (menu, shortcut, drag onto the Settled header), or automatically, decided by the server every minute and on run/PR events:
  - the linked PR merged or closed (setting `sidebarAutoSettleOnMerge`, default on), but only if it ended after your last message;
  - idle for N days (`sidebarAutoSettleAfterDays`, default 7).
  - Never auto-settled while pinned, snoozed, mid-run, awaiting an approval/question, or with an open PR.
- **Becoming unsettled.** Sending the thread a message, an explicit Un-settle, or pinning it. Snooze wakes on its timer or on a message, approval, question or failure.
- **Merge detection.** No webhook: its own Merge action, or the one-minute sweep re-reading the branch's PR (`git.branchPullRequest`), plus a 5 to 15 minute PR sync.
- **Settling does not delete the worktree.** Worktree removal is a separate storage policy (rules: after N days, after settled, on merge, on delete, when unchanged; all off by default; default keep-rule "has uncommitted changes").
- **Deleting a worktree safely (cleanup policy).** Skip if shared, if the thread is busy, if a terminal is open, if settled under 60 s ago, if the path is a symlink or outside the managed folder, if the branch changed, if `git status --porcelain` shows changes, or if HEAD is not reachable from the default branch (for squash/rebase merges the PR head SHA must equal HEAD). Re-check under a lock, then `git worktree remove` without `--force`.
- **Manual thread delete** in T3's web UI asks "Delete the worktree too?" and then forces; it has no dirty/unpushed check. T3 has no "commit & push" prompt at close, and no "close tab when merged" setting (its unit is a thread, not a tab).

## What Canopy does today (verified)

- Closing an agent tab runs `closeTab` -> `requestAgentClose` (10 s undo) -> `finalizeTabClose`, and 1.5 s after the PTY dies `maybeReapAgentWorkspace` runs (`ProjectView/index.tsx`), using `reapDecision` (`src/agentWorkspaceLifecycle.ts`).
- `reapDecision` returns keep (main, locked, non-`agent/` branch, protected branch, no audit), remove (clean and nothing unpushed) or ask. The ask dialog's **recommended** choice is "Keep the workspace".
- A leftover pristine `agent/<cli>-*` workspace is reused by the next launch (`reuseAgentWorkspace`).
- Commit, push and PR pieces exist separately: `ipc.gitCommit`, `ipc.gitPush(repo, true)`, `OpenPrDialog` (push then `ghPrCreate`). There is no single commit-push-PR action.
- No settle, snooze or archive state, and nothing closes a tab when its PR merges. `ghPrList` returns open PRs only; `ghPrState` is the call that tells merged from closed.

## Proposed behaviour

### 1. Closing an agent terminal removes its worktree (no setting)

| At close | Result |
| --- | --- |
| Clean, nothing only here | Remove the worktree; delete the branch if merged or never pushed; keep a pushed, unmerged branch (it backs a PR). |
| Uncommitted changes or unpushed commits | Warn "Unsaved work in `<branch>`": **Commit, push and open PR** (recommended), **Discard and remove**, **Cancel** (tab stays). There is no "keep it" choice. |
| Commit-and-push succeeded | Remove the worktree, keep the branch for the PR. |
| Commit or push fails | Back to the dialog with the error. Never remove. |

Checks that always win, in this order, before anything is deleted:

1. Another tab or agent is in the same workspace: do nothing.
2. Main worktree, locked, protected branch, or not a Canopy-made `agent/` workspace: never touch it.
3. A fresh audit and the path is a registered worktree of the repo; a missing audit or any git error means keep.
4. Re-read dirty and unpushed immediately before removing, after the PTY is gone.
5. Squash-merge aware: if the PR is MERGED and its head equals local HEAD, unpushed counts as zero.
6. Run a normal `git worktree remove` first; `--force` only for the explicit Discard choice, and only for the counts the dialog showed.

Also: a startup sweep for Canopy-made workspaces left behind by a crash or quit, using the same checks, and never while an agent is working.

### 2. Settled / unsettled (T3's model, scaled to Canopy)

- **Settled** = finished work whose tab can be put away: the PR merged or closed, or you settled it by hand. **Unsettled** = anything still running, waiting on you, or with an open PR.
- Settled sessions are hidden from the strip's Working/Idle groups and listed in a collapsed "Settled" group (like T3's sidebar), and the agents panel and floating card show a "Settled" state.
- A new message to a settled agent un-settles it. Pinned tabs are never auto-settled.
- Triggers, in order of effort: manual Settle in the tab menu; auto on PR merged/closed; optional idle-days rule (default off).
- Settling does not by itself delete anything; closing a tab does (section 1).

### 3. Option: close the tab when its PR merges (default off)

Canopy-original (T3 has no equivalent). When a branch that had an open PR is seen merged (`prs:tick` plus `ghPrState`; `ghPrList` drops merged PRs, so the signal is "was open, now absent, state MERGED"), settle the session and, if the option is on, close the tab through the normal close path, which then removes its worktree. Never while the agent is working or waiting on you.

### 4. Right panel

The floating card already shows branch, PR number and status chip and changes. Add: the PR list for the session (merged / open / closed per PR), a Settle / Un-settle action, and the same Commit, push and PR action the close dialog uses.

## Build order

1. Extract one `commitPushPr` helper from `OpenPrDialog` (commit with session trailers, push with upstream, create PR) and use it from the dialog and the card.
2. Rework `reapDecision` / `maybeReapAgentWorkspace`: remove the keep choice, add the warn flow and the safety order above, squash-merge awareness, startup sweep. Tests for each check.
3. Settled state: type, persistence (snapshot field), tab-strip group, menu actions, card state.
4. Auto-settle on PR merged/closed; the optional close-on-merge setting.
5. Card PR list.

## Risks and decisions for the owner

- **Discard is destructive.** The dialog must show file and commit counts and the path, and must not be the default.
- **Untracked build output** counts as "dirty" (`git status --porcelain`), so a project without a good `.gitignore` will warn often.
- **Cancel semantics.** Today the reap runs after the tab is already gone (10 s undo covers cancel). To warn before closing, the check moves into `requestAgentClose`.
- **Remote/Linux workspaces:** the reap reads local worktrees; remote parity is unchecked.
- **Quit or crash** skips close, so leftovers remain until the startup sweep.
- **Decision:** should "settled" also be reachable by an idle timeout, as T3 defaults to (7 days)? Recommended: off.

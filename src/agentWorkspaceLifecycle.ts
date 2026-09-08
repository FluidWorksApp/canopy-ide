// What happens to an agent's workspace around its terminal's lifetime.
//
// Launch: a pristine leftover workspace for the same CLI is reused (after a
// fast-forward to the repo's current HEAD) instead of minting yet another
// worktree — the accumulation ⌘N used to cause, and the seconds it used to
// cost. Close: the workspace the closing tab ran in is reaped when nothing in
// it can be lost, and asked about when something can.
//
// The decisions are pure functions over the git facts (`gitWorktrees`,
// `gitWorkAudit`) so the rules that delete a folder are tested rather than
// clicked. Only `agent/…` branches — the ones agentWorkspaceBranch mints — are
// ever considered; a workspace the user made by hand is never touched.
import * as ipc from "./ipc";
import { agentBranchSlug } from "./agentSpawn";

/** The branch namespace agent workspaces live in. */
const AGENT_BRANCH_PREFIX = "agent/";

/** The workspace worktree `cwd` sits in, when it sits in one. Worktrees are
 *  created as `<repo>-wt-<name>` siblings of the checkout (see switchTo), so
 *  the root is recoverable from the path alone — no git call, which matters
 *  because this runs on every tab close. */
export function agentWorkspaceRoot(
  cwd: string,
  repoPaths: readonly string[],
): { repo: string; root: string } | null {
  for (const repo of [...repoPaths].sort((a, b) => b.length - a.length)) {
    if (cwd === repo || cwd.startsWith(`${repo}/`)) return null;
    const prefix = `${repo}-wt-`;
    if (!cwd.startsWith(prefix)) continue;
    const name = cwd.slice(prefix.length).split("/")[0];
    if (name) return { repo, root: `${prefix}${name}` };
  }
  return null;
}

export type ReapDecision =
  | { kind: "keep" }
  /** Nothing in the workspace exists only there: remove it without asking.
   *  `deleteBranch` when the branch itself also holds nothing of its own. */
  | { kind: "remove"; branch: string; deleteBranch: boolean }
  /** Work that exists nowhere else — the user decides. */
  | { kind: "ask"; branch: string; dirty: number; unpushed: number };

/** What closing the last tab in a workspace should do to it. */
export function reapDecision(
  worktree: ipc.WorktreeInfo | undefined,
  work: ipc.BranchWork | undefined,
): ReapDecision {
  if (!worktree || worktree.is_main || worktree.locked != null)
    return { kind: "keep" };
  const branch = worktree.branch;
  if (!branch || !branch.startsWith(AGENT_BRANCH_PREFIX))
    return { kind: "keep" };
  // No audit row means git couldn't say what the branch holds — silence is
  // never licence to delete.
  if (!work || work.protected) return { kind: "keep" };
  const dirty = Math.max(worktree.dirty, work.dirty);
  // `ahead` is unpushed commits when the branch has an upstream, commits
  // beyond base when it doesn't; `merged` means base already contains the tip
  // either way. Zero of the one or true of the other = nothing only here.
  const unpushed = work.merged ? 0 : work.ahead;
  if (dirty === 0 && unpushed === 0)
    return {
      kind: "remove",
      branch,
      // A branch that was never pushed and holds nothing beyond base (or is
      // merged) says nothing the repo doesn't: take it with the folder. A
      // pushed, unmerged branch backs an open PR — the folder can go, the
      // branch stays.
      deleteBranch: work.merged || !work.upstream,
    };
  return { kind: "ask", branch, dirty, unpushed };
}

/** A leftover workspace `launchCli` may reuse: same CLI's branch namespace,
 *  nothing in it (clean, no commits of its own, never pushed), and not held by
 *  git for any reason. Newest first, so reuse drains recent leftovers. */
export function pickReusableWorkspace(
  agentId: string,
  worktrees: readonly ipc.WorktreeInfo[],
  work: readonly ipc.BranchWork[],
): ipc.WorktreeInfo | null {
  const prefix = `${AGENT_BRANCH_PREFIX}${agentBranchSlug(agentId)}-`;
  const byBranch = new Map(work.map((item) => [item.branch, item]));
  return (
    worktrees
      .filter((w) => {
        if (w.is_main || w.locked != null || w.prunable != null) return false;
        if (!w.branch?.startsWith(prefix) || w.dirty > 0) return false;
        const item = byBranch.get(w.branch);
        return (
          item != null &&
          !item.protected &&
          item.dirty === 0 &&
          item.ahead === 0 &&
          !item.upstream
        );
      })
      .sort((a, b) => (b.branch ?? "").localeCompare(a.branch ?? ""))[0] ?? null
  );
}

/** Find and fast-forward a reusable workspace for this CLI. Any refusal —
 *  nothing eligible, a realign the backend declined, a git error — answers
 *  null, and the caller makes a fresh workspace instead. */
export async function reuseAgentWorkspace(
  repo: string,
  agentId: string,
): Promise<string | null> {
  try {
    const [worktrees, audit] = await Promise.all([
      ipc.gitWorktrees(repo),
      ipc.gitWorkAudit(repo),
    ]);
    const pick = pickReusableWorkspace(agentId, worktrees, audit.items);
    if (!pick) return null;
    await ipc.gitWorktreeRealign(repo, pick.path);
    return pick.path;
  } catch {
    return null;
  }
}

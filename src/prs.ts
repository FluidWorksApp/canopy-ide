// PR-side counterparts to the ticket helpers in trackers.ts: the worktree a
// PR's head branch already lives in (if any), and the opening context an agent
// gets when a PR is handed to it for review.
import type * as ipc from "./ipc";

/** A worktree already holding this PR's head branch, if one exists — so a
 *  second review reuses it instead of stacking another checkout. */
export function prWorktree(
  pr: ipc.PrInfo,
  worktrees: ipc.WorktreeInfo[],
): ipc.WorktreeInfo | undefined {
  return worktrees.find(
    (w) => !w.is_main && !!w.branch && (w.branch === pr.branch || w.branch.endsWith(`/${pr.branch}`)),
  );
}

/** What a review agent is told: the PR, that its branch is checked out here,
 *  and to read the diff and report — not to push changes. */
export function prReviewContext(pr: ipc.PrInfo): string {
  return (
    `Review pull request #${pr.number}: "${pr.title}" (${pr.url}). ` +
    `It proposes merging ${pr.branch} into ${pr.base}, and this worktree has ${pr.branch} checked out. ` +
    `Read the diff (e.g. \`gh pr diff ${pr.number}\` or \`git diff ${pr.base}...HEAD\`) and the ` +
    `surrounding code, then give a thorough review — correctness, edge cases, tests, and risks — ` +
    `and summarize your findings. Don't commit or push; the review is for the human to act on.`
  );
}

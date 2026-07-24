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

/** What a conflict-resolution agent is told: the PR conflicts with its base,
 *  its branch is checked out here, and to merge the base in, resolve every
 *  conflict preserving both sides' intent, verify, and push so the PR updates. */
export function prConflictContext(pr: ipc.PrInfo): string {
  return (
    `Pull request #${pr.number}: "${pr.title}" (${pr.url}) has merge conflicts with its base. ` +
    `It merges ${pr.branch} into ${pr.base}, and this worktree has ${pr.branch} checked out. ` +
    `Bring in the latest base (e.g. \`git fetch origin\` then \`git merge origin/${pr.base}\`), then ` +
    `resolve every conflict by editing the files and removing the conflict markers — preserving the ` +
    `intent of BOTH sides, not just picking one. Once nothing conflicts, stage and commit the merge, ` +
    `run the build and tests if the project has them, and when everything is green push the branch ` +
    `(\`git push\`) so the PR stops showing conflicts. Summarize any non-obvious resolution choices for the human.`
  );
}

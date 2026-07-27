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

/** When an agent runs in a throwaway worktree we created for it, tell it to
 *  tear that worktree down as its last step. `git -C <repo>` runs from the main
 *  checkout, so removal works even though the agent's own cwd is the worktree.
 *  Shared with the micro-tasks that ask for the same isolation (microTasks.ts). */
export function cleanupLine(repo: string, worktree: string): string {
  return (
    ` This worktree was created just for this task — when you're finished, remove it as your last step: ` +
    `\`git -C "${repo}" worktree remove --force "${worktree}"\`.` +
    // Removing the worktree takes everything in it. Code is safe — it was
    // committed and pushed — but a notes file, a report, a screenshot written
    // beside it is not, and the history row then lists a file that is gone.
    ` Anything you write that is NOT committed — a report, notes, a scratch file — must go under ` +
    `\`${repo}/.canopy/\` instead of in this worktree, or it disappears with it. Create that ` +
    `directory if it isn't there, and make sure \`.canopy/\` is in \`${repo}/.git/info/exclude\` ` +
    `so it never shows up as a repo change.`
  );
}

/** Every PR worktree is checked out detached at the PR's head, never on the
 *  branch — git allows a branch in one worktree at a time, and the PR you are
 *  working on is usually the one checked out in the main repo (see
 *  git_worktree_add_pr). So a bare `git push` has no upstream to push to and
 *  the agent needs the refspec spelled out. */
export function detachedPushLine(branch: string): string {
  return (
    ` This worktree is detached at the PR's head — ${branch} itself is not checked out here, because ` +
    `git only allows that in one place at a time. Push with \`git push origin HEAD:${branch}\`, not a ` +
    `bare \`git push\`, and do not create or switch branches.`
  );
}

/** What a review agent is told: the PR, that its head is checked out here,
 *  and to read the diff and report — not to push changes. When `wt` is given
 *  the agent is in a throwaway worktree and is asked to clean it up when done. */
export function prReviewContext(pr: ipc.PrInfo, wt?: { repo: string; worktree: string }): string {
  return (
    `Review pull request #${pr.number}: "${pr.title}" (${pr.url}). ` +
    `It proposes merging ${pr.branch} into ${pr.base}, and this worktree is checked out at its head. ` +
    `Read the diff (e.g. \`gh pr diff ${pr.number}\` or \`git diff ${pr.base}...HEAD\`) and the ` +
    `surrounding code, then give a thorough review — correctness, edge cases, tests, and risks — ` +
    `and summarize your findings. Don't commit or push; the review is for the human to act on.` +
    (wt ? cleanupLine(wt.repo, wt.worktree) : "")
  );
}

/** What a conflict-resolution agent is told: the PR conflicts with its base,
 *  its branch is checked out here, and to merge the base in, resolve every
 *  conflict preserving both sides' intent, verify, and push so the PR updates.
 *  When `wt` is given it also tears the throwaway worktree down at the end. */
export function prConflictContext(pr: ipc.PrInfo, wt?: { repo: string; worktree: string }): string {
  return (
    `Pull request #${pr.number}: "${pr.title}" (${pr.url}) has merge conflicts with its base. ` +
    `It merges ${pr.branch} into ${pr.base}, and this worktree is checked out at its head. ` +
    `Bring in the latest base (e.g. \`git fetch origin\` then \`git merge origin/${pr.base}\`), then ` +
    `resolve every conflict by editing the files and removing the conflict markers — preserving the ` +
    `intent of BOTH sides, not just picking one. Once nothing conflicts, stage and commit the merge, ` +
    `run the build and tests if the project has them, and when everything is green push so the PR ` +
    `stops showing conflicts. Summarize any non-obvious resolution choices for the human.` +
    detachedPushLine(pr.branch) +
    (wt ? cleanupLine(wt.repo, wt.worktree) : "")
  );
}

/** Which repository a PR belongs to, said the way GitHub says it: `owner/name`
 *  parsed out of the origin URL (ssh, https, or scp-style, with or without the
 *  trailing `.git`). Falls back to the checkout's folder name, which is still
 *  an answer — with several projects open, a PR tab that names no repo leaves
 *  you counting tabs to work out which #843 you're looking at. */
export function repoLabel(remoteUrl: string, repoPath: string): string {
  const url = remoteUrl.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  // Everything after the host: `git@host:owner/name`, `https://host/owner/name`,
  // `ssh://git@host:22/owner/name`. Take the last two segments.
  const tail = url.replace(/^[a-z+]+:\/\/[^/]+\//i, "").replace(/^[^@]*@[^:]+:/, "");
  const parts = tail.split("/").filter(Boolean);
  if (parts.length >= 2) return parts.slice(-2).join("/");
  return repoPath.replace(/\/+$/, "").split("/").pop() ?? "";
}

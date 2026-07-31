import { describe, expect, it } from "vitest";
import {
  cleanupLine,
  detachedPushLine,
  prConflictContext,
  prReviewContext,
  prWorktree,
  repoLabel,
} from "./prs";
import type * as ipc from "./ipc";

const pr = (over: Partial<ipc.PrInfo> = {}): ipc.PrInfo =>
  ({
    number: 177,
    title: "Collapse the agent surface",
    url: "https://github.com/o/r/pull/177",
    branch: "feat/pr-review-agent-ux",
    base: "main",
    ...over,
  }) as ipc.PrInfo;

const wt = (over: Partial<ipc.WorktreeInfo> = {}): ipc.WorktreeInfo =>
  ({ path: "/repo-wt", branch: "feat/x", is_main: false, ...over }) as ipc.WorktreeInfo;

describe("prWorktree", () => {
  it("finds a worktree already holding the PR's branch", () => {
    const found = prWorktree(pr(), [wt({ branch: "feat/pr-review-agent-ux" })]);
    expect(found?.path).toBe("/repo-wt");
    // Fully-qualified refs count as the same branch.
    expect(
      prWorktree(pr(), [wt({ branch: "refs/heads/feat/pr-review-agent-ux" })]),
    ).toBeTruthy();
  });

  it("never offers the main checkout, however it is holding the branch", () => {
    // Other agents live there. Running in it — or switching it — is the thing
    // the whole worktree dance exists to avoid, so a match there is not a
    // match: the launcher makes a detached worktree instead.
    expect(
      prWorktree(pr(), [wt({ branch: "feat/pr-review-agent-ux", is_main: true })]),
    ).toBeUndefined();
    expect(prWorktree(pr(), [])).toBeUndefined();
    expect(prWorktree(pr(), [wt({ branch: "" })])).toBeUndefined();
  });
});

describe("detachedPushLine", () => {
  it("spells out the refspec, because there is no upstream to infer", () => {
    // The worktree is detached at the PR head (git_worktree_add_pr), so a bare
    // `git push` has nothing to push to. This is the line that says so.
    const line = detachedPushLine("feat/x");
    expect(line).toContain("git push origin HEAD:feat/x");
    expect(line).toContain("detached");
    expect(line).toContain("do not create or switch branches");
  });
});

describe("prConflictContext", () => {
  const ctx = (w?: { repo: string; worktree: string }) => prConflictContext(pr(), w);

  it("merges the base in, preserves both sides, and pushes with the refspec", () => {
    const c = ctx();
    expect(c).toContain("git merge origin/main");
    expect(c).toContain("intent of BOTH sides");
    expect(c).toContain("git push origin HEAD:feat/pr-review-agent-ux");
  });

  it("never claims the branch is checked out — it is not", () => {
    // It said "this worktree has <branch> checked out", which was false the
    // moment the worktree became detached, and would send the agent looking
    // for a branch that isn't there.
    const c = ctx();
    expect(c).toContain("checked out at its head");
    expect(c).not.toContain("has feat/pr-review-agent-ux checked out");
  });

  it("tears down only a worktree we made for it", () => {
    expect(ctx()).not.toContain("worktree remove");
    expect(ctx({ repo: "/repo", worktree: "/repo-wt-pr-177" })).toContain(
      "worktree remove --force",
    );
  });
});

describe("prReviewContext", () => {
  it("reads and reports without pushing, so it gets no refspec line", () => {
    const c = prReviewContext(pr());
    expect(c).toContain("Don't commit or push");
    expect(c).not.toContain("git push origin HEAD:");
    expect(c).toContain("checked out at its head");
  });
});

describe("cleanupLine", () => {
  it("removes from the main checkout, since the agent's cwd is the worktree", () => {
    const line = cleanupLine("/repo", "/repo-wt-pr-177");
    expect(line).toContain('git -C "/repo" worktree remove --force "/repo-wt-pr-177"');
  });
});

describe("repoLabel", () => {
  it("reads owner/name out of every shape of origin URL", () => {
    const want = "FluidWorksApp/canopy-ide";
    expect(repoLabel("git@github.com:FluidWorksApp/canopy-ide.git", "/x")).toBe(want);
    expect(repoLabel("https://github.com/FluidWorksApp/canopy-ide.git", "/x")).toBe(want);
    expect(repoLabel("https://github.com/FluidWorksApp/canopy-ide", "/x")).toBe(want);
    expect(repoLabel("ssh://git@github.com/FluidWorksApp/canopy-ide.git", "/x")).toBe(want);
    // A trailing slash is not a third segment.
    expect(repoLabel("https://github.com/FluidWorksApp/canopy-ide/", "/x")).toBe(want);
  });

  it("keeps only the last two segments of a nested path", () => {
    // Self-hosted GitLab-style groups: the project is still owner/name.
    expect(repoLabel("https://git.acme.com/team/group/svc.git", "/x")).toBe("group/svc");
  });

  it("falls back to the checkout's folder when there is no remote", () => {
    expect(repoLabel("", "/Users/me/Documents/GitHub/canopy")).toBe("canopy");
    expect(repoLabel("", "/Users/me/code/canopy/")).toBe("canopy");
  });
});

// The prune rules, tested rather than clicked — because the thing that makes a
// bulk delete usable is the guarantee that it can't take what you needed, and
// that guarantee lives in `presetSelection` and `runPrune`, not in the dialog.
import { describe, expect, it, vi } from "vitest";
import {
  baseName,
  isBusy,
  loses,
  outcomeSummary,
  planFor,
  presetSelection,
  pruneCandidates,
  pruneIsLossy,
  pruneLabel,
  pruneSummary,
  runPrune,
  selectable,
  tally,
  whyRefused,
  type PruneCandidate,
  type PruneOps,
} from "./prune";
import type * as ipc from "./ipc";

const work = (
  over: Partial<ipc.BranchWork> & { branch: string },
): ipc.BranchWork => ({
  worktree: null,
  is_main: false,
  prunable: false,
  current: false,
  dirty: 0,
  ahead: 0,
  behind: 0,
  upstream: "origin/x",
  upstream_gone: false,
  merged: false,
  protected: false,
  last_commit: "1700000000",
  age_days: 3,
  subject: "a commit",
  author: "someone",
  ...over,
});

const audit = (
  items: ipc.BranchWork[],
  over: Partial<ipc.WorkAudit> = {},
): ipc.WorkAudit => ({
  base: "origin/main",
  counts_degraded: false,
  items,
  ...over,
});

const by = (cands: PruneCandidate[], name: string) =>
  cands.find((c) => c.key === name)!;

describe("classifying a branch", () => {
  it("files that exist in one folder outrank everything else", () => {
    const c = by(
      pruneCandidates(
        audit([
          work({ branch: "feat/a", worktree: "/w/a", dirty: 4, merged: true }),
        ]),
      ),
      "feat/a",
    );
    expect(c.risk).toBe("uncommitted");
    expect(c.loss).toEqual({ files: 4, commits: 0 });
    expect(loses(c)).toBe(true);
  });

  it("a merged branch loses nothing, however far it has drifted from its upstream", () => {
    const c = by(
      pruneCandidates(audit([work({ branch: "feat/b", merged: true, ahead: 6 })])),
      "feat/b",
    );
    expect(c.risk).toBe("safe");
    expect(c.loss.commits).toBe(0);
  });

  it("a deleted remote branch reads as safe — that is what a squash-merge looks like", () => {
    const c = by(
      pruneCandidates(audit([work({ branch: "feat/c", upstream_gone: true })])),
      "feat/c",
    );
    expect(c.risk).toBe("safe");
  });

  it("pushed and unmerged is open work, not clutter", () => {
    const c = by(pruneCandidates(audit([work({ branch: "feat/d" })])), "feat/d");
    expect(c.risk).toBe("open");
    expect(loses(c)).toBe(false);
  });

  it("commits that are on no remote are counted as lost", () => {
    const c = by(
      pruneCandidates(audit([work({ branch: "feat/e", ahead: 3 })])),
      "feat/e",
    );
    expect(c.risk).toBe("unpushed");
    expect(c.loss.commits).toBe(3);
  });

  // The one lie this must never tell: an old git can't count against the base,
  // so an unpushed branch reports 0 and would look disposable.
  it("assumes work when git is too old to count it", () => {
    const c = by(
      pruneCandidates(
        audit([work({ branch: "feat/f", upstream: null })], { counts_degraded: true }),
      ),
      "feat/f",
    );
    expect(c.risk).toBe("unpushed");
    expect(loses(c)).toBe(true);
  });

  it("still assumes work when the remote was deleted and counts are degraded", () => {
    const c = by(
      pruneCandidates(
        audit([work({ branch: "feat/g", upstream_gone: true })], {
          counts_degraded: true,
        }),
      ),
      "feat/g",
    );
    expect(loses(c)).toBe(true);
  });

  it("a workspace whose folder is gone has no files to lose", () => {
    const c = by(
      pruneCandidates(
        audit([
          work({ branch: "feat/h", worktree: "/w/h", prunable: true, dirty: 9, merged: true }),
        ]),
      ),
      "feat/h",
    );
    expect(c.loss.files).toBe(0);
    expect(c.risk).toBe("safe");
  });
});

describe("what is never offered", () => {
  it("names the reason instead of dropping the row", () => {
    const rows = pruneCandidates(
      audit([
        work({ branch: "main", protected: true, merged: true }),
        work({ branch: "develop", protected: true, merged: true }),
        work({ branch: "feat/on-it", current: true, merged: true }),
        work({ branch: "feat/ok", merged: true }),
      ]),
    );
    expect(rows).toHaveLength(4);
    expect(by(rows, "main").blocked).toBe("the base branch");
    expect(by(rows, "develop").blocked).toBe("a protected branch");
    expect(by(rows, "feat/on-it").blocked).toBe("the branch you're on");
    expect(by(rows, "feat/ok").blocked).toBeNull();
    expect(rows.filter(selectable)).toHaveLength(1);
  });
});

describe("busy workspaces", () => {
  it("matches a run's cwd inside the checkout, not only the checkout itself", () => {
    expect(isBusy("/w/a", ["/w/a/packages/api"])).toBe(true);
    expect(isBusy("/w/a", ["/w/a"])).toBe(true);
    expect(isBusy("/w/a", ["/w/ab"])).toBe(false);
    expect(isBusy(null, ["/w/a"])).toBe(false);
    expect(isBusy("/w/a/", ["/w/a"])).toBe(true);
  });

  // Agent workspaces are created *inside* the repo, so a plain prefix test made
  // every one of them mark the main checkout as busy.
  it("doesn't let a workspace inside the repo make the repo look busy", () => {
    expect(isBusy("/repo", ["/repo/.claude/worktrees/feat-a/app"])).toBe(false);
    expect(isBusy("/repo/.claude/worktrees/feat-a", ["/repo/.claude/worktrees/feat-a/app"])).toBe(
      true,
    );
    // …but something running in the repo itself still counts.
    expect(isBusy("/repo", ["/repo/packages/api"])).toBe(true);
  });

  it("marks the row without blocking it", () => {
    const c = by(
      pruneCandidates(
        audit([work({ branch: "feat/live", worktree: "/w/live", merged: true })]),
        ["/w/live/app"],
      ),
      "feat/live",
    );
    expect(c.busy).toBe(true);
    expect(selectable(c)).toBe(true);
  });
});

describe("presets", () => {
  const rows = pruneCandidates(
    audit([
      work({ branch: "main", protected: true, merged: true }),
      work({ branch: "old/merged", merged: true, age_days: 90 }),
      work({ branch: "gone", upstream_gone: true, age_days: 40 }),
      work({ branch: "open/pushed", age_days: 200 }),
      work({ branch: "risky/commits", ahead: 2, age_days: 300 }),
      work({ branch: "risky/files", worktree: "/w/f", dirty: 1, merged: true, age_days: 300 }),
      work({ branch: "busy/merged", worktree: "/w/b", merged: true, age_days: 300 }),
    ]),
    ["/w/b"],
  );

  it("safe takes the disposable pile and nothing else", () => {
    expect([...presetSelection(rows, "safe")].sort()).toEqual(["gone", "old/merged"]);
  });

  it("remote-gone narrows to the squash-merge signal", () => {
    expect([...presetSelection(rows, "gone")]).toEqual(["gone"]);
  });

  it("none clears everything", () => {
    expect(presetSelection(rows, "none").size).toBe(0);
  });

  // The guard the whole feature rests on. "Untouched 30d" is the preset most
  // likely to sweep something up, so it is the one worth naming: every risky
  // branch here is older than the cutoff and none of them may be ticked.
  it("no preset ever ticks a row that would lose work, a blocked row, or a busy one", () => {
    for (const p of ["safe", "gone", "stale"] as const) {
      const picked = presetSelection(rows, p);
      for (const key of picked) {
        const c = by(rows, key);
        expect(loses(c)).toBe(false);
        expect(c.blocked).toBeNull();
        expect(c.busy).toBe(false);
      }
    }
    const stale = presetSelection(rows, "stale");
    expect(stale.has("risky/commits")).toBe(false);
    expect(stale.has("risky/files")).toBe(false);
    expect(stale.has("busy/merged")).toBe(false);
    expect(stale.has("main")).toBe(false);
    // …but it does still reach the merely-old, which is the point of it.
    expect([...stale].sort()).toEqual(["gone", "old/merged", "open/pushed"]);
  });

  it("respects a different cutoff", () => {
    expect([...presetSelection(rows, "stale", 100)]).toEqual(["open/pushed"]);
  });
});

describe("the plan for one row", () => {
  it("removes the folder before the branch, because git refuses the other order", () => {
    const c = by(
      pruneCandidates(audit([work({ branch: "feat/a", worktree: "/w/a", merged: true })])),
      "feat/a",
    );
    expect(planFor(c, false).map((s) => s.kind)).toEqual(["worktree", "branch"]);
  });

  it("never removes this project's own checkout", () => {
    const c = by(
      pruneCandidates(
        audit([work({ branch: "feat/m", worktree: "/repo", is_main: true, merged: true })]),
      ),
      "feat/m",
    );
    expect(planFor(c, true).map((s) => s.kind)).not.toContain("worktree");
  });

  it("adds the remote only when asked, and only when there is one left", () => {
    const [live, gone] = ["feat/live", "feat/gone"].map((name) =>
      by(
        pruneCandidates(
          audit([
            work({ branch: "feat/live", merged: true }),
            work({ branch: "feat/gone", upstream_gone: true }),
          ]),
        ),
        name,
      ),
    );
    expect(planFor(live, false).map((s) => s.kind)).toEqual(["branch"]);
    expect(planFor(live, true).map((s) => s.kind)).toEqual(["branch", "remote"]);
    expect(planFor(gone, true).map((s) => s.kind)).toEqual(["branch"]);
  });

  it("shows the force flag it will actually pass", () => {
    const c = by(
      pruneCandidates(audit([work({ branch: "d", worktree: "/w/d", dirty: 2 })])),
      "d",
    );
    expect(planFor(c, false)[0].hint).toBe("git worktree remove --force /w/d");
  });
});

describe("the tally and its sentence", () => {
  const rows = pruneCandidates(
    audit([
      work({ branch: "a", merged: true, worktree: "/w/a" }),
      work({ branch: "b", merged: true }),
      work({ branch: "c", worktree: "/w/c", dirty: 3, ahead: 2 }),
      work({ branch: "main", protected: true, merged: true }),
    ]),
  );

  it("counts what goes, including the folders", () => {
    expect(tally(rows, new Set(["a", "b"]), false)).toEqual({
      branches: 2,
      worktrees: 1,
      remotes: 0,
      files: 0,
      commits: 0,
    });
  });

  it("counts the remote copies only when they are in the plan", () => {
    expect(tally(rows, new Set(["a", "b"]), true).remotes).toBe(2);
  });

  it("ignores a blocked row even if something manages to select it", () => {
    expect(tally(rows, new Set(["main"]), false).branches).toBe(0);
  });

  it("says nothing is lost when nothing is", () => {
    const t = tally(rows, new Set(["a", "b"]), false);
    expect(pruneIsLossy(t)).toBe(false);
    expect(pruneSummary(t, "origin/main")).toBe(
      "2 branches, 1 workspace go. Nothing is lost — every one of them is already on origin/main or on the remote.",
    );
  });

  it("names the cost in full when there is one", () => {
    const t = tally(rows, new Set(["a", "c"]), false);
    expect(pruneIsLossy(t)).toBe(true);
    expect(pruneSummary(t, "origin/main")).toBe(
      "2 branches, 2 workspaces go. 3 uncommitted files and 2 unpushed commits go with them, and exist nowhere else afterwards.",
    );
  });

  it("has something to say about an empty selection", () => {
    const t = tally(rows, new Set(), false);
    expect(pruneSummary(t, "origin/main")).toBe("Nothing selected.");
    expect(pruneLabel(t)).toBe("Prune");
    expect(pruneLabel(tally(rows, new Set(["a"]), false))).toBe("Prune 1");
  });
});

describe("running it", () => {
  const rows = pruneCandidates(
    audit([
      work({ branch: "a", merged: true, worktree: "/w/a" }),
      work({ branch: "b", merged: true }),
    ]),
  );

  const ops = (over: Partial<PruneOps> = {}): PruneOps => ({
    removeWorktree: vi.fn().mockResolvedValue(""),
    deleteBranch: vi.fn().mockResolvedValue(""),
    deleteRemote: vi.fn().mockResolvedValue(""),
    ...over,
  });

  it("removes each row's folder before its branch", async () => {
    const calls: string[] = [];
    const o = ops({
      removeWorktree: vi.fn(async (p: string) => void calls.push(`wt ${p}`)),
      deleteBranch: vi.fn(async (b: string) => void calls.push(`br ${b}`)),
    });
    const out = await runPrune(rows, o, false);
    expect(calls).toEqual(["wt /w/a", "br a", "br b"]);
    expect(out.every((r) => r.ok)).toBe(true);
  });

  it("leaves the branch alone when its folder wouldn't go", async () => {
    const o = ops({
      removeWorktree: vi.fn().mockRejectedValue(new Error("fatal: '/w/a' is locked")),
    });
    const out = await runPrune(rows, o, false);
    expect(o.deleteBranch).toHaveBeenCalledTimes(1);
    expect(o.deleteBranch).toHaveBeenCalledWith("b");
    expect(out[0]).toEqual({
      key: "a",
      ok: false,
      why: "something still has that workspace locked",
    });
    // One refusal doesn't end the run.
    expect(out[1].ok).toBe(true);
  });

  it("never deletes the remote copy when the local one survived", async () => {
    const o = ops({
      deleteBranch: vi.fn().mockRejectedValue(new Error("error: not fully merged")),
    });
    const out = await runPrune(rows.filter((c) => c.key === "b"), o, true);
    expect(o.deleteRemote).not.toHaveBeenCalled();
    expect(out[0].why).toBe("it still has commits that aren't on the base branch");
  });

  it("forces past uncommitted files only for the row that has them", async () => {
    const dirty = pruneCandidates(
      audit([
        work({ branch: "d", worktree: "/w/d", dirty: 2, merged: true }),
        work({ branch: "c", worktree: "/w/c", merged: true }),
      ]),
    );
    const o = ops();
    await runPrune(dirty, o, false);
    expect(o.removeWorktree).toHaveBeenCalledWith("/w/d", 1);
    expect(o.removeWorktree).toHaveBeenCalledWith("/w/c", 0);
  });

  it("reports progress as it goes", async () => {
    const seen: [number, number][] = [];
    await runPrune(rows, ops(), false, (d, t) => seen.push([d, t]));
    expect(seen).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

describe("wording", () => {
  it("turns git's refusals into something a person can act on", () => {
    expect(whyRefused("error: the branch is checked out at '/w/feat-a'")).toBe(
      "it's open in feat-a",
    );
    expect(whyRefused("error: The branch 'x' is not fully merged.")).toBe(
      "it still has commits that aren't on the base branch",
    );
    expect(whyRefused("fatal: something else entirely")).toBe("something else entirely");
    expect(whyRefused("")).toBe("git wouldn't say why");
  });

  it("never folds refusals into the total", () => {
    expect(outcomeSummary([{ key: "a", ok: true }])).toBe("Pruned 1 branch.");
    expect(
      outcomeSummary([
        { key: "a", ok: true },
        { key: "b", ok: true },
        { key: "c", ok: false, why: "nope" },
      ]),
    ).toBe("Pruned 2 branches. 1 was left alone — each one says why below.");
    expect(outcomeSummary([{ key: "a", ok: false, why: "nope" }])).toBe(
      "Nothing was pruned. 1 was left alone — each one says why below.",
    );
  });

  it("names a folder the way a person does", () => {
    expect(baseName("/a/b/feat-x/")).toBe("feat-x");
    expect(baseName("solo")).toBe("solo");
  });
});

import { describe as suite, expect, it } from "vitest";
import { describe, hasNews, probeKey, remember, shouldPrompt } from "./branchSync";
import type { SyncProbe } from "./ipc";

const probe = (over: Partial<SyncProbe> = {}): SyncProbe => ({
  repo: "/w/app",
  branch: "fix/login",
  base: "origin/main",
  base_head: "abc123",
  behind: 4,
  ahead: 2,
  dirty: 0,
  state: "clean",
  conflicts: [],
  overlap: [],
  subjects: ["fix nav", "bump deps"],
  blocked: null,
  fetch_error: null,
  ...over,
});

suite("when to speak up", () => {
  it("says nothing when the base hasn't moved", () => {
    expect(hasNews(probe({ behind: 0, state: "current" }))).toBe(false);
  });

  it("says nothing while a merge is already in progress", () => {
    // Behind by plenty, but the user is mid-merge — piling on is the one
    // thing this feature must never do.
    expect(hasNews(probe({ state: "blocked", blocked: "a merge is already in progress here" }))).toBe(
      false,
    );
  });

  it("prompts for a clean update, and for a conflicting one", () => {
    expect(shouldPrompt(probe(), [])).toBe(true);
    expect(shouldPrompt(probe({ state: "conflict", conflicts: ["src/a.ts"] }), [])).toBe(true);
  });

  it("stops prompting once waved off, until the base moves again", () => {
    const p = probe();
    const dismissed = remember([], probeKey(p));
    expect(shouldPrompt(p, dismissed)).toBe(false);
    // A new commit on main is new news: ask again.
    expect(shouldPrompt(probe({ base_head: "def456" }), dismissed)).toBe(true);
  });

  it("keeps dismissals per repo, so one project's no isn't another's", () => {
    const dismissed = remember([], probeKey(probe()));
    expect(shouldPrompt(probe({ repo: "/w/other" }), dismissed)).toBe(true);
  });

  it("forgets the oldest dismissals rather than growing forever", () => {
    let keys: string[] = [];
    for (let i = 0; i < 60; i++) keys = remember(keys, `k${i}`);
    expect(keys).toHaveLength(50);
    expect(keys.at(-1)).toBe("k59");
    expect(keys).not.toContain("k0");
  });

  it("re-dismissing the same key doesn't duplicate it", () => {
    const k = probeKey(probe());
    expect(remember(remember([], k), k)).toEqual([k]);
  });
});

suite("what it says", () => {
  it("counts commits, and gets the singular right", () => {
    expect(describe(probe()).headline).toBe("main has 4 new commits");
    expect(describe(probe({ behind: 1 })).headline).toBe("main has 1 new commit");
  });

  it("strips the remote prefix — the user calls it main, not origin/main", () => {
    expect(describe(probe({ base: "origin/develop" })).headline).toContain("develop has");
    // A local base has no prefix to strip.
    expect(describe(probe({ base: "main" })).headline).toBe("main has 4 new commits");
  });

  it("offers a clean merge and promises the existing commits survive", () => {
    const d = describe(probe());
    expect(d.canMerge).toBe(true);
    expect(d.willConflict).toBe(false);
    expect(d.mergeLabel).toBe("Merge main in");
    expect(d.detail).toContain("Your commits stay as they are");
  });

  it("names the conflicting files and says nothing has changed yet", () => {
    const d = describe(probe({ state: "conflict", conflicts: ["src/a.ts", "src/b.ts"] }));
    expect(d.headline).toBe("main has 4 new commits — 2 files would conflict");
    expect(d.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(d.willConflict).toBe(true);
    // The non-destructive promise, stated to the user, not just implemented.
    expect(d.detail).toContain("Nothing has been changed yet");
    expect(d.detail).toContain("keep working");
    // Still offered — resolving now is the user's call to make.
    expect(d.canMerge).toBe(true);
    expect(d.mergeLabel).toBe("Merge and resolve now");
  });

  it("refuses the merge when uncommitted work is in the way, and says which files", () => {
    const d = describe(probe({ dirty: 3, overlap: ["src/a.ts"] }));
    expect(d.canMerge).toBe(false);
    expect(d.blockedReason).toBe("uncommitted changes are in the way");
    expect(d.files).toEqual(["src/a.ts"]);
    expect(d.detail).toContain("Commit or stash it");
  });

  it("admits when it could not check, rather than implying clean", () => {
    const d = describe(probe({ state: "unknown" }));
    expect(d.detail).toContain("too old to check");
    expect(d.canMerge).toBe(true);
  });
});

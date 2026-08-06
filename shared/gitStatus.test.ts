// The classifier every git-status consumer now shares.
//
// Each branch is pinned by its own assertion, on purpose: this file exists so
// that breaking one branch turns exactly one thing red. A suite that only
// checks the happy path would let the ignored branch return "changed" — the
// bug that made every project look permanently dirty — and stay green.

import { describe, expect, it } from "vitest";
import {
  classifyStatus,
  isIgnored,
  isStaged,
  isWithin,
  normalizePath,
  resolveEntryPath,
  trackedChanges,
  trackedGivenExistence,
  trackingFromStatus,
} from "./gitStatus";

describe("question 1: what is this entry", () => {
  it("calls `!!` ignored, and neither staged nor unstaged", () => {
    // `!` is neither a space nor a `?`, so the naive staged test says true and
    // node_modules/ lands under "Staged". That is the bug this line prevents.
    expect(classifyStatus("!!")).toEqual({
      kind: "ignored",
      tracked: false,
      staged: false,
      unstaged: false,
    });
  });

  it("calls `??` untracked: a working-tree presence git does not carry", () => {
    expect(classifyStatus("??")).toEqual({
      kind: "untracked",
      tracked: false,
      staged: false,
      unstaged: true,
    });
  });

  it("calls every other code a change to a file git already carries", () => {
    expect(classifyStatus(" M")).toEqual({
      kind: "changed",
      tracked: true,
      staged: false,
      unstaged: true,
    });
    expect(classifyStatus("M ")).toEqual({
      kind: "changed",
      tracked: true,
      staged: true,
      unstaged: false,
    });
    expect(classifyStatus("MM")).toEqual({
      kind: "changed",
      tracked: true,
      staged: true,
      unstaged: true,
    });
  });

  it("reads the two columns independently for add, delete, rename and conflict", () => {
    expect(classifyStatus("A ").staged).toBe(true);
    expect(classifyStatus(" D").staged).toBe(false);
    expect(classifyStatus(" D").unstaged).toBe(true);
    expect(classifyStatus("R ").staged).toBe(true);
    expect(classifyStatus("UU")).toEqual({
      kind: "changed",
      tracked: true,
      staged: true,
      unstaged: true,
    });
  });

  it("treats an unrecognised code as tracked — the fail-closed direction", () => {
    // An unknown code must never become a fresh way of saying "git will not
    // carry this, so it is safe to write a secret here".
    expect(classifyStatus("").tracked).toBe(true);
    expect(classifyStatus("ZZ").tracked).toBe(true);
    expect(classifyStatus("ZZ").kind).toBe("changed");
  });

  it("exposes the ignore filter under one name", () => {
    expect(isIgnored("!!")).toBe(true);
    expect(isIgnored("??")).toBe(false);
    expect(isIgnored(" M")).toBe(false);
  });

  it("exposes the staged test under one name, with `??` and `!!` not staged", () => {
    expect(isStaged("M ")).toBe(true);
    expect(isStaged("MM")).toBe(true);
    expect(isStaged(" M")).toBe(false);
    expect(isStaged("??")).toBe(false);
    expect(isStaged("!!")).toBe(false);
  });

  it("drops only the ignored rows from a list, keeping row identity", () => {
    const entries = [
      { status: "!!", path: "/repo/node_modules/" },
      { status: "??", path: "/repo/new.ts" },
      { status: " M", path: "/repo/src/App.tsx" },
    ];
    expect(trackedChanges(entries)).toEqual([entries[1], entries[2]]);
    // The same object, not a copy — consumers key rows on identity.
    expect(trackedChanges(entries)[0]).toBe(entries[1]);
  });
});

describe("paths", () => {
  it("normalises separators and the trailing slash git puts on directories", () => {
    expect(normalizePath("C:\\repo\\src")).toBe("C:/repo/src");
    expect(normalizePath("/repo/node_modules/")).toBe("/repo/node_modules");
  });

  it("leaves an absolute entry path alone and anchors a relative one", () => {
    expect(resolveEntryPath("/repo/src/App.tsx", "/repo")).toBe("/repo/src/App.tsx");
    expect(resolveEntryPath(".env.local", "/repo")).toBe("/repo/.env.local");
    expect(resolveEntryPath("C:/repo/a.ts", "C:/repo")).toBe("C:/repo/a.ts");
  });

  it("matches whole path segments, so a sibling prefix is not swallowed", () => {
    expect(isWithin("/repo/apps/web", "/repo/apps/web")).toBe(true);
    expect(isWithin("/repo/apps/web/src/App.tsx", "/repo/apps/web")).toBe(true);
    expect(isWithin("/repo/apps/web-admin/src/App.tsx", "/repo/apps/web")).toBe(false);
  });
});

describe("question 2: is the file's state provable from this list at all", () => {
  // The monorepo that caused the leak: the root's .env.local is gitignored, so
  // it is present as `!!`; the component's is committed, so it is absent
  // entirely. A basename match finds the root row and reads "safe".
  const entries = [
    { status: "!!", path: "/repo/.env.local" },
    { status: " M", path: "/repo/apps/web/src/App.tsx" },
    { status: "??", path: "/repo/apps/web/scratch.ts" },
  ];

  it("proves not-tracked from an ignored entry", () => {
    expect(trackingFromStatus(entries, "/repo/.env.local", "/repo")).toEqual({
      proven: true,
      tracked: false,
      kind: "ignored",
    });
  });

  it("proves not-tracked from an untracked entry", () => {
    expect(trackingFromStatus(entries, "/repo/apps/web/scratch.ts", "/repo")).toEqual({
      proven: true,
      tracked: false,
      kind: "untracked",
    });
  });

  it("proves tracked from a change entry", () => {
    expect(trackingFromStatus(entries, "/repo/apps/web/src/App.tsx", "/repo")).toEqual({
      proven: true,
      tracked: true,
      kind: "changed",
    });
  });

  it("says it cannot tell when no entry mentions the path", () => {
    // NOT `{ tracked: false }`. Absence means tracked-and-unmodified OR the
    // file does not exist, and this list cannot tell those apart.
    expect(trackingFromStatus(entries, "/repo/apps/web/.env.local", "/repo")).toEqual({
      proven: false,
      reason: "absent-from-status",
    });
  });

  it("does not let another directory's entry vouch for this path", () => {
    // The root's ignored `.env.local` must not answer for the component's.
    const proof = trackingFromStatus(entries, "/repo/apps/web/.env.local", "/repo");
    expect(proof.proven).toBe(false);
  });

  it("anchors relative entry paths against the worktree root before matching", () => {
    const relative = [{ status: "!!", path: ".env.local" }];
    expect(trackingFromStatus(relative, "/repo/.env.local", "/repo").proven).toBe(true);
    expect(trackingFromStatus(relative, "/repo/apps/web/.env.local", "/repo").proven).toBe(false);
  });

  it("settles an unproven verdict with existence, and only with existence", () => {
    const unproven = trackingFromStatus(entries, "/repo/apps/web/.env.local", "/repo");
    // On disk and git silent => tracked and unmodified => refuse.
    expect(trackedGivenExistence(unproven, true)).toBe(true);
    // Not on disk => nothing for a commit to carry.
    expect(trackedGivenExistence(unproven, false)).toBe(false);
  });

  it("lets a proof win over the existence evidence", () => {
    const ignored = trackingFromStatus(entries, "/repo/.env.local", "/repo");
    // It exists on disk, but git has positively said it will not carry it.
    expect(trackedGivenExistence(ignored, true)).toBe(false);
    const changed = trackingFromStatus(entries, "/repo/apps/web/src/App.tsx", "/repo");
    expect(trackedGivenExistence(changed, false)).toBe(true);
  });
});

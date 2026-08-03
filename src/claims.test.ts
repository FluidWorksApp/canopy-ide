// The claims vocabulary: three surfaces render a claim, and these pin the one
// place its state, its owner's name and its owner's terminal are decided.
import { describe, expect, it } from "vitest";
import type * as ipcTypes from "./ipc";
import {
  claimLabel,
  claimOwnerCwd,
  claimOwnerName,
  claimOwnerPty,
  claimState,
  claimsOnSamePaths,
  pathsOverlap,
} from "./claims";

const claim = (over: Partial<ipcTypes.AgentClaim> = {}): ipcTypes.AgentClaim => ({
  id: "c1",
  paths: ["/repo/src/auth.ts"],
  owner: "canopy (/repo)",
  owner_key: "pty:7@inst-1",
  pty_id: 7,
  instance: "inst-1",
  note: null,
  at_ms: 1_000,
  released_at_ms: null,
  released_by: null,
  refusals: [],
  ...over,
});

describe("claimState", () => {
  it("maps the two nullable fields onto the four states the UI has words for", () => {
    expect(claimState(claim())).toBe("held");
    expect(claimState(claim({ released_at_ms: 2_000, released_by: "agent" }))).toBe("released");
    expect(claimState(claim({ released_at_ms: 2_000, released_by: "canopy" }))).toBe("dropped");
    expect(claimState(claim({ released_at_ms: 2_000, released_by: "superseded" }))).toBe(
      "superseded",
    );
  });

  it("reads an unrecognised release as a plain release rather than vanishing", () => {
    expect(claimState(claim({ released_at_ms: 2_000, released_by: "??" }))).toBe("released");
  });
});

describe("the owner string", () => {
  it("splits into a name for the row and a directory for the meta line", () => {
    expect(claimOwnerName("canopy-wt-auth (/repo-wt-auth)")).toBe("canopy-wt-auth");
    expect(claimOwnerCwd("canopy-wt-auth (/repo-wt-auth)")).toBe("/repo-wt-auth");
    expect(claimOwnerCwd("bare-name")).toBeNull();
  });
});

describe("claimOwnerPty", () => {
  const stats = [
    { id: 7, cwd: "/repo/src/deep" },
    { id: 9, cwd: "/repo" },
  ];

  it("prefers the exact pty id, which survives an agent that cd'd", () => {
    // The cwd in the owner string still says /repo, but the terminal has long
    // since moved — the string match used to lose it (or worse, find the
    // wrong terminal that happens to sit in /repo).
    expect(claimOwnerPty(claim({ owner: "canopy (/repo)" }), stats, "inst-1")).toBe(7);
  });

  it("refuses a pty id from another app launch — ids restart at 1 every run", () => {
    const c = claim({ instance: "inst-OLD", owner: "canopy (/nowhere)" });
    expect(claimOwnerPty(c, stats, "inst-1")).toBeNull();
  });

  it("falls back to the cwd parse for claims recorded before the field existed", () => {
    const legacy = claim({ pty_id: null, instance: null });
    expect(claimOwnerPty(legacy, stats, "inst-1")).toBe(9);
  });

  it("falls back to the cwd parse when the claim's terminal is gone", () => {
    const c = claim({ pty_id: 42 });
    expect(claimOwnerPty(c, stats, "inst-1")).toBe(9);
    expect(claimOwnerPty(claim({ pty_id: 42, owner: "x (/gone)" }), stats, "inst-1")).toBeNull();
  });
});

describe("labels and overlap", () => {
  it("names a claim by its files, not its owner", () => {
    expect(claimLabel(claim())).toBe("auth.ts");
    expect(claimLabel(claim({ paths: ["/a/x.ts", "/a/y.ts"] }))).toBe("x.ts +1");
  });

  it("treats a file inside a claimed directory as the same ground", () => {
    expect(pathsOverlap("/repo/src", "/repo/src/auth.ts")).toBe(true);
    expect(pathsOverlap("/repo/src/auth.ts", "/repo/src/authx.ts")).toBe(false);
  });

  it("gathers the other claims that touched these files, and only those", () => {
    const mine = claim();
    const rival = claim({ id: "c2", paths: ["/repo/src"] });
    const elsewhere = claim({ id: "c3", paths: ["/repo/docs/readme.md"] });
    expect(claimsOnSamePaths([mine, rival, elsewhere], mine)).toEqual([rival]);
  });
});

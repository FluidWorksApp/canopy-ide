import { describe, expect, it } from "vitest";
import { diffOpenPrs, isMergedState } from "./prMerged";

describe("diffOpenPrs", () => {
  it("remembers a PR seen open on a branch being worked in", () => {
    const r = diffOpenPrs(new Map(), [{ branch: "agent/claude-1", number: 12 }], ["agent/claude-1"]);
    expect(r.tracked.get("agent/claude-1")).toBe(12);
    expect(r.vanished).toEqual([]);
  });

  it("reports a branch whose PR was open and is gone", () => {
    const r = diffOpenPrs(new Map([["agent/claude-1", 12]]), [], ["agent/claude-1"]);
    expect(r.vanished).toEqual([{ branch: "agent/claude-1", number: 12 }]);
    expect(r.tracked.size).toBe(0);
  });

  it("does not report a branch that never had a PR", () => {
    expect(diffOpenPrs(new Map(), [], ["agent/claude-2"]).vanished).toEqual([]);
  });

  it("forgets a branch nobody is working in any more instead of reporting it", () => {
    const r = diffOpenPrs(new Map([["agent/gone", 3]]), [], ["agent/claude-1"]);
    expect(r.vanished).toEqual([]);
    expect(r.tracked.size).toBe(0);
  });

  it("ignores open PRs on branches nobody is watching", () => {
    const r = diffOpenPrs(new Map(), [{ branch: "feature/x", number: 5 }], ["agent/claude-1"]);
    expect(r.tracked.size).toBe(0);
  });
});

describe("isMergedState", () => {
  it("is true only for MERGED", () => {
    expect(isMergedState("MERGED\n")).toBe(true);
    expect(isMergedState("merged")).toBe(true);
    expect(isMergedState("CLOSED")).toBe(false);
    expect(isMergedState("OPEN")).toBe(false);
  });
});

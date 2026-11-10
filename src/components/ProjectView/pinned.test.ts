import { describe, expect, it } from "vitest";
import { isPinnedTab, isSettledTab, splitPinned } from "./helpers";

describe("pinned tabs", () => {
  const tabs = [
    { id: "a" },
    { id: "b", pinned: true },
    { id: "c", pinned: false },
    { id: "d", pinned: true },
  ];

  it("recognises only an explicit pin", () => {
    expect(isPinnedTab({ pinned: true })).toBe(true);
    expect(isPinnedTab({ pinned: false })).toBe(false);
    expect(isPinnedTab({})).toBe(false);
    expect(isPinnedTab({ pinned: "yes" })).toBe(false);
  });

  it("splits the strip into pinned and the rest, each keeping its order", () => {
    const { pinned, rest } = splitPinned(tabs);
    expect(pinned.map((t) => t.id)).toEqual(["b", "d"]);
    expect(rest.map((t) => t.id)).toEqual(["a", "c"]);
  });

  it("is stable when nothing is pinned", () => {
    const { pinned, rest } = splitPinned([{ id: "x" }, { id: "y" }]);
    expect(pinned).toEqual([]);
    expect(rest.map((t) => t.id)).toEqual(["x", "y"]);
  });
});

describe("settled tabs", () => {
  it("are settled only when flagged, and never when pinned", () => {
    expect(isSettledTab({ settled: true })).toBe(true);
    expect(isSettledTab({ settled: false })).toBe(false);
    expect(isSettledTab({})).toBe(false);
    expect(isSettledTab({ settled: true, pinned: true })).toBe(false);
  });
});

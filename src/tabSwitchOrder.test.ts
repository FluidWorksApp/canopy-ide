import { describe, expect, it } from "vitest";
import {
  groupTabSwitch,
  pruneTabUses,
  recordTabUse,
  resolveTabSwitch,
  stepTabSwitch,
  stepTabSwitchAcrossRows,
  stepTabSwitchInRow,
  tabSwitchSnapshot,
} from "./tabSwitchOrder";

describe("tabSwitchSnapshot", () => {
  it("puts the previous context one step after the active tab", () => {
    const recent = recordTabUse(
      recordTabUse([], "a", ["a", "b", "c"]),
      "c",
      ["a", "b", "c"],
    );
    const snapshot = tabSwitchSnapshot(["a", "b", "c"], "c", recent, "recent");
    expect(snapshot).toEqual(["c", "a", "b"]);
    expect(stepTabSwitch(snapshot, "c", ["a", "b", "c"], 1)).toBe("a");
  });

  it("keeps stable tab order when configured", () => {
    expect(
      tabSwitchSnapshot(["a", "b", "c"], "c", ["c", "a", "b"], "order"),
    ).toEqual(["a", "b", "c"]);
  });

  it("adds never-visited tabs after recent contexts in stable order", () => {
    expect(
      tabSwitchSnapshot(["a", "b", "c", "d"], "c", ["c", "a"], "recent"),
    ).toEqual(["c", "a", "b", "d"]);
  });
});

describe("stable switch selection", () => {
  it("skips tabs that close while the switcher is held", () => {
    const snapshot = ["c", "a", "b"];
    expect(stepTabSwitch(snapshot, "c", ["b", "c"], 1)).toBe("b");
  });

  it("resolves a selected tab that closed without following its shifted index", () => {
    const snapshot = ["c", "a", "b"];
    expect(resolveTabSwitch(snapshot, "a", ["b", "c"])).toBe("b");
  });

  it("drops closed tabs from activation history", () => {
    expect(recordTabUse(["b", "a", "gone"], "a", ["a", "b"])).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("pruneTabUses", () => {
  it("drops closed tabs and keeps order, recording nothing", () => {
    expect(pruneTabUses(["c", "gone", "a"], ["a", "b", "c"])).toEqual([
      "c",
      "a",
    ]);
  });

  it("leaves an all-open list untouched", () => {
    expect(pruneTabUses(["b", "a"], ["a", "b"])).toEqual(["b", "a"]);
  });
});

/** Rows: kind of the id's first letter — t1/t2 terminals, f1/f2 files, p1 PRs. */
const keyFor = (id: string) => id[0];

describe("groupTabSwitch", () => {
  it("orders rows by first member and keeps snapshot order within rows", () => {
    expect(groupTabSwitch(["p1", "t1", "f1", "t2", "f2"], keyFor)).toEqual([
      { key: "p", ids: ["p1"] },
      { key: "t", ids: ["t1", "t2"] },
      { key: "f", ids: ["f1", "f2"] },
    ]);
  });

  it("groups an empty snapshot into no rows", () => {
    expect(groupTabSwitch([], keyFor)).toEqual([]);
  });
});

describe("stepTabSwitchInRow", () => {
  const rows = groupTabSwitch(["t1", "t2", "t3", "f1"], keyFor);
  const open = ["t1", "t2", "t3", "f1"];

  it("moves within the row and wraps both ways", () => {
    expect(stepTabSwitchInRow(rows, "t1", open, 1)).toBe("t2");
    expect(stepTabSwitchInRow(rows, "t3", open, 1)).toBe("t1");
    expect(stepTabSwitchInRow(rows, "t1", open, -1)).toBe("t3");
  });

  it("does not move out of a single-member row", () => {
    expect(stepTabSwitchInRow(rows, "f1", open, 1)).toBeNull();
    expect(stepTabSwitchInRow(rows, "f1", open, -1)).toBeNull();
  });

  it("skips members that closed mid-gesture", () => {
    expect(stepTabSwitchInRow(rows, "t1", ["t1", "t3", "f1"], 1)).toBe("t3");
    expect(stepTabSwitchInRow(rows, "t1", ["t1", "t3", "f1"], -1)).toBe("t3");
  });

  it("starts from the top-left when the selection is unknown", () => {
    expect(stepTabSwitchInRow(rows, "gone", open, 1)).toBe("t2");
  });

  it("returns null for no rows", () => {
    expect(stepTabSwitchInRow([], "t1", open, 1)).toBeNull();
  });
});

describe("stepTabSwitchAcrossRows", () => {
  const rows = groupTabSwitch(["t1", "t2", "t3", "f1", "f2", "p1"], keyFor);
  const open = ["t1", "t2", "t3", "f1", "f2", "p1"];

  it("lands on the same position in the adjacent row", () => {
    expect(stepTabSwitchAcrossRows(rows, "t2", open, 1)).toBe("f2");
    expect(stepTabSwitchAcrossRows(rows, "f2", open, -1)).toBe("t2");
  });

  it("clamps the position to a shorter row", () => {
    expect(stepTabSwitchAcrossRows(rows, "t3", open, 1)).toBe("f2");
    expect(stepTabSwitchAcrossRows(rows, "f2", open, 1)).toBe("p1");
  });

  it("wraps past the last row to the first and back", () => {
    expect(stepTabSwitchAcrossRows(rows, "p1", open, 1)).toBe("t1");
    expect(stepTabSwitchAcrossRows(rows, "t1", open, -1)).toBe("p1");
  });

  it("falls through to the row's next surviving member when the landing spot closed", () => {
    expect(
      stepTabSwitchAcrossRows(rows, "t2", ["t1", "t2", "t3", "f1", "p1"], 1),
    ).toBe("f1");
  });

  it("skips a fully closed row", () => {
    expect(
      stepTabSwitchAcrossRows(rows, "t1", ["t1", "t2", "t3", "p1"], 1),
    ).toBe("p1");
  });

  it("stays put with a single row", () => {
    const one = groupTabSwitch(["t1", "t2"], keyFor);
    expect(stepTabSwitchAcrossRows(one, "t2", ["t1", "t2"], 1)).toBe("t2");
  });

  it("returns null when every other tab is closed everywhere", () => {
    expect(stepTabSwitchAcrossRows(rows, "t1", [], 1)).toBeNull();
  });
});

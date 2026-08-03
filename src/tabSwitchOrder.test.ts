import { describe, expect, it } from "vitest";
import {
  recordTabUse,
  resolveTabSwitch,
  stepTabSwitch,
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

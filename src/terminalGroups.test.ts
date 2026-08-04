import { describe, expect, it } from "vitest";
import {
  equalizeSplits,
  layoutSplit,
  leafIds,
  mapSplitTabIds,
  remapTerminalGroups,
  neighborPane,
  removeLeaf,
  splitLeaf,
  swapLeaves,
  updateSplitRatio,
  type TerminalSplitNode,
} from "./terminalGroups";

const leaf = (tabId: string): TerminalSplitNode => ({ type: "leaf", tabId });

describe("terminal split trees", () => {
  it("splits only the requested leaf and preserves visual order", () => {
    const one = splitLeaf(leaf("a"), "a", "b", "horizontal");
    const two = splitLeaf(one, "b", "c", "vertical");
    expect(leafIds(two)).toEqual(["a", "b", "c"]);
    expect(layoutSplit(two).panes).toMatchObject([
      { tabId: "a", left: 0, width: 0.5 },
      { tabId: "b", left: 0.5, top: 0, height: 0.5 },
      { tabId: "c", left: 0.5, top: 0.5, height: 0.5 },
    ]);
  });

  it("collapses the redundant parent when a pane closes", () => {
    const tree = splitLeaf(
      splitLeaf(leaf("a"), "a", "b", "horizontal"),
      "b",
      "c",
      "vertical",
    );
    expect(leafIds(removeLeaf(tree, "b")!)).toEqual(["a", "c"]);
    expect(removeLeaf(leaf("a"), "a")).toBeNull();
  });

  it("clamps resize ratios and equalizes recursively", () => {
    const tree = splitLeaf(leaf("a"), "a", "b", "horizontal");
    if (tree.type !== "split") throw new Error("expected split");
    const resized = updateSplitRatio(tree, tree.id, 0.99);
    expect(layoutSplit(resized).panes[0].width).toBe(0.85);
    expect(layoutSplit(equalizeSplits(resized)).panes[0].width).toBe(0.5);
  });

  it("finds spatial neighbors without wrapping", () => {
    const tree = splitLeaf(
      splitLeaf(leaf("a"), "a", "b", "horizontal"),
      "b",
      "c",
      "vertical",
    );
    expect(neighborPane(tree, "a", "right")).toBe("b");
    expect(neighborPane(tree, "b", "down")).toBe("c");
    expect(neighborPane(tree, "a", "left")).toBeNull();
  });

  it("zooms one leaf without changing the tree", () => {
    const tree = splitLeaf(leaf("a"), "a", "b", "horizontal");
    expect(layoutSplit(tree, "b")).toEqual({
      panes: [{ tabId: "b", left: 0, top: 0, width: 1, height: 1 }],
      dividers: [],
    });
    expect(leafIds(tree)).toEqual(["a", "b"]);
  });

  it("remaps restored tab ids and drops missing leaves", () => {
    const tree = splitLeaf(leaf("old-a"), "old-a", "old-b", "horizontal");
    const restored = mapSplitTabIds(tree, new Map([["old-b", "new-b"]]));
    expect(restored).toEqual({ type: "leaf", tabId: "new-b" });
  });

  it("preserves layout details while collapsing a missing wake leaf", () => {
    const root = splitLeaf(
      splitLeaf(leaf("a"), "a", "b", "horizontal"),
      "b",
      "c",
      "vertical",
    );
    const groups = remapTerminalGroups(
      { g1: { id: "g1", root, activeTabId: "c", zoomedTabId: "c" } },
      new Map([
        ["a", "new-a"],
        ["c", "new-c"],
      ]),
    );
    expect(leafIds(groups.g1.root)).toEqual(["new-a", "new-c"]);
    expect(groups.g1.activeTabId).toBe("new-c");
    expect(groups.g1.zoomedTabId).toBe("new-c");
    expect(groups.g1.root).toMatchObject({ axis: "horizontal", ratio: 0.5 });
  });

  it("drops a persisted group when only one wake leaf survives", () => {
    const root = splitLeaf(leaf("a"), "a", "b", "horizontal");
    expect(
      remapTerminalGroups(
        { g1: { id: "g1", root, activeTabId: "b", zoomedTabId: "b" } },
        new Map([["a", "new-a"]]),
      ),
    ).toEqual({});
  });

  it("swaps pane contents without changing the layout", () => {
    const tree = splitLeaf(leaf("a"), "a", "b", "horizontal");
    expect(leafIds(swapLeaves(tree, "a", "b"))).toEqual(["b", "a"]);
  });
});

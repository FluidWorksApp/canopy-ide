import { describe, expect, it } from "vitest";
import { leafIds } from "./terminalGroups";
import {
  agentWorkspaceBranch,
  placeSpawnedTab,
  spawnedAgentTakesFocus,
} from "./agentSpawn";

describe("agent worktree branch", () => {
  it("names the owner and remains unique for rapid launches", () => {
    expect(
      agentWorkspaceBranch("Codex CLI", new Date("2026-08-18T11:15:30.123Z")),
    ).toBe("agent/codex-cli-20260818-111530-123");
    expect(
      agentWorkspaceBranch("Codex CLI", new Date("2026-08-18T11:15:30.124Z")),
    ).not.toBe(
      agentWorkspaceBranch("Codex CLI", new Date("2026-08-18T11:15:30.123Z")),
    );
  });
});

describe("spawn focus", () => {
  it("honours the existing attention preference both ways", () => {
    expect(spawnedAgentTakesFocus(false)).toBe(false);
    expect(spawnedAgentTakesFocus(true)).toBe(true);
  });
});

describe("placeSpawnedTab", () => {
  it("leaves a plain spawned tab outside the mux model", () => {
    const groups = {};
    expect(placeSpawnedTab(groups, [], "child", { mode: "tab" })).toEqual({ groups });
  });

  it("splits relative to the requested live terminal", () => {
    const placed = placeSpawnedTab(
      {},
      [{ id: "parent", ptyId: 7 }],
      "child",
      { mode: "split", relativeToPtyId: 7, direction: "left" },
    );
    const group = placed.groups[placed.groupId!];
    expect(group.root).toMatchObject({ axis: "horizontal", first: { tabId: "child" } });
    expect(leafIds(group.root)).toEqual(["child", "parent"]);
  });

  it("extends an existing tree instead of replacing it", () => {
    const groups = {
      mux: {
        id: "mux",
        activeTabId: "other",
        root: {
          type: "split" as const,
          id: "old",
          axis: "horizontal" as const,
          ratio: 0.5,
          first: { type: "leaf" as const, tabId: "target" },
          second: { type: "leaf" as const, tabId: "other" },
        },
      },
    };
    const placed = placeSpawnedTab(
      groups,
      [
        { id: "target", ptyId: 3, paneGroup: "mux" },
        { id: "other", ptyId: 4, paneGroup: "mux" },
      ],
      "child",
      { mode: "split", relativeToPtyId: 3, direction: "bottom" },
    );
    expect(placed.groupId).toBe("mux");
    expect(leafIds(placed.groups.mux.root)).toEqual(["target", "child", "other"]);
  });

  it("adds a background split without changing the active pane", () => {
    const placed = placeSpawnedTab(
      {},
      [{ id: "parent", ptyId: 7 }],
      "child",
      { mode: "split", relativeToPtyId: 7, direction: "right" },
      false,
    );
    expect(placed.groups[placed.groupId!].activeTabId).toBe("parent");
  });

  it("refuses a stale relative terminal", () => {
    expect(() =>
      placeSpawnedTab({}, [], "child", {
        mode: "split",
        relativeToPtyId: 99,
        direction: "right",
      }),
    ).toThrow("terminal 99 is no longer open");
  });
});

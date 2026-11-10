import { describe, expect, it } from "vitest";
import { buildAgentHierarchy, flattenAgents, treeForTab } from "./agentHierarchy";
import type { TermSubTab } from "./components/ProjectView/helpers";

const tab = (id: string, ptyId: number, over: Partial<TermSubTab> = {}): TermSubTab =>
  ({ id, type: "terminal", cwd: "/repo", ptyId, command: "claude", launchTitle: id, ...over }) as TermSubTab;
const child = (id: string, ptyId: number, parentPtyId: number, depth = 1) =>
  tab(id, ptyId, { spawnedTask: { runId: "r", attemptId: id, parentPtyId, depth } });

describe("buildAgentHierarchy", () => {
  it("nests children under their parent", () => {
    const roots = buildAgentHierarchy([tab("a", 1), child("b", 2, 1), child("c", 3, 2, 2)]);
    expect(roots).toHaveLength(1);
    expect(roots[0].children[0].tabId).toBe("b");
    expect(roots[0].children[0].children[0]).toMatchObject({ tabId: "c", depth: 2, parentTabId: "b" });
  });

  it("makes an orphan a root", () => {
    const roots = buildAgentHierarchy([child("b", 2, 99)]);
    expect(roots.map((r) => r.tabId)).toEqual(["b"]);
    expect(roots[0].parentTabId).toBeNull();
  });

  it("survives a cycle", () => {
    const roots = buildAgentHierarchy([child("a", 1, 2), child("b", 2, 1)]);
    expect(flattenAgents(roots)).toHaveLength(2);
  });

  it("skips run and micro tabs and plain shells", () => {
    const roots = buildAgentHierarchy([tab("a", 1), tab("r", 2, { run: true }), tab("s", 3, { command: undefined })]);
    expect(roots.map((r) => r.tabId)).toEqual(["a"]);
  });

  it("finds the tree and parent for a child", () => {
    const roots = buildAgentHierarchy([tab("a", 1), child("b", 2, 1), tab("z", 9)]);
    const t = treeForTab(roots, "b");
    expect(t?.tabId).toBe("a");
    expect(flattenAgents([t!]).find((n) => n.tabId === "b")?.parentTabId).toBe("a");
  });
});

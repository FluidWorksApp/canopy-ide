import { splitId, splitLeaf, type TerminalGroup } from "./terminalGroups";

export const MAX_AGENT_SPAWN_DEPTH = 2;
export const MAX_AGENT_SPAWN_CHILDREN = 4;

export type AgentSpawnPlacement =
  | { mode: "tab" }
  | {
      mode: "split";
      relativeToPtyId: number;
      direction: "left" | "right" | "top" | "bottom";
    };

export interface SpawnPlacementTab {
  id: string;
  ptyId: number | null;
  paneGroup?: string;
}

/** Add a new terminal to the existing mux tree without inventing a second
 * geometry model. A missing/stale target is an honest placement failure: the
 * caller can retry as a plain tab instead of silently landing elsewhere. */
export function placeSpawnedTab(
  groups: Record<string, TerminalGroup>,
  tabs: readonly SpawnPlacementTab[],
  nextTabId: string,
  placement: AgentSpawnPlacement,
): { groups: Record<string, TerminalGroup>; groupId?: string } {
  if (placement.mode === "tab") return { groups };
  const target = tabs.find((tab) => tab.ptyId === placement.relativeToPtyId);
  if (!target) {
    throw new Error(
      `terminal ${placement.relativeToPtyId} is no longer open; use placement.mode = "tab" or choose a ptyId from canopy_agents`,
    );
  }
  const current = target.paneGroup ? groups[target.paneGroup] : undefined;
  const groupId = current?.id ?? splitId();
  const horizontal = placement.direction === "left" || placement.direction === "right";
  const before = placement.direction === "left" || placement.direction === "top";
  const root = current?.root ?? { type: "leaf" as const, tabId: target.id };
  const next: TerminalGroup = {
    id: groupId,
    root: splitLeaf(root, target.id, nextTabId, horizontal ? "horizontal" : "vertical", before),
    activeTabId: nextTabId,
  };
  return { groups: { ...groups, [groupId]: next }, groupId };
}

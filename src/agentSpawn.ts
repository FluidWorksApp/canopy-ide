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

/** The existing attention preference is the single focus authority for agent
 *  delegation. Off means create the tab and leave the user's current project,
 *  tab, and active split pane untouched. */
export const spawnedAgentTakesFocus = (agentAskForAttention: boolean) =>
  agentAskForAttention;

/** The sanitized agent id as it appears in workspace branch names — the piece
 *  reuse and reap match on, so it must never drift from agentWorkspaceBranch. */
export function agentBranchSlug(agentId: string): string {
  return agentId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
}

/** Branch name for a generic agent workspace. */
export function agentWorkspaceBranch(agentId: string, now = new Date()): string {
  const safeAgent = agentBranchSlug(agentId);
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace("Z", "")
    .replace(".", "-");
  return `agent/${safeAgent || "agent"}-${stamp}`;
}

/** Add a new terminal to the existing mux tree without inventing a second
 * geometry model. A missing/stale target is an honest placement failure: the
 * caller can retry as a plain tab instead of silently landing elsewhere. */
export function placeSpawnedTab(
  groups: Record<string, TerminalGroup>,
  tabs: readonly SpawnPlacementTab[],
  nextTabId: string,
  placement: AgentSpawnPlacement,
  activate = true,
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
    activeTabId: activate ? nextTabId : (current?.activeTabId ?? target.id),
  };
  return { groups: { ...groups, [groupId]: next }, groupId };
}

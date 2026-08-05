import type { TerminalGroup } from "./terminalGroups";

export const AGENT_CLOSE_UNDO_MS = 10_000;

export interface PendingAgentClose {
  id: string;
  tabIds: string[];
  title: string;
  deadline: number;
  restoreTabId: string;
  groups: Record<string, TerminalGroup>;
}

export function remainingCloseSeconds(deadline: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function pendingAgentTabIds(
  pending: ReadonlyMap<string, PendingAgentClose>,
): Set<string> {
  const ids = new Set<string>();
  for (const close of pending.values()) {
    for (const id of close.tabIds) ids.add(id);
  }
  return ids;
}

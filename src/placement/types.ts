// Placement: where a new agent or project runs. Framework-free so the
// balancer is a pure function and every input is testable.

export type Target =
  | { kind: "local" }
  | { kind: "remote"; workspaceId: string }
  | { kind: "t3"; machineId: string };

/** What the user asked for. "auto" defers to the next level (or balance). */
export type Preference = "local" | "remote" | "balance" | "auto";

export interface ResourceSnapshot {
  target: Target;
  online: boolean;
  activeAgents: number;
  /** Max concurrent agents this target should carry. */
  capacity: number;
  /** 0..1 */
  cpuLoad?: number;
  /** Free memory, 0..1 of total. */
  memFree?: number;
  lastSeen: number;
}

export interface PlacementDecision {
  target: Target | null;
  reason: string;
  alternatives: Target[];
  /** The project is not on the chosen remote yet; run on-demand setup first. */
  needsSetup: boolean;
}

export const targetKey = (t: Target): string =>
  t.kind === "local" ? "local" : t.kind === "remote" ? `remote:${t.workspaceId}` : `t3:${t.machineId}`;

export const sameTarget = (a: Target, b: Target) => targetKey(a) === targetKey(b);

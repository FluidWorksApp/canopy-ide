// Placement: where a new agent or project runs. Framework-free so the
// balancer is a pure function and every input is testable.

export type Target =
  | { kind: "local" }
  | { kind: "remote"; workspaceId: string }
  | { kind: "t3"; machineId: string };

/** What the user asked for. Inheritance is available only at override levels;
 * automatic is always an explicit request to balance over live targets. */
export type Preference =
  | { mode: "inherit" }
  | { mode: "automatic" }
  | { mode: "target"; target: Target };

export type ResolvedPreference = Exclude<Preference, { mode: "inherit" }>;

export interface DisplayTarget {
  target: Target;
  name: string;
  online: boolean;
}

export interface ResourceSnapshot {
  target: Target;
  online: boolean;
  activeAgents: number;
  /** False when activeAgents could not be read (assumed 0). Balance prefers
   *  targets whose load is known. */
  loadUnknown?: boolean;
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
  /** User-facing name supplied by the gathering/UI layer when available. */
  targetName?: string;
}

export const targetKey = (t: Target): string =>
  t.kind === "local" ? "local" : t.kind === "remote" ? `remote:${t.workspaceId}` : `t3:${t.machineId}`;

export const sameTarget = (a: Target, b: Target) => targetKey(a) === targetKey(b);

export const preferenceKey = (p: Preference): string =>
  p.mode === "target" ? targetKey(p.target) : p.mode;

export const automaticPreference = (): { mode: "automatic" } => ({ mode: "automatic" });
export const inheritPreference = (): { mode: "inherit" } => ({ mode: "inherit" });
export const targetPreference = (target: Target): { mode: "target"; target: Target } => ({ mode: "target", target });

// Ash — the Canopy mark read as a face. Everything about the mascot that isn't
// SVG: the state vocabulary, the map from an agent's lifecycle onto it, the
// size ladder, and the two-character terminal form.

export type AshState =
  | "idle"
  | "thinking"
  | "done"
  | "needs"
  | "blocked"
  | "sleeping"
  | "celebrating"
  | "explaining";

export type AshTone = "accent" | "ok" | "warn" | "danger" | "dim";

export interface AshLook {
  state: AshState;
  tone: AshTone;
}

export const ASH_STATES: AshState[] = [
  "idle",
  "thinking",
  "done",
  "needs",
  "blocked",
  "sleeping",
  "celebrating",
  "explaining",
];

const LIFECYCLE: Record<string, AshLook> = {
  working: { state: "thinking", tone: "ok" },
  waiting: { state: "needs", tone: "warn" },
  idle: { state: "done", tone: "dim" },
  ended: { state: "sleeping", tone: "dim" },
  stale: { state: "sleeping", tone: "warn" },
};

/** The face and colour for one of `effectiveState()`'s lifecycle values. */
export function ashFor(state: string | null | undefined): AshLook {
  return (state ? LIFECYCLE[state] : undefined) ?? { state: "idle", tone: "dim" };
}

const DEFAULT_TONE: Record<AshState, AshTone> = {
  idle: "dim",
  thinking: "ok",
  done: "ok",
  needs: "warn",
  blocked: "danger",
  sleeping: "dim",
  celebrating: "ok",
  explaining: "accent",
};

export function ashTone(state: AshState): AshTone {
  return DEFAULT_TONE[state];
}

export const ASH_TONE_VARS: Record<AshTone, string> = {
  accent: "var(--accent)",
  ok: "var(--ok)",
  warn: "var(--warn)",
  danger: "var(--danger)",
  dim: "var(--text-dim)",
};

const GLYPHS: Record<AshState, string> = {
  idle: "[••]",
  thinking: "[··]",
  done: "[^^]",
  needs: "[!!]",
  blocked: "[××]",
  sleeping: "[--]",
  celebrating: "[++]",
  explaining: "[->]",
};

/** Ash where SVG can't go — a notification title, a log line, a window title. */
export function ashGlyph(state: AshState): string {
  return GLYPHS[state];
}

/** Only these two may pull the user out of what they are doing. */
export function ashMayInterrupt(state: AshState): boolean {
  return state === "needs" || state === "blocked";
}

export type AshTier = "full" | "compact" | "small" | "mono";

export interface AshMetrics {
  tier: AshTier;
  arc: { r: number; x0: number; x1: number; y: number };
  stroke: number;
  eye: { r: number; cy: number; dx: number };
  /** The mouth is the first thing to go. */
  mouth: boolean;
  /** Expression — curved eyes, crosses, the chevron, sparks — survives here. */
  expressive: boolean;
  /** Eyes take the state colour rather than ink. */
  monochrome: boolean;
}

const TIERS: Record<AshTier, Omit<AshMetrics, "tier">> = {
  full: {
    arc: { r: 11.2, x0: 8.8, x1: 31.2, y: 19.6 },
    stroke: 3.4,
    eye: { r: 2.2, cy: 26, dx: 4.6 },
    mouth: true,
    expressive: true,
    monochrome: false,
  },
  compact: {
    arc: { r: 11.2, x0: 8.8, x1: 31.2, y: 19.6 },
    stroke: 3.6,
    eye: { r: 2.4, cy: 26.4, dx: 4.6 },
    mouth: false,
    expressive: true,
    monochrome: false,
  },
  small: {
    arc: { r: 11.2, x0: 8.8, x1: 31.2, y: 19.6 },
    stroke: 4,
    eye: { r: 2.7, cy: 26.8, dx: 4.6 },
    mouth: false,
    expressive: false,
    monochrome: false,
  },
  mono: {
    arc: { r: 10.6, x0: 9.4, x1: 30.6, y: 20 },
    stroke: 4.8,
    eye: { r: 3.2, cy: 28.2, dx: 5 },
    mouth: false,
    expressive: false,
    monochrome: true,
  },
};

export function ashTier(size: number): AshTier {
  if (size > 32) return "full";
  if (size > 24) return "compact";
  if (size >= 20) return "small";
  return "mono";
}

export function ashMetrics(size: number): AshMetrics {
  const tier = ashTier(size);
  return { tier, ...TIERS[tier] };
}

export function ashArcPath(arc: AshMetrics["arc"]): string {
  return `M${arc.x0} ${arc.y} A${arc.r} ${arc.r} 0 0 1 ${arc.x1} ${arc.y}`;
}

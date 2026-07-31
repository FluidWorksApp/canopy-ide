// What each CLI can prove about itself, read from the manifest both languages
// share.
//
// The bug this exists to make impossible: `state_for` in canopy_hook.rs took no
// `agent` argument. Every CLI was asked the same questions and every answer was
// believed equally, so a CLI that cannot report being blocked had that state
// invented for it (agy: every notification read "waiting", permanently) and a
// CLI that cannot report anything else had "finished" invented for it (aider,
// from a message string Canopy itself wrote and then re-parsed).
//
// A fidelity row is a promise about an installer. `src/agentFidelityGuard.test.ts`
// checks the promise against `src-tauri/src/agents.rs` in both directions.
import manifest from "./fidelity.json";
import type { LifeState } from "./vocabulary";

/** What a CLI's notification-shaped event means, if it has one at all. */
export type NotificationMeaning =
  /** Every notification is a block — the CLI has a dedicated event for it. */
  | "block"
  /** The message text distinguishes a block from a completion notice, and the
   *  text is the CLI's own. */
  | "mixed"
  /** It wants the keyboard and cannot say which kind. */
  | "attention-only"
  /** The payload carries no field we can read. */
  | "unmapped"
  /** No notification event at all. */
  | "none";

export interface CliFidelity {
  /** Must be in SUPPORTED_AGENTS (src-tauri/src/agents.rs). */
  id: string;
  /** Events that prove the session is gone. */
  endsSession: string[];
  /** Events that prove a turn finished. */
  endsTurn: string[];
  /** Events that prove a turn started. */
  startsTurn: string[];
  /** Events that prove work is progressing. */
  toolActivity: string[];
  /** Events that prove the agent is blocked, structurally — a tool-name
   *  equality or a dedicated permission event. No free text. */
  structuredBlock: string[];
  notification: NotificationMeaning;
  /** Read only when `notification === "mixed"`: the CLI's own completion text. */
  promptReadyText?: string;
  /** Some of this CLI's events reach the bus with no pty stamp, so they can
   *  never satisfy a per-terminal rung. */
  unstampedBus?: boolean;
  /** Hooks are written but inert until a manual step. Downgrades `proven` to
   *  `reported` until a stamped event proves otherwise. */
  needsTrust?: boolean;
  /** When a human last checked this row against the installer. A stale claim
   *  should be visible rather than assumed. */
  verifiedAt: string;
}

/** A CLI we have never heard of declares nothing. Every rung that consults the
 *  manifest is therefore skipped for it, and it falls through to the process
 *  and output evidence — which is the honest answer, not a guess. */
export const UNKNOWN_CLI: CliFidelity = {
  id: "",
  endsSession: [],
  endsTurn: [],
  startsTurn: [],
  toolActivity: [],
  structuredBlock: [],
  notification: "none",
  verifiedAt: "never",
};

const BY_ID: Map<string, CliFidelity> = new Map(
  (manifest.clis as CliFidelity[]).map((c) => [c.id, c]),
);

export const ALL_FIDELITY: readonly CliFidelity[] =
  manifest.clis as CliFidelity[];

export function fidelityFor(agent: string | null | undefined): CliFidelity {
  return (agent && BY_ID.get(agent)) || UNKNOWN_CLI;
}

/** Which states this CLI's own events can reach. `ended` is omitted even for
 *  the two CLIs that declare `endsSession`, because the process-gone rung
 *  reaches it for everyone — this answers "what can the CLI tell us", not
 *  "what can we work out". */
export function reachableStates(agent: string): LifeState[] {
  const f = fidelityFor(agent);
  const out: LifeState[] = [];
  if (f.startsTurn.length || f.toolActivity.length) out.push("working");
  if (f.structuredBlock.length || f.notification === "block") out.push("waiting");
  if (f.notification === "attention-only") out.push("waiting");
  if (f.endsTurn.length) out.push("idle");
  if (f.endsSession.length) out.push("ended");
  return out;
}

/** Whether a notification-shaped event from this CLI may be read as a block at
 *  all. `unmapped` and `none` mean the rung is skipped and the prior state
 *  stands — the difference between "we don't know" and inventing an answer. */
export function canDeclareBlock(f: CliFidelity): boolean {
  return (
    f.notification === "block" ||
    f.notification === "mixed" ||
    f.notification === "attention-only"
  );
}

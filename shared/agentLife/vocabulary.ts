// The words Canopy uses for what an agent is doing. One axis, one set of
// values, no synonyms anywhere else in the app.
//
// Before this module there were five: the hook stream's four states, the tab
// strip's three buckets, `effectiveState`'s `stale`, the workspace rail's
// `unknown`, and the peer roster's `idle | active | stale`. Five vocabularies
// for one question is five chances for two screens to describe the same
// session differently, which is exactly the bug you cannot see from either
// screen alone.

/** What the agent is doing. */
export type LifeState =
  /** A process is here and nothing has spoken for it yet. */
  | "starting"
  /** A turn is in flight. */
  | "working"
  /** Blocked on the human — a question or a permission prompt. */
  | "waiting"
  /** Finished a turn, process alive, nothing outstanding. */
  | "idle"
  /** The session is gone. */
  | "ended"
  /** No signal we are willing to stand behind. */
  | "unknown";

export const LIFE_STATES: readonly LifeState[] = [
  "starting",
  "working",
  "waiting",
  "idle",
  "ended",
  "unknown",
] as const;

/** How well the state is backed. Not decorative: `reclaimable` keys on it, so
 *  this is what stands between an agent mid-turn and a SIGTERM. */
export type Confidence =
  /** A structural signal from a CLI whose manifest says it can emit it. */
  | "proven"
  /** The CLI said something whose meaning is ambiguous. */
  | "reported"
  /** We worked it out from the process, its output, or its CPU. */
  | "inferred";

/** Why we are saying `unknown`. Shown in the tooltip, because "we don't know"
 *  is only useful when it says which kind of not-knowing. */
export type UnknownReason =
  /** No digest and no events — the CLI's hooks may not be installed. */
  | "never-reported"
  /** Was working; then silent in hooks, in output, and in CPU together. */
  | "went-quiet"
  /** This CLI structurally cannot answer this question. */
  | "cli-cannot-report"
  /** The digest came from the CLI's own store, which records no state. */
  | "store-only"
  /** The digest belongs to a different launch of the app. */
  | "foreign-instance";

/** Which rung of the ladder answered. Shown in the row tooltip, and what the
 *  tests pin — the same discipline as `AgentIdentity.via`, where naming the
 *  rung is what makes a regression legible instead of merely wrong. */
export type Via =
  | "process-gone"
  | "session-end"
  | "structured-block"
  | "declared-block"
  | "turn-boundary"
  | "turn-start"
  | "tool-activity"
  | "output"
  | "cpu"
  | "startup"
  | "none";

export interface Life {
  state: LifeState;
  confidence: Confidence;
  via: Via;
  /** Set if and only if `state === "unknown"`. */
  reason?: UnknownReason;
  /** Unix seconds of the evidence that put us here. */
  since: number;
  /** The row tooltip: names the rung, and names the CLI's limit when that
   *  limit is why we can't say more. */
  note: string;
  /** Which CLI, when we know. */
  agent: string | null;
}

/** What the human has not dealt with. A separate axis from `LifeState`, and
 *  deliberately not derivable from it: "the agent is blocked" and "you haven't
 *  looked at this tab" are different facts with different clearing rules.
 *
 *  `blocked` is the agent's claim and only agent-side progress clears it.
 *  `unseen` is a property of your attention and focus clears it. Folding the
 *  two — which is what `statusFor(state, unread)` did — means a ring you never
 *  clicked away outranks what the agent is actually doing. */
export type Attention =
  | { kind: "none" }
  | {
      kind: "blocked";
      since: number;
      why: "question" | "permission" | "ambiguous-notice";
    }
  | {
      kind: "unseen";
      since: number;
      why: "osc-notice" | "went-quiet" | "finished";
    };

export const NO_ATTENTION: Attention = { kind: "none" };

/** Display metadata. One table, so a dot, a chip and a mascot cannot disagree
 *  about what "waiting" looks like. */
export const LIFE_META: Record<
  LifeState,
  { label: string; tip: string }
> = {
  starting: { label: "starting", tip: "Starting up" },
  working: { label: "working", tip: "Working on a turn" },
  waiting: { label: "waiting", tip: "Blocked on you" },
  idle: { label: "idle", tip: "Finished — waiting for you to type" },
  ended: { label: "ended", tip: "Session closed" },
  unknown: { label: "unknown", tip: "No signal — we've lost track of this one" },
};

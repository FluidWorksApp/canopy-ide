// A second opinion on the agents, in browserWatchdog's mold: pure decision
// logic over samples, with the sampling and the shouting kept outside. Today a
// session that goes quiet changes a dot's colour and nothing else; these two
// invariants are the first ones that make silence loud.
//
// The same rule that gives browserWatchdog its value applies: this must not
// agree with the code it is watching. It never runs the agentLife ladder —
// it reads the ladder's published verdicts (state, reason, since) and judges
// only duration and audience, which the ladder deliberately does not.
//
// Fully pure: episode identity comes from the sample's own `stateSince` /
// `blockedSince`, so the same breach yields the same key on every tick and
// the consumer dedupes on it. No clocks, no memory, no subscriptions here.

export type AgentInvariantCode = "W1" | "W2";

export const AGENT_INVARIANTS: Record<AgentInvariantCode, string> = {
  W1: "an agent went quiet and stayed quiet past the stall threshold",
  W2: "an agent is blocked on a human and nobody has seen it",
};

export interface AgentWatchdogLimits {
  /** How long `unknown / went-quiet` may persist before it is a stall rather
   *  than a pause. Generous on purpose: a long tool call looks identical from
   *  outside, and a false stall alarm teaches people to ignore real ones. */
  stallQuietMs: number;
  /** How long a blocked question or permission prompt may sit unseen before
   *  it escalates. Short on purpose: the whole cost of a block is wall-clock
   *  waiting, and the observed failure mode is a y/n prompt found hours late. */
  blockedUnseenMs: number;
}

/** In-module rather than in shared/agentLife/policy.json, exactly as
 *  browserWatchdog keeps its LIMITS: these are the watcher's thresholds, not
 *  the ladder's, and the parity machinery shouldn't churn for them. Revisit
 *  when the wired watchdog lands (0109 Foundation B). */
export const AGENT_WATCHDOG_LIMITS: AgentWatchdogLimits = {
  stallQuietMs: 5 * 60_000,
  blockedUnseenMs: 2 * 60_000,
};

/** One reading of one session, taken from published state — nothing here is
 *  computed by the watchdog. */
export interface AgentSample {
  at: number;
  ptyId: number;
  sessionId: string | null;
  /** LifeState as the ladder published it. */
  state: string;
  /** UnknownReason when state is "unknown". Only "went-quiet" can stall:
   *  "cli-cannot-report" and "never-reported" are structural facts about the
   *  CLI, true forever, and an alarm that is always on is off. */
  reason?: string | null;
  /** When the current life state began (Life.since). */
  stateSince: number;
  /** When the session became blocked on a human, from the attention axis —
   *  null when it is not. */
  blockedSince: number | null;
  /** The user currently has this session's surface in front of them. A seen
   *  block is being handled at human speed; only the unseen one escalates. */
  seen: boolean;
}

export interface AgentIncident {
  code: AgentInvariantCode;
  /** Stable per episode: one breach reports once, not once per tick. */
  key: string;
  ptyId: number;
  sessionId: string | null;
  what: string;
  /** When the condition started, not when it crossed the threshold. */
  since: number;
  at: number;
}

/** Judge one tick's samples. Stateless: call it with every live session's
 *  sample each tick and dedupe downstream on `key`. */
export function judgeAgents(
  samples: AgentSample[],
  limits: AgentWatchdogLimits = AGENT_WATCHDOG_LIMITS,
): AgentIncident[] {
  const incidents: AgentIncident[] = [];
  for (const s of samples) {
    if (
      s.state === "unknown" &&
      s.reason === "went-quiet" &&
      s.at - s.stateSince >= limits.stallQuietMs
    ) {
      incidents.push({
        code: "W1",
        key: `W1:${s.ptyId}:${s.stateSince}`,
        ptyId: s.ptyId,
        sessionId: s.sessionId,
        what: AGENT_INVARIANTS.W1,
        since: s.stateSince,
        at: s.at,
      });
    }
    if (
      s.blockedSince !== null &&
      !s.seen &&
      s.at - s.blockedSince >= limits.blockedUnseenMs
    ) {
      incidents.push({
        code: "W2",
        key: `W2:${s.ptyId}:${s.blockedSince}`,
        ptyId: s.ptyId,
        sessionId: s.sessionId,
        what: AGENT_INVARIANTS.W2,
        since: s.blockedSince,
        at: s.at,
      });
    }
  }
  return incidents;
}

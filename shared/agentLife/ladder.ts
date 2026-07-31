// What an agent is doing, decided once, from ranked evidence.
//
// The rungs are ordered by how much they can be trusted, and the first one
// whose condition holds returns. No later rung may overturn an earlier one —
// that ordering is the whole mechanism, and it is the same shape
// `agentIdentity.ts` already uses to answer "which agent is this", for the same
// reason: a near-miss must produce no claim rather than a plausible one.
//
// Two things this replaces are worth naming, because both looked correct.
//
// `effectiveState` opened `if (state !== "working") return state`, so it could
// only ever rewrite an over-confident "working". A `waiting` written by a
// session that died on Tuesday passed straight through it, forever, and no
// amount of routing more callers through it would have changed that.
//
// The tab strip's own heuristic asked the opposite question and got it wrong
// the other way: three CPU samples under 10% (about six seconds) marked an
// agent as needing you. That window is exactly what a model thinking looks
// like — no hook event exists between the last tool call and the end of the
// turn, and the CPU is near zero over the same span, so the two signals
// `effectiveState` treats as independent fail together precisely when it
// matters. The output channel below is the third signal that doesn't.
import { fidelityFor, canDeclareBlock, type CliFidelity } from "./fidelity";
import { POLICY } from "./policy";
import type {
  Confidence,
  Life,
  LifeState,
  UnknownReason,
  Via,
} from "./vocabulary";

/** The agent-shaped process on the pty, as `agent_hint` reports it. Only the
 *  presence question matters here; naming the binary is agentIdentity's job. */
export interface HintLike {
  bin: string;
  interactive: boolean;
}

/** What the terminal says.
 *
 *  Three variants for three different facts, the same three-valued discipline
 *  `identifyAgent(hint)` already uses — where an absent hint is the definitive
 *  "nothing is running here", not merely an absence of news.
 *
 *  `gone` may be passed ONLY when the caller authoritatively owns the binding:
 *  the digest named a surface, its instance is this launch, and that surface is
 *  absent from the live pty set. A session running outside Canopy has no
 *  terminal of ours and must be `undefined`, never `gone`. Getting this wrong
 *  turns a fix into a new bug, which is why `bind.ts` is the only place allowed
 *  to construct it. */
export type PtyEvidence =
  | {
      kind: "live";
      /** Absent means the foreground process group leader is the shell we
       *  spawned: nothing is running on this terminal. */
      hint: HintLike | null;
      /** Percent of one core, summed over the whole subtree. */
      cpu: number;
      /** Milliseconds since this pty last wrote a byte. Absent on a build that
       *  predates the output channel, which is itself evidence: no channel, no
       *  corroboration. */
      quietForMs?: number;
      /** Milliseconds since the human last typed into it, so the CLI's echo of
       *  a keystroke is not read as the agent working. */
      sinceInputMs?: number;
      /** Unix seconds this terminal was first seen, for the startup grace. */
      firstSeen?: number;
    }
  | { kind: "gone" };

/** The digest as the ladder reads it. Deliberately looser than `SessionDigest`:
 *  the portal, the Rust side and sessions read from a CLI's own store all
 *  produce this shape with different fields missing. */
export interface DigestLike {
  state?: string;
  /** The rung the producer used. Absent on pre-upgrade digests and on rows
   *  read from a CLI's own store — itself evidence: no rung, no certainty. */
  state_via?: string;
  confidence?: string;
  updated?: number;
  agent?: string;
  /** True for a row reconstructed from the CLI's own store rather than from
   *  our hook stream. Such a row records no lifecycle at all. */
  store?: boolean;
  /** The digest belongs to a different launch of the app, so its `surface`
   *  cannot be resolved against our live terminals. */
  foreign?: boolean;
}

export interface LifeEvidence {
  digest?: DigestLike | null;
  pty?: PtyEvidence;
  /** Injected. Nothing in this module reads a clock. */
  now: number;
}

const say = (
  state: LifeState,
  confidence: Confidence,
  via: Via,
  since: number,
  note: string,
  agent: string | null,
  reason?: UnknownReason,
): Life => ({ state, confidence, via, since, note, agent, ...(reason ? { reason } : {}) });

/** Which rung a digest's recorded state came from.
 *
 *  New digests carry `state_via` and this is a read. Old ones don't, and the
 *  fallback maps the four legacy states onto the rungs they must have come
 *  from — with one deliberate demotion: a legacy `waiting` becomes
 *  `declared-block`, never `structured-block`, because the producer that wrote
 *  it decided from message text and we cannot tell after the fact which kind it
 *  was. An old digest is worth less than a new one, and this is where that
 *  shows up. */
function rungOf(d: DigestLike): Via | null {
  if (d.state_via) return d.state_via as Via;
  switch (d.state) {
    case "ended":
      return "session-end";
    case "waiting":
      return "declared-block";
    case "idle":
      return "turn-boundary";
    case "working":
      return "tool-activity";
    default:
      return null;
  }
}

/** Whether a CLI's own events could have produced this rung. The manifest is
 *  consulted before the digest is believed, never after — so a rung a CLI
 *  cannot reach never fires for it, however the digest got written. */
function reachable(f: CliFidelity, via: Via): boolean {
  switch (via) {
    case "session-end":
      return f.endsSession.length > 0;
    case "structured-block":
      return f.structuredBlock.length > 0;
    case "declared-block":
      return canDeclareBlock(f);
    case "turn-boundary":
      return f.endsTurn.length > 0;
    case "turn-start":
      return f.startsTurn.length > 0;
    case "tool-activity":
      return f.toolActivity.length > 0;
    default:
      return true;
  }
}

/** A hook claim is only as good as the CLI it came from: one whose hooks are
 *  written but inert until a manual step has not proven anything yet. */
const hookConfidence = (f: CliFidelity): Confidence =>
  f.needsTrust ? "reported" : "proven";

/** The terminal painted recently enough to count as work, and not merely as the
 *  echo of a keystroke. */
function painting(p: Extract<PtyEvidence, { kind: "live" }>): boolean {
  if (p.quietForMs === undefined) return false;
  if (p.quietForMs > POLICY.quietOutputMs) return false;
  // Output within a moment of the human typing is the CLI echoing them.
  if (p.sinceInputMs !== undefined && p.sinceInputMs <= POLICY.answerWindowMs) {
    return p.quietForMs < p.sinceInputMs;
  }
  return true;
}

/**
 * The lifecycle verdict. Pure: `now` is given, no clock is read, and the
 * evidence type cannot carry focus — a stale UI flag has no way in here, which
 * is the type-level form of the rule the tab strip used to break.
 */
export function agentLife(ev: LifeEvidence): Life {
  // An empty digest object is no digest. Callers hand us `{}` for a terminal
  // nothing has ever reported on, and the Rust mirror sees the same JSON — the
  // two must agree on what emptiness means or the parity fixtures diverge on
  // the difference between "not set up" and "recorded nothing".
  const d =
    ev.digest && Object.keys(ev.digest).length > 0 ? ev.digest : null;
  const agent = d?.agent ?? null;
  const f = fidelityFor(agent);
  const pty = ev.pty;
  const live = pty?.kind === "live" ? pty : null;
  const updated = d?.updated ?? 0;
  // No timestamp means no silence to measure. Treating that as "very old"
  // would decay every pre-upgrade digest the moment it was read, so an
  // un-ageable claim is believed rather than aged from nothing.
  const silentFor = updated ? ev.now - updated : 0;
  const label = agent || "this agent";

  // Rung 0 — the process is gone. Beats every digest claim, including a
  // `waiting` that outlived the session that wrote it. The kernel already knew:
  // when the pty's foreground process group leader is the shell we spawned,
  // `agent_hint` is null and nothing is running there. That evidence arrives
  // within one monitor tick; the alternative was never.
  if (pty?.kind === "gone") {
    return say("ended", "proven", "process-gone", ev.now, "The terminal this session ran in is gone", agent);
  }
  if (live && live.hint === null) {
    return say("ended", "proven", "process-gone", ev.now, `No ${label} process is running on this terminal`, agent);
  }

  const via = d ? rungOf(d) : null;
  const digestUsable = !!d && !d.store && !d.foreign && !!via && reachable(f, via);

  if (digestUsable && via) {
    switch (via) {
      // Rung 1 — the CLI said the session ended.
      case "session-end":
        return say("ended", "proven", via, updated, "The session reported that it closed", agent);

      // Rung 2 — a tool-name equality or a dedicated permission event. Zero
      // free text was involved in reaching this.
      case "structured-block":
        return say("waiting", "proven", via, updated, `${label} is blocked on you`, agent);

      // Rung 3 — the CLI raised its notification and its manifest says what
      // that means. `attention-only` is the honest half-answer: it wants the
      // keyboard and cannot say whether it finished or is asking.
      case "declared-block":
        return f.notification === "attention-only"
          ? say("waiting", "reported", via, updated, `${label} is at a prompt — it cannot say whether it finished or is asking you something`, agent)
          : say("waiting", "proven", via, updated, `${label} is blocked on you`, agent);

      // Rung 4 — the turn ended.
      case "turn-boundary":
        return say("idle", hookConfidence(f), via, updated, `${label} finished its turn`, agent);

      // Rungs 5 and 6 — a turn is in flight. A hook event is a claim about the
      // recent past, so past the trust window it falls through to evidence that
      // is about now.
      case "turn-start":
      case "tool-activity":
        // A digest with no timestamp cannot be aged, so it is believed. Not a
        // loophole: without `updated` there is no silence to measure, and
        // treating "we don't know how old this is" as "it is old" would decay
        // every pre-upgrade digest to unknown the moment it was read.
        if (silentFor < POLICY.hookTrustSecs) {
          return say("working", hookConfidence(f), via, updated, `${label} is working`, agent);
        }
        break;
      default:
        break;
    }
  }

  if (live) {
    // Rung 7 — the terminal is painting. The decisive channel, and the only
    // positive evidence available at all for a CLI whose hooks cannot say
    // "working": aider has no such event, opencode has no turn start, amp
    // cannot report being blocked. A spinner redrawing is bytes.
    if (painting(live)) {
      return say("working", "inferred", "output", ev.now, `${label} is printing to its terminal`, agent);
    }
    // Rung 8 — the process tree is burning CPU. Weakest positive rung: the
    // number is a whole-subtree sum and five of seven CLIs keep a long-lived
    // helper child, so it proves motion and nothing finer.
    if (live.cpu >= POLICY.quietCpuPercent) {
      return say("working", "inferred", "cpu", ev.now, `${label}'s processes are busy`, agent);
    }
    // Rung 9 — a process is here and nothing has spoken for it yet.
    if (
      !d &&
      live.hint &&
      live.firstSeen !== undefined &&
      ev.now - live.firstSeen < POLICY.startupGraceSecs
    ) {
      return say("starting", "inferred", "startup", ev.now, `${label} is starting up`, agent);
    }
  }

  // Rung 10 — nothing we are willing to stand behind. Which kind of
  // not-knowing matters: it is the difference between "set this CLI up" and
  // "we lost track of a session that was working a minute ago", and nothing
  // destructive may key on any of them.
  const reason: UnknownReason = d?.foreign
    ? "foreign-instance"
    : d?.store || (d && !via)
      ? "store-only"
      : d && via && !reachable(f, via)
        ? "cli-cannot-report"
        : d
          ? "went-quiet"
          : "never-reported";

  const notes: Record<UnknownReason, string> = {
    "foreign-instance": "This session belongs to a different launch of Canopy",
    "store-only": `Read from ${label}'s own history — it records no live state`,
    "cli-cannot-report": `${label} cannot report this — its hooks don't cover it`,
    "went-quiet": `No events, no output and no CPU — ${label} may have stopped without telling Canopy`,
    "never-reported": `Nothing has reported for ${label} — its hooks may not be installed`,
  };

  return say("unknown", "inferred", "none", ev.now, notes[reason], agent, reason);
}

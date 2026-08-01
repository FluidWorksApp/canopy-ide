// The impure edge of shared/agentLife on the desktop: the clock, the pty
// stats, and the attention memory that a pure reducer cannot hold.
//
// Everything in shared/agentLife takes `now` as an argument and returns a
// value. This is where the arguments come from.
//
// One thing here is not incidental. `views` must be referentially stable —
// the same object for a session nothing has changed about — because pty stats
// land every 2 seconds for every terminal in every open project, and a fresh
// object per tick re-renders every tab strip in the app. That is the exact
// regression the monitor's own `setStats` bail and the content-keyed
// `busyPtyIds` memo were written to avoid, and both of those are deleted by
// this module, so the stability has to live here instead.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "./ipc";
import {
  agentLife,
  NO_ATTENTION,
  reduceAttention,
  type Attention,
  type AttentionInput,
  type HookSignal,
  type Life,
  type PtyEvidence,
} from "../shared/agentLife";

export interface AgentLifeView {
  ptyId: number;
  sessionId: string | null;
  life: Life;
  attention: Attention;
}

/** What a hook event on the bus means for the attention axis. Read from the
 *  event's own `canopy_signal` when the installer classified it, and otherwise
 *  from the event name — the same mapping the producer uses, and the reason
 *  neither side parses prose any more. */
export function signalFor(d: {
  event?: string | null;
  tool?: string | null;
  signal?: string | null;
}): HookSignal | null {
  if (d.signal) return d.signal as HookSignal;
  switch (d.event) {
    case "UserPromptSubmit":
      return "turn-start";
    case "PostToolUse":
      return "turn-progress";
    case "Stop":
      return "turn-end";
    case "SessionEnd":
      return "session-end";
    case "PreToolUse":
      return d.tool === "AskUserQuestion" ? "needs-human" : "turn-progress";
    case "PermissionRequest":
      return "needs-human-permission";
    default:
      return null;
  }
}

/** Everything the ladder needs about one terminal, from one stats sample. */
export function ptyEvidenceFor(
  s: ipc.SessionStats | undefined,
  firstSeen?: number,
): PtyEvidence | undefined {
  if (!s) return undefined;
  return {
    kind: "live",
    hint: s.agent_hint,
    cpu: s.total_cpu,
    quietForMs: s.quiet_ms ?? undefined,
    sinceInputMs: s.since_input_ms ?? undefined,
    firstSeen,
  };
}

/** Same verdict, field for field. Used to hold a view's identity steady across
 *  a stats tick that changed nothing anyone can see. */
function sameLife(a: Life, b: Life): boolean {
  return (
    a.state === b.state &&
    a.confidence === b.confidence &&
    a.via === b.via &&
    a.reason === b.reason &&
    a.agent === b.agent
  );
}

function sameAttention(a: Attention, b: Attention): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "none" || b.kind === "none") return true;
  return a.since === b.since && a.why === (b as typeof a).why;
}

/** The attention memory for a set of terminals. Held in a ref rather than in
 *  state: a reducer fed by three event sources at three cadences would
 *  otherwise re-render on every input rather than on every change.
 *
 *  `version` counts the changes. It exists because the map is mutated in
 *  place — its identity never changes — so a memo that derives from it must
 *  depend on the version, not the map, or an attention-only change leaves the
 *  memo reading the world as it was. */
export function useAttentionMemory() {
  const memory = useRef(new Map<number, Attention>());
  const [version, bump] = useState(0);

  const push = useCallback(
    (ptyId: number, input: AttentionInput, cli: string | null) => {
      const prev = memory.current.get(ptyId) ?? NO_ATTENTION;
      const next = reduceAttention(prev, input, cli);
      if (sameAttention(prev, next)) return;
      memory.current.set(ptyId, next);
      bump((n) => n + 1);
    },
    [],
  );

  const forget = useCallback((ptyId: number) => {
    if (memory.current.delete(ptyId)) bump((n) => n + 1);
  }, []);

  const get = useCallback(
    (ptyId: number) => memory.current.get(ptyId) ?? NO_ATTENTION,
    [],
  );

  return { push, forget, get, memory, version };
}

/** Stable views for a set of terminals.
 *
 *  `deps` is whatever the caller wants to recompute on — the digest array, the
 *  stats array, the attention memory's bump. Views whose verdict is unchanged
 *  keep their previous object, so a consumer memoized on identity does not
 *  re-render. */
export function useStableViews(
  build: () => AgentLifeView[],
  deps: unknown[],
): AgentLifeView[] {
  const prev = useRef(new Map<number, AgentLifeView>());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const next = new Map<number, AgentLifeView>();
    const out: AgentLifeView[] = [];
    for (const v of build()) {
      const was = prev.current.get(v.ptyId);
      const keep =
        was &&
        was.sessionId === v.sessionId &&
        sameLife(was.life, v.life) &&
        sameAttention(was.attention, v.attention)
          ? was
          : v;
      next.set(v.ptyId, keep);
      out.push(keep);
    }
    prev.current = next;
    return out;
  }, deps);
}

/** First-seen timestamps per terminal, for the startup grace. A terminal we
 *  have only just noticed is starting, not silent. */
export function useFirstSeen(ptyIds: readonly number[]): Map<number, number> {
  const seen = useRef(new Map<number, number>());
  const key = [...ptyIds].sort((a, b) => a - b).join(",");
  useEffect(() => {
    const now = Date.now() / 1000;
    for (const id of ptyIds) if (!seen.current.has(id)) seen.current.set(id, now);
    for (const id of [...seen.current.keys()])
      if (!ptyIds.includes(id)) seen.current.delete(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return seen.current;
}

/** The one verdict for one terminal. Every desktop surface goes through here
 *  or through `agentLife` directly with the same evidence. */
export function lifeFor(opts: {
  digest?: { [k: string]: unknown } | null;
  stats?: ipc.SessionStats;
  firstSeen?: number;
  /** True only when we authoritatively own this session's terminal and it is
   *  gone — see `resolveSessions`. Never inferred from an absent stat. */
  ended?: boolean;
  now: number;
}): Life {
  return agentLife({
    digest: opts.digest as never,
    pty: opts.ended
      ? { kind: "gone" }
      : ptyEvidenceFor(opts.stats, opts.firstSeen),
    now: opts.now,
  });
}

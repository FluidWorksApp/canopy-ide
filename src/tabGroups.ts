// Status grouping for the agent tab strip.
//
// An agent tab's place in the strip follows the agent's state: the ones
// blocked on you sit leftmost, the ones burning CPU next, the quiet ones last.
// Three buckets, because that is the whole question you ask a row of agents —
// who needs me, who is working, who is done.
//
// Promotion is instant: a tab that wants attention is never held back by a
// timer. Only the fall *into* idle is delayed, by a settling window, because
// an agent between tool calls dips quiet for a second at a time and a strip
// that reshuffles on every dip is unusable — the tab you were reaching for
// moves out from under the pointer. Waiting for the quiet to hold means a tab
// moves once, when the agent has genuinely stopped.
import { useEffect, useMemo, useRef, useState } from "react";

/** The three buckets. Also their left-to-right order in the strip. */
export type TabStatus = "attention" | "active" | "idle";

export const STATUS_ORDER: readonly TabStatus[] = ["attention", "active", "idle"] as const;

/** Group headings. Deliberately about the agent, not the machine: "Needs you"
 *  is an instruction, "waiting" would be a state you have to interpret. */
export const STATUS_LABEL: Record<TabStatus, string> = {
  attention: "Needs you",
  active: "Working",
  idle: "Idle",
};

/** The session states a terminal tab's dot already reports. */
export type AgentState = "working" | "waiting" | "idle" | "ended";

/** Which bucket a tab belongs in right now, before any settling. `unread` is
 *  unseen activity (an OSC notice, the went-quiet heuristic) and counts as
 *  wanting attention just as much as a formally `waiting` session does. */
export function statusFor(state: AgentState, unread?: boolean): TabStatus {
  if (unread || state === "waiting") return "attention";
  if (state === "working") return "active";
  return "idle";
}

/** A tab's settled bucket, plus when its pending fall to idle started (absent
 *  unless it is mid-fall). */
export interface Settled {
  group: TabStatus;
  pendingSince?: number;
}

export interface SettleResult {
  groups: Map<string, Settled>;
  /** Timestamp the caller should re-run at to complete a pending fall, or null
   *  when nothing is pending. */
  wake: number | null;
}

/** Fold raw statuses into settled ones. Pure: `now` and `delayMs` are given,
 *  never read from the clock, so the whole state machine is testable.
 *
 *  A tab absent from `prev` adopts its raw status outright — a tab that opens
 *  idle (a resumed session, a reopened workspace) belongs in Idle immediately
 *  rather than sliding there a minute later. */
export function settleGroups(
  prev: Map<string, Settled>,
  targets: Map<string, TabStatus>,
  now: number,
  delayMs: number,
): SettleResult {
  const groups = new Map<string, Settled>();
  let wake: number | null = null;
  for (const [id, target] of targets) {
    const was = prev.get(id);
    if (target !== "idle" || !was || was.group === "idle" || delayMs <= 0) {
      groups.set(id, { group: target });
      continue;
    }
    const since = was.pendingSince ?? now;
    if (now - since >= delayMs) {
      groups.set(id, { group: "idle" });
      continue;
    }
    groups.set(id, { group: was.group, pendingSince: since });
    const due = since + delayMs;
    wake = wake == null ? due : Math.min(wake, due);
  }
  return { groups, wake };
}

/** The reference half of the strip stacks by kind rather than by state — a
 *  document has no state to settle, but "show me my files" and "put the pull
 *  requests away" are the same gesture as folding Idle. Order is the order the
 *  stacks appear in, after the agent ones.
 *
 *  Keys are stable strings because they key the fold state and the drag
 *  handles; the tab types are the discriminants of ProjectView's SubTab union,
 *  named here as plain strings so this module stays free of the view. */
export const DOC_STACKS: { key: string; label: string; types: readonly string[] }[] = [
  { key: "workspaces", label: "Workspaces", types: ["agent"] },
  { key: "files", label: "Files", types: ["file", "collab"] },
  { key: "browser", label: "Browser", types: ["preview"] },
  { key: "tasks", label: "Tasks", types: ["ticket"] },
  { key: "reviews", label: "Reviews", types: ["pr", "review"] },
  { key: "history", label: "History", types: ["branch", "commit"] },
  { key: "team", label: "Team", types: ["chat", "shared-project"] },
];

/** The generic documents stack — where an unrecognised tab type lands. */
const FALLBACK_STACK = "files";

/** Which reference stack a tab type belongs to. Anything unmapped falls back
 *  rather than vanishing: a tab type added later must not be able to strand a
 *  tab outside every stack, where nothing would render it. */
export function docStackFor(type: string): string {
  return DOC_STACKS.find((g) => g.types.includes(type))?.key ?? FALLBACK_STACK;
}

/** What a stack actually puts on screen: everything while it is open, nothing
 *  at all while it is folded.
 *
 *  Folded used to hold one tab out — the one whose pane was in front — on the
 *  grounds that a view with nothing in the strip naming it is how you lose
 *  track of what you are looking at. In practice it read as a bug: a chip
 *  saying "Idle 3", folded, with an unexplained tab sitting beside it that the
 *  count did not account for. Folded means folded. Which stack you are inside
 *  is said by the chip instead — see `holdsActive` at the call site — and the
 *  pane itself never moves either way, because nothing here touches which tab
 *  is active. */
export function shownInStack<T extends { id: string }>(tabs: T[], open: boolean): T[] {
  return open ? tabs : [];
}

/** Same ids in the same buckets, at the same point in their fall. */
export function sameGroups(a: Map<string, Settled>, b: Map<string, Settled>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, s] of a) {
    const o = b.get(id);
    if (!o || o.group !== s.group || o.pendingSince !== s.pendingSince) return false;
  }
  return true;
}

/** Cheap identity for a target map — the hook's effect keys off this rather
 *  than the map, which is rebuilt every render. */
export function targetsKey(targets: Map<string, TabStatus>): string {
  return [...targets].map(([id, s]) => `${id}:${s}`).join("|");
}

/** Settled buckets for a live strip, with the timer that completes a pending
 *  fall even when nothing else re-renders. `delayMs <= 0` settles instantly. */
export function useSettledGroups(
  targets: Map<string, TabStatus>,
  delayMs: number,
): Map<string, TabStatus> {
  const [settled, setSettled] = useState<Map<string, Settled>>(() => new Map());
  // The effect reads the newest map without depending on it: state it wrote
  // itself must not restart the timer, or a pending fall would never land.
  const ref = useRef(settled);
  ref.current = settled;
  const key = targetsKey(targets);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;

  useEffect(() => {
    let timer = 0;
    const run = () => {
      const now = Date.now();
      const { groups, wake } = settleGroups(ref.current, targetsRef.current, now, delayMs);
      if (!sameGroups(ref.current, groups)) {
        ref.current = groups;
        setSettled(groups);
      }
      // A floor on the delay: a due time already in the past would otherwise
      // spin a zero-length timer.
      if (wake != null) timer = window.setTimeout(run, Math.max(16, wake - now));
    };
    run();
    return () => window.clearTimeout(timer);
  }, [key, delayMs]);

  return useMemo(() => {
    const out = new Map<string, TabStatus>();
    for (const [id, s] of settled) out.set(id, s.group);
    return out;
  }, [settled]);
}

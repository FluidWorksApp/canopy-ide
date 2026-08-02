// Where a tab sits in the strip, and when it is allowed to move.
//
// This file used to answer two questions and now answers one. Which bucket a
// session belongs in is `bucketFor` in shared/agentLife — the whole point of
// that module is that there is one answer. What is left here is the animation:
// a tab that has just gone quiet must not jump out from under the pointer.
//
// Promotion is instant: a tab that wants attention is never held back by a
// timer. Only the fall *into* the quiet bucket is delayed, by a settling
// window, because an agent between tool calls dips quiet for a second at a time
// and a strip that reshuffles on every dip is unusable. Waiting for the quiet
// to hold means a tab moves once, when the agent has genuinely stopped.
//
// The removed function is worth naming, because it read as obviously correct:
//
//   statusFor(state, unread) {
//     if (unread || state === "waiting") return "attention";
//     ...
//
// `unread` was tested *before* `working`, and the only thing that ever cleared
// it was looking at the tab. So an agent mid-turn — flagged by a six-second CPU
// dip, or by any OSC bell — sat under "Needs you" with a green pulsing dot
// beside the words, and stayed there after it resumed. See
// shared/agentLife/compose.ts for the ordering that replaced it.
import { useEffect, useMemo, useRef, useState } from "react";
import { BUCKET_LABEL, BUCKET_ORDER, type Bucket } from "../shared/agentLife";

/** The three buckets, re-exported under the names this file's callers use. */
export type TabStatus = Bucket;

export const STATUS_ORDER: readonly TabStatus[] = BUCKET_ORDER;

export const STATUS_LABEL: Record<TabStatus, string> = BUCKET_LABEL;

/** A tab's settled bucket, plus when its pending fall to quiet started (absent
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

/** Reasons a tab is not allowed to move right now, whatever its agent is
 *  doing. Both are about the same thing: a strip that rearranges itself while
 *  you are reading it costs you the map of where everything was, and the move
 *  explains far less than the disorientation costs.
 *
 *  This is the one lever that is not a timer. The settling window below makes
 *  moves *rare*; these make them *wait for you* — which is what the adaptive-
 *  interface literature keeps landing on. Findlater & McGrenere (CHI 2004)
 *  found system-driven rearrangement loses to a layout the user controls, and
 *  the ephemeral-adaptation work that followed it got the same benefit with no
 *  movement at all, by changing how an item looks rather than where it is. The
 *  strip already does the looking part — the dot, the ring, the chip colour. */
export interface SettleHold {
  /** The pointer is in the strip. Nothing moves under a cursor that is about
   *  to click something; everything that came due lands when it leaves. */
  frozen?: boolean;
  /** The tab whose pane is in front. It never moves while you are in it —
   *  looking at an agent is exactly when its position must not change under
   *  you. It settles the moment you go somewhere else.
   *
   *  One exception: a proven fall (below). The hold is a position claim; the
   *  chip's label is a state claim; when the CLI itself has declared the turn
   *  over, keeping the tab under a chip that says Working is the chip lying,
   *  and the dot beside it — which is never held — already says idle. That
   *  contradiction, not the move, is what reads as broken. */
  hold?: string | null;
  /** Tabs whose quiet target is a proven verdict — the CLI declared the turn
   *  or session over, rather than us inferring quiet from a CPU dip. A proven
   *  fall uses `provenDelayMs` instead of the settling window and is exempt
   *  from `hold` (never from `frozen`: nothing moves under the pointer). */
  proven?: ReadonlySet<string>;
  /** Delay for a proven fall. Capped by the settling window, so turning the
   *  window down never makes proven falls slower than inferred ones. */
  provenDelayMs?: number;
}

/** Fold raw statuses into settled ones. Pure: `now` and `delayMs` are given,
 *  never read from the clock, so the whole state machine is testable.
 *
 *  A tab absent from `prev` adopts its raw status outright — a tab that opens
 *  quiet (a resumed session, a reopened workspace) belongs in Idle immediately
 *  rather than sliding there a minute later. That holds even under a hold: a
 *  tab with no place yet cannot keep the place it had. */
export function settleGroups(
  prev: Map<string, Settled>,
  targets: Map<string, TabStatus>,
  now: number,
  delayMs: number,
  { frozen = false, hold = null, proven, provenDelayMs = 0 }: SettleHold = {},
): SettleResult {
  const groups = new Map<string, Settled>();
  let wake: number | null = null;
  for (const [id, target] of targets) {
    const was = prev.get(id);
    const provenFall = target === "quiet" && (proven?.has(id) ?? false);
    // A rise is never held by the active tab. The hold is there so the strip
    // does not move the tab you are reading out from under you, and a fall to
    // Idle is exactly that — but "working" and "needs you" are the opposite:
    // the tab in front of you is the one whose dot you are actually looking at,
    // and holding its rise made the chip beside it say Idle while the dot said
    // otherwise. One session, two answers, on the same screen.
    //
    // `frozen` still holds everything. That one is a gesture in progress —
    // a pointer over the strip, ⌘ held numbering the tabs — where any movement
    // is a misclick the strip caused, whichever direction it is in.
    const rising = target !== "quiet";
    // Held: keep the place, and the fall it was part-way through. Nothing is
    // forgotten, so letting go applies what came due rather than restarting
    // every clock — several tabs move at once, which reads as one event.
    // A proven fall passes through the hold (see SettleHold) but never
    // through frozen.
    if (was && (frozen || (id === hold && !rising && !provenFall))) {
      groups.set(id, was);
      continue;
    }
    const delay = provenFall ? Math.min(provenDelayMs, delayMs) : delayMs;
    if (target !== "quiet" || !was || was.group === "quiet" || delay <= 0) {
      groups.set(id, { group: target });
      continue;
    }
    const since = was.pendingSince ?? now;
    if (now - since >= delay) {
      groups.set(id, { group: "quiet" });
      continue;
    }
    groups.set(id, { group: was.group, pendingSince: since });
    const due = since + delay;
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
 *  than the map, which is rebuilt every render. Provenness is part of the
 *  identity: a target that goes from an inferred quiet to a proven one has a
 *  shorter fall due, and the effect has to re-run to schedule it. */
export function targetsKey(
  targets: Map<string, TabStatus>,
  proven?: ReadonlySet<string>,
): string {
  return [...targets]
    .map(([id, s]) => `${id}:${s}${proven?.has(id) ? ":p" : ""}`)
    .join("|");
}

/** Settled buckets for a live strip, with the timer that completes a pending
 *  fall even when nothing else re-renders. `delayMs <= 0` settles instantly. */
export function useSettledGroups(
  targets: Map<string, TabStatus>,
  delayMs: number,
  { frozen = false, hold = null, proven, provenDelayMs = 0 }: SettleHold = {},
): Map<string, TabStatus> {
  const [settled, setSettled] = useState<Map<string, Settled>>(() => new Map());
  // The effect reads the newest map without depending on it: state it wrote
  // itself must not restart the timer, or a pending fall would never land.
  const ref = useRef(settled);
  ref.current = settled;
  const key = targetsKey(targets, proven);
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const provenRef = useRef(proven);
  provenRef.current = proven;

  // Both holds are effect dependencies, so letting go re-runs immediately: the
  // pointer leaving the strip is the moment the moves it was holding back land.
  useEffect(() => {
    let timer = 0;
    const run = () => {
      const now = Date.now();
      const { groups, wake } = settleGroups(ref.current, targetsRef.current, now, delayMs, {
        frozen,
        hold,
        proven: provenRef.current,
        provenDelayMs,
      });
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
  }, [key, delayMs, frozen, hold, provenDelayMs]);

  return useMemo(() => {
    const out = new Map<string, TabStatus>();
    for (const [id, s] of settled) out.set(id, s.group);
    return out;
  }, [settled]);
}

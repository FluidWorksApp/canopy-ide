// Where the two axes meet — the only place in the app they are allowed to.
import type { Attention, Life, LifeState } from "./vocabulary";

/** The three buckets of the agent tab strip, and their left-to-right order:
 *  who needs me, who is working, who is quiet. */
export type Bucket = "attention" | "active" | "quiet";

export const BUCKET_ORDER: readonly Bucket[] = [
  "attention",
  "active",
  "quiet",
] as const;

/** Deliberately about the agent, not the machine: "Needs you" is an
 *  instruction, "waiting" would be a state you have to interpret. */
export const BUCKET_LABEL: Record<Bucket, string> = {
  attention: "Needs you",
  active: "Working",
  quiet: "Idle",
};

/**
 * Which bucket a session belongs in.
 *
 * The order of these four lines is the fix for the bug this module was written
 * for, so it is worth stating what each one is doing.
 *
 *  1. A proven `waiting` wins outright — and it only exists at all for a CLI
 *     whose manifest says it can prove it.
 *  2. A live `working` beats every flag. An unread ring cannot reach this line.
 *     Do not reorder 2 and 3 to make a card appear sooner; that reinstates the
 *     bug where an agent mid-turn sat under "Needs you" with a green pulsing
 *     dot beside the words, contradicting itself inside 200 pixels.
 *  3. `blocked` is the event stream's faster answer — the bus arrives in
 *     milliseconds and the digest poll in seconds — so it promotes a session
 *     the digest has not caught up with. Checked after live `working`, never
 *     before.
 *  4. Everything else is quiet. `ended` folding in with `idle` is deliberate;
 *     the hollow dot still tells them apart.
 */
export function bucketFor(life: Life, attention: Attention): Bucket {
  if (life.state === "waiting") return "attention";
  if (life.state === "working") return "active";
  if (attention.kind === "blocked") return "attention";
  return "quiet";
}

/** The additive ring: unseen activity, not a state of its own. It selects no
 *  bucket and never has. */
export function ringFor(attention: Attention): boolean {
  return attention.kind === "unseen";
}

/** What the status dot shows. One value, straight from the lifecycle axis. */
export function dotFor(life: Life): LifeState {
  return life.state;
}

/**
 * The only predicate a destructive action may key on — hibernation, killing a
 * pty, forgetting a session, recommending a directory for deletion.
 *
 * `confidence` is the part that matters, and it is why routing the old
 * hibernation gate through the old decay function would have changed nothing:
 * that function only ever rewrote an over-confident "working", so it produced a
 * byte-identical victim set. The guard that was missing is corroboration in the
 * *false-idle* direction — an agent we merely believe is finished is not one we
 * may kill. `unknown` is never reclaimable at any confidence: it means we lost
 * track, not that the work is done.
 */
export function reclaimable(life: Life, attention: Attention): boolean {
  if (life.state !== "idle" && life.state !== "ended") return false;
  if (life.confidence !== "proven") return false;
  return attention.kind !== "blocked";
}

/** "Something is running here" — for the close-project dialog and for what Ash
 *  says out loud. `unknown` is excluded on purpose: we can promise neither way,
 *  and a dialog that counts a session it cannot see is worse than one that
 *  admits the gap. */
export function isRunning(life: Life): boolean {
  return (
    life.state === "working" ||
    life.state === "waiting" ||
    life.state === "starting"
  );
}

/** Sort order for any list of sessions: what needs you, then what is working,
 *  then the rest, newest first inside each band.
 *
 *  One comparator, because the two that existed inverted each other — the
 *  workspace rail's picked `working` over `waiting`, so a crashed agent hid a
 *  genuinely blocked one, while the portal's sorted the other way. */
export interface RankableSession {
  life: Life;
  attention: Attention;
  updated?: number;
}

const BAND: Record<Bucket, number> = { attention: 0, active: 1, quiet: 2 };

export function rankSessions(a: RankableSession, b: RankableSession): number {
  const ba = BAND[bucketFor(a.life, a.attention)];
  const bb = BAND[bucketFor(b.life, b.attention)];
  if (ba !== bb) return ba - bb;
  return (b.updated ?? 0) - (a.updated ?? 0);
}

/** How long a session has been silent, for the row's tooltip. */
export function silenceLabel(
  updated: number | undefined,
  now: number,
): string {
  if (!updated) return "some time";
  const mins = Math.floor((now - updated) / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

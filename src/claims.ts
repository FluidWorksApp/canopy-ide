// Reading an advisory file claim, in the terms the UI talks about one.
//
// A claim is a small record with a lot of state hidden in two nullable fields,
// and three surfaces now render it — the panel's list, the page's list and the
// detail tab. Deciding "is this still held" or "what do I call it" in each of
// them is how the three end up disagreeing, so it is decided here.
import type * as ipc from "./ipc";
import { basename } from "./paths";

export type ClaimState = "held" | "released" | "dropped" | "superseded";

/** Where a claim stands. `released_by` is the backend's fact ("agent",
 *  "canopy", "superseded"); this turns it into the four states the UI has
 *  words for, and anything unrecognised reads as a plain release rather than
 *  vanishing. */
export function claimState(claim: ipc.AgentClaim): ClaimState {
  if (claim.released_at_ms == null) return "held";
  switch (claim.released_by) {
    case "canopy":
      return "dropped";
    case "superseded":
      return "superseded";
    default:
      return "released";
  }
}

export const CLAIM_STATE_LABEL: Record<ClaimState, string> = {
  held: "held",
  released: "released",
  dropped: "dropped",
  superseded: "superseded",
};

/** Said in full, for the line under the header. */
export const CLAIM_STATE_BLURB: Record<ClaimState, string> = {
  held: "The agent still has these files. Anyone else claiming them is turned away.",
  released: "The agent let these go itself.",
  dropped: "Dropped from Canopy — what you do for an agent that died holding a claim.",
  superseded: "Replaced by a later claim from the same agent.",
};

/** The agent's name without the directory the owner string carries. */
export const claimOwnerName = (owner: string) => owner.split(" (")[0];

/** The directory inside the owner string — an agent identifies itself by where
 *  it is working (see claim_owner in canopy_hook.rs). Display only: for
 *  resolving a claim to a live terminal use {@link claimOwnerPty}, because an
 *  agent that cd'd into a subdirectory no longer matches this string. */
export function claimOwnerCwd(owner: string): string | null {
  const m = /\(([^)]*)\)\s*$/.exec(owner);
  return m?.[1] || null;
}

/** The live terminal behind a claim, or null when there isn't one.
 *
 *  `pty_id` is exact and survives an agent that cd'd; the cwd parsed out of
 *  the owner string is the legacy fallback for claims recorded before the
 *  field existed. A pty id from another app launch must never resolve — ids
 *  restart at 1 every run, so the same number names someone else's terminal —
 *  which is what the `instance` check refuses. */
export function claimOwnerPty(
  claim: ipc.AgentClaim,
  stats: readonly { id: number; cwd: string }[],
  thisInstance: string | null,
): number | null {
  const sameLaunch =
    !claim.instance || !thisInstance || claim.instance === thisInstance;
  if (
    claim.pty_id != null &&
    sameLaunch &&
    stats.some((s) => s.id === claim.pty_id)
  ) {
    return claim.pty_id;
  }
  const cwd = claimOwnerCwd(claim.owner);
  if (!cwd) return null;
  return stats.find((s) => s.cwd === cwd)?.id ?? null;
}

/** A claim at tab width. The files, not the owner: two agents' claims sit side
 *  by side in the strip and what tells them apart is what each is holding. */
export function claimLabel(claim: ipc.AgentClaim): string {
  const first = basename(claim.paths[0]) || "claim";
  return claim.paths.length > 1 ? `${first} +${claim.paths.length - 1}` : first;
}

/** Same file, or one inside the other's directory.
 *
 *  A deliberate second copy of `paths_overlap` in context.rs, and it must stay
 *  a copy of the *display* kind only: nothing here decides whether a claim is
 *  allowed, which is Rust's call and is made under the lock. This one only
 *  gathers the other claims worth showing beside one you are reading. */
export function pathsOverlap(a: string, b: string): boolean {
  const x = a.replace(/\/+$/, "");
  const y = b.replace(/\/+$/, "");
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}

/** Every other claim that has touched these files, newest first — the history
 *  of a contested path, which is the question a claim raises and could not
 *  previously answer. */
export function claimsOnSamePaths(
  all: ipc.AgentClaim[],
  claim: ipc.AgentClaim,
): ipc.AgentClaim[] {
  return all.filter(
    (c) =>
      c.id !== claim.id &&
      c.paths.some((p) => claim.paths.some((q) => pathsOverlap(p, q))),
  );
}

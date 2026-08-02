// First-run coach-marks for the workspace rails. Same lifecycle-marker contract
// as onboarding.ts (see there), but one flag per tip so each spotlight fires
// once, the first time that section actually appears. Versioned per tip so a
// single tip can be re-introduced later without re-showing the others.
export type CoachTip =
  /** The rail's three groups, walked in order on a first run: what the rail is
   *  FOR, before any of the surfaces it opens. These point at the groups
   *  themselves (data-rail-group), not at a button inside one — the group is
   *  the unit the tour is teaching. */
  | "rail-project"
  | "rail-review"
  | "rail-agents"
  /** In-context, fired the first time the thing they point at exists. */
  | "agent";

const key = (tip: CoachTip) => `canopy.coachmark.${tip}.v1`;

export function shouldShowTip(tip: CoachTip): boolean {
  try {
    return localStorage.getItem(key(tip)) !== "1";
  } catch {
    // Storage blocked — never trap the user in a tip they can't dismiss for good.
    return false;
  }
}

export function markTipSeen(tip: CoachTip): void {
  try {
    localStorage.setItem(key(tip), "1");
  } catch {
    // A convenience marker; failing to persist it just re-shows the tip.
  }
}

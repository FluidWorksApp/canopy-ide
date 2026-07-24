// First-run coach-marks for the workspace rails. Same lifecycle-marker contract
// as onboarding.ts (see there), but one flag per tip so each spotlight fires
// once, the first time that section actually appears. Versioned per tip so a
// single tip can be re-introduced later without re-showing the others.
export type CoachTip = "shells" | "runs" | "agent";

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

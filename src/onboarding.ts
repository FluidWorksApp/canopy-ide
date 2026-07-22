// First-run onboarding flag. Kept out of settings.ts on purpose: this is a
// one-time lifecycle marker, not a user-tunable preference. Versioned so a
// future revamp of the walkthrough can re-introduce it to existing users by
// bumping the key, without disturbing anyone who has seen the current one.
const KEY = "canopy.onboarding.seen.v1";

export function shouldOnboard(): boolean {
  try {
    return localStorage.getItem(KEY) !== "1";
  } catch {
    // Storage blocked — never trap the user in a walkthrough they can't dismiss.
    return false;
  }
}

export function markOnboarded(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // A convenience marker; failing to persist it just re-shows the intro.
  }
}

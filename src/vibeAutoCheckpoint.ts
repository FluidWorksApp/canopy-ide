// Whether the automatic checkpoint has ever been observed to work here.
//
// Auto-checkpoint was dead code twice over: `secretScanClean` was hardcoded
// false, and `verified` was structurally unreachable because no check command
// was ever synthesised. Both are now fixed, and the arithmetic of that is
// blunt — a real `git commit` in a user's repository, made by Canopy with no
// one watching, along a path that has NEVER ONCE EXECUTED in production. Its
// unit tests are green because a stub hands them a clean secret scan.
//
// "Never executed" and "unverified" are the same state. A passing suite is
// evidence about the code the suite ran, not about `git commit` in this repo,
// on this disk, with this user's hooks, index state and identity config. The
// only thing that settles it is a checkpoint that actually happened and was
// seen to happen.
//
// So the gate: the FIRST checkpoint on a machine goes through the explicit
// "Save this version" button, exactly as an unverifiable turn already does. The
// decision, the paths, the baseline and the refusal reasons are still computed
// and still recorded — the evidence trail is not weakened, and no condition in
// `checkpointDecision` is bypassed. Only the unattended `commit()` waits.
//
// The flag flips when a checkpoint commit returns successfully. That is the
// live observation, and it is the ONLY thing that may flip it. Do not set this
// from a test fixture, a migration, a default, or a "we shipped it so it must
// work" — a flag armed by anything other than a commit that happened is the
// same claim of untested success this module exists to refuse.

/** Versioned so a change to how checkpoints commit can re-arm the gate rather
 *  than inherit confidence earned by a different implementation. */
const KEY = "canopy.vibe.autoCheckpointObserved.v1";

export function autoCheckpointObserved(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    // Storage unavailable. Unknown fails closed, the same way the secret scan
    // does: an unreadable flag is not permission to commit unattended.
    return false;
  }
}

/** Called only after a checkpoint commit has actually returned. */
export function recordAutoCheckpointObserved(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    // Persisting failed, so the next launch asks again. That is the correct
    // direction to fail in.
  }
}

/** For tests, and for anyone who wants the first automatic commit to be
 *  proposed rather than made again. */
export function forgetAutoCheckpointObserved(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do: the flag is already unreachable, which reads as unarmed.
  }
}

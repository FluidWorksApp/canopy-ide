// Account profiles for the agent CLIs: which login a launch runs under.
//
// The model lives in Rust (src-tauri/src/profiles.rs) — it owns the directory
// layout and, crucially, the mapping from CLI to the environment variable that
// actually moves that CLI's credentials. This module is the frontend's half:
// which profile is currently selected per CLI, and how a launcher asks for the
// environment to stamp on the terminal it is about to open.
//
// The selection is deliberately thin. "default" is not stored, it is the
// absence of a stored value, so a user who never opens this feature has an
// empty map and launches that are byte-identical to the ones before it existed.

import type { AgentProfile } from "./ipc";
import * as ipc from "./ipc";
import { getSettings, updateSettings } from "./settings";

/** The implicit profile: the login the machine already had. */
export const DEFAULT_PROFILE = "default";

/** Fired when the active account changes, or when the set of accounts does, so
 *  every launcher and the status chip re-read without the selection having to
 *  be threaded through the component tree. */
export const PROFILE_CHANGE_EVENT = "canopy:cli-profile-changed";

/** The account every agent CLI launches under right now. */
export function activeProfile(): string {
  return getSettings().activeProfile || DEFAULT_PROFILE;
}

/** Switch accounts. Global on purpose — see Settings.activeProfile.
 *
 *  Running sessions are untouched: the config-dir variable is read by the CLI
 *  at startup, so a session keeps the account it was launched with for its
 *  whole life. That is the honest behaviour, and the tab badge is what makes
 *  it legible when two accounts are open at once. */
export function setActiveProfile(profileId: string): void {
  updateSettings({ activeProfile: profileId || DEFAULT_PROFILE });
  window.dispatchEvent(
    new CustomEvent(PROFILE_CHANGE_EVENT, { detail: { profileId } }),
  );
}

/** A profile's display name, falling back to its id so a selection pointing at
 *  a profile that was removed still renders as something the user can act on
 *  rather than as blank space. */
export function profileLabel(profiles: AgentProfile[], id: string): string {
  return profiles.find((p) => p.id === id)?.label ?? id;
}

/** The environment that points `cliId` at its selected profile, ready to stamp
 *  onto a PTY. Empty for the default profile and for CLIs with no config-home
 *  variable, so callers can pass the result unconditionally.
 *
 *  Resolved in Rust rather than rebuilt here: which variable isolates which CLI
 *  is one fact, and a second copy of it in the frontend is how the two drift. */
export async function launchEnv(cliId: string): Promise<[string, string][]> {
  const profile = activeProfile();
  if (profile === DEFAULT_PROFILE || !supportsProfiles(cliId)) return [];
  try {
    return await ipc.profileEnv(cliId, profile);
  } catch {
    // A launch must not be blocked by a profile lookup. Falling back to no
    // environment means the CLI starts under the default login — visible in the
    // tab badge, and recoverable — rather than not starting at all.
    return [];
  }
}

/** Whether a CLI can hold more than one login. Mirrors PROFILE_AGENTS in
 *  profiles.rs; the pickers hide themselves for everything else rather than
 *  offering a choice that would isolate nothing.
 *
 *  Kept as a list rather than a probe because it is a property of the CLI's
 *  design, not of this machine — and a wrong "yes" here is the one failure the
 *  user cannot see: two profiles quietly sharing one account. */
export const PROFILE_CAPABLE = ["claude", "codex", "opencode", "amp"] as const;

export function supportsProfiles(cliId: string): boolean {
  return (PROFILE_CAPABLE as readonly string[]).includes(cliId);
}

/** The command that logs a profile in: just the CLI itself. Every one of these
 *  opens its own browser flow on first run inside an unauthenticated config
 *  dir, so there is nothing to automate and nothing for Canopy to hold. */
export function loginCommand(bin: string): string {
  return bin;
}

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

/** The implicit profile: the login the CLI already had. Never stored. */
export const DEFAULT_PROFILE = "default";

/** Fired when a CLI's selected profile changes, so open launchers re-render
 *  their badge without threading the selection through every component. */
export const PROFILE_CHANGE_EVENT = "canopy:cli-profile-changed";

/** Which profile `cliId` launches under right now. */
export function activeProfile(cliId: string): string {
  return getSettings().cliProfiles[cliId] || DEFAULT_PROFILE;
}

/** Point a CLI at a profile. Selecting the default *removes* the entry rather
 *  than storing "default": the stored map is a list of exceptions, and an
 *  explicit "default" would be a second way to say the same thing. */
export function setActiveProfile(cliId: string, profileId: string): void {
  const next = { ...getSettings().cliProfiles };
  if (!profileId || profileId === DEFAULT_PROFILE) delete next[cliId];
  else next[cliId] = profileId;
  updateSettings({ cliProfiles: next });
  window.dispatchEvent(
    new CustomEvent(PROFILE_CHANGE_EVENT, { detail: { cliId, profileId } }),
  );
}

/** A profile's display name, falling back to its id so a selection pointing at
 *  a profile that was removed still renders as something the user can act on
 *  rather than as blank space. */
export function profileLabel(profiles: AgentProfile[], id: string): string {
  return profiles.find((p) => p.id === id)?.label ?? id;
}

/** The short badge a tab or menu row shows. Null for the default profile:
 *  every session would carry it, so it would be noise rather than a signal. */
export function profileBadge(
  profiles: AgentProfile[],
  id: string,
): string | null {
  if (!id || id === DEFAULT_PROFILE) return null;
  return profileLabel(profiles, id);
}

/** The environment that points `cliId` at its selected profile, ready to stamp
 *  onto a PTY. Empty for the default profile and for CLIs with no config-home
 *  variable, so callers can pass the result unconditionally.
 *
 *  Resolved in Rust rather than rebuilt here: which variable isolates which CLI
 *  is one fact, and a second copy of it in the frontend is how the two drift. */
export async function launchEnv(cliId: string): Promise<[string, string][]> {
  const profile = activeProfile(cliId);
  if (profile === DEFAULT_PROFILE) return [];
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

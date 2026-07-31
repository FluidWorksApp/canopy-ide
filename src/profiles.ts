// Account profiles: which login a launch runs under.
//
// Rust owns the model — the directory layout and the CLI-to-env mapping (see
// src-tauri/src/profiles.rs). This is the frontend's half: which account is
// selected, and how a launcher gets the env to stamp on a new terminal.

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

/** Switch accounts. Global on purpose — see Settings.activeProfile. Running
 *  sessions keep the account they started with: the CLI reads the config-dir
 *  variable once, at startup. */
export function setActiveProfile(profileId: string): void {
  const id = profileId || DEFAULT_PROFILE;
  updateSettings({ activeProfile: id });
  // Mirrored to Rust for the launchers with no webview (the portal).
  // Fire-and-forget: recording it must not block the switch.
  void ipc.profileActivate(id).catch(() => {});
  window.dispatchEvent(
    new CustomEvent(PROFILE_CHANGE_EVENT, { detail: { profileId: id } }),
  );
}

/** A profile's display name, falling back to its id so a selection pointing at
 *  a profile that was removed still renders as something the user can act on
 *  rather than as blank space. */
export function profileLabel(profiles: AgentProfile[], id: string): string {
  return profiles.find((p) => p.id === id)?.label ?? id;
}

/** The env pointing `cliId` at the active account. Empty on the default
 *  account and for CLIs that can't hold one, so callers pass it through
 *  unconditionally. Resolved in Rust — one place knows the mapping. */
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

// ---------- the synchronous path ----------
//
// Agents launch from ~20 places. Each one remembering to await Rust is how half
// end up on the wrong login — the miss is invisible, because the CLI starts
// fine under the default account. So the env is resolved once per switch and
// looked up synchronously, and a call site that knows nothing about accounts
// gets it for free.

let envCache: { profile: string; byCli: Record<string, [string, string][]> } = {
  profile: DEFAULT_PROFILE,
  byCli: {},
};

/** Load the active account's env for every CLI that can hold one. */
export async function primeLaunchEnv(): Promise<void> {
  const profile = activeProfile();
  if (profile === DEFAULT_PROFILE) {
    envCache = { profile, byCli: {} };
    return;
  }
  const byCli: Record<string, [string, string][]> = {};
  await Promise.all(
    PROFILE_CAPABLE.map(async (id) => {
      try {
        byCli[id] = await ipc.profileEnv(id, profile);
      } catch {
        // Absent: launches on the default login, which the badge won't claim.
      }
    }),
  );
  envCache = { profile, byCli };
}

/** The account env for a CLI, without awaiting. Empty if unprimed: a launch is
 *  never worth blocking, and the default account is visible and recoverable. */
export function launchEnvSync(cliId: string): [string, string][] {
  if (envCache.profile !== activeProfile()) return [];
  return envCache.byCli[cliId] ?? [];
}

/** The account a launch would run under, for the tab badge. Null when no env
 *  is carried, so a tab only claims an account genuinely isolating it. */
export function launchProfile(cliId: string): string | null {
  return launchEnvSync(cliId).length ? activeProfile() : null;
}

/** Mirrors PROFILE_AGENTS in profiles.rs (pinned by a test). A property of the
 *  CLI's design, not of this machine. */
export const PROFILE_CAPABLE = ["claude", "codex", "opencode", "amp"] as const;

export function supportsProfiles(cliId: string): boolean {
  return (PROFILE_CAPABLE as readonly string[]).includes(cliId);
}

/** Logging in is just running the CLI: each opens its own browser flow in an
 *  unauthenticated config dir. Nothing to automate, nothing to hold. */
export function loginCommand(bin: string): string {
  return bin;
}

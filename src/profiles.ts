// Account profiles: which login a launch runs under.
//
// Rust owns the model — the directory layout and the CLI-to-env mapping (see
// src-tauri/src/profiles.rs). This is the frontend's half: which account is
// selected, and how a launcher gets the env to stamp on a new terminal.

import type { AgentProfile } from "./ipc";
import * as ipc from "./ipc";
import { agentCliFor, agentClisWith } from "./projects";
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
  // An explicit switch wins over each agent's remembered account: otherwise the
  // chip would say one account while a launch quietly used another.
  updateSettings({ activeProfile: id, lastProfileByCli: {} });
  // Mirrored to Rust for the launchers with no webview (the portal).
  // Fire-and-forget: recording it must not block the switch.
  void ipc.profileActivate(id).catch(() => {});
  window.dispatchEvent(
    new CustomEvent(PROFILE_CHANGE_EVENT, { detail: { profileId: id } }),
  );
}

let integrationEnsured = false;
/** Once per run. An account that predates a hook, or was signed in by hand,
 *  would otherwise never report a limit, and rotation would silently not fire. */
export function ensureAccountIntegration(): Promise<void> {
  if (integrationEnsured) return Promise.resolve();
  integrationEnsured = true;
  return ipc.profilesEnsureIntegration().catch(() => {});
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

/** The account `cliId` should launch under when nobody chose: the one it was
 *  last launched with, if that account still exists, else the active account. */
export function lastProfileFor(cliId: string, available?: string[]): string {
  const saved = getSettings().lastProfileByCli?.[cliId];
  if (saved && (!available || saved === DEFAULT_PROFILE || available.includes(saved))) return saved;
  return activeProfile();
}

/** Remember which account `cliId` was launched under. */
export function rememberProfile(cliId: string, profileId: string): void {
  const current = getSettings().lastProfileByCli ?? {};
  if (current[cliId] === profileId) return;
  updateSettings({ lastProfileByCli: { ...current, [cliId]: profileId } });
}

/** The accounts a launch of `cliId` can choose between: more than one profile
 *  and a CLI that can hold one, else none (nothing to ask). */
export function launchableProfiles(profiles: AgentProfile[], cliId: string): AgentProfile[] {
  return supportsProfiles(cliId) && profiles.length > 1 ? profiles : [];
}

/** The env pointing `cliId` at a specific account. Empty on the default account
 *  and for CLIs that can't hold one, like `launchEnv` but for a chosen profile. */
export async function launchEnvFor(cliId: string, profile: string): Promise<[string, string][]> {
  if (profile === DEFAULT_PROFILE || !supportsProfiles(cliId)) return [];
  try {
    return await ipc.profileEnv(cliId, profile);
  } catch {
    return [];
  }
}

/** The account env for the brain. The brain is the CLI on this computer in
 *  every mode, so the active account applies only when this computer has a
 *  profile by that id; in a cloud workspace the active account usually lives
 *  on the VM, and pointing the desktop CLI at a VM path would sign it out. */
export async function brainLaunchEnv(cliId: string): Promise<[string, string][]> {
  const profile = activeProfile();
  if (profile === DEFAULT_PROFILE || !supportsProfiles(cliId)) return [];
  try {
    const here = await ipc.profilesListDesktop();
    if (!here.some((p) => p.id === profile)) return [];
    return await ipc.profileEnvDesktop(cliId, profile);
  } catch {
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

/** Derived from first-class CLI manifests. Native profile commands resolve
 * the same capability defensively in their own runtime. */
export const PROFILE_CAPABLE = agentClisWith("profiles").map((cli) => cli.id);

export function supportsProfiles(cliId: string): boolean {
  return agentCliFor(cliId)?.capabilities?.profiles === true;
}

/** Logging in is just running the CLI: each opens its own browser flow in an
 *  unauthenticated config dir. Nothing to automate, nothing to hold. */
export function loginCommand(bin: string): string {
  return bin;
}

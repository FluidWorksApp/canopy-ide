// Which account a terminal runs under, decided once, from what the process is
// actually given. Every reader — the tab badge, the plan chip, the snapshot a
// restore relaunches from — takes this value, so none of them can name an
// account the CLI is not using.

import { DEFAULT_PROFILE, supportsProfiles } from "./profiles";

/** The account a launch env names. `CANOPY_PROFILE` rides with every named
 *  profile's env (src-tauri/src/profiles.rs `env_for`) and only with it. */
export function profileFromEnv(env: readonly (readonly [string, string])[] | undefined): string | null {
  // Last wins, as it does when the PTY applies the list.
  const named = [...(env ?? [])].reverse().find(([key]) => key === "CANOPY_PROFILE")?.[1];
  return named && named !== DEFAULT_PROFILE ? named : null;
}

/** The named account a launch is for but cannot be given synchronously: a
 *  profile-capable CLI, no env or account from the caller, a named active
 *  account, and nothing primed yet. Null when the launch is fully resolved. */
export function unresolvedLaunchAccount(input: {
  cli: string | null | undefined;
  extraEnv: [string, string][] | undefined;
  profile: string | undefined;
  syncEnv: [string, string][];
  active: string;
}): string | null {
  const { cli, extraEnv, profile, syncEnv, active } = input;
  if (!cli || !supportsProfiles(cli)) return null;
  if (extraEnv !== undefined || profile !== undefined) return null;
  if (active === DEFAULT_PROFILE || syncEnv.length > 0) return null;
  return active;
}

/** The tab's account. Undefined means the default login. A requested account
 *  the env does not carry is not claimed: for a CLI that can hold accounts the
 *  env is the truth; for anything else (a plain shell) the caller's label
 *  stands, since there is no env to contradict it. */
export function tabAccount(input: {
  env: [string, string][];
  pending: string | null;
  cli: string | null | undefined;
  requested: string | undefined;
}): string | undefined {
  const named = profileFromEnv(input.env) ?? input.pending;
  if (named) return named;
  if (input.cli && supportsProfiles(input.cli)) return undefined;
  return input.requested && input.requested !== DEFAULT_PROFILE ? input.requested : undefined;
}

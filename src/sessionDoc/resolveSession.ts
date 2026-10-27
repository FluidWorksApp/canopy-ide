// Which conversation a terminal's agent is having, for a CLI that never told
// Canopy (no hooks, or hooks that carry no session id).
//
// Every supported CLI writes its own session store, and session_digests
// already reads them all (stores.rs), each with the folder it ran in and when
// it last wrote. The terminal gives the rest: its CLI, its folder, and when it
// started (ptyBirth.ts). The session is the one of that CLI in that folder
// written since the terminal started — newest first, and never one another
// live terminal is known to be running.

import * as ipc from "../ipc";
import { ptyBirth, type PtyBirth } from "../ptyBirth";

const norm = (p: string | undefined) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");

/** Seconds of clock slack between the terminal starting and the CLI's first
 *  write landing in its store (file mtimes are whole seconds on some disks). */
const SLACK_SECS = 5;

export interface ResolveInput {
  agent: string;
  cwd: string;
  ptyId?: number | null;
  birth?: PtyBirth | null;
  /** Session ids other live terminals are known to be running. */
  taken?: ReadonlySet<string>;
}

/** The session `input`'s terminal is running, from `digests`; null when none
 *  can be told apart with confidence. Pure — tested directly. */
export function pickSession(digests: ipc.SessionDigest[], input: ResolveInput): ipc.SessionDigest | null {
  const cwd = norm(input.cwd);
  const mine = digests.filter((d) => d.agent === input.agent && !!d.session_id && !input.taken?.has(d.session_id));
  // A hook that recorded the terminal but not a usable id elsewhere: exact.
  if (input.ptyId != null) {
    const bound = mine
      .filter((d) => d.surface === String(input.ptyId))
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
    if (bound.length && (!input.birth || (bound[0].updated ?? 0) >= input.birth.at / 1000 - SLACK_SECS)) {
      return bound[0];
    }
  }
  const here = mine
    .filter((d) => [d.cwd, d.resume_cwd, d.launch_cwd].some((c) => c && norm(c) === cwd))
    .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  if (!here.length) return null;
  if (!input.birth) return here[0];
  const since = input.birth.at / 1000 - SLACK_SECS;
  const fresh = here.filter((d) => (d.updated ?? 0) >= since);
  if (fresh.length) return fresh[0];
  // Started while we watched and nothing written since: the CLI has not
  // saved this conversation yet, and the newest older one is not it.
  return input.birth.precise ? null : here[0];
}

/** Resolve through the live stores. Never throws. */
export async function resolveSessionId(
  input: Omit<ResolveInput, "birth">,
  deps: { digests(roots: string[]): Promise<ipc.SessionDigest[]> } = { digests: (r) => ipc.sessionDigests(r) },
): Promise<ipc.SessionDigest | null> {
  try {
    return pickSession(await deps.digests([input.cwd]), { ...input, birth: ptyBirth(input.ptyId) });
  } catch {
    return null;
  }
}

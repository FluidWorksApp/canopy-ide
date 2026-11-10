// Session digests of agents started on another machine from this window, read
// from that machine and keyed the way this window keys its own terminals: by the
// terminal's alias id, so the card, lineage and tasks find the right tab.
//
// Only digests of terminals this window started there are kept. Anyone else's
// sessions on that workspace are not this window's business.
import type { SessionDigest } from "../ipc";
import { aliasOf } from "./ptyRoute";
import type { MachineInvoke } from "./remoteWorkspace";

export interface DigestMachine {
  env: string;
  invoke: MachineInvoke;
}

/** One machine's digests, re-keyed. `instance` is stamped with this window's own
 *  tag: the machine's tag says which launch of ITS app wrote the digest, and the
 *  pairing check (digestBySurface) is about this window's terminals. */
/** Seconds of clock difference between this Mac and the machine that a digest's
 *  time is allowed to show before it is called older than the tab. */
export const DIGEST_CLOCK_SLACK_SECS = 60;

export function rekeyDigests(
  env: string,
  digests: readonly SessionDigest[],
  instance: string | null,
  /** When each alias's tab was started (ms). A digest last updated before then
   *  belongs to an earlier terminal that had the same id on that machine. */
  launchedAt: ReadonlyMap<number, number> = new Map(),
): SessionDigest[] {
  const out: SessionDigest[] = [];
  for (const digest of digests) {
    const real = digest.surface && /^\d+$/.test(digest.surface) ? Number(digest.surface) : undefined;
    if (real === undefined) continue;
    const alias = aliasOf(env, real);
    if (alias === undefined) continue;
    const since = launchedAt.get(alias);
    if (since !== undefined && typeof digest.updated === "number" && digest.updated < since / 1000 - DIGEST_CLOCK_SLACK_SECS) continue;
    out.push({ ...digest, surface: String(alias), ...(instance ? { instance } : {}) });
  }
  return out;
}

/** Every connected machine's digests; a machine that does not answer adds none. */
export async function fetchMachineDigests(
  machines: readonly DigestMachine[],
  instance: string | null,
  launchedAt?: ReadonlyMap<number, number>,
): Promise<SessionDigest[]> {
  const lists = await Promise.all(
    machines.map((m) =>
      m
        .invoke<SessionDigest[]>("session_digests", { roots: [] })
        .then((d) => rekeyDigests(m.env, d, instance, launchedAt))
        .catch(() => [] as SessionDigest[]),
    ),
  );
  return lists.flat();
}

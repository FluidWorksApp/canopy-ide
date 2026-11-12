// A session that raises its own pull request is on record as having done so.
//
// The agent's Bash hook event carries the PR the call created. Nothing else
// joined that PR to the session: the card looks sessions up by the ledger, and
// the ledger only heard from `canopy_job_done` and the watcher, so a PR raised
// from a branch other than the session's own never showed on its card.
//
// The event has no branch, so the head branch is read from GitHub by matching
// the URL in the repo's PR list. The match also proves the PR is in this repo:
// a `--repo other/x` call matches nothing and records nothing, which is better
// than filing a foreign PR number under this one.
import * as ipc from "./ipc";
import { prIdentity, record } from "./provenance";
import type { AgentEventData } from "../shared/notifications";

const seen = new Set<string>();
const RETRY_MS = 4000;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ObserverDeps {
  list: (repo: string) => Promise<ipc.PrInfo[]>;
  /** The session's own record: its agent and the profile that owns the
   *  conversation. The first edge for a PR wins, and resuming relaunches
   *  against that profile, so guessing one here would be permanent. */
  digest: (sessionId: string, cwd: string) => Promise<ipc.SessionDigest | undefined>;
  record: typeof record;
  /** Test seam for the retry delay. */
  wait?: (ms: number) => Promise<void>;
}

const defaults: ObserverDeps = {
  list: (repo) => ipc.ghPrList(repo),
  digest: async (sessionId, cwd) =>
    (await ipc.sessionDigests([cwd])).find((d) => d.session_id === sessionId),
  record,
};

export async function observePrCreated(
  events: (AgentEventData | null)[],
  deps: ObserverDeps = defaults,
): Promise<void> {
  for (const e of events) {
    if (!e?.prCreated || !e.sessionId || !e.cwd) continue;
    const url = e.prCreated.url.trim();
    const key = `${e.sessionId} ${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const id = prIdentity(url);
      const find = async () =>
        (await deps.list(e.cwd)).find(
          (p) => p.url === url || (id !== null && prIdentity(p.url) === id),
        );
      // GitHub can lag a second or two behind the create: one retry.
      const pr = (await find()) ?? (await (deps.wait ?? wait)(RETRY_MS), await find());
      if (!pr) continue;
      const digest = await deps.digest(e.sessionId, e.cwd);
      // No digest, no edge: better none than one with a wrong profile.
      if (!digest) {
        seen.delete(key);
        continue;
      }
      await deps.record({
        repo: e.cwd,
        url,
        branch: pr.branch,
        sessionId: e.sessionId,
        agent: digest.agent ?? (e.agent || null),
        profile: digest.profile ?? null,
        cwd: e.cwd,
        // Seen happening, as the watcher does: the existing "observed" tier.
        via: "pr_watch",
      });
    } catch {
      // Bookkeeping only; the key is released so a repeat can try again.
      seen.delete(key);
    }
  }
}

/** Test seam. */
export function __reset(): void {
  seen.clear();
}

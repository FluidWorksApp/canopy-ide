// What state a linked pull request is actually in.
//
// A research entry and a note both record the pull requests that came of them,
// and both record a *state* beside each one. That state is written once, at the
// moment the link is made — which for a PR an agent has just raised is always
// "open" — and the only thing that ever re-read it was a reconciler gated on
// the entry sitting in its one mid-flight status. So a research entry that had
// moved on, and every note ever written (the scratchpad's reconciler was built
// and never called), rendered "open" beside a pull request that merged weeks
// ago. The stored value was not wrong; it was being asked a question it cannot
// answer. It records what we knew when the link was made.
//
// This module answers the question the chip is actually asking — what is it
// *now* — and both detail views read it, so a linked PR's state cannot go stale
// in front of the user regardless of what status the thing holding it sits in.
//
// The sibling is `livePr` in prReview.ts, which fixes the same class of bug for
// a PR *tab*: a row captured when the tab opened, rendered as if it were still
// true. It derives its answer from the conversation payload that tab already
// fetched, which is exactly what a link chip does not have — the chip fetches
// nothing, which is why this asks rather than derives. Research and the
// scratchpad each held their own copy of that asking; this is the one copy.
//
// Three sources, cheapest first:
//
//   * The PR watcher's rows. It already polls every watched repo and holds only
//     *open* pull requests, so a row is proof of "open" at no cost. Absence
//     proves nothing: merged, closed, a repo nobody declared and a pass that
//     has not run yet all look identical from here.
//   * `gh pr view`, once per PR, for everything the watcher cannot answer.
//     Cached for TTL_MS, and a merged PR is never asked about twice — nothing
//     follows a merge.
//   * The stored value, as the last thing we knew, until one of the above
//     lands. Never a guess: a PR we could not reach keeps saying what it said.
import { useEffect } from "react";
import * as ipc from "./ipc";
import { createChannel, useChannel } from "./channel";
import { rowFor } from "./prWatchStore";

/** The part of a linked PR both stores agree on. `ResearchPrLink` and
 *  `NotePrLink` are the same four fields; everything here works on either. */
export interface PrLinkRef {
  repo: string;
  number: number;
  state: string;
}

/** How long a resolved state is trusted before it is worth asking again. Long
 *  enough that opening the same entry twice costs one `gh` call, short enough
 *  that a PR closed while the window sat open corrects itself. */
const TTL_MS = 5 * 60_000;

export const prKey = (repo: string, number: number) => `${repo}#${number}`;

interface Resolved {
  state: string;
  at: number;
}

const resolved = new Map<string, Resolved>();
const inflight = new Map<string, Promise<string>>();

/** Bumped whenever an answer lands, so views re-render. A counter rather than
 *  the map itself: subscribers read through `stateOf`, and a channel carrying a
 *  mutable map would publish an identity that never changes. */
const board = createChannel(0);

/** Nothing follows a merge, so a merged PR is never asked about again. A closed
 *  one can be reopened, which is why only this one state is terminal. */
const terminal = (state: string) => state === "merged";

const fresh = (k: string, now: number): boolean => {
  const hit = resolved.get(k);
  return !!hit && (terminal(hit.state) || now - hit.at < TTL_MS);
};

/** The state to show for a link, right now. Synchronous by design — a chip
 *  renders on the first paint with the last thing we knew, and re-renders when
 *  `resolve` lands something better. */
export function stateOf(link: PrLinkRef): string {
  const hit = resolved.get(prKey(link.repo, link.number));
  if (hit) return hit.state;
  // The watcher lists open PRs only, so a row is a live "open".
  if (rowFor(link.repo, link.number)) return "open";
  return (link.state || "").toLowerCase();
}

function ask(k: string, link: PrLinkRef): Promise<string> {
  const pending = inflight.get(k);
  if (pending) return pending;
  const p = ipc
    .ghPrState(link.repo, link.number)
    .then((s) => s.trim().toLowerCase())
    // Unreachable — no gh, no network, a repo that moved — is not an answer.
    // Recording nothing leaves the chip on the last thing we knew, which is the
    // whole difference between a status that lags and one that is invented.
    .catch(() => "")
    .then((state) => {
      inflight.delete(k);
      if (state) resolved.set(k, { state, at: Date.now() });
      return state;
    });
  inflight.set(k, p);
  return p;
}

/** Resolve every link that needs it, then publish. Links already answered
 *  recently, and duplicates within one call, cost nothing. */
export async function resolve(links: PrLinkRef[]): Promise<void> {
  const now = Date.now();
  const want = new Map<string, PrLinkRef>();
  for (const l of links) {
    const k = prKey(l.repo, l.number);
    if (want.has(k) || fresh(k, now)) continue;
    want.set(k, l);
  }
  if (want.size === 0) return;
  await Promise.all(
    [...want].map(([k, l]) => {
      if (rowFor(l.repo, l.number)) {
        resolved.set(k, { state: "open", at: now });
        return Promise.resolve("open");
      }
      return ask(k, l);
    }),
  );
  board.set(board.get() + 1);
}

/** Live states for one entry's links, for a detail view.
 *
 *  Resolves on mount and whenever the set of links changes, and re-renders when
 *  an answer arrives. This is what makes the chip correct without waiting for a
 *  background sweep — the entry the user opened is the one entry we know for
 *  certain somebody is looking at. */
export function usePrLinkStates(links: PrLinkRef[]): (link: PrLinkRef) => string {
  useChannel(board);
  // The identity that matters is which PRs, not which array. A detail view
  // re-reads its entry on every store event and hands us a fresh array each
  // time; depending on the array would re-ask on every one of them.
  const key = links.map((l) => prKey(l.repo, l.number)).join(",");
  useEffect(() => {
    if (key) void resolve(links);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return stateOf;
}

/** Bring a set of entries' recorded PR states up to date, and answer with the
 *  ids whose pull requests have all merged.
 *
 *  Research and the scratchpad hold the same links behind different commands,
 *  so the walk lives here and the two commands are passed in.
 *
 *  The split is the point. Refreshing what a link says and moving the thing
 *  holding it are separate jobs; they used to be one function behind one status
 *  gate, which is why a PR's recorded state stopped being maintained the moment
 *  its entry moved on. This refreshes every entry it is given, whatever status
 *  it is in, and leaves the decision about moving anything to the caller. */
export async function refreshPrLinks<
  R extends { id: string; pr_count: number },
  L extends PrLinkRef,
>(
  rows: R[],
  read: (id: string) => Promise<L[] | null>,
  write: (id: string, pr: L) => Promise<void>,
): Promise<Set<string>> {
  const allMerged = new Set<string>();
  for (const row of rows) {
    if (row.pr_count === 0) continue;
    const prs = await read(row.id).catch(() => null);
    if (!prs || prs.length === 0) continue;
    await resolve(prs);
    let merged = 0;
    for (const pr of prs) {
      const state = stateOf(pr);
      if (state && state !== pr.state) {
        await write(row.id, { ...pr, state }).catch(() => {});
      }
      if (state === "merged") merged += 1;
    }
    if (merged === prs.length) allMerged.add(row.id);
  }
  return allMerged;
}

/** Test seam: forget every resolved state and every listener. */
export function __reset(): void {
  resolved.clear();
  inflight.clear();
  board.reset();
}

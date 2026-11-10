// Noticing that a pull request an agent was working under has merged.
//
// `ghPrList` lists open PRs only, so a merge is never seen directly: the PR is
// seen open, and later it is not there. That absence means merged OR closed, and
// only `ghPrState` can say which. This module keeps the "seen open" memory and
// reports which branches have vanished since the last look; the caller asks
// `ghPrState` about those and acts on MERGED only.

export interface OpenPr {
  branch: string;
  number: number;
}

export interface WatchResult {
  /** The memory to pass to the next look. */
  tracked: Map<string, number>;
  /** Branches whose PR was open before and is not now. */
  vanished: { branch: string; number: number }[];
}

/** One look. `watch` is the set of branches an agent is currently working in;
 *  a branch nobody is working in any more is forgotten rather than reported. */
export function diffOpenPrs(
  tracked: ReadonlyMap<string, number>,
  open: readonly OpenPr[],
  watch: readonly string[],
): WatchResult {
  const watching = new Set(watch);
  const openByBranch = new Map(open.map((pr) => [pr.branch, pr.number]));
  const next = new Map<string, number>();
  const vanished: { branch: string; number: number }[] = [];
  for (const branch of watching) {
    const nowOpen = openByBranch.get(branch);
    if (nowOpen !== undefined) {
      next.set(branch, nowOpen);
    } else {
      const before = tracked.get(branch);
      if (before !== undefined) vanished.push({ branch, number: before });
    }
  }
  return { tracked: next, vanished };
}

/** `gh pr view --json state` answers MERGED, CLOSED or OPEN. */
export const isMergedState = (state: string): boolean => state.trim().toUpperCase() === "MERGED";

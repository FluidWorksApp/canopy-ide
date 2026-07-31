// How a pile of PRs from every open project becomes a list you can act on.
// Pure: the watcher (prwatch.rs) supplies rows, the store fans them out, and
// everything about *ordering and grouping* lives here so it can be tested and
// so no component has to hold an opinion about triage.
import type * as ipc from "./ipc";

/** The lanes, in the order they are shown. A PR is in exactly one — the first
 *  it qualifies for — because a row in two places is a row you read twice. */
export type Lane = "needs-you" | "blocked" | "waiting" | "ready" | "draft";

export const LANE_LABEL: Record<Lane, string> = {
  "needs-you": "Needs you",
  blocked: "Blocked",
  waiting: "Waiting on review",
  ready: "Ready to land",
  draft: "Drafts",
};

export const LANE_ORDER: Lane[] = ["needs-you", "blocked", "waiting", "ready", "draft"];

/** Which lane a row belongs in.
 *
 *  The ordering is the opinion, and it is the same one the PR tab's next-move
 *  bar takes: something asked of *you* outranks everything (review latency is
 *  the metric that actually moves), then your own PRs that can't proceed, then
 *  the ones simply waiting on other people. "Ready" is last of the live lanes
 *  because it needs a click, not attention. */
export function laneOf(row: ipc.PrRow): Lane {
  if (row.draft) return "draft";
  // Someone asked you, or asked for changes you haven't answered. Both are
  // "you are the reason this has stopped".
  if (row.requested_from_me) return "needs-you";
  if (row.mine && row.review_decision === "CHANGES_REQUESTED") return "needs-you";
  if (row.mine && (row.checks === "FAIL" || row.mergeable === "CONFLICTING")) return "blocked";
  if (row.review_decision === "APPROVED" && row.checks !== "FAIL" && row.mergeable !== "CONFLICTING")
    return "ready";
  if (!row.mine && !row.requested_from_me) return "waiting";
  return "waiting";
}

/** Rows a person should look at before the others, within a lane: yours first
 *  (you can act on them), then most recently touched. */
export function sortRows(rows: ipc.PrRow[]): ipc.PrRow[] {
  return [...rows].sort((a, b) => {
    if (a.mine !== b.mine) return a.mine ? -1 : 1;
    return a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.number - b.number;
  });
}

export interface LaneGroup {
  lane: Lane;
  rows: ipc.PrRow[];
}

/** Group into lanes, dropping empty ones so the panel has no dead headings. */
export function lanes(rows: ipc.PrRow[]): LaneGroup[] {
  const byLane = new Map<Lane, ipc.PrRow[]>();
  for (const row of rows) {
    const lane = laneOf(row);
    const list = byLane.get(lane);
    if (list) list.push(row);
    else byLane.set(lane, [row]);
  }
  return LANE_ORDER.filter((l) => byLane.has(l)).map((lane) => ({
    lane,
    rows: sortRows(byLane.get(lane) ?? []),
  }));
}

/** The number worth putting on the rail icon: things actually waiting on you.
 *  Drafts and other people's queues are not a notification. */
export const needsYouCount = (rows: ipc.PrRow[]): number =>
  rows.filter((r) => laneOf(r) === "needs-you").length;

/** One row's headline state, for the badge next to it. Deliberately one thing:
 *  a row wearing four chips tells you nothing. */
export function rowState(row: ipc.PrRow): { text: string; tone: "bad" | "ok" | "warn" | "dim" } {
  if (row.draft) return { text: "draft", tone: "dim" };
  if (row.mergeable === "CONFLICTING") return { text: "conflicts", tone: "bad" };
  if (row.checks === "FAIL") return { text: "checks failed", tone: "bad" };
  if (row.review_decision === "CHANGES_REQUESTED") return { text: "changes requested", tone: "bad" };
  if (row.requested_from_me) return { text: "your review", tone: "warn" };
  if (row.review_decision === "APPROVED") return { text: "approved", tone: "ok" };
  if (row.checks === "PENDING") return { text: "checks running", tone: "warn" };
  return { text: "open", tone: "dim" };
}

/** Merge a snapshot into what we already hold: a snapshot is the whole truth
 *  for its own repo and says nothing about any other, so replace by repo rather
 *  than merging row by row. Rows for repos no longer watched are dropped by the
 *  caller passing a `keep` set. */
export function applySnapshot(
  current: Map<string, ipc.PrRow[]>,
  snap: ipc.PrSnapshot,
): Map<string, ipc.PrRow[]> {
  const next = new Map(current);
  next.set(snap.repo, snap.rows);
  return next;
}

/** Flatten the per-repo map for rendering. */
export const allRows = (byRepo: Map<string, ipc.PrRow[]>): ipc.PrRow[] =>
  Array.from(byRepo.values()).flat();

/** "2m ago" for a millisecond timestamp — the panel's "last checked". */
export function since(ms: number, now = Date.now()): string {
  if (!ms) return "never";
  const d = Math.max(0, Math.floor((now - ms) / 1000));
  if (d < 10) return "just now";
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h ago`;
}

/** Did anything about this PR change in a way the detail tab should care about?
 *  `updated` moves on comments, pushes and reviews alike, which is exactly the
 *  set of things a detail tab would want to refetch for. */
export const rowChanged = (a: ipc.PrRow | undefined, b: ipc.PrRow | undefined): boolean =>
  !!b && (!a || a.updated !== b.updated);

/** The PrInfo shape the detail tab and every existing PR helper expect. The
 *  inbox row carries everything but the checks summary, so a click opens a tab
 *  with no extra call. */
export function toPrInfo(row: ipc.PrRow): ipc.PrInfo {
  return {
    number: row.number,
    title: row.title,
    author: row.author,
    branch: row.branch,
    base: row.base,
    draft: row.draft,
    state: "OPEN",
    url: row.url,
    created: row.created,
    updated: row.updated,
    review_decision: row.review_decision,
    additions: row.additions,
    deletions: row.deletions,
    mine: row.mine,
    mergeable: row.mergeable,
    checks: row.checks,
    checks_summary: "",
  };
}

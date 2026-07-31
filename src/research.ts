// Research, as the UI sees it: the status model the panel groups by, a small
// cache so the panel and SpotSearch don't each re-read the store, and the one
// event everything refreshes on.
//
// The store itself is Rust (src-tauri/src/research.rs) and is the only
// authority — nothing here is allowed to become a second source of truth. This
// module holds the last answer it gave, so the palette can offer rows on the
// first keystroke instead of after a round trip, and refreshes it whenever the
// store changes.
import * as ipc from "./ipc";

export type ResearchStatus = ipc.ResearchStatus;

/** Order the panel renders in: what needs a human first, then what is moving,
 *  then what is finished, then what has been put down. Same idea as the unified
 *  tracker statuses in trackers.ts — one list, grouped, regardless of who or
 *  what moved an entry into a state. */
export const STATUS_ORDER: ResearchStatus[] = [
  "blocked",
  "researching",
  "researched",
  "implementing",
  "implemented",
  "open",
  "superseded",
  "archived",
];

export const STATUS_LABELS: Record<ResearchStatus, string> = {
  open: "Not started",
  researching: "Researching",
  researched: "Researched",
  implementing: "Implementing",
  implemented: "Implemented",
  blocked: "Blocked",
  superseded: "Superseded",
  archived: "Archived",
};

/** One line each, because a status list with no explanation invites two people
 *  to mean different things by "researched". */
export const STATUS_BLURBS: Record<ResearchStatus, string> = {
  open: "The question is written down; nobody has started.",
  researching: "An agent is working on it now.",
  researched: "There is a finding. Nothing has been built from it yet.",
  implementing: "Someone is building it.",
  implemented: "A pull request carrying it merged.",
  blocked: "Stuck, and waiting on you.",
  superseded: "A later entry replaced this one.",
  archived: "Put down deliberately.",
};

/** Statuses the panel shows by default: current work, not the closed record.
 *  Implemented stays in — "what shipped from research" is exactly the question
 *  nothing else in the IDE could answer. */
export const ACTIVE_STATUSES: ResearchStatus[] = [
  "blocked",
  "researching",
  "researched",
  "implementing",
  "implemented",
  "open",
];

/** Where each status sits on the way from question to shipped, for the progress
 *  dots on a row. `blocked` deliberately keeps the rank of the work it
 *  interrupted rather than getting one of its own. */
export const STATUS_STEP: Record<ResearchStatus, number> = {
  open: 0,
  researching: 1,
  blocked: 1,
  researched: 2,
  implementing: 3,
  implemented: 4,
  superseded: 4,
  archived: 4,
};

/** Which transitions the store will accept — mirrored from the Rust state
 *  machine so the panel offers only the moves that exist rather than showing
 *  eight buttons and letting six of them fail. research.rs is the authority;
 *  the test in research.test.ts is what keeps the two honest. */
export const NEXT_STATUSES: Record<ResearchStatus, ResearchStatus[]> = {
  open: ["researching", "archived"],
  researching: ["researched", "blocked", "archived"],
  blocked: ["researching", "researched", "implementing", "archived"],
  researched: ["implementing", "researching", "blocked", "superseded", "archived"],
  implementing: ["implemented", "researched", "blocked", "archived"],
  implemented: ["superseded", "archived"],
  superseded: ["archived"],
  archived: [],
};

/** Fired whenever the store changes, so every surface showing research
 *  refreshes without polling. Emitted by the mutators below rather than by
 *  their callers, so no write can forget it — the same arrangement
 *  taskHistory.ts uses for TASK_HISTORY_EVENT. */
export const RESEARCH_EVENT = "canopy:research-changed";

const announce = () => window.dispatchEvent(new CustomEvent(RESEARCH_EVENT));

// ---------- the cache ----------
//
// Per project, last answer only. Never consulted for a decision — the store is
// asked again on every change — but it lets the palette put research rows up on
// the first keystroke, which is the difference between research being findable
// and research being findable eventually.

const cache = new Map<string, ipc.ResearchSummary[]>();

/** The last known entries for a project. Empty until something has loaded them;
 *  callers that need certainty call `refresh`. */
export const cached = (projectId: string): ipc.ResearchSummary[] =>
  cache.get(projectId) ?? [];

/** Re-read a project's entries and publish them. */
export async function refresh(projectId: string): Promise<ipc.ResearchSummary[]> {
  const rows = await ipc.researchList(projectId, ACTIVE_STATUSES, 50).catch(() => []);
  cache.set(projectId, rows);
  announce();
  return rows;
}

/** Drop a project's cache — it closed, so its rows should stop appearing in a
 *  palette that is now floating over something else. */
export function forget(projectId: string): void {
  cache.delete(projectId);
  announce();
}

/** Subscribe to the store's own change event, so writes that never touched this
 *  module still reach the UI.
 *
 *  The mutators below announce on `RESEARCH_EVENT`, which covers everything the
 *  user does here. It cannot cover an agent: `canopy_research_write` reaches the
 *  Rust commands through the MCP endpoint, and the renderer is never told. The
 *  panel fetches once per project on mount, so without this an agent's entry is
 *  invisible until the project is reopened — which reads as the write having
 *  failed. Rust therefore emits too, and this turns that into the same refresh.
 *
 *  Idempotent, and called by every surface that renders research, because no one
 *  of them is guaranteed to be mounted. Only projects already in the cache are
 *  re-read: a project nobody is showing has none, and `forget` clearing it must
 *  not be undone by a background write. */
let subscribed = false;
export function watchStore(): void {
  if (subscribed) return;
  subscribed = true;
  void ipc
    .onResearchChanged((projectId) => {
      if (cache.has(projectId)) void refresh(projectId);
    })
    // No event bridge — a test harness, a window that never got one — costs
    // live updates, not correctness: the fetch on mount still runs. Swallowing
    // it keeps a rendering surface from raising, and releasing the flag lets
    // the next mount try again rather than disabling this for the session.
    .catch(() => {
      subscribed = false;
    });
}

/** Test seam. `subscribed` is module state that outlives a test, so a test
 *  arming its own fake listener needs the next one to be able to arm too. */
export function resetStoreWatchForTest(): void {
  subscribed = false;
}

// ---------- mutations ----------
//
// Thin wrappers whose only job is to refresh afterwards. Anything that changes
// an entry goes through here rather than calling ipc directly, so the panel and
// the palette can never be showing a state the store has moved on from.

/** `by` defaults to the user because most moves are a button they pressed; the
 *  launcher passes "Canopy" for the ones the app makes on its own, so the
 *  history never credits a person for something they did not do. */
export async function setStatus(
  projectId: string,
  id: string,
  status: ResearchStatus,
  by = "you",
  note?: string,
): Promise<void> {
  await ipc.researchSetStatus(projectId, id, status, by, note);
  await refresh(projectId);
}

/** Move an entry only if it is still running.
 *
 *  The two "the run ended badly" paths — stopped by the user, died without
 *  reporting — can fire *after* a successful job_done has already marked the
 *  entry researched, because a process exiting is the last thing that happens
 *  either way. The store would accept researched → blocked quite happily, so
 *  the guard has to be here: settle what is still in flight, and leave anything
 *  that already reached a conclusion alone. */
export async function settleIfRunning(
  projectId: string,
  id: string,
  status: ResearchStatus,
  note: string,
): Promise<void> {
  const entry = await ipc.researchGet(projectId, id).catch(() => null);
  if (!entry) return;
  if (entry.status !== "researching" && entry.status !== "implementing") return;
  await setStatus(projectId, id, status, "Canopy", note).catch(() => {});
}

/** Give an entry a better name than the one it was born with.
 *
 *  An entry titles itself from the question, shortened — which is the only
 *  thing available at the moment it is created, and reliably terrible once
 *  anyone knows what the research actually turned out to be about. The title is
 *  what the panel, the tab strip, ⌘K and every citation of this entry show, so
 *  it is worth being able to fix. Empty is refused rather than stored: a row
 *  with no name is worse than a clumsy one. */
export async function rename(
  projectId: string,
  id: string,
  title: string,
): Promise<void> {
  const next = title.trim();
  if (!next) return;
  await ipc.researchUpdate({ projectId, id, title: next });
  await refresh(projectId);
}

export async function remove(projectId: string, id: string): Promise<void> {
  await ipc.researchDelete(projectId, id);
  await refresh(projectId);
}

export async function link(args: ipc.ResearchLinkArgs): Promise<ipc.ResearchDetail> {
  const detail = await ipc.researchLink(args);
  await refresh(args.projectId);
  return detail;
}

export async function start(args: ipc.ResearchStartArgs): Promise<ipc.ResearchSummary> {
  const entry = await ipc.researchStart(args);
  await refresh(args.projectId);
  return entry;
}

// ---------- the loop's closing half ----------

/** Move entries whose linked pull requests have all merged to `implemented`.
 *
 *  This is the tie-back the module exists for: an agent links the PR it raised,
 *  and the entry becomes "implemented" because that PR merged — not because
 *  anyone asserted it. Two rules keep it honest:
 *
 *  - An entry with no linked PR is never swept up. "Implementing" with nothing
 *    linked means nobody said what was carrying the work, not that it is done.
 *  - The state comes from asking GitHub, not from the PR having disappeared
 *    from the watcher's list. The watcher holds only *open* PRs, so a vanished
 *    one may equally have been closed unmerged — and inferring "shipped" from
 *    that is exactly the kind of quiet wrongness a status is supposed to
 *    prevent.
 *
 *  Every linked PR also has its recorded state refreshed on the way past, so
 *  the detail view shows what actually happened to each one. */
export async function reconcileMerged(projectId: string): Promise<number> {
  const rows = cached(projectId).filter(
    (r) => r.status === "implementing" && r.pr_count > 0,
  );
  let moved = 0;
  for (const row of rows) {
    const detail = await ipc.researchGet(projectId, row.id).catch(() => null);
    if (!detail || detail.links.prs.length === 0) continue;
    const states = await Promise.all(
      detail.links.prs.map(async (pr) => ({
        pr,
        state: await ipc
          .ghPrState(pr.repo, pr.number)
          .then((s) => s.toLowerCase())
          // Unreachable (no gh, no network, a repo that moved) is not "merged".
          // Leaving the entry where it is costs a status that lags; guessing
          // costs a finding marked shipped that never was.
          .catch(() => ""),
      })),
    );
    for (const { pr, state } of states) {
      if (state && state !== pr.state) {
        await ipc
          .researchLink({ projectId, id: row.id, pr: { ...pr, state } })
          .catch(() => {});
      }
    }
    if (states.length > 0 && states.every((s) => s.state === "merged")) {
      await ipc
        .researchSetStatus(projectId, row.id, "implemented", "Canopy",
          "every linked pull request merged")
        .catch(() => {});
      moved += 1;
    }
  }
  if (moved > 0) await refresh(projectId);
  return moved;
}

/** How a research entry is handed to an agent that will implement it.
 *
 *  Digest and recommendation only — deliberately not the body. The whole point
 *  of capping the digest was that this handoff could be one paragraph; pasting
 *  the document here would spend the budget the tiers exist to protect, and the
 *  agent can call `canopy_research get` if it wants the rest. */
export function implementContext(entry: ipc.ResearchDetail): string {
  const parts = [
    `Implement research ${entry.id}: "${entry.title}".`,
    entry.digest && `Finding: ${entry.digest}`,
    entry.recommendation && `Recommendation: ${entry.recommendation}`,
    entry.open_questions.length
      ? `Still open: ${entry.open_questions.join("; ")}`
      : "",
    `Call \`canopy_research get\` with id ${entry.id} for the full write-up and its sources before you start.`,
    `When you raise the PR, call \`canopy_research_write\` with action "link" and the PR so the entry records what implemented it.`,
  ];
  return parts.filter(Boolean).join(" ");
}

/** The opening brief for a research run. Names the protocol the harness will
 *  enforce anyway, because an agent that knows the rule writes better research
 *  than one that discovers it through a denied write. */
export function researchContext(entry: ipc.ResearchSummary, question: string): string {
  return [
    `Research this and record it in Canopy: ${question}`,
    `Your research entry is ${entry.id} ("${entry.title}") — it already exists.`,
    `Work through it with \`canopy_research_write\`: action "append" for findings as you go,`,
    `action "source" for anything long you want to keep (file dumps, logs, fetched pages),`,
    `and when you are done, action "digest" with the one paragraph another agent should read`,
    `instead of the whole entry, plus a recommendation.`,
    `Do not write research into files — writes outside the entry are refused, and the`,
    `answer would be lost when this session ends. Read code freely; change none of it.`,
  ].join(" ");
}

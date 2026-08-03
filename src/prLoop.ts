// The review loop: agent addresses the comments, the human comes back with
// more, agent addresses those, until the PR is approved and green. The rounds
// are one-shot agents — micro-tasks are deliberately amnesiac (job_done → wait
// for Stop → kill → sessionForget, see ProjectView) — so the memory of the loop
// lives here instead, and each round starts fresh from the PR thread, which is
// where the shared history actually is.
//
// Same storage call as taskHistory.ts and settings.ts: localStorage. Losing it
// costs at most a duplicated round, and every irreversible step (posting,
// merging) stays behind a human click regardless of what this file remembers.
import type * as ipc from "./ipc";
import { actionable } from "./prReview";

export type LoopStatus =
  /** No loop yet, or it was reset. */
  | "idle"
  /** A round's agent is running. */
  | "working"
  /** The round pushed; waiting for the humans to come back. */
  | "waiting"
  /** Needs a person: the agent asked, or a guard tripped. */
  | "blocked"
  /** Approved and green — the merge is one click away, deliberately. */
  | "ready"
  | "done";

export interface RoundRecord {
  n: number;
  startedAt: number;
  endedAt?: number;
  status: "working" | "done" | "blocked" | "stopped";
  /** The agent's one-line job_done summary. */
  summary?: string;
  /** Head sha when the round started, so "did it actually push?" is answerable. */
  headSha?: string;
  /** How many comments this round took on. */
  took: number;
}

export interface PrLoop {
  key: string;
  repo: string;
  number: number;
  status: LoopStatus;
  cycle: number;
  maxCycles: number;
  /** Comment / thread / review ids already handed to an agent. Never twice. */
  handled: string[];
  rounds: RoundRecord[];
  /** Set when a guard stopped the loop — shown verbatim in the UI. */
  blockedReason?: string;
  /** Rounds that ended without pushing anything. One is a warning, two is a
   *  loop that isn't converging. */
  noPush: number;
  /** Armed: when new comments arrive, start the next round without being asked.
   *  This is what makes the loop a loop rather than a button — and why the
   *  guards in `roundGate` exist. Off until the user starts one. */
  auto: boolean;
  autoMerge: boolean;
  updatedAt: number;
}

/** Three rounds. Past that, a human should look at why it isn't converging. */
export const MAX_ROUNDS = 3;

/** A round that hasn't reported in this long has lost its agent (crashed CLI,
 *  closed tab, machine slept) — treat it as needing a person, not as running. */
export const ROUND_STALE_MS = 45 * 60 * 1000;

export const loopKey = (repo: string, number: number): string => `${repo}#${number}`;

export function emptyLoop(repo: string, number: number): PrLoop {
  return {
    key: loopKey(repo, number),
    repo,
    number,
    status: "idle",
    cycle: 0,
    maxCycles: MAX_ROUNDS,
    handled: [],
    rounds: [],
    noPush: 0,
    auto: false,
    autoMerge: false,
    updatedAt: Date.now(),
  };
}

// ---------- transitions (pure) ----------

/** Start a round on `ids`, which are marked handled up front: an agent that
 *  crashes mid-round must not cause the same comments to be re-addressed. */
export function beginRound(loop: PrLoop, ids: string[], headSha: string): PrLoop {
  const n = loop.cycle + 1;
  return {
    ...loop,
    status: "working",
    cycle: n,
    handled: Array.from(new Set([...loop.handled, ...ids])),
    rounds: [
      ...loop.rounds,
      { n, startedAt: Date.now(), status: "working", headSha, took: ids.length },
    ],
    blockedReason: undefined,
    updatedAt: Date.now(),
  };
}

/** The round's agent reported. `pushed` is whether head moved — a round that
 *  only posted replies made no code progress, which is the guard against two
 *  agents talking past each other forever. */
export function finishRound(
  loop: PrLoop,
  outcome: "done" | "blocked" | "stopped",
  summary: string | undefined,
  pushed: boolean,
): PrLoop {
  const rounds = loop.rounds.map((r, i) =>
    i === loop.rounds.length - 1 && r.status === "working"
      ? { ...r, status: outcome, endedAt: Date.now(), summary }
      : r,
  );
  const noPush = outcome === "done" && !pushed ? loop.noPush + 1 : loop.noPush;
  let status: LoopStatus = outcome === "done" ? "waiting" : "blocked";
  let blockedReason = outcome === "done" ? undefined : summary || "the agent stopped without finishing";
  if (outcome === "done" && noPush >= 2) {
    status = "blocked";
    blockedReason = "two rounds in a row changed no code — this looks like a disagreement, not a task";
  } else if (outcome === "done" && loop.cycle >= loop.maxCycles) {
    status = "blocked";
    blockedReason = `${loop.cycle} rounds and comments are still coming — worth reading it yourself`;
  }
  return { ...loop, status, blockedReason, noPush, rounds, updatedAt: Date.now() };
}

export function markReady(loop: PrLoop): PrLoop {
  return { ...loop, status: "ready", blockedReason: undefined, updatedAt: Date.now() };
}

export function markDone(loop: PrLoop): PrLoop {
  return { ...loop, status: "done", updatedAt: Date.now() };
}

export function resetLoop(loop: PrLoop): PrLoop {
  return { ...emptyLoop(loop.repo, loop.number), autoMerge: loop.autoMerge };
}

/** A `working` round whose agent went quiet. */
export const isRoundStale = (loop: PrLoop, now = Date.now()): boolean =>
  loop.status === "working" &&
  (loop.rounds[loop.rounds.length - 1]?.startedAt ?? now) + ROUND_STALE_MS < now;

// ---------- what the watcher asks ----------

/** Actionable comment ids this loop has never handed to an agent. Empty means
 *  nothing new has arrived, whatever `updatedAt` says — a push moves that
 *  timestamp too, which is why ids are the trigger and time isn't. */
export function newSinceHandled(conv: ipc.PrConversation, loop: PrLoop): string[] {
  const seen = new Set(loop.handled);
  return actionable(conv).ids.filter((id) => !seen.has(id));
}

/** Return actionable ids that have not been announced in this mounted PR tab,
 * then remember every id in the current snapshot. This is deliberately separate
 * from `handled`: showing a toast does not mean an agent addressed the comment. */
export function takeUnnoticed(conv: ipc.PrConversation, noticed: Set<string>): string[] {
  const ids = actionable(conv).ids;
  const fresh = ids.filter((id) => !noticed.has(id));
  ids.forEach((id) => noticed.add(id));
  return fresh;
}

export interface RoundGate {
  ok: boolean;
  /** Why not, in words the UI can show as a tooltip. */
  reason?: string;
  ids: string[];
}

/** May a round start right now? The guards are the point of the whole file. */
export function roundGate(
  pr: ipc.PrInfo,
  conv: ipc.PrConversation | null,
  loop: PrLoop,
): RoundGate {
  if (!conv) return { ok: false, reason: "still loading the conversation", ids: [] };
  if (pr.state !== "OPEN") return { ok: false, reason: "this PR is closed", ids: [] };
  if (loop.status === "working") return { ok: false, reason: "a round is already running", ids: [] };
  if (conv.checks === "FAIL")
    return {
      ok: false,
      reason: "checks are failing — fix the build before addressing comments on it",
      ids: [],
    };
  if (conv.mergeable === "CONFLICTING")
    return { ok: false, reason: "it conflicts with its base — update the branch first", ids: [] };
  if (loop.cycle >= loop.maxCycles)
    return { ok: false, reason: `${loop.maxCycles} rounds is the cap for one PR`, ids: [] };
  const ids = newSinceHandled(conv, loop);
  if (!ids.length) return { ok: false, reason: "no comments to address", ids: [] };
  return { ok: true, ids };
}

/** Approved, green, and not conflicting — GitHub's own verdict, not ours. */
export const isLandable = (conv: ipc.PrConversation): boolean =>
  conv.review_decision === "APPROVED" && conv.checks !== "FAIL" && conv.mergeable !== "CONFLICTING";

// ---------- persistence ----------

const KEY = "canopy.prLoops";
/** Loops are per PR and PRs are finite, but a busy month shouldn't grow this
 *  without bound; the oldest are dropped. */
const MAX_LOOPS = 60;

type Store = Record<string, PrLoop>;

function read(): Store {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Store) : {};
  } catch {
    return {};
  }
}

export function loadLoop(repo: string, number: number): PrLoop {
  return read()[loopKey(repo, number)] ?? emptyLoop(repo, number);
}

export function saveLoop(loop: PrLoop): PrLoop {
  const all = read();
  all[loop.key] = loop;
  const keys = Object.keys(all);
  if (keys.length > MAX_LOOPS) {
    keys
      .sort((a, b) => (all[a].updatedAt ?? 0) - (all[b].updatedAt ?? 0))
      .slice(0, keys.length - MAX_LOOPS)
      .forEach((k) => delete all[k]);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // A full quota is not worth failing a review over.
  }
  return loop;
}

export function forgetLoop(repo: string, number: number): void {
  const all = read();
  delete all[loopKey(repo, number)];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

// ---------- findings already posted ----------
//
// A Review task's findings file stays on disk after the review is submitted —
// nothing deletes it, and the tab re-reads it on every mount. Without a record
// of what already went out, re-opening the tab staged the same comments again,
// as drafts, on a PR where they are live threads. So the posting is remembered
// here: keys only, never the comment bodies, and capped like the loops are.

const POSTED_KEY = "canopy.prPostedFindings";
const MAX_POSTED_PRS = 60;
/** Per PR. A review with more findings than this is not the case worth sizing
 *  for, and the tail being re-offered is a far smaller wrong than unbounded
 *  growth in a store the user can't see or clear. */
const MAX_POSTED_PER_PR = 200;

type PostedStore = Record<string, { at: number; keys: string[] }>;

function readPosted(): PostedStore {
  try {
    const v = JSON.parse(localStorage.getItem(POSTED_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as PostedStore) : {};
  } catch {
    return {};
  }
}

/** Identity of a finding, matched on what the agent wrote rather than on the
 *  posted comment: submit() prefixes "Nit: " on the way out, so the text that
 *  comes back from GitHub is not the text that was staged. */
export const findingKey = (f: { path: string; line: number; body: string }): string =>
  `${f.path}:${f.line}:${f.body.trim()}`;

export function postedFindings(repo: string, number: number): Set<string> {
  return new Set(readPosted()[loopKey(repo, number)]?.keys ?? []);
}

export function rememberPosted(repo: string, number: number, keys: string[]): void {
  if (!keys.length) return;
  const all = readPosted();
  const k = loopKey(repo, number);
  const merged = [...new Set([...(all[k]?.keys ?? []), ...keys])];
  all[k] = { at: Date.now(), keys: merged.slice(-MAX_POSTED_PER_PR) };
  const prs = Object.keys(all);
  if (prs.length > MAX_POSTED_PRS) {
    prs
      .sort((a, b) => (all[a].at ?? 0) - (all[b].at ?? 0))
      .slice(0, prs.length - MAX_POSTED_PRS)
      .forEach((key) => delete all[key]);
  }
  try {
    localStorage.setItem(POSTED_KEY, JSON.stringify(all));
  } catch {
    // Same trade as the loops: a full quota must not fail a review.
  }
}

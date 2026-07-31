// Deciding when to interrupt someone about their base branch, and with what
// words. Pure functions, no React and no IPC: the rules for "is this worth a
// prompt" are the part that has to be right, so they're testable on their own.
//
// The shape of the feature: a timer probes the base branch without touching
// the worktree, and the *only* thing that happens automatically is that a chip
// appears. Merging is always a click. Saying no is remembered against the base
// tip, so "not now" means "not until main moves again" rather than "ask me in
// five minutes".
import type { SyncProbe } from "./ipc";

/** How often to re-probe, fetching from the remote each time. Frequent enough
 *  that a conflict is minutes old rather than days; rare enough that a big
 *  repo's fetch isn't a background tax. */
export const PROBE_INTERVAL_MS = 5 * 60_000;

/** Dismissals are keyed on the base tip: a new commit on main is genuinely new
 *  news, so the chip comes back. Nothing else about the branch re-asks. */
export const probeKey = (p: SyncProbe) => `${p.repo}\n${p.base}\n${p.base_head}`;

/** Cap on remembered dismissals — a session that ran for weeks shouldn't grow
 *  this without bound. Oldest go first; the base tip they named is long gone. */
const DISMISS_LIMIT = 50;

export const remember = (prev: readonly string[], key: string): string[] =>
  [...prev.filter((k) => k !== key), key].slice(-DISMISS_LIMIT);

/** Is there anything to tell the user? Behind-ness alone isn't enough: a
 *  branch mid-merge, or a detached HEAD, has nothing actionable to offer. */
export const hasNews = (p: SyncProbe | null): p is SyncProbe =>
  p != null && p.behind > 0 && p.state !== "blocked";

/** Should the prompt open by itself? Only for news the user hasn't waved off.
 *  The chip stays either way — dismissing hides the panel, not the fact. */
export const shouldPrompt = (p: SyncProbe | null, dismissed: readonly string[]): boolean =>
  hasNews(p) && !dismissed.includes(probeKey(p));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Bare branch name for display — `origin/main` is plumbing, `main` is what
 *  the user calls it. */
export const baseLabel = (base: string) => base.replace(/^[^/]+\//, "");

export interface SyncPrompt {
  headline: string;
  detail: string;
  /** Paths worth listing under the detail line (conflicting or in the way). */
  files: string[];
  /** Whether the merge button does anything useful right now. */
  canMerge: boolean;
  /** Present when it doesn't — what the user has to do first. */
  blockedReason: string | null;
  mergeLabel: string;
  /** Conflicts ahead: the UI leans on this for colour and for warning that
   *  the merge will stop partway. */
  willConflict: boolean;
}

/** The words for a probe. Kept here rather than in the component so the
 *  phrasing is pinned by tests — this text is the entire product surface of
 *  the feature, and "4 commits" vs "1 commit" is exactly the kind of thing
 *  that rots silently. */
export function describe(p: SyncProbe): SyncPrompt {
  const base = baseLabel(p.base);
  const branch = p.branch ?? "this branch";
  const headline = `${base} has ${plural(p.behind, "new commit")}`;

  // Uncommitted edits to a file the merge needs: git will refuse before it
  // writes anything, so say so now instead of surfacing its error later.
  if (p.overlap.length > 0) {
    return {
      headline,
      detail:
        `You have uncommitted changes in ${plural(p.overlap.length, "file")} the incoming ` +
        `commits also touch. Commit or stash ${p.overlap.length === 1 ? "it" : "them"} and this can merge.`,
      files: p.overlap,
      canMerge: false,
      blockedReason: "uncommitted changes are in the way",
      mergeLabel: `Merge ${base}`,
      willConflict: p.state === "conflict",
    };
  }

  if (p.state === "conflict") {
    return {
      headline: `${headline} — ${plural(p.conflicts.length, "file")} would conflict`,
      detail:
        `Merging ${base} into ${branch} will stop on ${p.conflicts.length === 1 ? "this file" : "these files"} ` +
        `so you can resolve ${p.conflicts.length === 1 ? "it" : "them"}. Nothing has been changed yet — ` +
        `you can leave this until later and keep working.`,
      files: p.conflicts,
      canMerge: true,
      blockedReason: null,
      mergeLabel: "Merge and resolve now",
      willConflict: true,
    };
  }

  if (p.state === "unknown") {
    return {
      headline,
      detail:
        `This git is too old to check for conflicts up front (needs 2.38 or newer), ` +
        `so the merge may stop partway. It can be undone either way.`,
      files: [],
      canMerge: true,
      blockedReason: null,
      mergeLabel: `Merge ${base} in`,
      willConflict: false,
    };
  }

  return {
    headline,
    detail: `They merge into ${branch} cleanly. Your commits stay as they are.`,
    files: [],
    canMerge: true,
    blockedReason: null,
    mergeLabel: `Merge ${base} in`,
    willConflict: false,
  };
}

/** The one-liner after a merge attempt — success, or stopped-on-conflicts. */
export const outcomeMessage = (
  base: string,
  outcome: { merged: boolean; conflicts: string[]; message: string },
): string =>
  outcome.merged
    ? `Merged ${baseLabel(base)} — ${outcome.message}`
    : `Merge stopped on ${plural(outcome.conflicts.length, "conflicted file")}. Resolve them in Changes, or undo the merge.`;

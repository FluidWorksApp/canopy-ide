// The single place that reads a git porcelain status code.
//
// `git_status` (src-tauri/src/fsx.rs) runs `git status --porcelain -z
// --ignored` and returns every entry, unfiltered, with absolute paths. Two
// facts about that output drive everything in this module:
//
//  1. Ignored paths arrive coded `!!`. A consumer that counts entries as
//     "changes" counts node_modules/ and dist/, and reports every real project
//     as permanently dirty.
//  2. A tracked, unmodified file DOES NOT APPEAR AT ALL. Absence is therefore
//     not evidence about a file. Reading "absent" as "untracked" is the
//     fail-open direction, and it is the one that leaks: it is how a committed
//     `.env` came to be treated as safe to write a service-role key into.
//
// So this module answers two questions, and keeps them apart on purpose:
//
//   classifyStatus(code)  — what IS this entry? (question 1)
//   trackingFromStatus()  — is a file's state provable from the list at all?
//                           (question 2, and the one that caused the leak)
//
// Question 2 does not return a boolean. It can return "not proven", because
// for a path with no entry the list genuinely cannot distinguish "tracked and
// unmodified" from "does not exist". Only other evidence — a directory
// listing — settles that, and `trackedGivenExistence` is where that evidence
// is applied, explicitly, rather than guessed by each caller.
//
// This lives in shared/ so `src/` and `portal/src/` both reach it through the
// `@shared/*` alias. That is the whole point: the two bugs this consolidates
// against were both in portal/, which could not see the desktop's precedent
// and invented its own spelling of the ignore filter.

/** A row of `git_status`. `status` is git's raw two-column XY code. */
export interface GitStatusEntry {
  status: string;
  path: string;
}

/**
 * What an entry is, in the only three kinds that matter to a consumer.
 *
 *  - `ignored`    — git will never carry this. `!!`.
 *  - `untracked`  — git does not carry this yet. `??`.
 *  - `changed`    — git already carries this path, and it has a change.
 *
 * There is no fourth kind for "tracked and unmodified" because such a file
 * produces no entry. That absence is question 2's problem, not this one's.
 */
export type EntryKind = "ignored" | "untracked" | "changed";

export interface EntryClass {
  kind: EntryKind;
  /** git already carries this path — i.e. committing would publish it. */
  tracked: boolean;
  /** The index column (X) carries a change. */
  staged: boolean;
  /** The worktree column (Y) carries a change. */
  unstaged: boolean;
}

/**
 * Question 1: what is this entry?
 *
 * The order of the three branches is load-bearing. Ignored is tested first
 * because `!!` also satisfies the naive "X is neither space nor `?`" staged
 * test — which is exactly how ignored rows once landed under "Staged" in the
 * portal. Untracked is tested before the tracked fallthrough for the same
 * reason: `??` is a working-tree presence, never an index entry.
 *
 * Anything else is a code git only emits for a path it already carries, so the
 * fallthrough reports `tracked: true`. That is also the fail-CLOSED direction
 * for a code we do not recognise: treating an unknown code as untracked would
 * be a fresh way to say "safe to write secrets here".
 */
export function classifyStatus(code: string): EntryClass {
  const x = code[0] ?? " ";
  const y = code[1] ?? " ";
  if (x === "!" || y === "!") {
    return { kind: "ignored", tracked: false, staged: false, unstaged: false };
  }
  if (x === "?" || y === "?") {
    return { kind: "untracked", tracked: false, staged: false, unstaged: true };
  }
  return { kind: "changed", tracked: true, staged: x !== " ", unstaged: y !== " " };
}

/** `!!`, said once. Producers must NOT pre-filter these — shared/FileTree.tsx
 *  needs the ignored rows to paint its dimmed overlay. Filtering belongs to the
 *  consumer that is counting or listing *changes*. */
export function isIgnored(code: string): boolean {
  return classifyStatus(code).kind === "ignored";
}

/** True when the index column says this file has something staged. */
export function isStaged(code: string): boolean {
  return classifyStatus(code).staged;
}

/**
 * The entries that are actually changes: everything git will carry, ignored
 * rows dropped.
 *
 * Generic over the row so both the desktop's `ipc.GitStatusResult["entries"]`
 * and the portal's own `GitEntry` pass through with their identity intact.
 */
export function trackedChanges<T extends { status: string }>(entries: readonly T[]): T[] {
  return entries.filter((entry) => !isIgnored(entry.status));
}

// --- paths ------------------------------------------------------------------

/** Slashes forward, no trailing slash — git emits directory entries with one
 *  and callers pass roots with and without. */
export function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/$/, "");
}

/** An entry path as an absolute path. `git_status` resolves against the
 *  worktree top before returning, but the porcelain itself is repo-relative
 *  and a caller may hand us either, so anchor the relative case explicitly
 *  rather than comparing two different kinds of string. */
export function resolveEntryPath(entryPath: string, repoRoot: string): string {
  const path = normalizePath(entryPath);
  return /^(?:[A-Za-z]:\/|\/)/.test(path) ? path : `${normalizePath(repoRoot)}/${path}`;
}

/** Whether `path` is `dir` or lives under it. Prefix comparison on whole
 *  segments — `/repo/apps/web` must not swallow `/repo/apps/web-admin`. */
export function isWithin(path: string, dir: string): boolean {
  const p = normalizePath(path);
  const d = normalizePath(dir);
  return p === d || p.startsWith(`${d}/`);
}

// --- question 2 -------------------------------------------------------------

/**
 * What the entry list can prove about one file.
 *
 * `proven: false` is not a failure — it is the honest answer for a path no
 * entry mentions, which means EITHER "tracked and unmodified" OR "does not
 * exist". The status list alone cannot tell those apart. Deliberately not a
 * boolean: a boolean here forces every caller to invent an answer, and the
 * answer they invent is "untracked", which is the fail-open one.
 */
export type TrackingProof =
  | { proven: true; tracked: boolean; kind: EntryKind }
  | { proven: false; reason: "absent-from-status" };

/**
 * Question 2: is this file's tracked-ness provable from these entries?
 *
 * Anchored to a full path, never matched by basename. In a monorepo a basename
 * match finds the wrong file and fails open — see the callers' notes.
 */
export function trackingFromStatus(
  entries: readonly GitStatusEntry[],
  filePath: string,
  repoRoot: string,
): TrackingProof {
  const target = normalizePath(filePath);
  const match = entries.find((entry) => resolveEntryPath(entry.path, repoRoot) === target);
  if (!match) return { proven: false, reason: "absent-from-status" };
  const info = classifyStatus(match.status);
  return { proven: true, tracked: info.tracked, kind: info.kind };
}

/**
 * Settle an unproven verdict with the one piece of evidence that can settle
 * it: whether the file is on disk.
 *
 * Absent from status AND on disk means git is silent about a file that exists
 * — which is precisely the tracked-and-unmodified case, so it is tracked.
 * Absent from status and not on disk means there is no file yet, so there is
 * nothing for a commit to carry.
 *
 * Takes the proof rather than being folded into `trackingFromStatus` so the
 * extra evidence has to be produced and passed on purpose. A caller with no
 * directory listing cannot reach a confident boolean by accident.
 */
export function trackedGivenExistence(proof: TrackingProof, existsOnDisk: boolean): boolean {
  return proof.proven ? proof.tracked : existsOnDisk;
}

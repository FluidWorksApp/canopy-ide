/** How much of a diff is worth rendering up front.
 *
 *  Mounting every file of a multi-file patch, expanded and syntax-highlighted,
 *  is what froze a tab on anything large (a lockfile churn is tens of thousands
 *  of lines). PrView has always had a budget for it; the commit, branch and
 *  review tabs had none, so the same diff that painted instantly as a PR hung
 *  the window as a commit. The rule lives here, on its own, because all four
 *  read it and two numbers would eventually be two different answers.
 *
 *  Pure functions only — see PatchFileList.tsx for the list that renders under
 *  them. */

/** Whole-patch changed lines under which every file simply opens: cheap, and
 *  you want to read all of it. */
export const AUTO_EXPAND_TOTAL = 500;
/** Biggest single file opened on its own once the patch is past that. */
export const AUTO_EXPAND_FILE = 200;
/** Total lines auto-opened on a big patch, across all files. */
export const AUTO_EXPAND_BUDGET = 1200;
/** Syntax-highlight only files at or under this many changed lines. The
 *  highlight is the expensive half of rendering a diff. */
export const HIGHLIGHT_MAX = 800;

export interface PatchFileStats {
  additions: number;
  deletions: number;
  changed: number;
  binary: boolean;
}

/** Counts straight off the hunk lines. A PR arrives with these from the forge;
 *  a local patch does not, and that is the whole of the difference between the
 *  two callers. `+++`/`---` are the file headers, not content. */
export function patchStats(patch: string): PatchFileStats {
  let additions = 0;
  let deletions = 0;
  let binary = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
    else if (
      line.startsWith("Binary files ") ||
      line.startsWith("GIT binary patch")
    )
      binary = true;
  }
  return { additions, deletions, changed: additions + deletions, binary };
}

/** Which files open on mount: everything on a small patch, otherwise the small
 *  human-sized ones up to a budget, so lockfile-scale churn stays collapsed and
 *  the tab paints at once. Order is the patch's own — the budget is spent on
 *  what comes first, which is what makes it predictable.
 *
 *  Takes the three fields it actually decides on, so a PR file (which arrives
 *  with its counts) and a local patch (which had to be counted) are the same
 *  argument. */
export function autoExpanded(
  files: { path: string; changed: number; binary: boolean }[],
): Set<string> {
  const total = files.reduce((n, f) => n + f.changed, 0);
  if (total <= AUTO_EXPAND_TOTAL) return new Set(files.map((f) => f.path));
  const open = new Set<string>();
  let budget = AUTO_EXPAND_BUDGET;
  for (const f of files) {
    if (f.binary || f.changed > AUTO_EXPAND_FILE || budget - f.changed < 0)
      continue;
    open.add(f.path);
    budget -= f.changed;
  }
  return open;
}

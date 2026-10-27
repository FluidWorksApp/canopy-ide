// Did a pull request land, even when no commit subject says "#12"?
//
// A rebase merge replays the PR's commits onto the base with new ids and no
// PR number; a squash merge folds them into one commit whose subject can be
// edited to anything. What survives both is the change itself. So, like
// `git patch-id`, a change is fingerprinted by its content alone — per file,
// the added and removed lines, whitespace ignored, hunk positions and blob ids
// ignored — as a signed count: +1 for each added line, -1 for each removed.
//
// Signed counts make the comparison work for both merge styles: the PR's
// whole diff equals one squash commit's diff, and it equals the SUM of the
// rebased commits' diffs (a line added in one commit and removed in a later
// one cancels out, exactly as it does in the PR's combined diff). Matching is
// then: some run of consecutive commits on the base, after the PR was opened,
// whose summed fingerprint equals the PR's.

export type Fingerprint = Map<string, number>;

/** Lines that say nothing about the change. */
const SKIP = /^(?:index |old mode |new mode |similarity index |rename from |rename to |deleted file mode |new file mode |Binary files )/;

/** The content fingerprint of a unified diff. Empty for an empty diff. */
export function fingerprint(patch: string): Fingerprint {
  const out: Fingerprint = new Map();
  let file = "";
  for (const raw of patch.split("\n")) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (head) {
      file = head[2];
      continue;
    }
    if (!file || SKIP.test(raw) || raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("@@")) continue;
    const sign = raw[0] === "+" ? 1 : raw[0] === "-" ? -1 : 0;
    if (!sign) continue;
    const body = raw.slice(1).replace(/\s+/g, "");
    if (!body) continue;
    const key = `${file}\u0000${body}`;
    const n = (out.get(key) ?? 0) + sign;
    if (n === 0) out.delete(key);
    else out.set(key, n);
  }
  return out;
}

function addInto(into: Fingerprint, fp: Fingerprint): void {
  for (const [k, v] of fp) {
    const n = (into.get(k) ?? 0) + v;
    if (n === 0) into.delete(k);
    else into.set(k, n);
  }
}

export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  if (a.size !== b.size || a.size === 0) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** A stable string for a fingerprint, for caching it. */
export function fingerprintKey(fp: Fingerprint): string {
  return [...fp.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([k, v]) => `${v}:${k}`)
    .join("\n");
}

/** The longest run of rebased commits a PR is matched against. */
export const MAX_RUN = 30;

/** Find where `pr` landed among `commits` (oldest first, already limited to
 *  after the PR opened): the first commit of the first consecutive run whose
 *  summed fingerprint equals the PR's, and the last (the merge point). */
export function findLanding<C extends { fp: Fingerprint }>(
  pr: Fingerprint,
  commits: readonly C[],
  maxRun = MAX_RUN,
): { first: C; last: C } | null {
  if (!pr.size) return null;
  const prFiles = new Set([...pr.keys()].map((k) => k.slice(0, k.indexOf("\u0000"))));
  const touches = (c: C) => [...c.fp.keys()].some((k) => prFiles.has(k.slice(0, k.indexOf("\u0000"))));
  for (let i = 0; i < commits.length; i++) {
    // A run starts with a commit that touches the PR's files.
    if (!touches(commits[i])) continue;
    const sum: Fingerprint = new Map();
    for (let j = i; j < Math.min(commits.length, i + maxRun); j++) {
      addInto(sum, commits[j].fp);
      if (sameFingerprint(sum, pr)) return { first: commits[i], last: commits[j] };
    }
  }
  return null;
}

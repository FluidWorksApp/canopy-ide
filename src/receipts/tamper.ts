// Test-tamper detection: did the agent change what "passing" means?
//
// Agents under pressure to go green edit the test instead of the code: loosen
// an assertion, skip the case, delete the file (arXiv 2510.20270). A re-run
// that passes after that proves nothing, so the receipt looks at the turn's
// diff for test files and, inside them, at assertion lines that were removed
// or rewritten. Those are flagged "needs a human look" and cap the status
// below proven (status.ts). A turn that only *adds* tests is noted, not
// flagged: writing tests is what we want agents to do.
//
// Pure: a unified diff and a file list in, flags out.

import type { TamperFlag } from "./types";

const TEST_PATH: RegExp[] = [
  /(^|[\\/])(__tests__|__snapshots__|tests?|spec|specs|e2e)[\\/]/i,
  /\.(test|spec|e2e)\.[cm]?[jt]sx?$/i,
  /_test\.go$/,
  /(^|[\\/])test_[^\\/]*\.py$/,
  /_test\.py$/,
  /(^|[\\/])conftest\.py$/,
  /\.snap$/,
  /Tests?\.(cs|java|kt|swift)$/,
];

export function isTestFile(path: string): boolean {
  return TEST_PATH.some((re) => re.test(path));
}

/** Lines that state what must be true. Broad on purpose: a false positive
 *  costs a glance, a miss costs a fake green. */
const ASSERTION =
  /\b(expect|assert\w*|should|toBe\w*|toEqual|toStrictEqual|toMatch\w*|toHave\w*|toContain\w*|toThrow\w*|resolves|rejects|assert_eq!|assert_ne!|assert!|debug_assert\w*!|t\.(Error|Errorf|Fatal|Fatalf|Fail|FailNow)|require\.\w+|self\.assert\w+|pytest\.raises|XCTAssert\w*|Assert\.\w+)\b/;

/** Lines that switch a test off. */
const DISABLE =
  /\b(it|test|describe|context)\.(skip|todo)\s*\(|\bx(it|test|describe)\s*\(|@pytest\.mark\.(skip|xfail)|@unittest\.skip|#\[ignore\]|\bt\.Skip(Now|f)?\s*\(|@Disabled\b|@Ignore\b|\.only\s*\(/;

export interface FileDiff {
  path: string;
  added: string[];
  removed: string[];
  /** New file / deleted file per the diff header. */
  created: boolean;
  deleted: boolean;
}

/** Split a unified `git diff` into per-file added/removed lines. */
export function parseUnifiedDiff(patch: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(line);
      cur = { path: m ? m[1] : line.slice(11), added: [], removed: [], created: false, deleted: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) cur.created = true;
    else if (line.startsWith("deleted file mode")) cur.deleted = true;
    else if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      // `+++ b/path` names renames correctly; `/dev/null` keeps the old name.
      const m = /^\+\+\+ b\/(.+)$/.exec(line);
      if (m) cur.path = m[1];
    } else if (line.startsWith("+")) cur.added.push(line.slice(1));
    else if (line.startsWith("-")) cur.removed.push(line.slice(1));
  }
  return files;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** A path from the journal (absolute or relative) matches a diff path
 *  (relative to the repo) when one ends with the other. */
function samePath(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

const sample = (lines: string[], sign: "+" | "-", n = 3) =>
  lines.slice(0, n).map((l) => `${sign} ${l.trim().slice(0, 160)}`);

/** Flags for every test file the turn changed. `touched` is the agent's own
 *  journal plus anything the diff showed changed during the turn. */
export function detectTamper(touched: readonly string[], diffs: readonly FileDiff[]): TamperFlag[] {
  const flags: TamperFlag[] = [];
  const seen = new Set<string>();
  for (const d of diffs) {
    if (!isTestFile(d.path)) continue;
    seen.add(norm(d.path));
    const removedAsserts = d.removed.filter((l) => ASSERTION.test(l));
    const addedAsserts = d.added.filter((l) => ASSERTION.test(l));
    const disabled = d.added.filter((l) => DISABLE.test(l));
    if (d.deleted) {
      flags.push({
        path: d.path,
        severity: "review",
        reason: "test-deleted",
        detail: `Test file deleted${removedAsserts.length ? ` (${removedAsserts.length} assertion${removedAsserts.length === 1 ? "" : "s"} gone)` : ""}.`,
        lines: sample(removedAsserts, "-"),
      });
    } else if (disabled.length) {
      flags.push({
        path: d.path,
        severity: "review",
        reason: "test-disabled",
        detail: `A test was switched off or narrowed (${disabled.length} line${disabled.length === 1 ? "" : "s"}).`,
        lines: sample(disabled, "+"),
      });
    } else if (removedAsserts.length) {
      flags.push({
        path: d.path,
        severity: "review",
        reason: "assertions-changed",
        detail: `${removedAsserts.length} assertion${removedAsserts.length === 1 ? " was" : "s were"} removed or rewritten${addedAsserts.length ? `, ${addedAsserts.length} written in their place` : ""}.`,
        lines: [...sample(removedAsserts, "-"), ...sample(addedAsserts, "+")],
      });
    } else if (d.created || addedAsserts.length) {
      flags.push({
        path: d.path,
        severity: "note",
        reason: "tests-added",
        detail: d.created ? "New test file — no existing assertion changed." : `${addedAsserts.length} assertion${addedAsserts.length === 1 ? "" : "s"} added, none removed.`,
        lines: sample(addedAsserts, "+"),
      });
    } else {
      flags.push({
        path: d.path,
        severity: "note",
        reason: "test-file-touched",
        detail: "Test file edited without changing any assertion.",
        lines: [],
      });
    }
  }
  // A test file the agent's journal names but the diff does not show (the
  // diff was capped, or the edit was reverted within the turn) is still worth
  // naming.
  for (const t of touched) {
    if (!isTestFile(t) || [...seen].some((s) => samePath(t, s))) continue;
    seen.add(norm(t));
    flags.push({ path: t, severity: "note", reason: "test-file-touched", detail: "The agent edited this test file this turn.", lines: [] });
  }
  return flags;
}

export const tampered = (flags: readonly TamperFlag[]) => flags.some((f) => f.severity === "review");

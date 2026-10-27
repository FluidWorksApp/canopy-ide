// Reading a check's raw output into counts and an outcome.
//
// The rule the whole feature rests on: an exit code alone is not evidence.
// `go test ./...` in a module with no tests exits 0; jest with
// --passWithNoTests exits 0; a suite filtered to nothing is "green". So a test
// check is a pass only when the runner says it ran at least one test and none
// failed. A run killed at the time limit is "timed out" — practitioner audits
// found evidence checkers calling those failures, which accuses code that was
// never shown to be wrong.
//
// Pure: strings in, facts out.

import type { CheckCounts, CheckKind, CheckOutcome, CheckRunner } from "./types";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "").replace(/\r\n?/g, "\n");
}

export interface ParsedOutput {
  runner: CheckRunner;
  counts: CheckCounts | null;
  /** The runner said, in words, that it found nothing to run. */
  zeroTests: boolean;
  failures: string[];
}

const num = (s: string | undefined) => (s ? Number.parseInt(s, 10) || 0 : 0);

/** Every "N word" pair in a summary line: "1 failed | 11 passed (12)". */
function tally(line: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of line.matchAll(/(\d+)\s+(passed|failed|skipped|todo|pending|total|errors?|xfailed|xpassed|deselected|warnings?)/g)) {
    out[m[2]] = (out[m[2]] ?? 0) + num(m[1]);
  }
  return out;
}

function counts(passed: number, failed: number, skipped: number, total?: number, unit: CheckCounts["unit"] = "tests"): CheckCounts {
  return { passed, failed, skipped, total: total ?? passed + failed + skipped, unit };
}

function uniq(list: string[], max = 20): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))].slice(0, max);
}

function vitest(text: string): ParsedOutput | null {
  if (/No test files found/i.test(text))
    return { runner: "vitest", counts: counts(0, 0, 0), zeroTests: true, failures: [] };
  // "      Tests  1 failed | 11 passed (12)" — the "Test Files" line also
  // matches /Tests/, so anchor on the word alone.
  const line = text.split("\n").reverse().find((l) => /^\s*Tests\s+\d/.test(l));
  if (!line) return null;
  const t = tally(line);
  const total = /\((\d+)\)/.exec(line);
  const failures = [...text.matchAll(/^\s*(?:FAIL|×|✗)\s+(.+?)(?:\s+\d+ms)?$/gm)].map((m) => m[1]);
  return {
    runner: "vitest",
    counts: counts(t.passed ?? 0, t.failed ?? 0, (t.skipped ?? 0) + (t.todo ?? 0), total ? num(total[1]) : undefined),
    zeroTests: (total ? num(total[1]) : (t.passed ?? 0) + (t.failed ?? 0)) === 0,
    failures: uniq(failures),
  };
}

function jest(text: string): ParsedOutput | null {
  if (/No tests found/i.test(text))
    return { runner: "jest", counts: counts(0, 0, 0), zeroTests: true, failures: [] };
  // "Tests:       1 failed, 2 skipped, 11 passed, 14 total"
  const line = text.split("\n").reverse().find((l) => /^\s*Tests:\s+\d/.test(l));
  if (!line) return null;
  const t = tally(line);
  const failures = [...text.matchAll(/^\s*●\s+(.+?)\s*$/gm)].map((m) => m[1]).filter((f) => !/Console/.test(f));
  return {
    runner: "jest",
    counts: counts(t.passed ?? 0, t.failed ?? 0, (t.skipped ?? 0) + (t.todo ?? 0) + (t.pending ?? 0), t.total),
    zeroTests: (t.total ?? 0) === 0,
    failures: uniq(failures),
  };
}

function mocha(text: string): ParsedOutput | null {
  const passing = /^\s*(\d+) passing/m.exec(text);
  if (!passing) return null;
  const failing = /^\s*(\d+) failing/m.exec(text);
  const pending = /^\s*(\d+) pending/m.exec(text);
  const c = counts(num(passing[1]), num(failing?.[1]), num(pending?.[1]));
  return { runner: "mocha", counts: c, zeroTests: c.total === 0, failures: [] };
}

function cargo(text: string): ParsedOutput | null {
  // One "test result:" per test binary (unit, each integration file, doc
  // tests) — sum them. A crate whose every binary says "running 0 tests"
  // has no tests at all.
  const lines = [...text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  if (!lines.length) return null;
  let passed = 0, failed = 0, skipped = 0;
  for (const m of lines) {
    passed += num(m[1]);
    failed += num(m[2]);
    skipped += num(m[3]);
  }
  const failures = [...text.matchAll(/^test (\S+) \.\.\. FAILED$/gm)].map((m) => m[1]);
  return { runner: "cargo", counts: counts(passed, failed, skipped), zeroTests: passed + failed === 0, failures: uniq(failures) };
}

function pytest(text: string): ParsedOutput | null {
  if (/\bno tests ran\b/i.test(text) || /collected 0 items/.test(text))
    return { runner: "pytest", counts: counts(0, 0, 0), zeroTests: true, failures: [] };
  // "===== 3 failed, 10 passed, 1 skipped in 0.12s =====" (or the -q form
  // without the rules).
  const line = text.split("\n").reverse().find((l) => /\d+ (passed|failed|error)/.test(l) && /\bin [\d.]+s\b/.test(l));
  if (!line) return null;
  const t = tally(line);
  const failed = (t.failed ?? 0) + (t.error ?? 0) + (t.errors ?? 0);
  const failures = [...text.matchAll(/^(?:FAILED|ERROR) (\S+)/gm)].map((m) => m[1]);
  return {
    runner: "pytest",
    counts: counts((t.passed ?? 0) + (t.xpassed ?? 0), failed, (t.skipped ?? 0) + (t.xfailed ?? 0) + (t.deselected ?? 0)),
    zeroTests: (t.passed ?? 0) + failed === 0,
    failures: uniq(failures),
  };
}

function go(text: string): ParsedOutput | null {
  const ok = [...text.matchAll(/^ok\s+\S+\s+(.*)$/gm)];
  const fail = [...text.matchAll(/^FAIL\s+(\S+)\s/gm)];
  const none = [...text.matchAll(/^\?\s+\S+\s+\[no test files\]/gm)];
  if (!ok.length && !fail.length && !none.length) return null;
  const failures = [...text.matchAll(/^\s*--- FAIL: (\S+)/gm)].map((m) => m[1]);
  // `ok pkg 0.01s [no tests to run]` ran nothing either.
  const empty = ok.filter((m) => /\[no tests to run\]/.test(m[1])).length;
  // Per-test counts only exist under -v; fall back to packages.
  const passTests = [...text.matchAll(/^\s*--- PASS: /gm)].length;
  const skipTests = [...text.matchAll(/^\s*--- SKIP: /gm)].length;
  const c =
    passTests + failures.length > 0
      ? counts(passTests, failures.length, skipTests)
      : counts(ok.length - empty, fail.length, none.length + empty, undefined, "packages");
  return { runner: "go", counts: c, zeroTests: ok.length - empty + fail.length === 0, failures: uniq(failures) };
}

const PARSERS: Record<Exclude<CheckRunner, "unknown">, (t: string) => ParsedOutput | null> = {
  vitest,
  jest,
  mocha,
  cargo,
  pytest,
  go,
};

/** Read counts from a check's output. `hint` (from detection) is tried
 *  first; otherwise every dialect is tried, most distinctive first. */
export function parseOutput(raw: string, hint?: CheckRunner): ParsedOutput {
  const text = stripAnsi(raw);
  const order: Exclude<CheckRunner, "unknown">[] = ["cargo", "go", "pytest", "vitest", "jest", "mocha"];
  if (hint && hint !== "unknown") order.unshift(hint);
  for (const name of order) {
    const parsed = PARSERS[name](text);
    if (parsed) return parsed;
  }
  return { runner: "unknown", counts: null, zeroTests: false, failures: [] };
}

export interface ClassifyInput {
  kind: CheckKind;
  exitCode: number | null;
  timedOut: boolean;
  spawnError: string | null;
  parsed: ParsedOutput;
  /** What detection expected, for exit codes with a runner-specific meaning. */
  runner?: CheckRunner;
}

/** The outcome, from the exit code *and* what the runner said. */
export function classify({ kind, exitCode, timedOut, spawnError, parsed, runner }: ClassifyInput): CheckOutcome {
  if (spawnError) return "not-run";
  if (timedOut) return "timed-out";
  // pytest's own code for "collected nothing".
  if (kind === "test" && (runner === "pytest" || parsed.runner === "pytest") && exitCode === 5) return "no-tests";
  if (kind === "test" && parsed.zeroTests) return "no-tests";
  if (exitCode !== 0) return "failed";
  if (parsed.counts && parsed.counts.failed > 0) return "failed";
  return "passed";
}

/** The last `lines` lines of output, for the receipt and the brain. */
export function tail(text: string, lines = 60, maxChars = 4000): string {
  const kept = stripAnsi(text).trimEnd().split("\n").slice(-lines).join("\n");
  return kept.length > maxChars ? `…${kept.slice(-maxChars)}` : kept;
}

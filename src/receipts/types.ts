// Proof receipts: what the workspace — never the agent — verified about a turn.
//
// The principle (reports/"Agent native workspace rethink" §2): the producer of
// the work never produces its evidence. An agent's final message is a claim;
// a receipt is the workspace re-running the project's checks in a process the
// agent does not own, looking for tests the agent edited and packages it
// invented, then asking the brain to judge the request against that raw
// evidence. The brain never sets the status alone (see status.ts).
//
// The receipt is a ledger entry of kind "receipt"; `ReceiptData` is its `data`.

/** What a check is for; decides whether "ran zero tests" is a problem. */
export type CheckKind = "test" | "typecheck" | "lint" | "build" | "check";

/** Output dialects we can read counts from. */
export type CheckRunner = "vitest" | "jest" | "mocha" | "cargo" | "pytest" | "go" | "unknown";

/** One command the workspace will run. */
export interface CheckSpec {
  id: string;
  label: string;
  kind: CheckKind;
  argv: string[];
  /** Where it came from: a manifest, or the person's own override. */
  source: "package.json" | "Cargo.toml" | "go.mod" | "pytest" | "Makefile" | "custom";
  runner?: CheckRunner;
}

/** passed: exit 0 with real evidence. failed: non-zero exit. no-tests: a
 *  test command that ran nothing (a green zero is not a pass). timed-out:
 *  killed at the limit — said as such, never "failed". not-run: could not
 *  start (not installed). */
export type CheckOutcome = "passed" | "failed" | "no-tests" | "timed-out" | "not-run";

export interface CheckCounts {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  /** go without -v reports per package, not per test. */
  unit: "tests" | "packages";
}

export interface CheckResult {
  id: string;
  label: string;
  kind: CheckKind;
  command: string;
  exitCode: number | null;
  outcome: CheckOutcome;
  counts: CheckCounts | null;
  durationMs: number;
  /** Last lines of combined output, ANSI stripped — the raw evidence. */
  outputTail: string;
  /** Names of failing tests when the runner printed them. */
  failures: string[];
  note?: string;
}

/** review: a human should look (assertions removed or changed, a test
 *  disabled or deleted). note: the agent touched tests but only added. */
export interface TamperFlag {
  path: string;
  severity: "review" | "note";
  reason:
    | "assertions-changed"
    | "test-disabled"
    | "test-deleted"
    | "test-file-touched"
    | "tests-added";
  detail: string;
  /** A few of the changed assertion lines, prefixed +/-. */
  lines: string[];
}

export type PackageEcosystem = "npm" | "crates" | "pypi";

export interface PackageCheck {
  ecosystem: PackageEcosystem;
  name: string;
  /** exists: the registry knows it. unknown: the registry said 404 — likely
   *  invented. unchecked: no answer (offline, timeout, no curl). */
  status: "exists" | "unknown" | "unchecked";
  manifest: string;
}

export type BrainVerdictKind = "proven" | "partial" | "unproven" | "contradicted";

export interface BrainVerdict {
  verdict: BrainVerdictKind;
  asked: string;
  did: string;
  evidence: string[];
  gaps: string[];
}

/** What the person sees. tests-changed outranks proven/partial because a pass
 *  means nothing once the agent rewrote what passing means. */
export type ReceiptStatus =
  | "proven"
  | "partial"
  | "unproven"
  | "contradicted"
  | "tests-changed";

export interface ReceiptData {
  v: 1;
  trigger: "turn-end" | "manual";
  turnId?: string;
  sessionId: string;
  ptyId: number | null;
  cli: string;
  cwd: string;
  branch: string | null;
  /** The person's request for the turn (capped). */
  asked: string;
  /** The agent's own last message, when its hooks carry one (capped). */
  claim?: string;
  filesTouched: string[];
  /** What the diff was taken against: the turn's start snapshot or HEAD. */
  base: string;
  checks: CheckResult[];
  tamper: TamperFlag[];
  packages: PackageCheck[];
  verdict: BrainVerdict | null;
  /** Why there is no verdict (no brain, over budget, …), in plain words. */
  brainNote?: string;
  /** The workspace's own ceiling and why — independent of the brain. */
  ceiling: Exclude<ReceiptStatus, "tests-changed">;
  reasons: string[];
  status: ReceiptStatus;
  costUsd: number | null;
  startedAt: number;
  endedAt: number;
}

/** A stored receipt: the ledger entry's id and time with its data. */
export interface ReceiptRecord extends ReceiptData {
  id: string;
  ts: number;
  root: string;
}

// The status rule: the workspace sets a ceiling from what it ran itself; the
// brain's verdict can only lower it.
//
// Ungrounded LLM judges are noisy and over-correct (arXiv 2507.10535), so the
// brain judges *against* the raw evidence and never decides alone:
//
//   * any failing check                          → ceiling "unproven"
//   * zero tests, a timeout, a check that could
//     not start, an unknown package, or no checks
//     at all                                     → ceiling "partial"
//   * otherwise (≥1 check, all passed)           → ceiling "proven"
//
// final = the lower of ceiling and verdict (proven > partial > unproven >
// contradicted). With no verdict (no brain, over budget) the final is capped
// at "partial": passing checks show the code holds together, not that it does
// what was asked. A "review" tamper flag then turns proven/partial into
// "tests-changed": a pass means nothing once the agent rewrote the test.

import type { BrainVerdictKind, CheckResult, PackageCheck, ReceiptStatus, TamperFlag } from "./types";
import { tampered } from "./tamper";

type Level = Exclude<ReceiptStatus, "tests-changed">;
const RANK: Record<Level, number> = { contradicted: 0, unproven: 1, partial: 2, proven: 3 };
const lower = (a: Level, b: Level): Level => (RANK[a] <= RANK[b] ? a : b);

export interface Ceiling {
  ceiling: Level;
  reasons: string[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function workspaceCeiling(checks: readonly CheckResult[], packages: readonly PackageCheck[]): Ceiling {
  const reasons: string[] = [];
  let ceiling: Level = "proven";
  const failed = checks.filter((c) => c.outcome === "failed");
  const empty = checks.filter((c) => c.outcome === "no-tests");
  const slow = checks.filter((c) => c.outcome === "timed-out");
  const missing = checks.filter((c) => c.outcome === "not-run");
  const unknown = packages.filter((p) => p.status === "unknown");
  if (!checks.length) {
    ceiling = "partial";
    reasons.push("No checks were found to run for this project.");
  } else if (missing.length === checks.length) {
    ceiling = "partial";
    reasons.push("None of the checks could be started on this machine.");
  }
  if (failed.length) {
    ceiling = lower(ceiling, "unproven");
    reasons.push(`${plural(failed.length, "check")} failed: ${failed.map((c) => c.label).join(", ")}.`);
  }
  if (empty.length) {
    ceiling = lower(ceiling, "partial");
    reasons.push(`${empty.map((c) => c.label).join(", ")} ran zero tests — a green run with nothing in it.`);
  }
  if (slow.length) {
    ceiling = lower(ceiling, "partial");
    reasons.push(`${slow.map((c) => c.label).join(", ")} timed out (not counted as a failure).`);
  }
  if (missing.length && missing.length < checks.length) {
    ceiling = lower(ceiling, "partial");
    reasons.push(`${missing.map((c) => c.label).join(", ")} could not be started.`);
  }
  if (unknown.length) {
    ceiling = lower(ceiling, "partial");
    reasons.push(`Unknown ${unknown.length === 1 ? "package" : "packages"}: ${unknown.map((p) => p.name).join(", ")}.`);
  }
  if (ceiling === "proven") reasons.push(`${plural(checks.length, "check")} passed.`);
  return { ceiling, reasons };
}

export function combineStatus(
  ceiling: Level,
  verdict: BrainVerdictKind | null,
  flags: readonly TamperFlag[],
): ReceiptStatus {
  let level = verdict ? lower(ceiling, verdict) : lower(ceiling, "partial");
  // "contradicted" is the brain saying the evidence shows the opposite of the
  // claim; that stands whatever the ceiling.
  if (verdict === "contradicted") level = "contradicted";
  if (tampered(flags) && (level === "proven" || level === "partial")) return "tests-changed";
  return level;
}

export const STATUS_META: Record<ReceiptStatus | "verifying" | "unverified", { icon: string; label: string; cls: string }> = {
  proven: { icon: "✓", label: "Proven", cls: "rc-proven" },
  partial: { icon: "◐", label: "Partial", cls: "rc-partial" },
  unproven: { icon: "✗", label: "Unproven", cls: "rc-unproven" },
  contradicted: { icon: "✗", label: "Contradicted", cls: "rc-unproven" },
  "tests-changed": { icon: "⚠", label: "Tests changed", cls: "rc-tamper" },
  verifying: { icon: "…", label: "Verifying", cls: "rc-verifying" },
  unverified: { icon: "—", label: "Unverified", cls: "rc-unverified" },
};

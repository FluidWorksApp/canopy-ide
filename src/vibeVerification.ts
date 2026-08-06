// The verification ledger's decision logic — what counts as evidence and what
// the evidence adds up to. Pure on purpose (plan 0109, "Browser and
// verification"): the impure half that runs checks, drives the preview and
// takes screenshots feeds observations in; this module only judges them.
//
// The one rule everything here serves: an agent's own claim of success is a
// declaration, not evidence. `job_done` STARTS verification; only independent
// observations move the verdict, and an absent observation is `unknown`,
// never a quiet pass.

export type ObservationKind =
  | "check" // a configured check command (typecheck, tests) ran
  | "server" // the dev server answered a real navigation
  | "console" // browser console scanned for errors
  | "network" // failed requests and perf outliers
  | "screenshot"; // a capture exists for visual work

export type ObservationVerdict = "pass" | "fail" | "unknown";

export interface VerificationObservation {
  kind: ObservationKind;
  verdict: ObservationVerdict;
  /** What was seen, in words a non-coder can read in the ledger. */
  note: string;
  /** Where the evidence lives (log excerpt path, screenshot path, url). */
  evidence?: string | null;
  at: number;
}

/** What one attempt must show before "done" may be believed. Derived from the
 *  envelope's verify contract; `screenshot` joins only for visual work. */
export interface VerificationContract {
  required: ObservationKind[];
}

export type VerificationOutcome = "verified" | "failed" | "incomplete";

export interface VerificationVerdict {
  outcome: VerificationOutcome;
  /** Required kinds with no observation at all — the "unknown is not a pass"
   *  list, named so the surface can say what was never checked. */
  missing: ObservationKind[];
  /** Failing observations, worst evidence first for the incident bundle. */
  failures: VerificationObservation[];
}

/** Judge a contract against what was actually observed. Latest observation
 *  per kind wins — a re-run check supersedes its earlier failure — but only
 *  an explicit pass supersedes: `unknown` never overwrites a fail. */
export function judgeVerification(
  contract: VerificationContract,
  observations: VerificationObservation[],
): VerificationVerdict {
  const latest = new Map<ObservationKind, VerificationObservation>();
  for (const o of [...observations].sort((a, b) => a.at - b.at)) {
    const held = latest.get(o.kind);
    if (held && held.verdict === "fail" && o.verdict === "unknown") continue;
    latest.set(o.kind, o);
  }

  const missing = contract.required.filter((k) => !latest.has(k));
  const failures = contract.required
    .map((k) => latest.get(k))
    .filter((o): o is VerificationObservation => o?.verdict === "fail");

  if (failures.length > 0) return { outcome: "failed", missing, failures };
  const allPassed =
    missing.length === 0 &&
    contract.required.every((k) => latest.get(k)?.verdict === "pass");
  return { outcome: allPassed ? "verified" : "incomplete", missing, failures };
}

/** A slow or oversized response is evidence too (program requirement:
 *  perf rides the same ledger). Thresholds are deliberately loose — this
 *  flags the outlier a person would notice, not a budget regression suite. */
export interface NetworkSample {
  url: string;
  ms: number;
  bytes: number;
  failed: boolean;
}

export const PERF_LIMITS = { slowMs: 3_000, heavyBytes: 5_000_000 };

export function networkObservation(
  samples: NetworkSample[],
  at: number,
  limits = PERF_LIMITS,
): VerificationObservation {
  const failed = samples.filter((s) => s.failed);
  const slow = samples.filter((s) => !s.failed && s.ms >= limits.slowMs);
  const heavy = samples.filter((s) => !s.failed && s.bytes >= limits.heavyBytes);
  if (failed.length > 0) {
    return {
      kind: "network",
      verdict: "fail",
      note: `${failed.length} request${failed.length === 1 ? "" : "s"} failed (first: ${failed[0].url})`,
      at,
    };
  }
  if (slow.length > 0 || heavy.length > 0) {
    const worst = slow[0] ?? heavy[0];
    return {
      kind: "network",
      verdict: "pass",
      note: `working, but ${slow.length + heavy.length} outlier${slow.length + heavy.length === 1 ? "" : "s"} worth a look (${worst.url}: ${worst.ms}ms, ${Math.round(worst.bytes / 1024)}KB)`,
      at,
    };
  }
  return { kind: "network", verdict: "pass", note: "no failed requests, no outliers", at };
}

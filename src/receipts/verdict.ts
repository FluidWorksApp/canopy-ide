// The brain's half of a receipt: compare what was asked with what the raw
// evidence shows was done.
//
// The brain gets everything in the prompt — the request, the agent's own
// claim, a capped diff summary and each check's exit code, counts and output
// tail — and is told the workspace already ran the checks. It is a judge of
// evidence, not a second agent: it must not take the agent's word, and its
// verdict can only lower the workspace's ceiling (status.ts).

import type { AcceptanceResult, BrainVerdict, CheckResult, PackageCheck, ReceiptPreview, TamperFlag } from "./types";

export const DIFF_SUMMARY_MAX = 8000;
const OUTPUT_PER_CHECK = 2500;
const VERDICTS = ["proven", "partial", "unproven", "contradicted"] as const;

export interface VerdictInput {
  asked: string;
  claim?: string;
  diffSummary: string;
  filesTouched: string[];
  checks: CheckResult[];
  tamper: TamperFlag[];
  packages: PackageCheck[];
  /** The preview before and after the turn, when one was open. */
  preview?: ReceiptPreview | null;
  /** The linked plan's acceptance checks, when the run carried a plan. */
  acceptance?: string[];
}

export const ACCEPTANCE_MAX = 8;

/** The plan's acceptance checks as the brain reads them, numbered. */
function acceptanceBlock(items: string[] | undefined): string[] {
  if (!items?.length) return [];
  return [
    "",
    "## The plan's acceptance checks (what the person agreed counts as done)",
    ...items.slice(0, ACCEPTANCE_MAX).map((a, i) => `${i + 1}. ${a}`),
  ];
}

/** The preview evidence as the brain reads it: what the workspace saw on the
 *  page, in words (the brain's CLI takes no images). */
export function previewBlock(p: ReceiptPreview | null | undefined): string[] {
  if (!p) return [];
  return [
    "",
    "## The preview page (the workspace photographed and read it itself)",
    p.summary,
    ...p.changes.map((c) => `- ${c}`),
    ...(p.note ? [`(${p.note})`] : []),
    "If the request is about something people see, weigh this: a page that reads the same before and after is not evidence of a visible change.",
  ];
}

function checkBlock(c: CheckResult): string {
  const counts = c.counts
    ? `${c.counts.passed} passed, ${c.counts.failed} failed, ${c.counts.skipped} skipped (${c.counts.unit})`
    : "no counts parsed";
  const out = c.outputTail.length > OUTPUT_PER_CHECK ? `…${c.outputTail.slice(-OUTPUT_PER_CHECK)}` : c.outputTail;
  return [
    `### ${c.label} — \`${c.command}\``,
    `outcome: ${c.outcome}; exit code: ${c.exitCode ?? "none"}; ${counts}; ${Math.round(c.durationMs / 1000)}s`,
    c.failures.length ? `failing: ${c.failures.join(", ")}` : "",
    "```",
    out || "(no output)",
    "```",
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildVerdictPrompt(i: VerdictInput): string {
  const diff =
    i.diffSummary.length > DIFF_SUMMARY_MAX
      ? `${i.diffSummary.slice(0, DIFF_SUMMARY_MAX)}\n… (diff truncated)`
      : i.diffSummary;
  return [
    "You are auditing a coding agent's turn for a proof receipt. The workspace — not the agent — re-ran the project's checks in its own process; their raw results are below. Judge ONLY from this evidence. The agent's claim is not evidence.",
    "",
    "## What the person asked",
    i.asked.trim() || "(the request was not captured)",
    "",
    "## What the agent says it did (a claim, not evidence)",
    i.claim?.trim() || "(no claim captured)",
    "",
    `## Files changed this turn (${i.filesTouched.length})`,
    i.filesTouched.slice(0, 60).join("\n") || "(none)",
    "",
    "## Diff (capped)",
    "```diff",
    diff || "(empty)",
    "```",
    "",
    "## Checks the workspace ran",
    i.checks.length ? i.checks.map(checkBlock).join("\n\n") : "No checks were found for this project.",
    "",
    "## Tests the agent changed",
    i.tamper.length ? i.tamper.map((t) => `- ${t.path}: ${t.detail}${t.lines.length ? `\n  ${t.lines.join("\n  ")}` : ""}`).join("\n") : "None.",
    "",
    "## New dependencies",
    i.packages.length ? i.packages.map((p) => `- ${p.name} (${p.ecosystem}): ${p.status}`).join("\n") : "None.",
    ...previewBlock(i.preview),
    ...acceptanceBlock(i.acceptance),
    "",
    "## Your verdict",
    i.acceptance?.length
      ? 'Reply with ONE JSON object and nothing else: {"verdict":"proven"|"partial"|"unproven"|"contradicted","asked":string,"did":string,"evidence":string[],"gaps":string[],"acceptance":[{"item":number,"met":true|false|null,"evidence":string}]}'
      : 'Reply with ONE JSON object and nothing else: {"verdict":"proven"|"partial"|"unproven"|"contradicted","asked":string,"did":string,"evidence":string[],"gaps":string[]}',
    ...(i.acceptance?.length
      ? [
          "- acceptance: one entry per numbered acceptance check, `item` its number. met: true only when a specific check result or diff fact above shows it; false when the evidence shows it is not done; null when nothing above says either way. evidence: the specific result or fact, in one short sentence.",
          "- proven requires every acceptance check met.",
        ]
      : []),
    "- proven: the diff does what was asked AND passing checks actually exercise it.",
    "- partial: some of the request is done or evidenced, or the checks do not cover the change.",
    "- unproven: the evidence does not show the request was done (failing checks, nothing relevant tested).",
    "- contradicted: the evidence shows the opposite of the agent's claim (e.g. it says tests pass; they fail).",
    "- asked: the request in one plain sentence. did: what the diff actually does, one or two plain sentences.",
    "- evidence: short items, each citing a specific check result, count or diff fact. gaps: what is unverified or missing.",
    "Write for a non-engineer. Do not repeat the instructions.",
  ].join("\n");
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const list = (v: unknown, n: number, max: number) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, n).map((x) => x.trim().slice(0, max)) : [];

/** The brain's acceptance answers matched back to the plan's own wording, in
 *  the plan's order; a check it skipped is "not shown either way". */
export function readAcceptance(v: unknown, items: string[]): AcceptanceResult[] {
  const rows = Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
  return items.slice(0, ACCEPTANCE_MAX).map((item, i) => {
    const hit = rows.find((r) => Number(r.item) === i + 1) ?? rows.find((r) => typeof r.item === "string" && r.item.trim() === item.trim());
    const met = hit?.met === true ? true : hit?.met === false ? false : null;
    return { item, met, evidence: str(hit?.evidence, 300) || (hit ? "" : "The brain did not report on this check.") };
  });
}

/** A validator for a run whose plan lists these acceptance checks. A verdict
 *  of "proven" with any check unmet or unshown is read as "partial": proven
 *  means every agreed check is evidenced. */
export function validateVerdictFor(items: string[] | undefined): (v: unknown) => BrainVerdict | null {
  if (!items?.length) return validateVerdict;
  return (v) => {
    const base = validateVerdict(v);
    if (!base) return null;
    const acceptance = readAcceptance((v as Record<string, unknown>).acceptance, items);
    const verdict = base.verdict === "proven" && acceptance.some((a) => a.met !== true) ? "partial" : base.verdict;
    return { ...base, verdict, acceptance };
  };
}

/** askBrain's `validate`: a well-formed verdict, clipped, or null. */
export function validateVerdict(v: unknown): BrainVerdict | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const verdict = typeof o.verdict === "string" ? o.verdict.trim().toLowerCase() : "";
  if (!(VERDICTS as readonly string[]).includes(verdict)) return null;
  const asked = str(o.asked, 500);
  const did = str(o.did, 800);
  if (!did) return null;
  return {
    verdict: verdict as BrainVerdict["verdict"],
    asked,
    did,
    evidence: list(o.evidence, 8, 300),
    gaps: list(o.gaps, 8, 300),
  };
}

/** Why there is no verdict, in the receipt's words. */
export function brainNote(reason: string): string {
  switch (reason) {
    case "no-brain":
      return "No brain connected — checks only, not compared with the request.";
    case "over-budget":
      return "Brain budget reached for today — checks only.";
    case "signed-out":
      return "The brain CLI is signed out — checks only.";
    case "rate-limited":
      return "The brain is rate-limited right now — checks only.";
    case "timeout":
      return "The brain took too long to answer — checks only.";
    case "invalid-output":
      return "The brain's answer could not be read — checks only.";
    default:
      return "The brain could not be asked — checks only.";
  }
}

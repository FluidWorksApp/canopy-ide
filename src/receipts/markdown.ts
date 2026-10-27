// Receipts travel: as markdown for a PR or a chat, as one line for a PTY
// brief, as a short factual message back to the agent.

import { STATUS_META } from "./status";
import type { CheckResult, ReceiptData } from "./types";

const OUTCOME: Record<CheckResult["outcome"], string> = {
  passed: "passed",
  failed: "failed",
  "no-tests": "ran zero tests",
  "timed-out": "timed out",
  "not-run": "could not start",
};

export function checkLine(c: CheckResult): string {
  const counts = c.counts
    ? ` — ${c.counts.passed} passed${c.counts.failed ? `, ${c.counts.failed} failed` : ""}${c.counts.skipped ? `, ${c.counts.skipped} skipped` : ""}${c.counts.unit === "packages" ? " packages" : ""}`
    : "";
  const exit = c.exitCode == null ? "" : `, exit ${c.exitCode}`;
  return `\`${c.command}\` ${OUTCOME[c.outcome]}${counts} (${(c.durationMs / 1000).toFixed(1)}s${exit})`;
}

export function statusLine(r: Pick<ReceiptData, "status">): string {
  const m = STATUS_META[r.status];
  return `${m.icon} ${m.label}`;
}

/** The full receipt, for Copy and Share. */
export function receiptMarkdown(r: ReceiptData & { ts?: number }): string {
  const out: string[] = [];
  out.push(`### Workspace verification receipt: ${statusLine(r)}`);
  out.push("");
  out.push(`_Checks re-run by Canopy outside the agent's terminal${r.ts ? ` on ${new Date(r.ts).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}${r.branch ? ` on \`${r.branch}\`` : ""}._`);
  out.push("");
  if (r.verdict) {
    out.push(`**Asked:** ${r.verdict.asked || r.asked}`);
    out.push(`**Did:** ${r.verdict.did}`);
  } else if (r.asked) out.push(`**Asked:** ${r.asked.slice(0, 300)}`);
  if (r.claim) out.push(`**Agent says:** ${r.claim.replace(/\s+/g, " ").slice(0, 300)}`);
  out.push("");
  out.push("**Checks**");
  if (r.checks.length) for (const c of r.checks) out.push(`- ${checkLine(c)}`);
  else out.push("- No checks found for this project.");
  const review = r.tamper.filter((t) => t.severity === "review");
  if (review.length) {
    out.push("");
    out.push("**Tests changed by the agent — needs a human look**");
    for (const t of review) out.push(`- \`${t.path}\`: ${t.detail}`);
  }
  if (r.packages.length) {
    out.push("");
    out.push(`**New packages:** ${r.packages.map((p) => `${p.name} (${p.status === "exists" ? "exists" : p.status === "unknown" ? "UNKNOWN — not on the registry" : "not checked"})`).join(", ")}`);
  }
  if (r.verdict?.gaps.length) {
    out.push("");
    out.push("**Gaps**");
    for (const g of r.verdict.gaps) out.push(`- ${g}`);
  }
  if (!r.verdict && r.brainNote) out.push("", `_${r.brainNote}_`);
  return out.join("\n");
}

/** A single line (PTY brief contract) summarising the receipt. */
export function receiptOneLine(r: ReceiptData): string {
  const parts = [statusLine(r), ...r.checks.map(checkLine)];
  const review = r.tamper.filter((t) => t.severity === "review");
  if (review.length) parts.push(`tests changed by the agent: ${review.map((t) => t.path).join(", ")}`);
  const unknown = r.packages.filter((p) => p.status === "unknown");
  if (unknown.length) parts.push(`unknown packages: ${unknown.map((p) => p.name).join(", ")}`);
  if (r.verdict?.did) parts.push(`did: ${r.verdict.did}`);
  return parts.join(" · ").replace(/\s+/g, " ").slice(0, 1500);
}

/** What "Tell the agent" types: facts only, no blame, one line. */
export function tellAgentMessage(r: ReceiptData): string {
  const facts: string[] = [];
  for (const c of r.checks) {
    if (c.outcome === "failed") {
      const n = c.counts?.failed;
      facts.push(
        `${c.command} failed${n ? ` (${n} failing${c.failures.length ? `: ${c.failures.slice(0, 5).join(", ")}` : ""})` : ""}`,
      );
    } else if (c.outcome === "no-tests") facts.push(`${c.command} ran zero tests`);
    else if (c.outcome === "timed-out") facts.push(`${c.command} timed out`);
  }
  for (const t of r.tamper.filter((f) => f.severity === "review")) facts.push(`${t.path} was modified (${t.detail.replace(/\.$/, "")})`);
  for (const p of r.packages.filter((x) => x.status === "unknown")) facts.push(`package "${p.name}" does not exist on the ${p.ecosystem} registry`);
  if (r.verdict?.gaps.length) facts.push(...r.verdict.gaps.slice(0, 3));
  const body = facts.length ? facts.join("; ") : `status ${STATUS_META[r.status].label.toLowerCase()}`;
  return `Workspace verification (re-run by Canopy, not by you): ${body}. Please fix the cause and do not change tests to make them pass.`
    .replace(/\s+/g, " ")
    .slice(0, 1200);
}

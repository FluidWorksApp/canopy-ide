// The evidence half of a review: the proof receipt for a run, and the
// autonomy ledger — how work of this kind has held up in this repo.
//
// Receipts are written by the proof-receipts feature as `receipt` ledger
// entries (ref = the agent's session or turn). This module only reads them,
// and reads defensively: a missing field is a missing line, an unknown shape
// is "No receipt yet", never a crash.
//
// The autonomy ledger (MVP) is computed, not stored: per repo and task class
// (the brain files every plan under one), count the receipt verdicts of the
// runs that executed those plans, and how many of their commits were later
// reverted ("Revert …" commits whose body names them). A class with a strong
// record is shown as *eligible* for auto-merge. Nothing auto-merges: the
// graduation is a recommendation on screen, and stays one.

import * as ipc from "../ipc";
import { queryLedger, type LedgerEntry } from "../ledger";
import type { PlanData, TaskClass } from "../plans/plan";

export type Verdict = "proven" | "partial" | "unproven" | "contradicted";
const VERDICTS: readonly Verdict[] = ["proven", "partial", "unproven", "contradicted"];

export interface ReceiptView {
  verdict: Verdict | null;
  asked: string;
  did: string;
  evidence: string[];
  gaps: string[];
  checks: { name: string; ok: boolean | null; detail: string }[];
  tampered: boolean;
  ts: number;
}

const text = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const t = [o.text, o.what, o.summary, o.claim, o.name, o.description].find((x) => typeof x === "string");
    if (typeof t === "string") return t;
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return "";
};
const texts = (v: unknown) =>
  (Array.isArray(v) ? v : [])
    .map(text)
    .map((t) => t.replace(/\s+/g, " ").trim().slice(0, 400))
    .filter(Boolean)
    .slice(0, 20);

/** A receipt entry as something the review can show. */
export function readReceipt(entry: LedgerEntry): ReceiptView {
  const d = (entry.data && typeof entry.data === "object" ? entry.data : {}) as Record<string, unknown>;
  const verdict = VERDICTS.includes(d.verdict as Verdict) ? (d.verdict as Verdict) : null;
  const rawChecks = Array.isArray(d.checks) ? d.checks : d.checks && typeof d.checks === "object" ? Object.entries(d.checks).map(([name, v]) => ({ name, ...(typeof v === "object" ? v : { value: v }) })) : [];
  const checks = rawChecks.slice(0, 20).map((c) => {
    const o = (c && typeof c === "object" ? c : { name: text(c) }) as Record<string, unknown>;
    const exit = typeof o.exit === "number" ? o.exit : typeof o.exitCode === "number" ? o.exitCode : null;
    const ok = typeof o.passed === "boolean" ? o.passed : typeof o.ok === "boolean" ? o.ok : exit != null ? exit === 0 : null;
    const counts = ["passed", "failed", "count", "total"]
      .filter((k) => typeof o[k] === "number")
      .map((k) => `${o[k]} ${k}`)
      .join(", ");
    const detail = [exit != null ? `exit ${exit}` : "", counts].filter(Boolean).join(" · ");
    return { name: text(o.name ?? o.command ?? o.check ?? "check").slice(0, 200), ok, detail };
  });
  const tamper = d.tamper ?? d.tampered ?? d.tamperFlags;
  const tampered = Array.isArray(tamper) ? tamper.length > 0 : tamper === true || (!!tamper && typeof tamper === "object" && Object.values(tamper).some(Boolean));
  return {
    verdict,
    asked: text(d.asked).slice(0, 600),
    did: text(d.did).slice(0, 800),
    evidence: texts(d.evidence),
    gaps: texts(d.gaps),
    checks,
    tampered,
    ts: entry.ts,
  };
}

/** Does this receipt belong to the run with `sessionId`? Its ref may be the
 *  session, or a turn (`<sessionId>:<startedAt>`). */
export function receiptMatches(entry: LedgerEntry, sessionId: string): boolean {
  const ref = entry.ref?.id ?? "";
  const d = (entry.data ?? {}) as Record<string, unknown>;
  return ref === sessionId || ref.startsWith(`${sessionId}:`) || d.sessionId === sessionId;
}

/** The newest receipt for a session, or null ("No receipt yet"). */
export async function latestReceipt(dir: string, sessionId: string | null | undefined): Promise<ReceiptView | null> {
  if (!sessionId) return null;
  const rows = await queryLedger(dir, { kinds: ["receipt"], limit: 500 }).catch(() => [] as LedgerEntry[]);
  const hit = rows.find((r) => receiptMatches(r, sessionId));
  return hit ? readReceipt(hit) : null;
}

/** One line for the brain's review prompt. */
export function receiptLine(r: ReceiptView | null): string | undefined {
  if (!r) return undefined;
  return [
    r.verdict ? `verdict ${r.verdict}` : "no verdict",
    r.gaps.length ? `gaps: ${r.gaps.join("; ")}` : "",
    r.checks.length ? `checks: ${r.checks.map((c) => `${c.name} ${c.ok === true ? "passed" : c.ok === false ? "failed" : "?"}`).join(", ")}` : "",
    r.tampered ? "TAMPER FLAGS RAISED" : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

// --------------------------------------------------------------- reverts

const REVERT_TTL = 5 * 60_000;
const revertCache = new Map<string, { at: number; value: Promise<{ shas: string[]; subjects: Set<string> }> }>();

/** Commits reverted in this repo's recent history: the shas a revert's body
 *  names ("This reverts commit <sha>") and the subjects it quotes
 *  (`Revert "<subject>"`). A heuristic, and labelled as one. */
export function revertedCommits(dir: string): Promise<{ shas: string[]; subjects: Set<string> }> {
  const hit = revertCache.get(dir);
  if (hit && Date.now() - hit.at < REVERT_TTL) return hit.value;
  const value = (async () => {
    const log = await ipc.gitLog(dir, 400).catch(() => [] as ipc.CommitInfo[]);
    const reverts = log.filter((c) => /^Revert\b/i.test(c.subject)).slice(0, 25);
    const subjects = new Set<string>();
    const shas: string[] = [];
    for (const r of reverts) {
      const quoted = /^Revert "(.+)"$/i.exec(r.subject)?.[1];
      if (quoted) subjects.add(quoted);
      const detail = await ipc.gitCommitDetail(dir, r.hash).catch(() => null);
      for (const m of (detail?.body ?? "").matchAll(/reverts commit ([0-9a-f]{7,64})/gi)) shas.push(m[1]);
    }
    return { shas, subjects };
  })();
  revertCache.set(dir, { at: Date.now(), value });
  return value;
}

export function planReverted(plan: PlanData, reverted: { shas: string[]; subjects: Set<string> }): boolean {
  return (plan.commits ?? []).some(
    (c) => reverted.shas.some((s) => c.sha.startsWith(s) || s.startsWith(c.sha)) || reverted.subjects.has(c.subject),
  );
}

// ------------------------------------------------------- autonomy ledger

export interface TrackRecord {
  taskClass: TaskClass;
  runs: number;
  proven: number;
  partial: number;
  unproven: number;
  contradicted: number;
  reverted: number;
  /** A displayed recommendation only. Nothing in Canopy acts on it. */
  eligible: boolean;
}

/** Proven runs a class needs, with no reverts or contradictions, before it is
 *  shown as eligible for auto-merge. */
export const GRADUATE_AFTER = 10;

export function scoreTrackRecord(
  taskClass: TaskClass,
  plans: LedgerEntry<PlanData>[],
  receipts: LedgerEntry[],
  reverted: { shas: string[]; subjects: Set<string> },
): TrackRecord {
  const rec: TrackRecord = { taskClass, runs: 0, proven: 0, partial: 0, unproven: 0, contradicted: 0, reverted: 0, eligible: false };
  for (const p of plans) {
    if (p.data?.taskClass !== taskClass || !p.data.sessionId) continue;
    rec.runs++;
    const receipt = receipts.find((r) => receiptMatches(r, p.data.sessionId as string));
    const verdict = receipt ? readReceipt(receipt).verdict : null;
    if (verdict) rec[verdict]++;
    if (planReverted(p.data, reverted)) rec.reverted++;
  }
  rec.eligible = rec.proven >= GRADUATE_AFTER && rec.reverted === 0 && rec.contradicted === 0;
  return rec;
}

export async function trackRecord(dir: string, taskClass: TaskClass): Promise<TrackRecord> {
  const [plans, receipts, reverted] = await Promise.all([
    queryLedger<PlanData>(dir, { kinds: ["plan"], limit: 2000 }).catch(() => [] as LedgerEntry<PlanData>[]),
    queryLedger(dir, { kinds: ["receipt"], limit: 2000 }).catch(() => [] as LedgerEntry[]),
    revertedCommits(dir).catch(() => ({ shas: [], subjects: new Set<string>() })),
  ]);
  return scoreTrackRecord(taskClass, plans, receipts, reverted);
}

/** Tests only. */
export function resetEvidenceForTests(): void {
  revertCache.clear();
}

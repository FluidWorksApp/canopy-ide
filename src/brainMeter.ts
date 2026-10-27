// What the brain has cost, per feature, and whether a feature may spend more.
//
// Every intelligent feature runs on the person's own CLI plan, so a feature
// that quietly asks the brain a question on every keystroke spends their
// money and their rate limit. This is the one meter all brain calls go
// through (askBrain records here; nothing else should), so "what is the
// review feature costing me?" and "stop background features after $2 a day"
// each have one answer.
//
// Stored in localStorage like settings: small, per-machine, and read on hot
// paths. Capped by count and age so it can never grow without bound. Spend is
// also a ledger kind, for features that want a durable per-project record;
// this meter is the cheap, global, always-on one.

import { getSettings } from "./settings";

export interface BrainCallRecord {
  feature: string;
  ts: number;
  /** Null when the CLI reports no price (it still counts as a call). */
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  ok: boolean;
  /** The failure reason, for a call that did not answer. */
  reason?: string;
}

export interface BrainSpend {
  calls: number;
  failures: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

const KEY = "canopy.brainMeter";
const MAX_RECORDS = 5000;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const BRAIN_METER_EVENT = "canopy:brain-meter";

/** The connection probe is never gated: a status check that reports
 *  "over budget" instead of "connected" would answer the wrong question. */
const UNMETERED_BUDGET = new Set(["connect-probe"]);

let cache: { raw: string | null; records: BrainCallRecord[] } | null = null;

function read(): BrainCallRecord[] {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    // Storage blocked: meter in memory for this session only.
    return cache?.records ?? [];
  }
  if (cache && cache.raw === raw) return cache.records;
  let records: BrainCallRecord[] = [];
  try {
    const parsed = JSON.parse(raw ?? "[]") as unknown;
    if (Array.isArray(parsed)) {
      records = parsed.filter(
        (r): r is BrainCallRecord =>
          !!r && typeof r === "object" && typeof r.feature === "string" && typeof r.ts === "number",
      );
    }
  } catch {
    records = [];
  }
  cache = { raw, records };
  return records;
}

function write(records: BrainCallRecord[]): void {
  const raw = JSON.stringify(records);
  cache = { raw, records };
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    // Quota or blocked storage: the in-memory cache still meters this session.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BRAIN_METER_EVENT));
}

/** Record one brain call. askBrain calls this for every outcome that reached
 *  (or was refused before) the CLI. */
export function recordBrainCall(record: BrainCallRecord, now: number = Date.now()): void {
  const floor = now - MAX_AGE_MS;
  const kept = read().filter((r) => r.ts >= floor);
  kept.push(record);
  write(kept.slice(-MAX_RECORDS));
}

/** Totals over records matching `feature` (all when omitted) since `sinceMs`. */
export function brainSpend(opts: { feature?: string; sinceMs?: number } = {}): BrainSpend {
  const since = opts.sinceMs ?? 0;
  const out: BrainSpend = { calls: 0, failures: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
  for (const r of read()) {
    if (r.ts < since || (opts.feature !== undefined && r.feature !== opts.feature)) continue;
    out.calls += 1;
    if (!r.ok) out.failures += 1;
    out.costUsd += r.costUsd ?? 0;
    out.inputTokens += r.inputTokens ?? 0;
    out.outputTokens += r.outputTokens ?? 0;
  }
  return out;
}

/** Totals per feature since `sinceMs`. */
export function brainSpendByFeature(sinceMs = 0): Record<string, BrainSpend> {
  const features = new Set(read().filter((r) => r.ts >= sinceMs).map((r) => r.feature));
  return Object.fromEntries(
    [...features].map((feature) => [feature, brainSpend({ feature, sinceMs })]),
  );
}

/** Local midnight — budgets are daily in the person's own day, not UTC's. */
export function startOfToday(now: number = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whether `feature` has used up today's budget (its own, or the total). */
export function overBudget(feature: string, now: number = Date.now()): boolean {
  if (UNMETERED_BUDGET.has(feature)) return false;
  const s = getSettings();
  const since = startOfToday(now);
  const daily = s.brainDailyBudgetUsd;
  if (daily !== null && brainSpend({ sinceMs: since }).costUsd >= daily) return true;
  const cap = s.brainFeatureBudgetsUsd[feature];
  return cap !== undefined && brainSpend({ feature, sinceMs: since }).costUsd >= cap;
}

/** Hear about every recorded call. Returns an unsubscribe. */
export function subscribeBrainMeter(cb: () => void): () => void {
  window.addEventListener(BRAIN_METER_EVENT, cb);
  return () => window.removeEventListener(BRAIN_METER_EVENT, cb);
}

/** Tests only: forget everything. */
export function resetBrainMeterForTests(): void {
  cache = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

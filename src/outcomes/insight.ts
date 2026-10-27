// The brain-written weekly insight at the top of the Outcomes panel.
//
// The brain sees aggregated numbers only — counts, rates and dollars per task
// class, CLI and week, and Canopy's own spend per feature. Never code, file
// paths, prompts or PR titles: the question is "where is agent work paying
// off?", and the numbers answer it without anything that could leak.
//
// Cost control: background tier (the cheap model), at most once a day per
// repository unless the user presses Refresh, and not at all when the numbers
// have not changed since the last answer. Off in Settings → "Outcomes insight".

import { askBrain, type BrainAnswer } from "../brainCall";
import type { BrainSpend } from "../brainMeter";
import type { MetricRow } from "./metrics";

export const INSIGHT_FEATURE = "outcomes";
export const INSIGHT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface OutcomesInsight {
  headline: string;
  wins: string[];
  concerns: string[];
  suggestions: string[];
}

export interface InsightInput {
  days: number;
  total: MetricRow;
  byClass: MetricRow[];
  byCli: MetricRow[];
  byWeek: MetricRow[];
  brainByFeature: Record<string, BrainSpend>;
}

const pct = (x: number | null) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
const usd = (x: number | null) => (x == null ? "n/a" : `$${x.toFixed(2)}`);

function rowLine(r: MetricRow): string {
  return [
    `${r.key}: ${r.sessions} sessions`,
    `spend ${usd(r.costUsd)}`,
    `${r.merged} merged`,
    `cost/merged ${usd(r.costPerMerged)}`,
    `receipts ${r.receipts.proven} proven / ${r.receipts.partial} partial / ${r.receipts.unproven} unproven / ${r.receipts.contradicted} contradicted`,
    `${r.reverted} reverted (${pct(r.revertRate)})`,
    `${r.reworked} reworked within a week (${pct(r.reworkRate)})`,
    `median review ${r.medianReviewHours == null ? "n/a" : `${r.medianReviewHours.toFixed(1)}h`}`,
  ].join(", ");
}

/** The numbers, as text. Deterministic, so its hash is a cache key. */
export function insightFacts(input: InsightInput): string {
  const features = Object.entries(input.brainByFeature)
    .sort((a, b) => b[1].costUsd - a[1].costUsd)
    .slice(0, 12)
    .map(([f, s]) => `${f}: ${s.calls} calls, ${usd(s.costUsd)}`);
  return [
    `Window: last ${input.days} days.`,
    `Overall — ${rowLine(input.total)}`,
    "",
    "By task class:",
    ...input.byClass.map((r) => `- ${rowLine(r)}`),
    "",
    "By agent CLI:",
    ...input.byCli.map((r) => `- ${rowLine(r)}`),
    "",
    "By week:",
    ...input.byWeek.map((r) => `- ${rowLine(r)}`),
    "",
    "Canopy's own background intelligence spend by feature:",
    ...(features.length ? features.map((f) => `- ${f}`) : ["- none"]),
  ].join("\n");
}

export function buildInsightPrompt(facts: string): string {
  return [
    "You are reviewing how well AI coding-agent work is paying off in one repository.",
    "Below are aggregated, local numbers only (no code). Definitions: merged = the session raised a PR that merged;",
    "reverted = a later git revert touched the session's files; reworked = another session re-edited its files within 7 days;",
    "receipts = automated proof checks of each turn (proven is best).",
    "",
    facts,
    "",
    "Write a short, plain-language weekly insight for the team. Be concrete and cite the numbers.",
    "Recommend where agents can be trusted with more autonomy (e.g. auto-merge for a class with many proven and no reverts)",
    "and where they need tighter control (e.g. require plans for a class that is often reworked). Say so when there is too little data.",
    "",
    'Reply with ONE JSON object and nothing else: {"headline": string (max 120 chars), "wins": string[], "concerns": string[], "suggestions": string[]}',
    "Each list has at most 4 items of at most 160 characters.",
  ].join("\n");
}

const clean = (s: unknown, max: number): string | null =>
  typeof s === "string" && s.trim() ? s.trim().replace(/\s+/g, " ").slice(0, max) : null;

const list = (v: unknown): string[] | null => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  return v.map((x) => clean(x, 200)).filter((x): x is string => x != null).slice(0, 4);
};

/** Accept the brain's reply only in the exact shape the panel renders. */
export function validateInsight(v: unknown): OutcomesInsight | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const headline = clean(o.headline, 160);
  const wins = list(o.wins);
  const concerns = list(o.concerns);
  const suggestions = list(o.suggestions);
  if (!headline || !wins || !concerns || !suggestions) return null;
  return { headline, wins, concerns, suggestions };
}

/** FNV-1a — a cache key, not security. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export interface CachedInsight {
  hash: string;
  at: number;
  insight: OutcomesInsight;
}

const cacheKey = (root: string) => `canopy.outcomesInsight:${root}`;

export function readCachedInsight(root: string): CachedInsight | null {
  try {
    const v = JSON.parse(localStorage.getItem(cacheKey(root)) ?? "null") as CachedInsight | null;
    if (!v || typeof v.at !== "number" || typeof v.hash !== "string") return null;
    const insight = validateInsight(v.insight);
    return insight ? { ...v, insight } : null;
  } catch {
    return null;
  }
}

function writeCachedInsight(root: string, c: CachedInsight): void {
  try {
    localStorage.setItem(cacheKey(root), JSON.stringify(c));
  } catch {
    // Not cached: the next open asks again, at most once a day anyway.
  }
}

export type InsightOutcome =
  | { state: "fresh" | "cached"; insight: OutcomesInsight; at: number }
  | { state: "skipped"; reason: "no-data"; cached: CachedInsight | null }
  | { state: "failed"; reason: Extract<BrainAnswer<OutcomesInsight>, { ok: false }>["reason"]; message: string; cached: CachedInsight | null };

type Ask = typeof askBrain;

/** The insight for `root`: the cached one when it is under a day old (or the
 *  numbers have not moved) unless `force`, else a fresh background call. */
export async function loadInsight(
  root: string,
  input: InsightInput,
  opts: { force?: boolean; now?: number; ask?: Ask; signal?: AbortSignal } = {},
): Promise<InsightOutcome> {
  const now = opts.now ?? Date.now();
  const cached = readCachedInsight(root);
  const facts = insightFacts(input);
  const hash = hashText(facts);
  if (!opts.force && cached && (now - cached.at < INSIGHT_MAX_AGE_MS || cached.hash === hash)) {
    return { state: "cached", insight: cached.insight, at: cached.at };
  }
  if (input.total.sessions === 0 && input.total.receipts.total === 0) {
    return { state: "skipped", reason: "no-data", cached };
  }
  const ask = opts.ask ?? askBrain;
  const res = await ask<OutcomesInsight>({
    feature: INSIGHT_FEATURE,
    tier: "background",
    cwd: root,
    prompt: buildInsightPrompt(facts),
    json: true,
    validate: validateInsight,
    timeoutMs: 90_000,
    signal: opts.signal,
  });
  if (!res.ok) return { state: "failed", reason: res.reason, message: res.message, cached };
  const insight = res.value!;
  writeCachedInsight(root, { hash, at: now, insight });
  return { state: "fresh", insight, at: now };
}

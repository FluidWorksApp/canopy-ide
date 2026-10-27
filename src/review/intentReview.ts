// Intent & evidence: review an agent's work by what it was meant to do and
// what proves it did, with the diff as the drill-down.
//
//   plan (goal, decisions)
//   → the brain's deviation summary: askBrain({feature: "review", tier: "main"})
//     with the plan and the diff (chunked and capped, small files whole, big
//     ones by their first hunks, the rest named with their size)
//   → the proof receipt (from the ledger, written by the receipts feature)
//   → a risk map: files ordered by the brain's risk, with auth / data /
//     migrations / money forced to "high — read the lines" whatever it said
//   → the diff, in that order.
//
// Summaries are cached by a hash of plan + diff, in memory and in
// localStorage, so reopening the same review never asks twice.

import { askBrain, type BrainAnswer } from "../brainCall";
import { forcedHighReason } from "../plans/hotspots";
import type { PlanData } from "../plans/plan";

export type Level = "high" | "medium" | "low";

export interface ReviewSummary {
  summary: string;
  deviations: { what: string; where: string; severity: Level }[];
  unplanned: string[];
  missing: string[];
  risk: { file: string; level: Level; why: string }[];
  sliceSuggestion?: string;
}

export interface DiffFile {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
}

/** One blob → per-file patches with their size. */
export function splitDiff(patch: string): DiffFile[] {
  const out: DiffFile[] = [];
  let cur: { path: string; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    let add = 0;
    let del = 0;
    for (const l of cur.lines) {
      if (l.startsWith("+") && !l.startsWith("+++")) add++;
      else if (l.startsWith("-") && !l.startsWith("---")) del++;
    }
    out.push({ path: cur.path, patch: cur.lines.join("\n"), additions: add, deletions: del });
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const m = /diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = { path: m?.[2] ?? line.slice(11), lines: [line] };
    } else if (cur) cur.lines.push(line);
  }
  flush();
  return out;
}

export const changedLines = (files: DiffFile[]) => files.reduce((n, f) => n + f.additions + f.deletions, 0);

// ------------------------------------------------------------------ prompt

/** Per-file cap and total cap on patch text sent to the brain. */
export const FILE_PATCH_MAX = 6_000;
export const TOTAL_PATCH_MAX = 60_000;

function planSection(plan: PlanData | null): string[] {
  if (!plan) return ["PLAN: none was recorded for this work. Judge the diff on its own, and say that no plan exists."];
  const lines = ["PLAN:", `Goal: ${plan.goal}`];
  const settled = plan.decisions.filter((d) => d.answer || d.recommended);
  if (settled.length) lines.push("Decisions:", ...settled.map((d) => `- ${d.question} → ${d.answer || d.recommended}`));
  if (plan.touches.length) lines.push(`Expected to touch: ${plan.touches.join(", ")}`);
  if (plan.acceptance.length) lines.push("Acceptance checks:", ...plan.acceptance.map((a) => `- ${a}`));
  if (plan.wontDo.length) lines.push(`Won't do: ${plan.wontDo.join("; ")}`);
  return lines;
}

/** The diff as the brain sees it: every file named with its size; patches
 *  included whole while they fit, the first FILE_PATCH_MAX of a big one, and
 *  none once the total is spent. */
export function diffSection(files: DiffFile[]): string[] {
  const lines = [`CHANGED FILES (${files.length}, ${changedLines(files)} lines changed):`];
  for (const f of files) lines.push(`- ${f.path} (+${f.additions} -${f.deletions})`);
  lines.push("", "PATCHES:");
  let budget = TOTAL_PATCH_MAX;
  const omitted: string[] = [];
  for (const f of files) {
    if (budget <= 0) {
      omitted.push(f.path);
      continue;
    }
    const take = Math.min(FILE_PATCH_MAX, budget);
    const text = f.patch.length > take ? `${f.patch.slice(0, take)}\n… (${f.patch.length - take} more characters of this file not shown)` : f.patch;
    budget -= Math.min(f.patch.length, take);
    lines.push(text);
  }
  if (omitted.length) lines.push("", `Patches not shown (over the size cap; judge by name and size): ${omitted.join(", ")}`);
  return lines;
}

export function buildReviewPrompt(plan: PlanData | null, files: DiffFile[], receiptLine?: string): string {
  return [
    "You are reviewing an agent's code change for a human who will NOT read every line.",
    "Compare what was done against the plan. Be concrete and short; plain language a non-engineer can follow.",
    "",
    "Return ONE JSON object, nothing else:",
    "{",
    '  "summary": "2-3 sentences: what the change does, and whether it matches the plan",',
    '  "deviations": [{"what": "how it differs from the plan", "where": "file or area", "severity": "high"|"medium"|"low"}],',
    '  "unplanned": ["files changed that the plan did not call for"],',
    '  "missing": ["acceptance checks the diff does not appear to satisfy"],',
    '  "risk": [{"file": "path", "level": "high"|"medium"|"low", "why": "one short reason"}],',
    '  "sliceSuggestion": "optional: if this is too big to review at once, how the agent should split it into smaller reviewable pieces"',
    "}",
    "Rate every changed file in risk. Auth, data, migrations and money are always high.",
    "",
    ...planSection(plan),
    ...(receiptLine ? ["", `PROOF RECEIPT: ${receiptLine}`] : []),
    "",
    ...diffSection(files),
  ].join("\n");
}

// -------------------------------------------------------------- validation

const LEVELS: readonly Level[] = ["high", "medium", "low"];
const s = (v: unknown, n: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const list = (v: unknown, n: number) =>
  Array.isArray(v)
    ? v
        .map((x) => s(x, 300))
        .filter(Boolean)
        .slice(0, n)
    : [];
const level = (v: unknown): Level => (LEVELS.includes(v as Level) ? (v as Level) : "medium");

export function validateReview(v: unknown): ReviewSummary | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const summary = s(o.summary, 1200);
  if (!summary) return null;
  const objs = (x: unknown) => (Array.isArray(x) ? x.filter((y): y is Record<string, unknown> => !!y && typeof y === "object") : []);
  const deviations = objs(o.deviations)
    .map((d) => ({ what: s(d.what, 400), where: s(d.where, 200), severity: level(d.severity) }))
    .filter((d) => d.what)
    .slice(0, 20);
  const risk = objs(o.risk)
    .map((r) => ({ file: s(r.file, 400), level: level(r.level), why: s(r.why, 300) }))
    .filter((r) => r.file)
    .slice(0, 300);
  const slice = s(o.sliceSuggestion, 1500);
  return {
    summary,
    deviations,
    unplanned: list(o.unplanned, 50),
    missing: list(o.missing, 20),
    risk,
    ...(slice ? { sliceSuggestion: slice } : {}),
  };
}

// ------------------------------------------------------------------- cache

/** FNV-1a over the text, 52 bits, as hex. Not cryptographic — a cache key. */
export function contentHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${(h2 & 0xfffff).toString(16).padStart(5, "0")}`;
}

export const reviewCacheKey = (plan: PlanData | null, patch: string) =>
  contentHash(`${plan ? `${plan.planId}|${plan.goal}|${plan.acceptance.join("|")}` : "no-plan"}\n${patch}`);

const CACHE_PREFIX = "canopy:intent-review:";
const CACHE_INDEX = "canopy:intent-review-index";
const CACHE_KEEP = 40;
const memory = new Map<string, ReviewSummary>();

export function cachedReview(key: string): ReviewSummary | null {
  const hit = memory.get(key);
  if (hit) return hit;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    const v = raw ? validateReview(JSON.parse(raw)) : null;
    if (v) memory.set(key, v);
    return v;
  } catch {
    return null;
  }
}

function storeReview(key: string, v: ReviewSummary): void {
  memory.set(key, v);
  try {
    const index = (JSON.parse(localStorage.getItem(CACHE_INDEX) ?? "[]") as string[]).filter((k) => k !== key);
    index.push(key);
    while (index.length > CACHE_KEEP) localStorage.removeItem(CACHE_PREFIX + index.shift());
    localStorage.setItem(CACHE_INDEX, JSON.stringify(index));
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(v));
  } catch {
    // Storage full or blocked: the in-memory copy covers this session.
  }
}

/** In-flight requests, so two surfaces opening the same review share a call. */
const inflight = new Map<string, Promise<BrainAnswer<ReviewSummary>>>();

/** The brain's deviation summary for plan + diff, from cache when the same
 *  pair was summarised before. */
export async function summarizeChange(opts: {
  cwd: string;
  plan: PlanData | null;
  patch: string;
  receiptLine?: string;
  signal?: AbortSignal;
}): Promise<BrainAnswer<ReviewSummary> & { cached?: boolean }> {
  const key = reviewCacheKey(opts.plan, opts.patch);
  const hit = cachedReview(key);
  if (hit) return { ok: true, text: "", value: hit, costUsd: 0, inputTokens: null, outputTokens: null, cached: true } as BrainAnswer<ReviewSummary> & { cached: boolean };
  const running = inflight.get(key);
  if (running) return running;
  const call = askBrain<ReviewSummary>({
    feature: "review",
    tier: "main",
    json: true,
    cwd: opts.cwd,
    prompt: buildReviewPrompt(opts.plan, splitDiff(opts.patch), opts.receiptLine),
    validate: validateReview,
    timeoutMs: 150_000,
    signal: opts.signal,
  }).then((answer) => {
    if (answer.ok && answer.value) storeReview(key, answer.value);
    return answer;
  });
  inflight.set(key, call);
  try {
    return await call;
  } finally {
    inflight.delete(key);
  }
}

// --------------------------------------------------------------- risk map

export interface RiskRow {
  path: string;
  level: Level;
  why: string;
  /** Forced high by path (auth / data / migration / money): read the lines. */
  forced: boolean;
  lines: number;
}

const RANK: Record<Level, number> = { high: 0, medium: 1, low: 2 };
const samePath = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

/** Every changed file, most dangerous first. Forced-high files lead (always
 *  "high, read the lines"), then the brain's high / medium / low, then files
 *  it did not rate, biggest first. Ties break on size, then path. */
export function riskOrder(files: DiffFile[], brain: ReviewSummary["risk"] = []): RiskRow[] {
  const rows = files.map((f): RiskRow => {
    const lines = f.additions + f.deletions;
    const forced = forcedHighReason(f.path);
    const rated = brain.find((r) => samePath(r.file, f.path));
    if (forced)
      return {
        path: f.path,
        level: "high",
        why: `${forced} — always read every line${rated?.why ? `. ${rated.why}` : ""}`,
        forced: true,
        lines,
      };
    if (rated) return { path: f.path, level: rated.level, why: rated.why, forced: false, lines };
    return { path: f.path, level: "medium", why: "", forced: false, lines };
  });
  const unrated = (r: RiskRow) => !r.forced && !brain.some((b) => samePath(b.file, r.path));
  return rows.sort(
    (a, b) =>
      Number(b.forced) - Number(a.forced) ||
      Number(unrated(a)) - Number(unrated(b)) ||
      RANK[a.level] - RANK[b.level] ||
      b.lines - a.lines ||
      a.path.localeCompare(b.path),
  );
}

// ------------------------------------------------------------ slice budget

export interface SliceStatus {
  lines: number;
  budget: number;
  over: boolean;
}
export const sliceStatus = (files: DiffFile[], budget: number): SliceStatus => {
  const lines = changedLines(files);
  return { lines, budget, over: lines > budget };
};

/** What "Ask the agent to split this" types into the agent's terminal. */
export function splitRequest(status: SliceStatus, suggestion: string | undefined): string {
  const how = suggestion?.trim()
    ? `Suggested split: ${suggestion.trim()}`
    : "Split it by concern (for example: refactor first, then behaviour change, then tests).";
  return (
    `This change is ${status.lines} changed lines, over the team's review budget of ${status.budget} lines per slice. ` +
    `Please split it into smaller reviewable slices (separate commits or branches, each under ${status.budget} lines) without changing the overall result. ${how}`
  ).replace(/\s+/g, " ");
}

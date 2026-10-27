// Plain-language checkpoint summaries for the builder lens.
//
// Build saves a verified version as a commit whose subject starts "vibe: ",
// and every agent turn that finishes is a step. To someone who never asked to
// see git, both read as hashes and prompts. Here the brain (background tier)
// turns each into {title, whatChanged, layer, risk} in words they use, once per
// checkpoint: summaries are cached in memory and in the ledger (`memory` kind,
// ref lens-checkpoint/<key>), so a list re-renders for free and a reopened
// project never pays twice.
import { askBrain } from "./brainCall";
import * as ipc from "./ipc";
import { appendLedger, queryLedger } from "./ledger";
import { isLensLayer, type LensLayer } from "./lensLayers";
import { patchInRange } from "./turnSnapshots";

export type CheckpointRisk = "low" | "medium" | "high";

export interface CheckpointSummary {
  title: string;
  whatChanged: string;
  layer: LensLayer;
  risk: CheckpointRisk;
}

export interface LensCheckpoint {
  /** Stable cache key: `commit:<sha>` or `turn:<turnId>`. */
  key: string;
  kind: "checkpoint" | "step";
  /** Set for saved versions — what "Go back to here" restores. */
  sha?: string;
  /** What the person asked for, as Build recorded it. */
  goal: string;
  at: number;
  files: string[];
  /** For a step: turn rollback's snapshots around it, so its summary reads
   *  everything it changed (Bash edits too). */
  range?: { from: string; to: string | null; shared?: boolean };
}

/** Build's checkpoint commit prefix (vibeBuilderSession: `vibe: ${goal}`). */
export const CHECKPOINT_SUBJECT_PREFIX = "vibe: ";

const PATCH_BUDGET = 12_000;

/** The saved versions in a log, newest first, as the builder lens lists them. */
export function checkpointsFromLog(log: readonly ipc.CommitInfo[]): LensCheckpoint[] {
  return log
    .filter((c) => c.subject.startsWith(CHECKPOINT_SUBJECT_PREFIX))
    .map((c) => ({
      key: `commit:${c.hash}`,
      kind: "checkpoint" as const,
      sha: c.hash,
      goal: c.subject.slice(CHECKPOINT_SUBJECT_PREFIX.length).trim(),
      at: Date.parse(c.date) || 0,
      files: [],
    }));
}

/** File names a commit patch touched ("diff --git a/x b/x"). */
export function filesInPatch(patch: string): string[] {
  const out = new Set<string>();
  for (const m of patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) out.add(m[2]);
  return [...out];
}

export function checkpointSummaryPrompt(cp: { goal: string; files: readonly string[] }, patch: string): string {
  const clipped = patch.length > PATCH_BUDGET ? `${patch.slice(0, PATCH_BUDGET)}\n… (diff shortened)` : patch;
  return [
    "Summarise one saved step of an app for the person who asked for it. They are not an engineer.",
    "Rules: plain everyday language, no jargon, no file names, no code, no git words (commit, diff, branch, merge).",
    "Say what someone using the app would notice, not how it was done.",
    `What they asked for: ${cp.goal || "(not recorded)"}`,
    cp.files.length ? `Files touched (for your judgment only): ${cp.files.slice(0, 40).join(", ")}` : "",
    clipped ? `The change:\n${clipped}` : "",
    "Pick the one layer it mostly touched: data (what the app stores), logic (rules and behaviour), view (what people see), auth (sign-in and permissions), deploy (hosting, going live), integration (outside services like payments or email).",
    "Risk: low (looks and wording), medium (behaviour changes), high (stored data, sign-in, payments, or going live).",
    'Reply with one JSON object: {"title":"at most 8 words","whatChanged":"one or two short sentences","layer":"data|logic|view|auth|deploy|integration","risk":"low|medium|high"}',
  ].filter(Boolean).join("\n");
}

const RISKS: readonly CheckpointRisk[] = ["low", "medium", "high"];

/** Strips what plain language never needs (backticks, code fences) and caps
 *  length; rejects anything missing a field. */
export function validateCheckpointSummary(v: unknown): CheckpointSummary | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const plain = (x: unknown, max: number) =>
    typeof x === "string"
      ? x.replace(/```[\s\S]*?```/g, " ").replace(/`/g, "").replace(/\s+/g, " ").trim().slice(0, max)
      : "";
  const title = plain(o.title, 80);
  const whatChanged = plain(o.whatChanged, 400);
  const layer = typeof o.layer === "string" ? o.layer.trim().toLowerCase() : "";
  const risk = typeof o.risk === "string" ? o.risk.trim().toLowerCase() : "";
  if (!title || !whatChanged || !isLensLayer(layer) || !(RISKS as readonly string[]).includes(risk)) return null;
  return { title, whatChanged, layer, risk: risk as CheckpointRisk };
}

const REF_KIND = "lens-checkpoint";
const memory = new Map<string, CheckpointSummary>();
const inflight = new Map<string, Promise<CheckpointSummary | null>>();
const cacheKey = (root: string, key: string) => `${root.replace(/\\/g, "/").replace(/\/+$/, "")}\0${key}`;

export function peekCheckpointSummary(root: string, key: string): CheckpointSummary | null {
  return memory.get(cacheKey(root, key)) ?? null;
}

export interface SummaryDeps {
  ask?: typeof askBrain;
  patchFor?: (root: string, cp: LensCheckpoint) => Promise<string>;
}

/** The change a checkpoint carries: the commit's patch, or for an unsaved step
 *  the working-tree diff of the files it touched. Best effort — the brain can
 *  still summarise from the goal alone. */
async function defaultPatch(root: string, cp: LensCheckpoint): Promise<string> {
  if (cp.sha) return (await ipc.gitCommitPatch(root, cp.sha).catch(() => null))?.patch ?? "";
  if (cp.range) {
    // In a checkout another agent shares, only this step's own files.
    const files = cp.range.shared ? cp.files.slice(0, 40) : [];
    const patch = cp.range.shared && !files.length
      ? ""
      : await patchInRange(root, { from: cp.range.from, to: cp.range.to, shared: !!cp.range.shared }, files, PATCH_BUDGET * 2).catch(() => "");
    if (patch) return patch;
  }
  const parts = await Promise.all(
    cp.files.slice(0, 12).map((f) => ipc.gitDiff(root, f, false).catch(() => "")),
  );
  return parts.filter(Boolean).join("\n");
}

/** Summary for one checkpoint: memory → ledger → brain (background). Never
 *  throws; null means "show the goal instead" (no brain, over budget, …). */
export function summarizeCheckpoint(
  root: string,
  cp: LensCheckpoint,
  deps: SummaryDeps = {},
): Promise<CheckpointSummary | null> {
  const k = cacheKey(root, cp.key);
  const hit = memory.get(k);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(k);
  if (running) return running;
  const job = (async () => {
    const rows = await queryLedger<CheckpointSummary>(root, {
      kinds: ["memory"], refKind: REF_KIND, refId: cp.key, limit: 1,
    }).catch(() => []);
    const stored = rows[0] ? validateCheckpointSummary(rows[0].data) : null;
    if (stored) {
      memory.set(k, stored);
      return stored;
    }
    const patch = await (deps.patchFor ?? defaultPatch)(root, cp).catch(() => "");
    const answer = await (deps.ask ?? askBrain)<CheckpointSummary>({
      feature: "lens",
      tier: "background",
      cwd: root,
      json: true,
      prompt: checkpointSummaryPrompt(cp, patch),
      validate: validateCheckpointSummary,
    });
    if (!answer.ok || !answer.value) return null;
    memory.set(k, answer.value);
    await appendLedger<CheckpointSummary>(root, {
      kind: "memory",
      author: { kind: "brain", name: "lens" },
      scope: "project",
      subject: answer.value.title,
      ref: { kind: REF_KIND, id: cp.key },
      data: answer.value,
    }).catch(() => undefined);
    return answer.value;
  })().finally(() => inflight.delete(k));
  inflight.set(k, job);
  return job;
}

/** The label a checkpoint is listed (and restored) under. */
export function checkpointTitle(cp: LensCheckpoint, summary: CheckpointSummary | null): string {
  return summary?.title || cp.goal || (cp.kind === "checkpoint" ? "Saved version" : "A change");
}

export const RISK_LABEL: Record<CheckpointRisk, string> = {
  low: "Small change",
  medium: "Changes how it works",
  high: "Touches important stuff",
};

export function resetLensCheckpointsForTests(): void {
  memory.clear();
  inflight.clear();
}

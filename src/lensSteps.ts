// Agent steps, collected and summarised app-wide.
//
// The builder lens lists every agent turn as a step with a plain-language
// summary. That used to be gathered by the panel itself, so a turn that ended
// while the panel wasn't on screen (another project in front, the engineer
// lens showing, the app just opened) was never listed or summarised. This
// store subscribes once for the window (App.tsx `startLensSteps`), keeps the
// recent steps per project, and asks for each summary in the background when
// the project is in the builder lens and Builder lens summaries are on. The
// summaries are cached by lensCheckpoints.ts (memory + ledger), so the
// engineer lens's turn list (TurnTimeline) reads the same ones.

import { onAgentTurnEnd, type AgentTurnEnd } from "./agentTurns";
import { getSettings } from "./settings";
import { queryLedger } from "./ledger";
import {
  peekCheckpointSummary,
  summarizeCheckpoint,
  validateCheckpointSummary,
  type CheckpointSummary,
  type LensCheckpoint,
} from "./lensCheckpoints";
import { turnSnapshotRange, filesInRange } from "./turnSnapshots";

export interface LensStep extends LensCheckpoint {
  kind: "step";
  sessionId: string;
  cwd: string;
  startedAt: number;
}

export interface LensProjectRoot {
  root: string;
  /** Summaries are written automatically only in the builder lens. */
  builder: boolean;
}

const MAX_STEPS = 30;
/** A summary matches a timeline turn when their starts are this close (the
 *  observed start vs the snapshot's stamp). */
const MATCH_SLACK_MS = 15_000;

const byRoot = new Map<string, LensStep[]>();
const listeners = new Set<() => void>();
let version = 0;

const emit = () => {
  version++;
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // A broken listener must not stop the others.
    }
  }
};

export function subscribeLensSteps(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Changes on every new step or summary — a `useSyncExternalStore` snapshot. */
export const lensStepsVersion = () => version;

/** The recent steps in `root`, newest first. */
export function lensSteps(root: string): readonly LensStep[] {
  return byRoot.get(norm(root)) ?? [];
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const under = (root: string, cwd: string) => {
  const r = norm(root);
  const c = norm(cwd);
  return c === r || c.startsWith(`${r}/`);
};

/** The project root a turn belongs to: the deepest one containing its cwd. */
export function rootFor(cwd: string, roots: readonly LensProjectRoot[]): LensProjectRoot | null {
  let best: LensProjectRoot | null = null;
  for (const r of roots) {
    if (under(r.root, cwd) && (!best || norm(r.root).length > norm(best.root).length)) best = r;
  }
  return best;
}

export function stepOf(turn: AgentTurnEnd): LensStep {
  return {
    key: `turn:${turn.turnId}`,
    kind: "step",
    goal: turn.prompt?.trim() ?? "",
    at: turn.endedAt,
    files: turn.filesTouched,
    sessionId: turn.sessionId,
    cwd: turn.cwd,
    startedAt: turn.startedAt,
  };
}

export interface LensStepsDeps {
  summarize: typeof summarizeCheckpoint;
  range: typeof turnSnapshotRange;
  files: typeof filesInRange;
  autoSummaries(): boolean;
}

const defaultDeps: LensStepsDeps = {
  summarize: summarizeCheckpoint,
  range: turnSnapshotRange,
  files: filesInRange,
  autoSummaries: () => getSettings().lensAutoSummaries,
};

/** File one finished turn. Exported for tests. */
export async function recordStep(
  turn: AgentTurnEnd,
  roots: readonly LensProjectRoot[],
  deps: LensStepsDeps = defaultDeps,
): Promise<LensStep | null> {
  const project = rootFor(turn.cwd, roots);
  if (!project) return null;
  const key = norm(project.root);
  const step = stepOf(turn);
  // The snapshot pair also catches what the turn changed through Bash, which
  // the edit journal (filesTouched) doesn't see; the summary reads that diff.
  const range = await deps.range(turn.cwd, turn.sessionId, turn.startedAt, turn.endedAt).catch(() => null);
  if (range) {
    step.range = { from: range.from, to: range.to, shared: range.shared };
    if (!range.shared) {
      const extra = await deps.files(turn.cwd, range).catch(() => [] as string[]);
      step.files = [...new Set([...step.files, ...extra])];
    }
  }
  const list = byRoot.get(key) ?? [];
  byRoot.set(key, [step, ...list.filter((s) => s.key !== step.key)].slice(0, MAX_STEPS));
  emit();
  if (project.builder && deps.autoSummaries() && (step.files.length || step.goal)) {
    void deps
      .summarize(key, step)
      .then((s) => s && emit())
      .catch(() => undefined);
  }
  return step;
}

/** Listen for turn ends app-wide. `roots` reads the open projects at call
 *  time. Returns a stop. */
export function startLensSteps(opts: { roots: () => LensProjectRoot[] }, deps: LensStepsDeps = defaultDeps): () => void {
  let chain: Promise<unknown> = Promise.resolve();
  return onAgentTurnEnd((turn) => {
    chain = chain.then(() => recordStep(turn, opts.roots(), deps)).catch(() => undefined);
  });
}

// ------------------------------------------------------- per session (turns)

export interface StepSummary {
  startedAt: number;
  summary: CheckpointSummary;
}

/** `turn:<sessionId>:<startedAt>` → its parts. */
export function parseStepKey(key: string): { sessionId: string; startedAt: number } | null {
  const m = /^turn:(.+):(\d+)$/.exec(key);
  return m ? { sessionId: m[1], startedAt: Number(m[2]) } : null;
}

/** Every summary written for a session's turns: this window's, and what the
 *  ledger kept from before. */
export async function stepSummariesFor(cwd: string, sessionId: string): Promise<StepSummary[]> {
  const out = new Map<number, CheckpointSummary>();
  const rows = await queryLedger<CheckpointSummary>(cwd, {
    kinds: ["memory"],
    refKind: "lens-checkpoint",
    limit: 1000,
  }).catch(() => []);
  for (const r of rows) {
    const parsed = r.ref ? parseStepKey(r.ref.id) : null;
    const summary = parsed?.sessionId === sessionId ? validateCheckpointSummary(r.data) : null;
    if (parsed && summary && !out.has(parsed.startedAt)) out.set(parsed.startedAt, summary);
  }
  for (const steps of byRoot.values()) {
    for (const s of steps) {
      if (s.sessionId !== sessionId) continue;
      const hit = peekCheckpointSummaryAnywhere(s.key);
      if (hit) out.set(s.startedAt, hit);
    }
  }
  return [...out.entries()].map(([startedAt, summary]) => ({ startedAt, summary }));
}

function peekCheckpointSummaryAnywhere(key: string): CheckpointSummary | null {
  for (const root of byRoot.keys()) {
    const hit = peekCheckpointSummary(root, key);
    if (hit) return hit;
  }
  return null;
}

/** The summary for a turn that started at `startedMs`, if one is close. */
export function matchStepSummary(summaries: readonly StepSummary[], startedMs: number | null): CheckpointSummary | null {
  if (startedMs == null) return null;
  let best: StepSummary | null = null;
  for (const s of summaries) {
    const d = Math.abs(s.startedAt - startedMs);
    if (d <= MATCH_SLACK_MS && (!best || d < Math.abs(best.startedAt - startedMs))) best = s;
  }
  return best?.summary ?? null;
}

/** Tests only. */
export function resetLensStepsForTests(): void {
  byRoot.clear();
  listeners.clear();
  version = 0;
}

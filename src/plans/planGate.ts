// The dispatch gate: work handed to an agent through Canopy gets a plan first.
//
//   dispatchWithPlan(request, launch)
//     → "Planning…" (the person can skip and start now)
//     → askBrain({feature: "plan", tier: "main"}) with the request + repo context
//     → tiny / low risk / nothing shared: plan shown inline, agent starts now
//     → otherwise: the plan card waits for answers and an approval
//     → the agent starts with the plan folded into its brief
//
// No brain, signed out, over budget, a timeout: the work starts without a plan
// and a one-line note says why. Planning must never be the reason work did not
// start.
//
// The gate is a small external store (items on screen) that PlanGateHost
// renders; launch surfaces call `dispatchWithPlan` and nothing else.

import { askBrain } from "../brainCall";
import { subscribeLedger } from "../ledger";
import { getSettings } from "../settings";
import {
  buildPlanPrompt,
  newPlanId,
  planBrief,
  planGate,
  settleWithRecommendations,
  validatePlan,
  type PlanData,
  type PlanDecision,
  type PlanSource,
} from "./plan";
import { gatherPlanContext } from "./planContext";
import { createPlan, expectRun, revisePlan, type PlanEntry } from "./planStore";

export interface DispatchRequest {
  /** The brief as the surface composed it. */
  request: string;
  /** Where the agent will run. */
  dir: string;
  label?: string;
  source: PlanSource;
}

/** Starts the agent with this brief; resolves whether it started. `planId` is
 *  set when the brief carries a plan, so a surface that only learns where the
 *  agent runs later (a ticket's new worktree) can `expectRun` it there too. */
export type Launch = (brief: string, planId?: string) => Promise<boolean | void> | boolean | void;

export type GateItem =
  | { id: string; phase: "planning"; req: DispatchRequest }
  | { id: string; phase: "approval"; req: DispatchRequest; entry: PlanEntry }
  | { id: string; phase: "inline"; req: DispatchRequest; entry: PlanEntry }
  | { id: string; phase: "note"; req: DispatchRequest; message: string };

let items: GateItem[] = [];
const listeners = new Set<() => void>();
/** What each on-screen item does when acted on; not part of the snapshot. */
const handlers = new Map<
  string,
  { skip?: () => void; approve?: (edits: PlanEdits) => Promise<void>; drop?: () => void; dispose?: () => void }
>();

function emit() {
  for (const l of listeners) l();
}
function put(item: GateItem) {
  const i = items.findIndex((x) => x.id === item.id);
  items = i < 0 ? [...items, item] : items.map((x) => (x.id === item.id ? item : x));
  emit();
}
function remove(id: string) {
  handlers.get(id)?.dispose?.();
  handlers.delete(id);
  if (!items.some((x) => x.id === id)) return;
  items = items.filter((x) => x.id !== id);
  emit();
}

export const planGateItems = (): GateItem[] => items;
export function subscribePlanGate(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export interface PlanEdits {
  decisions: PlanDecision[];
  acceptance: string[];
}

/** The person skipped planning: start now, with the brief as composed. */
export const skipPlanning = (id: string) => handlers.get(id)?.skip?.();
/** The person answered the decisions and approved. */
export const approvePlan = (id: string, edits: PlanEdits) => handlers.get(id)?.approve?.(edits) ?? Promise.resolve();
/** The person decided not to start this. */
export const dropPlan = (id: string) => handlers.get(id)?.drop?.();
export const dismissGateItem = (id: string) => remove(id);

const REQUEST_KEEP = 4000;
const NOTE_MS = 9_000;
const REASON: Record<string, string> = {
  "no-brain": "no brain is connected",
  "signed-out": "the brain is signed out",
  "rate-limited": "the brain is rate-limited",
  "over-budget": "planning is over today's budget",
  timeout: "planning took too long",
  "invalid-output": "the brain's plan was unreadable",
  failed: "planning failed",
};

async function persist(data: PlanData, status: "proposed" | "approved"): Promise<PlanEntry> {
  try {
    return await createPlan(data, status);
  } catch {
    // A ledger that won't take the write must not hold up the work. The plan
    // still shapes the brief; it just isn't on record.
    return {
      id: `local-${data.planId}`,
      kind: "plan",
      ts: Date.now(),
      root: data.dir,
      author: { kind: "brain", name: "plan" },
      scope: "project",
      data,
      status,
    };
  }
}

let seq = 0;

/** Plan, then launch. Never throws; never leaves the work unstarted unless the
 *  person chose "Don't start". Resolves once the work has been launched (or
 *  dropped) — for a plan waiting on approval, that is after the person acts. */
export async function dispatchWithPlan(req: DispatchRequest, launch: Launch): Promise<void> {
  if (!getSettings().planBeforeDispatch) {
    await launch(req.request);
    return;
  }
  const id = `gate-${++seq}`;
  const controller = new AbortController();
  let settled = false;
  const start = async (brief: string, planId?: string) => {
    try {
      await (planId ? launch(brief, planId) : launch(brief));
    } catch {
      // The surface reports its own launch failures.
    }
  };
  handlers.set(id, {
    skip: () => {
      if (settled) return;
      settled = true;
      controller.abort();
      remove(id);
      void start(req.request);
    },
  });
  put({ id, phase: "planning", req });

  const ctx = await gatherPlanContext(req.dir, req.request).catch(() => ({ tree: [], relevant: [], memory: [] }));
  if (settled) return;
  const answer = await askBrain({
    feature: "plan",
    tier: "main",
    json: true,
    cwd: req.dir,
    prompt: buildPlanPrompt(req.request, ctx),
    validate: validatePlan,
    timeoutMs: 90_000,
    signal: controller.signal,
  });
  if (settled) return;

  if (!answer.ok || !answer.value) {
    settled = true;
    const why = answer.ok ? "the brain returned no plan" : (REASON[answer.reason] ?? "planning failed");
    put({ id, phase: "note", req, message: `Started without a plan: ${why}.` });
    handlers.set(id, {});
    window.setTimeout(() => remove(id), NOTE_MS);
    await start(req.request);
    return;
  }

  const draft = answer.value;
  const gate = planGate(draft);
  const base: PlanData = {
    ...draft,
    planId: newPlanId(),
    request: req.request.length > REQUEST_KEEP ? `${req.request.slice(0, REQUEST_KEEP - 1)}…` : req.request,
    ...(req.label ? { label: req.label } : {}),
    dir: req.dir,
    source: req.source,
    gate: gate.gate,
    gateWhy: gate.why,
  };
  // The brief keeps the whole request even when the record clips it.
  const briefFor = (data: PlanData) => planBrief({ ...data, request: req.request });

  if (gate.gate === "inline") {
    settled = true;
    const data = { ...base, decisions: settleWithRecommendations(base.decisions) };
    const entry = await persist(data, "approved");
    put({ id, phase: "inline", req, entry });
    handlers.set(id, {});
    // Expect the run before it starts: HEAD is read before the agent can
    // commit, and a fast first turn finds the plan already waiting for it.
    await expectRun(data.planId, req.dir).catch(() => {});
    await start(briefFor(data), data.planId);
    return;
  }

  const entry = await persist(base, "proposed");
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let launched = false;
  const go = async (data: PlanData) => {
    if (launched) return;
    launched = true;
    settled = true;
    remove(id);
    await expectRun(data.planId, req.dir).catch(() => {});
    await start(briefFor(data), data.planId);
    finish();
  };
  // Approval can also arrive from team chat (the shared plan card): the
  // ledger hears the status change, and the waiting launch goes ahead.
  const stopWatching = subscribeLedger(entry.root || req.dir, (e) => {
    const d = e.data as Partial<PlanData> | undefined;
    if (e.kind === "plan" && d?.planId === base.planId && e.status === "approved") void go(e.data as PlanData);
  });
  handlers.set(id, {
    dispose: stopWatching,
    approve: async (edits) => {
      const data: PlanData = {
        ...base,
        decisions: edits.decisions,
        acceptance: edits.acceptance,
        approvedBy: "you",
        approvedAt: Date.now(),
      };
      const next = await revisePlan(req.dir, base.planId, () => ({
        status: "approved",
        data: { decisions: data.decisions, acceptance: data.acceptance, approvedBy: data.approvedBy, approvedAt: data.approvedAt },
      })).catch(() => null);
      await go(next?.data ?? data);
    },
    drop: () => {
      if (launched) return;
      launched = true;
      settled = true;
      remove(id);
      finish();
      void revisePlan(req.dir, base.planId, () => ({ status: "dropped" })).catch(() => {});
    },
  });
  put({ id, phase: "approval", req, entry });
  await finished;
}

/** Tests only. */
export function resetPlanGateForTests(): void {
  for (const id of [...handlers.keys()]) handlers.get(id)?.dispose?.();
  items = [];
  handlers.clear();
  listeners.clear();
  seq = 0;
}

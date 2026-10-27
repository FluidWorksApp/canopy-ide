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
//
// A plan waiting for approval outlives the window. The dispatch records how to
// launch it (`resume`: a kind and a JSON payload) on the plan's ledger entry;
// after a restart, `restoreWaitingPlans` finds the plans made on this machine
// that still wait (or were approved in team chat while Canopy was closed and
// never launched), puts them back on screen, and launches through the resumer
// the surface registered for that kind.

import { askBrain } from "../brainCall";
import { queryLedger, subscribeLedger } from "../ledger";
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
  type PlanLaunchSpec,
  type PlanRunMode,
  type PlanSource,
} from "./plan";
import { gatherPlanContext } from "./planContext";
import { createPlan, expectRun, madeHere, revisePlan, type PlanEntry } from "./planStore";

export interface DispatchRequest {
  /** The brief as the surface composed it. */
  request: string;
  /** Where the agent will run. */
  dir: string;
  label?: string;
  source: PlanSource;
  /** "interactive": a session the person keeps talking to (a ticket's
   *  terminal, Build chat), done when the person or the evidence says so.
   *  Absent = one-shot, done when its run ends. */
  mode?: PlanRunMode;
  /** The ticket the work is for, so marking it done finishes the plan. */
  ticketId?: string;
  /** How to launch this after a restart (see restoreWaitingPlans). Without
   *  it a waiting plan can only start from this window. */
  resume?: { kind: string; payload: Record<string, unknown> };
}

/** Starts the agent with this brief; resolves whether it started. `planId` is
 *  set when the brief carries a plan, so a surface that only learns where the
 *  agent runs later (a ticket's new worktree) can `expectRun` it there too. */
export type Launch = (brief: string, planId?: string) => Promise<boolean | void> | boolean | void;

/** Launches a restored plan: the planned brief, its id, and the payload the
 *  dispatch recorded. */
export type PlanResumer = (
  brief: string,
  planId: string,
  payload: Record<string, unknown>,
) => Promise<boolean | void> | boolean | void;

export type GateItem =
  | { id: string; phase: "planning"; req: DispatchRequest }
  /** `waiting`: tucked into the corner while the team decides, rather than
   *  holding the screen. */
  | { id: string; phase: "approval"; req: DispatchRequest; entry: PlanEntry; waiting?: boolean }
  | { id: string; phase: "inline"; req: DispatchRequest; entry: PlanEntry }
  | { id: string; phase: "note"; req: DispatchRequest; message: string };

let items: GateItem[] = [];
const listeners = new Set<() => void>();
/** What each on-screen item does when acted on; not part of the snapshot. */
const handlers = new Map<
  string,
  { skip?: () => void; approve?: (edits: PlanEdits) => Promise<void>; drop?: () => void; dispose?: () => void }
>();
/** Plans with a launch armed in this window (live or restored): one each. */
const armed = new Set<string>();

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
/** Tuck a waiting plan into the corner (the team is deciding), or bring it
 *  back up. The launch stays armed either way. */
export function setPlanWaiting(id: string, waiting: boolean): void {
  const item = items.find((x) => x.id === id);
  if (item?.phase === "approval") put({ ...item, waiting });
}

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

/** Wait for `entry` to be approved — here, in team chat, or (restored) while
 *  Canopy was closed — then launch it once. Resolves when it launched or was
 *  dropped. */
function armApproval(
  id: string,
  req: DispatchRequest,
  entry: PlanEntry,
  launch: (brief: string, planId: string) => Promise<void>,
  waiting = false,
): Promise<void> {
  const base = entry.data;
  const planId = base.planId;
  armed.add(planId);
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let launched = false;
  // The brief keeps the whole request even when the record clips it.
  const full = base.launch?.request ?? req.request;
  const go = async (data: PlanData) => {
    if (launched) return;
    launched = true;
    remove(id);
    await expectRun(planId, req.dir, { mode: data.mode, ticketId: data.ticketId }).catch(() => {});
    // Recorded before the launch: a restart after this point must not start a
    // second agent for the same approval.
    await revisePlan(req.dir, planId, () => ({ data: { launchedAt: Date.now() } })).catch(() => null);
    await launch(planBrief({ ...data, request: full }), planId);
    armed.delete(planId);
    finish();
  };
  // Approval can also arrive from team chat (the shared plan card): the
  // ledger hears the status change, and the waiting launch goes ahead.
  const stopWatching = subscribeLedger(entry.root || req.dir, (e) => {
    const d = e.data as Partial<PlanData> | undefined;
    if (e.kind === "plan" && d?.planId === planId && e.status === "approved") void go(e.data as PlanData);
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
      const next = await revisePlan(req.dir, planId, () => ({
        status: "approved",
        data: { decisions: data.decisions, acceptance: data.acceptance, approvedBy: data.approvedBy, approvedAt: data.approvedAt },
      })).catch(() => null);
      await go(next?.data ?? data);
    },
    drop: () => {
      if (launched) return;
      launched = true;
      remove(id);
      armed.delete(planId);
      finish();
      void revisePlan(req.dir, planId, () => ({ status: "dropped" })).catch(() => {});
    },
  });
  put({ id, phase: "approval", req, entry, ...(waiting ? { waiting } : {}) });
  return finished;
}

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
  const clipped = req.request.length > REQUEST_KEEP;
  const launchSpec: PlanLaunchSpec | undefined = req.resume
    ? { kind: req.resume.kind, payload: req.resume.payload, ...(clipped ? { request: req.request } : {}) }
    : undefined;
  const base: PlanData = {
    ...draft,
    planId: newPlanId(),
    request: clipped ? `${req.request.slice(0, REQUEST_KEEP - 1)}…` : req.request,
    ...(req.label ? { label: req.label } : {}),
    dir: req.dir,
    source: req.source,
    ...(req.mode ? { mode: req.mode } : {}),
    ...(req.ticketId ? { ticketId: req.ticketId } : {}),
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
    await expectRun(data.planId, req.dir, { mode: req.mode, ticketId: req.ticketId }).catch(() => {});
    await start(briefFor(data), data.planId);
    return;
  }

  settled = true;
  const entry = await persist(launchSpec ? { ...base, launch: launchSpec } : base, "proposed");
  await armApproval(id, req, entry, (brief, planId) => start(brief, planId));
}

// ---------------------------------------------------------------- restore

/** Idempotent (a plan already armed here, or already launched, is left
 *  alone), so a surface can call it again when another resumer comes up.
 *
 *  After a restart: put the plans made on this machine that still wait for
 *  approval back on screen (tucked in the corner), armed to launch through
 *  the surface's resumer when someone approves; and launch the ones approved
 *  in team chat while Canopy was closed. `resumer` maps a launch kind to the
 *  surface's launcher; kinds it does not know are left alone. */
export async function restoreWaitingPlans(
  dirs: readonly string[],
  resumer: (kind: string) => PlanResumer | undefined,
): Promise<void> {
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir) continue;
    const rows = await queryLedger<PlanData>(dir, { kinds: ["plan"], limit: 500 }).catch(() => [] as PlanEntry[]);
    for (const entry of rows) {
      const data = entry.data;
      if (!data?.planId || !data.launch || seen.has(data.planId) || armed.has(data.planId)) continue;
      seen.add(data.planId);
      // Only plans dispatched from this computer: the ledger may hold a
      // teammate's, whose agent is theirs to start.
      if (!madeHere(data.planId)) continue;
      const resume = resumer(data.launch.kind);
      if (!resume) continue;
      const req: DispatchRequest = {
        request: data.launch.request ?? data.request,
        dir: data.dir,
        ...(data.label ? { label: data.label } : {}),
        source: data.source,
        ...(data.mode ? { mode: data.mode } : {}),
        ...(data.ticketId ? { ticketId: data.ticketId } : {}),
        resume: { kind: data.launch.kind, payload: data.launch.payload },
      };
      const launch = async (brief: string, planId: string) => {
        try {
          await resume(brief, planId, data.launch!.payload);
        } catch {
          // The surface reports its own launch failures.
        }
      };
      const id = `gate-${++seq}`;
      if (entry.status === "proposed") {
        void armApproval(id, req, entry, launch, true);
      } else if (entry.status === "approved" && !data.launchedAt && !data.sessionId) {
        // Approved (in team chat) while this window was closed.
        armed.add(data.planId);
        void (async () => {
          await expectRun(data.planId, data.dir, { mode: data.mode, ticketId: data.ticketId }).catch(() => {});
          await revisePlan(data.dir, data.planId, () => ({ data: { launchedAt: Date.now() } })).catch(() => null);
          await launch(planBrief({ ...data, request: req.request }), data.planId);
          armed.delete(data.planId);
        })();
      }
    }
  }
}

/** Tests only. */
export function resetPlanGateForTests(): void {
  for (const id of [...handlers.keys()]) handlers.get(id)?.dispose?.();
  items = [];
  handlers.clear();
  listeners.clear();
  armed.clear();
  seq = 0;
}

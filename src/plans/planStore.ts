// Plans in the ledger: create, revise, link to the agent session that runs
// them, record decisions made mid-run, and take approvals that arrive from
// team chat.
//
// A plan is one `plan` ledger entry whose chain evolves: proposed → approved →
// in-progress → done (or dropped). The ledger's own `setLedgerStatus` copies
// an entry unchanged but for its status; a plan also changes its *data* (the
// session it got linked to, a decision answered mid-run, the commits it made),
// so revisions append a successor with `supersedes` set to the current head —
// the same chain the ledger folds. `data.planId` stays fixed across the chain,
// because ledger ids do not.
//
// Revisions for one plan are serialised: two successors of the same head
// would fork the chain into two heads.

import * as ipc from "../ipc";
import { appendLedger, queryLedger, type LedgerEntry } from "../ledger";
import { onAgentSessionEnd, onAgentTurnEnd, onAgentTurnStart, type AgentTurnStart } from "../agentTurns";
import { receiptFor, subscribeReceipts } from "../receipts/store";
import {
  PLAN_ID,
  planIdInPrompt,
  settleWithRecommendations,
  type PlanData,
  type PlanDecision,
  type PlanRunMode,
  type PlanStatus,
} from "./plan";

export type PlanEntry = LedgerEntry<PlanData>;

/** Latest head per planId, as this window last wrote or read it. */
const heads = new Map<string, PlanEntry>();
const queues = new Map<string, Promise<unknown>>();

function remember(entry: PlanEntry): PlanEntry {
  if (entry?.data?.planId) heads.set(entry.data.planId, entry);
  return entry;
}

// Where each plan made on this machine lives, so a chat card (which names a
// plan by id and never by a path on anyone's disk) can find its ledger again
// after a reload.
const DIRS_KEY = "canopy:plan-dirs";
function readDirs(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(DIRS_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function rememberDir(planId: string, dir: string): void {
  try {
    const all = readDirs();
    all[planId] = dir;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 300))) delete all[k];
    localStorage.setItem(DIRS_KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: chat approvals then work only while this window lives.
  }
}
/** The checkout a plan made here was dispatched in, or null for one that was
 *  not made on this machine. */
export function planDir(planId: string): string | null {
  return heads.get(planId)?.data.dir ?? readDirs()[planId] ?? null;
}

/** Was this plan dispatched from this computer? */
export const madeHere = (planId: string): boolean => planId in readDirs();

export async function createPlan(data: PlanData, status: PlanStatus): Promise<PlanEntry> {
  const entry = await appendLedger<PlanData>(data.dir, {
    kind: "plan",
    author: { kind: "brain", name: "plan" },
    scope: "project",
    subject: data.goal,
    // Until a session runs it, the plan is its own subject; linking re-points
    // `ref` at the session so receipts (ref = session) and plans meet.
    ref: { kind: "plan", id: data.planId },
    data,
    status,
  });
  rememberDir(data.planId, data.dir);
  return remember(entry);
}

/** The current head for `planId` in the repo containing `dir`. */
export async function findPlan(dir: string, planId: string): Promise<PlanEntry | null> {
  const known = heads.get(planId);
  if (known) return known;
  const rows = await queryLedger<PlanData>(dir, { kinds: ["plan"], limit: 1000 }).catch(() => []);
  const hit = rows.find((r) => r.data?.planId === planId) ?? null;
  return hit ? remember(hit) : null;
}

/** Append a successor with `patch` merged into data (and `status`, if given).
 *  `mutate` sees the current head so read-modify-write stays inside the
 *  queue. Resolves with the new head, or null when the plan is unknown. */
export function revisePlan(
  dir: string,
  planId: string,
  mutate: (current: PlanEntry) => { data?: Partial<PlanData>; status?: PlanStatus; ref?: { kind: string; id: string } } | null,
): Promise<PlanEntry | null> {
  const prev = queues.get(planId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      const current = await findPlan(dir, planId);
      if (!current) return null;
      const change = mutate(current);
      if (!change) return current;
      const entry = await appendLedger<PlanData>(current.root || dir, {
        kind: "plan",
        author: current.author,
        scope: current.scope,
        subject: change.data?.goal ?? current.subject,
        ref: change.ref ?? current.ref,
        data: { ...current.data, ...change.data },
        status: change.status ?? current.status,
        supersedes: current.id,
      });
      return remember(entry);
    });
  queues.set(planId, next);
  return next;
}

export const setPlanStatus = (dir: string, planId: string, status: PlanStatus, data?: Partial<PlanData>) =>
  revisePlan(dir, planId, () => ({ status, data }));

/** Plans linked to an agent session (the receipts feature uses the same ref). */
export async function plansForSession(dir: string, sessionId: string): Promise<PlanEntry[]> {
  return queryLedger<PlanData>(dir, { kinds: ["plan"], refKind: "session", refId: sessionId }).catch(() => []);
}

// ------------------------------------------------------------- run linking
//
// The plan is written before the agent exists, so it learns its session when
// the agent's first turn starts. The plan id travels explicitly: every planned
// launch sets CANOPY_PLAN_ID (planLaunch.ts), canopy-hook stamps it on each
// event, and the turn carries it as `planId` — a brief parked in a file links
// the same as one typed whole. A launch that cannot set env for its turn (a
// message into a running Build session) still carries the brief's
// `[Canopy plan <id>]` mark in the prompt itself. Nothing is inferred from the
// folder or the time.
//
// A run ends one of two ways. A one-shot task is done when its turn ends. An
// interactive session (a ticket's terminal, Build chat) keeps the plan in
// progress across turns, and is done when the person marks the ticket done,
// the session ends, or a receipt proves every acceptance check.

interface RunInfo {
  dir: string;
  /** Where the agent actually runs, when not `dir` (a ticket's worktree). */
  workDir?: string;
  mode?: PlanRunMode;
  ticketId?: string;
  sessionId?: string;
  ptyId?: number | null;
}
/** planId → its run, for plans dispatched from this machine. Persisted, so
 *  a ticket marked done or a receipt after a restart still finds the plan. */
const RUNS_KEY = "canopy:plan-runs";
function readRuns(): Record<string, RunInfo> {
  try {
    const v = JSON.parse(localStorage.getItem(RUNS_KEY) ?? "{}") as unknown;
    return v && typeof v === "object" ? (v as Record<string, RunInfo>) : {};
  } catch {
    return {};
  }
}
function writeRun(planId: string, info: RunInfo | null): void {
  try {
    const all = readRuns();
    if (info) all[planId] = info;
    else delete all[planId];
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete all[k];
    localStorage.setItem(RUNS_KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: this window still tracks its own runs below.
  }
}
const runs = new Map<string, RunInfo>();
const runOf = (planId: string): RunInfo | undefined => runs.get(planId) ?? readRuns()[planId];
function setRun(planId: string, patch: Partial<RunInfo> & { dir?: string }): RunInfo {
  const cur = runOf(planId);
  const next = { ...(cur ?? { dir: patch.dir ?? "" }), ...patch } as RunInfo;
  runs.set(planId, next);
  writeRun(planId, next);
  return next;
}
function endRun(planId: string): void {
  runs.delete(planId);
  writeRun(planId, null);
}

/** sessionId → planId, and ptyId → planId, for runs linked in this window. */
const bySession = new Map<string, string>();
const byPty = new Map<number, string>();

const norm = (p: string) => p.replace(/[\\/]+$/, "");
const sameDir = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
};

async function headSha(dir: string): Promise<string | undefined> {
  return ipc
    .gitLog(dir, 1)
    .then((c) => c[0]?.hash)
    .catch(() => undefined);
}

/** Note that `planId` was just dispatched in `dir`, and remember HEAD so the
 *  run's commits can be told apart from what was already there. */
export async function expectRun(
  planId: string,
  dir: string,
  opts: { mode?: PlanRunMode; ticketId?: string } = {},
): Promise<void> {
  armPlanTracking();
  const cur = runOf(planId);
  setRun(planId, {
    // The first directory is where the plan's record lives; a later one (the
    // ticket's worktree) is only where the agent runs.
    dir: cur?.dir || dir,
    ...(cur?.dir && cur.dir !== dir ? { workDir: dir } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.ticketId ? { ticketId: opts.ticketId } : {}),
  });
  rememberDir(planId, cur?.dir || dir);
  const baseHead = await headSha(dir);
  // The run's own checkout decides: a ticket's worktree starts from its branch.
  if (baseHead) await revisePlan(cur?.dir || dir, planId, () => ({ data: { baseHead } }));
}

/** The plan a turn belongs to: the id its session was launched with, or the
 *  mark its prompt carries. */
export const turnPlanId = (turn: { planId?: string; prompt?: string }): string | null =>
  (turn.planId && PLAN_ID.test(turn.planId) ? turn.planId : null) ?? planIdInPrompt(turn.prompt);

export async function linkTurnStart(turn: AgentTurnStart): Promise<void> {
  const planId = turnPlanId(turn);
  if (!planId || bySession.get(turn.sessionId) === planId) return;
  const run = runOf(planId);
  // A plan has one run: a second session claiming it (a copied brief) is not it.
  if (run?.sessionId && run.sessionId !== turn.sessionId) return;
  // One conversation carrying plan after plan (Build chat): the person moving
  // on to the next planned request is the previous one finished.
  const before = planForSession(turn.sessionId);
  if (before && before !== planId) void completePlanRun(before, "the next planned request started").catch(() => null);
  bySession.set(turn.sessionId, planId);
  if (turn.ptyId != null) byPty.set(turn.ptyId, planId);
  const dir = run?.dir || planDir(planId) || turn.cwd;
  setRun(planId, { dir, sessionId: turn.sessionId, ptyId: turn.ptyId });
  await revisePlan(dir, planId, (cur) =>
    cur.data.sessionId === turn.sessionId && cur.status !== "approved" && cur.status !== "proposed"
      ? null
      : {
          status: cur.status === "done" ? "done" : "in-progress",
          ref: { kind: "session", id: turn.sessionId },
          data: { sessionId: turn.sessionId, ptyId: turn.ptyId, startedAt: cur.data.startedAt ?? turn.startedAt },
        },
  );
}

/** Commits between the run's starting HEAD and now, newest first. */
async function runCommits(dir: string, baseHead: string | undefined): Promise<{ sha: string; subject: string }[]> {
  if (!baseHead) return [];
  const log = await ipc.gitLog(dir, 60).catch(() => [] as ipc.CommitInfo[]);
  const out: { sha: string; subject: string }[] = [];
  for (const c of log) {
    if (c.hash === baseHead) return out;
    out.push({ sha: c.hash, subject: c.subject });
  }
  // HEAD moved somewhere unrelated (a branch switch): claim nothing.
  return [];
}

const planForSession = (sessionId: string, planId?: string | null): string | null =>
  bySession.get(sessionId) ??
  (planId && PLAN_ID.test(planId) ? planId : null) ??
  Object.entries(readRuns()).find(([, r]) => r.sessionId === sessionId)?.[0] ??
  null;

export async function linkTurnEnd(turn: {
  sessionId: string;
  cwd: string;
  endedAt: number;
  planId?: string;
  prompt?: string;
}): Promise<void> {
  const planId = planForSession(turn.sessionId, turnPlanId(turn));
  if (!planId) return;
  const run = runOf(planId);
  const dir = run?.dir || planDir(planId) || turn.cwd;
  const current = await findPlan(dir, planId);
  if (!current || current.data.sessionId !== turn.sessionId) return;
  const commits = await runCommits(run?.workDir || current.data.dir || turn.cwd, current.data.baseHead);
  const interactive = (run?.mode ?? current.data.mode) === "interactive";
  await revisePlan(dir, planId, (cur) =>
    interactive
      ? // An interactive session's turn ending is not the work ending: the
        // person may well say "now the other half". Keep the commits current.
        commits.length
        ? { data: { commits } }
        : null
      : {
          status: "done",
          data: { endedAt: turn.endedAt, doneBecause: cur.data.doneBecause ?? "the task finished", ...(commits.length ? { commits } : {}) },
        },
  );
  if (!interactive) endRun(planId);
}

/** Mark an interactive run's plan done, once, saying why. */
export async function completePlanRun(planId: string, why: string, now = Date.now()): Promise<PlanEntry | null> {
  const run = runOf(planId);
  const dir = run?.dir || planDir(planId);
  if (!dir) return null;
  const current = await findPlan(dir, planId);
  if (!current) return null;
  const commits = await runCommits(run?.workDir || current.data.dir || dir, current.data.baseHead);
  const next = await revisePlan(dir, planId, (cur) =>
    cur.status === "done" || cur.status === "dropped"
      ? null
      : { status: "done", data: { endedAt: now, doneBecause: why, ...(commits.length ? { commits } : {}) } },
  );
  endRun(planId);
  return next;
}

/** The person marked a ticket done: every plan running for it is done. */
export async function completeTicketPlans(ticketId: string): Promise<void> {
  if (!ticketId) return;
  const ids = new Set<string>();
  for (const [id, r] of runs) if (r.ticketId === ticketId) ids.add(id);
  for (const [id, r] of Object.entries(readRuns())) if (r.ticketId === ticketId) ids.add(id);
  for (const id of ids) await completePlanRun(id, "the ticket was marked done").catch(() => null);
}

/** The agent session ended (its CLI exited, or its terminal closed). */
export async function completeSessionPlan(sessionId: string, planId?: string | null): Promise<void> {
  const id = planForSession(sessionId, planId);
  if (!id || runOf(id)?.sessionId !== sessionId) return;
  await completePlanRun(id, "the agent session ended");
}

/** A receipt arrived for a session running an interactive plan: if it is
 *  Proven and the brain found every acceptance check met, the work is done. */
export async function notePlanReceipt(r: {
  sessionId: string;
  status: string;
  verdict?: { acceptance?: { met: boolean | null }[] } | null;
}): Promise<void> {
  const id = planForSession(r.sessionId);
  if (!id) return;
  const run = runOf(id);
  if (!run || run.sessionId !== r.sessionId || run.mode !== "interactive") return;
  if (r.status !== "proven") return;
  const current = await findPlan(run.dir, id);
  if (!current) return;
  const checks = r.verdict?.acceptance ?? [];
  // A plan with acceptance checks needs each one judged met; one without any
  // is proven by the receipt itself.
  if (current.data.acceptance.length && (checks.length < current.data.acceptance.length || !checks.every((c) => c.met === true)))
    return;
  await completePlanRun(id, "a proof receipt showed every acceptance check met");
}

let armed = false;
/** Start following agent turns, session ends, closed terminals and receipts.
 *  Idempotent; called on first dispatch and by App on start. */
export function armPlanTracking(): void {
  if (armed) return;
  armed = true;
  onAgentTurnStart((t) => void linkTurnStart(t).catch(() => {}));
  onAgentTurnEnd((t) => void linkTurnEnd(t).catch(() => {}));
  onAgentSessionEnd((e) => void completeSessionPlan(e.sessionId, e.planId).catch(() => {}));
  // A terminal closing is the session ending for CLIs without a SessionEnd hook.
  void Promise.resolve()
    .then(() =>
      ipc.onPtyExit?.((e) => {
        const planId = byPty.get(e.id);
        const run = planId ? runOf(planId) : undefined;
        if (planId && run?.sessionId) void completeSessionPlan(run.sessionId, planId).catch(() => {});
      }),
    )
    .catch(() => {});
  const seen = new Map<string, string>();
  subscribeReceipts(() => {
    for (const [sessionId] of bySession) {
      const state = receiptFor(sessionId);
      if (state?.state !== "done" || seen.get(sessionId) === state.record.id) continue;
      seen.set(sessionId, state.record.id);
      void notePlanReceipt(state.record).catch(() => {});
    }
  });
}

// ------------------------------------------------------ mid-run decisions

const SKIPPED = "(the user skipped this question — decide for yourself)";

/** An agent asked the person something through canopy_ask_user and got an
 *  answer. When that agent is running a plan, the answer is a decision the
 *  plan did not foresee: record it on the plan, so the plan stays the record
 *  of what was decided and the reviewer sees it. */
export async function notePlanQuestionAnswered(q: {
  ptyId: number | null | undefined;
  route: string;
  question: string;
  options: string[];
  answer: string;
}): Promise<PlanEntry | null> {
  let planId = q.ptyId != null ? byPty.get(q.ptyId) : undefined;
  if (!planId) {
    // A run linked before a reload, or by a CLI whose hooks carry no pty:
    // the most recent in-progress plan in that checkout.
    const rows = await queryLedger<PlanData>(q.route, { kinds: ["plan"], limit: 200 }).catch(() => []);
    const live = rows.find(
      (r) =>
        r.status === "in-progress" &&
        (q.ptyId == null || r.data?.ptyId == null || r.data.ptyId === q.ptyId) &&
        sameDir(r.data?.dir ?? "", q.route),
    );
    if (live) {
      remember(live);
      planId = live.data.planId;
    }
  }
  if (!planId) return null;
  const decision: PlanDecision = {
    question: q.question.slice(0, 300),
    options: q.options.slice(0, 5).map((o) => o.slice(0, 160)),
    recommended: "",
    why: "The agent asked while working: the plan had not settled this.",
    answer: q.answer === SKIPPED ? "Left to the agent" : q.answer.slice(0, 300),
    source: "mid-run",
  };
  return revisePlan(q.route, planId, (cur) => ({ data: { decisions: [...cur.data.decisions, decision] } }));
}

// ------------------------------------------------------- chat approvals

/** A teammate approved a shared plan in team chat. Only a plan still waiting
 *  moves; one already approved, running or done keeps its state. And only an
 *  approver the author named when sharing can move it: anyone else in the
 *  conversation can comment, but their "approve" is not an approval. */
export async function applyChatApproval(planId: string, by: { id: string; name: string }): Promise<PlanEntry | null> {
  const dir = planDir(planId);
  if (!dir) return null;
  return revisePlan(dir, planId, (cur) =>
    cur.status === "proposed" && (cur.data.approvers ?? []).includes(by.id)
      ? {
          status: "approved",
          // The teammate approved the plan as shared, and the card showed each
          // open decision at its recommendation: that is what was approved.
          data: {
            decisions: settleWithRecommendations(cur.data.decisions),
            approvedBy: `${by.name} (team chat)`,
            approvedAt: Date.now(),
          },
        }
      : null,
  );
}

/** Tests only. */
export function resetPlanStoreForTests(): void {
  heads.clear();
  queues.clear();
  runs.clear();
  bySession.clear();
  byPty.clear();
  armed = false;
}

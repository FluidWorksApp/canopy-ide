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
import { onAgentTurnEnd, onAgentTurnStart, type AgentTurnStart } from "../agentTurns";
import { planIdInPrompt, type PlanData, type PlanDecision, type PlanStatus } from "./plan";

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
// the agent's first turn starts. The brief carries `[Canopy plan <id>]`, which
// links exactly when the prompt reaches the hook. A brief too long for the
// shell is parked in a file and the turn sees only a pointer, so a dispatch
// also waits by directory: the first unclaimed turn in that checkout within a
// few minutes is its run.

interface Pending {
  planId: string;
  dir: string;
  at: number;
}
const pending: Pending[] = [];
/** sessionId → planId, and ptyId → planId, for runs linked in this window. */
const bySession = new Map<string, string>();
const byPty = new Map<number, string>();
const PENDING_MS = 10 * 60_000;

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
export async function expectRun(planId: string, dir: string, now = Date.now()): Promise<void> {
  armPlanTracking();
  pending.push({ planId, dir, at: now });
  const baseHead = await headSha(dir);
  if (baseHead) await revisePlan(dir, planId, () => ({ data: { baseHead } }));
}

function claim(turn: AgentTurnStart, now: number): Pending | null {
  for (let i = pending.length - 1; i >= 0; i--) if (now - pending[i].at > PENDING_MS) pending.splice(i, 1);
  const marked = planIdInPrompt(turn.prompt);
  let i = marked ? pending.findIndex((p) => p.planId === marked) : -1;
  if (i < 0 && marked) return { planId: marked, dir: turn.cwd, at: now };
  if (i < 0) i = pending.findIndex((p) => sameDir(p.dir, turn.cwd));
  if (i < 0) return null;
  return pending.splice(i, 1)[0];
}

export async function linkTurnStart(turn: AgentTurnStart, now = Date.now()): Promise<void> {
  if (bySession.has(turn.sessionId)) return;
  const hit = claim(turn, now);
  if (!hit) return;
  bySession.set(turn.sessionId, hit.planId);
  if (turn.ptyId != null) byPty.set(turn.ptyId, hit.planId);
  await revisePlan(hit.dir, hit.planId, (cur) => ({
    status: cur.status === "done" ? "done" : "in-progress",
    ref: { kind: "session", id: turn.sessionId },
    data: { sessionId: turn.sessionId, ptyId: turn.ptyId, startedAt: turn.startedAt },
  }));
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

export async function linkTurnEnd(turn: { sessionId: string; cwd: string; endedAt: number }): Promise<void> {
  const planId = bySession.get(turn.sessionId);
  if (!planId) return;
  const current = await findPlan(turn.cwd, planId);
  if (!current) return;
  const commits = await runCommits(current.data.dir || turn.cwd, current.data.baseHead);
  await revisePlan(turn.cwd, planId, () => ({
    status: "done",
    data: { endedAt: turn.endedAt, ...(commits.length ? { commits } : {}) },
  }));
}

let armed = false;
/** Start following agent turns. Idempotent; called on first dispatch. */
export function armPlanTracking(): void {
  if (armed) return;
  armed = true;
  onAgentTurnStart((t) => void linkTurnStart(t).catch(() => {}));
  onAgentTurnEnd((t) => void linkTurnEnd(t).catch(() => {}));
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
 *  moves; one already approved, running or done keeps its state. */
export async function applyChatApproval(planId: string, by: string): Promise<PlanEntry | null> {
  const dir = planDir(planId);
  if (!dir) return null;
  return revisePlan(dir, planId, (cur) =>
    cur.status === "proposed"
      ? { status: "approved", data: { approvedBy: `${by} (team chat)`, approvedAt: Date.now() } }
      : null,
  );
}

/** Tests only. */
export function resetPlanStoreForTests(): void {
  heads.clear();
  queues.clear();
  pending.length = 0;
  bySession.clear();
  byPty.clear();
  armed = false;
}

// Budgets for agent sessions: warn at 80%, pause politely at 100%.
//
// Where a budget comes from, first match wins:
//   1. the session's own — "Budget $5" anywhere in a prompt to it, or set in
//      its tab header;
//   2. its plan's — `budgetUsd` on the plan ledger entry that refs the session;
//   3. the defaults in Settings — the per-session budget, and for a session in
//      a Build-lens (prototype) project the prototype cap; the lower applies.
//
// Pausing uses the one interrupt every agent CLI already honours: Esc in its
// terminal, the same keystroke the pending panel's Deny sends. It stops the
// agent's current step without killing the session, so raising the budget
// and saying "continue" picks up where it was. It is sent once per turn —
// never a stream of keystrokes into a terminal the user may be typing in —
// and only when Canopy knows the agent's terminal. A CLI whose hooks cannot
// name its terminal gets a loud notice instead, and its tab is marked over
// budget.

import { createChannel, useChannel } from "../channel";
import type { AttentionInput } from "../attention";
import type * as ipc from "../ipc";
import { getSettings } from "../settings";
import { sessionCost } from "../pricing";
import type { AgentTurnEnd, AgentTurnStart } from "../agentTurns";

export const WARN_AT = 0.8;
/** How often a session in the middle of a turn has its spend re-read. A long
 *  autonomous turn is exactly where an overnight bill comes from. */
export const ACTIVE_POLL_MS = 45_000;

export type BudgetSource = "session" | "plan" | "default" | "prototype";
export type BudgetLevel = "none" | "ok" | "warn" | "over";

export interface ResolvedBudget {
  usd: number;
  source: BudgetSource;
}

export interface SessionBudgetState {
  sessionId: string;
  ptyId: number | null;
  cli: string;
  cwd: string;
  root: string;
  costUsd: number;
  budget: ResolvedBudget | null;
  level: BudgetLevel;
  /** A turn is in progress (start seen, no end yet). */
  active: boolean;
  /** Esc was sent during the current turn. */
  pausedThisTurn: boolean;
  /** The budget figure the 80% warning was last raised for. */
  warnedFor: number | null;
  /** The budget figure the over-budget notice was last raised for. */
  overFor: number | null;
}

// ------------------------------------------------------------ pure parts

/** "Budget $5", "budget: $12.50", "budget of $3" in a prompt. */
export function parseBudget(prompt: string | undefined | null): number | null {
  if (!prompt) return null;
  const m = /\bbudget\s*(?:of|:|=|is)?\s*\$\s*(\d{1,6}(?:\.\d{1,2})?)\b/i.exec(prompt);
  if (!m) return null;
  const usd = Number(m[1]);
  return Number.isFinite(usd) && usd > 0 ? usd : null;
}

export function resolveBudget(opts: {
  session?: number | null;
  plan?: number | null;
  isPrototype: boolean;
  defaultUsd: number | null;
  prototypeCapUsd: number | null;
}): ResolvedBudget | null {
  if (opts.session != null && opts.session > 0) return { usd: opts.session, source: "session" };
  if (opts.plan != null && opts.plan > 0) return { usd: opts.plan, source: "plan" };
  const def = opts.defaultUsd != null && opts.defaultUsd > 0 ? opts.defaultUsd : null;
  const cap =
    opts.isPrototype && opts.prototypeCapUsd != null && opts.prototypeCapUsd > 0
      ? opts.prototypeCapUsd
      : null;
  if (def != null && (cap == null || def <= cap)) return { usd: def, source: "default" };
  if (cap != null) return { usd: cap, source: "prototype" };
  return null;
}

export function budgetLevel(costUsd: number, budget: ResolvedBudget | null): BudgetLevel {
  if (!budget) return "none";
  const ratio = costUsd / budget.usd;
  if (ratio >= 1) return "over";
  if (ratio >= WARN_AT) return "warn";
  return "ok";
}

export const fmtUsd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

// ------------------------------------------------------------ session budgets

const KEY = "canopy.sessionBudgets";

function readStore(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).filter(([, n]) => typeof n === "number" && Number.isFinite(n) && n > 0),
    ) as Record<string, number>;
  } catch {
    return {};
  }
}

/** The budget set on this session itself, if any. */
export const sessionBudget = (sessionId: string): number | null => readStore()[sessionId] ?? null;

/** Set (or clear, with null) a session's own budget. Kept to the newest 500
 *  sessions so the store cannot grow without bound. */
export function storeSessionBudget(sessionId: string, usd: number | null): void {
  const all = readStore();
  delete all[sessionId];
  if (usd != null && usd > 0) all[sessionId] = usd;
  const kept = Object.fromEntries(Object.entries(all).slice(-500));
  try {
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // Storage blocked: the monitor's in-memory state still holds it.
  }
}

// ------------------------------------------------------------ the monitor

export interface BudgetDeps {
  usage(): Promise<ipc.AgentSessionUsage[]>;
  ptyWrite(ptyId: number, data: string): Promise<void> | void;
  notify(input: AttentionInput): void;
  resolveNotice(dedupeKey: string): void;
  /** Is this cwd inside a Build-lens (prototype) project? */
  isPrototype(cwd: string): boolean;
  /** The budget on the plan that refs this session, if any. */
  planBudget(root: string, sessionId: string): Promise<number | null>;
  /** The project the session's cwd belongs to, for the notice's label. */
  projectFor?(cwd: string): { id: string; name: string } | null;
}

const states = createChannel<ReadonlyMap<string, SessionBudgetState>>(new Map());

/** One session's budget state, for its tab. */
export function useSessionBudget(sessionId: string | null | undefined): SessionBudgetState | null {
  const all = useChannel(states);
  return sessionId ? (all.get(sessionId) ?? null) : null;
}

export const sessionBudgetStates = () => states.get();

let active: ReturnType<typeof createBudgetMonitor> | null = null;

/** Set a session's own budget from its tab, and re-check it now. */
export function setSessionBudget(sessionId: string, usd: number | null): void {
  storeSessionBudget(sessionId, usd);
  if (active) void active.reevaluate(sessionId);
}

export function createBudgetMonitor(deps: BudgetDeps) {
  const byId = new Map<string, SessionBudgetState>();
  const planCache = new Map<string, { at: number; usd: number | null }>();

  // Snapshots, not the live objects: a tab holding last render's state must
  // not see it change underneath it.
  const publish = () => states.set(new Map([...byId].map(([k, v]) => [k, { ...v }])));

  async function planUsd(root: string, sessionId: string): Promise<number | null> {
    const hit = planCache.get(sessionId);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.usd;
    const usd = await deps.planBudget(root, sessionId).catch(() => null);
    planCache.set(sessionId, { at: Date.now(), usd });
    return usd;
  }

  function ensure(t: Pick<AgentTurnStart, "sessionId" | "ptyId" | "cli" | "cwd" | "root">) {
    let s = byId.get(t.sessionId);
    if (!s) {
      s = {
        sessionId: t.sessionId,
        ptyId: t.ptyId,
        cli: t.cli,
        cwd: t.cwd,
        root: t.root,
        costUsd: 0,
        budget: null,
        level: "none",
        active: false,
        pausedThisTurn: false,
        warnedFor: null,
        overFor: null,
      };
      byId.set(t.sessionId, s);
    }
    if (t.ptyId != null) s.ptyId = t.ptyId;
    return s;
  }

  async function refreshCost(s: SessionBudgetState): Promise<void> {
    const rows = await deps.usage().catch(() => []);
    const u = rows.find((r) => r.supported && r.agent === s.cli && r.session_id === s.sessionId);
    const c = u ? sessionCost(u) : null;
    if (c != null) s.costUsd = Math.max(s.costUsd, c);
  }

  /** Re-resolve the budget and act on where the session now stands. */
  async function evaluate(s: SessionBudgetState): Promise<void> {
    const settings = getSettings();
    s.budget = resolveBudget({
      session: sessionBudget(s.sessionId),
      plan: await planUsd(s.root, s.sessionId),
      isPrototype: deps.isPrototype(s.cwd),
      defaultUsd: settings.sessionBudgetUsd,
      prototypeCapUsd: settings.builderSessionCapUsd,
    });
    s.level = budgetLevel(s.costUsd, s.budget);
    const key = `budget:${s.sessionId}`;
    const project = deps.projectFor?.(s.cwd) ?? null;
    const where = s.ptyId != null ? { where: { kind: "terminal" as const, ptyId: s.ptyId } } : {};
    const base = {
      source: "agent" as const,
      dedupeKey: key,
      ...(project ? { projectId: project.id, projectName: project.name } : {}),
      ...where,
    };
    const budgetUsd = s.budget?.usd ?? null;

    if (s.level !== "over") {
      // Raised (or spend re-read lower): the pause question is answered.
      if (s.overFor != null) {
        deps.resolveNotice(key);
        s.overFor = null;
      }
      if (s.level === "warn" && budgetUsd != null && s.warnedFor !== budgetUsd) {
        s.warnedFor = budgetUsd;
        deps.notify({
          ...base,
          dedupeKey: `${key}:warn`,
          kind: "fyi",
          tone: "warn",
          title: `Agent at ${Math.round((s.costUsd / budgetUsd) * 100)}% of its ${fmtUsd(budgetUsd)} budget`,
          body: `It has spent ${fmtUsd(s.costUsd)}. It will pause at ${fmtUsd(budgetUsd)} unless you raise the budget in its tab.`,
        });
      }
      publish();
      return;
    }

    const canPause = settings.budgetPauseAtLimit && s.ptyId != null;
    if (s.active && canPause && !s.pausedThisTurn) {
      s.pausedThisTurn = true;
      try {
        await deps.ptyWrite(s.ptyId!, "\x1b");
      } catch {
        // The terminal went away; the notice below still tells the user.
      }
      s.overFor = budgetUsd;
      deps.notify({
        ...base,
        kind: "question",
        tone: "warn",
        title: `Agent paused: it reached its ${fmtUsd(budgetUsd!)} budget`,
        body: `It has spent ${fmtUsd(s.costUsd)}. Raise the budget in its tab, then tell it to continue.`,
      });
    } else if (s.overFor !== budgetUsd) {
      s.overFor = budgetUsd;
      deps.notify({
        ...base,
        kind: "question",
        tone: "error",
        title: `Agent over its ${fmtUsd(budgetUsd!)} budget`,
        body: canPause
          ? `It has spent ${fmtUsd(s.costUsd)}. It will be paused if it starts another step — raise the budget in its tab to let it continue.`
          : `It has spent ${fmtUsd(s.costUsd)} and Canopy cannot pause this agent for you. Stop it in its terminal, or raise the budget in its tab.`,
      });
    }
    publish();
  }

  async function onTurnStart(t: AgentTurnStart): Promise<void> {
    const s = ensure(t);
    s.active = true;
    s.pausedThisTurn = false;
    // "Budget $5" in the prompt sets (or raises) this session's budget before
    // the check, so a user raising it in the prompt is not paused by the old one.
    const asked = parseBudget(t.prompt);
    if (asked != null) storeSessionBudget(t.sessionId, asked);
    await refreshCost(s);
    await evaluate(s);
  }

  async function onTurnEnd(t: AgentTurnEnd, costUsd?: number | null): Promise<void> {
    const s = ensure(t);
    s.active = false;
    if (costUsd != null) s.costUsd = Math.max(s.costUsd, costUsd);
    else await refreshCost(s);
    await evaluate(s);
  }

  /** Re-read spend for sessions mid-turn. */
  async function tick(): Promise<void> {
    for (const s of byId.values()) {
      if (!s.active) continue;
      await refreshCost(s);
      await evaluate(s);
    }
  }

  async function reevaluate(sessionId: string): Promise<void> {
    const s = byId.get(sessionId);
    if (!s) return;
    planCache.delete(sessionId);
    await evaluate(s);
  }

  const monitor = { onTurnStart, onTurnEnd, tick, reevaluate, states: () => byId };
  active = monitor;
  return monitor;
}

/** Tests only. */
export function resetBudgetsForTests(): void {
  states.reset();
  active = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}

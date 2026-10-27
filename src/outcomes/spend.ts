// Per-session cost attribution: at every agent turn end, read the session's
// usage from its own CLI store and keep one `spend` ledger record for it.
//
// There is no "session ended" event — a CLI can sit idle for a week and then
// take another prompt — so the turn end is the closest durable signal. Each
// write supersedes the session's previous record, so the ledger holds one head
// per session and a crash loses at most the last turn's delta. A write happens
// only when the numbers or the files moved; an idle turn end costs nothing.
//
// The usage store (ipc.agentUsage) is the same one the agent tab's "$12 · 40
// turns" header reads, so the panel and the header can never disagree.

import type * as ipc from "../ipc";
import type { LedgerDraft, LedgerEntry, LedgerQuery } from "../ledger";
import { sessionCost } from "../pricing";
import type { AgentTurnEnd } from "../agentTurns";
import { planClass, type PlanLike, type SpendData, type TouchedFile } from "./types";

/** Paths kept per session. A spend entry is capped at 256 KiB by the ledger;
 *  this keeps it well under, and a session that touched more than this many
 *  files is reworked by definition. */
export const MAX_FILES = 300;

export interface SpendDeps {
  usage(): Promise<ipc.AgentSessionUsage[]>;
  append<D>(root: string, draft: LedgerDraft<D>): Promise<LedgerEntry<D>>;
  query<D>(root: string, q: LedgerQuery): Promise<LedgerEntry<D>[]>;
}

/** Fold a turn's files into what the session already owned: newest ts per
 *  path, newest paths kept when over the cap. */
export function mergeFiles(prev: TouchedFile[], paths: string[], ts: number): TouchedFile[] {
  const byPath = new Map(prev.map((f) => [f.path, f.ts]));
  for (const p of paths) if (p) byPath.set(p, Math.max(byPath.get(p) ?? 0, ts));
  return [...byPath.entries()]
    .map(([path, t]) => ({ path, ts: t }))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_FILES);
}

/** Repo-relative when the path sits under the turn's root or cwd, so the same
 *  file edited from two worktrees (or the main checkout) compares equal. */
export function normalizePath(path: string, root: string, cwd: string): string {
  for (const base of [cwd, root]) {
    const b = base.replace(/[\\/]+$/, "");
    if (b && path.startsWith(`${b}/`)) return path.slice(b.length + 1);
  }
  return path.replace(/^\.\//, "");
}

/** Who a session is attributed to. */
export const personOf = (profile: string | null | undefined): string =>
  !profile || profile === "default" ? "You" : profile;

/** The spend record for `usage`, folding in what the previous record knew. */
export function buildSpend(
  turn: Pick<AgentTurnEnd, "sessionId" | "cli" | "cwd" | "root" | "filesTouched" | "startedAt" | "endedAt">,
  usage: ipc.AgentSessionUsage | null,
  prev: SpendData | null,
  plan: { id: string; data: PlanLike } | null,
): SpendData {
  const files = mergeFiles(
    prev?.files ?? [],
    turn.filesTouched.map((p) => normalizePath(p, turn.root, turn.cwd)),
    turn.endedAt,
  );
  const cost = usage ? sessionCost(usage) : null;
  return {
    type: "session",
    sessionId: turn.sessionId,
    cli: turn.cli,
    profile: usage?.profile ?? prev?.profile ?? "default",
    person: personOf(usage?.profile ?? prev?.profile),
    cwd: turn.cwd,
    // Never let a usage read that came back empty roll a session's cost back.
    costUsd: Math.max(cost ?? 0, prev?.costUsd ?? 0),
    costReported: usage ? usage.cost != null : (prev?.costReported ?? false),
    inputTokens: usage
      ? usage.input_tokens + usage.cache_read_tokens + usage.cache_creation_tokens
      : (prev?.inputTokens ?? 0),
    outputTokens: usage?.output_tokens ?? prev?.outputTokens ?? 0,
    turns: Math.max(usage?.turns ?? 0, prev?.turns ?? 0),
    model: usage?.model ?? prev?.model ?? null,
    planId: plan?.id ?? prev?.planId,
    taskClass: planClass(plan?.data) ?? prev?.taskClass,
    files,
    firstTs: prev?.firstTs ?? turn.startedAt,
    lastTs: Math.max(turn.endedAt, prev?.lastTs ?? 0),
  };
}

/** Whether `next` says anything `prev` did not — the write gate. */
export function spendChanged(prev: SpendData | null, next: SpendData): boolean {
  if (!prev) return true;
  return (
    Math.abs(prev.costUsd - next.costUsd) >= 0.005 ||
    prev.turns !== next.turns ||
    prev.outputTokens !== next.outputTokens ||
    prev.planId !== next.planId ||
    prev.files.length !== next.files.length ||
    next.files.some((f, i) => prev.files[i]?.path !== f.path || prev.files[i]?.ts !== f.ts)
  );
}

/** The usage row for a session, by id only. The agent tab falls back to "the
 *  freshest session in this cwd" for display; a ledger record must not, or two
 *  agents in one checkout would be billed for each other. */
export function usageFor(
  rows: ipc.AgentSessionUsage[],
  sessionId: string,
  cli: string,
): ipc.AgentSessionUsage | null {
  return rows.find((u) => u.supported && u.agent === cli && u.session_id === sessionId) ?? null;
}

/** The newest plan whose ref is this session, if any. */
export async function planForSession(
  deps: Pick<SpendDeps, "query">,
  root: string,
  sessionId: string,
): Promise<{ id: string; data: PlanLike } | null> {
  const rows = await deps
    .query<PlanLike>(root, { kinds: ["plan"], refKind: "session", refId: sessionId, limit: 1 })
    .catch(() => []);
  const p = rows[0];
  return p ? { id: p.id, data: (p.data ?? {}) as PlanLike } : null;
}

/** Records spend per session. Holds the last head it wrote per session so a
 *  turn end normally costs one usage read and, at most, one append. */
export function createSpendRecorder(deps: SpendDeps) {
  const heads = new Map<string, LedgerEntry<SpendData>>();

  async function previous(root: string, sessionId: string): Promise<LedgerEntry<SpendData> | null> {
    const cached = heads.get(sessionId);
    if (cached) return cached;
    const rows = await deps
      .query<SpendData>(root, { kinds: ["spend"], refKind: "session", refId: sessionId, limit: 5 })
      .catch(() => []);
    return rows.find((r) => (r.data as SpendData | null)?.type === "session") ?? null;
  }

  /** Fold one turn end in. Resolves with the session's current record (written
   *  or not), or null when the ledger could not be reached. */
  async function record(
    turn: AgentTurnEnd,
    rows?: ipc.AgentSessionUsage[],
  ): Promise<SpendData | null> {
    try {
      const usageRows = rows ?? (await deps.usage().catch(() => []));
      const usage = usageFor(usageRows, turn.sessionId, turn.cli);
      const prevEntry = await previous(turn.root, turn.sessionId);
      const prev = prevEntry?.data ?? null;
      const plan = await planForSession(deps, turn.root, turn.sessionId);
      const next = buildSpend(turn, usage, prev, plan);
      if (!spendChanged(prev, next)) return next;
      const written = await deps.append<SpendData>(turn.root, {
        kind: "spend",
        author: { kind: "workspace", name: "outcomes", sessionId: turn.sessionId, cli: turn.cli },
        scope: "personal",
        subject: `Session spend $${next.costUsd.toFixed(2)}`,
        ref: { kind: "session", id: turn.sessionId },
        data: next,
        ...(prevEntry ? { supersedes: prevEntry.id } : {}),
      });
      heads.set(turn.sessionId, written);
      return next;
    } catch {
      return null;
    }
  }

  return { record, forget: () => heads.clear() };
}

// "An agent turn just started / just ended" — one subscription for features.
//
// The signal already exists: every agent CLI with Canopy's hooks reports
// UserPromptSubmit (turn start) and Stop (turn end) through canopy-hook →
// ~/.canopy/agent-events.jsonl → the app's hook bridge → `agent:events`, and
// App.tsx parses each batch once. Turn rollback (turnRollback.ts) snapshots
// off the same two events. This file adds nothing to that pipe; it listens to
// the parsed batch (App.tsx calls `observeAgentTurns` beside
// `observeTurnEvents`) and enriches the end with what features need:
//
//  * `root` — the repo's canonical root (main checkout), the same key the
//    ledger files entries under, so a turn-end handler can write straight in;
//  * `filesTouched` — from the agent's own change journal
//    (`~/.canopy/sessions/<id>.edits.jsonl`, written by canopy-hook on every
//    edit tool call), so it is attributed even on a checkout other agents
//    share. Bash-made changes are not in the journal; diff the turn-rollback
//    snapshots for those.
//
// Brain calls never appear here: brain.rs strips CANOPY* from their env, which
// is what arms canopy-hook in the first place.

import * as ipc from "./ipc";
import { eventAgentId, type AgentEventData } from "../shared/notifications";

export interface AgentTurnStart {
  /** `<sessionId>:<startedAt>` — stable for the turn, shared by its end. */
  turnId: string;
  /** The terminal the agent runs in; null when its hooks cannot carry the
   *  stamp (codex). */
  ptyId: number | null;
  sessionId: string;
  /** Agent registry id. */
  cli: string;
  cwd: string;
  /** Canonical repo root (see ledger.ts); the cwd when git cannot say. */
  root: string;
  prompt?: string;
  startedAt: number;
}

export interface AgentTurnEnd extends AgentTurnStart {
  /** Paths the agent's edit tools changed during the turn — relative to the
   *  checkout `cwd` is in when Canopy has that workspace open, absolute
   *  otherwise. */
  filesTouched: string[];
  endedAt: number;
  /** The start was not observed (the app opened mid-turn), so `startedAt` is
   *  the session's previous turn end, or `endedAt` when there is none, and
   *  `filesTouched` covers that window. */
  partial?: boolean;
}

type StartListener = (turn: AgentTurnStart) => void;
type EndListener = (turn: AgentTurnEnd) => void;

const startListeners = new Set<StartListener>();
const endListeners = new Set<EndListener>();

/** Fires after an agent's turn begins. Returns an unsubscribe. */
export function onAgentTurnStart(cb: StartListener): () => void {
  startListeners.add(cb);
  return () => {
    startListeners.delete(cb);
  };
}

/** Fires after an agent's turn ends, with what it touched. Returns an
 *  unsubscribe. */
export function onAgentTurnEnd(cb: EndListener): () => void {
  endListeners.add(cb);
  return () => {
    endListeners.delete(cb);
  };
}

// ---------------------------------------------------------------- plumbing

export interface AgentTurnDeps {
  root(cwd: string): Promise<string>;
  edits(cwd: string, sessionId: string): Promise<{ ts: number; path: string }[]>;
}

const defaultDeps: AgentTurnDeps = {
  root: (cwd) => ipc.ledgerRoot(cwd),
  edits: (cwd, sessionId) => ipc.agentEdits(cwd, sessionId),
};
let deps: AgentTurnDeps = defaultDeps;

/** Tests only: swap the lookups. Null restores the real ones. */
export function setAgentTurnDepsForTests(next: AgentTurnDeps | null): void {
  deps = next ?? defaultDeps;
}

/** Per session: the open turn, and when the last one ended. */
const open = new Map<string, AgentTurnStart>();
const lastEnd = new Map<string, number>();
/** Per-session chain, so a short turn's start is announced before its end
 *  even though each waits on an async root lookup. */
const chains = new Map<string, Promise<unknown>>();
const roots = new Map<string, Promise<string>>();

function rootOf(cwd: string): Promise<string> {
  let hit = roots.get(cwd);
  if (!hit) {
    hit = deps.root(cwd).catch(() => cwd);
    roots.set(cwd, hit);
  }
  return hit;
}

function emit<T>(listeners: Set<(t: T) => void>, turn: T): void {
  for (const cb of listeners) {
    try {
      cb(turn);
    } catch {
      // One feature's bug must not cost the others their event.
    }
  }
}

/** Journal timestamps are whole seconds; a turn's window is in ms. One second
 *  of slack on each side, because the observed time is the hook bridge's
 *  batch time (up to ~500ms after the hook ran). */
export function filesInWindow(
  edits: readonly { ts: number; path: string }[],
  startedAt: number,
  endedAt: number,
): string[] {
  const from = Math.floor(startedAt / 1000) - 1;
  const to = Math.ceil(endedAt / 1000) + 1;
  const seen = new Set<string>();
  for (const e of edits) {
    if (e.path && e.ts >= from && e.ts <= to) seen.add(e.path);
  }
  return [...seen];
}

/** Called by App.tsx with each parsed hook-bridge batch. */
export function observeAgentTurns(
  events: readonly (AgentEventData | null)[],
  observedMs: number = Date.now(),
): void {
  for (const e of events) {
    if (!e || !e.sessionId || !e.cwd) continue;
    if (e.event !== "UserPromptSubmit" && e.event !== "Stop") continue;
    const event = e;
    const sessionId = e.sessionId;
    const prev = chains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => (event.event === "UserPromptSubmit" ? start(event, observedMs) : end(event, observedMs)))
      .catch(() => {});
    chains.set(sessionId, next);
    void next.finally(() => {
      if (chains.get(sessionId) === next) chains.delete(sessionId);
    });
  }
}

async function start(e: AgentEventData, at: number): Promise<void> {
  const turn: AgentTurnStart = {
    turnId: `${e.sessionId}:${at}`,
    ptyId: e.pty,
    sessionId: e.sessionId,
    cli: eventAgentId(e),
    cwd: e.cwd,
    root: await rootOf(e.cwd),
    ...(e.prompt ? { prompt: e.prompt } : {}),
    startedAt: at,
  };
  open.set(e.sessionId, turn);
  emit(startListeners, turn);
}

async function end(e: AgentEventData, at: number): Promise<void> {
  const began = open.get(e.sessionId);
  open.delete(e.sessionId);
  const startedAt = began?.startedAt ?? lastEnd.get(e.sessionId) ?? at;
  lastEnd.set(e.sessionId, at);
  const root = began?.root ?? (await rootOf(e.cwd));
  // The cwd, not the root: the journal relativises paths to the checkout the
  // agent works in, which for a linked worktree is not the main checkout.
  const edits = await deps.edits(e.cwd, e.sessionId).catch(() => []);
  const turn: AgentTurnEnd = {
    turnId: began?.turnId ?? `${e.sessionId}:${startedAt}`,
    ptyId: e.pty ?? began?.ptyId ?? null,
    sessionId: e.sessionId,
    cli: eventAgentId(e),
    cwd: e.cwd,
    root,
    ...(began?.prompt ? { prompt: began.prompt } : {}),
    startedAt,
    endedAt: at,
    filesTouched: filesInWindow(edits, startedAt, at),
    ...(began ? {} : { partial: true }),
  };
  emit(endListeners, turn);
}

/** Tests only. */
export function resetAgentTurnsForTests(): void {
  startListeners.clear();
  endListeners.clear();
  open.clear();
  lastEnd.clear();
  chains.clear();
  roots.clear();
  deps = defaultDeps;
}

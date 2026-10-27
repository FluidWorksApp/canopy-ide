// When to ask the brain what the team just learned.
//
// Turn ends come from agentTurns.ts. Extraction is debounced per session: the
// first turn end in a window is extracted at once, later ones are buffered and
// extracted together when the window closes or the session ends — so a busy
// agent costs at most one background brain call per session per
// EXTRACT_WINDOW_MS, and nothing it said is dropped on the floor.
//
// The hook bridge's raw events (App.tsx calls `observeMemoryEvents` beside
// `observeAgentTurns`) add what a turn-end does not carry: the agent's final
// message when the CLI reports one, every tool the session used (the
// untrusted-content rule, memoryLedger.ts `untrustedReason`), and SessionEnd.
//
// Agent proposals (canopy_memory_propose) are written by the Rust bridge,
// which knows nothing about a session's tool history; they are picked up off
// the ledger here, quarantined when their session read untrusted content, and
// checked for contradictions like any other new entry.

import { askBrain } from "./brainCall";
import { onAgentTurnEnd, type AgentTurnEnd } from "./agentTurns";
import { subscribeLedger, type LedgerEntry } from "./ledger";
import {
  appendMemory,
  buildContradictionPrompt,
  buildExtractionPrompt,
  contentKey,
  listMemories,
  memoryStatus,
  overlapCandidates,
  reviseMemory,
  untrustedReason,
  validateContradiction,
  validateExtraction,
  type ContradictionVerdict,
  type MemoryData,
  type MemoryEntry,
  type TurnDigest,
} from "./memoryLedger";
import { getSettings } from "./settings";
import type { AgentEventData } from "../shared/notifications";

export const EXTRACT_WINDOW_MS = 10 * 60 * 1000;
/** Buffered turns kept per session; older ones are summarised by their
 *  files alone rather than growing the prompt without bound. */
const MAX_BUFFERED_TURNS = 6;

interface PendingTurn extends TurnDigest {
  turnId: string;
}

interface SessionState {
  turns: PendingTurn[];
  untrusted: Set<string>;
  lastExtractAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastMessage?: string;
  cli?: string;
  cwd?: string;
  root?: string;
  pty?: number | null;
}

const sessions = new Map<string, SessionState>();
const sessionByPty = new Map<number, string>();

function stateFor(sessionId: string): SessionState {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { turns: [], untrusted: new Set(), lastExtractAt: 0, timer: null };
    sessions.set(sessionId, s);
  }
  return s;
}

/** What the session has read that nobody on the team wrote. Exported for the
 *  panel's tooltip and for tests. */
export function untrustedFor(sessionId: string): string[] {
  return [...(sessions.get(sessionId)?.untrusted ?? [])];
}

// --------------------------------------------------------------- events

/** Called by App.tsx with each parsed hook-bridge batch. */
export function observeMemoryEvents(events: readonly (AgentEventData | null)[]): void {
  for (const e of events) {
    if (!e || !e.sessionId) continue;
    const s = stateFor(e.sessionId);
    if (e.pty != null) {
      s.pty = e.pty;
      sessionByPty.set(e.pty, e.sessionId);
    }
    if (e.event === "PostToolUse" || e.event === "PreToolUse" || e.event === "PostToolUseFailure") {
      const why = e.tool ? untrustedReason(e.tool, e.toolCommand) : null;
      if (why) s.untrusted.add(why);
    } else if (e.event === "Stop" && e.lastAssistantMessage) {
      // Read by the turn end that this same Stop produces: agentTurns emits
      // it after an async root lookup, so this assignment always lands first.
      s.lastMessage = e.lastAssistantMessage;
    } else if (e.event === "SessionEnd") {
      void flush(e.sessionId);
    }
  }
}

// --------------------------------------------------------------- deps

export interface MemoryExtractDeps {
  ask: typeof askBrain;
  list: (root: string) => Promise<MemoryEntry[]>;
  append: typeof appendMemory;
  revise: typeof reviseMemory;
  now: () => number;
}

const realDeps: MemoryExtractDeps = {
  ask: askBrain,
  list: listMemories,
  append: appendMemory,
  revise: reviseMemory,
  now: () => Date.now(),
};
let deps = realDeps;

/** Tests only. */
export function setMemoryExtractDepsForTests(next: Partial<MemoryExtractDeps> | null): void {
  deps = next ? { ...realDeps, ...next } : realDeps;
}

// --------------------------------------------------------------- turn end

export function onTurnEnd(turn: AgentTurnEnd): void {
  if (!getSettings().memoryAutoExtract) return;
  const s = stateFor(turn.sessionId);
  s.cli = turn.cli;
  s.cwd = turn.cwd;
  s.root = turn.root;
  const finalMessage = s.lastMessage;
  s.lastMessage = undefined;
  // A turn with nothing to say (no prompt seen, no files, no final words)
  // cannot teach anything; not worth a slot in the prompt.
  if (!turn.prompt && !finalMessage && turn.filesTouched.length === 0) return;
  s.turns.push({ turnId: turn.turnId, prompt: turn.prompt, finalMessage, files: turn.filesTouched });
  if (s.turns.length > MAX_BUFFERED_TURNS) {
    const dropped = s.turns.splice(0, s.turns.length - MAX_BUFFERED_TURNS);
    s.turns[0].files = [...new Set([...dropped.flatMap((t) => t.files), ...s.turns[0].files])];
  }
  const wait = s.lastExtractAt + EXTRACT_WINDOW_MS - deps.now();
  if (wait <= 0) {
    void flush(turn.sessionId);
  } else if (!s.timer) {
    s.timer = setTimeout(() => void flush(turn.sessionId), wait);
  }
}

const inflight = new Map<string, Promise<void>>();

/** Extract whatever the session has buffered. Serialised per session. */
export function flush(sessionId: string): Promise<void> {
  const prev = inflight.get(sessionId) ?? Promise.resolve();
  const next = prev.then(() => extract(sessionId)).catch(() => {});
  inflight.set(sessionId, next);
  void next.finally(() => {
    if (inflight.get(sessionId) === next) inflight.delete(sessionId);
  });
  return next;
}

async function extract(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) return;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  const turns = s.turns.splice(0);
  if (!turns.length || !s.root || !s.cwd) return;
  const settings = getSettings();
  if (!settings.memoryAutoExtract) return;
  const untrusted = [...s.untrusted];
  // "skip" means a session that read the outside world never contributes —
  // not even to quarantine.
  if (untrusted.length && settings.memoryQuarantine === "skip") return;
  s.lastExtractAt = deps.now();

  const existing = await deps.list(s.root).catch(() => [] as MemoryEntry[]);
  const live = existing.filter((e) => ["approved", "proposed", "quarantined"].includes(memoryStatus(e)));
  const answer = await deps.ask({
    feature: "memory",
    tier: "background",
    json: true,
    cwd: s.cwd,
    prompt: buildExtractionPrompt(turns, live.map((e) => e.data.text)),
    validate: validateExtraction,
  });
  // No brain, signed out, over budget: memory simply does not accumulate.
  if (!answer.ok || !answer.value?.length) return;

  const known = new Set(live.map((e) => contentKey(e.data.text)));
  for (const m of answer.value) {
    const key = contentKey(m.text);
    if (!key || known.has(key)) continue;
    known.add(key);
    const verdict = await checkContradictions(s.cwd, m.text, m.why, existing);
    await deps
      .append(s.root, {
        ...m,
        source: "brain",
        author: { kind: "brain", name: "memory", sessionId, cli: s.cli, ...(s.pty != null ? { ptyId: s.pty } : {}) },
        provenance: {
          sessionId,
          cli: s.cli,
          turnId: turns[turns.length - 1].turnId,
          files: [...new Set(turns.flatMap((t) => t.files))].slice(0, 50),
          ...(turns[turns.length - 1].prompt ? { prompt: turns[turns.length - 1].prompt!.slice(0, 400) } : {}),
        },
        ...(untrusted.length ? { untrusted } : {}),
        ...(verdict ? { verdict } : {}),
      })
      .catch(() => {});
  }
}

/** One background call, and only when the keyword prefilter found approved
 *  entries on the same topic. */
export async function checkContradictions(
  cwd: string,
  text: string,
  why: string,
  existing: readonly MemoryEntry[],
): Promise<ContradictionVerdict | null> {
  const candidates = overlapCandidates(text, existing);
  if (!candidates.length) return null;
  const offered = candidates.map((e) => e.data.memoryId);
  const answer = await deps.ask({
    feature: "memory",
    tier: "background",
    json: true,
    cwd,
    prompt: buildContradictionPrompt(text, why, candidates),
    validate: (v) => validateContradiction(v, offered),
  });
  return answer.ok && answer.value ? answer.value : null;
}

// --------------------------------------------------------------- agent proposals

const reviewed = new Set<string>();

/** An agent proposed a memory through the MCP tool: quarantine it if its
 *  session read untrusted content, and run the contradiction check. One
 *  successor carries both, so the chain gains a single hop. */
export async function reviewProposal(entry: LedgerEntry): Promise<void> {
  if (entry.kind !== "memory" || entry.author.kind !== "agent") return;
  const data = entry.data as MemoryData | undefined;
  if (!data?.memoryId || data.checkedAt || reviewed.has(data.memoryId)) return;
  if (entry.status && entry.status !== "proposed") return;
  reviewed.add(data.memoryId);
  const sessionId =
    entry.author.sessionId ?? (entry.author.ptyId != null ? sessionByPty.get(entry.author.ptyId) : undefined);
  const untrusted = sessionId ? untrustedFor(sessionId) : [];
  const existing = await deps.list(entry.root).catch(() => [] as MemoryEntry[]);
  const verdict = await checkContradictions(entry.root, data.text, data.why ?? "", existing);
  await deps
    .revise(entry.root, data.memoryId, {
      data: {
        checkedAt: deps.now(),
        ...(verdict ?? {}),
        ...(untrusted.length ? { untrusted } : {}),
        ...(sessionId && !data.provenance?.sessionId ? { provenance: { ...data.provenance, sessionId } } : {}),
      },
      ...(untrusted.length ? { status: "quarantined" as const } : {}),
    })
    .catch(() => {});
}

// --------------------------------------------------------------- lifecycle

/** Arm turn-end extraction and proposal review. Returns a stop function. */
export function startMemory(): () => void {
  const offTurn = onAgentTurnEnd(onTurnEnd);
  const offLedger = subscribeLedger("*", (e) => void reviewProposal(e));
  return () => {
    offTurn();
    offLedger();
  };
}

/** Tests only. */
export function resetMemoryExtractForTests(): void {
  for (const s of sessions.values()) if (s.timer) clearTimeout(s.timer);
  sessions.clear();
  sessionByPty.clear();
  inflight.clear();
  reviewed.clear();
  deps = realDeps;
}

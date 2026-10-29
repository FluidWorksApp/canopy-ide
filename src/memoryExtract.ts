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
// which quarantines them on arrival when the hook marked the agent's terminal
// as having read untrusted content (gates.rs taint). They are picked up off
// the ledger here, quarantined too when this window saw the session read
// something the hook could not mark, and checked for contradictions like any
// other new entry.
//
// Every Canopy window sees the same events, so each extraction and each
// proposal review first takes a lease in the shared ledger (memoryLease.ts):
// two windows never extract the same turn.

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
import { claimLease } from "./memoryLease";
import { AUTO_TIDY_AT, maybeTidyMemory } from "./memoryConsolidate";
import { turnFileChanges, type TurnFileChange } from "./turnDiff";
import * as ipc from "./ipc";
import type { AgentEventData } from "../shared/notifications";

export const EXTRACT_WINDOW_MS = 10 * 60 * 1000;
/** With a long review queue, proposals below this confidence are not added. */
const CROWDED_MIN_CONFIDENCE = 0.75;
/** Buffered turns kept per session; older ones are summarised by their
 *  files alone rather than growing the prompt without bound. */
const MAX_BUFFERED_TURNS = 6;

interface PendingTurn extends TurnDigest {
  turnId: string;
  startedAt: number;
  endedAt: number;
  /** The transcript-tail lookup for a Stop that carried no final message. */
  pendingMessage?: Promise<string | undefined>;
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

/** The agent's closing words: the last assistant line of the transcript. */
function lastAssistantLine(lines: readonly ipc.TranscriptLine[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].role === "assistant" && lines[i].text.trim()) return lines[i].text.trim().slice(0, 4000);
  }
  return undefined;
}

// --------------------------------------------------------------- deps

export interface MemoryExtractDeps {
  ask: typeof askBrain;
  list: (root: string) => Promise<MemoryEntry[]>;
  append: typeof appendMemory;
  revise: typeof reviseMemory;
  now: () => number;
  /** Take the shared-ledger lease on `key`; false when another window has it. */
  lease: (root: string, key: string, ttlMs: number) => Promise<boolean>;
  /** The session's transcript, newest last, for a Stop without a final message. */
  transcriptTail: (sessionId: string, cli: string, roots: string[]) => Promise<ipc.TranscriptLine[]>;
  /** What the turn changed on disk between its rollback snapshots. */
  turnChanges: (t: { cwd: string; sessionId: string; startedAt: number; endedAt: number }) => Promise<TurnFileChange[] | null>;
  /** Tidy the review queue once it is long (memoryConsolidate.ts). */
  tidy: (root: string, cwd: string) => Promise<void>;
}

const realDeps: MemoryExtractDeps = {
  ask: askBrain,
  list: listMemories,
  append: appendMemory,
  revise: reviseMemory,
  now: () => Date.now(),
  lease: (root, key, ttlMs) => claimLease(root, key, ttlMs),
  transcriptTail: (sessionId, agent, roots) => ipc.sessionTranscriptTail({ sessionId, agent, roots, maxBytes: 128 * 1024 }),
  turnChanges: (t) => turnFileChanges(t),
  tidy: maybeTidyMemory,
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
  const finalMessage = s.lastMessage ?? turn.lastMessage;
  s.lastMessage = undefined;
  // Not every CLI's Stop carries the agent's closing words; its transcript
  // does. Read now, while the tail is still this turn's.
  const pendingMessage = finalMessage
    ? undefined
    : deps
        .transcriptTail(turn.sessionId, turn.cli, [...new Set([turn.root, turn.cwd])])
        .then((lines) => lastAssistantLine(lines))
        .catch(() => undefined);
  s.turns.push({
    turnId: turn.turnId,
    prompt: turn.prompt,
    finalMessage,
    files: turn.filesTouched,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    ...(pendingMessage ? { pendingMessage } : {}),
  });
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
  // Another Canopy window is extracting this session: it saw these turns too.
  if (!(await deps.lease(s.root, `session:${sessionId}`, 2 * EXTRACT_WINDOW_MS))) return;
  s.lastExtractAt = deps.now();
  const cwd = s.cwd;
  await Promise.all(
    turns.map(async (t) => {
      if (t.pendingMessage) {
        t.finalMessage = await t.pendingMessage;
        delete t.pendingMessage;
      }
      // Bash-made changes, generated files and deletions: the snapshot pair
      // sees what the edit journal could not.
      const changes = await deps.turnChanges({ cwd, sessionId, startedAt: t.startedAt, endedAt: t.endedAt }).catch(() => null);
      if (changes?.length) {
        const known = new Set(t.files.map((f) => f.replace(/\\/g, "/")));
        t.otherChanges = changes.filter((c) => !known.has(c.path)).map((c) => (c.status === "modify" ? c.path : `${c.path} (${c.status === "add" ? "new" : "deleted"})`));
      }
    }),
  );
  if (!turns.some((t) => t.prompt || t.finalMessage || t.files.length || t.otherChanges?.length)) return;

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
  // A long queue raises the bar: only what the brain is sure of joins it.
  const crowded = live.filter((e) => memoryStatus(e) !== "approved").length >= AUTO_TIDY_AT;
  let added = 0;
  for (const m of answer.value) {
    const key = contentKey(m.text);
    if (!key || known.has(key)) continue;
    if (crowded && m.confidence < CROWDED_MIN_CONFIDENCE) continue;
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
          files: [...new Set(turns.flatMap((t) => [...t.files, ...(t.otherChanges ?? []).map((f) => f.replace(/ \((new|deleted)\)$/, ""))]))].slice(0, 50),
          ...(turns[turns.length - 1].prompt ? { prompt: turns[turns.length - 1].prompt!.slice(0, 400) } : {}),
        },
        ...(untrusted.length ? { untrusted } : {}),
        ...(verdict ? { verdict } : {}),
      })
      .then(() => added++)
      .catch(() => {});
  }
  if (added) await deps.tidy(s.root, s.cwd).catch(() => {});
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
  // Proposed, or quarantined on arrival by the bridge: both still need the
  // contradiction check.
  if (entry.status && entry.status !== "proposed" && entry.status !== "quarantined") return;
  reviewed.add(data.memoryId);
  if (!(await deps.lease(entry.root, `proposal:${data.memoryId}`, EXTRACT_WINDOW_MS))) return;
  const sessionId =
    entry.author.sessionId ?? (entry.author.ptyId != null ? sessionByPty.get(entry.author.ptyId) : undefined);
  const seen = sessionId ? untrustedFor(sessionId) : [];
  const untrusted = [...new Set([...(data.untrusted ?? []), ...seen])];
  const existing = await deps.list(entry.root).catch(() => [] as MemoryEntry[]);
  const verdict = await checkContradictions(entry.root, data.text, data.why ?? "", existing);
  await deps
    .revise(entry.root, data.memoryId, {
      data: {
        checkedAt: deps.now(),
        ...(verdict ?? {}),
        ...(seen.length ? { untrusted } : {}),
        ...(sessionId && !data.provenance?.sessionId ? { provenance: { ...data.provenance, sessionId } } : {}),
      },
      ...(seen.length && entry.status !== "quarantined" ? { status: "quarantined" as const } : {}),
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

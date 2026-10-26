// Turn rollback: snapshot triggers and the timeline the agent tab draws.
//
// The snapshots themselves live in src-tauri/src/turn_rollback.rs (hidden refs
// under refs/canopy/, a temp index, nothing the user's git state can see
// change). This file decides two things:
//
//  1. WHEN to snapshot. Claude's UserPromptSubmit (turn start) and Stop (turn
//     end) already travel canopy-hook → ~/.canopy/agent-events.jsonl → the
//     app's hook bridge → `agent:events`. Taking the snapshot here, off that
//     event, keeps `git add -A` out of the blocking hook — the cost is that the
//     start snapshot can land a beat after Claude's first edit, which is why
//     every turn's END is snapshotted too and preferred when a start is late.
//
//  2. WHICH snapshot each button restores, as pure functions over the list
//     Rust returns — the part worth testing without a repo.

import * as ipc from "./ipc";
import { eventAgentId, type AgentEventData } from "../shared/notifications";
import { getSettings } from "./settings";
import { supportsTurnRollback } from "./harness";

/** Fired after a snapshot lands, so an open timeline refreshes. `detail` is
 *  the session id. */
export const TURNS_CHANGED_EVENT = "canopy:turns-changed";

/** Which boundary an event marks, if any. Only CLIs whose ledger entry wires
 *  the snapshot layer (harness.ts `supportsTurnRollback`) — Claude Code first;
 *  the others' hook names map in once their adapters exist.
 *  `StopFailure`/`SubagentStop` are not turn ends: the first is an API error
 *  mid-turn, the second a child agent. */
export function boundaryOf(
  e: Pick<AgentEventData, "event" | "agent">,
): "start" | "end" | null {
  if (!supportsTurnRollback(eventAgentId(e))) return null;
  if (e.event === "UserPromptSubmit") return "start";
  if (e.event === "Stop") return "end";
  return null;
}

/** Per-session chain, so a short turn's start and end reach Rust in order. */
const chains = new Map<string, Promise<unknown>>();

/** Called with each hook-bridge batch (App.tsx). Fire-and-forget: a snapshot
 *  that fails costs one rollback point, never the session. */
export function observeTurnEvents(
  events: readonly (AgentEventData | null)[],
  observedMs: number = Date.now(),
): void {
  if (!getSettings().turnRollback) return;
  for (const e of events) {
    if (!e || !e.sessionId || !e.cwd) continue;
    const kind = boundaryOf(e);
    if (!kind) continue;
    const sessionId = e.sessionId;
    const prev = chains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() =>
        ipc.turnSnapshot({
          cwd: e.cwd,
          sessionId,
          kind,
          prompt: kind === "start" ? e.prompt : undefined,
          observedMs,
        }),
      )
      .then((out) => {
        if (out.taken && typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent(TURNS_CHANGED_EVENT, { detail: sessionId }),
          );
        }
      })
      .catch(() => {});
    chains.set(sessionId, next);
    void next.finally(() => {
      if (chains.get(sessionId) === next) chains.delete(sessionId);
    });
  }
}

/** A headless Claude session reported one of its own checkpoint ids (the
 *  replayed user message's uuid). Recorded so a restore can call
 *  `--rewind-files` with it before the snapshot pass. */
export function recordNativeCheckpoint(sessionId: string, uuid: string): void {
  if (!getSettings().turnRollback || !sessionId || !uuid) return;
  void ipc.turnNativeCheckpoint(sessionId, uuid).catch(() => {});
}

// ------------------------------------------------------------- timeline

export interface TimelineAction {
  /** The snapshot ref to restore. */
  target: string;
  /** Claude checkpoint to rewind to first, when known. */
  nativeUuid: string | null;
  /** What the person should know before choosing this, or null. */
  caveat: string | null;
}

export interface TimelineEntry {
  n: number;
  prompt: string | null;
  startedMs: number | null;
  endedMs: number | null;
  /** Started and not yet ended — the newest turn, still being worked on. */
  running: boolean;
  /** Restore the tree to how it was before this turn ran. */
  undo: TimelineAction | null;
  /** Restore the tree to how this turn left it. */
  backToHere: TimelineAction | null;
}

export const LATE_CAVEAT =
  "This snapshot was taken a moment after the agent started, so a few of this turn's first edits may survive.";
export const PREV_END_CAVEAT =
  "Uses the snapshot from when the previous turn finished, so edits made between turns are rolled back too.";

/** Turn the Rust list into what each timeline row offers. Chronological. */
export function buildTimeline(list: ipc.TurnList): TimelineEntry[] {
  const turns = [...list.turns].sort((a, b) => a.n - b.n);
  return turns.map((t, i) => {
    const prev = i > 0 ? turns[i - 1] : undefined;
    const next = turns[i + 1];
    let undo: TimelineAction | null = null;
    if (t.start && !t.late) {
      undo = { target: t.start.ref, nativeUuid: t.native_uuid, caveat: null };
    } else if (prev?.end && prev.n === t.n - 1) {
      undo = {
        target: prev.end.ref,
        nativeUuid: t.native_uuid,
        caveat: PREV_END_CAVEAT,
      };
    } else if (t.start) {
      // Late, and nothing better to fall back on. Claude's own rewind (when
      // the uuid is known) still restores its Edit/Write files exactly.
      undo = {
        target: t.start.ref,
        nativeUuid: t.native_uuid,
        caveat: t.native_uuid ? null : LATE_CAVEAT,
      };
    }
    let backToHere: TimelineAction | null = null;
    if (t.end) {
      backToHere = {
        target: t.end.ref,
        nativeUuid: next?.native_uuid ?? null,
        caveat: null,
      };
    } else if (next?.start && !next.late) {
      backToHere = {
        target: next.start.ref,
        nativeUuid: next.native_uuid,
        caveat: null,
      };
    }
    return {
      n: t.n,
      prompt: t.prompt,
      startedMs: t.start?.ts_ms ?? null,
      endedMs: t.end?.ts_ms ?? null,
      running: !!t.start && !t.end && !next,
      undo,
      backToHere,
    };
  });
}

/** The labels, by lens. Build is for people who never asked to see git. */
export function timelineWords(builder: boolean) {
  return builder
    ? {
        title: "Go back to when it worked",
        undo: "Undo this step",
        back: "Go back to here",
        redo: "Put it back",
      }
    : {
        title: "Turns",
        undo: "Undo this turn",
        back: "Back to here",
        redo: "Redo",
      };
}

/** What no file snapshot can take back. Static on purpose: Canopy cannot see
 *  which commands reached the outside world, only that some might have. */
export const IRREVERSIBLE_NOTE =
  "Restores files only. Anything a command did outside this folder — network calls, database changes, migrations, deploys, pushes, installs — cannot be undone here.";

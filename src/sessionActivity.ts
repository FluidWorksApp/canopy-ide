// A session's subagents and context use, live: one shared poller per session
// however many surfaces show it (the agent tab, the Agents page card, the side
// panel row), reading session_activity (src-tauri/src/session_activity.rs, or
// the workspace host's twin in a cloud workspace).
//
// Polls fast while something is happening — a surface says the agent is
// working, or a subagent is still running — and slowly otherwise. Only CLIs
// whose harness ledger says their transcript records subagents are polled at
// all (harness.ts).

import { useEffect, useState } from "react";
import * as ipc from "./ipc";
import { harnessSupport } from "./harness";

export const ACTIVITY_FAST_MS = 3_000;
export const ACTIVITY_SLOW_MS = 15_000;

export interface ActivityKey {
  agent: string;
  sessionId: string;
  /** Where the session ran: finds the per-project stores. */
  cwd: string;
  profile?: string | null;
}

/** Whether `agent`'s sessions have activity Canopy can read. */
export const activitySupported = (agent: string): boolean => {
  const s = harnessSupport(agent, "subagents");
  return s === "native" || s === "partial";
};

interface Entry {
  key: ActivityKey;
  value: ipc.SessionActivity | null;
  listeners: Set<(v: ipc.SessionActivity | null) => void>;
  /** How many subscribers want the fast cadence right now. */
  fast: number;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: boolean;
}

const entries = new Map<string, Entry>();
const idOf = (k: ActivityKey) => `${k.agent}\u0000${k.sessionId}\u0000${k.profile ?? ""}`;

let read: (k: ActivityKey) => Promise<ipc.SessionActivity | null> = (k) =>
  ipc.sessionActivity({ sessionId: k.sessionId, agent: k.agent, roots: k.cwd ? [k.cwd] : [], profile: k.profile });

const busy = (e: Entry) => e.fast > 0 || !!e.value?.subagents.some((s) => s.status === "running");

function schedule(e: Entry) {
  if (e.timer) clearTimeout(e.timer);
  if (!e.listeners.size) return;
  e.timer = setTimeout(() => void poll(e), busy(e) ? ACTIVITY_FAST_MS : ACTIVITY_SLOW_MS);
}

async function poll(e: Entry) {
  if (e.inflight) return;
  e.inflight = true;
  try {
    // Never throws: an unreadable transcript just keeps what was shown.
    const next = await Promise.resolve()
      .then(() => read(e.key))
      .catch(() => e.value);
    if (JSON.stringify(next) !== JSON.stringify(e.value)) {
      e.value = next;
      for (const l of e.listeners) l(next);
    }
  } finally {
    e.inflight = false;
    schedule(e);
  }
}

/** Subscribe to one session's activity. Returns the unsubscribe. */
export function watchSessionActivity(
  key: ActivityKey,
  listener: (v: ipc.SessionActivity | null) => void,
  opts: { fast?: boolean } = {},
): () => void {
  const id = idOf(key);
  let e = entries.get(id);
  const fresh = !e;
  if (!e) {
    e = { key, value: null, listeners: new Set(), fast: 0, timer: null, inflight: false };
    entries.set(id, e);
  }
  const entry = e;
  entry.listeners.add(listener);
  if (opts.fast) entry.fast++;
  if (fresh) void poll(entry);
  else {
    listener(entry.value);
    schedule(entry);
  }
  return () => {
    entry.listeners.delete(listener);
    if (opts.fast) entry.fast--;
    if (!entry.listeners.size) {
      if (entry.timer) clearTimeout(entry.timer);
      entries.delete(id);
    } else schedule(entry);
  };
}

/** Read again now (after a compaction was sent, say). */
export function refreshSessionActivity(key: ActivityKey): void {
  const e = entries.get(idOf(key));
  if (e) void poll(e);
}

/** The activity as React state; null while unknown or unsupported. */
export function useSessionActivity(
  key: ActivityKey | null,
  opts: { fast?: boolean } = {},
): ipc.SessionActivity | null {
  const [value, setValue] = useState<ipc.SessionActivity | null>(null);
  const agent = key?.agent ?? "";
  const sessionId = key?.sessionId ?? "";
  const cwd = key?.cwd ?? "";
  const profile = key?.profile ?? null;
  const fast = !!opts.fast;
  useEffect(() => {
    setValue(null);
    if (!sessionId || !activitySupported(agent)) return;
    return watchSessionActivity({ agent, sessionId, cwd, profile }, setValue, { fast });
  }, [agent, sessionId, cwd, profile, fast]);
  return value;
}

/** Tests only. */
export function setSessionActivityReaderForTests(
  r: ((k: ActivityKey) => Promise<ipc.SessionActivity | null>) | null,
): void {
  for (const e of entries.values()) if (e.timer) clearTimeout(e.timer);
  entries.clear();
  read =
    r ??
    ((k) => ipc.sessionActivity({ sessionId: k.sessionId, agent: k.agent, roots: k.cwd ? [k.cwd] : [], profile: k.profile }));
}

// ------------------------------------------------------------ display

/** "42s", "3m 05s", "1h 12m". */
export function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** How long a subagent ran (or has been running). */
export function subagentSpan(s: ipc.SubagentRun, now: number): number | null {
  if (s.duration_ms != null) return s.duration_ms;
  if (s.started_ms == null) return null;
  return (s.ended_ms ?? (s.status === "running" ? now : s.started_ms)) - s.started_ms;
}

/** "2 running · 5 done · 1 failed". */
export function subagentCounts(list: readonly ipc.SubagentRun[]): string {
  const n = (st: ipc.SubagentRun["status"]) => list.filter((s) => s.status === st).length;
  return (["running", "done", "failed", "stopped"] as const)
    .filter((st) => n(st) > 0)
    .map((st) => `${n(st)} ${st}`)
    .join(" · ");
}

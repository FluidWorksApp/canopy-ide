/**
 * Agents put away with Settle. Settling retires the tab (the terminal closes,
 * the agent stops) and records enough here to bring the conversation back from
 * the Agents panel. A day later the sweep in ProjectView cleans up what the
 * agent left: its worktree and branch when nothing would be lost, and the
 * session record. A worktree with uncommitted or unpushed work is kept and
 * flagged instead (`unsaved`), for the person to restore or discard.
 */

export interface SettledSession {
  /** The agent's conversation id, or `tab:<id>` when none was known. */
  id: string;
  /** Whether `id` is a real session id that a resume command can use. */
  resumable: boolean;
  agentId: string;
  /** Tab title at the moment it was settled. */
  title: string;
  /** Folder the agent ran in (where a resume runs). */
  cwd: string;
  /** The command that started it, the fallback for a resume. */
  command?: string;
  profile?: string;
  /** The agent's own worktree, when it had one. Never the main checkout. */
  worktree?: { repo: string; root: string };
  branch?: string;
  /** The project it was settled from: the list is per project. */
  projectId?: string;
  settledAt: number;
  /** Set by the sweep when the worktree is kept: work that exists only there,
   *  or a reason it may not be removed automatically (`note`). */
  unsaved?: { dirty: number; unpushed: number; note?: string };
}

/** How long a settled agent stays before its worktree and record are cleaned up. */
export const SETTLED_TTL_MS = 24 * 60 * 60 * 1000;

const KEY = "canopy.settled-sessions.v1";
const EVENT = "canopy:settled-sessions";

let cache: SettledSession[] | null = null;

function read(): SettledSession[] {
  if (cache) return cache;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    cache = Array.isArray(raw)
      ? (raw as SettledSession[]).filter(
          (s) => s && typeof s.id === "string" && typeof s.cwd === "string" && Number.isFinite(s.settledAt),
        )
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(next: SettledSession[]) {
  cache = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* Storage is optional: the list still holds for this run. */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function settledSessions(): SettledSession[] {
  return read();
}

export function subscribeSettled(listener: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    cache = null;
    listener();
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function markSettled(entry: SettledSession) {
  write([entry, ...read().filter((s) => s.id !== entry.id)]);
}

export function clearSettled(id: string) {
  const list = read();
  if (!list.some((s) => s.id === id)) return;
  write(list.filter((s) => s.id !== id));
}

export function flagUnsaved(id: string, unsaved: SettledSession["unsaved"]) {
  write(read().map((s) => (s.id === id ? { ...s, unsaved } : s)));
}

/** Settled entries old enough for the sweep. */
export function dueForCleanup(list: readonly SettledSession[], now: number): SettledSession[] {
  return list.filter((s) => now - s.settledAt >= SETTLED_TTL_MS);
}

/** Whether a settled entry belongs to this project: by the id it was settled
 *  from, or (older entries) by its folder being under one of these roots. */
export function inProject(entry: SettledSession, roots: readonly string[], projectId?: string): boolean {
  if (entry.projectId && projectId) return entry.projectId === projectId;
  return roots.some(
    (root) =>
      entry.cwd === root ||
      entry.cwd.startsWith(`${root}/`) ||
      entry.worktree?.repo === root,
  );
}

/** Worktree roots that settled agents may still come back to. */
export function settledRoots(): Set<string> {
  return new Set(read().flatMap((s) => (s.worktree ? [s.worktree.root] : [])));
}

/** Session ids that are settled (listed under Settled, not Restorable). */
export function settledIds(): Set<string> {
  return new Set(read().map((s) => s.id));
}

/** Test hook: forget the in-memory copy. */
export function resetSettledCache() {
  cache = null;
}

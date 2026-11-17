// Pinned tabs that are not terminals, kept across a restart.
//
// A pin is the person's standing choice ("keep this one in front"), so it has
// to outlive the window. Terminals already come back after a restart
// (terminalMemory.ts), and carry their pin there. Every other kind of tab (a
// file, a pull request, a list) was simply gone, pin and all. This remembers
// those: the same serialisation a sleeping project uses (hibernation.ts), in
// localStorage like the other convenience records, scoped the same way as
// terminal memory so a workspace's pins never open on this Mac.
//
// Unlike terminal memory, an empty list is recorded: unpinning the last tab
// must be remembered too.
import type { SnapshotTab } from "./hibernation";

const KEY = "canopy.pinnedTabs.v1";
/** More than anyone pins; bounds what a damaged store can make a window open. */
export const MAX_PINNED_TABS = 24;

type Store = Record<string, SnapshotTab[]>;

const storageKey = (projectId: string, scope: string) =>
  scope === "local" ? projectId : JSON.stringify([scope, projectId]);

function read(): Store {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

/** Which tab a snapshot entry is, so one already open is never opened twice.
 *  A file is its path whatever view it shows; a pull request is its number
 *  whatever its title has become since. */
export function snapshotTabKey(tab: SnapshotTab): string {
  switch (tab.kind) {
    case "file":
      return `file:${tab.path}`;
    case "preview":
      return `preview:${tab.url}`;
    case "pr":
      return `pr:${tab.repo}#${tab.pr.number}`;
    case "commit":
      return `commit:${tab.repo}@${tab.hash}`;
    default: {
      const { pinned: _pin, ...rest } = tab as SnapshotTab & { pinned?: boolean };
      return `${tab.kind}:${JSON.stringify(rest)}`;
    }
  }
}

/** The pinned, non-terminal tabs of a strip's snapshot, each once. */
export function pinnedDocuments(tabs: readonly SnapshotTab[]): SnapshotTab[] {
  const seen = new Set<string>();
  const out: SnapshotTab[] = [];
  for (const tab of tabs) {
    if (tab.kind === "terminal" || tab.pinned !== true) continue;
    const key = snapshotTabKey(tab);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tab);
    if (out.length >= MAX_PINNED_TABS) break;
  }
  return out;
}

/** Record the project's pinned non-terminal tabs. Returns false when storage refused. */
export function rememberPinnedTabs(projectId: string, tabs: readonly SnapshotTab[], scope = "local"): boolean {
  const store = read();
  const key = storageKey(projectId, scope);
  const pinned = pinnedDocuments(tabs);
  if (pinned.length) store[key] = pinned;
  else delete store[key];
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
    return true;
  } catch {
    // Storage full or unavailable: a lost convenience record is not worth interrupting anyone over.
    return false;
  }
}

/** What was pinned last time. Anything that is not a usable entry is dropped. */
export function rememberedPinnedTabs(projectId: string, scope = "local"): SnapshotTab[] {
  const stored = read()[storageKey(projectId, scope)];
  if (!Array.isArray(stored)) return [];
  return pinnedDocuments(
    stored.filter((tab): tab is SnapshotTab => !!tab && typeof tab === "object" && typeof (tab as { kind?: unknown }).kind === "string"),
  );
}

/** The remembered pins that the strip does not already show. */
export function pinsToRestore(remembered: readonly SnapshotTab[], open: readonly SnapshotTab[]): SnapshotTab[] {
  const have = new Set(open.map(snapshotTabKey));
  return remembered.filter((tab) => !have.has(snapshotTabKey(tab)));
}

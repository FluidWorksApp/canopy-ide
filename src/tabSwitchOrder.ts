import type { TabSwitchMode } from "./settings";

/** Record one committed activation, newest first, dropping tabs that closed. */
export function recordTabUse(
  recent: readonly string[],
  activeId: string,
  openIds: readonly string[],
): string[] {
  const open = new Set(openIds);
  return [activeId, ...recent.filter((id) => id !== activeId && open.has(id))];
}

/** Freeze the order a held switch gesture will walk.
 *
 * The active tab stays first in recent mode, so the first forward step is the
 * previously used tab. Tabs never visited in this session remain reachable in
 * their stable strip order after the history. */
export function tabSwitchSnapshot(
  openIds: readonly string[],
  activeId: string | null,
  recent: readonly string[],
  mode: TabSwitchMode,
): string[] {
  if (mode === "order") return [...openIds];

  const open = new Set(openIds);
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (id: string | null) => {
    if (!id || !open.has(id) || seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
  };
  add(activeId);
  recent.forEach(add);
  openIds.forEach(add);
  return ordered;
}

/** Move through a frozen snapshot, skipping entries that closed mid-gesture. */
export function stepTabSwitch(
  snapshot: readonly string[],
  selectedId: string | null,
  openIds: readonly string[],
  dir: 1 | -1,
): string | null {
  if (snapshot.length < 2) return null;
  const open = new Set(openIds);
  const at = Math.max(0, snapshot.indexOf(selectedId ?? ""));
  for (let n = 1; n <= snapshot.length; n += 1) {
    const id = snapshot[(at + dir * n + snapshot.length) % snapshot.length];
    if (open.has(id)) return id;
  }
  return null;
}

/** Resolve a release after the selected tab closed. Prefer the next surviving
 * entry in the frozen order instead of letting shifted array indices choose a
 * different tab accidentally. */
export function resolveTabSwitch(
  snapshot: readonly string[],
  selectedId: string | null,
  openIds: readonly string[],
): string | null {
  const open = new Set(openIds);
  if (selectedId && open.has(selectedId)) return selectedId;
  if (!snapshot.length) return null;
  const at = Math.max(0, snapshot.indexOf(selectedId ?? ""));
  for (let n = 1; n <= snapshot.length; n += 1) {
    const id = snapshot[(at + n) % snapshot.length];
    if (open.has(id)) return id;
  }
  return null;
}

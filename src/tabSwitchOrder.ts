import type { TabSwitchMode } from "./settings";

/** How long a tab must hold focus before it counts as used. Passing through a
 *  tab on the way somewhere else must not rewrite the recency order. */
export const TAB_USE_DWELL_MS = 2000;

/** Drop closed tabs from the recency list without recording anything. */
export function pruneTabUses(
  recent: readonly string[],
  openIds: readonly string[],
): string[] {
  const open = new Set(openIds);
  return recent.filter((id) => open.has(id));
}

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

/** One labeled strip of the grouped panel, in frozen order. */
export interface TabSwitchRow {
  key: string;
  ids: string[];
}

/** Fold the frozen snapshot into rows. Row order is the order of each row's
 *  first member in the snapshot — most-recent-first, like the snapshot itself —
 *  and everything derives from the snapshot alone, so nothing reshuffles while
 *  the gesture is held. */
export function groupTabSwitch(
  snapshot: readonly string[],
  rowKeyFor: (id: string) => string,
): TabSwitchRow[] {
  const rows: TabSwitchRow[] = [];
  const byKey = new Map<string, TabSwitchRow>();
  for (const id of snapshot) {
    const key = rowKeyFor(id);
    let row = byKey.get(key);
    if (!row) {
      row = { key, ids: [] };
      byKey.set(key, row);
      rows.push(row);
    }
    row.ids.push(id);
  }
  return rows;
}

/** Where the selection sits in the grouped rows: [row, position]. An id the
 *  rows don't know starts at the top-left, mirroring stepTabSwitch's origin. */
function locateInRows(
  rows: readonly TabSwitchRow[],
  selectedId: string | null,
): [number, number] {
  for (let r = 0; r < rows.length; r += 1) {
    const p = rows[r].ids.indexOf(selectedId ?? "");
    if (p >= 0) return [r, p];
  }
  return [0, 0];
}

/** ArrowLeft/ArrowRight: move within the current row, wrapping, skipping
 *  entries that closed mid-gesture. */
export function stepTabSwitchInRow(
  rows: readonly TabSwitchRow[],
  selectedId: string | null,
  openIds: readonly string[],
  dir: 1 | -1,
): string | null {
  if (!rows.length) return null;
  const open = new Set(openIds);
  const [r, p] = locateInRows(rows, selectedId);
  const ids = rows[r].ids;
  if (ids.length < 2) return null;
  for (let n = 1; n <= ids.length; n += 1) {
    const id = ids[(p + dir * n + ids.length * n) % ids.length];
    if (open.has(id)) return id;
  }
  return null;
}

/** ArrowUp/ArrowDown: move to the adjacent row, wrapping past the ends,
 *  landing on the member at the same position clamped to the row's length.
 *  A closed landing spot falls through to the row's next surviving member;
 *  a fully closed row is skipped entirely. */
export function stepTabSwitchAcrossRows(
  rows: readonly TabSwitchRow[],
  selectedId: string | null,
  openIds: readonly string[],
  dir: 1 | -1,
): string | null {
  if (!rows.length) return null;
  const open = new Set(openIds);
  const [r, p] = locateInRows(rows, selectedId);
  for (let n = 1; n <= rows.length; n += 1) {
    const row = rows[(r + dir * n + rows.length * n) % rows.length];
    if (!row.ids.length) continue;
    const at = Math.min(p, row.ids.length - 1);
    for (let k = 0; k < row.ids.length; k += 1) {
      const id = row.ids[(at + k) % row.ids.length];
      if (open.has(id)) return id;
    }
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

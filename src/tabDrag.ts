// Drag-to-reorder for a horizontal tab strip.
//
// Pointer events rather than the HTML5 drag-and-drop API: Tauri claims native
// drags at the webview layer (dragDropEnabled, which the terminals rely on for
// OS file drops), so a webview-level drag is not something the strip can count
// on. Pointer events also behave the same under mouse, trackpad and pen.
//
// Reordering is committed live — each time the dragged tab passes a
// neighbour's midpoint — so the strip you see while dragging is the strip you
// get when you let go, and no ghost element or drop indicator is needed.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export interface TabDrag {
  /** The tab currently being dragged, for the translucent `tab-dragging` look. */
  dragId: string | null;
  /** Current translateX offset of the dragged tab in px (0 when not dragging). */
  dragOffsetX: number;
  /** Spread onto each draggable tab element. */
  itemProps: (id: string) => {
    "data-drag-id": string;
    onPointerDown: (e: ReactPointerEvent) => void;
  };
}

/** `ids` is the strip's current left-to-right order; `reorder` is handed the
 *  new order. Ids outside `ids` (another strip, another group) are ignored, so
 *  a tab can only be dropped among its own kind. */

/** Snapshot the left edge of the given tab elements, keyed by data-drag-id. */
function snapPositions(stripIds: Set<string>): Map<string, number> {
  const map = new Map<string, number>();
  document.querySelectorAll<HTMLElement>("[data-drag-id]").forEach((el) => {
    const id = el.dataset.dragId;
    if (id && stripIds.has(id)) map.set(id, el.getBoundingClientRect().left);
  });
  return map;
}

/** After a reorder React flushes new positions synchronously. We call this
 *  from useLayoutEffect to FLIP-animate all displaced tabs in this strip. */
function flipAnimate(before: Map<string, number>, dragId: string, stripIds: Set<string>) {
  document.querySelectorAll<HTMLElement>("[data-drag-id]").forEach((el) => {
    const id = el.dataset.dragId;
    // Only animate tabs in this strip; skip the dragged tab (it tracks the pointer).
    if (!id || !stripIds.has(id) || id === dragId) return;
    const prev = before.get(id);
    if (prev == null) return;
    const delta = prev - el.getBoundingClientRect().left;
    if (Math.abs(delta) < 1) return;
    // Teleport to old position (no transition), then animate to natural slot.
    el.style.transition = "none";
    el.style.transform = `translateX(${delta}px)`;
    // Force a style recalc so the browser sees the "from" state before the transition.
    el.getBoundingClientRect();
    el.style.transition = "transform 160ms cubic-bezier(0.22, 1, 0.36, 1)";
    el.style.transform = "translateX(0)";
  });
}

export function useTabDrag(ids: string[], reorder: (ids: string[]) => void): TabDrag {
  return useTabDragGroups([ids], reorder);
}

/** Drag-to-reorder across several strips at once. `groups` is one id list per
 *  strip; a tab is constrained to the strip it was picked up from, so the rule
 *  is the same as running a useTabDrag per group — but on one set of window
 *  listeners instead of three per group. That matters once a bar carries a
 *  dozen groups, and this one does: three agent stacks plus a stack per kind
 *  of document, per open project. */
export function useTabDragGroups(
  groups: string[][],
  reorder: (ids: string[]) => void,
): TabDrag {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOffsetX, setDragOffsetX] = useState(0);
  // The list the drag is confined to, resolved once at pointerdown: which
  // group a tab belongs to can change mid-drag (an agent finishing a turn
  // restacks it), and a tab that changed lists underneath the pointer would
  // start reordering strangers.
  const idsRef = useRef<string[]>([]);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const reorderRef = useRef(reorder);
  reorderRef.current = reorder;
  const drag = useRef<{ id: string; startX: number; moved: boolean } | null>(null);
  // Positions snapshot taken just before a reorder — consumed by the layout effect.
  const flipBefore = useRef<Map<string, number> | null>(null);

  // After React commits the reorder, run FLIP on all non-dragged tabs.
  useLayoutEffect(() => {
    const before = flipBefore.current;
    flipBefore.current = null;
    if (!before || !drag.current) return;
    flipAnimate(before, drag.current.id, new Set(idsRef.current));
  });

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const st = drag.current;
      if (!st) return;
      if (!st.moved) {
        // A few pixels of slop: a click that wobbles is still a click.
        if (Math.abs(e.clientX - st.startX) < 4) return;
        st.moved = true;
        setDragId(st.id);
        document.body.classList.add("dragging-tab");
      }
      // Track pixel offset so the tab translates with the pointer.
      setDragOffsetX(e.clientX - st.startX);
      // The dragged tab is pointer-events:none while dragging, so this hits the
      // tab underneath rather than the one in hand.
      const over = (
        document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null
      )?.closest<HTMLElement>("[data-drag-id]");
      const overId = over?.dataset.dragId;
      if (!over || !overId || overId === st.id) return;
      const list = idsRef.current;
      const from = list.indexOf(st.id);
      const to = list.indexOf(overId);
      if (from < 0 || to < 0) return;
      // Swap only once the pointer is past the neighbour's midpoint — a tab
      // parked on a boundary would otherwise flip back and forth.
      const r = over.getBoundingClientRect();
      const mid = r.left + r.width / 2;
      if (to > from ? e.clientX < mid : e.clientX > mid) return;
      // Snapshot positions BEFORE the reorder so FLIP can animate from them.
      flipBefore.current = snapPositions(new Set(idsRef.current));
      // When the strip reorders, the tab snaps to its new slot — reset startX
      // so the translate stays relative to the new position, not the origin.
      st.startX = e.clientX;
      setDragOffsetX(0);
      const next = [...list];
      next.splice(from, 1);
      next.splice(to, 0, st.id);
      reorderRef.current(next);
    };
    const up = () => {
      const st = drag.current;
      drag.current = null;
      if (!st?.moved) return;
      setDragId(null);
      setDragOffsetX(0);
      flipBefore.current = null;
      document.body.classList.remove("dragging-tab");
      // Clear any FLIP inline styles left on non-dragged tabs.
      document.querySelectorAll<HTMLElement>("[data-drag-id]").forEach((el) => {
        el.style.transition = "";
        el.style.transform = "";
      });
      // Releasing lands a click on whatever tab is now under the cursor —
      // swallow it so a drag never doubles as "switch to that tab".
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      window.addEventListener("click", swallow, true);
      window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      if (drag.current?.moved) document.body.classList.remove("dragging-tab");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  const itemProps = useCallback(
    (id: string) => ({
      "data-drag-id": id,
      onPointerDown: (e: ReactPointerEvent) => {
        if (e.button !== 0) return;
        // Close buttons and the rename input keep their own behaviour.
        if ((e.target as HTMLElement).closest("input, button, .tab-close")) return;
        const own = groupsRef.current.find((list) => list.includes(id));
        if (!own) return;
        idsRef.current = own;
        drag.current = { id, startX: e.clientX, moved: false };
      },
    }),
    [],
  );

  // Memoize the returned object so consumers that spread it as two props
  // (tabDragId/tabDragItemProps) or wrap it in useMemo([agentDrag, docDrag])
  // get a stable reference — memo(Component) won't re-render just because
  // useTabDrag re-ran.
  return useMemo(() => ({ dragId, dragOffsetX, itemProps }), [dragId, dragOffsetX, itemProps]);
}

/** Write `order` (a reordered subset of `all`) back into `all`, leaving every
 *  item outside the subset in the slot it already occupied. Lets one group of a
 *  grouped strip be reordered without disturbing the rest of the list. */
export function applyOrder<T>(all: T[], idOf: (t: T) => string, order: string[]): T[] {
  const byId = new Map(all.map((t) => [idOf(t), t] as const));
  // A tab can close mid-drag; dropping ids that no longer exist keeps the
  // subset and its slots the same length, so nothing is duplicated.
  const live = order.filter((id) => byId.has(id));
  const wanted = new Set(live);
  const next = [...all];
  let k = 0;
  all.forEach((t, i) => {
    if (wanted.has(idOf(t))) next[i] = byId.get(live[k++])!;
  });
  return next;
}

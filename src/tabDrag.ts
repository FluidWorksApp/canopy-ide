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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export interface TabDrag {
  /** The tab currently being dragged, for the translucent `tab-dragging` look. */
  dragId: string | null;
  /** Spread onto each draggable tab element. */
  itemProps: (id: string) => {
    "data-drag-id": string;
    onPointerDown: (e: ReactPointerEvent) => void;
  };
}

/** `ids` is the strip's current left-to-right order; `reorder` is handed the
 *  new order. Ids outside `ids` (another strip, another group) are ignored, so
 *  a tab can only be dropped among its own kind. */
export function useTabDrag(ids: string[], reorder: (ids: string[]) => void): TabDrag {
  const [dragId, setDragId] = useState<string | null>(null);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const reorderRef = useRef(reorder);
  reorderRef.current = reorder;
  const drag = useRef<{ id: string; startX: number; moved: boolean } | null>(null);

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
      document.body.classList.remove("dragging-tab");
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
        drag.current = { id, startX: e.clientX, moved: false };
      },
    }),
    [],
  );

  // Memoize the returned object so consumers that spread it as two props
  // (tabDragId/tabDragItemProps) or wrap it in useMemo([agentDrag, docDrag])
  // get a stable reference — memo(Component) won't re-render just because
  // useTabDrag re-ran.
  return useMemo(() => ({ dragId, itemProps }), [dragId, itemProps]);
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

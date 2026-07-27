// Fixed-row-height list windowing, dependency-free. Only the rows near the
// viewport are mounted; the rest are two padding spacers, so a 10k-row tree
// costs React ~60 elements instead of 10k.
//
// Deliberately viewport-relative rather than bound to a scroll container: these
// lists live inside panels whose *ancestor* does the scrolling (.file-tree is
// overflow:auto but grows to content; the outer panel scrolls), and which
// ancestor that is can change with layout. A capture-phase window scroll
// listener sees every ancestor scroll without knowing which one it was.
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

const OVERSCAN = 12;

export function WindowedList<T>({
  items,
  rowHeight,
  renderRow,
  innerRef,
}: {
  items: T[];
  /** Every row must render at exactly this height — the spacer math is the
   *  scrollbar, and a drifting row height makes scrolling jump. */
  rowHeight: number;
  renderRow: (item: T, index: number) => ReactNode;
  /** The rows wrapper, for callers that need geometry (keyboard reveal). */
  innerRef?: Ref<HTMLDivElement>;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState({ start: 0, end: 80 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      // The wrapper's border-box top is the list start even mid-scroll: the
      // spacers are padding, inside the box.
      const top = el.getBoundingClientRect().top;
      const pad = OVERSCAN * rowHeight;
      const start = Math.max(0, Math.floor((-top - pad) / rowHeight));
      const end = Math.max(
        start,
        Math.min(
          items.length,
          Math.ceil((window.innerHeight + pad - top) / rowHeight),
        ),
      );
      setRange((prev) =>
        prev.start === start && prev.end === end ? prev : { start, end },
      );
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", schedule);
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(schedule);
      ro.observe(el);
    }
    return () => {
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [items.length, rowHeight]);

  return (
    <div
      ref={(node) => {
        ref.current = node;
        if (typeof innerRef === "function") innerRef(node);
        else if (innerRef) innerRef.current = node;
      }}
      style={{
        paddingTop: range.start * rowHeight,
        paddingBottom: Math.max(0, (items.length - range.end) * rowHeight),
      }}
    >
      {items
        .slice(range.start, range.end)
        .map((item, i) => renderRow(item, range.start + i))}
    </div>
  );
}

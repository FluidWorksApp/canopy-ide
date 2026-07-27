// Fixed-row-height list windowing, dependency-free. Only the rows near the
// viewport are mounted; the rest are two padding spacers, so a 10k-row tree
// costs React ~60 elements instead of 10k.
//
// Deliberately viewport-relative rather than bound to a scroll container: these
// lists live inside panels whose *ancestor* does the scrolling (.file-tree is
// overflow:auto but grows to content; the outer panel scrolls), and which
// ancestor that is can change with layout. A capture-phase window scroll
// listener sees every ancestor scroll without knowing which one it was.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";

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

  // Read through refs so `update` can live in a mount-once effect while items
  // and row height stay current.
  const geom = useRef({ count: items.length, rowHeight });
  geom.current = { count: items.length, rowHeight };

  const update = useRef(() => {});
  update.current = () => {
    const el = ref.current;
    if (!el) return;
    const { count, rowHeight: rh } = geom.current;
    // The wrapper's border-box top is the list start even mid-scroll: the
    // spacers are padding, inside the box.
    const top = el.getBoundingClientRect().top;
    const pad = OVERSCAN * rh;
    const start = Math.max(0, Math.floor((-top - pad) / rh));
    const end = Math.max(
      start,
      Math.min(count, Math.ceil((window.innerHeight + pad - top) / rh)),
    );
    setRange((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end },
    );
  };

  // A scroll event only covers one way the list moves under the viewport. The
  // other is layout above it changing height — a sibling section expanding, a
  // command row appearing — which scrolls nothing and resizes nothing this
  // list can observe, but shifts where its rows should be. Every one of those
  // shifts comes from a React commit in this panel, so re-measuring after
  // every commit (deliberately no dependency array) catches them all for the
  // price of one rect read.
  useLayoutEffect(() => {
    update.current();
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const run = () => {
      raf = 0;
      update.current();
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(run);
    };
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
  }, []);

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

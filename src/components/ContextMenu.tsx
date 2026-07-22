// A small, generic context menu. The webview's own menu (Reload / Inspect
// Element, or macOS's Look Up / Translate over selected text) is meaningless in
// a desktop IDE, so the app suppresses it globally (see main.tsx) and shows
// this instead.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  /** Omitted only on a plain separator (`separator: true` with no label). */
  label?: string;
  onClick?: () => void;
  danger?: boolean;
  /** Renders a divider; label is ignored. */
  separator?: boolean;
  disabled?: boolean;
  /** Leading glyph — the launcher menu uses the agent brand marks. */
  icon?: ReactNode;
  /** Trailing note, dimmed and right-aligned (e.g. "install"). */
  hint?: string;
  /** Nested items, shown in a panel attached to this row. Used where a
   *  choice has its own list ("New agent ▸" → every installed CLI) and
   *  flattening it would bury the common case under the rare one. */
  submenu?: MenuItem[];
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [openSub, setOpenSub] = useState<number | null>(null);
  const subRef = useRef<HTMLDivElement>(null);
  // The attached panel is positioned relative to its row, so it inherits none
  // of the parent's viewport clamping — near the bottom or right edge it ran
  // straight off screen. Measure the real rect once it opens and pull it back.
  const [subFix, setSubFix] = useState<{ top: number; flip: boolean }>({
    top: 0,
    flip: false,
  });
  useLayoutEffect(() => {
    if (openSub == null) {
      setSubFix({ top: 0, flip: false });
      return;
    }
    const el = subRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    // Lift it just enough to fit; never push it above the top edge.
    const overflowY = r.bottom - (window.innerHeight - margin);
    const top = overflowY > 0 ? -Math.min(overflowY, Math.max(0, r.top - margin)) : 0;
    const flip = r.right > window.innerWidth - margin;
    setSubFix({ top, flip });
  }, [openSub]);

  // Keep the menu inside the window — near the bottom/right edge it would
  // otherwise open off-screen and be unusable.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Math.max guards the case where the menu is larger than the window, which
    // would otherwise clamp it to a negative offset and cut off the top/left.
    setPos({
      x: Math.max(6, Math.min(x, window.innerWidth - r.width - 6)),
      y: Math.max(6, Math.min(y, window.innerHeight - r.height - 6)),
    });
  }, [x, y]);

  useEffect(() => {
    // Capture phase, so a click on the page closes the menu before any
    // underlying handler reacts to it. That means this fires before the event
    // reaches our own buttons too, so ignore anything inside the menu by
    // hit-testing the target — a bubble-phase stopPropagation on the container
    // would run too late to prevent this listener, closing the menu (and
    // unmounting the button) before its click could ever fire.
    const close = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const bail = () => onClose();
    window.addEventListener("mousedown", close, true);
    window.addEventListener("keydown", esc);
    window.addEventListener("resize", bail);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("resize", bail);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.separator ? (
          // A separator with a label is a section heading, which is how the
          // agent menus tell "running" from "new" without a second widget.
          item.label ? (
            <div key={i} className="ctx-heading">
              {item.label}
            </div>
          ) : (
            <div key={i} className="ctx-sep" />
          )
        ) : item.submenu ? (
          <div
            key={i}
            className="ctx-sub-anchor"
            onMouseEnter={() => setOpenSub(i)}
            onMouseLeave={() => setOpenSub((cur) => (cur === i ? null : cur))}
          >
            <button
              className={`ctx-item ${openSub === i ? "ctx-item-on" : ""}`}
              onClick={() => setOpenSub((cur) => (cur === i ? null : i))}
            >
              {item.icon != null && <span className="ctx-icon">{item.icon}</span>}
              <span className="ctx-label">{item.label}</span>
              <span className="ctx-caret">›</span>
            </button>
            {openSub === i && (
              <div
                ref={subRef}
                className={`ctx-menu ctx-submenu ${subFix.flip ? "ctx-submenu-left" : ""}`}
                style={{ marginTop: subFix.top }}
              >
                {item.submenu.map((sub, j) =>
                  sub.separator ? (
                    sub.label ? (
                      <div key={j} className="ctx-heading">
                        {sub.label}
                      </div>
                    ) : (
                      <div key={j} className="ctx-sep" />
                    )
                  ) : (
                    <button
                      key={j}
                      className={`ctx-item ${sub.danger ? "ctx-danger" : ""}`}
                      disabled={sub.disabled}
                      onClick={() => {
                        sub.onClick?.();
                        onClose();
                      }}
                    >
                      {sub.icon != null && <span className="ctx-icon">{sub.icon}</span>}
                      <span className="ctx-label">{sub.label}</span>
                      {sub.hint && <span className="ctx-hint">{sub.hint}</span>}
                    </button>
                  ),
                )}
              </div>
            )}
          </div>
        ) : (
          <button
            key={i}
            className={`ctx-item ${item.danger ? "ctx-danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              item.onClick?.();
              onClose();
            }}
          >
            {item.icon != null && <span className="ctx-icon">{item.icon}</span>}
            <span className="ctx-label">{item.label}</span>
            {item.hint && <span className="ctx-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/** Menu state helper: `open(e, items)` from an onContextMenu handler. */
export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const open = (e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const close = () => setMenu(null);
  return { menu, open, close };
}

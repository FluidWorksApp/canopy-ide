// A small, generic context menu. The webview's own menu (Reload / Inspect
// Element, or macOS's Look Up / Translate over selected text) is meaningless in
// a desktop IDE, so the app suppresses it globally (see main.tsx) and shows
// this instead.
import { useEffect, useRef, useState, type ReactNode } from "react";

export interface MenuItem {
  label: string;
  onClick?: () => void;
  danger?: boolean;
  /** Renders a divider; label is ignored. */
  separator?: boolean;
  disabled?: boolean;
  /** Leading glyph — the launcher menu uses the agent brand marks. */
  icon?: ReactNode;
  /** Trailing note, dimmed and right-aligned (e.g. "install"). */
  hint?: string;
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
          <div key={i} className="ctx-sep" />
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

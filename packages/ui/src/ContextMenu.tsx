import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import "./ContextMenu.css";

export interface MenuItem {
  label: string;
  onClick?: () => void;
  /** Tints the row red — destructive actions. */
  danger?: boolean;
  /** Renders a divider; `label` is ignored. */
  separator?: boolean;
  disabled?: boolean;
  /** Leading glyph. */
  icon?: ReactNode;
  /** Trailing note, dimmed and right-aligned (e.g. "install"). */
  hint?: string;
}

export interface ContextMenuProps {
  /** Viewport coordinates — typically `e.clientX` / `e.clientY`. */
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // Keep the menu inside the window — opened near an edge it would otherwise
  // render off-screen. Math.max guards a menu taller than the viewport, which
  // would clamp to a negative offset and cut off its own top.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(6, Math.min(x, window.innerWidth - r.width - 6)),
      y: Math.max(6, Math.min(y, window.innerHeight - r.height - 6)),
    });
  }, [x, y]);

  useEffect(() => {
    // Capture phase, so a click anywhere else closes the menu before the
    // underlying handler reacts. That also means this runs before the event
    // reaches our own buttons — so hit-test the target and bail. A bubble-phase
    // stopPropagation on the container cannot help here: it runs after this
    // listener, which would already have unmounted the button and eaten its
    // click. (Every item was dead until this was hit-tested.)
    const close = (e: globalThis.MouseEvent) => {
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
      className="cn-ctx-menu"
      style={{ left: pos.x, top: pos.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="cn-ctx-sep" />
        ) : (
          <button
            key={i}
            type="button"
            className={`cn-ctx-item ${item.danger ? "cn-ctx-danger" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              item.onClick?.();
              onClose();
            }}
          >
            {item.icon != null && <span className="cn-ctx-icon">{item.icon}</span>}
            <span className="cn-ctx-label">{item.label}</span>
            {item.hint && <span className="cn-ctx-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

/** Menu state helper: call `open(e, items)` from an `onContextMenu` handler. */
export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const open = (e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    // Stop the parent's own onContextMenu from replacing this menu with its own.
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };
  const close = () => setMenu(null);
  return { menu, open, close };
}

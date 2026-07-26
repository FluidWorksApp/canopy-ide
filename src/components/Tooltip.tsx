// Hover tooltip on the overlay surface. Wraps its trigger (no portal — the rail
// and its ancestors don't clip, so it inherits the theme and travels with
// scroll). The arrow tracks the pointer along the near edge, and the mono
// shortcut chip lands a beat behind the label. Reveal is pure CSS animation
// (the hover delay IS the animation-delay), so it plays on the first hover
// frame with nothing to clean up on unmount. See docs in the design handoff.
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface TooltipProps {
  /** One line, sentence case — names the action. */
  label: string;
  /** Optional dim second line — explain a consequence, don't repeat the label. */
  body?: string;
  /** Mono shortcut chip, e.g. "⌘P". Always a real keybinding. */
  hint?: string;
  /** Mono meta line for paths, counts, costs. */
  meta?: string;
  side?: "top" | "bottom" | "left" | "right";
  /** "accent" adds an accent dot + accent label — reserved for agent surfaces. */
  variant?: "plain" | "accent";
  /** Hover delay in ms before opening; becomes the CSS animation delay. */
  delay?: number;
  /** Fixed width in px; defaults to max-content, capped at 280 in CSS. */
  width?: number;
  children: ReactNode;
}

export function Tooltip({
  label,
  body,
  hint,
  meta,
  side = "top",
  variant = "plain",
  delay = 90,
  width,
  children,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const tip = useRef<HTMLSpanElement>(null);
  const arrow = useRef<HTMLSpanElement>(null);
  const point = useRef<{ x: number; y: number } | null>(null);
  const vertical = side === "top" || side === "bottom";

  // The arrow offset is written straight to the node — continuous pointer moves
  // must not wait on a React render, or the arrow visibly lags the cursor.
  const place = useCallback(() => {
    const box = tip.current;
    const a = arrow.current;
    const pt = point.current;
    if (!box || !a || !pt) return;
    const r = box.getBoundingClientRect();
    const raw = vertical ? pt.x - r.left : pt.y - r.top;
    const span = vertical ? r.width : r.height;
    // Clamp so the arrow never overruns a rounded corner (radius 8/12 + margin).
    const v = Math.max(15, Math.min(span - 15, raw));
    if (vertical) a.style.left = `${v}px`;
    else a.style.top = `${v}px`;
  }, [vertical]);

  // First placement before paint, so the opening frame is already correct.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  const enter = (e: React.MouseEvent) => {
    point.current = { x: e.clientX, y: e.clientY };
    setOpen(true);
  };
  const move = (e: React.MouseEvent) => {
    point.current = { x: e.clientX, y: e.clientY };
    place();
  };
  const focus = (e: React.FocusEvent) => {
    // Keyboard: center the arrow on the trigger (synthesize pointer coords).
    const r = e.currentTarget.getBoundingClientRect();
    point.current = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    setOpen(true);
  };

  const card = Boolean(body || meta);
  const accent = variant === "accent";

  return (
    <span
      className="cnp-tooltip-wrap"
      onMouseEnter={enter}
      onMouseMove={move}
      onMouseLeave={() => setOpen(false)}
      onFocus={focus}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          ref={tip}
          role="tooltip"
          className={`cnp-tooltip ${card ? "cnp-tooltip-card" : ""} ${accent ? "cnp-tooltip-accent" : ""}`}
          data-side={side}
          style={{
            // Hover delay = animation delay; keep the width override inline.
            animationDelay: `${delay}ms`,
            ...(width ? { width: `${width}px` } : null),
          }}
        >
          <span ref={arrow} className="cnp-tooltip-arrow" />
          <span className="cnp-tooltip-row">
            {accent && <span className="cnp-tooltip-dot" />}
            <span className="cnp-tooltip-label">{label}</span>
            {hint && (
              <span className="cnp-tooltip-hint" style={{ animationDelay: `${delay + 80}ms` }}>
                {hint}
              </span>
            )}
          </span>
          {body && <span className="cnp-tooltip-body">{body}</span>}
          {meta && <span className="cnp-tooltip-meta">{meta}</span>}
        </span>
      )}
    </span>
  );
}

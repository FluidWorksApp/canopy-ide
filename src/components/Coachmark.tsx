// An anchored first-run spotlight. Dims the app, cuts a highlight hole around a
// live element (found by selector, re-measured as layout settles), and floats a
// small callout beside it. No portal — mounts inline like the other overlays and
// layers by z-index. Dismiss via the button, Esc, or clicking the dimmed area.
import { useCallback, useLayoutEffect, useState } from "react";
import { useEscape } from "../useEscape";
import { Mascot } from "./Mascot";
import { Button } from "./ui";

interface CoachmarkProps {
  /** CSS selector for the element to spotlight. */
  targetSelector: string;
  title: string;
  body: string;
  /** Called on any dismissal (button, Esc, backdrop). */
  onDismiss: () => void;
}

const POP_WIDTH = 264;

export function Coachmark({ targetSelector, title, body, onDismiss }: CoachmarkProps) {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useEscape(onDismiss, true);

  const measure = useCallback(() => {
    const el = document.querySelector(targetSelector);
    const next = el ? el.getBoundingClientRect() : null;
    // getBoundingClientRect returns a fresh DOMRect every call, so setting it
    // unconditionally never bailed out: this re-rendered the coachmark and the
    // app-wide dim layer with it, 2.5 times a second, for its whole life.
    setRect((prev) => {
      if (prev === next) return prev;
      if (!prev || !next) return next;
      const same =
        prev.top === next.top &&
        prev.left === next.left &&
        prev.width === next.width &&
        prev.height === next.height;
      return same ? prev : next;
    });
  }, [targetSelector]);

  useLayoutEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    // Rails grow/shift as chips land and the layout settles; keep the hole glued.
    const id = window.setInterval(measure, 400);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      window.clearInterval(id);
    };
  }, [measure]);

  // Target gone (rail emptied, tab closed) — nothing to point at, so bow out.
  if (!rect || rect.width === 0) return null;

  const pad = 6;
  const holeStyle: React.CSSProperties = {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };

  // Prefer below the target; flip above if it would run off the bottom.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const below = rect.bottom + 12 + 132 < vh;
  const popStyle: React.CSSProperties = {
    top: below ? rect.bottom + 12 : undefined,
    bottom: below ? undefined : vh - rect.top + 12,
    left: Math.min(Math.max(rect.left + rect.width / 2 - POP_WIDTH / 2, 10), vw - POP_WIDTH - 10),
    width: POP_WIDTH,
  };

  return (
    <div className="coach-layer" onMouseDown={onDismiss}>
      <div className="coach-hole" style={holeStyle} aria-hidden />
      <div
        className={`coach-pop ${below ? "coach-pop-below" : "coach-pop-above"}`}
        style={popStyle}
        role="dialog"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="coach-title">
          <Mascot state="explaining" size={26} className="coach-ash" />
          {title}
        </div>
        <p className="coach-body">{body}</p>
        <div className="coach-actions">
          <Button variant="accent" onClick={onDismiss} autoFocus>
            Got it
          </Button>
        </div>
      </div>
    </div>
  );
}

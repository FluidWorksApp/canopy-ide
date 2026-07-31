// One tooltip for the whole IDE. Mounted once by App; every `title` in the app
// — ours, Monaco's, anything added later — becomes the themed bubble instead of
// the platform's grey box, without a single call site changing.
//
// The trick is that the title has to LEAVE the element while it is hovered:
// the webview draws its own tooltip off that attribute and nothing but its
// absence stops it. So we hoist it (remembering it on the node), draw ours, and
// put it back on the way out — which keeps it as the element's accessible name
// for everything except the ~300ms it is on screen.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  parseTitle,
  placeTip,
  upgradable,
  type Placement,
  type TipContent,
} from "../tooltipTitles";

/** Long enough that dragging the pointer across a dense list doesn't strobe,
 *  short enough to beat the platform's own (~1s) delay. Same value the
 *  terminal's link hint uses — hovering shouldn't feel different per surface. */
const DELAY_MS = 300;

/** A click focuses what it clicked; showing the tooltip again on that focus is
 *  a bubble nobody asked for. Keyboard focus arriving later still gets one. */
const CLICK_FOCUS_MS = 500;

/** Marks the element whose title we are holding, so that moving the pointer
 *  onto a child (the icon inside a titled button) is not read as leaving. */
const HELD_ATTR = "data-cnp-tip";

export function TooltipLayer() {
  const [tip, setTip] = useState<TipContent | null>(null);
  const [pos, setPos] = useState<Placement | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const arrow = useRef<HTMLSpanElement>(null);
  // Everything the DOM listeners need is a ref: they are bound once, for the
  // life of the app, and must not be rebound on every hover.
  const held = useRef<{ el: Element; title: string } | null>(null);
  const anchor = useRef<Element | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const watch = useRef<MutationObserver | null>(null);
  // Watches for the held element being swapped out from under the pointer, and
  // where the pointer was when it landed — the only clue to what replaced it.
  const swap = useRef<MutationObserver | null>(null);
  const at = useRef<{ x: number; y: number } | null>(null);
  // -Infinity, not 0: performance.now() starts at 0 too, and "no click yet"
  // must not read as "clicked just now" for the first half-second of the app.
  const clickedAt = useRef(-Infinity);

  useEffect(() => {
    const restore = () => {
      const h = held.current;
      held.current = null;
      watch.current?.disconnect();
      watch.current = null;
      swap.current?.disconnect();
      swap.current = null;
      if (!h) return;
      h.el.removeAttribute(HELD_ATTR);
      // Only if the element hasn't grown a title of its own in the meantime —
      // a React re-render during the hover can reinstate it.
      if (!h.el.hasAttribute("title")) h.el.setAttribute("title", h.title);
    };

    const hide = () => {
      clearTimeout(timer.current);
      timer.current = undefined;
      anchor.current = null;
      restore();
      setTip(null);
      setPos(null);
    };

    const arm = (el: Element) => {
      const content = parseTitle(el.getAttribute("title") ?? "");
      if (!content) return;
      // Hoist immediately, not when the bubble opens: the platform is counting
      // down to its own tooltip from the moment the pointer landed.
      const title = el.getAttribute("title") ?? "";
      el.removeAttribute("title");
      el.setAttribute(HELD_ATTR, "");
      held.current = { el, title };
      // A live row (an agent's status, a running count) re-renders under the
      // pointer, and React writes the new title straight back onto the node —
      // which is the platform's tooltip returning. Take it again, and say the
      // new thing if the bubble is already open.
      watch.current = new MutationObserver(() => {
        const fresh = el.getAttribute("title");
        if (fresh == null) return;
        el.removeAttribute("title");
        if (held.current) held.current.title = fresh;
        if (anchor.current === el) setTip(parseTitle(fresh));
      });
      watch.current.observe(el, { attributes: true, attributeFilter: ["title"] });
      // The attribute watcher above covers React writing a new title onto the
      // SAME node. It cannot cover React replacing the node: a tab moving
      // between stacks is unmounted and remounted in its new group, and the
      // fresh node arrives carrying the `title` straight from the JSX. The
      // pointer never moved, so no pointerover fires, nothing re-arms, and the
      // platform draws the grey box we exist to prevent.
      //
      // Alive only while a title is held — that is, only while the pointer is
      // resting on something with a tooltip — so the subtree watch costs
      // nothing for the rest of the app's life. The callback early-outs in one
      // property read on every batch it does not care about.
      swap.current = new MutationObserver(() => {
        if (el.isConnected) return;
        const pt = at.current;
        const now = pt && document.elementFromPoint(pt.x, pt.y);
        const next = now?.closest(`[title], [${HELD_ATTR}]`) ?? null;
        hide();
        if (next && next.hasAttribute("title") && upgradable(next)) arm(next);
      });
      swap.current.observe(document.body, { childList: true, subtree: true });
      timer.current = setTimeout(() => {
        timer.current = undefined;
        // The row scrolled away, the panel closed, the button re-rendered into
        // a different node — nothing to point at.
        if (!el.isConnected) {
          hide();
          return;
        }
        anchor.current = el;
        setTip(content);
      }, DELAY_MS);
    };

    const enter = (target: EventTarget | null) => {
      const t = target instanceof Element ? target : null;
      const el = t?.closest(`[title], [${HELD_ATTR}]`) ?? null;
      if (el && el === held.current?.el) return;
      hide();
      if (el && el.hasAttribute("title") && upgradable(el)) arm(el);
    };

    const over = (e: Event) => {
      if (e instanceof PointerEvent) at.current = { x: e.clientX, y: e.clientY };
      enter(e.target);
    };
    const focus = (e: Event) => {
      if (performance.now() - clickedAt.current < CLICK_FOCUS_MS) return;
      enter(e.target);
    };
    const down = () => {
      clickedAt.current = performance.now();
      hide();
    };

    // Capture, all of it: a panel that stops propagation on its own rows would
    // otherwise be the one place in the app with no tooltips.
    document.addEventListener("pointerover", over, true);
    document.addEventListener("focusin", focus, true);
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", hide, true);
    // A bubble anchored to a row that just scrolled is pointing at a lie.
    document.addEventListener("scroll", hide, { capture: true, passive: true });
    document.addEventListener("pointerleave", hide);
    window.addEventListener("blur", hide);
    window.addEventListener("resize", hide);
    return () => {
      hide();
      document.removeEventListener("pointerover", over, true);
      document.removeEventListener("focusin", focus, true);
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("pointerleave", hide);
      window.removeEventListener("blur", hide);
      window.removeEventListener("resize", hide);
    };
  }, []);

  // Measure once the content is in the DOM but before it paints: the first
  // frame the user sees is already in the right place, and the arrow offset
  // goes straight to the node rather than through a second render.
  useLayoutEffect(() => {
    const el = box.current;
    const at = anchor.current;
    if (!tip || !el || !at) return;
    const a = at.getBoundingClientRect();
    // offsetWidth/Height, not a rect: the reveal keyframe is running from
    // scale(0.98), and a rect measured mid-animation is 2% short — enough to
    // park the bubble half a pixel off the window edge instead of six.
    const p = placeTip(
      { top: a.top, bottom: a.bottom, left: a.left, right: a.right, width: a.width, height: a.height },
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPos(p);
    if (arrow.current) arrow.current.style.left = `${p.arrow}px`;
  }, [tip]);

  if (!tip) return null;
  const card = Boolean(tip.body);
  return (
    <span
      ref={box}
      role="tooltip"
      className={`cnp-tooltip cnp-tooltip-fixed ${card ? "cnp-tooltip-card" : ""}`}
      data-side={pos?.side ?? "top"}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        // One frame measured off-screen-ish rather than visibly jumping.
        visibility: pos ? undefined : "hidden",
      }}
    >
      <span ref={arrow} className="cnp-tooltip-arrow" />
      {tip.label && (
        <span className="cnp-tooltip-row">
          <span className="cnp-tooltip-label">{tip.label}</span>
          {tip.hint && <span className="cnp-tooltip-hint">{tip.hint}</span>}
        </span>
      )}
      {tip.body && <span className="cnp-tooltip-body">{tip.body}</span>}
    </span>
  );
}

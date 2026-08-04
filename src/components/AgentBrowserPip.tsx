// A passive view of the browser ONE agent is driving. The native browser cannot
// be mounted in two places, so this pulls background snapshots from that agent's
// own linked preview tab instead of creating a second page with different state.
//
// One of these per agent, never one shared between them: the tab is the agent's
// browser session, and a second agent's page is a different page. See the pip
// routing in ProjectView for how a session gets a tab of its own.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import { AgentIcon, CloseIcon, GlobeIcon } from "./icons";

const FRAME_GAP_MS = 250;
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
/** How far each additional pip is dealt from the corner, so a second agent's
 *  view doesn't land exactly on the first one's. */
const SLOT_STEP = 26;
const EDGE = 18;

export interface PipPos {
  x: number;
  y: number;
}

export function pipOwnerVisible(
  ptyId: number,
  terminals: { id: string; ptyId: number | null; paneGroup?: string }[],
  activeTabId: string | null,
): boolean {
  const owner = terminals.find((tab) => tab.ptyId === ptyId);
  const active = terminals.find((tab) => tab.id === activeTabId);
  if (!owner || !active) return false;
  return (
    owner.id === active.id ||
    (owner.paneGroup != null && owner.paneGroup === active.paneGroup)
  );
}

interface AgentBrowserPipProps {
  tabId: string;
  url: string;
  agentId: string;
  agentTitle: string;
  supported: boolean;
  /** Which pip this is among the ones on screen, for the dealt-out default
   *  position. Ignored once the user has dragged it somewhere. */
  slot?: number;
  /** Its own tab is in front, so the full browser is already the live view and
   *  this would only cover the corner of it.
   *
   *  Hidden rather than unmounted, and that is the whole point of the prop:
   *  where the user dragged it, how wide they made it and whether they
   *  minimized it live in here, so an unmount threw all three away and the pip
   *  came back dealt to the default corner every time its tab was looked at.
   *  Nothing streams while hidden — the cost of staying mounted is one idle
   *  component, not a snapshot loop. */
  hidden?: boolean;
  onClose: () => void;
}

function pipWidth(startWidth: number, startX: number, clientX: number, viewport: number) {
  return Math.round(
    Math.min(Math.max(MIN_WIDTH, viewport - 48), MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + startX - clientX)),
  );
}

/** Keep a dragged pip inside its pane. The clamp is against the pip's own size,
 *  so a pip wider than the pane pins to the left edge rather than jumping. */
export function clampPip(pos: PipPos, size: { width: number; height: number }, area: { width: number; height: number }): PipPos {
  return {
    x: Math.round(Math.min(Math.max(0, pos.x), Math.max(0, area.width - size.width))),
    y: Math.round(Math.min(Math.max(0, pos.y), Math.max(0, area.height - size.height))),
  };
}

export function AgentBrowserPip({
  tabId,
  url,
  agentId,
  agentTitle,
  supported,
  slot = 0,
  hidden = false,
  onClose,
}: AgentBrowserPipProps) {
  const [frame, setFrame] = useState<string | null>(null);
  const [ratio, setRatio] = useState(16 / 9);
  const [width, setWidth] = useState(400);
  const [minimized, setMinimized] = useState(false);
  const [failed, setFailed] = useState(false);
  /** null until the user drags: the pip stays dealt from the bottom-right
   *  corner, which is what keeps it out of the way of the terminal. Once moved
   *  it is anchored top-left, because that is what a drag means. */
  const [pos, setPos] = useState<PipPos | null>(null);
  const el = useRef<HTMLElement | null>(null);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    if (!supported || minimized || hidden) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const shot = await ipc.browserSnapshot(tabId, 720);
        if (stopped) return;
        setFrame(`data:image/png;base64,${shot.image}`);
        if (shot.width > 0 && shot.height > 0) setRatio(shot.width / shot.height);
        setFailed(false);
      } catch {
        if (!stopped) setFailed(true);
      }
      if (!stopped) timer = setTimeout(() => void tick(), FRAME_GAP_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [minimized, supported, tabId, hidden]);

  /** One pointer gesture on the window, so the pip keeps following the cursor
   *  after it leaves the small element the drag started on. */
  const track = (
    e: React.PointerEvent<Element>,
    onMove: (ev: PointerEvent) => void,
  ) => {
    if (e.button !== 0) return false;
    e.preventDefault();
    const target = e.currentTarget;
    const pointerId = e.pointerId;
    target.setPointerCapture?.(pointerId);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) onMove(ev);
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      target.releasePointerCapture?.(pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return true;
  };

  /** Where the pip sits inside its pane right now, whether it is still on the
   *  dealt corner or has already been dragged. Measured rather than tracked,
   *  because the pane itself moves when a panel opens. */
  const rects = useCallback(() => {
    const node = el.current;
    const box = node?.getBoundingClientRect();
    const area = (node?.offsetParent ?? document.body).getBoundingClientRect();
    return box ? { box, area } : null;
  }, []);

  /** Pull a dragged pip back inside the pane.
   *
   *  Clamping only while the pointer moves was not enough, because the pip
   *  changes size without anyone dragging it: restoring it from minimized makes
   *  it tall again, a frame with a new aspect ratio makes it taller, the resize
   *  grip makes it wider, and opening a panel makes the pane itself narrower.
   *  Each of those can push a pip that was against an edge out past it, where
   *  the header — the only thing that can drag it back — is unreachable.
   *
   *  A no-op while it still sits on its dealt corner: `pos` is null then, and
   *  the corner offsets keep it inside by construction. Returns the same object
   *  when nothing moved, so an observer firing on every frame of a transition
   *  doesn't re-render. */
  const reclamp = useCallback(() => {
    setPos((p) => {
      if (!p) return p;
      const at = rects();
      if (!at) return p;
      const next = clampPip(
        p,
        { width: at.box.width, height: at.box.height },
        { width: at.area.width, height: at.area.height },
      );
      return next.x === p.x && next.y === p.y ? p : next;
    });
  }, [rects]);

  // Its own size first — this runs after the DOM has the new box and before it
  // is painted, so a restore never shows a frame of the pip hanging off the
  // edge. `ratio` is in here because the frame drives the height.
  useLayoutEffect(reclamp, [reclamp, width, minimized, ratio, hidden]);

  // Then the pane's. ResizeObserver catches a panel opening or the window
  // changing shape; the resize listener is the same answer for environments
  // without one, and costs nothing when the pip has not been dragged.
  useEffect(() => {
    if (!pos) return;
    window.addEventListener("resize", reclamp);
    const node = el.current;
    const parent = node?.offsetParent ?? null;
    const ro =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(reclamp) : null;
    if (ro && node) ro.observe(node);
    if (ro && parent) ro.observe(parent);
    return () => {
      window.removeEventListener("resize", reclamp);
      ro?.disconnect();
    };
    // Only whether it is anchored matters — re-subscribing on every drag frame
    // would tear down and rebuild the observer sixty times a second.
  }, [pos !== null, reclamp]); // eslint-disable-line react-hooks/exhaustive-deps

  const startDrag = (e: React.PointerEvent<HTMLElement>) => {
    // The header carries the close and minimize buttons; a click on one of them
    // is not the start of a drag.
    if ((e.target as HTMLElement).closest("button")) return;
    const at = rects();
    if (!at) return;
    const grabX = e.clientX - at.box.left;
    const grabY = e.clientY - at.box.top;
    track(e, (ev) => {
      const now = rects();
      if (!now) return;
      setPos(
        clampPip(
          { x: ev.clientX - now.area.left - grabX, y: ev.clientY - now.area.top - grabY },
          { width: now.box.width, height: now.box.height },
          { width: now.area.width, height: now.area.height },
        ),
      );
    });
  };

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const startX = e.clientX;
    const startWidth = widthRef.current;
    const startLeft = pos?.x ?? null;
    track(e, (ev) => {
      const next = pipWidth(startWidth, startX, ev.clientX, window.innerWidth);
      setWidth(next);
      // Anchored top-left after a drag, so holding the right edge still means
      // moving the left one — the grip is on the left.
      if (startLeft !== null) setPos((p) => (p ? { ...p, x: Math.max(0, startLeft + startWidth - next) } : p));
    });
  };

  let host = "Browser";
  try {
    host = new URL(url).host;
  } catch {
    // The linked preview may still be navigating; its next render updates this.
  }

  const placement = pos
    ? { left: pos.x, top: pos.y, right: "auto" as const, bottom: "auto" as const }
    : { right: EDGE + slot * SLOT_STEP, bottom: EDGE + slot * SLOT_STEP };

  return (
    <aside
      ref={el}
      className={`agent-browser-pip${minimized ? " minimized" : ""}`}
      style={{ width, ...placement, ...(hidden ? { display: "none" } : null) }}
      // display:none takes it out of the accessibility tree and out of the
      // browser-occlusion walk (browserHost measures rectangles, and it no
      // longer has one) — which is what a pip over its own live view should do.
      aria-label={`${agentTitle} browser picture in picture`}
    >
      <header
        className="agent-browser-pip-head"
        onPointerDown={startDrag}
        title="Drag to move"
      >
        <span className="agent-browser-pip-agent">
          <AgentIcon id={agentId} size={14} />
          <span>{agentTitle}</span>
        </span>
        <span className="agent-browser-pip-page" title={url}>
          <GlobeIcon size={12} /> {host}
        </span>
        <button
          className="agent-browser-pip-action"
          title={minimized ? "Restore browser picture in picture" : "Minimize browser picture in picture"}
          aria-label={minimized ? "Restore browser picture in picture" : "Minimize browser picture in picture"}
          onClick={() => setMinimized((v) => !v)}
        >
          {minimized ? "□" : "−"}
        </button>
        <button
          className="agent-browser-pip-action"
          title="Close browser picture in picture"
          aria-label="Close browser picture in picture"
          onClick={onClose}
        >
          <CloseIcon size={13} />
        </button>
      </header>
      {!minimized && (
        <div className="agent-browser-pip-frame" style={{ aspectRatio: ratio }}>
          {frame ? (
            <img src={frame} alt={`Live read-only view of ${host}`} draggable={false} />
          ) : (
            <span>{supported && !failed ? "Connecting to browser..." : "Live view unavailable"}</span>
          )}
          <span className="agent-browser-pip-readonly">Live / read only</span>
          <div
            className="agent-browser-pip-resize"
            role="separator"
            aria-label="Resize browser picture in picture"
            aria-orientation="vertical"
            onPointerDown={startResize}
          />
        </div>
      )}
    </aside>
  );
}

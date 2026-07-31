// The companion, floating.
//
// One layer, mounted once in App beside <Dictation /> and <TooltipLayer />,
// deliberately above every project rather than inside one — the companion
// belongs to the workspace, and a per-project instance would be a different
// feature (and a different conversation) per tab.
//
// The host boundary is real: everything below positions itself against a
// `Viewport` it is handed, and nothing reads `window.innerWidth` directly. That
// is what would let the whole thing move into a separate always-on-top window
// later without touching the mascot, the drag or the panel — only what supplies
// the viewport changes.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  DEFAULT_SPOT,
  clampSpot,
  companionName,
  panelPlacement,
  pixelsToSpot,
  spotToPixels,
  type CompanionSpot,
} from "../companion";
import {
  companionState,
  sendToCompanion,
  subscribeCompanion,
  type CompanionProposal,
  type CompanionState,
} from "../companionSession";
import { ashStateFor, toastMs, type AttentionItem } from "../attention";
import { browserViewSnapshots, onBrowserSignal } from "../browserSignals";
import { getSettings, updateSettings, SETTINGS_CHANGE_EVENT } from "../settings";
import { Mascot } from "./Mascot";
import { CompanionChat } from "./CompanionChat";
import type { AshState } from "../ash";

/** The mascot's rendered box. Everything else measures against it, so it is one
 *  number rather than a magic constant in three files. */
const MASCOT = 54;
const PANEL_WIDTH = 352;
const PANEL_HEIGHT = 380;
const GAP = 14;
/** How far the pointer has to travel before a press counts as a drag rather
 *  than a click. Below this, a click with a shaky hand would move the companion
 *  instead of opening it. */
const DRAG_SLOP = 4;

interface CompanionProps {
  /** What would otherwise have been a corner toast. Presented from wherever
   *  the companion is instead — see the note in App. */
  notices: AttentionItem[];
  onDismissNotice: (id: string) => void;
  onFollowNotice: (item: AttentionItem) => void;
  /** An action the companion is blocked on. */
  proposal: CompanionProposal | null;
  onAnswerProposal: (accepted: boolean) => void;
  /** Open Settings where an agent CLI can be installed. */
  onInstallCli: () => void;
  /** Start the session again after it died. */
  onRetry: () => void;
}

/** Whether a native browser view is on screen right now.
 *
 *  The companion has to get out of the way of one, and not for tidiness: a
 *  child webview is composited above the entire window with no z-order API
 *  (see the note on `browserEngine` in settings.ts), so anything painted over
 *  it makes the host hide the page to keep the overlay readable. A mascot
 *  parked over a preview would not float above it — it would blank it.
 *
 *  Read from the host's own snapshots rather than measured here, for the same
 *  reason the watchdog does: re-deriving it would just reach the same wrong
 *  answer by a second route. */
function useBrowserShowing(): boolean {
  const [showing, setShowing] = useState(false);
  useEffect(() => {
    const read = () => setShowing(browserViewSnapshots().some((v) => v.shown));
    read();
    // Signals cover every deliberate show/hide; the interval catches the ones
    // nothing announces — a pane drag, a tab closing under it.
    const off = onBrowserSignal(read);
    const timer = window.setInterval(read, 400);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, []);
  return showing;
}

function useViewport() {
  const [view, setView] = useState(() => ({
    width: typeof window === "undefined" ? 1440 : window.innerWidth,
    height: typeof window === "undefined" ? 900 : window.innerHeight,
  }));
  useEffect(() => {
    const onResize = () =>
      setView({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return view;
}

function useSpot(): [CompanionSpot, (next: CompanionSpot) => void] {
  const stored = useSyncExternalStore(
    (cb) => {
      window.addEventListener(SETTINGS_CHANGE_EVENT, cb);
      return () => window.removeEventListener(SETTINGS_CHANGE_EVENT, cb);
    },
    () => getSettings().companionSpot,
    () => DEFAULT_SPOT,
  );
  const save = useCallback(
    (next: CompanionSpot) => updateSettings({ companionSpot: clampSpot(next) }),
    [],
  );
  return [clampSpot(stored), save];
}

/** The face. The companion wears what it is doing, and — when something is
 *  waiting — what the notice needs, because the notice is being delivered *by*
 *  it and a cheerful idle face over a failure reads as a bug. */
function faceFor(
  state: CompanionState,
  notice: AttentionItem | undefined,
  waiting: boolean,
): AshState {
  // Waiting on an answer outranks everything: the agent is blocked, and a
  // thinking face over a question that needs answering is the one state that
  // actively misleads.
  if (waiting) return "needs";
  if (notice) return ashStateFor(notice);
  switch (state.status) {
    case "working":
      return "thinking";
    case "failed":
      return "blocked";
    // Asleep rather than blocked: with no agent CLI installed there is nothing
    // wrong, it simply has nothing to think with yet. Still on screen — going
    // invisible would leave the user with no way to find out what it needs.
    case "unavailable":
    case "starting":
      return "sleeping";
    default:
      return "idle";
  }
}

export function Companion({
  notices,
  onDismissNotice,
  onFollowNotice,
  proposal,
  onAnswerProposal,
  onInstallCli,
  onRetry,
}: CompanionProps) {
  const state = useSyncExternalStore(subscribeCompanion, companionState, () => companionState());
  const browserShowing = useBrowserShowing();
  const view = useViewport();
  const [spot, saveSpot] = useSpot();
  const [open, setOpen] = useState(false);
  // Live position while dragging: settings are only written on release, so a
  // drag does not put a localStorage write on every pointermove.
  const [dragSpot, setDragSpot] = useState<CompanionSpot | null>(null);
  const drag = useRef<{ dx: number; dy: number; moved: boolean } | null>(null);
  // Read in the pointer handler, which is memoised on inputs that must not
  // include a proposal arriving mid-drag.
  const proposalRef = useRef<CompanionProposal | null>(null);
  proposalRef.current = proposal;
  const name = companionName();

  const at = spotToPixels(dragSpot ?? spot, view, MASCOT);
  const panel = useMemo(
    () =>
      panelPlacement(at, view, {
        mascot: MASCOT,
        panelWidth: PANEL_WIDTH,
        panelHeight: PANEL_HEIGHT,
        gap: GAP,
      }),
    [at.left, at.top, view.width, view.height], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The notice being shown. One at a time, newest first: the companion is a
  // 54px mark, not a stack, and three cards fanned out from it would cover the
  // work. The rest stay in the notification centre, which is where a queue
  // belongs.
  const notice = notices[notices.length - 1];

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Left button only — a right click is the context menu everywhere else.
      if (e.button !== 0) return;
      (e.target as Element).setPointerCapture?.(e.pointerId);
      drag.current = { dx: e.clientX - at.left, dy: e.clientY - at.top, moved: false };
    },
    [at.left, at.top],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const left = e.clientX - d.dx;
      const top = e.clientY - d.dy;
      if (
        !d.moved &&
        Math.abs(left - at.left) < DRAG_SLOP &&
        Math.abs(top - at.top) < DRAG_SLOP
      ) {
        return;
      }
      d.moved = true;
      setDragSpot(pixelsToSpot(left, top, view, MASCOT));
    },
    [at.left, at.top, view],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      drag.current = null;
      (e.target as Element).releasePointerCapture?.(e.pointerId);
      if (!d) return;
      if (d.moved) {
        // Computed from this event rather than read from `dragSpot`, which is
        // state and therefore one render behind. A flick fast enough that the
        // last move and the release land in the same frame would otherwise
        // save where the drag *started*, and the companion would snap back —
        // rare, unreproducible by hand, and exactly the kind of thing that
        // gets filed as "it sometimes forgets where I put it".
        saveSpot(pixelsToSpot(e.clientX - d.dx, e.clientY - d.dy, view, MASCOT));
        setDragSpot(null);
        return;
      }
      // A click with a notice showing follows the notice rather than opening
      // the chat: the companion just told them something, and the obvious
      // meaning of clicking it is "take me there". A pending proposal beats
      // that — the panel holding the question is where the click should land.
      if (proposalRef.current) setOpen(true);
      else if (notice) onFollowNotice(notice);
      else setOpen((v) => !v);
    },
    [saveSpot, view, notice, onFollowNotice],
  );

  // A proposal opens the panel on its own. The companion is blocked on the
  // answer, and a question asked into a closed panel is a companion that
  // appears to have silently stopped working.
  useEffect(() => {
    if (proposal) setOpen(true);
  }, [proposal]);

  // Esc closes the panel, matching every other overlay in the app. Never while
  // a proposal is up: dismissing the surface is not answering the question, and
  // the agent would still be waiting.
  useEffect(() => {
    if (!open || proposal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, proposal]);

  const dragging = Boolean(dragSpot);

  // Nothing at all while a native browser view is up — not hidden with CSS,
  // which would still leave a painted box for the host's occlusion walk to
  // find and answer by blanking the page.
  if (browserShowing) return null;

  return (
    <>
      <div
        className={`companion${dragging ? " companion-dragging" : ""}`}
        style={{ left: at.left, top: at.top, width: MASCOT, height: MASCOT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        tabIndex={0}
        role="button"
        aria-label={open ? `Close ${name}` : `Ask ${name}`}
        aria-expanded={open}
        title={dragging ? undefined : `Ask ${name}`}
      >
        <Mascot state={faceFor(state, notice, Boolean(proposal))} size={MASCOT} />
      </div>

      {/* The notice, delivered from wherever the companion is standing. Same
          items, same queue, same urgency rules as the corner toast — only the
          messenger changed. */}
      {notice && !dragging && (
        <CompanionNotice
          item={notice}
          at={panel}
          more={notices.length - 1}
          onDismiss={() => onDismissNotice(notice.id)}
          onFollow={() => onFollowNotice(notice)}
        />
      )}

      {open && !dragging && (
        <CompanionChat
          state={state}
          name={name}
          at={panel}
          width={PANEL_WIDTH}
          height={PANEL_HEIGHT}
          proposal={proposal}
          onAnswer={onAnswerProposal}
          onInstall={onInstallCli}
          onRetry={onRetry}
          onSend={(text) => void sendToCompanion(text)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function CompanionNotice({
  item,
  at,
  more,
  onDismiss,
  onFollow,
}: {
  item: AttentionItem;
  at: { left: number; top: number; side: "left" | "right" };
  more: number;
  onDismiss: () => void;
  onFollow: () => void;
}) {
  // A question never fades — it is outstanding until answered, and the
  // companion is only its messenger. `toastMs` is the queue's own rule; this
  // does not get to invent a second one.
  const fades = toastMs(item) != null;
  return (
    <div
      className={`companion-notice companion-notice-${at.side}${fades ? "" : " companion-notice-held"}`}
      style={{ left: at.left, top: at.top, width: PANEL_WIDTH }}
      role="status"
    >
      <button className="companion-notice-body" onClick={onFollow} type="button">
        <span className="companion-notice-title">{item.title}</span>
        {item.body && <span className="companion-notice-text">{item.body}</span>}
        {item.projectName && (
          <span className="companion-notice-where">{item.projectName}</span>
        )}
      </button>
      {more > 0 && <span className="companion-notice-more">+{more}</span>}
      <button
        className="companion-notice-x"
        onClick={onDismiss}
        aria-label="Dismiss"
        type="button"
      >
        ✕
      </button>
    </div>
  );
}

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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
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
import { ashStateFor, isOutstanding, type AttentionItem } from "../attention";
import { useNativeSurface } from "../activeView";
import { getSettings, updateSettings, SETTINGS_CHANGE_EVENT } from "../settings";
import { Mascot } from "./Mascot";
import { CompanionChat } from "./CompanionChat";
import type { AshState } from "../ash";

/** The mascot's rendered box. Everything else measures against it, so it is one
 *  number rather than a magic constant in three files. */
const MASCOT = 54;
const PANEL_WIDTH = 352;
const PANEL_HEIGHT = 380;
/** What a notice card is taken to be tall before it has been measured — one
 *  line of title, one of body. Only the bottom clamp reads it, so being wrong
 *  for a frame costs nothing; being wrong forever is what `PANEL_HEIGHT` was. */
const NOTICE_HEIGHT = 76;
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
  // Whether a native browser view is claiming the pane. One subscription to the
  // one channel (activeView.ts) — not a measurement taken here, and not a timer
  // of its own: a mascot parked over a child webview does not float above it,
  // it makes the host blank the page to keep the mascot readable.
  const browserInFront = useNativeSurface();
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

  // The card is not the panel, and placing it with the panel's geometry meant
  // the panel's 380px bottom clamp: with the companion parked near the bottom
  // edge — where it starts — the card was pushed a third of the window above
  // the mascot supposedly saying it, floating unattached in the middle of the
  // work. It gets its own placement, off its own height.
  //
  // Measured rather than assumed, because the height is genuinely variable: a
  // title that wraps to four lines is three times a one-liner, and the height's
  // only job here is to keep the card's bottom on screen.
  const [noticeHeight, setNoticeHeight] = useState(NOTICE_HEIGHT);
  const noticeAt = useMemo(
    () =>
      panelPlacement(at, view, {
        mascot: MASCOT,
        panelWidth: PANEL_WIDTH,
        panelHeight: noticeHeight,
        gap: GAP,
      }),
    [at.left, at.top, view.width, view.height, noticeHeight], // eslint-disable-line react-hooks/exhaustive-deps
  );

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

  // Nothing at all while a browser tab is in front — not hidden with CSS,
  // which would still leave a painted box for the host's occlusion walk to
  // find and answer by blanking the page. The notice and the chat go with it;
  // they hang off the mascot, and a card floating where the mascot isn't would
  // blank the page on its own.
  if (browserInFront) return null;

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
          at={noticeAt}
          more={notices.length - 1}
          onDismiss={() => onDismissNotice(notice.id)}
          onFollow={() => onFollowNotice(notice)}
          onHeight={setNoticeHeight}
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
  onHeight,
}: {
  item: AttentionItem;
  at: { left: number; top: number; side: "left" | "right" };
  more: number;
  onDismiss: () => void;
  onFollow: () => void;
  onHeight: (px: number) => void;
}) {
  // The standing accent edge means "outstanding" — a question nobody has
  // answered yet. It used to be drawn for anything that does not fade, which an
  // *error* also satisfies (high urgency, no timer), so a failure wore the
  // question's accent while Ash wore `blocked` red for the same item. That is
  // precisely the disagreement the corner strip removed when it dropped its own
  // stripe. `isOutstanding` is the queue's own predicate; this does not get to
  // invent a second one, and the tone gets its own quiet tint below instead.
  const held = isOutstanding(item);
  const box = useRef<HTMLDivElement>(null);
  // Before paint, so the card is never drawn once at the assumed height and
  // again where it belongs.
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight;
    if (h) onHeight(h);
  }, [item.id, item.title, item.body, item.projectName, onHeight]);
  return (
    <div
      ref={box}
      className={`companion-notice companion-notice-${at.side} companion-notice-${item.tone}${held ? " companion-notice-held" : ""}`}
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

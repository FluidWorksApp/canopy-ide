// Remote desktop UI, both sides of a session (docs/remote-desktop.md).
//
// Viewer: a canvas that paints the teammate's JPEG frames and, only when the
// grant is "control", forwards pointer, wheel and key input. Target: a consent
// dialog (nothing is captured until it is answered) and a banner that stays on
// screen for as long as the session is live, with a Stop button.
import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import {
  bannerText,
  canSendInput,
  clampScroll,
  createThrottle,
  isBeingViewed,
  mapKeyCode,
  mouseButton,
  needsConsent,
  pointerToNormalized,
  viewerStatus,
  type DeskMode,
  type DeskStateEvent,
  type DeskView,
  type FrameBus,
  type InputEvent,
} from "../desk";
import { Dialog } from "./Dialog";
import type { Notify, RelayHandle } from "../types";

const MOVE_GAP_MS = 33;

function send(session: string, event: InputEvent) {
  void ipc.deskSendInput(session, event).catch(() => {
    /* the session ending races with in-flight input; the state event tells the user */
  });
}

export function ConsentDialog({ session }: { session: DeskStateEvent }) {
  const answer = (accept: boolean, mode: DeskMode) =>
    void ipc.deskRespond(session.session, accept, mode).catch(() => {});
  const viewOnly = session.requested === "view-only";
  return (
    <Dialog
      variant="accent"
      title={`${session.peer_name} wants to see your screen`}
      body={`${viewOnly ? "They asked to view only. " : ""}Nothing is shared until you choose. You can stop the session at any time from the banner at the top of the window. Names are chosen by each person, so only accept from someone you expect.`}
      meta={viewOnly ? "They will not be able to move your mouse or type." : "Control lets them move your mouse and type on this computer."}
      dismissLabel="Deny"
      onDismiss={() => answer(false, "view-only")}
      actions={[
        { label: "Accept view-only", primary: true, onClick: () => answer(true, "view-only") },
        ...(viewOnly
          ? []
          : [{ label: "Accept control", onClick: () => answer(true, "control") }]),
      ]}
    />
  );
}

export function ControlledBanner({ session }: { session: DeskStateEvent }) {
  return (
    <div className="desk-banner" role="alert">
      <span>{bannerText(session)}</span>
      <button type="button" onClick={() => void ipc.deskEnd(session.session).catch(() => {})}>
        Stop
      </button>
    </div>
  );
}

export function RemoteDesktopView({
  view,
  frames,
  onClose,
}: {
  view: DeskStateEvent;
  frames: FrameBus;
  onClose: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const moveGate = useRef(createThrottle(MOVE_GAP_MS));
  const sessionRef = useRef(view.session);
  sessionRef.current = view.session;
  const held = useRef(new Set<string>());
  const control = canSendInput(view);
  const live = view.state !== "ended";

  useEffect(
    () =>
      frames.subscribe((f) => {
        if (f.session !== sessionRef.current) return;
        size.current = { w: f.w, h: f.h };
        const el = canvas.current;
        if (!el || typeof createImageBitmap !== "function") return;
        void (async () => {
          try {
            const bin = atob(f.jpeg_b64);
            const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
            const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
            // Trust the decoded size, not the peer's header, and bound it.
            if (bmp.width > 4096 || bmp.height > 4096 || bmp.width !== f.w || bmp.height !== f.h) {
              bmp.close();
              return;
            }
            if (el.width !== f.w) el.width = f.w;
            if (el.height !== f.h) el.height = f.h;
            el.getContext("2d")?.drawImage(bmp, 0, 0);
            bmp.close();
          } catch {
            /* a corrupt frame is dropped; the next one repaints */
          }
        })();
      }),
    [frames],
  );

  const norm = useCallback((clientX: number, clientY: number) => {
    const el = canvas.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return pointerToNormalized(clientX, clientY, r, size.current.w, size.current.h);
  }, []);

  const releaseHeld = () => {
    for (const k of held.current) {
      if (k.startsWith("b:")) {
        send(sessionRef.current, { kind: "mouse-button", button: k.slice(2) as Extract<InputEvent, { kind: "mouse-button" }>["button"], down: false });
      } else {
        send(sessionRef.current, { kind: "key", code: k.slice(2), down: false });
      }
    }
    held.current.clear();
  };

  const emit = (event: InputEvent) => {
    if (event.kind === "key") {
      if (event.down) held.current.add(`k:${event.code}`);
      else held.current.delete(`k:${event.code}`);
    } else if (event.kind === "mouse-button") {
      if (event.down) held.current.add(`b:${event.button}`);
      else held.current.delete(`b:${event.button}`);
    }
    if (control) send(view.session, event);
  };

  return (
    <div className="desk-viewer" role="dialog" aria-label={`Remote desktop: ${view.peer_name}`}>
      <div className="desk-viewer-bar">
        <strong>{view.peer_name}</strong>
        <span className={`desk-badge ${control ? "control" : "view"}`}>
          {control ? "Control" : "View only"}
        </span>
        <span className="desk-status">{viewerStatus(view)}</span>
        <span className="desk-spacer" />
        {live ? (
          <button type="button" onClick={() => void ipc.deskEnd(view.session).catch(() => {})}>
            End
          </button>
        ) : (
          <button type="button" onClick={onClose}>
            Close
          </button>
        )}
      </div>
      <canvas
        ref={canvas}
        className="desk-canvas"
        tabIndex={0}
        aria-label="Remote screen"
        onBlur={releaseHeld}
        onContextMenu={(e) => control && e.preventDefault()}
        onMouseMove={(e) => {
          if (!control || !moveGate.current(performance.now())) return;
          const p = norm(e.clientX, e.clientY);
          if (p) emit({ kind: "mouse-move", ...p });
        }}
        onMouseDown={(e) => {
          const b = mouseButton(e.button);
          const p = norm(e.clientX, e.clientY);
          if (!control || !b || !p) return;
          e.currentTarget.focus();
          emit({ kind: "mouse-move", ...p });
          emit({ kind: "mouse-button", button: b, down: true });
        }}
        onMouseUp={(e) => {
          const b = mouseButton(e.button);
          if (control && b) emit({ kind: "mouse-button", button: b, down: false });
        }}
        onWheel={(e) => {
          if (!control) return;
          emit({ kind: "scroll", dx: clampScroll(e.deltaX), dy: clampScroll(e.deltaY) });
        }}
        onKeyDown={(e) => {
          const code = mapKeyCode(e.code);
          if (!control || !code) return;
          e.preventDefault();
          emit({ kind: "key", code, down: true });
        }}
        onKeyUp={(e) => {
          const code = mapKeyCode(e.code);
          if (!control || !code) return;
          e.preventDefault();
          emit({ kind: "key", code, down: false });
        }}
      />
    </div>
  );
}

/** Mounted once by App. Renders whichever surface the current session needs. */
export function DeskOverlay({
  desk,
  frames,
  onDismiss,
}: {
  desk: DeskView;
  frames: FrameBus;
  onDismiss: () => void;
}) {
  const [hidden, setHidden] = useState<string | null>(null);
  if (!desk) return null;
  if (needsConsent(desk)) return <ConsentDialog session={desk} />;
  if (isBeingViewed(desk)) return <ControlledBanner session={desk} />;
  if (desk.role === "viewer" && hidden !== desk.session) {
    return (
      <RemoteDesktopView
        view={desk}
        frames={frames}
        onClose={() => {
          setHidden(desk.session);
          onDismiss();
        }}
      />
    );
  }
  return null;
}

/** Team panel section: one "Remote desktop" action per connected teammate.
 *  Never offered for yourself, and not while a session is already running. */
export function RemoteDesktopMembers({
  relay,
  onNotice,
}: {
  relay: RelayHandle;
  onNotice?: Notify;
}) {
  const { self_id: selfId, role, members } = relay.status;
  if (role === "off") return null;
  const others = members.filter((m) => m.id !== selfId);
  if (others.length === 0) return null;
  const busy = !!relay.desk && relay.desk.state !== "ended";
  return (
    <section className="desk-members" aria-label="Remote desktop">
      <h3 className="team-hub-section">Remote desktop</h3>
      {others.map((m) => (
        <div key={m.id} className="team-row">
          <span className="team-row-text">
            <strong>{m.name}</strong>
          </span>
          <button
            type="button"
            className="btn"
            disabled={busy}
            title={`Ask ${m.name} to share their screen. They must accept.`}
            aria-label={`Remote desktop with ${m.name}`}
            onClick={() =>
              relay.deskRequest(m.id, "control").catch((err) => onNotice?.(String(err), "error"))
            }
          >
            Remote desktop
          </button>
        </div>
      ))}
    </section>
  );
}

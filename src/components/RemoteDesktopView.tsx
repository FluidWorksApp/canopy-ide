// Remote desktop UI, both sides of a session (docs/remote-desktop.md).
//
// Viewer: a canvas that paints the teammate's JPEG frames and, only when the
// grant is "control", forwards pointer, wheel and key input. Target: a consent
// dialog (nothing is captured until it is answered) and a banner that stays on
// screen for as long as the session is live, with a Stop button.
import { useCallback, useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import type { RelayMember } from "../ipc";
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
import { Button } from "./ui";
import type { Notify, RelayHandle } from "../types";

const MOVE_GAP_MS = 33;
const MAX_FRAME_DIMENSION = 4096;

function send(session: string, event: InputEvent) {
  void ipc.deskSendInput(session, event).catch(() => {
    /* The state event reports a session ending while input is in flight. */
  });
}

function shortFingerprint(key: string | null): string | null {
  if (!key) return null;
  const compact = key.replace(/[^a-fA-F0-9]/g, "").toUpperCase();
  if (!compact) return null;
  return compact.slice(0, 12).match(/.{1,4}/g)?.join(" ") ?? null;
}

function trustEvidence(member?: RelayMember): string {
  if (!member) return "Device identity is unavailable for this member.";
  const fingerprint = shortFingerprint(member.key);
  const key = fingerprint ? ` Key ${fingerprint}.` : " Key fingerprint unavailable.";
  switch (member.trust) {
    case "known":
      return `Known device.${key}`;
    case "changed":
      return `Warning: this device key changed.${key}`;
    case "new":
      return `First-seen device.${key}`;
    case "relayed":
      return `Identity is asserted by the relay host, not verified directly.${key}`;
    case "self":
      return `This is your device.${key}`;
    default:
      return `Device identity is unavailable.${key}`;
  }
}

export function ConsentDialog({
  session,
  member,
}: {
  session: DeskStateEvent;
  member?: RelayMember;
}) {
  const [answering, setAnswering] = useState<DeskMode | "deny" | null>(null);
  const [error, setError] = useState("");
  const answer = (accept: boolean, mode: DeskMode) => {
    if (answering) return;
    setAnswering(accept ? mode : "deny");
    setError("");
    void ipc.deskRespond(session.session, accept, mode).catch((reason) => {
      setAnswering(null);
      setError(String(reason));
    });
  };
  const viewOnly = session.requested === "view-only";
  return (
    <Dialog
      variant="accent"
      title={`${session.peer_name} wants to see your screen`}
      body={
        <>
          <span>
            {viewOnly ? "They asked to view only. " : ""}Nothing is shared until you choose.
            You can stop the session at any time from the banner at the top of the window.
          </span>
          <span className={`desk-trust ${member?.trust === "changed" ? "changed" : ""}`}>
            {trustEvidence(member)} Names are chosen by each person, so only accept from someone
            you expect.
          </span>
          {error && <span role="alert" className="desk-inline-error">{error}</span>}
        </>
      }
      meta={viewOnly ? "They will not be able to move your mouse or type." : "Control lets them move your mouse and type on this computer."}
      dismissLabel={answering === "deny" ? "Denying…" : "Deny"}
      onDismiss={() => answer(false, "view-only")}
      actions={[
        {
          label: answering === "view-only" ? "Accepting…" : "Accept view-only",
          primary: true,
          disabled: answering !== null,
          onClick: () => answer(true, "view-only"),
        },
        ...(viewOnly
          ? []
          : [{
              label: answering === "control" ? "Accepting…" : "Accept control",
              disabled: answering !== null,
              onClick: () => answer(true, "control"),
            }]),
      ]}
    />
  );
}

export function ControlledBanner({ session }: { session: DeskStateEvent }) {
  return (
    <div className="desk-banner" role="alert">
      <span>{bannerText(session)}</span>
      <Button size="sm" variant="danger" onClick={() => void ipc.deskEnd(session.session).catch(() => {})}>
        Stop
      </Button>
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
  const paintedSeq = useRef(-1);
  const focusedSession = useRef<string | null>(null);
  const moveGate = useRef(createThrottle(MOVE_GAP_MS));
  const sessionRef = useRef(view.session);
  sessionRef.current = view.session;
  const held = useRef(new Set<string>());
  const control = canSendInput(view);
  const live = view.state !== "ended";

  useEffect(() => {
    paintedSeq.current = -1;
    size.current = { w: 0, h: 0 };
    if (canvas.current) {
      canvas.current.width = 0;
      canvas.current.height = 0;
    }
  }, [view.session]);

  useEffect(
    () =>
      frames.subscribe((f) => {
        if (
          f.session !== sessionRef.current ||
          f.w <= 0 ||
          f.h <= 0 ||
          f.w > MAX_FRAME_DIMENSION ||
          f.h > MAX_FRAME_DIMENSION
        ) return;
        const el = canvas.current;
        if (!el || typeof createImageBitmap !== "function") return;
        void (async () => {
          try {
            const bin = atob(f.jpeg_b64);
            const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
            const bmp = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
            const valid =
              bmp.width > 0 &&
              bmp.height > 0 &&
              bmp.width <= MAX_FRAME_DIMENSION &&
              bmp.height <= MAX_FRAME_DIMENSION &&
              bmp.width === f.w &&
              bmp.height === f.h;
            if (
              !valid ||
              f.session !== sessionRef.current ||
              f.seq <= paintedSeq.current
            ) {
              bmp.close();
              return;
            }
            const context = el.getContext("2d");
            if (!context) {
              bmp.close();
              return;
            }
            if (el.width !== f.w) el.width = f.w;
            if (el.height !== f.h) el.height = f.h;
            context.drawImage(bmp, 0, 0);
            size.current = { w: f.w, h: f.h };
            paintedSeq.current = f.seq;
            bmp.close();
          } catch {
            /* A corrupt frame is dropped; the next valid frame repaints. */
          }
        })();
      }),
    [frames],
  );

  useEffect(() => {
    if (!control || focusedSession.current === view.session) return;
    focusedSession.current = view.session;
    canvas.current?.focus({ preventScroll: true });
  }, [control, view.session]);

  // React delegates wheel events through a passive root listener. A native,
  // non-passive target listener is required to stop the workbench from
  // scrolling while the pointer is over the remote screen.
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const blockDefault = (event: Event) => event.preventDefault();
    element.addEventListener("wheel", blockDefault, { passive: false });
    element.addEventListener("contextmenu", blockDefault);
    return () => {
      element.removeEventListener("wheel", blockDefault);
      element.removeEventListener("contextmenu", blockDefault);
    };
  }, []);

  const norm = useCallback((clientX: number, clientY: number) => {
    const el = canvas.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return pointerToNormalized(clientX, clientY, r, size.current.w, size.current.h);
  }, []);

  const releaseHeld = useCallback(() => {
    for (const k of held.current) {
      if (k.startsWith("b:")) {
        send(sessionRef.current, {
          kind: "mouse-button",
          button: k.slice(2) as Extract<InputEvent, { kind: "mouse-button" }>["button"],
          down: false,
        });
      } else {
        send(sessionRef.current, { kind: "key", code: k.slice(2), down: false });
      }
    }
    held.current.clear();
  }, []);

  const releaseMouseButton = useCallback(
    (button: Extract<InputEvent, { kind: "mouse-button" }>["button"]) => {
      const heldButton = `b:${button}`;
      if (!held.current.has(heldButton)) return;
      held.current.delete(heldButton);
      send(sessionRef.current, { kind: "mouse-button", button, down: false });
    },
    [],
  );

  // Pointer capture keeps a drag owned by the canvas. The window listener is
  // the fallback for WebViews that release capture over native chrome, and the
  // blur path covers leaving the application window entirely.
  useEffect(() => {
    const pointerUp = (event: PointerEvent) => {
      const button = mouseButton(event.button);
      if (button) releaseMouseButton(button);
    };
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", releaseHeld);
    window.addEventListener("blur", releaseHeld);
    return () => {
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", releaseHeld);
      window.removeEventListener("blur", releaseHeld);
      releaseHeld();
    };
  }, [releaseHeld, releaseMouseButton]);

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
        <span className="desk-status" role="status" aria-live="polite">
          {viewerStatus(view)}
        </span>
        <span className="desk-spacer" />
        {live ? (
          <Button size="sm" variant="danger" onClick={() => void ipc.deskEnd(view.session).catch(() => {})}>
            End
          </Button>
        ) : (
          <Button size="sm" onClick={onClose}>Close</Button>
        )}
      </div>
      <canvas
        ref={canvas}
        className="desk-canvas"
        tabIndex={0}
        aria-label="Remote screen"
        onBlur={releaseHeld}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onPointerMove={(event) => {
          if (!control || !moveGate.current(performance.now())) return;
          const p = norm(event.clientX, event.clientY);
          if (p) emit({ kind: "mouse-move", ...p });
        }}
        onPointerDown={(event) => {
          const button = mouseButton(event.button);
          const p = norm(event.clientX, event.clientY);
          if (!control || !button || !p) return;
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          emit({ kind: "mouse-move", ...p });
          emit({ kind: "mouse-button", button, down: true });
        }}
        onPointerUp={(event) => {
          const button = mouseButton(event.button);
          if (button) releaseMouseButton(button);
          if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }}
        onPointerCancel={() => releaseHeld()}
        onWheel={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!control) return;
          emit({ kind: "scroll", dx: clampScroll(event.deltaX), dy: clampScroll(event.deltaY) });
        }}
        onKeyDown={(event) => {
          const code = mapKeyCode(event.code);
          if (!control || !code) return;
          event.preventDefault();
          emit({ kind: "key", code, down: true });
        }}
        onKeyUp={(event) => {
          const code = mapKeyCode(event.code);
          if (!control || !code) return;
          event.preventDefault();
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
  relay,
  onDismiss,
}: {
  desk: DeskView;
  frames: FrameBus;
  relay?: RelayHandle;
  onDismiss: () => void;
}) {
  const [hidden, setHidden] = useState<string | null>(null);
  if (!desk) return null;
  if (needsConsent(desk)) {
    const member = relay?.status.members.find((candidate) => candidate.id === desk.peer);
    return <ConsentDialog session={desk} member={member} />;
  }
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

/** Team panel section: separate view and control requests for each connected
 * teammate. Never offered for yourself, and not while a session is running. */
export function RemoteDesktopMembers({
  relay,
  onNotice,
}: {
  relay: RelayHandle;
  onNotice?: Notify;
}) {
  const [pending, setPending] = useState<{ peer: string; mode: DeskMode } | null>(null);
  const [error, setError] = useState<{ peer: string; message: string } | null>(null);
  const { self_id: selfId, role, members } = relay.status;
  if (role === "off") return null;
  const others = members.filter((member) => member.id !== selfId);
  if (others.length === 0) return null;
  const busy = !!relay.desk && relay.desk.state !== "ended";

  const request = (peer: string, mode: DeskMode) => {
    if (pending || busy) return;
    setPending({ peer, mode });
    setError(null);
    void relay.deskRequest(peer, mode).catch((reason) => {
      const message = String(reason);
      setError({ peer, message });
      onNotice?.(message, "error");
    }).finally(() => setPending(null));
  };

  return (
    <section className="desk-members" aria-label="Remote desktop">
      <h3 className="team-hub-section">Remote desktop</h3>
      {others.map((member) => {
        const requestingView = pending?.peer === member.id && pending.mode === "view-only";
        const requestingControl = pending?.peer === member.id && pending.mode === "control";
        return (
          <div key={member.id} className="team-row desk-member-row">
            <span className="team-row-text">
              <strong>{member.name}</strong>
              {error?.peer === member.id && <span role="alert" className="desk-inline-error">{error.message}</span>}
              {pending?.peer === member.id && (
                <span role="status" aria-live="polite" className="desk-request-status">
                  Requesting {pending.mode === "control" ? "control" : "view only"}…
                </span>
              )}
            </span>
            <span className="desk-member-actions">
              <Button
                size="sm"
                disabled={busy || pending !== null}
                title={`Ask ${member.name} to share their screen for viewing. They must accept.`}
                aria-label={`View ${member.name}'s desktop`}
                onClick={() => request(member.id, "view-only")}
              >
                {requestingView ? "Requesting…" : "View"}
              </Button>
              <Button
                size="sm"
                variant="accent"
                disabled={busy || pending !== null}
                title={`Ask ${member.name} to share control. They must accept.`}
                aria-label={`Control ${member.name}'s desktop`}
                onClick={() => request(member.id, "control")}
              >
                {requestingControl ? "Requesting…" : "Control"}
              </Button>
            </span>
          </div>
        );
      })}
    </section>
  );
}

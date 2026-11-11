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
  return (
    compact
      .slice(0, 12)
      .match(/.{1,4}/g)
      ?.join(" ") ?? null
  );
}

function trustEvidence(member?: RelayMember): string {
  if (!member) return "Device identity is unavailable for this member.";
  const fingerprint = shortFingerprint(member.key);
  const key = fingerprint
    ? ` Key ${fingerprint}.`
    : " Key fingerprint unavailable.";
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
  // What the OS allows (macOS asks for Screen recording and Accessibility).
  const [perms, setPerms] = useState<ipc.DeskPerms | null>(null);
  useEffect(() => {
    let live = true;
    const check = () =>
      void ipc
        .deskPermissions()
        .then((p) => live && setPerms(p))
        .catch(() => live && setPerms({ screen: true, input: true }));
    check();
    window.addEventListener("focus", check);
    return () => {
      live = false;
      window.removeEventListener("focus", check);
    };
  }, []);
  const viewOk = !perms || perms.screen;
  const controlOk = !perms || (perms.screen && perms.input);
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
            {viewOnly ? "They asked to view only. " : ""}Nothing is shared until
            you choose. You can stop the session at any time from the banner at
            the top of the window.
          </span>
          <span
            className={`desk-trust ${member?.trust === "changed" ? "changed" : ""}`}
          >
            {trustEvidence(member)} Names are chosen by each person, so only
            accept from someone you expect.
          </span>
          {perms && (!perms.screen || !perms.input) && (
            <span className="desk-perms">
              {(
                [
                  ["screen", "Screen recording", perms.screen],
                  ["input", "Accessibility (control)", perms.input],
                ] as const
              ).map(([kind, label, ok]) => (
                <span key={kind} className="desk-perm">
                  <span>{label}</span>
                  {ok ? (
                    <span aria-label="Allowed">✓</span>
                  ) : (
                    <Button
                      size="sm"
                      variant="accent"
                      onClick={() =>
                        void ipc.deskRequestPermission(kind).catch(() => {})
                      }
                    >
                      Allow
                    </Button>
                  )}
                </span>
              ))}
              <span>Allow it in System Settings, then restart Canopy.</span>
            </span>
          )}
          {error && (
            <span role="alert" className="desk-inline-error">
              {error}
            </span>
          )}
        </>
      }
      meta={
        viewOnly
          ? "They will not be able to move your mouse or type."
          : "Control lets them move your mouse and type on this computer."
      }
      dismissLabel={answering === "deny" ? "Denying…" : "Deny"}
      onDismiss={() => answer(false, "view-only")}
      actions={[
        {
          label: answering === "view-only" ? "Accepting…" : "Accept view-only",
          primary: true,
          disabled: answering !== null || !viewOk,
          onClick: () => answer(true, "view-only"),
        },
        ...(viewOnly
          ? []
          : [
              {
                label:
                  answering === "control" ? "Accepting…" : "Accept control",
                disabled: answering !== null || !controlOk,
                onClick: () => answer(true, "control"),
              },
            ]),
      ]}
    />
  );
}

/** Shown on every screen while this desktop is shared (relay host), so sharing
 *  is never invisible and always has a Stop. The live-session banner covers a
 *  desk session; this covers the link itself. */
export function SharingBanner({
  relay,
  onStop,
}: {
  relay: RelayHandle;
  onStop: () => void;
}) {
  const s = relay.status;
  if (s.role !== "host" || relay.desk) return null;
  const others = s.members.filter((m) => m.id !== s.self_id).map((m) => m.name);
  return (
    <div className="desk-banner" role="alert">
      <span>
        {others.length
          ? `Sharing your desktop with ${others.join(", ")}`
          : "Sharing your desktop"}
      </span>
      <Button size="sm" variant="danger" onClick={onStop}>
        Stop
      </Button>
    </div>
  );
}

export function ControlledBanner({ session }: { session: DeskStateEvent }) {
  return (
    <div className="desk-banner" role="alert">
      <span>{bannerText(session)}</span>
      <Button
        size="sm"
        variant="danger"
        onClick={() => void ipc.deskEnd(session.session).catch(() => {})}
      >
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
  const viewer = useRef<HTMLDivElement>(null);
  const size = useRef({ w: 0, h: 0 });
  const paintedSeq = useRef(-1);
  const focusedSession = useRef<string | null>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const moveGate = useRef(createThrottle(MOVE_GAP_MS));
  const sessionRef = useRef(view.session);
  sessionRef.current = view.session;
  const held = useRef(new Set<string>());
  const heldSession = useRef<string | null>(null);
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
        )
          return;
        const el = canvas.current;
        if (!el || typeof createImageBitmap !== "function") return;
        void (async () => {
          try {
            const bin = atob(f.jpeg_b64);
            const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
            const bmp = await createImageBitmap(
              new Blob([bytes], { type: "image/jpeg" }),
            );
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
    restoreFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => restoreFocus.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (focusedSession.current === view.session) return;
    focusedSession.current = view.session;
    canvas.current?.focus({ preventScroll: true });
  }, [view.session]);

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
    return pointerToNormalized(
      clientX,
      clientY,
      r,
      size.current.w,
      size.current.h,
    );
  }, []);

  const releaseHeld = useCallback(() => {
    const session = heldSession.current;
    const inputs = [...held.current];
    held.current.clear();
    heldSession.current = null;
    if (!session) return;
    for (const k of inputs) {
      if (k.startsWith("b:")) {
        send(session, {
          kind: "mouse-button",
          button: k.slice(2) as Extract<
            InputEvent,
            { kind: "mouse-button" }
          >["button"],
          down: false,
        });
      } else {
        send(session, { kind: "key", code: k.slice(2), down: false });
      }
    }
  }, []);

  const releaseMouseButton = useCallback(
    (button: Extract<InputEvent, { kind: "mouse-button" }>["button"]) => {
      const heldButton = `b:${button}`;
      if (!held.current.has(heldButton)) return;
      held.current.delete(heldButton);
      const session = heldSession.current;
      if (held.current.size === 0) heldSession.current = null;
      if (session) send(session, { kind: "mouse-button", button, down: false });
    },
    [],
  );

  useEffect(() => {
    if (held.current.size && (heldSession.current !== view.session || !control))
      releaseHeld();
  }, [control, releaseHeld, view.session]);

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
      if (event.down) {
        held.current.add(`k:${event.code}`);
        heldSession.current = view.session;
      } else held.current.delete(`k:${event.code}`);
    } else if (event.kind === "mouse-button") {
      if (event.down) {
        held.current.add(`b:${event.button}`);
        heldSession.current = view.session;
      } else held.current.delete(`b:${event.button}`);
    }
    if (held.current.size === 0) heldSession.current = null;
    if (control) send(view.session, event);
  };

  const containFocus = (event: React.KeyboardEvent) => {
    if (event.key !== "Tab" || !viewer.current) return;
    const focusable = [
      ...viewer.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ),
    ];
    if (focusable.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    const current = focusable.indexOf(document.activeElement as HTMLElement);
    const next = event.shiftKey
      ? (current <= 0 ? focusable.length : current) - 1
      : (current + 1) % focusable.length;
    focusable[next].focus();
  };

  return (
    <div
      ref={viewer}
      className="desk-viewer"
      role="dialog"
      aria-modal="true"
      aria-label={`Remote desktop: ${view.peer_name}`}
      onKeyDownCapture={containFocus}
    >
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
          <Button
            size="sm"
            variant="danger"
            onClick={() => void ipc.deskEnd(view.session).catch(() => {})}
          >
            End
          </Button>
        ) : (
          <Button size="sm" onClick={onClose}>
            Close
          </Button>
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
          emit({
            kind: "scroll",
            dx: clampScroll(event.deltaX),
            dy: clampScroll(event.deltaY),
          });
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
    const member = relay?.status.members.find(
      (candidate) => candidate.id === desk.peer,
    );
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
  const [pending, setPending] = useState<{
    peer: string;
    mode: DeskMode;
  } | null>(null);
  const [error, setError] = useState<{ peer: string; message: string } | null>(
    null,
  );
  const { self_id: selfId, role, members } = relay.status;
  if (role === "off") return null;
  const others = members.filter((member) => member.id !== selfId);
  if (others.length === 0) return null;
  const busy = !!relay.desk && relay.desk.state !== "ended";

  const request = (peer: string, mode: DeskMode) => {
    if (pending || busy) return;
    setPending({ peer, mode });
    setError(null);
    void relay
      .deskRequest(peer, mode)
      .catch((reason) => {
        const message = String(reason);
        setError({ peer, message });
        onNotice?.(message, "error");
      })
      .finally(() => setPending(null));
  };

  return (
    <section className="desk-members" aria-label="Remote desktop">
      <h3 className="team-hub-section">Remote desktop</h3>
      {others.map((member) => {
        const requestingView =
          pending?.peer === member.id && pending.mode === "view-only";
        const requestingControl =
          pending?.peer === member.id && pending.mode === "control";
        return (
          <div key={member.id} className="team-row desk-member-row">
            <span className="team-row-text">
              <strong>{member.name}</strong>
              {error?.peer === member.id && (
                <span role="alert" className="desk-inline-error">
                  {error.message}
                </span>
              )}
              {pending?.peer === member.id && (
                <span
                  role="status"
                  aria-live="polite"
                  className="desk-request-status"
                >
                  Requesting{" "}
                  {pending.mode === "control" ? "control" : "view only"}…
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

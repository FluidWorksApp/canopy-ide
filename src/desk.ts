// Remote desktop over the team relay: the framework-free half. Wire types match
// crates/canopy-core/src/desk.rs and src-tauri/src/desk.rs; design and threat
// model are in docs/remote-desktop.md. Everything here is pure so the consent
// and view-only rules can be tested without React or a backend.

export type DeskMode = "view-only" | "control";

export type MouseButton = "left" | "right" | "middle";

export type InputEvent =
  | { kind: "mouse-move"; x: number; y: number }
  | { kind: "mouse-button"; button: MouseButton; down: boolean }
  | { kind: "scroll"; dx: number; dy: number }
  | { kind: "key"; code: string; down: boolean }
  | { kind: "text"; s: string };

export type DeskBody =
  | { kind: "request"; mode: DeskMode }
  | { kind: "accept"; mode: DeskMode }
  | { kind: "deny"; reason: string }
  | { kind: "frame"; seq: number; w: number; h: number; jpeg_b64: string }
  | { kind: "input"; event: InputEvent }
  | { kind: "ping" }
  | { kind: "end"; reason: string };

/** `relay:desk`: only accepted frames reach the viewer UI. */
export interface DeskMsg {
  id: string;
  from: string;
  from_name: string;
  to: string;
  session: string;
  body: DeskBody;
  ts: number;
}

/** `desk:state` payload (and, minus `reason`, the `desk_status` result). */
export interface DeskStateEvent {
  session: string;
  state: "requested" | "active" | "ended";
  role: "viewer" | "target";
  peer: string;
  peer_name: string;
  mode: DeskMode | null;
  reason?: string | null;
}

// ---------- session state ----------

export type DeskView = DeskStateEvent | null;

export type DeskAction =
  | { type: "state"; event: DeskStateEvent }
  | { type: "dismiss"; session?: string };

/** Last state wins, except that a late event for a different session never
 *  clobbers a live one (the backend only runs one session at a time). */
export function deskReducer(state: DeskView, action: DeskAction): DeskView {
  if (action.type === "dismiss") {
    if (!state) return state;
    if (action.session && action.session !== state.session) return state;
    return null;
  }
  const ev = action.event;
  if (state && state.session !== ev.session && state.state !== "ended") {
    return state;
  }
  return ev;
}

/** The target side must show the consent dialog. */
export const needsConsent = (s: DeskView): boolean =>
  !!s && s.role === "target" && s.state === "requested";

/** The target side must show the persistent banner. */
export const isBeingViewed = (s: DeskView): boolean =>
  !!s && s.role === "target" && s.state === "active";

/** Input may only leave the viewer while the grant is control. */
export const canSendInput = (s: DeskView): boolean =>
  !!s && s.role === "viewer" && s.state === "active" && s.mode === "control";

export function bannerText(s: DeskStateEvent): string {
  return s.mode === "control"
    ? `${s.peer_name} is controlling your screen`
    : `${s.peer_name} is viewing your screen`;
}

export function viewerStatus(s: DeskStateEvent): string {
  if (s.state === "requested") return "Waiting for consent";
  if (s.state === "active") return s.mode === "control" ? "Control" : "View only";
  const r = (s.reason ?? "").trim();
  if (/declin|den(y|ied)/i.test(r)) return r ? `Denied: ${r}` : "Denied";
  return r ? `Ended: ${r}` : "Ended";
}

// ---------- pointer mapping ----------

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where the remote frame is actually drawn inside a canvas box laid out with
 *  object-fit: contain, i.e. minus the letterbox bars. */
export function contentRect(box: Box, frameW: number, frameH: number): Box {
  if (frameW <= 0 || frameH <= 0 || box.width <= 0 || box.height <= 0) {
    return { left: box.left, top: box.top, width: 0, height: 0 };
  }
  const scale = Math.min(box.width / frameW, box.height / frameH);
  const width = frameW * scale;
  const height = frameH * scale;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

/** Client pointer position to normalized 0..1 frame coordinates, or null when
 *  the pointer is over a letterbox bar (nothing remote lives there). */
export function pointerToNormalized(
  clientX: number,
  clientY: number,
  box: Box,
  frameW: number,
  frameH: number,
): { x: number; y: number } | null {
  const r = contentRect(box, frameW, frameH);
  if (r.width === 0 || r.height === 0) return null;
  const x = (clientX - r.left) / r.width;
  const y = (clientY - r.top) / r.height;
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
  return { x, y };
}

// ---------- keys ----------

const NAMED_KEYS = new Set([
  "Enter", "NumpadEnter", "Escape", "Backspace", "Tab", "Space", "Delete",
  "Insert", "Home", "End", "PageUp", "PageDown", "ArrowUp", "ArrowDown",
  "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight", "ControlLeft",
  "ControlRight", "AltLeft", "AltRight", "MetaLeft", "MetaRight", "CapsLock",
  "Minus", "Equal", "BracketLeft", "BracketRight", "Backslash", "Semicolon",
  "Quote", "Backquote", "Comma", "Period", "Slash",
]);

/** Mirror of `is_known_key` in the Rust core: anything else is refused there,
 *  so there is no point sending it. */
export function mapKeyCode(code: string): string | null {
  if (NAMED_KEYS.has(code)) return code;
  if (/^Key[A-Z]$/.test(code)) return code;
  if (/^Digit[0-9]$/.test(code)) return code;
  if (/^F([1-9]|1[0-2])$/.test(code)) return code;
  return null;
}

export function mouseButton(button: number): MouseButton | null {
  return button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : null;
}

// ---------- throttle ----------

/** Rate gate for pointer moves: at most one per `minGapMs`. Returns whether
 *  this event should be sent. Not a timer, so a trailing move is the caller's
 *  job (send the last position on mouse up/leave). */
export function createThrottle(minGapMs: number) {
  let last = -Infinity;
  return (now: number): boolean => {
    if (now - last < minGapMs) return false;
    last = now;
    return true;
  };
}

/** Clamp wheel deltas to the backend's accepted range. */
export function clampScroll(d: number, max = 1000): number {
  if (!Number.isFinite(d)) return 0;
  return Math.max(-max, Math.min(max, Math.round(d)));
}

// ---------- frames ----------

type FrameListener = (frame: { session: string; w: number; h: number; jpeg_b64: string }) => void;

/** Frames are too hot to live in React state. App publishes here and the
 *  viewer canvas subscribes. */
export function createFrameBus() {
  const listeners = new Set<FrameListener>();
  return {
    publish(msg: DeskMsg) {
      if (msg.body.kind !== "frame") return;
      const { w, h, jpeg_b64 } = msg.body;
      for (const l of listeners) l({ session: msg.session, w, h, jpeg_b64 });
    },
    subscribe(l: FrameListener) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
  };
}

export type FrameBus = ReturnType<typeof createFrameBus>;

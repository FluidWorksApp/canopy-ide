// The live view of a streamed Chromium page: the canvas the frames are painted
// on, pointer, wheel, touch and keyboard input mapped into page CSS pixels, the
// page's dialogs and the agent's cursor. Ported from T3 Code (MIT)
// apps/web/src/browser/ServerBrowserSurface.tsx (pingdotgg/t3code d5290e9),
// first as StreamedBrowser and moved here unchanged so two views share it:
//
// - StreamedBrowser, the cloud workspace's agent browser, with T3's explicit
//   Take control / Release control (input only while you hold the page);
// - PreviewView's Chrome engine, the desktop preview (preview-host.mjs), with
//   `autoControl`: input is sent whenever no other viewer holds the page, and
//   the host takes and gives back control around it.
//
// Callbacks are read through a ref, so a parent re-rendering never reconnects;
// `connectKey` names the stream, and changing it does.
import {
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type MutableRefObject,
  type PointerEvent,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { Button, TextInput } from "../components/ui";
import { writeClipboardText } from "../terminalClipboard";
import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  previewStreamCanInput,
  previewStreamModifiers,
  type PreviewStreamClient,
  type PreviewStreamControl,
  type PreviewStreamFileChooser,
  type PreviewStreamInput,
  type PreviewStreamMouseButton,
  type PreviewStreamNavigation,
  type PreviewStreamPointer,
  type PreviewStreamPopup,
  type PreviewStreamViewport,
} from "./browserStream";
import "./workspace.css";

const RESIZE_THROTTLE_MS = 150;
// Reuse nearby probes when a slow link would return the tap's answer after it ends.
const PROBE_REUSE_PX = 24;
const PROBE_REUSE_MS = 10_000;
// Android keyboards report Backspace as text deletion, so keep a deletable sentinel.
const INPUT_SENTINEL = "\u200b";
const BACKSPACE = { key: "Backspace", code: "Backspace", keyCode: 8 } as const;
const DELETE = { key: "Delete", code: "Delete", keyCode: 46 } as const;
const COPY = { key: "c", code: "KeyC", keyCode: 67 } as const;
const CUT = { key: "x", code: "KeyX", keyCode: 88 } as const;
const CTRL = 2;
const TAP_SLOP_PX = 8;
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_SLOP_PX = 4;
const WHEEL_LINE_PX = 16;

type MouseInput = Extract<PreviewStreamInput, { type: "mouse" }>;
type WheelInput = Extract<PreviewStreamInput, { type: "wheel" }>;

interface PagePoint {
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

interface TouchGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  panning: boolean;
}

interface TouchProbe {
  readonly x: number;
  readonly y: number;
  editable: boolean | null;
  answered: boolean;
  tapped: boolean;
}

const buttonOf = (button: number): PreviewStreamMouseButton =>
  button === 0
    ? "left"
    : button === 1
      ? "middle"
      : button === 2
        ? "right"
        : "none";

const pressedButtonOf = (buttons: number): PreviewStreamMouseButton =>
  buttons & 1
    ? "left"
    : buttons & 2
      ? "right"
      : buttons & 4
        ? "middle"
        : "none";

// Mouse thumb buttons: `button === 3` is Back, `button === 4` is Forward.
const historyDeltaOf = (button: number): -1 | 1 | null =>
  button === 3 ? -1 : button === 4 ? 1 : null;

/** Whether this document is on screen; the stream pauses while it is not. */
export function useDocumentVisible() {
  const [shown, setShown] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  useEffect(() => {
    const update = () => setShown(!document.hidden);
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return shown;
}

export interface StreamSurfaceHandle {
  /** False when the input was not sent (not connected, or another viewer holds the page). */
  readonly send: (input: PreviewStreamInput) => boolean;
}

export interface StreamSurfaceProps {
  /** A fresh one-use stream URL for `path` (its query carries the frame cap). */
  readonly streamUrl: (path: string) => Promise<string>;
  /** Names the stream; a new key reconnects. */
  readonly connectKey: string;
  /** Streams only while true ("only the visible tab streams"). */
  readonly visible: boolean;
  readonly autoControl?: boolean;
  readonly className?: string;
  /** Shown on a page dialog to a viewer who cannot answer it. */
  readonly dialogHint?: string;
  readonly handleRef?: MutableRefObject<StreamSurfaceHandle | null>;
  readonly onControl?: (control: PreviewStreamControl) => void;
  /** A short status line (clipboard results). */
  readonly onNote?: (text: string) => void;
  readonly onGone?: () => void;
  readonly onNavigated?: (navigation: PreviewStreamNavigation) => void;
  readonly onPicker?: (message: Record<string, unknown>) => void;
  readonly onPopup?: (popup: PreviewStreamPopup) => void;
  readonly onFileChooser?: (chooser: PreviewStreamFileChooser) => void;
  readonly onFileChooserClosed?: (id: string) => void;
}

export function StreamSurface({
  streamUrl,
  connectKey,
  visible,
  autoControl = false,
  className,
  dialogHint = "Take control to respond.",
  handleRef,
  onControl,
  onNote,
  onGone,
  onNavigated,
  onPicker,
  onPopup,
  onFileChooser,
  onFileChooserClosed,
}: StreamSurfaceProps) {
  const followSize = true;
  const streamUrlRef = useRef(streamUrl);
  streamUrlRef.current = streamUrl;
  // Callbacks are read through a ref, so a parent's fresh arrows never reconnect the stream.
  const eventsRef = useRef({
    onControl,
    onNote,
    onGone,
    onNavigated,
    onPicker,
    onPopup,
    onFileChooser,
    onFileChooserClosed,
  });
  eventsRef.current = {
    onControl,
    onNote,
    onGone,
    onNavigated,
    onPicker,
    onPopup,
    onFileChooser,
    onFileChooserClosed,
  };
  const canInput = (state: PreviewStreamControl | null | undefined) =>
    previewStreamCanInput(state ?? null, autoControl);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const keySentRef = useRef(false);
  const clientRef = useRef<PreviewStreamClient | null>(null);
  const viewportRef = useRef<PreviewStreamViewport | null>(null);
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  const hasFrameRef = useRef(false);
  const controlRef = useRef<PreviewStreamControl | null>(null);
  const [control, setControl] = useState<PreviewStreamControl | null>(null);
  const [promptText, setPromptText] = useState("");
  const [agentCursor, setAgentCursor] = useState<AgentCursorPlacement | null>(
    null,
  );
  const [gone, setGone] = useState(false);
  const setNote = (text: string) => eventsRef.current.onNote?.(text);
  const pendingMoveRef = useRef<MouseInput | null>(null);
  const pendingWheelRef = useRef<WheelInput | null>(null);
  const inputFrameRef = useRef<number | null>(null);
  const mouseButtonsRef = useRef(0);
  const mouseClicksRef = useRef({ left: 1, middle: 1, right: 1, none: 1 });
  const lastClickRef = useRef<{
    button: PreviewStreamMouseButton;
    time: number;
    x: number;
    y: number;
    count: number;
  } | null>(null);
  const touchRef = useRef<TouchGesture | null>(null);
  const probeRef = useRef<TouchProbe | null>(null);
  const lastProbeRef = useRef<{
    x: number;
    y: number;
    editable: boolean;
    at: number;
  } | null>(null);
  const [cap, setCap] = useState<{ width: number; height: number } | null>(
    null,
  );

  const send = (input: PreviewStreamInput) => {
    clientRef.current?.send(input);
  };
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      send: (input) => clientRef.current?.send(input) ?? false,
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef]);

  const clearInput = useEffectEvent(() => {
    if (inputFrameRef.current !== null)
      cancelAnimationFrame(inputFrameRef.current);
    inputFrameRef.current = null;
    pendingMoveRef.current = pendingWheelRef.current = null;
    mouseButtonsRef.current = 0;
    mouseClicksRef.current = { left: 1, middle: 1, right: 1, none: 1 };
    lastClickRef.current = null;
    touchRef.current = probeRef.current = lastProbeRef.current = null;
    keySentRef.current = false;
    if (inputRef.current) inputRef.current.value = INPUT_SENTINEL;
    inputRef.current?.blur();
  });

  const flushInput = () => {
    if (inputFrameRef.current !== null)
      cancelAnimationFrame(inputFrameRef.current);
    inputFrameRef.current = null;
    const move = pendingMoveRef.current;
    const wheel = pendingWheelRef.current;
    pendingMoveRef.current = null;
    pendingWheelRef.current = null;
    if (move) send(move);
    if (wheel) send(wheel);
  };

  const scheduleFlush = () => {
    if (inputFrameRef.current === null)
      inputFrameRef.current = requestAnimationFrame(flushInput);
  };

  const queueWheel = (
    point: PagePoint,
    deltaX: number,
    deltaY: number,
    modifiers: number,
  ) => {
    const pending = pendingWheelRef.current;
    pendingWheelRef.current = {
      type: "wheel",
      x: point.x,
      y: point.y,
      deltaX: (pending?.deltaX ?? 0) + deltaX,
      deltaY: (pending?.deltaY ?? 0) + deltaY,
      modifiers,
    };
    scheduleFlush();
  };

  const pagePoint = (
    clientX: number,
    clientY: number,
    clamp: boolean,
  ): PagePoint | null => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (
      !canvas ||
      !viewport ||
      !hasFrameRef.current ||
      !canInput(controlRef.current)
    )
      return null;
    const rect = canvas.getBoundingClientRect();
    const fit = Math.min(
      rect.width / canvas.width,
      rect.height / canvas.height,
    );
    const width = canvas.width * fit;
    const height = canvas.height * fit;
    if (!(width > 0 && height > 0)) return null;
    const scale = viewport.width / width;
    const x = (clientX - rect.left - (rect.width - width) / 2) * scale;
    const y =
      (clientY - rect.top - (rect.height - height) / 2) *
      (viewport.height / height);
    const inside =
      x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height;
    if (!inside && !clamp) return null;
    return {
      x: Math.min(Math.max(x, 0), viewport.width),
      y: Math.min(Math.max(y, 0), viewport.height),
      scale,
    };
  };

  const countClick = (
    button: PreviewStreamMouseButton,
    x: number,
    y: number,
    time: number,
  ) => {
    const last = lastClickRef.current;
    const count =
      last &&
      last.button === button &&
      time - last.time < MULTI_CLICK_MS &&
      Math.hypot(x - last.x, y - last.y) < MULTI_CLICK_SLOP_PX
        ? last.count + 1
        : 1;
    lastClickRef.current = { button, time, x, y, count };
    return count;
  };

  const focusInput = () => inputRef.current?.focus({ preventScroll: true });

  // Observes the canvas container's size, sends resizes to the stream and grows the frame cap.
  useEffect(() => {
    const element = canvasRef.current?.parentElement;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    const growCap = () => {
      capTimer = null;
      const size = sizeRef.current;
      if (!size) return;
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(size.width * ratio);
      const height = Math.round(size.height * ratio);
      setCap((current) =>
        current !== null && current.width >= width && current.height >= height
          ? current
          : {
              width: Math.max(width, current?.width ?? 0),
              height: Math.max(height, current?.height ?? 0),
            },
      );
    };
    const measure = () => {
      timer = null;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const size = {
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      const previous = sizeRef.current;
      if (previous?.width === size.width && previous.height === size.height)
        return;
      sizeRef.current = size;
      if (followSize) clientRef.current?.send({ type: "resize", ...size });
      // Growing the cap reconnects the stream; wait until resizing settles.
      if (capTimer !== null) clearTimeout(capTimer);
      capTimer = setTimeout(
        growCap,
        previous === null ? 0 : RESIZE_THROTTLE_MS * 2,
      );
    };
    const observer = new ResizeObserver(() => {
      if (timer !== null) return;
      timer = setTimeout(
        measure,
        sizeRef.current === null ? 0 : RESIZE_THROTTLE_MS,
      );
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
      if (capTimer !== null) clearTimeout(capTimer);
    };
  }, [followSize]);

  // Opens the stream client and paints its frames onto the canvas while visible.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || gone || !cap || !canvas) return;
    const painter = createPreviewFramePainter(canvas, () => {
      hasFrameRef.current = true;
    });
    const stream = createPreviewStreamClient(
      {
        streamUrl: (path) => streamUrlRef.current(path),
        maxWidth: cap.width,
        maxHeight: cap.height,
        autoControl,
      },
      {
        onFrame: (jpeg) => painter.paint(jpeg),
        onProbe: (result) => {
          if (!canInput(controlRef.current)) return;
          lastProbeRef.current = { ...result, at: performance.now() };
          const probe = probeRef.current;
          if (!probe || probe.x !== result.x || probe.y !== result.y) return;
          probe.editable = result.editable;
          probe.answered = true;
          if (!probe.tapped) return;
          probeRef.current = null;
          if (result.editable) inputRef.current?.focus({ preventScroll: true });
          else inputRef.current?.blur();
        },
        onPointer: (pointer) => {
          const placed = placeAgentCursor(
            pointer,
            canvasRef.current,
            viewportRef.current,
          );
          if (placed) setAgentCursor(placed);
        },
        // Browsers may refuse a write after the key press; the note says so.
        onClipboard: (text) =>
          void writeClipboardText(text).then((copied) =>
            setNote(
              copied
                ? "Copied to this computer"
                : "Couldn’t reach this computer’s clipboard",
            ),
          ),
        onViewport: (viewport) => {
          viewportRef.current = viewport;
        },
        onControl: (next) => {
          const previous = controlRef.current;
          controlRef.current = next;
          setControl(next);
          eventsRef.current.onControl?.(next);
          if (
            next.dialog?.message !== previous?.dialog?.message ||
            next.dialog?.defaultValue !== previous?.dialog?.defaultValue
          )
            setPromptText(next.dialog?.defaultValue ?? "");
          if (!canInput(next)) {
            clearInput();
          } else if (!canInput(previous)) {
            const size = sizeRef.current;
            if (followSize && size) stream.send({ type: "resize", ...size });
          }
        },
        onNavigated: (navigation) =>
          eventsRef.current.onNavigated?.(navigation),
        onPicker: (message) => eventsRef.current.onPicker?.(message),
        onPopup: (popup) => eventsRef.current.onPopup?.(popup),
        onFileChooser: (chooser) => eventsRef.current.onFileChooser?.(chooser),
        onFileChooserClosed: (id) =>
          eventsRef.current.onFileChooserClosed?.(id),
        onConnectedChange: (connected) => {
          if (connected) return;
          controlRef.current = null;
          setControl(null);
          clearInput();
        },
        onGone: () => {
          setGone(true);
          eventsRef.current.onGone?.();
        },
      },
    );
    clientRef.current = stream;
    return () => {
      painter.stop();
      stream.stop();
      if (clientRef.current === stream) clientRef.current = null;
      controlRef.current = null;
      setControl(null);
      clearInput();
    };
  }, [cap, autoControl, followSize, gone, visible, connectKey]);

  // Registers a non-passive wheel listener on the canvas so it can stop the panel scrolling.
  const onWheel = useEffectEvent((event: WheelEvent) => {
    const point = pagePoint(event.clientX, event.clientY, false);
    if (!point) return;
    event.preventDefault();
    const unit =
      event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? WHEEL_LINE_PX
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? (viewportRef.current?.height ?? 0)
          : 1;
    queueWheel(
      point,
      event.deltaX * unit,
      event.deltaY * unit,
      previewStreamModifiers(event),
    );
  });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Registered natively: React's wheel listener is passive and cannot stop the panel scrolling.
    const listener = (event: WheelEvent) => onWheel(event);
    canvas.addEventListener("wheel", listener, { passive: false });
    return () => canvas.removeEventListener("wheel", listener);
  }, []);

  // Cancels the pending input animation frame when the component unmounts.
  useEffect(
    () => () => {
      if (inputFrameRef.current !== null)
        cancelAnimationFrame(inputFrameRef.current);
    },
    [],
  );

  const handlePointer = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!canInput(controlRef.current)) return;
    // Thumb buttons drive this tab's history in handleMouseUp, never the page.
    if (historyDeltaOf(event.button) !== null) return;
    const { type, pointerId, clientX, clientY } = event;
    const cancelled = type === "pointercancel";
    const touch = touchRef.current;
    if (cancelled && touch?.pointerId === pointerId) {
      touchRef.current = probeRef.current = null;
      return;
    }
    if (event.pointerType === "touch" && !cancelled) {
      const point = pagePoint(clientX, clientY, type === "pointermove");
      if (type === "pointerdown") {
        if (!event.isPrimary) return;
        touchRef.current = {
          pointerId,
          startX: clientX,
          startY: clientY,
          lastX: clientX,
          lastY: clientY,
          panning: false,
        };
        const last = lastProbeRef.current;
        const reusable =
          point &&
          last &&
          performance.now() - last.at < PROBE_REUSE_MS &&
          Math.hypot(point.x - last.x, point.y - last.y) < PROBE_REUSE_PX;
        probeRef.current = point
          ? {
              x: point.x,
              y: point.y,
              editable: reusable ? last.editable : null,
              answered: false,
              tapped: false,
            }
          : null;
        if (point) send({ type: "probe", x: point.x, y: point.y });
        return;
      }
      if (!touch || touch.pointerId !== pointerId) return;
      if (type === "pointermove") {
        if (
          !touch.panning &&
          Math.hypot(clientX - touch.startX, clientY - touch.startY) <
            TAP_SLOP_PX
        )
          return;
        touch.panning = true;
        if (point)
          queueWheel(
            point,
            (touch.lastX - clientX) * point.scale,
            (touch.lastY - clientY) * point.scale,
            0,
          );
        touch.lastX = clientX;
        touch.lastY = clientY;
        return;
      }
      touchRef.current = null;
      const probe = probeRef.current;
      if (touch.panning) {
        probeRef.current = null;
        return;
      }
      if (!point) return;
      // iOS requires focus during the tap; late probe replies only raise Android's keyboard.
      if (probe?.editable === true) focusInput();
      else if (probe?.editable === false) inputRef.current?.blur();
      if (probe && !probe.answered) probe.tapped = true;
      else probeRef.current = null;
      flushInput();
      const clickCount = countClick("left", clientX, clientY, event.timeStamp);
      const at = { x: point.x, y: point.y, modifiers: 0 };
      send({
        type: "mouse",
        action: "move",
        ...at,
        button: "none",
        buttons: 0,
        clickCount: 0,
      });
      send({
        type: "mouse",
        action: "down",
        ...at,
        button: "left",
        buttons: 1,
        clickCount,
      });
      send({
        type: "mouse",
        action: "up",
        ...at,
        button: "left",
        buttons: 0,
        clickCount,
      });
      return;
    }
    const previous = mouseButtonsRef.current;
    if ((cancelled || type === "pointerup") && previous === 0) return;
    if (cancelled || type === "pointerup")
      mouseButtonsRef.current = cancelled ? 0 : event.buttons & 7;
    const point = pagePoint(
      clientX,
      clientY,
      type !== "pointerdown" &&
        (cancelled ||
          type === "pointerup" ||
          previous !== 0 ||
          event.buttons !== 0),
    );
    if (!point) return;
    const at = {
      x: point.x,
      y: point.y,
      modifiers: previewStreamModifiers(event),
    };
    const mouse = (
      action: "down" | "up",
      button: PreviewStreamMouseButton,
      buttons: number,
    ) => {
      if (action === "down")
        mouseClicksRef.current[button] = countClick(
          button,
          clientX,
          clientY,
          event.timeStamp,
        );
      send({
        type: "mouse",
        action,
        ...at,
        button,
        buttons,
        clickCount: mouseClicksRef.current[button],
      });
    };
    if (type === "pointerdown") {
      focusInput();
      event.currentTarget.setPointerCapture(pointerId);
      flushInput();
      mouseButtonsRef.current = event.buttons & 7;
      mouse("down", buttonOf(event.button), event.buttons);
    } else if (type === "pointerup") {
      flushInput();
      mouse("up", buttonOf(event.button), event.buttons);
    } else {
      // Chords arrive as pointermove. Cancellation releases every held button.
      const next = cancelled ? 0 : event.buttons & 7;
      const changed = previous ^ next;
      if (previous !== 0 && changed !== 0) {
        flushInput();
        let buttons = previous;
        for (const bit of [1, 2, 4]) {
          if (!(changed & bit)) continue;
          buttons ^= bit;
          mouse(next & bit ? "down" : "up", pressedButtonOf(bit), buttons);
        }
        mouseButtonsRef.current = next;
      }
      if (cancelled) return;
      pendingMoveRef.current = {
        type: "mouse",
        action: "move",
        ...at,
        button: pressedButtonOf(event.buttons),
        buttons: event.buttons,
        clickCount: 0,
      };
      scheduleFlush();
    }
  };

  // Chromium runs a thumb button's back/forward on mouseup in this document, which
  // would move the app's own history. Cancel it and send the press to the page.
  const handleMouseUp = (event: MouseEvent<HTMLDivElement>) => {
    const delta = historyDeltaOf(event.button);
    if (delta === null) return;
    event.preventDefault();
    send({ type: "history", delta });
  };

  const resetInput = (textarea: HTMLTextAreaElement) => {
    keySentRef.current = false;
    textarea.value = INPUT_SENTINEL;
    textarea.setSelectionRange(INPUT_SENTINEL.length, INPUT_SENTINEL.length);
  };

  const sendKeyPress = (
    key: typeof BACKSPACE | typeof DELETE | typeof COPY | typeof CUT,
    modifiers = 0,
  ) => {
    send({ type: "key", action: "down", ...key, modifiers });
    send({ type: "key", action: "up", ...key, modifiers });
  };

  // Edit menu Copy and Cut fire no key, so send the shortcut the server copies on.
  const handleClipboard = (
    key: typeof COPY | typeof CUT,
    event: ClipboardEvent,
  ) => {
    // Keep the sentinel off the clipboard.
    event.preventDefault();
    if (!canInput(controlRef.current)) return;
    sendKeyPress(key, CTRL);
  };

  const handleKey = (
    action: "down" | "up",
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => {
    if (!canInput(controlRef.current)) return;
    keySentRef.current = false;
    if (
      event.nativeEvent.isComposing ||
      event.keyCode === 229 ||
      event.key === "Process" ||
      event.key === "Unidentified"
    )
      return;
    if (event.key === "Escape" && event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (action === "down") event.currentTarget.blur();
      return;
    }
    const shortcut = event.ctrlKey || event.metaKey;
    if (shortcut && event.key.toLowerCase() === "v") return;
    if (event.shiftKey && event.key === "Insert") return;
    // Enter carries "\r" like Puppeteer's key table, so forms submit and textareas break lines.
    const text = shortcut
      ? undefined
      : [...event.key].length === 1
        ? event.key
        : event.key === "Enter"
          ? "\r"
          : undefined;
    send({
      type: "key",
      action,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      ...(action === "down" && text !== undefined ? { text } : {}),
      modifiers: previewStreamModifiers(event),
    });
    // Some Android keyboards edit the textarea even when keydown is prevented.
    keySentRef.current =
      action === "down" &&
      !shortcut &&
      (text !== undefined ||
        event.key === "Backspace" ||
        event.key === "Delete");
    // The key copies or cuts in the page, so stop the browser's own copy or cut repeating it.
    if (
      event.ctrlKey !== event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      ["c", "x"].includes(event.key.toLowerCase())
    ) {
      event.preventDefault();
    }
    if (shortcut) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const handleInput = (event: FormEvent<HTMLTextAreaElement>) => {
    const native = event.nativeEvent;
    if (native instanceof InputEvent && native.isComposing) return;
    const textarea = event.currentTarget;
    const inputType = native instanceof InputEvent ? native.inputType : "";
    if (keySentRef.current) keySentRef.current = false;
    else if (inputType === "deleteContentBackward") sendKeyPress(BACKSPACE);
    else if (inputType === "deleteContentForward") sendKeyPress(DELETE);
    else {
      const text = textarea.value.replace(/^\u200b/, "");
      if (text) send({ type: "text", text });
    }
    resetInput(textarea);
  };

  const owned = canInput(control);
  return (
    <div
      className={`streamed-browser-surface${className ? ` ${className}` : ""}`}
      onMouseUp={handleMouseUp}
    >
      <canvas
        ref={canvasRef}
        className={`streamed-browser-canvas${owned ? " is-controlled" : ""}`}
        onPointerDown={handlePointer}
        onPointerMove={handlePointer}
        onPointerUp={handlePointer}
        onPointerCancel={handlePointer}
        onMouseDown={(event) => event.preventDefault()}
        onContextMenu={(event) => event.preventDefault()}
      />
      {agentCursor && control?.controller !== "you" ? (
        <span
          key={agentCursor.sequence}
          className={`streamed-browser-agent-cursor${agentCursor.phase === "click" ? " is-click" : ""}`}
          style={{ left: agentCursor.left, top: agentCursor.top }}
          aria-hidden="true"
        />
      ) : null}
      {/* Pinned top-left to avoid focus scrolling; 16px prevents iOS focus zoom. */}
      <textarea
        ref={inputRef}
        className="streamed-browser-input"
        aria-label="Browser page"
        aria-description="Press Shift+Escape to leave the browser page."
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={!owned}
        defaultValue={INPUT_SENTINEL}
        onFocus={(event) => resetInput(event.currentTarget)}
        onKeyDown={(event) => handleKey("down", event)}
        onKeyUp={(event) => handleKey("up", event)}
        onInput={handleInput}
        onCompositionEnd={(event) => {
          const text = event.data.replace(/^\u200b/, "");
          if (text) send({ type: "text", text });
          resetInput(event.currentTarget);
        }}
        onCopy={(event) => handleClipboard(COPY, event)}
        onCut={(event) => handleClipboard(CUT, event)}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData("text/plain");
          if (text) send({ type: "text", text });
        }}
      />
      {control?.dialog ? (
        <div
          className="streamed-browser-dialog"
          role="dialog"
          aria-label="Browser dialog"
        >
          <p>{control.dialog.message}</p>
          {owned ? (
            <>
              {control.dialog.type === "prompt" ? (
                <TextInput
                  width="full"
                  aria-label="Dialog response"
                  value={promptText}
                  onChange={(event) => setPromptText(event.target.value)}
                />
              ) : null}
              <div className="streamed-browser-dialog-actions">
                <Button
                  size="sm"
                  onClick={() => send({ type: "dialog", accept: false })}
                >
                  Dismiss
                </Button>
                <Button
                  size="sm"
                  variant="accent"
                  onClick={() =>
                    send({
                      type: "dialog",
                      accept: true,
                      ...(control.dialog?.type === "prompt"
                        ? { promptText }
                        : {}),
                    })
                  }
                >
                  Accept
                </Button>
              </div>
            </>
          ) : (
            <small>{dialogHint}</small>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface AgentCursorPlacement {
  readonly phase: PreviewStreamPointer["phase"];
  readonly sequence: number;
  readonly left: number;
  readonly top: number;
}

function placeAgentCursor(
  pointer: PreviewStreamPointer,
  canvas: HTMLCanvasElement | null,
  viewport: PreviewStreamViewport | null,
): AgentCursorPlacement | null {
  if (!canvas || !viewport || canvas.width < 1 || canvas.height < 1)
    return null;
  const box = { width: canvas.clientWidth, height: canvas.clientHeight };
  const fit = Math.min(box.width / canvas.width, box.height / canvas.height);
  const width = canvas.width * fit;
  const height = canvas.height * fit;
  return {
    phase: pointer.phase,
    sequence: pointer.sequence,
    left: (box.width - width) / 2 + (pointer.x * width) / viewport.width,
    top: (box.height - height) / 2 + (pointer.y * height) / viewport.height,
  };
}

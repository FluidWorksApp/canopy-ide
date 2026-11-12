// Ported from T3 Code (MIT) packages/client-runtime/src/preview/serverBrowserStream.ts
// (pingdotgg/t3code d5290e9): the viewer side of a streamed agent browser
// (packages/remote-host/browser-stream.mjs).
//
// Difference forced by Canopy's transport: a stream URL carries a one-use
// gateway ticket, so every connect awaits a fresh URL from `streamUrl`
// (RemoteExecutionClient.streamUrl). Where T3 stops and reports
// onUnauthorized (a refused upgrade), Canopy mints a new ticket and retries
// with the same backoff; a ticket that cannot be minted retries the same way.
// Not ported (no Canopy counterpart): file chooser uploads, downloads, popups
// and the host-setup close code.

export const BROWSER_STREAM_PATH = "/browser/stream";

export interface PreviewStreamViewport {
  readonly width: number;
  readonly height: number;
}

export type PreviewStreamMouseButton = "none" | "left" | "middle" | "right";

export interface PreviewStreamControl {
  readonly canOperate: boolean;
  readonly controller: "agent" | "you" | "another-viewer" | "unclaimed";
  readonly generation: number;
  readonly dialog: null | {
    readonly type: string;
    readonly message: string;
    readonly defaultValue: string;
  };
}

export const previewStreamControlLabel = (control: PreviewStreamControl | null): string =>
  !control
    ? "Connecting..."
    : !control.canOperate
      ? "Read-only"
      : control.controller === "you"
        ? "You have control"
        : control.controller === "agent"
          ? "Agent has control"
          : control.controller === "another-viewer"
            ? "Another viewer has control"
            : "Watching";

const isPreviewStreamDialog = (value: unknown): value is PreviewStreamControl["dialog"] =>
  value === null ||
  (typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "defaultValue" in value &&
    typeof value.defaultValue === "string");

/** Coordinates are page CSS px. */
export type PreviewStreamInput =
  | { readonly type: "takeControl" }
  | { readonly type: "releaseControl" }
  | { readonly type: "dialog"; readonly accept: boolean; readonly promptText?: string }
  | {
      readonly type: "mouse";
      readonly action: "move" | "down" | "up";
      readonly x: number;
      readonly y: number;
      readonly button: PreviewStreamMouseButton;
      /** Pressed buttons: left 1, right 2, middle 4. */
      readonly buttons: number;
      readonly clickCount: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "wheel";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
      readonly modifiers: number;
    }
  | {
      readonly type: "key";
      readonly action: "down" | "up";
      readonly key: string;
      readonly code: string;
      /** Windows virtual key code (DOM `keyCode`); Enter, Backspace, and arrows need it. */
      readonly keyCode?: number;
      /** Only for printable keys without Ctrl or Meta. */
      readonly text?: string;
      readonly modifiers: number;
    }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resize"; readonly width: number; readonly height: number }
  | { readonly type: "navigate"; readonly url: string }
  | { readonly type: "history"; readonly delta: -1 | 1 }
  | { readonly type: "reload"; readonly ignoreCache?: boolean }
  | { readonly type: "probe"; readonly x: number; readonly y: number }
  /** Desktop preview: a command for the page's picker (annotate mode, marks). */
  | { readonly type: "picker"; readonly message: Record<string, unknown> }
  /** Desktop preview: answers a file chooser with paths from the native dialog; none cancels. */
  | {
      readonly type: "fileChooser";
      readonly id: string;
      readonly paths: readonly string[];
    };

/** The page's address, after each navigation (the desktop preview's URL bar). */
export interface PreviewStreamNavigation {
  readonly url: string;
  readonly title: string;
  readonly loadError?: { readonly url: string; readonly description: string };
}

/** A popup the page opened (a sign-in window), offered to the viewer that caused it. */
export interface PreviewStreamPopup {
  readonly tabId: string;
  readonly openerId: string;
  readonly url: string;
}

/** A file input the page opened, offered to the viewer controlling it. */
export interface PreviewStreamFileChooser {
  readonly id: string;
  readonly multiple: boolean;
  readonly accept: string;
}

export interface PreviewStreamProbe {
  readonly x: number;
  readonly y: number;
  readonly editable: boolean;
}

export interface PreviewStreamPointer {
  readonly phase: "move" | "click";
  readonly x: number;
  readonly y: number;
  readonly sequence: number;
}

export const previewStreamModifiers = (event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): number =>
  (event.altKey ? 1 : 0) |
  (event.ctrlKey ? 2 : 0) |
  (event.metaKey ? 4 : 0) |
  (event.shiftKey ? 8 : 0);

export interface PreviewStreamTarget {
  /** A fresh one-use stream URL for `path` (RemoteExecutionClient.streamUrl). */
  readonly streamUrl: (path: string) => Promise<string>;
  /** Viewer backing-store size in device px. The server never sends larger frames. */
  readonly maxWidth: number;
  readonly maxHeight: number;
  /** Passive viewers reduce their own access, including automatic control grants. */
  readonly interactive?: boolean;
  /** The desktop preview: input is sent whenever no other viewer holds the page,
   *  and the host takes and gives back control around it (preview-host.mjs). */
  readonly autoControl?: boolean;
}

export interface PreviewStreamEvents {
  readonly onFrame: (jpeg: ArrayBuffer) => void;
  readonly onViewport: (viewport: PreviewStreamViewport) => void;
  readonly onProbe?: (probe: PreviewStreamProbe) => void;
  readonly onPointer?: (pointer: PreviewStreamPointer) => void;
  readonly onControl?: (control: PreviewStreamControl) => void;
  readonly onClipboard?: (text: string) => void;
  readonly onConnectedChange: (connected: boolean) => void;
  readonly onGone?: () => void;
  readonly onNavigated?: (navigation: PreviewStreamNavigation) => void;
  readonly onPicker?: (message: Record<string, unknown>) => void;
  readonly onPopup?: (popup: PreviewStreamPopup) => void;
  readonly onFileChooser?: (chooser: PreviewStreamFileChooser) => void;
  readonly onFileChooserClosed?: (id: string) => void;
}

/** Whether input may be sent under this control state. */
export const previewStreamCanInput = (
  control: PreviewStreamControl | null,
  autoControl = false,
): boolean =>
  !!control?.canOperate &&
  (control.controller === "you" ||
    (autoControl && control.controller !== "another-viewer"));

export interface PreviewStreamClient {
  readonly send: (input: PreviewStreamInput) => boolean;
  readonly stop: () => void;
}

export const browserStreamPath = (target: Pick<PreviewStreamTarget, "maxWidth" | "maxHeight" | "interactive">) => {
  const query = new URLSearchParams({
    maxWidth: String(Math.max(1, Math.round(target.maxWidth))),
    maxHeight: String(Math.max(1, Math.round(target.maxHeight))),
  });
  if (target.interactive === false) query.set("interactive", "false");
  return `${BROWSER_STREAM_PATH}?${query.toString()}`;
};

const ACK_MESSAGE = JSON.stringify({ type: "ack" });
export function createPreviewStreamClient(
  target: PreviewStreamTarget,
  events: PreviewStreamEvents,
): PreviewStreamClient {
  const path = browserStreamPath(target);
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failures = 0;
  let control: PreviewStreamControl | null = null;

  const retry = () => {
    if (stopped) return;
    retryTimer = setTimeout(connect, Math.min(500 * 2 ** failures++, 10_000));
  };

  const open = (url: string) => {
    if (stopped) return;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    socket = ws;
    let opened = false;
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      events.onConnectedChange(true);
    });
    ws.addEventListener("message", (event) => {
      if (socket !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        failures = 0;
        ws.send(ACK_MESSAGE);
        events.onFrame(event.data);
        return;
      }
      if (typeof event.data !== "string") return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (typeof message !== "object" || message === null) return;
      const { type, x, y, width, height, editable, canOperate, controller, generation, dialog, text, phase, sequence } =
        message as Record<string, unknown>;
      const record = message as Record<string, unknown>;
      if (type === "navigated" && typeof record.url === "string") {
        const loadError = record.loadError as
          PreviewStreamNavigation["loadError"] | undefined;
        events.onNavigated?.({
          url: record.url,
          title: typeof record.title === "string" ? record.title : "",
          ...(loadError && typeof loadError.description === "string"
            ? { loadError }
            : {}),
        });
        return;
      }
      if (
        type === "picker" &&
        typeof record.message === "object" &&
        record.message !== null
      ) {
        events.onPicker?.(record.message as Record<string, unknown>);
        return;
      }
      if (type === "popup" && typeof record.tabId === "string") {
        events.onPopup?.({
          tabId: record.tabId,
          openerId: String(record.openerId ?? ""),
          url: typeof record.url === "string" ? record.url : "",
        });
        return;
      }
      if (type === "fileChooser" && typeof record.id === "string") {
        events.onFileChooser?.({
          id: record.id,
          multiple: record.multiple === true,
          accept: typeof record.accept === "string" ? record.accept : "",
        });
        return;
      }
      if (type === "fileChooserClosed" && typeof record.id === "string") {
        events.onFileChooserClosed?.(record.id);
        return;
      }
      if (
        type === "pointer" &&
        (phase === "move" || phase === "click") &&
        typeof x === "number" &&
        typeof y === "number" &&
        typeof sequence === "number"
      ) {
        events.onPointer?.({ phase, x, y, sequence });
      } else if (type === "clipboard" && typeof text === "string") {
        events.onClipboard?.(text);
      } else if (type === "viewport" && typeof width === "number" && typeof height === "number") {
        failures = 0;
        events.onViewport({ width, height });
      } else if (type === "probe" && typeof x === "number" && typeof y === "number" && typeof editable === "boolean") {
        events.onProbe?.({ x, y, editable });
      } else if (
        type === "control" &&
        typeof canOperate === "boolean" &&
        (controller === "agent" || controller === "you" || controller === "another-viewer" || controller === "unclaimed") &&
        typeof generation === "number" &&
        isPreviewStreamDialog(dialog)
      ) {
        const nextControl: PreviewStreamControl = { canOperate, controller, generation, dialog };
        control = nextControl;
        events.onControl?.(nextControl);
      }
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      control = null;
      if (opened) events.onConnectedChange(false);
      if (stopped) return;
      if (event.code === 4404) {
        stopped = true;
        events.onGone?.();
        return;
      }
      // T3 stops on a refused upgrade (1008, 4401, or 1006 before open) and
      // asks for new access. A Canopy ticket is one-use, so every retry
      // already mints a new one; refusals back off like any other drop.
      retry();
    });
    ws.addEventListener("error", () => ws.close());
  };

  const connect = () => {
    retryTimer = null;
    if (stopped) return;
    void target.streamUrl(path).then(open, retry);
  };

  connect();

  return {
    send: (input) => {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      if (!control?.canOperate) return false;
      if (input.type !== "takeControl" && !previewStreamCanInput(control, target.autoControl)) return false;
      socket.send(JSON.stringify(input));
      return true;
    },
    stop: () => {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      const ws = socket;
      socket = null;
      control = null;
      ws?.close();
    },
  };
}

export interface PreviewFramePainter {
  readonly paint: (jpeg: ArrayBuffer) => void;
  readonly stop: () => void;
}

/** One decode at a time, keeping only the latest waiting frame for slow viewers. */
export function createPreviewFramePainter(canvas: HTMLCanvasElement, onPainted?: () => void): PreviewFramePainter {
  const context = canvas.getContext("2d");
  let stopped = false;
  let decoding = false;
  let waiting: ArrayBuffer | null = null;
  const draw = (jpeg: ArrayBuffer) => {
    decoding = true;
    void createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }))
      .then((bitmap) => {
        if (stopped || !context) {
          bitmap.close();
          return;
        }
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        onPainted?.();
      })
      .catch(() => undefined)
      .finally(() => {
        decoding = false;
        const next = waiting;
        waiting = null;
        if (next && !stopped) draw(next);
      });
  };
  return {
    paint: (jpeg) => {
      if (stopped) return;
      if (decoding) waiting = jpeg;
      else draw(jpeg);
    },
    stop: () => {
      stopped = true;
      waiting = null;
    },
  };
}

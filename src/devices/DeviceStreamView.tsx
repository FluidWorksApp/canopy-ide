// A streamed simulator or emulator screen with touch, keyboard and paste input.
//
// Ported from T3 Code apps/web/src/components/device/DeviceStreamView.tsx
// (https://github.com/pingdotgg/t3code, commit d5290e9, MIT License,
// Copyright (c) 2026 T3 Tools Inc.). Kept from T3: the aspect and rotation rules,
// fitting the frame in both dimensions, pointer capture and normalized touch
// coordinates, key and paste forwarding, the MJPEG <img> fallback, the
// input-disconnected and loading/error states with Reconnect. Left out: the
// 3D phone and iPhone Duo scenes, Android fold controls and the accessibility
// overlay (T3's `allowPhoneView`, `axOverlay`); this renders the plain screen.
// Tailwind classes became the small stylesheet in devices.css.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { fitDeviceFrame } from "./deviceFrameLayout";
import { IDLE_DEVICE_STREAM_STATE, useDeviceStreamSession } from "./deviceStreamSession";
import type { DeviceHubAccess } from "./hubAccess";
import type { DeviceHardwareButton, DevicePlatform, DeviceScreenSize } from "./stream";
import "./devices.css";

function screenAspect(platform: DevicePlatform, screen: DeviceScreenSize | null): number {
  if (!screen) return platform === "ios" ? 9 / 19.5 : 9 / 20;
  const landscape =
    screen.orientation === "landscape_left" || screen.orientation === "landscape_right";
  const w = landscape
    ? Math.max(screen.width, screen.height)
    : Math.min(screen.width, screen.height);
  const h = landscape
    ? Math.min(screen.width, screen.height)
    : Math.max(screen.width, screen.height);
  return w / h;
}

// serve-sim sends raw portrait framebuffers even when iOS reports landscape; rotate the display.
function screenRotation(platform: DevicePlatform, screen: DeviceScreenSize | null): number {
  if (platform !== "ios" || !screen || screen.width > screen.height) return 0;
  switch (screen.orientation) {
    case "landscape_left":
      return 90;
    case "landscape_right":
      return -90;
    case "portrait_upside_down":
      return 180;
    default:
      return 0;
  }
}

export interface DeviceStreamHandle {
  readonly pressButton: (button: DeviceHardwareButton) => void;
  readonly rotate: () => void;
  readonly inputConnected: boolean;
  readonly streaming: boolean;
  readonly screen: DeviceScreenSize | null;
}

export function DeviceStreamView(props: {
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly deviceName?: string;
  /** Only the visible tab streams: a hidden view holds no session. */
  readonly visible: boolean;
  readonly access: DeviceHubAccess | null;
  /** A refused ticket; mint a new one (T3's `refreshDeviceHubAccess`). */
  readonly onUnauthorized: () => void;
  readonly renderControls?: (handle: DeviceStreamHandle | null) => ReactNode;
  /** When set, pointer input goes to the overlay (annotation) instead of the device. */
  readonly inputSuspended?: boolean;
  /** Drawn over the screen, sized to it (annotation marks and their click layer). */
  readonly overlay?: ReactNode;
}) {
  const session = useDeviceStreamSession(
    props.access && props.visible
      ? { platform: props.platform, deviceId: props.deviceId, access: props.access }
      : null,
    props.onUnauthorized,
  );
  const client = session?.stream ?? null;
  const canvas = session?.canvas ?? null;
  const { status, detail, screen, mjpegUrl, mjpegGeneration } =
    session?.state ?? IDLE_DEVICE_STREAM_STATE;
  const inputState = session?.state.input ?? IDLE_DEVICE_STREAM_STATE.input;

  const attachMjpegImage = (image: HTMLImageElement | null) => {
    if (!client || !image) return;
    client.setMjpegImage(image);
    return () => client.setMjpegImage(null);
  };
  const mountCanvas = (node: HTMLDivElement | null) => {
    if (!node || !canvas) return;
    node.append(canvas);
    return () => canvas.remove();
  };

  const aspect = screenAspect(props.platform, screen);

  // Fit the frame in both dimensions; pinned CSS height plus a width clamp distorts aspect-ratio.
  const [host, setHost] = useState({ width: 0, height: 0 });
  const hostRef = (element: HTMLDivElement | null) => {
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setHost((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  };
  const frame = fitDeviceFrame(aspect, host.width, host.height, 0);

  const rotation = screenRotation(props.platform, screen);
  const sideways = rotation === 90 || rotation === -90;
  const mediaStyle: React.CSSProperties = sideways
    ? {
        width: frame.height,
        height: frame.width,
        left: (frame.width - frame.height) / 2,
        top: (frame.height - frame.width) / 2,
        transform: `rotate(${rotation}deg)`,
      }
    : {
        width: frame.width,
        height: frame.height,
        ...(rotation ? { transform: `rotate(${rotation}deg)` } : {}),
      };

  const activePointer = useRef<{ id: number; x: number; y: number } | null>(null);
  // Clears pointer ownership when the device input connection drops or is replaced.
  useEffect(() => {
    if (!client || !inputState.connected) return;
    return () => {
      activePointer.current = null;
    };
  }, [client, inputState.connected]);
  const normalizedPoint = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };
  const endPointer = (event: React.PointerEvent<HTMLElement>) => {
    const pointer = activePointer.current;
    if (pointer?.id !== event.pointerId) return;
    activePointer.current = null;
    const { x, y } = event.type === "lostpointercapture" ? pointer : normalizedPoint(event);
    client?.sendTouch("end", x, y);
  };

  const handle: DeviceStreamHandle | null = client
    ? {
        pressButton: client.pressButton,
        rotate: client.rotate,
        inputConnected: inputState.connected,
        streaming: status === "streaming",
        screen,
      }
    : null;

  return (
    <div className="dsv-root">
      {props.renderControls ? props.renderControls(handle) : null}
      <div
        ref={hostRef}
        className="dsv-host"
        tabIndex={0}
        role="application"
        aria-label={`${props.platform === "ios" ? "iOS Simulator" : "Android Emulator"} screen`}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.metaKey && !["r", "R"].includes(event.key)) return;
          // Let browser paste chords fire the paste event.
          if (
            (event.ctrlKey && (event.key === "v" || event.key === "V")) ||
            (event.shiftKey && event.key === "Insert")
          ) {
            return;
          }
          event.preventDefault();
          client?.sendKey(event.nativeEvent, "down");
        }}
        onPaste={(event) => {
          if (event.target !== event.currentTarget) return;
          event.preventDefault();
          client?.sendText(event.clipboardData.getData("text/plain"));
        }}
        onKeyUp={(event) => {
          if (event.target !== event.currentTarget) return;
          client?.sendKey(event.nativeEvent, "up");
        }}
      >
        <div
          className="dsv-frame"
          style={{ width: frame.width, height: frame.height }}
          onPointerDown={(event) => {
            if (props.inputSuspended) return;
            if (event.button !== 0 || !inputState.connected || activePointer.current !== null)
              return;
            event.currentTarget.setPointerCapture(event.pointerId);
            (event.currentTarget.parentElement as HTMLElement | null)?.focus();
            const { x, y } = normalizedPoint(event);
            activePointer.current = { id: event.pointerId, x, y };
            client?.sendTouch("begin", x, y);
          }}
          onPointerMove={(event) => {
            if (activePointer.current?.id !== event.pointerId) return;
            const { x, y } = normalizedPoint(event);
            activePointer.current = { id: event.pointerId, x, y };
            client?.sendTouch("move", x, y);
          }}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onLostPointerCapture={endPointer}
        >
          <div
            ref={mountCanvas}
            className={mjpegUrl ? "dsv-media dsv-hidden" : "dsv-media"}
            style={mediaStyle}
          />
          {props.visible && props.access && mjpegUrl ? (
            <img
              key={mjpegGeneration}
              ref={attachMjpegImage}
              alt=""
              draggable={false}
              className="dsv-media dsv-mjpeg"
              style={mediaStyle}
            />
          ) : null}
          {props.overlay}
        </div>
        {status === "streaming" && !inputState.connected ? (
          <div className="dsv-banner">
            <span>
              Input disconnected{inputState.detail ? ` (${inputState.detail})` : ""}, reconnecting…
            </span>
          </div>
        ) : null}
        {status !== "streaming" ? (
          <div className="dsv-loading" role="status">
            <div className="dsv-loading-card">
              <strong>{props.deviceName ?? "Device"}</strong>
              <span className={status === "error" ? "dsv-error" : undefined}>
                {status === "error" ? (detail ?? "Stream failed.") : (detail ?? "Connecting video…")}
              </span>
              {status === "error" ? (
                <button
                  type="button"
                  className="dsv-button"
                  onClick={() => {
                    // An expired ticket surfaces as unauthorized on restart and
                    // refreshes access, which starts a new session.
                    session?.reconnect();
                  }}
                >
                  Reconnect
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

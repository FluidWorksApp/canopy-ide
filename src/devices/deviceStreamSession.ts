// A device's video and input connection, live while a view uses it.
//
// Ported from T3 Code apps/web/src/components/device/deviceStreamSession.ts
// (https://github.com/pingdotgg/t3code, commit d5290e9, MIT License,
// Copyright (c) 2026 T3 Tools Inc.). T3 keeps the session in an Effect atom family
// whose finalizer stops the client; Canopy has no atom runtime, so the same
// session object is created by `createDeviceStreamSession` and owned by the
// `useDeviceStreamSession` hook, whose effect cleanup is that finalizer. The
// state, events and reconnect behaviour are T3's. The 3D viewer hooks
// (frame/control-rejected listeners) and the per-view screen atom are left
// out with the 3D phone scenes.
import { useEffect, useReducer, useRef, useState } from "react";
import type { DuoControlState } from "./duoControl";
import { createCanvasFrameSink } from "./frame";
import type { DeviceHubAccess } from "./hubAccess";
import {
  createDeviceStreamClient,
  type DevicePlatform,
  type DeviceScreenSize,
  type DeviceStreamClient,
  type DeviceStreamStatus,
} from "./stream";

export interface DeviceStreamState {
  readonly status: DeviceStreamStatus;
  readonly detail: string | undefined;
  /** A frame arrived during this session, so a reconnect can keep showing it. */
  readonly hasFrame: boolean;
  readonly screen: DeviceScreenSize | null;
  readonly mjpegUrl: string | null;
  readonly mjpegGeneration: number;
  readonly input: { readonly connected: boolean; readonly detail?: string };
  readonly duoControl: DuoControlState;
}

export interface DeviceStreamSession {
  readonly stream: DeviceStreamClient;
  /** The stream draws here; the view mounts it. */
  readonly canvas: HTMLCanvasElement;
  readonly reconnect: () => void;
  readonly state: DeviceStreamState;
}

export interface DeviceStreamKey {
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly access: DeviceHubAccess;
}

export const IDLE_DEVICE_STREAM_STATE: DeviceStreamState = {
  status: "connecting",
  detail: undefined,
  hasFrame: false,
  screen: null,
  mjpegUrl: null,
  mjpegGeneration: 0,
  input: { connected: false },
  duoControl: { pending: false, requested: null, error: null },
};

export interface DeviceStreamSessionHandle {
  readonly get: () => DeviceStreamSession;
  readonly subscribe: (listener: () => void) => () => void;
  /** T3's atom finalizer. */
  readonly dispose: () => void;
}

export function createDeviceStreamSession(
  key: DeviceStreamKey,
  onUnauthorized: () => void,
): DeviceStreamSessionHandle {
  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  const listeners = new Set<() => void>();
  let state = IDLE_DEVICE_STREAM_STATE;
  let session: DeviceStreamSession;
  const update = (patch: Partial<DeviceStreamState>) => {
    state = { ...state, ...patch };
    session = { ...session, state };
    for (const listener of listeners) listener();
  };
  const client = createDeviceStreamClient(
    { platform: key.platform, deviceId: key.deviceId, access: key.access },
    createCanvasFrameSink(canvas),
    {
      onDuoControl: (duoControl) => update({ duoControl }),
      onStatus: (status, detail) =>
        update({ status, detail, ...(status === "streaming" ? { hasFrame: true } : {}) }),
      onScreen: (screen) => update({ screen }),
      onUnauthorized,
      onMjpegFallback: (mjpegUrl) =>
        update({ mjpegUrl, mjpegGeneration: state.mjpegGeneration + 1 }),
      onCanvasVideo: () => update({ mjpegUrl: null }),
      onInputConnected: (connected, detail) =>
        update({ input: { connected, ...(detail ? { detail } : {}) } }),
    },
  );
  session = {
    stream: client,
    canvas,
    reconnect: () => {
      client.stop();
      client.start();
    },
    state,
  };
  client.start();
  return {
    get: () => session,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      listeners.clear();
      client.stop();
    },
  };
}

const keyId = (key: DeviceStreamKey | null) =>
  key
    ? [key.platform, key.deviceId, key.access.httpBase, JSON.stringify(key.access.query)].join(
        "\u0000",
      )
    : null;

/** The session for `key`, or null; a new key (or a new ticket) is a new session. */
export function useDeviceStreamSession(
  key: DeviceStreamKey | null,
  onUnauthorized: () => void,
): DeviceStreamSession | null {
  const [owned, setOwned] = useState<{ id: string; handle: DeviceStreamSessionHandle } | null>(
    null,
  );
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const keyRef = useRef(key);
  keyRef.current = key;
  const unauthorizedRef = useRef(onUnauthorized);
  unauthorizedRef.current = onUnauthorized;
  const id = keyId(key);
  useEffect(() => {
    const current = keyRef.current;
    if (!id || !current) {
      setOwned(null);
      return;
    }
    const next = createDeviceStreamSession(current, () => unauthorizedRef.current());
    const unsubscribe = next.subscribe(rerender);
    setOwned({ id, handle: next });
    return () => {
      unsubscribe();
      next.dispose();
    };
  }, [id]);
  // A session for a previous key is never handed out, even for the render
  // before its replacement exists.
  return owned && owned.id === id ? owned.handle.get() : null;
}

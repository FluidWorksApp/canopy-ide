// IPC for the device hub (src-tauri/src/devicehub.rs) and the hub access a
// stream needs. Desktop calls, like the android_* commands: the hub, adb and
// the simulators are on the computer showing the IDE even when a workspace's
// execution is remote.
//
// `useDeviceHubAccess` plays the part of T3 Code's `useDeviceHubAccess` /
// `refreshDeviceHubAccess` (apps/web/src/state/device.ts, MIT): T3 mints a
// short-lived `wsTicket` over authenticated HTTP; Canopy mints it with a
// Tauri command. Either way a stream that sees 401 (or a refused upgrade)
// asks for a fresh ticket, which restarts its session.
import { useCallback, useEffect, useRef, useState } from "react";
import { invokeDesktop } from "../host";
import type { DeviceHubAccess } from "./hubAccess";
import type { DevicePlatform } from "./stream";

/** expo-device-hub's version, pinned in devicehub.rs as T3 pins it. */
export interface DeviceHubStatus {
  installed: boolean;
  running: boolean;
  installing: boolean;
  starting: boolean;
  version: string;
  installDir: string;
  /** Set when Node.js is missing: the hub cannot run without it. */
  nodeError: string | null;
  npmAvailable: boolean;
  platforms: { platform: DevicePlatform; available: boolean; reason: string | null }[];
  error: string | null;
}

export interface HostDevice {
  id: string;
  name: string;
  version: string;
  platform: DevicePlatform;
  booted: boolean;
  physical: boolean;
}

export interface DeviceListing {
  devices: HostDevice[];
  detail: string | null;
  androidDiscoveryIncomplete: boolean;
  incompletePlatforms: DevicePlatform[];
}

export const deviceHubStatus = () => invokeDesktop<DeviceHubStatus>("device_hub_status");
/** The consent step: downloads and installs the pinned hub. */
export const deviceHubInstall = () => invokeDesktop<DeviceHubStatus>("device_hub_install");
export const deviceHubStart = () => invokeDesktop<DeviceHubStatus>("device_hub_start");
export const deviceHubStop = () => invokeDesktop<void>("device_hub_stop");
export const deviceHubAccess = () => invokeDesktop<DeviceHubAccess>("device_hub_access");
export const deviceHubDevices = () => invokeDesktop<DeviceListing>("device_hub_devices");
export const deviceHubBoot = (device: HostDevice) => invokeDesktop<string>("device_hub_boot", { device });
export const deviceHubAttach = (device: HostDevice) => invokeDesktop<void>("device_hub_attach", { device });
export const deviceHubShutdown = (device: HostDevice) =>
  invokeDesktop<void>("device_hub_shutdown", { device });

/** Whether the user turned down the setup card; the tab then stays on stills. */
const DECLINED_KEY = "canopy.deviceHub.declined";
export const deviceHubDeclined = () => {
  try {
    return localStorage.getItem(DECLINED_KEY) === "1";
  } catch {
    return false;
  }
};
export const setDeviceHubDeclined = (declined: boolean) => {
  try {
    if (declined) localStorage.setItem(DECLINED_KEY, "1");
    else localStorage.removeItem(DECLINED_KEY);
  } catch {
    // Storage unavailable: the card simply shows again next time.
  }
};

/** Hub access while `enabled`; `refresh` mints a fresh ticket. */
export function useDeviceHubAccess(enabled: boolean): {
  access: DeviceHubAccess | null;
  error: string | null;
  refresh: () => void;
} {
  const [access, setAccess] = useState<DeviceHubAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(() => {
    const mine = ++generation.current;
    deviceHubAccess().then(
      (next) => {
        if (generation.current === mine) {
          setAccess(next);
          setError(null);
        }
      },
      (e) => {
        if (generation.current === mine) setError(String(e));
      },
    );
  }, []);
  useEffect(() => {
    if (!enabled) {
      generation.current++;
      setAccess(null);
      return;
    }
    load();
  }, [enabled, load]);
  return { access: enabled ? access : null, error, refresh: load };
}

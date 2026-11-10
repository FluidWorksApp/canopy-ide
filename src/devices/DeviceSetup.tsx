// The consent card for device streaming tools.
//
// Adapted from T3 Code apps/web/src/components/device/DeviceSetup.tsx
// (https://github.com/pingdotgg/t3code, commit d5290e9, MIT License,
// Copyright (c) 2026 T3 Tools Inc.): its first two steps, "Enable the device hub"
// and "Check simulator support", as one card. Nothing is downloaded until the
// user presses Install, as in T3. T3's third step (agent access through
// agent-device) has no counterpart: Canopy's agents keep their adb tools.
import { useState } from "react";
import { Button } from "../components/ui";
import { deviceHubInstall, deviceHubStart, setDeviceHubDeclined, type DeviceHubStatus } from "./deviceHub";
import "./devices.css";

const platformName = (platform: "ios" | "android") => (platform === "ios" ? "iOS" : "Android");

export function DeviceSetup(props: {
  readonly status: DeviceHubStatus;
  readonly onChange: (status: DeviceHubStatus) => void;
  readonly onDecline: () => void;
}) {
  const [pending, setPending] = useState<"install" | "start" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { status } = props;
  const blocked = status.nodeError ?? (!status.npmAvailable && !status.installed ? "npm was not found. Install Node.js (it includes npm) and make sure npm is on PATH, then retry." : null);

  const run = async (kind: "install" | "start") => {
    setPending(kind);
    setError(null);
    try {
      const installed = kind === "install" ? await deviceHubInstall() : status;
      props.onChange(installed);
      props.onChange(await deviceHubStart());
      setDeviceHubDeclined(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="device-block device-setup-card">
      <h4>Stream devices live</h4>
      <p>
        Live video with touch and keyboard input needs Expo Device Hub {status.version}, which
        drives Android emulators and devices through adb and scrcpy, and iOS Simulators on a Mac.
        It is downloaded from npm into <code>{status.installDir}</code>, runs on this computer
        only, and is reached through Canopy. Without it this tab shows refreshing screenshots.
      </p>
      {status.platforms.map((p) => (
        <p key={p.platform} className={p.available ? undefined : "device-row-sub"}>
          {platformName(p.platform)}: {p.available ? "available" : p.reason}
        </p>
      ))}
      {blocked && <p className="preview-error">{blocked}</p>}
      {(error ?? status.error) && <p className="preview-error">{error ?? status.error}</p>}
      <div className="device-setup-actions">
        {status.installed ? (
          <Button size="sm" disabled={pending !== null || !!status.nodeError} onClick={() => void run("start")}>
            {pending === "start" ? "Starting device hub…" : "Start streaming"}
          </Button>
        ) : (
          <Button size="sm" disabled={pending !== null || !!blocked} onClick={() => void run("install")}>
            {pending === "install" ? "Installing device hub…" : pending === "start" ? "Starting device hub…" : "Install device tools"}
          </Button>
        )}
        <Button
          size="sm"
          disabled={pending !== null}
          onClick={() => {
            setDeviceHubDeclined(true);
            props.onDecline();
          }}
        >
          Not now
        </Button>
      </div>
    </div>
  );
}

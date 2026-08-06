// A live Android device as refreshing still frames, with the same annotate-and-
// hand-over flow the preview tab has for web pages.
//
// The frames are pictures, not video. That is what keeps this tab identical on
// macOS, Windows and Linux: no codec, no vendored server, nothing per-platform
// beyond adb itself. Cost is the refresh rate — a screencap round trip is about
// half a second — which is fine for watching an agent work and is why there is
// no attempt at direct manipulation here.
//
// Frames are pulled, never pushed: the loop asks for the next picture only once
// the last has arrived and only while the tab is on screen, so a slow device
// throttles itself and a hidden tab costs nothing.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  actionableFor,
  centerOf,
  deviceFeedbackContext,
  labelFor,
  nodeAt,
  parseUiDump,
  toDevicePoint,
  type DeviceAnnotation,
} from "../android";
import * as ipc from "../ipc";
import { AgentLaunchButton } from "./AgentLaunchButton";
import type { AgentTarget } from "./TicketsPanel";
import { Button } from "./ui";

/** How long to wait after a frame before asking for the next one. The request
 *  itself costs ~500ms, so this is a pause between frames, not a frame budget. */
const FRAME_GAP_MS = 250;

interface DeviceViewProps {
  serial: string;
  projectDir: string;
  annotations: DeviceAnnotation[];
  visible: boolean;
  onPatch: (patch: {
    serial?: string;
    projectDir?: string;
    annotations?: DeviceAnnotation[];
  }) => void;
  agentTargets: AgentTarget[];
  installed: Record<string, boolean>;
  onSendToAgent: (target: AgentTarget, text: string) => void;
  onStartNew: (
    agentId: string,
    text: string,
    cwd: string | null,
  ) => Promise<boolean>;
  /** This project's components. The chosen one resolves the SDK (its
   *  local.properties pins one) and is the codebase feedback names. */
  projects: { label: string; path: string }[];
}

export default function DeviceView({
  serial,
  projectDir,
  annotations,
  visible,
  onPatch,
  agentTargets,
  installed,
  onSendToAgent,
  onStartNew,
  projects,
}: DeviceViewProps) {
  const [status, setStatus] = useState<ipc.AndroidSdkStatus | null>(null);
  const [devices, setDevices] = useState<ipc.AndroidDevice[]>([]);
  const [avds, setAvds] = useState<ipc.AndroidAvd[]>([]);
  const [frame, setFrame] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [booting, setBooting] = useState<string | null>(null);

  const imgRef = useRef<HTMLImageElement | null>(null);
  const frameUrl = useRef<string | null>(null);
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;

  const dir = projectDir || undefined;

  // ---- discovery ----

  const refreshDevices = useCallback(async () => {
    try {
      const s = await ipc.androidSdkStatus(dir);
      setStatus(s);
      if (!s.sdk) return;
      setDevices(await ipc.androidDevices(dir));
      if (s.sdk.cli) setAvds(await ipc.androidAvds(dir).catch(() => []));
    } catch (e) {
      setError(String(e));
    }
  }, [dir]);

  useEffect(() => {
    if (visible) void refreshDevices();
  }, [visible, refreshDevices]);

  // ---- frames ----

  useEffect(() => {
    if (!visible || !serial) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (stopped) return;
      try {
        const bytes = await ipc.androidScreencap(serial, dir);
        if (stopped) return;
        const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
        // Revoke the previous frame only after the next one exists, or the
        // <img> briefly has nothing to show and the tab flickers.
        const prev = frameUrl.current;
        frameUrl.current = url;
        setFrame(url);
        if (prev) URL.revokeObjectURL(prev);
        setError(null);
      } catch (e) {
        if (!stopped) setError(String(e));
      }
      if (!stopped) timer = setTimeout(() => void tick(), FRAME_GAP_MS);
    };
    void tick();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [visible, serial, dir]);

  // Drop the last frame when the tab unmounts; nothing else owns this URL.
  useEffect(
    () => () => {
      if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
      frameUrl.current = null;
    },
    [],
  );

  // ---- annotate ----

  const onFrameClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!picking || !imgRef.current || !size || resolving) return;
    const rect = imgRef.current.getBoundingClientRect();
    const point = toDevicePoint(e.clientX, e.clientY, rect, size.w, size.h);
    if (!point) return;

    setResolving(true);
    try {
      // Dumped at click time rather than cached with the frame: the tree has to
      // describe what is on screen now, and an agent may have moved the app on
      // since the picture the user is looking at was taken.
      const nodes = parseUiDump(await ipc.androidUiDump(serial, dir));
      const hit = nodes.length ? nodeAt(nodes, point.x, point.y) : null;
      if (!hit) {
        setError("Nothing in the app's accessibility tree covers that point.");
        return;
      }
      const target = actionableFor(nodes, hit);
      const component = await ipc.androidForeground(serial, dir).catch(() => "");
      const next: DeviceAnnotation = {
        n: annotationsRef.current.length + 1,
        serial,
        component,
        resourceId: target.resourceId,
        className: target.className,
        // The label the user aimed at, which on a Compose button is never on
        // the node that responds — see actionableFor.
        text: labelFor(nodes, target) || hit.text,
        contentDesc: target.contentDesc,
        clickable: target.clickable,
        bounds: target.bounds,
        comment: "",
      };
      onPatch({ annotations: [...annotationsRef.current, next] });
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setResolving(false);
    }
  };

  const setComment = (n: number, comment: string) =>
    onPatch({
      annotations: annotationsRef.current.map((a) => (a.n === n ? { ...a, comment } : a)),
    });

  const removeAnnotation = (n: number) =>
    onPatch({
      annotations: annotationsRef.current
        .filter((a) => a.n !== n)
        .map((a, i) => ({ ...a, n: i + 1 })),
    });

  const feedback = () =>
    deviceFeedbackContext(annotationsRef.current, serial, projectDir || null);

  const startEmulator = async (name: string) => {
    setBooting(name);
    setError(null);
    try {
      const started = await ipc.androidEmulatorStart(name, dir);
      onPatch({ serial: started });
      await refreshDevices();
    } catch (e) {
      setError(String(e));
    } finally {
      setBooting(null);
    }
  };

  // ---- render ----

  const missing = status?.missing ?? [];

  if (!serial) {
    const running = devices.filter((d) => d.state === "device");
    const notReady = devices.filter((d) => d.state !== "device");
    return (
      <div className="preview-view">
        <div className="device-picker">
          <div className="device-picker-card">
            <h3>Pick a device to watch</h3>
            <p className="device-picker-lead">
              Canopy shows its screen here and refreshes it while this tab is in front. Your
              agent can install the app, drive it and read its log on the same device.
            </p>

            {missing.length > 0 && (
              <div className="device-block device-block-warn">
                <h4>Install these first</h4>
                <ul>
                  {missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
            )}

            {projects.length > 1 && (
              <label className="device-project-pick">
                <span>Android project</span>
                <select
                  value={projectDir}
                  onChange={(e) => onPatch({ projectDir: e.target.value })}
                >
                  {projects.map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {running.length > 0 && (
              <div className="device-block">
                <h4>Running now</h4>
                <ul className="device-list">
                  {running.map((d) => (
                    <li key={d.serial}>
                      <button className="device-row" onClick={() => onPatch({ serial: d.serial })}>
                        <span className="device-row-name">{d.model || d.serial}</span>
                        <span className="device-row-sub">
                          {d.emulator ? "emulator" : "connected device"} · {d.serial}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {avds.length > 0 && (
              <div className="device-block">
                <h4>{running.length ? "Or start another emulator" : "Start an emulator"}</h4>
                <ul className="device-list">
                  {avds.map((avd) => (
                    <li key={avd.name}>
                      <button
                        className="device-row"
                        // A broken AVD stays visible but unclickable: hiding it
                        // would leave the user hunting for a device they know
                        // they created, and the reason is the useful part.
                        disabled={!avd.ready || booting !== null}
                        onClick={() => void startEmulator(avd.name)}
                      >
                        <span className="device-row-name">
                          {booting === avd.name ? `Starting ${avd.name}…` : avd.name}
                        </span>
                        <span className="device-row-sub">
                          {avd.problem ??
                            (booting === avd.name
                              ? "this takes about half a minute"
                              : "not running — click to boot it")}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {notReady.length > 0 && (
              <div className="device-block">
                <h4>Not usable yet</h4>
                <ul className="device-list">
                  {notReady.map((d) => (
                    <li key={d.serial} className="device-row device-row-dead">
                      <span className="device-row-name">{d.model || d.serial}</span>
                      <span className="device-row-sub">
                        {d.state === "unauthorized"
                          ? "accept the USB debugging prompt on the device"
                          : `adb reports it as ${d.state}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {devices.length === 0 && avds.length === 0 && missing.length === 0 && (
              <div className="device-block">
                <p>
                  No devices and no emulators. Create one in Android Studio, or plug in a phone
                  with USB debugging turned on.
                </p>
              </div>
            )}

            {error && <p className="preview-error device-picker-error">{error}</p>}

            <Button size="sm" onClick={() => void refreshDevices()}>
              Refresh
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="preview-view">
      <div className="preview-head">
        <span className="preview-component-badge" title={`adb serial ${serial}`}>
          {devices.find((d) => d.serial === serial)?.model || serial}
        </span>
        <Button size="sm" onClick={() => onPatch({ serial: "" })}>
          Change device
        </Button>
        <Button
          size="sm"
          className={`preview-annotate-toggle ${picking ? "preview-annotate-on" : ""}`}
          title="Annotate: click anything on the device to attach feedback to it"
          onClick={() => setPicking((p) => !p)}
        >
          ◎ Annotate{annotations.length > 0 ? ` (${annotations.length})` : ""}
        </Button>
        {resolving && <span className="device-busy">Reading the screen…</span>}
      </div>
      <div className="preview-body">
        <div className="preview-frame-wrap device-frame-wrap">
          {frame ? (
            // The box is given the device's aspect ratio and told to fit the
            // pane; the image then fills it exactly. Sizing the image by
            // `max-height: 100%` instead does nothing, because its parent has
            // no definite height to resolve the percentage against — which is
            // how the frame ended up overflowing the pane.
            <div
              className="device-screen"
              style={size ? { aspectRatio: `${size.w} / ${size.h}` } : undefined}
            >
              <img
                ref={imgRef}
                src={frame}
                alt={`Screen of ${serial}`}
                className={picking ? "device-picking" : ""}
                onClick={(e) => void onFrameClick(e)}
                onLoad={(e) =>
                  setSize({
                    w: e.currentTarget.naturalWidth,
                    h: e.currentTarget.naturalHeight,
                  })
                }
              />
              {size &&
                annotations.map((a) => (
                  <span
                    key={a.n}
                    className="device-mark"
                    // Percentages of the frame, not scaled pixels: correct at
                    // any pane size, and no layout read during render.
                    style={{
                      left: `${(a.bounds.x1 / size.w) * 100}%`,
                      top: `${(a.bounds.y1 / size.h) * 100}%`,
                      width: `${((a.bounds.x2 - a.bounds.x1) / size.w) * 100}%`,
                      height: `${((a.bounds.y2 - a.bounds.y1) / size.h) * 100}%`,
                    }}
                  >
                    <b>{a.n}</b>
                  </span>
                ))}
            </div>
          ) : (
            <p className="preview-panel-hint">Waiting for the first frame…</p>
          )}
          {error && <p className="preview-error">{error}</p>}
        </div>
        {(annotations.length > 0 || picking) && (
          <div className="preview-panel">
            <div className="preview-panel-head">
              <span>Feedback</span>
              {annotations.length > 0 && (
                <Button size="sm" onClick={() => onPatch({ annotations: [] })}>
                  Clear all
                </Button>
              )}
            </div>
            {annotations.length === 0 && (
              <p className="preview-panel-hint">
                Click anything on the device to tag it, then write what should change.
              </p>
            )}
            <div className="preview-panel-list">
              {annotations.map((a) => (
                <div className="preview-note" key={a.n}>
                  <div className="preview-note-head">
                    <span className="preview-note-badge">{a.n}</span>
                    <span
                      className="preview-note-what"
                      title={`${a.className}\n${
                        a.resourceId || "no resource id (normal for Compose)"
                      }`}
                    >
                      {a.resourceId
                        ? a.resourceId.replace(/^.*:id\//, "#")
                        : shortClass(a.className)}
                    </span>
                    <Button icon className="preview-note-remove"
                      title="Remove"
                      onClick={() => removeAnnotation(a.n)}>
                      ✕
                    </Button>
                  </div>
                  {a.text && <div className="preview-note-text">“{a.text.slice(0, 120)}”</div>}
                  {a.clickable && (
                    <Button size="sm" className="device-tap"
                      title="Tap this element on the device"
                      onClick={() => {
                        const c = centerOf(a.bounds);
                        void ipc.androidTap(serial, c.x, c.y, dir).catch((e) => setError(String(e)));
                      }}>
                      Tap it
                    </Button>
                  )}
                  <textarea
                    className="preview-note-comment"
                    placeholder="What should change here?"
                    value={a.comment}
                    onChange={(e) => setComment(a.n, e.target.value)}
                  />
                </div>
              ))}
            </div>
            {annotations.length > 0 && (
              <div className="preview-panel-foot">
                <AgentLaunchButton
                  label="Send feedback"
                  agentTargets={agentTargets}
                  installed={installed}
                  newAgentLabel="New agent on this feedback"
                  primaryTitle={(cli) => `Start ${cli} on this feedback`}
                  onStart={(agentId) => onStartNew(agentId, feedback(), projectDir || null)}
                  onSend={(target) => onSendToAgent(target, feedback())}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** `androidx.compose.ui.platform.ComposeView` reads as `ComposeView` in a chip. */
const shortClass = (cls: string) => cls.split(".").pop() || cls || "element";

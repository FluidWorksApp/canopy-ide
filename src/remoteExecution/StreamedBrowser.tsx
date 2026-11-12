// Ported from T3 Code (MIT) apps/web/src/browser/ServerBrowserSurface.tsx
// (pingdotgg/t3code d5290e9): the live view of a workspace's agent browser
// (packages/remote-host/agent-browser.mjs), its Take/Release control button,
// pointer, wheel and keyboard input, and the page's dialogs. The canvas,
// input and dialogs are StreamSurface.tsx, shared with the desktop preview.
//
// Differences: Canopy's Button and workspace.css instead of Tailwind and T3's
// ui kit; plain ResizeObserver for T3's observeResize; a stream URL is a
// fresh gateway ticket per connect (browserStream.ts), so there is no access
// refresh or "connection refused" state. The stream stops while the window
// is hidden or the overlay is minimized ("only the visible tab streams").
// Not ported: PDF embedding, file chooser uploads, downloads, popups and the
// host-setup notice (no Canopy counterpart). The agent cursor overlay is
// kept, but Canopy's agent clicks through the in-page picker, which reports
// no pointer, so it shows only if the runner sends one.
import { useEffect, useRef, useState } from "react";
import type { RemoteExecutionClient } from "./client";
import { Button } from "../components/ui";
import { CloseIcon, MinimizeIcon, RestartIcon } from "../components/icons";
import {
  previewStreamControlLabel,
  type PreviewStreamControl,
  type PreviewStreamInput,
} from "./browserStream";
import {
  StreamSurface,
  useDocumentVisible,
  type StreamSurfaceHandle,
} from "./StreamSurface";
import "./workspace.css";

const NOTE_MS = 4_000;

export function StreamedBrowser({
  client,
  workspaceId,
  workspaceName,
  minimized = false,
  onMinimize,
  onClose,
}: {
  client: RemoteExecutionClient;
  workspaceId: string;
  workspaceName?: string;
  minimized?: boolean;
  onMinimize?: () => void;
  onClose?: () => void;
}) {
  const documentVisible = useDocumentVisible();
  const visible = documentVisible && !minimized;
  const handleRef = useRef<StreamSurfaceHandle | null>(null);
  const [control, setControl] = useState<PreviewStreamControl | null>(null);
  const [gone, setGone] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(""), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  // A dropped connection forgets who controls the page until the next state message.
  useEffect(() => {
    if (!visible) setControl(null);
  }, [visible]);

  const send = (input: PreviewStreamInput) => {
    handleRef.current?.send(input);
  };

  const owned = control?.controller === "you";
  const status = gone
    ? "The agent browser closed"
    : !visible
      ? "Paused while hidden"
      : note || previewStreamControlLabel(control);
  return (
    <div
      className="remote-desktop streamed-browser"
      data-streamed-browser={workspaceId}
    >
      <div className="side-panel-head">
        <span className="remote-desktop-heading">
          <span>Agent browser{workspaceName ? ` · ${workspaceName}` : ""}</span>
          <span role="status">{status}</span>
        </span>
        <span className="side-head-actions">
          <Button
            size="sm"
            variant="ghost"
            disabled={!owned}
            title="Back"
            aria-label="Back"
            onClick={() => send({ type: "history", delta: -1 })}
          >
            ‹
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!owned}
            title="Forward"
            aria-label="Forward"
            onClick={() => send({ type: "history", delta: 1 })}
          >
            ›
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!owned}
            title="Reload the page"
            onClick={() => send({ type: "reload" })}
          >
            Reload
          </Button>
          {control?.canOperate ? (
            <Button
              size="sm"
              variant={owned ? "default" : "accent"}
              disabled={control.controller === "another-viewer"}
              onClick={() =>
                send({ type: owned ? "releaseControl" : "takeControl" })
              }
            >
              {owned ? "Release control" : "Take control"}
            </Button>
          ) : null}
          {gone && (
            <Button
              size="sm"
              variant="ghost"
              icon
              title="Reopen the agent browser"
              aria-label="Reopen the agent browser"
              onClick={() => {
                setGone(false);
                setAttempt((n) => n + 1);
              }}
            >
              <RestartIcon />
            </Button>
          )}
          {onMinimize && (
            <Button
              size="sm"
              variant="ghost"
              icon
              title="Minimize agent browser"
              aria-label="Minimize agent browser"
              onClick={onMinimize}
            >
              <MinimizeIcon />
            </Button>
          )}
          {onClose && (
            <Button
              size="sm"
              variant="ghost"
              icon
              title="Close agent browser"
              aria-label="Close agent browser"
              onClick={onClose}
            >
              <CloseIcon />
            </Button>
          )}
        </span>
      </div>
      <StreamSurface
        key={attempt}
        streamUrl={(path) => client.streamUrl(workspaceId, path)}
        connectKey={workspaceId}
        visible={visible && !gone}
        handleRef={handleRef}
        onControl={setControl}
        onNote={setNote}
        onGone={() => {
          setGone(true);
          setControl(null);
        }}
      />
    </div>
  );
}

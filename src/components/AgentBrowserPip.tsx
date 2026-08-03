// A passive view of the browser an agent is driving. The native browser cannot
// be mounted in two places, so this pulls background snapshots from the same
// linked preview tab instead of creating a second page with different state.
import { useEffect, useRef, useState } from "react";
import * as ipc from "../ipc";
import { AgentIcon, CloseIcon, GlobeIcon } from "./icons";

const FRAME_GAP_MS = 250;
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;

interface AgentBrowserPipProps {
  tabId: string;
  url: string;
  agentId: string;
  agentTitle: string;
  supported: boolean;
  onClose: () => void;
}

function pipWidth(startWidth: number, startX: number, clientX: number, viewport: number) {
  return Math.round(
    Math.min(Math.max(MIN_WIDTH, viewport - 48), MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + startX - clientX)),
  );
}

export function AgentBrowserPip({
  tabId,
  url,
  agentId,
  agentTitle,
  supported,
  onClose,
}: AgentBrowserPipProps) {
  const [frame, setFrame] = useState<string | null>(null);
  const [ratio, setRatio] = useState(16 / 9);
  const [width, setWidth] = useState(400);
  const [minimized, setMinimized] = useState(false);
  const [failed, setFailed] = useState(false);
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    if (!supported || minimized) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const shot = await ipc.browserSnapshot(tabId, 720);
        if (stopped) return;
        setFrame(`data:image/png;base64,${shot.image}`);
        if (shot.width > 0 && shot.height > 0) setRatio(shot.width / shot.height);
        setFailed(false);
      } catch {
        if (!stopped) setFailed(true);
      }
      if (!stopped) timer = setTimeout(() => void tick(), FRAME_GAP_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [minimized, supported, tabId]);

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const grip = e.currentTarget;
    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startWidth = widthRef.current;
    grip.setPointerCapture?.(pointerId);
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      setWidth(pipWidth(startWidth, startX, ev.clientX, window.innerWidth));
    };
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      grip.releasePointerCapture?.(pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  let host = "Browser";
  try {
    host = new URL(url).host;
  } catch {
    // The linked preview may still be navigating; its next render updates this.
  }

  return (
    <aside
      className={`agent-browser-pip${minimized ? " minimized" : ""}`}
      style={{ width }}
      aria-label={`${agentTitle} browser picture in picture`}
    >
      <header className="agent-browser-pip-head">
        <span className="agent-browser-pip-agent">
          <AgentIcon id={agentId} size={14} />
          <span>{agentTitle}</span>
        </span>
        <span className="agent-browser-pip-page" title={url}>
          <GlobeIcon size={12} /> {host}
        </span>
        <button
          className="agent-browser-pip-action"
          title={minimized ? "Restore browser picture in picture" : "Minimize browser picture in picture"}
          aria-label={minimized ? "Restore browser picture in picture" : "Minimize browser picture in picture"}
          onClick={() => setMinimized((v) => !v)}
        >
          {minimized ? "□" : "−"}
        </button>
        <button
          className="agent-browser-pip-action"
          title="Close browser picture in picture"
          aria-label="Close browser picture in picture"
          onClick={onClose}
        >
          <CloseIcon size={13} />
        </button>
      </header>
      {!minimized && (
        <div className="agent-browser-pip-frame" style={{ aspectRatio: ratio }}>
          {frame ? (
            <img src={frame} alt={`Live read-only view of ${host}`} draggable={false} />
          ) : (
            <span>{supported && !failed ? "Connecting to browser..." : "Live view unavailable"}</span>
          )}
          <span className="agent-browser-pip-readonly">Live / read only</span>
          <div
            className="agent-browser-pip-resize"
            role="separator"
            aria-label="Resize browser picture in picture"
            aria-orientation="vertical"
            onPointerDown={startResize}
          />
        </div>
      )}
    </aside>
  );
}

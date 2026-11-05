import { useEffect, useRef, useState, useImperativeHandle, type Ref } from "react";
import type { RemoteExecutionClient } from "./client";
import { Button } from '../components/ui';
import './workspace.css';
import { remoteDiagnostic } from './remoteDiagnostic';
import { CloseIcon, MinimizeIcon, RestartIcon } from '../components/icons';

/** How long a minimized desktop stays connected. An open stream counts as
 *  activity, so an indefinite one would keep the workspace from idling out. */
export const MINIMIZED_KEEP_MS = 15 * 60_000;
const RETRY_MAX_MS = 30_000;

export type RemoteDesktopCapture = { capture(): {png:string;cssWidth:number} };

export function RemoteDesktop({ client, workspaceId, workspaceName, onClose, onMinimize, minimized = false, previewUrl, captureRef }: { client: RemoteExecutionClient; workspaceId: string; workspaceName?: string; onClose?: () => void; onMinimize?: () => void; minimized?: boolean; previewUrl?: string; captureRef?: Ref<RemoteDesktopCapture> }) {
  const surface = useRef<HTMLDivElement>(null);
  const connection = useRef<import('@novnc/novnc').default | null>(null);
  const connected = useRef(false);
  useImperativeHandle(captureRef,()=>({capture(){
    const rfb=connection.current;
    if(!rfb||!connected.current)throw Error('Workspace browser is not connected');
    const rect=surface.current?.getBoundingClientRect();
    if(!rect||rect.width<1||rect.height<1)throw Error('Workspace browser is not visible');
    const image=rfb.toDataURL('image/png');
    if(!image.startsWith('data:image/png;base64,'))throw Error('Workspace display did not provide a PNG');
    return {png:image.slice('data:image/png;base64,'.length),cssWidth:rect.width};
  }}),[]);
  const [attempt, setAttempt] = useState(0);
  const [fit, setFit] = useState(true);
  const [status, setStatus] = useState("Starting workspace desktop…");
  const [parked, setParked] = useState(false);
  const drops = useRef(0);
  // Staying mounted is what makes restoring instant. Hidden, it gives up the
  // keyboard so typing in the IDE cannot land in the workspace.
  useEffect(() => {
    if (!minimized) {
      setParked(false);
      connection.current?.focus({ preventScroll: true });
      return;
    }
    connection.current?.blur();
    const timer = setTimeout(() => setParked(true), MINIMIZED_KEEP_MS);
    return () => clearTimeout(timer);
  }, [minimized]);
  useEffect(() => {
    if (parked) { setStatus('Paused while minimized'); return; }
    setStatus('Connecting…');
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let disconnect: (() => void) | undefined;
    const display = import("@novnc/novnc");
    display.catch(() => {});
    void (async () => {
      try {
        await client.workspace(workspaceId, "/desktop", {});
        if (disposed) return;
        await client.workspace(workspaceId, "/native", {command: "desktop_session", args: {}});
        if (disposed) return;
        if (previewUrl) await client.workspace(workspaceId, "/native", { command: "workspace_preview_open", args: { url: previewUrl } });
        if (disposed) return;
        const [{ default: RFB }, url] = await Promise.all([display, client.streamUrl(workspaceId, "/desktop/ws")]);
        if (disposed) return;
        const rfb = new RFB(surface.current!, url);
        connection.current = rfb;
        rfb.scaleViewport = true;
        rfb.background = 'var(--bg-deep)';
        rfb.addEventListener("connect", () => { if (!disposed) { connected.current=true;drops.current=0;setStatus("Connected");remoteDiagnostic('desktop-connected'); } });
        rfb.addEventListener("disconnect", () => {
          if (disposed) return;
          connected.current = false;
          remoteDiagnostic('desktop-disconnected');
          setStatus("Reconnecting… agents keep running");
          const delay = Math.min(1000 * 2 ** Math.min(drops.current++, 5), RETRY_MAX_MS);
          retry = setTimeout(() => setAttempt(value => value + 1), delay);
        });
        disconnect = () => rfb.disconnect();
      } catch (error) { if (!disposed) { setStatus(String(error)); remoteDiagnostic('desktop-failed'); } }
    })();
    return () => { disposed = true; clearTimeout(retry); connected.current=false; disconnect?.(); connection.current = null; };
  }, [client, workspaceId, attempt, previewUrl, parked]);
  useEffect(() => { if (connection.current) connection.current.scaleViewport = fit; }, [fit, status]);
  return <div className="remote-desktop">
    <div className="side-panel-head">
      <span className="remote-desktop-heading"><span>{previewUrl ? "Workspace browser" : "Desktop"}{workspaceName ? ` · ${workspaceName}` : ''}</span><span role="status">{status}</span></span>
      <span className="side-head-actions">
        <Button size="sm" variant="ghost" aria-pressed={fit} title={fit ? 'Show desktop at its original size' : 'Fit desktop to the viewer'} onClick={() => setFit(value => !value)}>{fit ? 'Actual size' : 'Fit'}</Button>
        <Button size="sm" variant="ghost" icon title="Reconnect desktop" aria-label="Reconnect desktop" onClick={() => setAttempt(value => value + 1)}><RestartIcon /></Button>
        {onMinimize && <Button size="sm" variant="ghost" icon title="Minimize desktop (stays connected)" aria-label="Minimize desktop" onClick={onMinimize}><MinimizeIcon /></Button>}
        {onClose && <Button size="sm" variant="ghost" icon title="Close desktop" aria-label="Close desktop" onClick={onClose}><CloseIcon /></Button>}
      </span>
    </div>
    <div ref={surface} className="remote-desktop-surface" />
  </div>;
}

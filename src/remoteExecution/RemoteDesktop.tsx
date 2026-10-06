import { useEffect, useRef, useState, useImperativeHandle, type Ref } from "react";
import type { RemoteExecutionClient } from "./client";
import { Button } from '../components/ui';
import './workspace.css';
import { CloseIcon, RestartIcon } from '../components/icons';

export type RemoteDesktopCapture = { capture(): {png:string;cssWidth:number} };

export function RemoteDesktop({ client, workspaceId, workspaceName, onClose, previewUrl, captureRef }: { client: RemoteExecutionClient; workspaceId: string; workspaceName?: string; onClose?: () => void; previewUrl?: string; captureRef?: Ref<RemoteDesktopCapture> }) {
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
  useEffect(() => {
    setStatus('Connecting…');
    let disposed = false;
    let disconnect: (() => void) | undefined;
    void (async () => {
      try {
        await client.workspace(workspaceId, "/desktop", {});
        if (disposed) return;
        await client.workspace(workspaceId, "/native", {command: "desktop_session", args: {}});
        if (disposed) return;
        if (previewUrl) await client.workspace(workspaceId, "/native", { command: "workspace_preview_open", args: { url: previewUrl } });
        if (disposed) return;
        const [{ default: RFB }, url] = await Promise.all([import("@novnc/novnc"), client.streamUrl(workspaceId, "/desktop/ws")]);
        if (disposed) return;
        const rfb = new RFB(surface.current!, url);
        connection.current = rfb;
        rfb.scaleViewport = true;
        rfb.background = 'var(--bg-deep)';
        rfb.addEventListener("connect", () => { if (!disposed) { connected.current=true;setStatus("Connected"); } });
        rfb.addEventListener("disconnect", () => { if (!disposed) {connected.current=false;setStatus("Desktop disconnected; agents keep running");} });
        disconnect = () => rfb.disconnect();
      } catch (error) { if (!disposed) setStatus(String(error)); }
    })();
    return () => { disposed = true; connected.current=false; disconnect?.(); connection.current = null; };
  }, [client, workspaceId, attempt, previewUrl]);
  useEffect(() => { if (connection.current) connection.current.scaleViewport = fit; }, [fit, status]);
  return <div className="remote-desktop">
    <div className="side-panel-head">
      <span className="remote-desktop-heading"><span>{previewUrl ? "Workspace browser" : "Desktop"}{workspaceName ? ` · ${workspaceName}` : ''}</span><span role="status">{status}</span></span>
      <span className="side-head-actions">
        <Button size="sm" variant="ghost" aria-pressed={fit} title={fit ? 'Show desktop at its original size' : 'Fit desktop to the viewer'} onClick={() => setFit(value => !value)}>{fit ? 'Actual size' : 'Fit'}</Button>
        <Button size="sm" variant="ghost" icon title="Reconnect desktop" aria-label="Reconnect desktop" onClick={() => setAttempt(value => value + 1)}><RestartIcon /></Button>
        {onClose && <Button size="sm" variant="ghost" icon title="Close desktop" aria-label="Close desktop" onClick={onClose}><CloseIcon /></Button>}
      </span>
    </div>
    <div ref={surface} className="remote-desktop-surface" />
  </div>;
}

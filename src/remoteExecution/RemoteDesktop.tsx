import { useCallback, useEffect, useRef, useState, useImperativeHandle, type Ref } from "react";
import type { RemoteExecutionClient } from "./client";
import { Button } from '../components/ui';
import './workspace.css';
import { remoteDiagnostic } from './remoteDiagnostic';
import { CloseIcon, MinimizeIcon, RestartIcon } from '../components/icons';
import { readClipboardText, writeClipboardText } from '../terminalClipboard';
import { createPcmPlayer, DESKTOP_AUDIO_RATE } from './desktopAudio';
import { copiedText, fitsVncClipboard, KEYS } from './desktopClipboard';

/** How long a minimized desktop stays connected. An open stream counts as
 *  activity, so an indefinite one would keep the workspace from idling out. */
export const MINIMIZED_KEEP_MS = 15 * 60_000;
const RETRY_MAX_MS = 30_000;
const AUDIO_RETRY_MS = 2_000;
const NOTE_MS = 4_000;
/** Time for the focused program to answer the copy shortcut. */
const COPY_SETTLE_MS = 200;
const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

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
  const [sound, setSound] = useState(false);
  const [note, setNote] = useState('');
  const audio = useRef<AudioContext | null>(null);
  const live = status === 'Connected';
  const press = useCallback((...keys: (readonly [number, string])[]) => {
    const rfb = connection.current;
    if (!rfb) return;
    for (const [keysym, code] of keys) rfb.sendKey(keysym, code, true);
    for (const [keysym, code] of [...keys].reverse()) rfb.sendKey(keysym, code, false);
  }, []);
  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(''), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);
  // Cmd was already sent as Super, and Shift for Ctrl+Shift+C. Held, they would
  // turn the shortcut into another one.
  const releaseModifiers = useCallback(() => {
    for (const [keysym, code] of [KEYS.superLeft, KEYS.superRight, KEYS.shift]) connection.current?.sendKey(keysym, code, false);
  }, []);
  // The clipboard goes through the workspace rather than VNC: x11vnc's is
  // Latin-1, and it passed changes late or not at all when tested.
  const paste = useCallback(async () => {
    const text = await readClipboardText();
    const rfb = connection.current;
    if (!rfb || !connected.current) return;
    if (!text) { setNote('Nothing to paste'); return; }
    setNote('');
    try { await client.workspace(workspaceId, '/native', { command: 'desktop_clipboard_write', args: { text } }); }
    catch {
      rfb.clipboardPasteFrom(text);
      if (!fitsVncClipboard(text)) setNote('Some characters may not paste until this workspace updates');
    }
    // Shift+Insert pastes in terminals as well as in GUI programs, where Ctrl+V doesn't.
    press(KEYS.shift, KEYS.insert);
    rfb.focus({ preventScroll: true });
  }, [client, workspaceId, press]);
  // Only ever on a shortcut or a click here: a workspace can't reach this
  // computer's clipboard by itself.
  const copy = useCallback(async () => {
    const read = async (selection: 'clipboard' | 'primary') => (await client.workspace<{ result?: string }>(workspaceId, '/native', { command: 'desktop_clipboard_read', args: { selection } })).result ?? '';
    try {
      const before = await read('clipboard');
      press(KEYS.control, KEYS.insert);
      await new Promise(resolve => setTimeout(resolve, COPY_SETTLE_MS));
      const text = copiedText(before, await read('clipboard'), await read('primary'));
      if (!text) { setNote('Nothing selected to copy'); return; }
      setNote(await writeClipboardText(text) ? 'Copied to this computer' : 'Couldn’t reach this computer’s clipboard');
    } catch { setNote('Copying needs a newer workspace'); }
    connection.current?.focus({ preventScroll: true });
  }, [client, workspaceId, press]);
  // Capture runs first, so noVNC never sends these as plain keystrokes.
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const key = (event: KeyboardEvent) => {
      const name = event.key.toLowerCase();
      const pasting = name === 'v' && (MAC ? event.metaKey : event.ctrlKey && !event.shiftKey);
      const copying = name === 'c' && (MAC ? event.metaKey : event.ctrlKey && event.shiftKey);
      if (!pasting && !copying) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      releaseModifiers();
      void (pasting ? paste() : copy());
    };
    element.addEventListener('keydown', key, true);
    return () => element.removeEventListener('keydown', key, true);
  }, [copy, paste, releaseModifiers]);
  // The context is created by the click itself, or the webview keeps it silent.
  const toggleSound = () => {
    setNote('');
    if (sound) { setSound(false); return; }
    audio.current ??= new AudioContext({ sampleRate: DESKTOP_AUDIO_RATE });
    void audio.current.resume();
    setSound(true);
  };
  useEffect(() => () => { void audio.current?.close(); audio.current = null; }, []);
  useEffect(() => {
    if (!sound || !live) return;
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const unavailable = () => { setSound(false); setNote('Sound isn’t available in this workspace yet'); };
    const open = async () => {
      try {
        const url = await client.streamUrl(workspaceId, '/desktop/audio');
        if (disposed || !audio.current) return;
        const play = createPcmPlayer(audio.current);
        let heard = false;
        socket = new WebSocket(url);
        socket.binaryType = 'arraybuffer';
        socket.onmessage = event => { heard = true; play(event.data as ArrayBuffer); };
        socket.onclose = () => { if (disposed) return; if (heard) retry = setTimeout(() => void open(), AUDIO_RETRY_MS); else unavailable(); };
      } catch { if (!disposed) unavailable(); }
    };
    void open();
    return () => { disposed = true; clearTimeout(retry); socket?.close(); };
  }, [client, workspaceId, sound, live]);
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
      <span className="remote-desktop-heading"><span>{previewUrl ? "Workspace browser" : "Desktop"}{workspaceName ? ` · ${workspaceName}` : ''}</span><span role="status">{note || status}</span></span>
      <span className="side-head-actions">
        <Button size="sm" variant="ghost" aria-pressed={sound} disabled={!live} title={sound ? 'Mute workspace sound' : 'Play workspace sound on this computer'} onClick={toggleSound}>{sound ? 'Sound on' : 'Sound off'}</Button>
        <Button size="sm" variant="ghost" disabled={!live} title="Copy the workspace selection to this computer" onClick={() => void copy()}>Copy</Button>
        <Button size="sm" variant="ghost" disabled={!live} title="Paste this computer’s clipboard into the workspace" onClick={() => void paste()}>Paste</Button>
        <Button size="sm" variant="ghost" aria-pressed={fit} title={fit ? 'Show desktop at its original size' : 'Fit desktop to the viewer'} onClick={() => setFit(value => !value)}>{fit ? 'Actual size' : 'Fit'}</Button>
        <Button size="sm" variant="ghost" icon title="Reconnect desktop" aria-label="Reconnect desktop" onClick={() => setAttempt(value => value + 1)}><RestartIcon /></Button>
        {onMinimize && <Button size="sm" variant="ghost" icon title="Minimize desktop (stays connected)" aria-label="Minimize desktop" onClick={onMinimize}><MinimizeIcon /></Button>}
        {onClose && <Button size="sm" variant="ghost" icon title="Close desktop" aria-label="Close desktop" onClick={onClose}><CloseIcon /></Button>}
      </span>
    </div>
    <div ref={surface} className="remote-desktop-surface" />
  </div>;
}

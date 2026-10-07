import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { coalesced } from "./coalesced";
import { TerminalInput } from "./terminalInput";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { RemoteExecutionClient } from "./client";

export function RemoteTerminal({ client, workspaceId, sessionId, sharedSessionId, writable }: {
  client: RemoteExecutionClient; workspaceId: string; sessionId: number; sharedSessionId?:string; writable: boolean;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Connecting…");
  useEffect(() => {
    const sessionRoute=sharedSessionId?`/shared-sessions/${sharedSessionId}`:`/sessions/${sessionId}`;
    const term = new Terminal({ scrollback: 2000, disableStdin: !writable, theme: { background: "#0d0f12" } });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(surface.current!);
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let parsing = 0;
    let connectionEpoch = 0;
    let exited = false;
    const decoder = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const geometry = coalesced<{ cols: number; rows: number }>(value => client.workspace(workspaceId, `/sessions/${sessionId}/resize`, value));
    const resize = () => {
      fit.fit();
      if (writable&&!sharedSessionId) geometry.push({ cols: Math.min(512, Math.max(1, term.cols)), rows: Math.min(256, Math.max(1, term.rows)) });
    };
    const observer = new ResizeObserver(resize); observer.observe(surface.current!);
    // Ordered, bounded input: over the stream socket when the gateway offers
    // it, otherwise one HTTP request at a time. Never retain a growing list
    // of HTTP promises while a VM is unavailable.
    const sender = new TerminalInput(body => client.workspace(workspaceId, `${sessionRoute}/input`, body), 16 * 1024);
    const input = term.onData(data => {
      if(!writable)return;
      if (document.hidden || socket?.readyState !== WebSocket.OPEN || exited) {
        setStatus("Terminal is reconnecting; input was not sent"); return;
      }
      if (sender.queued + data.length > 16 * 1024) { setStatus("Input queue full"); return; }
      sender.write(data).catch(() => { if (!disposed && !document.hidden) setStatus("Input failed; check the connection before retrying"); });
    });
    const connect = async () => {
      if (disposed || document.hidden || exited) return;
      const epoch = ++connectionEpoch;
      const current = () => !disposed && epoch === connectionEpoch && !document.hidden;
      try {
        const url = await client.streamUrl(workspaceId, `${sessionRoute}/stream`);
        if (!current()) return;
        socket = new WebSocket(url);
        const connectedSocket = socket;
        socket.onopen = () => { if (current()) setStatus("Connected"); };
        socket.onmessage = event => {
          if (!current()) return;
          let message;
          try { message = JSON.parse(event.data); }
          catch { connectedSocket.close(); return; }
          if (message.t === "hello") { sender.hello(connectedSocket, message.input); return; }
          if (message.t === "input-ack") { sender.acknowledge(message.id, message.seq); return; }
          if (message.t === "input-error") { sender.rejected(message.id, message.error); return; }
          if (message.t === "exit") { exited = true; setStatus(`Exited (${message.exitCode})`); return; }
          if (message.t !== "snapshot" && message.t !== "data") return;
          let bytes: Uint8Array;
          try { bytes = decoder(message.b64); }
          catch { connectedSocket.close(); return; }
          if (message.t === "snapshot") {
            term.reset(); term.resize(message.cols, message.rows);
            // Managed hosts restore current cells, rather than playing stale
            // spinner frames accumulated while this renderer was unfocused.
            if (message.reset && bytes[0] === 0) bytes = bytes.subarray(1);
            if (message.exitCode != null) { exited = true; setStatus(`Exited (${message.exitCode})`); }
          }
          if (parsing + bytes.length > 1024 * 1024) { socket?.close(); return; }
          parsing += bytes.length;
          term.write(bytes, () => { parsing -= bytes.length; });
        };
        socket.onclose = () => {
          sender.closed(connectedSocket);
          if (!current() || exited) return;
          setStatus("Disconnected — agents continue on the host");
          retry = window.setTimeout(() => void connect(), 1500);
        };
      } catch (error) {
        if (current()) { setStatus(String(error)); retry = window.setTimeout(() => void connect(), 5000); }
      }
    };
    const visibilityChanged = () => {
      window.clearTimeout(retry);
      ++connectionEpoch;
      if (socket) sender.closed(socket);
      socket?.close(); socket = undefined;
      sender.fail(Error("Terminal hidden"));
      if (!document.hidden && !exited) { setStatus("Reconnecting…"); void connect(); }
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    void connect();
    return () => { disposed = true; ++connectionEpoch; sender.dispose(); document.removeEventListener("visibilitychange", visibilityChanged); window.clearTimeout(retry); socket?.close(); observer.disconnect(); geometry.stop(); input.dispose(); term.dispose(); };
  }, [client, workspaceId, sessionId, sharedSessionId, writable]);
  return <div className="remote-terminal"><div className="remote-status" role="status">{status}</div><div ref={surface} className="remote-terminal-surface" /></div>;
}

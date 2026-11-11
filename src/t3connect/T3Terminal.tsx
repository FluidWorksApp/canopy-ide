// A terminal on a T3 Code machine: xterm as RemoteTerminal.tsx uses it, wired
// to terminal.open / attach / write / resize / close over the RPC socket.
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { coalesced } from "../remoteExecution/coalesced";
import type { T3RpcClient } from "./rpc";
import { CANOPY_TERMINAL_THREAD_ID, t3 } from "./methods";

/** packages/contracts/src/terminal.ts: TerminalWriteInput data ≤ 65,536 chars,
 *  cols 1..1000, rows 1..500. */
const MAX_WRITE = 65_536;
const clamp = (value: number, max: number) => Math.min(max, Math.max(1, Math.floor(value)));

export function T3Terminal({ rpc, cwd, terminalId, writable, startup }: {
  rpc: T3RpcClient; cwd: string; terminalId: string; writable: boolean;
  /** Typed into the shell once it is running, e.g. an agent CLI's command. */
  startup?: string;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("Opening…");
  useEffect(() => {
    const threadId = CANOPY_TERMINAL_THREAD_ID;
    const term = new Terminal({ scrollback: 5000, disableStdin: !writable, theme: { background: "#0d0f12" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(surface.current!);
    fit.fit();
    let disposed = false;
    let writes = Promise.resolve();
    let started = false;
    const report = (error: unknown) => { if (!disposed) setStatus(error instanceof Error ? error.message : String(error)); };
    const geometry = coalesced<{ cols: number; rows: number }>(size =>
      t3.terminalResize(rpc, { threadId, terminalId, ...size }));
    const resize = () => {
      fit.fit();
      if (writable) geometry.push({ cols: clamp(term.cols, 1000), rows: clamp(term.rows, 500) });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(surface.current!);
    const input = term.onData(data => {
      if (!writable) return;
      // One write at a time keeps keystrokes in order.
      for (let at = 0; at < data.length; at += MAX_WRITE) {
        const chunk = data.slice(at, at + MAX_WRITE);
        writes = writes.then(() => t3.terminalWrite(rpc, { threadId, terminalId, data: chunk })).catch(report);
      }
    });
    let attach: ReturnType<typeof t3.terminalAttach> | undefined;
    const size = { cols: clamp(term.cols, 1000), rows: clamp(term.rows, 500) };
    void t3.terminalOpen(rpc, { threadId, terminalId, cwd, ...size }).then(() => {
      if (disposed) return;
      attach = t3.terminalAttach(rpc, { threadId, terminalId, cwd, ...size }, event => {
        if (disposed) return;
        switch (event.type) {
          case "snapshot":
          case "restarted":
            term.reset();
            term.write(event.snapshot.history);
            setStatus(event.snapshot.status === "running" ? "Connected" : `Terminal ${event.snapshot.status}`);
            if (startup && writable && !started && event.type === "snapshot" && event.snapshot.status === "running") {
              started = true;
              writes = writes.then(() => t3.terminalWrite(rpc, { threadId, terminalId, data: `${startup}\r` })).catch(report);
            }
            return;
          case "output":
            return new Promise<void>(resolve => term.write(event.data, resolve));
          case "cleared":
            term.clear();
            return;
          case "exited":
            setStatus(`Exited (${event.exitCode ?? event.exitSignal ?? "?"})`);
            return;
          case "closed":
            setStatus("Terminal closed");
            return;
          case "error":
            setStatus(event.message);
            return;
          default:
            return;
        }
      });
      attach.done.then(() => { if (!disposed) setStatus("Terminal stream ended"); }, report);
    }, report);
    return () => {
      disposed = true;
      // Leaving the view stops watching; the shell keeps running on the
      // machine, as it does when a T3 client closes.
      attach?.cancel();
      observer.disconnect();
      geometry.stop();
      input.dispose();
      term.dispose();
    };
  }, [rpc, cwd, terminalId, writable]);
  return <div className="remote-terminal"><div className="remote-status" role="status">{status}</div><div ref={surface} className="remote-terminal-surface t3-terminal-surface" /></div>;
}

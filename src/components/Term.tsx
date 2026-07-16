// One xterm.js terminal bound to one PTY session. Raw bytes pass straight
// through in both directions — no filtering or normalization anywhere.
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SerializeAddon } from "@xterm/addon-serialize";
import "@xterm/xterm/css/xterm.css";
import * as ipc from "../ipc";
import { getSettings } from "../settings";

export interface TermHandle {
  clearScrollback: () => void;
  hardReset: () => void;
  focus: () => void;
}

interface TermProps {
  cwd?: string;
  active: boolean;
  /** Typed into the shell right after spawn (e.g. launch an agent CLI). */
  initialCommand?: string;
  onSpawned: (ptyId: number) => void;
  onExited: (exitCode: number | null) => void;
  onTitle?: (title: string) => void;
}

export const Term = forwardRef<TermHandle, TermProps>(function Term(
  { cwd, active, initialCommand, onSpawned, onExited, onTitle },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const ptyIdRef = useRef<number | null>(null);

  useImperativeHandle(ref, () => ({
    clearScrollback: () => termRef.current?.clear(),
    hardReset: () => {
      termRef.current?.reset();
      // \x0c: ask the shell to repaint its prompt after the hard reset
      if (ptyIdRef.current != null) void ipc.ptyWrite(ptyIdRef.current, "\x0c");
    },
    focus: () => termRef.current?.focus(),
  }));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const settings = getSettings();
    const term = new Terminal({
      allowProposedApi: true,
      scrollback: settings.scrollback,
      fontSize: settings.fontSize,
      fontFamily:
        "'SF Mono', Menlo, Monaco, 'JetBrains Mono', 'Fira Code', monospace",
      cursorBlink: true,
      macOptionIsMeta: true,
      theme: {
        background: "#16161e",
        foreground: "#c9d1d9",
        cursor: "#c9d1d9",
        selectionBackground: "#33467c",
      },
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new SerializeAddon());
    term.open(el);

    // WebGL renderer for throughput; xterm 6 falls back to the DOM renderer
    // if WebGL is unavailable or the context is lost (canvas addon is gone in 6.x).
    if (settings.webgl) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // DOM renderer remains active
      }
    }

    fit.fit();

    let disposed = false;
    let unlistenExit: (() => void) | undefined;

    void ipc
      .ptySpawn(
        {
          cols: term.cols,
          rows: term.rows,
          cwd,
          highWater: settings.ptyHighWater,
        },
        (bytes) => {
          // Feed xterm's own write buffer and ack once it has consumed the
          // chunk — this drives the Rust-side backpressure window. Never
          // accumulate output in JS. (Read the ref inside the callback: early
          // chunks can arrive before the spawn promise resolves.)
          term.write(bytes, () => {
            if (ptyIdRef.current != null) {
              void ipc.ptyAck(ptyIdRef.current, bytes.length);
            }
          });
        },
      )
      .then(async (result) => {
        if (disposed) {
          void ipc.ptyKill(result.id);
          return;
        }
        ptyIdRef.current = result.id;
        onSpawned(result.id);
        if (initialCommand) {
          void ipc.ptyWrite(result.id, `${initialCommand}\r`);
        }
        unlistenExit = await ipc.onPtyExit((e) => {
          if (e.id === result.id) onExited(e.exit_code);
        });
      })
      .catch((err) => {
        term.writeln(`\r\n\x1b[31mfailed to spawn shell: ${err}\x1b[0m`);
      });

    const dataSub = term.onData((data) => {
      if (ptyIdRef.current != null) void ipc.ptyWrite(ptyIdRef.current, data);
    });
    const titleSub = term.onTitleChange((title) => {
      onTitle?.(title);
      if (ptyIdRef.current != null) void ipc.ptySetTitle(ptyIdRef.current, title);
    });

    // Debounced resize: fit() locally, then tell the PTY so the child gets
    // a matching SIGWINCH.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (el.clientWidth === 0 || el.clientHeight === 0) return;
        fit.fit();
        if (ptyIdRef.current != null) {
          void ipc.ptyResize(ptyIdRef.current, term.cols, term.rows);
        }
      }, 50);
    });
    observer.observe(el);

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      observer.disconnect();
      dataSub.dispose();
      titleSub.dispose();
      unlistenExit?.();
      if (ptyIdRef.current != null) void ipc.ptyKill(ptyIdRef.current);
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (active) termRef.current?.focus();
  }, [active]);

  return <div className="term-container" ref={containerRef} />;
});

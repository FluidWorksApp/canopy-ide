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

    // No WebGL renderer. @xterm/addon-webgl 0.19.0 corrupts rendering on
    // WKWebView/macOS: a stale texture binding after an atlas page swap makes
    // the GPU sample the wrong page, so xterm's buffer is correct while the
    // screen shows ghosts, stale glyphs or blanked rows. It masquerades as
    // broken keyboard input — a character is deleted but never repaints, so
    // arrow keys look like they destroy the line. See xtermjs/xterm.js#5847
    // (Tauri + WKWebView + Retina — our exact stack) and #5816. Fixed by PR
    // #5883, but that is beta-only: addon-webgl 0.20.0-beta peers on xterm
    // 6.1.0-beta, so taking it means moving the whole core onto betas. Not
    // worth it to speed up a shell prompt — xterm 6's DOM renderer is correct.
    // Deleted rather than made a setting: stored settings win over DEFAULTS, so
    // a `webgl: false` default would silently do nothing for existing users.

    // macOS natural text editing — the same mapping iTerm2 ships under that name.
    //
    // xterm.js's defaults are wrong for a Mac shell, and actively destructive.
    // From its own Keyboard.ts, with `modifiers = alt?2 | meta?8`:
    //   Option+Arrow  -> ESC[1;3D / ESC[1;3C
    //   Option/Cmd+Del -> ESC[3;3~ / ESC[3;9~
    //   Cmd+Arrow     -> nothing at all (`if (ev.metaKey) break`), and the
    //                    un-cancelled event then reaches the WebView, which
    //                    applies macOS text editing to xterm's hidden textarea.
    // zsh binds NONE of those CSI forms (`bindkey "^[[1;3D"` => undefined-key).
    // Given one, zle discards the part it matched and SELF-INSERTS the rest, so
    // Option+Left literally types "3D" into your command. Verified against a
    // real login zsh: each sequence below does exactly what its name says.
    //
    // Deliberately absent: Option+Backspace. xterm already sends ESC+DEL for it
    // (case 8), which zsh binds to backward-kill-word — it works, so leave it.
    //
    // These MUST go through term.input(). It feeds xterm's own ordered input
    // path (-> onData -> the single ptyWrite stream), keeping them in sequence
    // with typed characters. Writing to the PTY directly from here opens a
    // second, racing channel: the bytes then land wherever they land, which is
    // how an earlier attempt at this ended up typing "^E^E" into the prompt.
    const NATURAL_EDIT: Record<string, string> = {
      "alt+ArrowLeft": "\x1bb", // backward-word
      "alt+ArrowRight": "\x1bf", // forward-word
      "alt+Delete": "\x1bd", // kill-word (forward)
      "meta+ArrowLeft": "\x01", // beginning-of-line  (C-a)
      "meta+ArrowRight": "\x05", // end-of-line        (C-e)
      // C-u. NB: in zsh this is kill-whole-line, NOT bash's backward-kill-line
      // — it clears the entire line, not just the part before the cursor. zsh
      // binds nothing to backward-kill-line, so there is no closer match; iTerm2
      // sends C-u here too and inherits the same behaviour.
      "meta+Backspace": "\x15",
      "meta+Delete": "\x0b", // kill-line          (C-k)
    };
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown" || ev.ctrlKey) return true;
      // Only claim the combos above: Cmd+C/V/T/W and Option+letter (accents,
      // and Meta-prefixed keys via macOptionIsMeta) must keep their meaning.
      const mod = ev.metaKey ? "meta" : ev.altKey ? "alt" : null;
      const seq = mod && NATURAL_EDIT[`${mod}+${ev.key}`];
      if (!seq) return true;
      ev.preventDefault();
      term.input(seq);
      return false;
    });

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

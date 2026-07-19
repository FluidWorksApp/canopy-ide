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
import "@xterm/xterm/css/xterm.css";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as ipc from "../ipc";
import { getSettings } from "../settings";
import { xtermTheme } from "../themes";

/** Quote a dropped path for the shell, the way iTerm2/Terminal.app do. Paths
 *  that are pure safe chars pass through bare; anything else is single-quoted,
 *  which neutralizes every shell metacharacter except the quote itself. */
const SAFE_PATH = /^[A-Za-z0-9_\-./~+@%:=,]+$/;
const shellQuote = (p: string) =>
  SAFE_PATH.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`;

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
  /** The program in this terminal asked for attention — see the OSC handlers. */
  onNotify?: (message: string) => void;
}

export const Term = forwardRef<TermHandle, TermProps>(function Term(
  { cwd, active, initialCommand, onSpawned, onExited, onTitle, onNotify },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const ptyIdRef = useRef<number | null>(null);
  /** Repaint + size-sync immediately (no debounce); set by the mount effect. */
  const syncNowRef = useRef<(() => void) | null>(null);
  // Mirrored so the mount-once drop listener can see the current value.
  const activeRef = useRef(active);
  activeRef.current = active;

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
      theme: xtermTheme(),
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    // Links must go through the OS, not window.open(): WKWebView has no popup
    // support, so the addon's default handler gets null back from window.open()
    // and the click dies silently. The opener plugin's default scope already
    // allows http/https, which is all the addon's URL matcher produces.
    term.loadAddon(new WebLinksAddon((_event, uri) => void openUrl(uri)));
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
    // Movement widgets plus exactly ONE kill: Cmd+Delete. An earlier version
    // mapped several kill widgets (ESC d, C-k, C-u) and one was mis-keyed —
    // on a Mac the key labelled "delete" reports key="Backspace", while
    // key="Delete" is fn+delete — so a destructive sequence sat armed on a
    // key nobody meant to press, and all of them were removed. Cmd+Delete
    // comes back keyed to the name the key actually reports, verified above.
    // fn+delete ("Delete") stays unmapped on purpose. The sequence is C-u,
    // what iTerm2's natural preset sends for Cmd+Delete; zsh's emacs mode
    // reads it as kill-whole-line (bash: to line start) — the accepted
    // terminal meaning of the chord. Option+Backspace needs no entry: xterm
    // itself sends ESC+DEL, which zsh binds to backward-kill-word.
    const NATURAL_EDITING: Record<string, string> = {
      "alt+ArrowLeft": "\x1bb", // backward-word
      "alt+ArrowRight": "\x1bf", // forward-word
      "meta+ArrowLeft": "\x01", // beginning-of-line (C-a)
      "meta+ArrowRight": "\x05", // end-of-line       (C-e)
      "meta+Backspace": "\x15", // kill line         (C-u)
    };
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown" || ev.ctrlKey) return true;
      // Never touch a key that is mid-composition. Option+letter starts a dead
      // key on a US layout (Option+e = acute), and WebKit then reports a
      // collapsed, length-2 ev.key and stops honouring preventDefault. Bailing
      // lets xterm's own dead-key handling run — it is downstream of this
      // handler, so returning false here would skip it and strand the
      // composition, making the next keypress behave as if Option were held.
      if (ev.isComposing || ev.keyCode === 229) return true;
      // Only named keys (arrows, Backspace), and only with exactly one of
      // Cmd/Option. `ev.key` for those is always a multi-char name, so a
      // composed character can never collide with these entries.
      if (ev.altKey === ev.metaKey) return true;
      const seq = NATURAL_EDITING[`${ev.metaKey ? "meta" : "alt"}+${ev.key}`];
      if (!seq) return true;
      ev.preventDefault();
      term.input(seq);
      return false;
    });

    // The pty owns the size; this only proposes one.
    //
    // fit.fit() resizes the grid locally and tells the pty afterwards, which
    // means the two disagree for a moment on every resize — and the shell lays
    // its line out against the pty's winsize, so during that window a redraw
    // wraps at the wrong column and smears. Worse, a terminal mounted in a
    // hidden tab (every inactive tab is display:none) measures nothing:
    // proposeDimensions returns NaN, and `NaN < 10` is false, so the obvious
    // guard doesn't catch it.
    //
    // So: propose -> pty applies and reports back -> resize the grid to that.
    // One authority, and a hidden tab simply proposes nothing.
    const propose = (): { cols: number; rows: number } | null => {
      const d = fit.proposeDimensions();
      if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return null;
      if (d.cols < 1 || d.rows < 1) return null;
      return { cols: d.cols, rows: d.rows };
    };
    const applyGeometry = (g: { cols: number; rows: number }) => {
      if (term.cols !== g.cols || term.rows !== g.rows) term.resize(g.cols, g.rows);
    };

    // Becoming visible again needs an explicit repaint. While the tab is
    // display:none the renderer drops its painted cells, and nothing on the
    // way back triggers a redraw by itself: the ResizeObserver path only
    // repaints when the grid size actually *changed*, which on a plain tab
    // switch it didn't. Without this, the buffer stays blank until the
    // program in the terminal happens to emit output (an agent's spinner, a
    // prompt repaint) — the "blank for a second or two" on every switch.
    // Size sync rides along so a resize that happened while hidden is also
    // corrected now rather than on the debounced observer.
    syncNowRef.current = () => {
      const next = propose();
      if (next) {
        if (ptyIdRef.current == null) {
          applyGeometry(next);
        } else if (next.cols !== term.cols || next.rows !== term.rows) {
          void ipc
            .ptyResize(ptyIdRef.current, next.cols, next.rows)
            .then(applyGeometry)
            .catch(() => {});
        }
      }
      term.refresh(0, term.rows - 1);
    };

    const initial = propose();

    let disposed = false;
    let unlistenExit: (() => void) | undefined;

    void ipc
      .ptySpawn(
        {
          // 0 tells Rust to fall back to 80x24; the first resize once the tab is
          // visible corrects it.
          cols: initial?.cols ?? 0,
          rows: initial?.rows ?? 0,
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
        // Adopt whatever the pty opened at, including the 80x24 fallback when we
        // proposed nothing — better a grid that matches the shell than one that
        // looks right and wraps wrong.
        applyGeometry(result);
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

    // Desktop notifications, straight out of the byte stream.
    //
    // This is how a terminal program says "I need you" — and it costs nothing
    // per agent, because the agent CLIs already emit these. Anything that can
    // write to a tty gets it for free: `printf '\e]9;done\a'` from a shell
    // script raises the same signal claude does. The alternative — teaching the
    // app about each agent's output format — would need per-agent parsing that
    // breaks whenever one of them changes a string.
    //
    // Three spellings of the same idea, none standard:
    //   OSC 9  ;<body>                 iTerm2 / Windows Terminal
    //   OSC 777;notify;<title>;<body>  urxvt, adopted by kitty and others
    //   OSC 99 ;<meta>;<body>          kitty's own, which chunks long bodies
    // Return false so the sequence still reaches the renderer: swallowing it
    // would suppress whatever else a program layers on the same OSC.
    const oscSubs = [
      term.parser.registerOscHandler(9, (data) => {
        const body = data.trim();
        if (body) onNotify?.(body);
        return false;
      }),
      term.parser.registerOscHandler(777, (data) => {
        // notify;<title>;<body> — the body is optional, so fall back to title.
        const parts = data.split(";");
        if (parts[0] !== "notify") return false;
        const body = (parts[2] ?? parts[1] ?? "").trim();
        if (body) onNotify?.(body);
        return false;
      }),
      term.parser.registerOscHandler(99, (data) => {
        // <metadata>:<body>. Kitty splits long bodies across several sequences
        // keyed by an id; we take the payload as-is rather than reassemble --
        // a truncated first chunk is still a usable "look at me".
        const body = data.split(";").slice(1).join(";").trim();
        if (body) onNotify?.(body);
        return false;
      }),
    ];

    // OS file drops. Tauri intercepts these at the native layer (dragDropEnabled
    // defaults on), so the HTML5 drop event never fires in the webview and the
    // only way to receive a dropped file is this event. It is window-global —
    // every Term hears every drop — so exactly one may act: the active one
    // (there is one per app: visible project x active tab). Routed through
    // term.paste(), which takes xterm's ordered input path (like the key
    // handler above) and wraps the text in bracketed-paste markers, so zsh and
    // TUIs treat it as pasted text rather than typed keystrokes.
    let unlistenDrop: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        if (e.payload.type !== "drop" || !activeRef.current) return;
        const paths = e.payload.paths;
        if (!paths.length) return;
        term.paste(paths.map(shellQuote).join(" ") + " ");
        term.focus();
      })
      .then((un) => {
        if (disposed) un();
        else unlistenDrop = un;
      });

    // Live appearance changes: theme flips repaint every terminal in place,
    // font-size changes also need the grid re-measured (cell metrics change),
    // which syncNow's propose→pty→apply path already does.
    const onAppearance = () => {
      term.options.theme = xtermTheme();
      const size = getSettings().fontSize;
      if (term.options.fontSize !== size) {
        term.options.fontSize = size;
      }
      syncNowRef.current?.();
    };
    window.addEventListener("canopy:appearance", onAppearance);

    // Debounced resize: propose, let the pty apply it and SIGWINCH the child,
    // then match the grid to what it confirmed. A hidden tab proposes nothing
    // and is left alone until it is shown, which fires this again.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const next = propose();
        if (!next) return;
        if (ptyIdRef.current == null) {
          // Still spawning; the size we asked for is already in flight.
          applyGeometry(next);
          return;
        }
        void ipc
          .ptyResize(ptyIdRef.current, next.cols, next.rows)
          .then(applyGeometry)
          .catch(() => {
            // The pty is gone (exited between the observer firing and this
            // call). Nothing to keep in sync with.
          });
      }, 50);
    });
    observer.observe(el);

    return () => {
      disposed = true;
      window.removeEventListener("canopy:appearance", onAppearance);
      clearTimeout(resizeTimer);
      observer.disconnect();
      dataSub.dispose();
      titleSub.dispose();
      oscSubs.forEach((s) => s.dispose());
      unlistenDrop?.();
      unlistenExit?.();
      if (ptyIdRef.current != null) void ipc.ptyKill(ptyIdRef.current);
      syncNowRef.current = null;
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active) return;
    termRef.current?.focus();
    // One frame so display:block has landed and the container measures; then
    // repaint the buffer that went blank while the tab was hidden.
    const raf = requestAnimationFrame(() => syncNowRef.current?.());
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return <div className="term-container" ref={containerRef} />;
});

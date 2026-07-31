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
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openLink } from "../links";
import * as ipc from "../ipc";
import { getSettings, THEME_CHANGE_EVENT, type Settings } from "../settings";
import { terminalTheme } from "../terminalThemes";
import { createLinkHint, opensLink } from "../terminalLinks";
import { matchesChord, resolve } from "../shortcuts";

/** Quote a dropped path for the shell, the way iTerm2/Terminal.app do. Paths
 *  that are pure safe chars pass through bare; anything else is single-quoted,
 *  which neutralizes every shell metacharacter except the quote itself. */
const SAFE_PATH = /^[A-Za-z0-9_\-./~+@%:=,]+$/;
const shellQuote = (p: string) =>
  SAFE_PATH.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`;

/** The active skin's terminal palette, with the user's accent substituted in
 *  when they set one. Always fully opaque: xterm's DOM renderer paints cell
 *  backgrounds, and a transparent background makes a cleared cell show
 *  whatever was beneath it — which reads as "delete did nothing". */
function themeFor(settings: Settings) {
  return terminalTheme(settings.theme, settings.customAccent);
}

export interface TermHandle {
  clearScrollback: () => void;
  hardReset: () => void;
  focus: () => void;
  /** The text currently selected in the terminal, "" when none. */
  getSelection: () => string;
  /** The scrollback as plain text, keeping the newest `maxChars`. Plain rather
   *  than ANSI on purpose: this is read back in the task-history pane, not
   *  replayed into a terminal, so escape sequences would only be noise. */
  captureText: (maxChars?: number) => string;
}

interface TermProps {
  cwd?: string;
  active: boolean;
  /** Typed into the shell right after spawn (e.g. launch an agent CLI). */
  initialCommand?: string;
  /** A run tab's one-shot command: the shell is spawned to run it and exit with
   *  its status (native, per-shell), rather than typing it in. Mutually
   *  exclusive with initialCommand. */
  runCommand?: string;
  /** Stamped onto the child at spawn. A run inside a workspace carries that
   *  workspace's port lease here, which is what lets two checkouts of the same
   *  repo serve at once instead of losing the race for one hard-coded port. */
  env?: [string, string][];
  /** Attach to an already-running PTY (spawned headless from the remote portal)
   *  instead of spawning a fresh one. The tab mirrors that session's live
   *  output and drives its input; closing the tab detaches, it does not kill the
   *  agent (it stays controllable from the phone). */
  attachId?: number;
  onSpawned: (ptyId: number) => void;
  onExited: (exitCode: number | null) => void;
  onTitle?: (title: string) => void;
  /** The program in this terminal asked for attention — see the OSC handlers. */
  onNotify?: (message: string) => void;
}

export const Term = forwardRef<TermHandle, TermProps>(function Term(
  { cwd, active, initialCommand, runCommand, env, attachId, onSpawned, onExited, onTitle, onNotify },
  ref,
) {
  // Frozen once: a Term never switches between spawn and attach mid-life, and
  // the mount-once effect closes over it.
  const attachIdRef = useRef(attachId);
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
    getSelection: () => termRef.current?.getSelection() ?? "",
    captureText: (maxChars = 8000) => {
      const term = termRef.current;
      if (!term) return "";
      // Whichever screen the CLI is actually on. For an inline agent (claude,
      // which micro-tasks prefer) that's the normal buffer and this really is
      // the tail of the run. For a full-TUI agent on the alternate screen there
      // is no scrollback to have: that buffer is one screenful, so what gets
      // stored is the final frame. Deliberately not falling back to
      // `buffer.normal` there — it holds what was on screen *before* the CLI
      // took over, which is the shell prompt, and that is worse than the frame.
      const buf = term.buffer.active;
      const lines: string[] = [];
      // Walk backwards and stop once we have enough: the scrollback is up to
      // `scrollback` rows (10k by default) and a finished task only needs its
      // ending, so reading the whole buffer to throw most of it away would be
      // the expensive way round.
      let chars = 0;
      for (let i = buf.length - 1; i >= 0 && chars < maxChars; i--) {
        // `true` trims trailing whitespace — xterm pads every row to the full
        // terminal width, so without it each line arrives with ~80 spaces.
        const line = buf.getLine(i)?.translateToString(true) ?? "";
        lines.push(line);
        chars += line.length + 1;
      }
      // The tail of an agent's run is typically preceded by a screenful of
      // blank rows; dropping them keeps the stored transcript to what was said.
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      return lines.reverse().join("\n").trimStart().slice(-maxChars);
    },
  }));

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const settings = getSettings();
    const term = new Terminal({
      allowProposedApi: true,
      scrollback: settings.scrollback,
      fontSize: settings.fontSize,
      fontFamily: settings.terminalFontFamily,
      cursorStyle: settings.terminalCursorStyle,
      cursorBlink: settings.terminalCursorBlink,
      macOptionIsMeta: true,
      theme: themeFor(settings),
    });
    termRef.current = term;

    // Everything else recolors for free via CSS custom properties when the
    // skin changes; xterm renders its own surface and needs the theme object
    // pushed explicitly. Reassigning .options.theme repaints immediately — no
    // remount, no fresh PTY, the running shell/agent is untouched.
    const onThemeChange = () => {
      const next = getSettings();
      term.options.theme = themeFor(next);
      // Font and cursor used to apply only to newly opened terminals. That is
      // worse than it sounds: an open terminal kept a grid measured for the
      // OLD font while everything else re-rendered, which is precisely the
      // mismatch above. Apply them here and re-measure.
      const metricsChanged =
        term.options.fontFamily !== next.terminalFontFamily ||
        term.options.fontSize !== next.fontSize;
      term.options.fontFamily = next.terminalFontFamily;
      term.options.fontSize = next.fontSize;
      term.options.cursorStyle = next.terminalCursorStyle;
      term.options.cursorBlink = next.terminalCursorBlink;
      if (metricsChanged) syncNowRef.current?.();
    };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    // Links must go through the OS, not window.open(): WKWebView has no popup
    // support, so the addon's default handler gets null back from window.open()
    // and the click dies silently. The opener plugin's default scope already
    // allows http/https, which is all the addon's URL matcher produces.
    //
    // A bare click by default, ⌘-click if Settings → Terminal says so — see
    // terminalLinks.ts, and for the hint that keeps a hovered link from looking
    // like a dead one. A gesture that isn't a follow falls through untouched:
    // xterm's link handling is additive, so selecting and focusing still behave
    // as they always did. The mode is read here, per event, so changing it
    // reaches terminals that are already open.
    const linkMode = () => getSettings().terminalLinkClick;
    const linkHint = createLinkHint(el, linkMode);
    term.loadAddon(
      new WebLinksAddon(
        (event, uri) => {
          if (!opensLink(event, linkMode(), term.hasSelection())) return;
          linkHint.hide();
          // Same route as every other link in the app — a dev server printing
          // its address is the case the in-app browser was built for.
          openLink(uri);
        },
        { hover: (event) => linkHint.show(event), leave: () => linkHint.hide() },
      ),
    );
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

    // Natural text editing — on a Mac, the same mapping iTerm2 ships under
    // that name; off it, only the parts that make sense without a Cmd key.
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
    //
    // The chords come from the registry, which is what keeps this map from
    // shipping macOS semantics to everyone. The three Cmd-based entries are
    // unbound off a Mac (see shared/shortcuts.json): there is no Command key
    // there — Mod resolves to Ctrl, where Ctrl+Left already means word-jump,
    // and Super belongs to the window manager. Home/End cover line start/end
    // on those platforms natively. The Option ones stay: ESC-b/ESC-f is what
    // readline binds to word movement on every platform.
    const NATURAL_EDITING = (
      [
        ["term-word-left", "\x1bb"], // backward-word
        ["term-word-right", "\x1bf"], // forward-word
        ["term-line-start", "\x01"], // beginning-of-line (C-a)
        ["term-line-end", "\x05"], // end-of-line       (C-e)
        ["term-kill-line", "\x15"], // kill line         (C-u)
      ] as const
    ).flatMap(([id, seq]) => {
      const chord = resolve(id);
      return chord && chord.code ? [{ chord, seq }] : [];
    });
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      // Never touch a key that is mid-composition. Option+letter starts a dead
      // key on a US layout (Option+e = acute), and WebKit then reports a
      // collapsed, length-2 ev.key and stops honouring preventDefault. Bailing
      // lets xterm's own dead-key handling run — it is downstream of this
      // handler, so returning false here would skip it and strand the
      // composition, making the next keypress behave as if Option were held.
      if (ev.isComposing || ev.keyCode === 229) return true;
      // Every modifier flag must agree, so a composed character can never
      // collide with these entries and Option+Cmd+Left matches nothing.
      const hit = NATURAL_EDITING.find(({ chord }) => matchesChord(ev, chord));
      if (!hit) return true;
      ev.preventDefault();
      term.input(hit.seq);
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
    // Below this, a measurement is an artifact of being taken mid-layout, not
    // a terminal anyone asked for. Pushing one to the pty makes the child
    // re-wrap its output at that width, and everything it prints before the
    // size is corrected stays shredded in the scrollback forever — the damage
    // outlives the bad measurement, which is why this reads as random
    // corruption rather than a momentarily narrow terminal.
    const MIN_COLS = 20;
    const MIN_ROWS = 4;
    const propose = (): { cols: number; rows: number } | null => {
      const d = fit.proposeDimensions();
      if (!d || !Number.isFinite(d.cols) || !Number.isFinite(d.rows)) return null;
      if (d.cols < MIN_COLS || d.rows < MIN_ROWS) return null;
      return { cols: d.cols, rows: d.rows };
    };
    const applyGeometry = (g: { cols: number; rows: number }) => {
      if (term.cols !== g.cols || term.rows !== g.rows) term.resize(g.cols, g.rows);
    };
    let disposed = false;

    // Becoming visible again needs an explicit repaint. While the tab is
    // display:none the renderer drops its painted cells, and nothing on the
    // way back triggers a redraw by itself: the ResizeObserver path only
    // repaints when the grid size actually *changed*, which on a plain tab
    // switch it didn't. Without this, the buffer stays blank until the
    // program in the terminal happens to emit output (an agent's spinner, a
    // prompt repaint) — the "blank for a second or two" on every switch.
    // Size sync rides along so a resize that happened while hidden is also
    // corrected now rather than on the debounced observer.
    const pushGeometry = (next: { cols: number; rows: number }) => {
      if (ptyIdRef.current == null) {
        applyGeometry(next);
      } else if (next.cols !== term.cols || next.rows !== term.rows) {
        void ipc
          .ptyResize(ptyIdRef.current, next.cols, next.rows)
          .then(applyGeometry)
          .catch(() => {});
      }
    };

    // Repaint now, but never resize off a single measurement.
    //
    // Every caller of this runs at a moment when the layout may still be
    // settling — the biggest being a tab switch, where the container flips
    // from display:none and the panel group has not necessarily applied its
    // final widths yet. One frame is not enough to guarantee it has, so the
    // old code could measure a container that was briefly a fraction of its
    // real width, SIGWINCH the running child with it, and shred the output of
    // whatever was mid-command. It self-corrected 50ms later via the observer,
    // which is exactly why it looked intermittent and unreproducible.
    //
    // So: take two measurements a frame apart and only push if they agree. A
    // settling layout disagrees and we defer to the ResizeObserver, which is
    // debounced and measures once things are stable anyway. The repaint — the
    // part a tab switch actually needs, to refill a buffer blanked while
    // hidden — still happens immediately.
    syncNowRef.current = () => {
      term.refresh(0, term.rows - 1);
      const first = propose();
      if (!first) return;
      requestAnimationFrame(() => {
        if (disposed) return;
        const second = propose();
        if (!second) return;
        if (second.cols !== first.cols || second.rows !== first.rows) return;
        pushGeometry(second);
      });
    };

    const initial = propose();
    // Cell size is a function of the font, and a font resolves
    // asynchronously — the first proposeDimensions() above can be measured
    // against a fallback face. If the real font is even slightly wider or
    // narrower, xterm keeps the columns it computed while the glyphs render
    // at a different width, so the shell wraps and redraws against a column
    // the terminal no longer agrees with. That is what "backspace deletes
    // nothing, and the line vanishes when I press right" actually is: the
    // redraw is landing in the wrong place, not the keys failing. Re-measure
    // once the fonts are ready and push the corrected size to the pty.
    void document.fonts?.ready
      .then(() => {
        if (!disposed) syncNowRef.current?.();
      })
      .catch(() => {});

    // The same drift has other routes in: moving the window to a display with
    // a different pixel ratio changes the measured cell size, and waking from
    // sleep can leave a stale measurement behind. xterm does not re-measure on
    // its own, and nothing resizes the container, so the ResizeObserver never
    // fires — the grid quietly stops matching the pty and every mid-line
    // redraw lands in the wrong column until the terminal is recreated.
    // Re-checking when the window regains focus is cheap: syncNow only talks
    // to the pty when the numbers actually differ.
    const onFocus = () => {
      if (activeRef.current) syncNowRef.current?.();
    };
    window.addEventListener("focus", onFocus);
    let unlistenExit: (() => void) | undefined;

    // Once the pty (fresh or attached) is bound: adopt its grid, wire exit, and
    // announce the id. Shared by both paths below so they stay in lock-step.
    const bound = async (id: number, geom: { cols: number; rows: number }) => {
      ptyIdRef.current = id;
      applyGeometry(geom);
      onSpawned(id);
      unlistenExit = await ipc.onPtyExit((e) => {
        if (e.id === id) onExited(e.exit_code);
      });
    };

    if (attachIdRef.current != null) {
      // Attach path: mirror a headless PTY the portal spawned. No ack — a
      // headless session fans out over a lossy broadcast and never applies
      // WebView backpressure — and no initial command (the portal already sent
      // it). The scrollback snapshot arrives first, then the live tail.
      const id = attachIdRef.current;
      void ipc
        .ptyAttach(id, (bytes) => {
          if (!disposed) term.write(bytes);
        })
        .then((geom) => {
          if (disposed) return; // detach only; never kill a remote-owned agent
          void bound(id, geom);
        })
        .catch((err) => {
          term.writeln(`\r\n\x1b[31mfailed to attach: ${err}\x1b[0m`);
        });
    } else {
      void ipc
        .ptySpawn(
          {
            // 0 tells Rust to fall back to 80x24; the first resize once the tab is
            // visible corrects it.
            cols: initial?.cols ?? 0,
            rows: initial?.rows ?? 0,
            cwd,
            highWater: settings.ptyHighWater,
            runCommand,
            env,
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
          // Adopt whatever the pty opened at, including the 80x24 fallback when
          // we proposed nothing — better a grid that matches the shell than one
          // that looks right and wraps wrong.
          await bound(result.id, result);
          // A run tab's command was handed to the shell at spawn (runCommand),
          // so it's already executing — only a typed initialCommand needs sending.
          if (initialCommand && !runCommand) {
            void ipc.ptyWrite(result.id, `${initialCommand}\r`);
          }
        })
        .catch((err) => {
          term.writeln(`\r\n\x1b[31mfailed to spawn shell: ${err}\x1b[0m`);
        });
    }

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
    //
    // The WINDOW, not the webview. Tauri picks the target by how many webviews
    // the window has: one, and the drop goes to `AnyLabel` (which every kind of
    // listener matches); more than one, and it goes to the `Window` target,
    // which a webview listener does not match at all. Opening a preview adds a
    // second webview — so a webview listener here meant that dropping a file
    // onto ANY terminal, in ANY project, silently did nothing for as long as a
    // browser tab existed anywhere in the window. A window listener is correct
    // in both states.
    let unlistenDrop: (() => void) | undefined;
    void getCurrentWindow()
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

    // Dictated text. Same contract as the drop handler above: the event is
    // window-global, exactly one Term — the active one — may act, and the
    // text goes through term.paste() so bracketed-paste applies.
    const onDictationText = (e: Event) => {
      if (!activeRef.current) return;
      const text = (e as CustomEvent).detail as string;
      if (!text) return;
      term.paste(text);
      term.focus();
    };
    window.addEventListener("canopy:dictation-text", onDictationText);

    // Debounced resize: propose, let the pty apply it and SIGWINCH the child,
    // then match the grid to what it confirmed. A hidden tab proposes nothing
    // and is left alone until it is shown, which fires this again.
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        // Already stable by construction: 50ms of quiet since the last size
        // change. The pty may also be gone by now (exited between the observer
        // firing and this call); pushGeometry swallows that.
        const next = propose();
        if (next) pushGeometry(next);
      }, 50);
    });
    observer.observe(el);

    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      observer.disconnect();
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("canopy:dictation-text", onDictationText);
      linkHint.dispose();
      dataSub.dispose();
      titleSub.dispose();
      oscSubs.forEach((s) => s.dispose());
      unlistenDrop?.();
      unlistenExit?.();
      // Attached tabs detach on close — the agent was spawned from the phone and
      // stays alive and controllable there. Only a tab that OWNS its pty kills it.
      if (attachIdRef.current == null && ptyIdRef.current != null) {
        void ipc.ptyKill(ptyIdRef.current);
      }
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

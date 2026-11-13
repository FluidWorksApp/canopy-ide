// One place decides which engine a terminal tab runs on.
//
//   ghostty  our engine: canopy-term-core (libghostty-vt) compiled to wasm,
//            the same parser and screen the native Canopy Terminal uses.
//   xterm    xterm.js, the engine every release up to 0.5.14 used.
//
// Ghostty is the default. A terminal falls back to xterm, with a reason the
// developer overlay shows, when the user chose xterm in Settings, when the
// engine could not be loaded in this webview, or after it failed once in
// this session.
import { Terminal, type ILinkHandler, type ILinkProvider, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { trackMouseEncoding } from "../../packages/remote-host/terminal-mouse-modes.mjs";
import { ghosttyFailure, ghosttyReady, loadGhostty } from "./ghostty/engine";
import { GhosttyTerminal, type WebLinkHandler } from "./ghostty/GhosttyTerminal";
import { ResilientTerminal, type XtermBundle } from "./resilient";
import { newStats, trackStats, type TerminalStats } from "./stats";
import wasmUrl from "./pkg/canopy_term_wasm_bg.wasm?url";

export type TerminalEngine = "ghostty" | "xterm";
export type { TerminalStats } from "./stats";
export { liveStats } from "./stats";
export { ghosttyFailure, ghosttyMemoryBytes, ghosttyReady } from "./ghostty/engine";

interface Disposable {
  dispose(): void;
}
type Listen<T> = (listener: (arg: T) => void) => Disposable;

/** What a terminal tab needs from its engine: the part of xterm.js's Terminal
 *  the app uses. Both engines provide exactly this. */
export interface TermLike {
  readonly cols: number;
  readonly rows: number;
  readonly element: HTMLElement | undefined;
  readonly textarea: HTMLTextAreaElement | undefined;
  options: {
    theme?: ITheme;
    fontSize?: number;
    fontFamily?: string;
    cursorStyle?: "block" | "underline" | "bar";
    cursorBlink?: boolean;
    linkHandler?: ILinkHandler | null;
  };
  readonly buffer: {
    readonly active: {
      readonly length: number;
      readonly viewportY: number;
      readonly baseY: number;
      getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
    readonly normal: { readonly length: number };
    readonly alternate: { readonly length: number };
    onBufferChange(listener: () => void): Disposable;
  };
  readonly modes: { readonly mouseTrackingMode: string };
  readonly parser: {
    registerOscHandler(
      id: number,
      handler: (data: string) => boolean | Promise<boolean>,
    ): Disposable;
  };
  onData: Listen<string>;
  onBinary: Listen<string>;
  onTitleChange: Listen<string>;
  onResize: Listen<{ cols: number; rows: number }>;
  onWriteParsed(listener: () => void): Disposable;
  open(parent: HTMLElement): void;
  write(data: string | Uint8Array, callback?: () => void): void;
  writeln(data: string | Uint8Array, callback?: () => void): void;
  input(data: string, wasUserInput?: boolean): void;
  paste(text: string): void;
  focus(): void;
  reset(): void;
  clear(): void;
  resize(cols: number, rows: number): void;
  refresh(start: number, end: number): void;
  hasSelection(): boolean;
  getSelection(): string;
  selectAll(): void;
  clearSelection(): void;
  scrollToLine(line: number): void;
  scrollToBottom(): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
  registerLinkProvider(provider: ILinkProvider): Disposable;
  dispose(): void;
}

export interface CreateTerminalOptions {
  /** The engine the user chose in Settings. */
  engine: TerminalEngine;
  scrollback: number;
  fontSize?: number;
  fontFamily?: string;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  macOptionIsMeta?: boolean;
  macOptionClickForcesSelection?: boolean;
  minimumContrastRatio?: number;
  disableStdin?: boolean;
  theme?: ITheme;
  /** URLs written out in the text. */
  webLinks?: WebLinkHandler;
}

export interface CreatedTerminal {
  term: TermLike;
  /** The engine this terminal runs on right now. */
  readonly engine: TerminalEngine;
  /** Why that is not the chosen engine ("" when it is). A short code. */
  readonly fallback: string;
  stats: TerminalStats;
  fit: { proposeDimensions(): { cols: number; rows: number } | undefined };
  serializer: { serialize(options?: { scrollback?: number }): string };
  /** Serialising with the mouse report encoding kept, and forgetting it. */
  mouseModes: {
    reset(): void;
    serialize(
      serializer: { serialize(options?: { scrollback?: number }): string },
      options?: { scrollback?: number },
    ): string;
    dispose(): void;
  };
  /** Neither engine could draw this terminal: it shows nothing further. */
  onEngineFailure(listener: (reason: string) => void): Disposable;
}

/** Load the Ghostty engine. Call once at startup. Resolves true when it is
 *  ready, false when it failed or `waitMs` passed first (it keeps loading:
 *  terminals opened once it is ready use it, earlier ones run on xterm). */
export function preloadTerminalEngine(waitMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), waitMs);
    void loadGhostty(wasmUrl).then((ready) => {
      clearTimeout(timer);
      resolve(ready);
    });
  });
}

export function createTerminal(options: CreateTerminalOptions): CreatedTerminal {
  let fallback = "";
  if (options.engine === "ghostty") {
    if (ghosttyReady()) {
      try {
        return createGhostty(options);
      } catch {
        fallback = "create-failed";
      }
    } else {
      fallback = ghosttyFailure() || "not-loaded";
    }
  }
  return createXterm(options, fallback);
}

function createGhostty(options: CreateTerminalOptions): CreatedTerminal {
  const ghostty = new GhosttyTerminal({
    scrollback: options.scrollback,
    fontSize: options.fontSize,
    fontFamily: options.fontFamily,
    cursorStyle: options.cursorStyle,
    cursorBlink: options.cursorBlink,
    macOptionIsMeta: options.macOptionIsMeta,
    macOptionClickForcesSelection: options.macOptionClickForcesSelection,
    minimumContrastRatio: options.minimumContrastRatio,
    disableStdin: options.disableStdin,
    theme: options.theme,
    webLinks: options.webLinks,
  });
  // If the engine ever fails beyond its own repair, the same tab carries on
  // with xterm (see ResilientTerminal).
  const term = new ResilientTerminal(ghostty, () => xtermBundle(options));
  return {
    term,
    get engine() {
      return term.engine;
    },
    get fallback() {
      return term.stats.fallback;
    },
    stats: term.stats,
    fit: term,
    serializer: term,
    mouseModes: term.mouseModes,
    onEngineFailure: (listener) => term.onEngineFailure(listener),
  };
}

function xtermBundle(options: CreateTerminalOptions): XtermBundle {
  const term = new Terminal({
    allowProposedApi: true,
    scrollback: options.scrollback,
    fontSize: options.fontSize,
    fontFamily: options.fontFamily,
    cursorStyle: options.cursorStyle,
    cursorBlink: options.cursorBlink,
    macOptionIsMeta: options.macOptionIsMeta,
    macOptionClickForcesSelection: options.macOptionClickForcesSelection,
    minimumContrastRatio: options.minimumContrastRatio,
    disableStdin: options.disableStdin,
    theme: options.theme,
  });
  const mouseModes = trackMouseEncoding(term);
  const fit = new FitAddon();
  term.loadAddon(fit);
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  const web = options.webLinks;
  if (web) {
    term.loadAddon(
      new WebLinksAddon((event, uri) => web.activate(event, uri), {
        hover: (event, uri) => web.hover?.(event, uri),
        leave: (event, uri) => web.leave?.(event, uri),
      }),
    );
  }
  return { term, fit, serializer, mouseModes };
}

function createXterm(options: CreateTerminalOptions, fallback: string): CreatedTerminal {
  const { term, fit, serializer, mouseModes } = xtermBundle(options);
  const stats = newStats("xterm", fallback);
  const untrack = trackStats(stats);
  // Numbers for the developer overlay; xterm does not report its own.
  const write = term.write.bind(term);
  term.write = (data: string | Uint8Array, callback?: () => void) => {
    stats.bytes += data.length;
    write(data, callback);
  };
  const sized = () => {
    stats.cols = term.cols;
    stats.rows = term.rows;
    stats.scrollbackRows = Math.max(0, term.buffer.normal.length - term.rows);
  };
  sized();
  const subscriptions = [term.onResize(sized), term.onWriteParsed(sized)];
  const dispose = term.dispose.bind(term);
  term.dispose = () => {
    untrack();
    for (const subscription of subscriptions) subscription.dispose();
    dispose();
  };
  return {
    term,
    engine: "xterm",
    fallback,
    stats,
    fit,
    serializer,
    mouseModes,
    onEngineFailure: () => ({ dispose() {} }),
  };
}

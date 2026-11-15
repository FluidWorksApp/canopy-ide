// A terminal tab on the Ghostty engine (canopy-term-core compiled to wasm):
// the engine parses the PTY stream and owns the screen and scrollback; this
// class feeds it, draws it on a canvas and turns keyboard, mouse and paste
// into the bytes the program expects.
//
// The public surface is the part of xterm.js's Terminal the app uses, with
// the same names and behaviour, so a tab can run on either engine.
import { classifyTrap, failGhostty, WasmTerminal } from "./engine";
import {
  EMPTY_LINE,
  WORDS,
  lineCols,
  lineText,
  lineVt,
  lineWraps,
  textColumns,
  type Line,
} from "./cells";
import { keyArgs, MOD_ALT, MOD_CTRL, MOD_SHIFT } from "./keys";
import { AltScreenWatcher } from "./altwatch";
import { OscScanner } from "./osc";
import { buildPalette, type Palette, type TermColors } from "./palette";
import { CanvasRenderer, type CursorStyle, type CursorView, type RenderSource } from "./renderer";
import { newStats, trackStats, type TerminalStats } from "../stats";
import type { ILink, ILinkHandler, ILinkProvider } from "@xterm/xterm";

export interface IDisposable {
  dispose(): void;
}
export type IEvent<T> = (listener: (arg: T) => void) => IDisposable;

class Emitter<T> {
  private readonly listeners = new Set<(arg: T) => void>();
  readonly event: IEvent<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };
  fire(arg: T): void {
    for (const listener of [...this.listeners]) listener(arg);
  }
  clear(): void {
    this.listeners.clear();
  }
}

/** A handler for URLs written out in the text (xterm's WebLinksAddon). */
export interface WebLinkHandler {
  activate(event: MouseEvent, uri: string): void;
  hover?(event: MouseEvent, uri: string): void;
  leave?(event: MouseEvent, uri: string): void;
}

export interface GhosttyOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
  fontSize?: number;
  fontFamily?: string;
  cursorStyle?: CursorStyle;
  cursorBlink?: boolean;
  macOptionIsMeta?: boolean;
  macOptionClickForcesSelection?: boolean;
  minimumContrastRatio?: number;
  disableStdin?: boolean;
  theme?: Partial<TermColors>;
  /** OSC 8 hyperlinks. */
  linkHandler?: ILinkHandler | null;
  /** URLs written out in the text. */
  webLinks?: WebLinkHandler | null;
  /** Leave the default background clear (the page shows through). */
  allowTransparency?: boolean;
  /** Accepted and ignored: xterm options with no meaning here. */
  allowProposedApi?: boolean;
}

interface Pos {
  line: number;
  col: number;
}

interface ActiveLink {
  line: number;
  from: number;
  to: number;
  text: string;
  activate(event: MouseEvent): void;
  hover?(event: MouseEvent): void;
  leave?(event: MouseEvent): void;
}

interface Pending {
  bytes: Uint8Array;
  offset: number;
  callback?: () => void;
}

const DEFAULT_FONT = "Menlo, Monaco, 'Courier New', monospace";
/** Parsed per engine call: large enough to be efficient, small enough that a
 *  burst never holds the page for long. */
const SLICE = 128 * 1024;
/** Parse budget per turn of the event loop. */
const BUDGET_MS = 12;
/** Raw output kept to rebuild the screen if the engine fails. */
const TAIL_BYTES = 256 * 1024;
const SCROLLBACK_CHUNK = 256;
const SCROLLBAR_WIDTH = 10;
const WORD_SEPARATORS = " ()[]{}'\",;` ";
const URL_PATTERN =
  /(?:https?|ftp):\/\/[^\s"'<>`\u0000-\u001f]*[^\s"'<>`\u0000-\u001f.,;:!?)\]}]/gi;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || "");
}

function bytesToString(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

const macrotask: (fn: () => void) => void = (() => {
  if (typeof MessageChannel === "function") {
    const channel = new MessageChannel();
    const queue: Array<() => void> = [];
    channel.port1.onmessage = () => {
      const fn = queue.shift();
      if (fn) fn();
    };
    // Node keeps the process alive for an open port; a browser has no unref.
    (channel.port1 as unknown as { unref?: () => void }).unref?.();
    return (fn) => {
      queue.push(fn);
      channel.port2.postMessage(0);
    };
  }
  return (fn) => void setTimeout(fn, 0);
})();

export class GhosttyTerminal {
  readonly engine = "ghostty" as const;
  readonly stats: TerminalStats = newStats("ghostty");
  cols: number;
  rows: number;
  element: HTMLElement | undefined;
  textarea: HTMLTextAreaElement | undefined;

  readonly options: {
    theme: Partial<TermColors> | undefined;
    fontSize: number;
    fontFamily: string;
    cursorStyle: CursorStyle;
    cursorBlink: boolean;
    linkHandler: ILinkHandler | null;
    minimumContrastRatio: number;
    readonly scrollback: number;
    disableStdin: boolean;
  };

  /** Accepted for xterm compatibility; the engine's width tables are fixed. */
  readonly unicode = { activeVersion: "15" };

  readonly parser = {
    registerOscHandler: (id: number, handler: (data: string) => boolean | Promise<boolean>) => {
      let set = this.oscHandlers.get(id);
      if (!set) this.oscHandlers.set(id, (set = new Set()));
      set.add(handler);
      return { dispose: () => void set.delete(handler) };
    },
  };

  private readonly dataEmitter = new Emitter<string>();
  private readonly binaryEmitter = new Emitter<string>();
  private readonly titleEmitter = new Emitter<string>();
  private readonly resizeEmitter = new Emitter<{ cols: number; rows: number }>();
  private readonly parsedEmitter = new Emitter<void>();
  private readonly bellEmitter = new Emitter<void>();
  private readonly scrollEmitter = new Emitter<number>();
  private readonly selectionEmitter = new Emitter<void>();
  private readonly bufferEmitter = new Emitter<void>();
  private readonly failureEmitter = new Emitter<string>();

  readonly onData = this.dataEmitter.event;
  readonly onBinary = this.binaryEmitter.event;
  readonly onTitleChange = this.titleEmitter.event;
  readonly onResize = this.resizeEmitter.event;
  readonly onWriteParsed = this.parsedEmitter.event;
  readonly onBell = this.bellEmitter.event;
  readonly onScroll = this.scrollEmitter.event;
  readonly onSelectionChange = this.selectionEmitter.event;
  /** The engine failed and could not be rebuilt: this terminal shows nothing
   *  further. The reason is a short code, never content. */
  readonly onEngineFailure = this.failureEmitter.event;

  readonly buffer: {
    readonly active: BufferView;
    readonly normal: { readonly length: number };
    readonly alternate: { readonly length: number };
    onBufferChange: IEvent<void>;
  };

  readonly modes: { readonly mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any" };

  private wasm: WasmTerminal | null = null;
  private dead = false;
  private disposed = false;
  private readonly scrollbackLimit: number;
  private readonly mac = isMac();
  private readonly optionIsMeta: boolean;
  private readonly optionForcesSelection: boolean;
  private webLinks: WebLinkHandler | null;
  private readonly transparent: boolean;
  private palette: Palette;

  private readonly queue: Pending[] = [];
  private flushScheduled = false;
  private tail: Uint8Array[] = [];
  private tailBytes = 0;
  private lastRecovery = 0;
  private readonly osc = new OscScanner();
  private readonly altWatch = new AltScreenWatcher();
  /** The primary screen and its history as they were when a full-screen
   *  program took over; the engine cannot be asked for them until it exits. */
  private primaryStash: string | null = null;
  private readonly oscHandlers = new Map<number, Set<(data: string) => boolean | Promise<boolean>>>();

  // The frame last read from the engine.
  private stale = true;
  private generation = 0;
  private seq = 0;
  private cellsSeq = -1;
  private cells: Uint32Array = new Uint32Array(0);
  private clusters: string[] = [];
  private cursorState: Uint32Array = new Uint32Array(5);
  private modeState: Uint32Array = new Uint32Array(9);
  private scrollbackLen = 0;
  private altScreen = false;
  private title = "";
  private readonly scrollbackCache = new Map<number, Line[]>();
  private scrollbackCacheGeneration = -1;

  // View state.
  private scrollOffset = 0;
  private selection: { anchor: Pos; head: Pos; mode: "char" | "word" | "line"; origin: [Pos, Pos] } | null =
    null;
  private renderer: CanvasRenderer | null = null;
  private thumb: HTMLElement | null = null;
  private raf = 0;
  private needsFull = true;
  private paintedSeq = 0;
  private paintedCursorRow = -1;
  private cursorDirty = false;
  private focused = false;
  private blinkOn = true;
  private blinkTimer: ReturnType<typeof setInterval> | null = null;
  private syncHeldSince = 0;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;

  // Input state.
  private keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  private composing = false;
  private wheelRemainder = 0;
  private reportingButton = -1;
  /** Where a press the program was told about went down, to tell a click from a drag. */
  private reportedPress: { col: number; row: number } | null = null;
  private lastReportedCell = -1;
  private dragging = false;
  private dragMoved = false;
  private readonly linkProviders = new Set<ILinkProvider>();
  private readonly providedLinks = new Map<number, ILink[] | null>();
  private providedGeneration = -1;
  private hoverLink: ActiveLink | null = null;
  private hoverCell: Pos | null = null;
  private readonly cleanup: Array<() => void> = [];
  private readonly untrack: () => void;

  constructor(options: GhosttyOptions = {}) {
    this.cols = Math.max(2, options.cols ?? 80);
    this.rows = Math.max(1, options.rows ?? 24);
    this.scrollbackLimit = Math.max(0, options.scrollback ?? 1000);
    this.optionIsMeta = options.macOptionIsMeta ?? false;
    this.optionForcesSelection = options.macOptionClickForcesSelection ?? false;
    this.webLinks = options.webLinks ?? null;
    this.transparent = options.allowTransparency ?? false;
    this.palette = buildPalette(options.theme);

    const state = {
      theme: options.theme,
      fontSize: options.fontSize ?? 13,
      fontFamily: options.fontFamily || DEFAULT_FONT,
      cursorStyle: options.cursorStyle ?? "block",
      cursorBlink: options.cursorBlink ?? false,
      linkHandler: options.linkHandler ?? null,
      minimumContrastRatio: options.minimumContrastRatio ?? 1,
      disableStdin: options.disableStdin ?? false,
    };
    const self = this;
    this.options = {
      get theme() {
        return state.theme;
      },
      set theme(value) {
        state.theme = value;
        self.applyTheme();
      },
      get fontSize() {
        return state.fontSize;
      },
      set fontSize(value) {
        if (value === state.fontSize) return;
        state.fontSize = value;
        self.applyFont();
      },
      get fontFamily() {
        return state.fontFamily;
      },
      set fontFamily(value) {
        if (value === state.fontFamily) return;
        state.fontFamily = value || DEFAULT_FONT;
        self.applyFont();
      },
      get cursorStyle() {
        return state.cursorStyle;
      },
      set cursorStyle(value) {
        state.cursorStyle = value;
        self.touchCursor();
      },
      get cursorBlink() {
        return state.cursorBlink;
      },
      set cursorBlink(value) {
        state.cursorBlink = value;
        self.syncBlink();
        self.touchCursor();
      },
      get linkHandler() {
        return state.linkHandler;
      },
      set linkHandler(value) {
        state.linkHandler = value;
      },
      get minimumContrastRatio() {
        return state.minimumContrastRatio;
      },
      set minimumContrastRatio(value) {
        state.minimumContrastRatio = value;
        self.refresh();
      },
      get scrollback() {
        return self.scrollbackLimit;
      },
      get disableStdin() {
        return state.disableStdin;
      },
      set disableStdin(value) {
        state.disableStdin = value;
      },
    };

    const active: BufferView = {
      get length() {
        return self.baseY() + self.rows;
      },
      get viewportY() {
        return self.baseY() - self.scrollOffset;
      },
      get baseY() {
        return self.baseY();
      },
      get cursorX() {
        self.ensureFresh();
        return self.cursorState[1];
      },
      get cursorY() {
        self.ensureFresh();
        return self.cursorState[0];
      },
      getLine: (index: number) => {
        if (index < 0 || index >= this.baseY() + this.rows) return undefined;
        const line = this.bufferLine(index);
        return {
          translateToString: (trimRight = false, from?: number, to?: number) =>
            lineText(line, trimRight, from, to),
          get isWrapped() {
            return index > 0 && lineWraps(self.bufferLine(index - 1));
          },
        };
      },
    };
    this.buffer = {
      active,
      normal: {
        get length() {
          self.ensureFresh();
          return self.scrollbackLen + self.rows;
        },
      },
      alternate: {
        get length() {
          self.ensureFresh();
          return self.altScreen ? self.rows : 0;
        },
      },
      onBufferChange: this.bufferEmitter.event,
    };
    this.modes = {
      get mouseTrackingMode() {
        self.ensureFresh();
        return (["none", "x10", "vt200", "drag", "any"] as const)[self.modeState[0]] ?? "none";
      },
    };

    this.stats.cols = this.cols;
    this.stats.rows = this.rows;
    this.untrack = trackStats(this.stats);
    this.createEngine();
  }

  // ---------------------------------------------------------------- engine

  private createEngine(): void {
    try {
      this.wasm = new WasmTerminal(this.cols, this.rows, this.scrollbackLimit);
      this.pushColors();
    } catch (error) {
      this.wasm = null;
      this.giveUp(error);
    }
    this.stale = true;
    this.generation++;
    this.paintedSeq = 0;
    this.needsFull = true;
  }

  /** Every engine call goes through here: a trap must never reach the app. */
  private call<T>(fn: (wasm: WasmTerminal) => T, fallback: T): T {
    const wasm = this.wasm;
    if (!wasm) return fallback;
    try {
      return fn(wasm);
    } catch (error) {
      this.recover(error);
      return fallback;
    }
  }

  /** The engine trapped. Its state for this terminal is gone; build a new
   *  screen and replay the output kept for exactly this. New terminals use
   *  xterm from here on (the engine is no longer trusted for the session). */
  private recover(error: unknown): void {
    const reason = classifyTrap(error);
    failGhostty(reason);
    const old = this.wasm;
    this.wasm = null;
    try {
      old?.free();
    } catch {
      // Already broken; its memory goes with the instance.
    }
    const now = Date.now();
    if (this.disposed || now - this.lastRecovery < 5000) {
      this.giveUp(error);
      return;
    }
    this.lastRecovery = now;
    this.stats.recoveries++;
    try {
      const fresh = new WasmTerminal(this.cols, this.rows, this.scrollbackLimit);
      this.wasm = fresh;
      this.pushColors();
      for (const chunk of this.tail) fresh.advance(chunk);
      // Answers to queries inside the replay were sent the first time.
      fresh.take_replies();
      fresh.take_events();
    } catch (again) {
      this.wasm = null;
      this.giveUp(again);
      return;
    }
    this.osc.reset();
    this.altWatch.reset();
    this.primaryStash = null;
    this.stale = true;
    this.generation++;
    this.paintedSeq = 0;
    this.scrollOffset = 0;
    this.selection = null;
    this.refresh();
  }

  private giveUp(error: unknown): void {
    if (this.dead) return;
    this.dead = true;
    const reason = classifyTrap(error);
    failGhostty(reason);
    this.failureEmitter.fire(reason);
  }

  /** The engine failed beyond repair (see `onEngineFailure`). */
  get failed(): boolean {
    return this.dead;
  }

  /** Output accepted but not parsed yet, handed over (with its callbacks) to
   *  whoever takes this terminal's place. */
  drainPending(): Array<{ bytes: Uint8Array; callback?: () => void }> {
    const rest: Array<{ bytes: Uint8Array; callback?: () => void }> = [];
    for (const item of this.queue) {
      rest.push({ bytes: item.bytes.subarray(item.offset), callback: item.callback });
    }
    this.queue.length = 0;
    return rest;
  }

  private pushColors(): void {
    const wasm = this.wasm;
    if (!wasm) return;
    wasm.set_default_palette(this.palette.table.subarray(0, 16));
    wasm.set_reply_colors(this.palette.fg, this.palette.bg, this.palette.cursor);
  }

  private ensureFresh(): void {
    if (!this.stale) return;
    this.stale = false;
    this.call((wasm) => {
      this.seq = wasm.refresh();
      this.cursorState = wasm.cursor();
      this.modeState = wasm.modes();
      this.scrollbackLen = wasm.scrollback_len();
      const alt = this.modeState[8] === 1;
      const title = wasm.title() ?? "";
      const altChanged = alt !== this.altScreen;
      this.altScreen = alt;
      if (altChanged) {
        if (!alt) this.primaryStash = null;
        this.scrollOffset = 0;
        this.selection = null;
        this.needsFull = true;
        this.bufferEmitter.fire();
      }
      if (title !== this.title) {
        this.title = title;
        this.titleEmitter.fire(title);
      }
    }, undefined);
    this.stats.scrollbackRows = this.scrollbackLen;
    if (this.scrollOffset > this.baseYNow()) this.scrollOffset = this.baseYNow();
  }

  private baseYNow(): number {
    return this.altScreen ? 0 : this.scrollbackLen;
  }

  private baseY(): number {
    this.ensureFresh();
    return this.baseYNow();
  }

  private frameCells(): Uint32Array {
    this.ensureFresh();
    if (this.cellsSeq !== this.seq) {
      this.call((wasm) => {
        this.cells = wasm.cells();
        this.clusters = wasm.clusters();
      }, undefined);
      this.cellsSeq = this.seq;
    }
    return this.cells;
  }

  private screenLine(row: number): Line {
    const cells = this.frameCells();
    const width = this.cols * WORDS;
    const start = row * width;
    if (row < 0 || start + width > cells.length) return EMPTY_LINE;
    return { cells: cells.subarray(start, start + width), clusters: this.clusters };
  }

  private scrollbackLine(index: number): Line {
    if (this.scrollbackCacheGeneration !== this.generation) {
      this.scrollbackCache.clear();
      this.scrollbackCacheGeneration = this.generation;
    }
    const chunk = Math.floor(index / SCROLLBACK_CHUNK);
    let lines = this.scrollbackCache.get(chunk);
    if (!lines) {
      const start = chunk * SCROLLBACK_CHUNK;
      const count = Math.min(SCROLLBACK_CHUNK, this.scrollbackLen - start);
      lines = this.call((wasm) => {
        const cells = wasm.scrollback_cells(start, count);
        const flat = wasm.scrollback_clusters(start, count);
        const width = count > 0 ? cells.length / count : 0;
        const out: Line[] = [];
        let at = 0;
        for (let i = 0; i < count; i++) {
          const n = Number(flat[at] ?? 0);
          out.push({
            cells: cells.subarray(i * width, (i + 1) * width),
            clusters: flat.slice(at + 1, at + 1 + n),
          });
          at += 1 + n;
        }
        return out;
      }, [] as Line[]);
      if (this.scrollbackCache.size >= 8) this.scrollbackCache.clear();
      this.scrollbackCache.set(chunk, lines);
    }
    return lines[index - chunk * SCROLLBACK_CHUNK] ?? EMPTY_LINE;
  }

  /** A line of the active buffer: scrollback first, then the screen. */
  private bufferLine(index: number): Line {
    const base = this.baseY();
    return index < base ? this.scrollbackLine(index) : this.screenLine(index - base);
  }

  // ----------------------------------------------------------------- write

  write(data: string | Uint8Array, callback?: () => void): void {
    if (this.disposed) return;
    const bytes = typeof data === "string" ? encoder.encode(data) : data;
    this.queue.push({ bytes, offset: 0, callback });
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      macrotask(() => this.flush());
    }
  }

  writeln(data: string | Uint8Array, callback?: () => void): void {
    this.write(data);
    this.write("\r\n", callback);
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.disposed) return;
    const started = performance.now();
    let parsed = 0;
    const done: Array<() => void> = [];
    while (this.queue.length) {
      const item = this.queue[0];
      if (this.dead || !this.wasm) {
        this.queue.shift();
        if (item.callback) done.push(item.callback);
        continue;
      }
      const end = Math.min(item.bytes.length, item.offset + SLICE);
      const slice =
        item.offset === 0 && end === item.bytes.length
          ? item.bytes
          : item.bytes.subarray(item.offset, end);
      item.offset = end;
      // Off the queue before it is parsed: if the engine fails on it, what is
      // still queued is exactly what has not been parsed.
      const finished = end >= item.bytes.length;
      if (finished) this.queue.shift();
      if (slice.length) {
        this.remember(slice);
        this.feed(slice);
        this.osc.scan(slice, (id, data) => this.dispatchOsc(id, data));
        parsed += slice.length;
      }
      if (finished && item.callback) done.push(item.callback);
      if (performance.now() - started > BUDGET_MS) break;
    }
    if (parsed) {
      this.stats.bytes += parsed;
      this.stats.parseMs += performance.now() - started;
      this.stale = true;
      this.generation++;
      const scrolledAt = this.scrollOffset > 0 ? this.scrollbackLen : -1;
      this.drainEngine();
      this.ensureFresh();
      // Reading history: stay on the same lines while output arrives below.
      if (scrolledAt >= 0 && this.scrollbackLen > scrolledAt) {
        this.scrollOffset = Math.min(
          this.baseYNow(),
          this.scrollOffset + (this.scrollbackLen - scrolledAt),
        );
      }
      this.requestPaint();
    }
    for (const callback of done) {
      try {
        callback();
      } catch (error) {
        console.error(error);
      }
    }
    if (parsed) this.parsedEmitter.fire();
    if (this.queue.length && !this.flushScheduled) {
      this.flushScheduled = true;
      macrotask(() => this.flush());
    }
  }

  /** Hand bytes to the engine, pausing just before a switch to the alternate
   *  screen to keep what the primary screen holds. */
  private feed(slice: Uint8Array): void {
    let from = 0;
    let scan = 0;
    for (;;) {
      const at = this.altWatch.find(slice, scan);
      if (at < 0) break;
      scan = at + 1;
      if (at > from) {
        const head = slice.subarray(from, at);
        this.call((wasm) => wasm.advance(head), undefined);
        from = at;
      }
      this.stale = true;
      this.generation++;
      this.ensureFresh();
      if (!this.altScreen) this.primaryStash = this.primaryVt();
    }
    if (from < slice.length) {
      const rest = from === 0 ? slice : slice.subarray(from);
      this.call((wasm) => wasm.advance(rest), undefined);
    }
  }

  /** History and screen of the primary buffer as plain styled text: written
   *  to a fresh terminal it puts the same lines in the same places. */
  private primaryVt(): string {
    const parts: string[] = [];
    const history = this.scrollbackLen;
    const runsOn = (line: Line, next: Line) => lineWraps(line) && lineText(next, true) !== "";
    for (let i = 0; i < history; i++) {
      const line = this.scrollbackLine(i);
      parts.push(lineVt(line));
      const next = i + 1 < history ? this.scrollbackLine(i + 1) : this.screenLine(0);
      if (!runsOn(line, next)) parts.push("\r\n");
    }
    // With history above it every screen row is written, blank ones too, so
    // the screen ends up holding exactly these rows.
    let last = this.rows - 1;
    if (history === 0) {
      while (last > 0 && lineText(this.screenLine(last), true) === "") last--;
    }
    for (let row = 0; row <= last; row++) {
      const line = this.screenLine(row);
      parts.push(lineVt(line));
      if (row < last && !runsOn(line, this.screenLine(row + 1))) parts.push("\r\n");
    }
    parts.push(`\x1b[${this.cursorState[0] + 1};${this.cursorState[1] + 1}H`);
    return parts.join("");
  }

  /** The newest output this terminal received (up to 256 KiB): enough to
   *  redraw the screen on another engine. */
  recentOutput(): Uint8Array {
    const out = new Uint8Array(this.tailBytes);
    let at = 0;
    for (const chunk of this.tail) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }

  private remember(slice: Uint8Array): void {
    // A copy: the caller may reuse its buffer.
    this.tail.push(slice.slice());
    this.tailBytes += slice.length;
    while (this.tailBytes > TAIL_BYTES && this.tail.length > 1) {
      this.tailBytes -= this.tail.shift()!.length;
    }
  }

  private drainEngine(): void {
    const replies = this.call((wasm) => wasm.take_replies(), null);
    if (replies && replies.length && !this.options.disableStdin) {
      this.dataEmitter.fire(bytesToString(replies));
    }
    const events = this.call((wasm) => wasm.take_events(), "[]");
    if (events.length > 2 && events.includes('"bell"')) this.bellEmitter.fire();
  }

  private dispatchOsc(id: number, data: string): void {
    const handlers = this.oscHandlers.get(id);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        void handler(data);
      } catch (error) {
        console.error(error);
      }
    }
  }

  // ------------------------------------------------------------------ input

  /** Text as if typed (xterm `input`). */
  input(data: string, _wasUserInput = true): void {
    if (this.disposed || this.options.disableStdin) return;
    this.dataEmitter.fire(data);
  }

  paste(text: string): void {
    if (this.disposed || this.options.disableStdin || !text) return;
    this.ensureFresh();
    const bytes = this.call((wasm) => wasm.encode_paste(text, true), null);
    if (!bytes || !bytes.length) return;
    this.scrollToBottom();
    this.dataEmitter.fire(bytesToString(bytes));
  }

  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
  }

  focus(): void {
    this.textarea?.focus({ preventScroll: true });
  }

  blur(): void {
    this.textarea?.blur();
  }

  private send(bytes: Uint8Array | null, binary = false): boolean {
    if (!bytes || !bytes.length || this.options.disableStdin) return false;
    if (binary) this.binaryEmitter.fire(bytesToBinary(bytes));
    else this.dataEmitter.fire(bytesToString(bytes));
    return true;
  }

  private onKeyDown(ev: KeyboardEvent): void {
    if (this.keyHandler && this.keyHandler(ev) === false) return;
    if (ev.isComposing || ev.keyCode === 229 || this.composing) return;
    // Command (and the Windows key) belongs to the app and the OS.
    if (ev.metaKey) return;
    if (ev.shiftKey && !ev.ctrlKey && !ev.altKey && !this.altScreen) {
      if (ev.key === "PageUp" || ev.key === "PageDown") {
        ev.preventDefault();
        this.scrollLines((ev.key === "PageUp" ? -1 : 1) * Math.max(1, this.rows - 1));
        return;
      }
    }
    const args = keyArgs(ev, { mac: this.mac, optionIsMeta: this.optionIsMeta });
    if (!args) return;
    this.ensureFresh();
    const bytes = this.call(
      (wasm) =>
        wasm.encode_key(args.key, args.mods, ev.repeat ? 1 : 0, args.text, args.shifted, args.base),
      null,
    );
    if (!bytes || !bytes.length) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (this.options.disableStdin) return;
    this.clearSelection();
    this.scrollToBottom();
    this.dataEmitter.fire(bytesToString(bytes));
  }

  private onKeyUp(ev: KeyboardEvent): void {
    if (this.keyHandler && this.keyHandler(ev) === false) return;
    this.ensureFresh();
    // Releases are only sent when the program asked for them (kitty flag 2).
    if ((this.modeState[7] & 2) === 0 || ev.metaKey) return;
    const args = keyArgs(ev, { mac: this.mac, optionIsMeta: this.optionIsMeta });
    if (!args) return;
    this.send(
      this.call((wasm) => wasm.encode_key(args.key, args.mods, 2, "", args.shifted, args.base), null),
    );
  }

  /** Text that did not come from a key we encoded: an input method, a dead
   *  key, dictation, an on-screen keyboard. */
  private onTextInput(ev: Event): void {
    const area = this.textarea;
    if (!area) return;
    const input = ev as InputEvent;
    if (this.composing || input.isComposing) return;
    const text = input.data ?? area.value;
    area.value = "";
    if (!text || this.options.disableStdin) return;
    if (input.inputType === "insertFromPaste" || input.inputType === "insertFromDrop") {
      this.paste(text);
      return;
    }
    this.clearSelection();
    this.scrollToBottom();
    this.dataEmitter.fire(text);
  }

  // ------------------------------------------------------------------ mouse

  private cellAt(ev: MouseEvent): { col: number; row: number; boundary: number } {
    const renderer = this.renderer!;
    const rect = renderer.canvas.getBoundingClientRect();
    const m = renderer.metrics;
    const x = (ev.clientX - rect.left) / m.cellWidth;
    const y = (ev.clientY - rect.top) / m.cellHeight;
    const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v));
    return {
      col: clamp(Math.floor(x), this.cols - 1),
      row: clamp(Math.floor(y), this.rows - 1),
      boundary: clamp(Math.round(x), this.cols),
    };
  }

  private reportsMouse(ev: MouseEvent): boolean {
    this.ensureFresh();
    if (this.modeState[0] === 0 || this.options.disableStdin) return false;
    // The gestures that select text even while a program tracks the mouse.
    if (ev.shiftKey) return false;
    if (this.mac && ev.altKey && this.optionForcesSelection) return false;
    return this.scrollOffset === 0;
  }

  private mouseMods(ev: MouseEvent): number {
    return (ev.shiftKey ? MOD_SHIFT : 0) | (ev.altKey ? MOD_ALT : 0) | (ev.ctrlKey ? MOD_CTRL : 0);
  }

  private report(kind: number, button: number, ev: MouseEvent): boolean {
    const { col, row } = this.cellAt(ev);
    if (kind === 2) {
      const cell = row * this.cols + col;
      if (cell === this.lastReportedCell) return false;
      this.lastReportedCell = cell;
    }
    const bytes = this.call(
      (wasm) => wasm.encode_mouse(kind, button, col, row, this.mouseMods(ev)),
      null,
    );
    // Only the SGR encoding is plain text; the others carry raw bytes.
    return this.send(bytes, this.modeState[1] !== 2);
  }

  private static button(ev: MouseEvent): number {
    return [0, 1, 2, 8, 9][ev.button] ?? -1;
  }

  private onMouseDown(ev: MouseEvent): void {
    if (!this.renderer) return;
    // Keep the click from moving focus or starting a DOM selection.
    if (ev.target !== this.textarea) ev.preventDefault();
    this.focus();
    if (this.reportsMouse(ev)) {
      const button = GhosttyTerminal.button(ev);
      if (button < 0) return;
      this.reportingButton = button;
      this.lastReportedCell = -1;
      const { col, row } = this.cellAt(ev);
      this.reportedPress = { col, row };
      this.report(0, button, ev);
      this.trackDocument();
      return;
    }
    if (ev.button !== 0) return;
    const cell = this.cellAt(ev);
    const line = this.viewportY() + cell.row;
    this.dragMoved = false;
    if (ev.shiftKey && this.selection) {
      this.selection.head = { line, col: cell.boundary };
      this.selection.mode = "char";
    } else if (ev.detail >= 3) {
      const range: [Pos, Pos] = [
        { line, col: 0 },
        { line, col: this.cols },
      ];
      this.selection = { anchor: range[0], head: range[1], mode: "line", origin: range };
    } else if (ev.detail === 2) {
      const range = this.wordAt(line, cell.col);
      this.selection = { anchor: range[0], head: range[1], mode: "word", origin: range };
    } else {
      const at = { line, col: cell.boundary };
      this.selection = { anchor: at, head: at, mode: "char", origin: [at, at] };
    }
    this.dragging = true;
    this.selectionChanged();
    this.trackDocument();
  }

  private trackDocument(): void {
    const doc = this.element?.ownerDocument;
    if (!doc) return;
    const move = (ev: MouseEvent) => this.onDragMove(ev);
    const up = (ev: MouseEvent) => {
      doc.removeEventListener("mousemove", move, true);
      doc.removeEventListener("mouseup", up, true);
      this.onMouseUp(ev);
    };
    doc.addEventListener("mousemove", move, true);
    doc.addEventListener("mouseup", up, true);
  }

  private onDragMove(ev: MouseEvent): void {
    if (this.reportingButton >= 0) {
      this.report(2, this.reportingButton, ev);
      return;
    }
    if (!this.dragging || !this.selection || !this.renderer) return;
    const cell = this.cellAt(ev);
    // Dragging past the top or bottom edge scrolls the history along.
    const rect = this.renderer.canvas.getBoundingClientRect();
    if (ev.clientY < rect.top) this.scrollLines(-1);
    else if (ev.clientY > rect.bottom) this.scrollLines(1);
    const line = this.viewportY() + cell.row;
    const sel = this.selection;
    if (sel.mode === "char") {
      sel.head = { line, col: cell.boundary };
    } else {
      const range: [Pos, Pos] =
        sel.mode === "word"
          ? this.wordAt(line, cell.col)
          : [
              { line, col: 0 },
              { line, col: this.cols },
            ];
      const before = comparePos(range[0], sel.origin[0]) < 0;
      sel.anchor = before ? sel.origin[1] : sel.origin[0];
      sel.head = before ? range[0] : range[1];
    }
    this.dragMoved = true;
    this.selectionChanged();
  }

  private onMouseUp(ev: MouseEvent): void {
    if (this.reportingButton >= 0) {
      const button = this.reportingButton;
      const press = this.reportedPress;
      this.reportingButton = -1;
      this.reportedPress = null;
      this.lastReportedCell = -1;
      this.report(1, button, ev);
      // A program that tracks the mouse still gets the click, and a link under
      // it still opens: an agent's screen is where most links are.
      const at = this.cellAt(ev);
      if (button === 0 && press && press.col === at.col && press.row === at.row && this.hoverLink) {
        this.hoverLink.activate(ev);
      }
      return;
    }
    if (!this.dragging) return;
    this.dragging = false;
    const sel = this.selection;
    if (sel && comparePos(sel.anchor, sel.head) === 0) {
      this.selection = null;
      this.selectionChanged();
    }
    if (!this.dragMoved && ev.button === 0 && this.hoverLink) this.hoverLink.activate(ev);
  }

  private onMouseMove(ev: MouseEvent): void {
    if (!this.renderer || this.dragging || this.reportingButton >= 0) return;
    if (this.reportsMouse(ev)) {
      this.ensureFresh();
      // Mode "any": motion is reported with no button held.
      if (this.modeState[0] === 4 && ev.buttons === 0) this.report(2, 3, ev);
    }
    const cell = this.cellAt(ev);
    const at = { line: this.viewportY() + cell.row, col: cell.col };
    if (this.hoverCell && comparePos(this.hoverCell, at) === 0) return;
    this.hoverCell = at;
    this.updateHover(ev, at);
  }

  private onWheel(ev: WheelEvent): void {
    if (!this.renderer || ev.deltaY === 0) return;
    const m = this.renderer.metrics;
    if (ev.deltaMode === 1) this.wheelRemainder += ev.deltaY;
    else if (ev.deltaMode === 2) this.wheelRemainder += ev.deltaY * this.rows;
    else this.wheelRemainder += ev.deltaY / m.cellHeight;
    const lines = Math.trunc(this.wheelRemainder);
    ev.preventDefault();
    if (lines === 0) return;
    this.wheelRemainder -= lines;
    const count = Math.min(Math.abs(lines), this.rows);
    if (this.reportsMouse(ev)) {
      const button = lines < 0 ? 4 : 5;
      for (let i = 0; i < count; i++) {
        this.lastReportedCell = -1;
        this.report(0, button, ev);
      }
      return;
    }
    if (this.altScreen) {
      // A full-screen program with no mouse tracking scrolls by arrow keys.
      if (this.options.disableStdin) return;
      const key = lines < 0 ? "Up" : "Down";
      const bytes = this.call((wasm) => wasm.encode_key(key, 0, 0, "", 0, 0), null);
      if (bytes && bytes.length) this.dataEmitter.fire(bytesToString(bytes).repeat(count));
      return;
    }
    this.scrollLines(lines);
  }

  // -------------------------------------------------------------- selection

  private selectionBounds(): [Pos, Pos] | null {
    const sel = this.selection;
    if (!sel) return null;
    const order = comparePos(sel.anchor, sel.head);
    if (order === 0) return null;
    return order < 0 ? [sel.anchor, sel.head] : [sel.head, sel.anchor];
  }

  private wordAt(line: number, col: number): [Pos, Pos] {
    const data = this.bufferLine(line);
    const cols = lineCols(data);
    const isSeparator = (c: number) => {
      const code = data.cells[c * WORDS];
      const ch = code === 0 ? " " : String.fromCodePoint(code);
      return WORD_SEPARATORS.includes(ch);
    };
    if (col >= cols) return [{ line, col }, { line, col: Math.min(this.cols, col + 1) }];
    const kind = isSeparator(col);
    let from = col;
    let to = col + 1;
    // A separator selects only itself (a run of blanks selects the run).
    const same = (c: number) =>
      isSeparator(c) === kind && (!kind || data.cells[c * WORDS] === data.cells[col * WORDS]);
    while (from > 0 && same(from - 1)) from--;
    while (to < cols && same(to)) to++;
    return [
      { line, col: from },
      { line, col: to },
    ];
  }

  private selectionChanged(): void {
    this.needsFull = true;
    this.requestPaint();
    this.selectionEmitter.fire();
  }

  hasSelection(): boolean {
    return this.selectionBounds() !== null;
  }

  getSelection(): string {
    const bounds = this.selectionBounds();
    if (!bounds) return "";
    const [start, end] = bounds;
    const last = Math.min(end.line, this.baseY() + this.rows - 1);
    let out = "";
    for (let line = Math.max(0, start.line); line <= last; line++) {
      const data = this.bufferLine(line);
      const from = line === start.line ? start.col : 0;
      const to = line === end.line ? end.col : this.cols;
      const whole = to >= this.cols;
      out += lineText(data, whole, from, to);
      if (line === last) break;
      // A row that runs into the next one is the same line of text.
      const joined = whole && lineWraps(data) && lineText(this.bufferLine(line + 1), true) !== "";
      if (!joined) out += "\n";
    }
    return out;
  }

  clearSelection(): void {
    if (!this.selection) return;
    this.selection = null;
    this.selectionChanged();
  }

  selectAll(): void {
    const start = { line: 0, col: 0 };
    const end = { line: this.baseY() + this.rows - 1, col: this.cols };
    this.selection = { anchor: start, head: end, mode: "char", origin: [start, end] };
    this.selectionChanged();
  }

  // ------------------------------------------------------------------ links

  registerLinkProvider(provider: ILinkProvider): IDisposable {
    this.linkProviders.add(provider);
    return { dispose: () => void this.linkProviders.delete(provider) };
  }

  private updateHover(ev: MouseEvent, at: Pos): void {
    const found = this.linkAt(ev, at);
    const current = this.hoverLink;
    if (
      current &&
      found &&
      current.line === found.line &&
      current.from === found.from &&
      current.to === found.to &&
      current.text === found.text
    ) {
      return;
    }
    if (current) {
      this.hoverLink = null;
      current.leave?.(ev);
    }
    if (found) {
      this.hoverLink = found;
      found.hover?.(ev);
    }
    if (this.element) this.element.style.cursor = found ? "pointer" : "";
    if (current || found) {
      this.needsFull = true;
      this.requestPaint();
    }
  }

  private linkAt(ev: MouseEvent, at: Pos): ActiveLink | null {
    const base = this.baseY();
    // An OSC 8 hyperlink: the target travels in the escape sequence.
    const handler = this.options.linkHandler;
    if (handler && at.line >= base) {
      const row = at.line - base;
      const uri = this.call((wasm) => wasm.hyperlink_at(row, at.col), undefined);
      if (uri && /^https?:/i.test(uri)) {
        let from = at.col;
        let to = at.col + 1;
        const same = (c: number) => this.call((wasm) => wasm.hyperlink_at(row, c), undefined) === uri;
        while (from > 0 && same(from - 1)) from--;
        while (to < this.cols && same(to)) to++;
        const range = {
          start: { x: from + 1, y: at.line + 1 },
          end: { x: to, y: at.line + 1 },
        };
        return {
          line: at.line,
          from,
          to,
          text: uri,
          activate: (e) => handler.activate(e, uri, range),
          hover: (e) => handler.hover?.(e, uri, range),
          leave: (e) => handler.leave?.(e, uri, range),
        };
      }
    }
    // Links the app's own providers found on this line (file paths).
    if (this.providedGeneration !== this.generation) {
      this.providedLinks.clear();
      this.providedGeneration = this.generation;
    }
    const provided = this.providedLinks.get(at.line);
    if (provided === undefined) {
      this.requestProvidedLinks(at.line, ev);
    } else if (provided) {
      for (const link of provided) {
        if (at.col + 1 >= link.range.start.x && at.col + 1 <= link.range.end.x) {
          return {
            line: at.line,
            from: link.range.start.x - 1,
            to: link.range.end.x,
            text: link.text,
            activate: (e) => link.activate(e, link.text),
            hover: (e) => link.hover?.(e, link.text),
            leave: (e) => link.leave?.(e, link.text),
          };
        }
      }
    }
    // A URL written out in the text.
    const web = this.webLinks;
    if (!web) return null;
    const data = this.bufferLine(at.line);
    const text = lineText(data, false);
    const columns = textColumns(data);
    URL_PATTERN.lastIndex = 0;
    for (let m = URL_PATTERN.exec(text); m; m = URL_PATTERN.exec(text)) {
      const from = columns[m.index];
      const to = columns[m.index + m[0].length - 1] + 1;
      if (at.col >= from && at.col < to) {
        const uri = m[0];
        return {
          line: at.line,
          from,
          to,
          text: uri,
          activate: (e) => web.activate(e, uri),
          hover: (e) => web.hover?.(e, uri),
          leave: (e) => web.leave?.(e, uri),
        };
      }
    }
    return null;
  }

  private requestProvidedLinks(line: number, ev: MouseEvent): void {
    if (!this.linkProviders.size) return;
    const generation = this.generation;
    const collected: ILink[] = [];
    this.providedLinks.set(line, null);
    for (const provider of this.linkProviders) {
      provider.provideLinks(line + 1, (links) => {
        if (this.disposed || generation !== this.generation || !links?.length) return;
        collected.push(...links);
        this.providedLinks.set(line, collected);
        // The answer can arrive after the pointer settled on the link.
        if (this.hoverCell && this.hoverCell.line === line) this.updateHover(ev, this.hoverCell);
      });
    }
  }

  // ----------------------------------------------------------------- scroll

  private viewportY(): number {
    return this.baseY() - this.scrollOffset;
  }

  scrollLines(amount: number): void {
    this.setScrollOffset(this.scrollOffset - amount);
  }

  scrollPages(pages: number): void {
    this.scrollLines(pages * Math.max(1, this.rows - 1));
  }

  scrollToLine(line: number): void {
    this.setScrollOffset(this.baseY() - line);
  }

  scrollToTop(): void {
    this.setScrollOffset(this.baseY());
  }

  scrollToBottom(): void {
    this.setScrollOffset(0);
  }

  private setScrollOffset(value: number): void {
    const next = Math.max(0, Math.min(this.baseY(), Math.round(value)));
    if (next === this.scrollOffset) return;
    this.scrollOffset = next;
    this.needsFull = true;
    this.requestPaint();
    this.scrollEmitter.fire(this.viewportY());
  }

  // ------------------------------------------------------------------- view

  open(parent: HTMLElement): void {
    if (this.element || this.disposed) return;
    const doc = parent.ownerDocument;
    // The class names are xterm's: the app's stylesheet and a few focus
    // checks ("is the caret in a terminal?") look for them.
    const root = doc.createElement("div");
    root.className = "xterm canopy-term";
    // Like xterm's root: a block as wide as its container and as tall as the
    // grid. The grid is fitted to the container (proposeDimensions), or the
    // container scrolls a grid that is deliberately larger (the phone view).
    root.style.cssText = "position:relative;";
    const screen = doc.createElement("div");
    screen.className = "xterm-screen";
    screen.style.cssText = "position:relative;";
    const area = doc.createElement("textarea");
    area.className = "xterm-helper-textarea";
    area.setAttribute("aria-label", "Terminal input");
    area.setAttribute("autocorrect", "off");
    area.setAttribute("autocapitalize", "off");
    area.setAttribute("autocomplete", "off");
    area.spellcheck = false;
    area.tabIndex = 0;
    area.style.cssText =
      "position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;line-height:1;padding:0;margin:0;border:0;resize:none;overflow:hidden;white-space:nowrap;z-index:-5;caret-color:transparent;";
    const thumb = doc.createElement("div");
    thumb.className = "canopy-term-scrollbar";
    thumb.style.cssText = `position:absolute;right:1px;top:0;width:${SCROLLBAR_WIDTH - 4}px;border-radius:3px;background:currentColor;opacity:0;transition:opacity 120ms;pointer-events:none;`;

    const renderer = new CanvasRenderer(
      doc,
      this.options.fontSize,
      this.options.fontFamily,
      this.transparent,
    );
    screen.appendChild(renderer.canvas);
    root.append(screen, area, thumb);
    parent.appendChild(root);
    this.element = root;
    this.textarea = area;
    this.thumb = thumb;
    this.renderer = renderer;
    this.applyTheme();
    renderer.measure(root);
    renderer.resize(this.cols, this.rows);

    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement,
      type: K,
      handler: (ev: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, handler, options);
      this.cleanup.push(() => target.removeEventListener(type, handler, options));
    };
    on(area, "keydown", (ev) => this.onKeyDown(ev));
    on(area, "keyup", (ev) => this.onKeyUp(ev));
    on(area, "input", (ev) => this.onTextInput(ev));
    on(area, "compositionstart", () => {
      this.composing = true;
      this.placeTextarea();
    });
    on(area, "compositionend", (ev) => {
      this.composing = false;
      area.value = "";
      if (ev.data && !this.options.disableStdin) {
        this.scrollToBottom();
        this.dataEmitter.fire(ev.data);
      }
    });
    on(area, "paste", (ev) => {
      const text = ev.clipboardData?.getData("text/plain");
      ev.preventDefault();
      if (text) this.paste(text);
    });
    on(area, "focus", () => this.setFocused(true));
    on(area, "blur", () => this.setFocused(false));
    // Edit > Copy and its key equivalent arrive as a copy event, not a key.
    on(root, "copy", (ev) => {
      if (!this.hasSelection() || !ev.clipboardData) return;
      ev.clipboardData.setData("text/plain", this.getSelection());
      ev.preventDefault();
    });
    on(root, "mousedown", (ev) => this.onMouseDown(ev));
    on(root, "mousemove", (ev) => this.onMouseMove(ev));
    on(root, "mouseleave", (ev) => {
      this.hoverCell = null;
      const link = this.hoverLink;
      if (!link) return;
      this.hoverLink = null;
      link.leave?.(ev);
      root.style.cursor = "";
      this.refresh();
    });
    on(root, "wheel", (ev) => this.onWheel(ev), { passive: false });

    // A web font that finishes loading changes the cell size.
    void doc.fonts?.ready.then(() => {
      if (!this.disposed && this.renderer) this.applyFont();
    });
    const view = doc.defaultView;
    if (view?.matchMedia) {
      // Moving to a screen with another pixel density.
      let query: MediaQueryList | null = null;
      const changed = () => {
        if (this.disposed) return;
        this.applyFont();
        watch();
      };
      const watch = () => {
        query?.removeEventListener("change", changed);
        query = view.matchMedia(`(resolution: ${view.devicePixelRatio || 1}dppx)`);
        query.addEventListener("change", changed);
      };
      watch();
      this.cleanup.push(() => query?.removeEventListener("change", changed));
    }
    this.refresh();
  }

  /** The grid that fills the container (xterm's FitAddon). Undefined while
   *  the terminal is not laid out, as in a hidden tab. */
  proposeDimensions(): { cols: number; rows: number } | undefined {
    const root = this.element;
    const renderer = this.renderer;
    if (!root || !renderer) return undefined;
    // The space is the container's, less its padding (xterm's FitAddon).
    const parent = root.parentElement;
    const style = parent ? root.ownerDocument.defaultView?.getComputedStyle(parent) : null;
    if (!parent || !style) return undefined;
    const pad = (value: string) => Number.parseFloat(value) || 0;
    const width = parent.clientWidth - pad(style.paddingLeft) - pad(style.paddingRight);
    const height = parent.clientHeight - pad(style.paddingTop) - pad(style.paddingBottom);
    if (!(width > 0) || !(height > 0)) return undefined;
    if (!renderer.metrics.measured && renderer.measure(root)) {
      renderer.resize(this.cols, this.rows);
      this.needsFull = true;
    }
    const m = renderer.metrics;
    return {
      cols: Math.max(2, Math.floor((width - SCROLLBAR_WIDTH) / m.cellWidth)),
      rows: Math.max(1, Math.floor(height / m.cellHeight)),
    };
  }

  /** FitAddon's `fit()`. */
  fit(): void {
    const next = this.proposeDimensions();
    if (next && (next.cols !== this.cols || next.rows !== this.rows)) {
      this.resize(next.cols, next.rows);
    }
  }

  resize(cols: number, rows: number): void {
    cols = Math.max(2, Math.floor(cols));
    rows = Math.max(1, Math.floor(rows));
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.stats.cols = cols;
    this.stats.rows = rows;
    this.call((wasm) => wasm.resize(cols, rows), undefined);
    this.stale = true;
    this.generation++;
    this.selection = null;
    this.renderer?.resize(cols, rows);
    this.needsFull = true;
    this.ensureFresh();
    this.requestPaint();
    this.resizeEmitter.fire({ cols, rows });
  }

  /** Repaint. The row arguments are accepted for xterm compatibility; every
   *  row is redrawn. */
  refresh(_start?: number, _end?: number): void {
    this.needsFull = true;
    this.requestPaint();
  }

  /** Erase the screen and scrollback, keeping the line the cursor is on. */
  clear(): void {
    this.ensureFresh();
    if (this.altScreen) return;
    const row = this.cursorState[0];
    const col = this.cursorState[1];
    const keep = lineVt(this.screenLine(row));
    const bytes = encoder.encode(`\x1b[0m\x1b[H\x1b[2J\x1b[3J${keep}\x1b[1;${col + 1}H`);
    this.call((wasm) => {
      wasm.advance(bytes);
      wasm.take_replies();
    }, undefined);
    this.afterDirectChange();
  }

  /** A fresh screen: nothing on it, no scrollback, every mode at its default. */
  reset(): void {
    const old = this.wasm;
    this.wasm = null;
    try {
      old?.free();
    } catch {
      // A broken engine has nothing left to free.
    }
    this.tail = [];
    this.tailBytes = 0;
    this.osc.reset();
    this.altWatch.reset();
    this.primaryStash = null;
    if (this.dead) return;
    this.createEngine();
    this.afterDirectChange();
  }

  private afterDirectChange(): void {
    this.stale = true;
    this.generation++;
    this.scrollOffset = 0;
    this.selection = null;
    this.needsFull = true;
    this.ensureFresh();
    this.requestPaint();
  }

  /** The escape sequences that rebuild this terminal on a fresh one of the
   *  same size: scrollback (the newest `scrollback` lines; all by default),
   *  the screen, the cursor and the modes. xterm's SerializeAddon. */
  serialize(options?: { scrollback?: number }): string {
    this.ensureFresh();
    const snapshot = this.call((wasm) => bytesToString(wasm.snapshot()), "");
    if (this.altScreen && this.primaryStash !== null && snapshot.startsWith("\x1bc")) {
      // What the shell had on screen first, then the full-screen program
      // over it: leaving the program shows the shell again.
      return `\x1bc${this.primaryStash}\x1b[0m${snapshot.slice(2)}`;
    }
    const lines = Math.min(this.scrollbackLen, Math.max(0, options?.scrollback ?? this.scrollbackLen));
    if (!lines || !snapshot) return snapshot;
    // The engine's snapshot starts with a full reset and addresses every row,
    // so history goes first: written out, then pushed off the top.
    const body = snapshot.startsWith("\x1bc") ? snapshot.slice(2) : snapshot;
    const parts: string[] = ["\x1bc"];
    const first = this.scrollbackLen - lines;
    for (let i = first; i < this.scrollbackLen; i++) {
      const line = this.scrollbackLine(i);
      parts.push(lineVt(line));
      const runsOn =
        i + 1 < this.scrollbackLen &&
        lineWraps(line) &&
        lineText(this.scrollbackLine(i + 1), true) !== "";
      if (!runsOn) parts.push("\r\n");
    }
    parts.push("\n".repeat(Math.max(0, this.rows - 1)), "\x1b[0m", body);
    return parts.join("");
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.untrack();
    for (const undo of this.cleanup.splice(0)) undo();
    const view = this.element?.ownerDocument.defaultView;
    if (this.raf && view) view.cancelAnimationFrame(this.raf);
    if (this.blinkTimer) clearInterval(this.blinkTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.queue.length = 0;
    this.tail = [];
    const wasm = this.wasm;
    this.wasm = null;
    try {
      wasm?.free();
    } catch {
      // Nothing to do for an engine that already failed.
    }
    this.element?.remove();
    this.element = undefined;
    this.textarea = undefined;
    this.renderer = null;
    for (const emitter of [
      this.dataEmitter,
      this.binaryEmitter,
      this.titleEmitter,
      this.resizeEmitter,
      this.parsedEmitter,
      this.bellEmitter,
      this.scrollEmitter,
      this.selectionEmitter,
      this.bufferEmitter,
      this.failureEmitter,
    ] as unknown as Array<Emitter<never>>) {
      emitter.clear();
    }
  }

  // ---------------------------------------------------------------- drawing

  private applyTheme(): void {
    this.palette = buildPalette(this.options.theme);
    this.call(() => this.pushColors(), undefined);
    if (this.element) {
      this.element.style.background = this.options.theme?.background ?? "";
      this.element.style.color = this.options.theme?.foreground ?? "";
    }
    this.refresh();
  }

  private applyFont(): void {
    const renderer = this.renderer;
    if (!renderer || !this.element) return;
    renderer.setFont(this.options.fontSize, this.options.fontFamily);
    renderer.measure(this.element);
    renderer.resize(this.cols, this.rows);
    this.refresh();
  }

  private touchCursor(): void {
    this.cursorDirty = true;
    this.requestPaint();
  }

  private setFocused(focused: boolean): void {
    if (this.focused === focused) return;
    this.focused = focused;
    this.blinkOn = true;
    this.syncBlink();
    this.touchCursor();
    this.ensureFresh();
    if (this.modeState[5]) this.send(this.call((wasm) => wasm.encode_focus(focused), null));
  }

  private syncBlink(): void {
    const want = this.focused && !this.disposed;
    if (want && !this.blinkTimer) {
      this.blinkTimer = setInterval(() => {
        if (!this.options.cursorBlink && !this.cursorState[4]) {
          if (!this.blinkOn) {
            this.blinkOn = true;
            this.touchCursor();
          }
          return;
        }
        this.blinkOn = !this.blinkOn;
        this.touchCursor();
      }, 600);
    } else if (!want && this.blinkTimer) {
      clearInterval(this.blinkTimer);
      this.blinkTimer = null;
      this.blinkOn = true;
    }
  }

  private requestPaint(): void {
    if (this.raf || this.disposed || !this.renderer) return;
    const view = this.element?.ownerDocument.defaultView;
    if (!view) return;
    this.raf = view.requestAnimationFrame(() => {
      this.raf = 0;
      this.paint();
    });
  }

  private cursorView(): CursorView | null {
    const [row, col, shape, visible] = this.cursorState;
    if (!visible) return null;
    const viewRow = row + this.scrollOffset;
    if (viewRow >= this.rows) return null;
    if (this.focused && !this.blinkOn) return null;
    const style: CursorStyle =
      shape === 1 ? "underline" : shape === 2 ? "bar" : this.options.cursorStyle;
    return { row: viewRow, col, style, focused: this.focused };
  }

  private paint(): void {
    const renderer = this.renderer;
    const root = this.element;
    if (!renderer || !root || this.disposed || this.dead) return;
    // A hidden tab keeps parsing and paints when it is shown again.
    if (!(root.clientWidth > 0)) {
      this.needsFull = true;
      return;
    }
    if (!renderer.metrics.measured && renderer.measure(root)) {
      renderer.resize(this.cols, this.rows);
      this.needsFull = true;
    }
    this.ensureFresh();
    // Synchronized output: the program is mid-update, hold the frame (but
    // never for long: a program that died mid-update must not freeze it).
    if (this.modeState[6]) {
      const now = performance.now();
      if (!this.syncHeldSince) this.syncHeldSince = now;
      if (now - this.syncHeldSince < 1000) {
        if (!this.syncTimer) {
          this.syncTimer = setTimeout(() => {
            this.syncTimer = null;
            this.requestPaint();
          }, 250);
        }
        return;
      }
    }
    this.syncHeldSince = 0;

    const started = performance.now();
    const view = this.viewportY();
    const base = this.baseYNow();
    const cursor = this.cursorView();
    let dirty: Uint8Array | null = null;
    const full =
      this.needsFull ||
      this.paintedSeq === 0 ||
      (this.scrollOffset > 0 && this.seq !== this.paintedSeq) ||
      this.call((wasm) => wasm.damage_full(this.paintedSeq), true);
    if (!full) {
      dirty = new Uint8Array(this.rows);
      const ranges = this.call((wasm) => wasm.damage_rows(this.paintedSeq), new Uint16Array(0));
      for (let i = 0; i + 1 < ranges.length; i += 2) {
        for (let r = ranges[i]; r <= ranges[i + 1] && r < this.rows; r++) dirty[r] = 1;
      }
      if (this.paintedCursorRow >= 0 && this.paintedCursorRow < this.rows) {
        dirty[this.paintedCursorRow] = 1;
      }
      if (cursor) dirty[cursor.row] = 1;
      else if (this.cursorDirty) {
        const row = this.cursorState[0] + this.scrollOffset;
        if (row < this.rows) dirty[row] = 1;
      }
    }
    const bounds = this.selectionBounds();
    const link = this.hoverLink;
    const source: RenderSource = {
      cols: this.cols,
      rows: this.rows,
      cursor,
      line: (row) => {
        const index = view + row;
        return index < base ? this.scrollbackLine(index) : this.screenLine(index - base);
      },
      selection: (row) => {
        if (!bounds) return null;
        const index = view + row;
        if (index < bounds[0].line || index > bounds[1].line) return null;
        const from = index === bounds[0].line ? bounds[0].col : 0;
        const to = index === bounds[1].line ? bounds[1].col : this.cols;
        return to > from ? [from, to] : null;
      },
      link: (row) => (link && link.line === view + row ? [link.from, link.to] : null),
    };
    const drawn = renderer.paint(source, dirty, this.palette, this.options.minimumContrastRatio);
    this.needsFull = false;
    this.cursorDirty = false;
    this.paintedSeq = this.seq;
    this.paintedCursorRow = cursor ? cursor.row : -1;
    const elapsed = performance.now() - started;
    this.stats.paints++;
    this.stats.paintMs += elapsed;
    this.stats.lastPaintMs = elapsed;
    this.stats.lastPaintRows = drawn;
    this.placeScrollbar();
    this.placeTextarea();
  }

  private placeScrollbar(): void {
    const thumb = this.thumb;
    const renderer = this.renderer;
    if (!thumb || !renderer) return;
    const base = this.baseYNow();
    if (this.scrollOffset === 0 || base === 0) {
      thumb.style.opacity = "0";
      return;
    }
    const height = this.rows * renderer.metrics.cellHeight;
    const size = Math.max(24, (this.rows / (base + this.rows)) * height);
    const top = ((base - this.scrollOffset) / base) * (height - size);
    thumb.style.height = `${size}px`;
    thumb.style.top = `${top}px`;
    thumb.style.opacity = "0.35";
  }

  /** Keep the hidden input on the cursor cell, always (xterm does the same).
   *  macOS dictation and input-method candidate windows anchor to the focused
   *  input's caret, so an input parked at the corner puts them there. */
  private placeTextarea(): void {
    const area = this.textarea;
    const renderer = this.renderer;
    if (!area || !renderer) return;
    const m = renderer.metrics;
    const left = `${this.cursorState[1] * m.cellWidth}px`;
    const top = `${(this.cursorState[0] + this.scrollOffset) * m.cellHeight}px`;
    const width = `${m.cellWidth}px`;
    const height = `${m.cellHeight}px`;
    const st = area.style;
    if (st.left !== left) st.left = left;
    if (st.top !== top) st.top = top;
    if (st.width !== width) st.width = width;
    if (st.height !== height) st.height = height;
  }
}

interface BufferView {
  readonly length: number;
  readonly viewportY: number;
  readonly baseY: number;
  readonly cursorX: number;
  readonly cursorY: number;
  getLine(index: number):
    | { translateToString(trimRight?: boolean, from?: number, to?: number): string; readonly isWrapped: boolean }
    | undefined;
}

function comparePos(a: Pos, b: Pos): number {
  return a.line !== b.line ? a.line - b.line : a.col - b.col;
}

// A Ghostty terminal that cannot be lost: if the engine fails beyond its own
// repair, the tab continues on xterm.js in the same place, with the same
// listeners, redrawn from the newest output. The program behind it never
// notices.
import type { ILinkHandler, ILinkProvider, ITheme, Terminal } from "@xterm/xterm";
import type { GhosttyTerminal } from "./ghostty/GhosttyTerminal";
import { trackStats, type TerminalStats } from "./stats";

interface Disposable {
  dispose(): void;
}

export interface XtermBundle {
  term: Terminal;
  fit: { proposeDimensions(): { cols: number; rows: number } | undefined; fit(): void };
  serializer: { serialize(options?: { scrollback?: number }): string };
  mouseModes: {
    reset(): void;
    serialize(
      serializer: { serialize(options?: { scrollback?: number }): string },
      options?: { scrollback?: number },
    ): string;
    dispose(): void;
  };
}

class Signal<T> {
  private readonly listeners = new Set<(arg: T) => void>();
  readonly event = (listener: (arg: T) => void): Disposable => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };
  fire(arg: T): void {
    for (const listener of [...this.listeners]) listener(arg);
  }
}

type OscHandler = (data: string) => boolean | Promise<boolean>;

export class ResilientTerminal {
  readonly stats: TerminalStats;
  private ghostty: GhosttyTerminal | null;
  private xterm: XtermBundle | null = null;
  private parent: HTMLElement | null = null;
  private disposed = false;
  private keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  private readonly osc = new Map<number, Set<OscHandler>>();
  private readonly oscHooks = new Map<number, Disposable>();
  private readonly providers = new Map<ILinkProvider, Disposable | null>();
  private readonly data = new Signal<string>();
  private readonly binary = new Signal<string>();
  private readonly title = new Signal<string>();
  private readonly resized = new Signal<{ cols: number; rows: number }>();
  private readonly parsed = new Signal<void>();
  private readonly bufferChanged = new Signal<void>();
  private readonly failure = new Signal<string>();
  private untrack: (() => void) | null = null;

  readonly onData = this.data.event;
  readonly onBinary = this.binary.event;
  readonly onTitleChange = this.title.event;
  readonly onResize = this.resized.event;
  /** Neither engine could draw this terminal. */
  readonly onEngineFailure = this.failure.event;

  readonly options: {
    theme: ITheme | undefined;
    fontSize: number | undefined;
    fontFamily: string | undefined;
    cursorStyle: "block" | "underline" | "bar" | undefined;
    cursorBlink: boolean | undefined;
    linkHandler: ILinkHandler | null | undefined;
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

  readonly parser = {
    registerOscHandler: (id: number, handler: OscHandler): Disposable => {
      let set = this.osc.get(id);
      if (!set) this.osc.set(id, (set = new Set()));
      set.add(handler);
      this.hookOsc(id);
      return { dispose: () => void set.delete(handler) };
    },
  };

  /** Serialising with the mouse report encoding kept (xterm needs help with
   *  that; the Ghostty snapshot carries it). */
  readonly mouseModes = {
    reset: () => this.xterm?.mouseModes.reset(),
    serialize: (
      _serializer: { serialize(options?: { scrollback?: number }): string },
      options?: { scrollback?: number },
    ) => this.serialize(options),
    dispose: () => this.xterm?.mouseModes.dispose(),
  };

  private readonly makeXterm: (reason: string) => XtermBundle;

  constructor(ghostty: GhosttyTerminal, makeXterm: (reason: string) => XtermBundle) {
    this.makeXterm = makeXterm;
    this.ghostty = ghostty;
    this.stats = ghostty.stats;
    const self = this;
    const option = <K extends keyof ResilientTerminal["options"]>(key: K) => ({
      get: () => self.inner().options[key] as ResilientTerminal["options"][K],
      set: (value: ResilientTerminal["options"][K]) => {
        (self.inner().options as Record<string, unknown>)[key] = value;
      },
      enumerable: true,
    });
    this.options = Object.defineProperties({} as ResilientTerminal["options"], {
      theme: option("theme"),
      fontSize: option("fontSize"),
      fontFamily: option("fontFamily"),
      cursorStyle: option("cursorStyle"),
      cursorBlink: option("cursorBlink"),
      linkHandler: option("linkHandler"),
    });
    this.buffer = {
      get active() {
        return self.inner().buffer.active;
      },
      get normal() {
        return self.inner().buffer.normal;
      },
      get alternate() {
        return self.inner().buffer.alternate;
      },
      onBufferChange: this.bufferChanged.event,
    };
    this.modes = {
      get mouseTrackingMode() {
        return self.inner().modes.mouseTrackingMode;
      },
    };
    ghostty.onData((d) => this.data.fire(d));
    ghostty.onBinary((d) => this.binary.fire(d));
    ghostty.onTitleChange((t) => this.title.fire(t));
    ghostty.onResize((size) => this.resized.fire(size));
    ghostty.onWriteParsed(() => this.parsed.fire());
    ghostty.buffer.onBufferChange(() => this.bufferChanged.fire());
    ghostty.onEngineFailure((reason) => this.takeOver(reason));
    if (ghostty.failed) this.takeOver("create-failed");
  }

  /** The engine drawing this terminal right now. */
  get engine(): "ghostty" | "xterm" {
    return this.xterm ? "xterm" : "ghostty";
  }

  private inner(): GhosttyTerminal | Terminal {
    return this.xterm ? this.xterm.term : this.ghostty!;
  }

  private hookOsc(id: number): void {
    if (this.oscHooks.has(id)) return;
    const run: OscHandler = (data) => {
      let handled = false;
      for (const handler of [...(this.osc.get(id) ?? [])]) {
        if (handler(data) === true) handled = true;
      }
      return handled;
    };
    this.oscHooks.set(id, this.inner().parser.registerOscHandler(id, run));
  }

  private takeOver(reason: string): void {
    const ghostty = this.ghostty;
    if (!ghostty || this.xterm || this.disposed) return;
    let bundle: XtermBundle;
    try {
      bundle = this.makeXterm(reason);
    } catch {
      this.failure.fire(reason);
      return;
    }
    const term = bundle.term;
    const pending = ghostty.drainPending();
    const recent = ghostty.recentOutput();
    const focused = !!ghostty.textarea && ghostty.textarea === ghostty.textarea.ownerDocument.activeElement;
    const { cols, rows } = ghostty;
    this.ghostty = null;
    this.xterm = bundle;
    this.stats.engine = "xterm";
    this.stats.fallback = reason;
    ghostty.dispose();
    // The Ghostty terminal stopped reporting when it was disposed.
    this.untrack = trackStats(this.stats);

    term.resize(cols, rows);
    // Answers xterm gives while it redraws old output were already sent.
    let live = false;
    term.onData((d) => live && this.data.fire(d));
    term.onBinary((d) => live && this.binary.fire(d));
    term.onTitleChange((t) => this.title.fire(t));
    term.onResize((size) => this.resized.fire(size));
    term.onWriteParsed(() => this.parsed.fire());
    term.buffer.onBufferChange(() => this.bufferChanged.fire());
    this.oscHooks.clear();
    for (const id of this.osc.keys()) this.hookOsc(id);
    for (const provider of this.providers.keys()) {
      this.providers.set(provider, term.registerLinkProvider(provider));
    }
    if (this.keyHandler) term.attachCustomKeyEventHandler(this.keyHandler);
    if (this.parent) term.open(this.parent);
    term.write(recent, () => {
      live = true;
      if (focused) term.focus();
    });
    for (const item of pending) term.write(item.bytes, item.callback);
  }

  get cols(): number {
    return this.inner().cols;
  }
  get rows(): number {
    return this.inner().rows;
  }
  get element(): HTMLElement | undefined {
    return this.inner().element;
  }
  get textarea(): HTMLTextAreaElement | undefined {
    return this.inner().textarea;
  }

  onWriteParsed(listener: () => void): Disposable {
    return this.parsed.event(listener);
  }
  open(parent: HTMLElement): void {
    this.parent = parent;
    this.inner().open(parent);
  }
  write(data: string | Uint8Array, callback?: () => void): void {
    if (this.disposed) return;
    this.inner().write(data, callback);
  }
  writeln(data: string | Uint8Array, callback?: () => void): void {
    if (this.disposed) return;
    this.inner().writeln(data, callback);
  }
  input(data: string, wasUserInput?: boolean): void {
    this.inner().input(data, wasUserInput);
  }
  paste(text: string): void {
    this.inner().paste(text);
  }
  focus(): void {
    this.inner().focus();
  }
  reset(): void {
    this.inner().reset();
  }
  clear(): void {
    this.inner().clear();
  }
  resize(cols: number, rows: number): void {
    this.inner().resize(cols, rows);
  }
  refresh(start: number, end: number): void {
    this.inner().refresh(start, end);
  }
  hasSelection(): boolean {
    return this.inner().hasSelection();
  }
  getSelection(): string {
    return this.inner().getSelection();
  }
  selectAll(): void {
    this.inner().selectAll();
  }
  clearSelection(): void {
    this.inner().clearSelection();
  }
  scrollToLine(line: number): void {
    this.inner().scrollToLine(line);
  }
  scrollToBottom(): void {
    this.inner().scrollToBottom();
  }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
    this.keyHandler = handler;
    this.inner().attachCustomKeyEventHandler(handler);
  }
  registerLinkProvider(provider: ILinkProvider): Disposable {
    this.providers.set(provider, this.inner().registerLinkProvider(provider));
    return {
      dispose: () => {
        this.providers.get(provider)?.dispose();
        this.providers.delete(provider);
      },
    };
  }
  proposeDimensions(): { cols: number; rows: number } | undefined {
    return this.xterm ? this.xterm.fit.proposeDimensions() : this.ghostty!.proposeDimensions();
  }
  fit(): void {
    if (this.xterm) this.xterm.fit.fit();
    else this.ghostty!.fit();
  }
  serialize(options?: { scrollback?: number }): string {
    return this.xterm
      ? this.xterm.mouseModes.serialize(this.xterm.serializer, options)
      : this.ghostty!.serialize(options);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.untrack?.();
    this.xterm?.mouseModes.dispose();
    this.inner().dispose();
  }
}

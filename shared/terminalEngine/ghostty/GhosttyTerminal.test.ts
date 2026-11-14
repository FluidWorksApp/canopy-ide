// Runs the real engine (the committed wasm build), not a mock: what these
// assert is what a tab shows.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ghosttyFailure, ghosttyReady, resetGhosttyStateForTests } from "./engine";
import { loadEngineForTests } from "../testEngine";
import { GhosttyTerminal } from "./GhosttyTerminal";

beforeAll(loadEngineForTests);

const parsed = (term: GhosttyTerminal, data: string | Uint8Array = "") =>
  new Promise<void>((resolve) => term.write(data, resolve));

function screenText(term: GhosttyTerminal): string[] {
  const buffer = term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buffer.length; i++) out.push(buffer.getLine(i)!.translateToString(true));
  return out;
}

function opened(options: ConstructorParameters<typeof GhosttyTerminal>[0] = {}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const term = new GhosttyTerminal({ cols: 40, rows: 6, scrollback: 100, ...options });
  term.open(host);
  return { term, host, area: term.textarea! };
}

function key(area: HTMLTextAreaElement, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  area.dispatchEvent(event);
  return event;
}

describe("GhosttyTerminal", () => {
  it("loads the engine", () => {
    expect(ghosttyReady()).toBe(true);
  });

  it("parses output in order and reports it parsed", async () => {
    const term = new GhosttyTerminal({ cols: 20, rows: 4 });
    const order: string[] = [];
    term.onWriteParsed(() => order.push("parsed"));
    term.write("hello ", () => order.push("first"));
    term.write(new TextEncoder().encode("wörld"), () => order.push("second"));
    await parsed(term);
    expect(screenText(term)[0]).toBe("hello wörld");
    expect(order.slice(0, 2)).toEqual(["first", "second"]);
    expect(order).toContain("parsed");
    term.dispose();
  });

  it("is not affected by how the stream is split", async () => {
    const stream = new TextEncoder().encode("\x1b[1;31mred\x1b[0m \u{1F600} tail\r\n\x1b]0;my title\x07done");
    const whole = new GhosttyTerminal({ cols: 30, rows: 4 });
    const split = new GhosttyTerminal({ cols: 30, rows: 4 });
    whole.write(stream);
    for (const byte of stream) split.write(Uint8Array.of(byte));
    await parsed(whole);
    await parsed(split);
    expect(screenText(split)).toEqual(screenText(whole));
    expect(split.serialize()).toBe(whole.serialize());
    whole.dispose();
    split.dispose();
  });

  it("sends the engine's answers back as input", async () => {
    const term = new GhosttyTerminal({ cols: 20, rows: 4 });
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    await parsed(term, "ab\x1b[6n");
    expect(sent).toEqual(["\x1b[1;3R"]);
    term.dispose();
  });

  it("reports title changes once", async () => {
    const term = new GhosttyTerminal();
    const titles: string[] = [];
    term.onTitleChange((title) => titles.push(title));
    await parsed(term, "\x1b]0;one\x07");
    await parsed(term, "x");
    await parsed(term, "\x1b]2;two\x1b\\");
    expect(titles).toEqual(["one", "two"]);
    term.dispose();
  });

  it("hands OSC sequences to their handlers, across chunk boundaries", async () => {
    const term = new GhosttyTerminal();
    const seen: string[] = [];
    term.parser.registerOscHandler(9, (data) => (seen.push(`9:${data}`), true));
    term.parser.registerOscHandler(777, (data) => (seen.push(`777:${data}`), true));
    const gone = term.parser.registerOscHandler(52, (data) => (seen.push(`52:${data}`), true));
    term.write("\x1b]9;build ");
    term.write("done\x07text\x1b]777;notify;Title;Bo");
    term.write("dy\x1b");
    term.write("\\\x1b]52;c;aGk=\x07");
    await parsed(term);
    gone.dispose();
    await parsed(term, "\x1b]52;c;eA==\x07\x1b]1337;ignored\x07");
    expect(seen).toEqual(["9:build done", "777:notify;Title;Body", "52:c;aGk="]);
    expect(screenText(term)[0]).toBe("text");
    term.dispose();
  });

  it("keeps scrollback and holds the view while reading history", async () => {
    const term = new GhosttyTerminal({ cols: 20, rows: 4, scrollback: 50 });
    for (let i = 0; i < 30; i++) term.write(`line ${i}\r\n`);
    await parsed(term);
    const buffer = term.buffer.active;
    expect(buffer.baseY).toBe(27);
    expect(buffer.length).toBe(31);
    expect(buffer.getLine(0)!.translateToString(true)).toBe("line 0");
    expect(buffer.getLine(29)!.translateToString(true)).toBe("line 29");
    expect(buffer.viewportY).toBe(27);
    term.scrollToLine(10);
    expect(buffer.viewportY).toBe(10);
    await parsed(term, "more\r\nmore\r\n");
    expect(buffer.viewportY).toBe(10);
    term.scrollToBottom();
    expect(buffer.viewportY).toBe(buffer.baseY);
    expect(term.buffer.normal.length).toBe(buffer.length);
    expect(term.buffer.alternate.length).toBe(0);
    term.dispose();
  });

  it("caps scrollback at the configured size", async () => {
    const term = new GhosttyTerminal({ cols: 20, rows: 4, scrollback: 10 });
    for (let i = 0; i < 200; i++) term.write(`l${i}\r\n`);
    await parsed(term);
    expect(term.buffer.active.baseY).toBeLessThanOrEqual(10);
    term.dispose();
  });

  it("serializes to escape sequences that rebuild screen, history and modes", async () => {
    const term = new GhosttyTerminal({ cols: 24, rows: 5, scrollback: 100 });
    for (let i = 0; i < 12; i++) term.write(`\x1b[3${i % 8}mrow ${i}\x1b[0m\r\n`);
    term.write("a line that is longer than the terminal is wide\r\n");
    term.write("\x1b[?1000h\x1b[?1006h\x1b[?2004hprompt> ");
    await parsed(term);
    const vt = term.serialize();
    expect(vt.startsWith("\x1bc")).toBe(true);

    const copy = new GhosttyTerminal({ cols: 24, rows: 5, scrollback: 100 });
    const answers: string[] = [];
    copy.onData((data) => answers.push(data));
    await parsed(copy, vt);
    expect(screenText(copy)).toEqual(screenText(term));
    expect(copy.buffer.active.baseY).toBe(term.buffer.active.baseY);
    expect(copy.buffer.active.cursorX).toBe(term.buffer.active.cursorX);
    expect(copy.buffer.active.cursorY).toBe(term.buffer.active.cursorY);
    expect(copy.modes.mouseTrackingMode).toBe("vt200");
    expect(copy.serialize()).toBe(vt);
    // Restoring must not type anything into the shell.
    expect(answers).toEqual([]);

    const tail = term.serialize({ scrollback: 3 });
    const short = new GhosttyTerminal({ cols: 24, rows: 5, scrollback: 100 });
    await parsed(short, tail);
    expect(short.buffer.active.baseY).toBe(3);
    expect(screenText(short).slice(-5)).toEqual(screenText(term).slice(-5));
    for (const t of [term, copy, short]) t.dispose();
  });

  it("serializes a full-screen program on the alternate screen", async () => {
    const term = new GhosttyTerminal({ cols: 20, rows: 4, scrollback: 50 });
    for (let i = 0; i < 8; i++) term.write(`shell ${i}\r\n`);
    term.write("\x1b[?1049h\x1b[2J\x1b[Hfull screen");
    await parsed(term);
    expect(term.buffer.alternate.length).toBe(4);
    expect(term.buffer.active.baseY).toBe(0);
    const copy = new GhosttyTerminal({ cols: 20, rows: 4, scrollback: 50 });
    await parsed(copy, term.serialize());
    expect(screenText(copy)).toEqual(screenText(term));
    // Leaving the program brings the shell's history back.
    await parsed(copy, "\x1b[?1049l");
    expect(copy.buffer.active.getLine(0)!.translateToString(true)).toBe("shell 0");
    for (const t of [term, copy]) t.dispose();
  });

  it("resizes the engine and tells listeners", async () => {
    const term = new GhosttyTerminal({ cols: 20, rows: 4 });
    const sizes: Array<{ cols: number; rows: number }> = [];
    term.onResize((size) => sizes.push(size));
    term.resize(30, 6);
    term.resize(30, 6);
    expect(sizes).toEqual([{ cols: 30, rows: 6 }]);
    await parsed(term, "x".repeat(25));
    expect(screenText(term)[0]).toBe("x".repeat(25));
    term.dispose();
  });

  it("clear keeps the prompt line and drops history; reset drops everything", async () => {
    const term = new GhosttyTerminal({ cols: 20, rows: 4, scrollback: 50 });
    for (let i = 0; i < 10; i++) term.write(`out ${i}\r\n`);
    await parsed(term, "\x1b[32m$\x1b[0m cmd");
    term.clear();
    expect(term.buffer.active.baseY).toBe(0);
    expect(screenText(term)).toEqual(["$ cmd", "", "", ""]);
    expect(term.buffer.active.cursorX).toBe(5);
    await parsed(term, "\x1b[?1000h");
    term.reset();
    expect(screenText(term)).toEqual(["", "", "", ""]);
    expect(term.modes.mouseTrackingMode).toBe("none");
    await parsed(term, "after");
    expect(screenText(term)[0]).toBe("after");
    term.dispose();
  });

  it("selects and copies text, joining rows of one wrapped line", async () => {
    const term = new GhosttyTerminal({ cols: 10, rows: 4, scrollback: 50 });
    await parsed(term, "0123456789abcde\r\nnext   \r\n");
    expect(term.hasSelection()).toBe(false);
    term.selectAll();
    expect(term.hasSelection()).toBe(true);
    expect(term.getSelection().replace(/\n+$/, "")).toBe("0123456789abcde\nnext");
    term.clearSelection();
    expect(term.getSelection()).toBe("");
    term.dispose();
  });

  it("encodes keys by the modes the program set", async () => {
    const { term, area } = opened();
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    expect(key(area, { key: "ArrowUp", code: "ArrowUp" }).defaultPrevented).toBe(true);
    key(area, { key: "a", code: "KeyA" });
    key(area, { key: "A", code: "KeyA", shiftKey: true });
    key(area, { key: "c", code: "KeyC", ctrlKey: true });
    key(area, { key: "Enter", code: "Enter" });
    key(area, { key: "Tab", code: "Tab", shiftKey: true });
    await parsed(term, "\x1b[?1h");
    key(area, { key: "ArrowUp", code: "ArrowUp" });
    expect(sent).toEqual(["\x1b[A", "a", "A", "\x03", "\r", "\x1b[Z", "\x1bOA"]);
    // Command chords belong to the app.
    expect(key(area, { key: "k", code: "KeyK", metaKey: true }).defaultPrevented).toBe(false);
    expect(sent).toHaveLength(7);
    term.dispose();
  });

  it("lets the app's key handler take a key first", () => {
    const { term, area } = opened();
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    term.attachCustomKeyEventHandler((ev) => ev.key !== "Escape");
    key(area, { key: "Escape", code: "Escape" });
    key(area, { key: "x", code: "KeyX" });
    expect(sent).toEqual(["x"]);
    term.dispose();
  });

  it("leaves a key alone while an input method composes", () => {
    const { term, area } = opened();
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    expect(key(area, { key: "a", code: "KeyA", isComposing: true }).defaultPrevented).toBe(false);
    area.dispatchEvent(new CompositionEvent("compositionstart"));
    area.dispatchEvent(new CompositionEvent("compositionend", { data: "日本" }));
    expect(sent).toEqual(["日本"]);
    term.dispose();
  });

  it("pastes bracketed when asked, and never lets a paste type escapes", async () => {
    const { term } = opened();
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    term.paste("one\ntwo\x1b[201~");
    await parsed(term, "\x1b[?2004h");
    term.paste("one\ntwo");
    term.input("typed");
    expect(sent).toEqual(["one\rtwo[201~", "\x1b[200~one\ntwo\x1b[201~", "typed"]);
    term.dispose();
  });

  it("reports the mouse only when the program tracks it", async () => {
    const { term, host } = opened();
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    const root = host.firstElementChild as HTMLElement;
    const down = () => root.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    const up = () => document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    down();
    up();
    expect(sent).toEqual([]);
    await parsed(term, "\x1b[?1000h\x1b[?1006h");
    down();
    up();
    expect(sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;1;1m"]);
    // Shift is the gesture that selects text instead.
    root.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
    up();
    expect(sent).toHaveLength(2);
    term.dispose();
  });

  it("opens a clicked link even while the program tracks the mouse", async () => {
    const activate = vi.fn();
    const { term, host } = opened({ webLinks: { activate } });
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    const root = host.firstElementChild as HTMLElement;
    const move = () => root.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    const down = () => root.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    const up = () => document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    await parsed(term, "https://example.test/pull/596 done");
    move();
    down();
    up();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0][1]).toBe("https://example.test/pull/596");

    // An agent's screen tracks the mouse. The program still gets the click,
    // and the link under it still opens.
    await parsed(term, "\x1b[?1000h\x1b[?1006h");
    move();
    down();
    up();
    expect(sent).toEqual(["\x1b[<0;1;1M", "\x1b[<0;1;1m"]);
    expect(activate).toHaveBeenCalledTimes(2);
    term.dispose();
  });

  it("answers the copy command with the selection", async () => {
    // The real event targets the focused textarea and bubbles up.
    const { term, area } = opened();
    const copy = () => {
      const data = new Map<string, string>();
      const event = new Event("copy", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: { setData: (type: string, text: string) => data.set(type, text) },
      });
      area.dispatchEvent(event);
      return { event, text: data.get("text/plain") };
    };
    await parsed(term, "hello");
    // Nothing selected: the command is left alone.
    expect(copy().event.defaultPrevented).toBe(false);
    term.selectAll();
    const done = copy();
    expect(done.event.defaultPrevented).toBe(true);
    expect(done.text?.trim()).toBe("hello");
    term.dispose();
  });

  it("reports focus when the program asked", async () => {
    const { term, area } = opened();
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    area.dispatchEvent(new FocusEvent("focus"));
    area.dispatchEvent(new FocusEvent("blur"));
    await parsed(term, "\x1b[?1004h");
    area.dispatchEvent(new FocusEvent("focus"));
    area.dispatchEvent(new FocusEvent("blur"));
    expect(sent).toEqual(["\x1b[I", "\x1b[O"]);
    term.dispose();
  });

  it("sends nothing when input is disabled", async () => {
    const { term, area } = opened({ disableStdin: true });
    const sent: string[] = [];
    term.onData((data) => sent.push(data));
    key(area, { key: "a", code: "KeyA" });
    term.paste("x");
    term.input("y");
    await parsed(term, "\x1b[6n");
    expect(sent).toEqual([]);
    term.dispose();
  });

  it("proposes no size while it is not laid out", () => {
    const { term } = opened();
    expect(term.proposeDimensions()).toBeUndefined();
    term.dispose();
  });

  it("rebuilds the screen from recent output when the engine fails", async () => {
    const term = new GhosttyTerminal({ cols: 20, rows: 4 });
    const failures: string[] = [];
    term.onEngineFailure((reason) => failures.push(reason));
    await parsed(term, "before\r\n");
    const engine = (term as unknown as { wasm: { advance: (b: Uint8Array) => void } }).wasm;
    const spy = vi.spyOn(engine, "advance").mockImplementationOnce(() => {
      throw new WebAssembly.RuntimeError("unreachable");
    });
    await parsed(term, "after");
    spy.mockRestore();
    expect(screenText(term).slice(0, 2)).toEqual(["before", "after"]);
    expect(term.stats.recoveries).toBe(1);
    expect(failures).toEqual([]);
    expect(ghosttyFailure()).toBe("engine-trap");
    resetGhosttyStateForTests();
    await parsed(term, " more");
    expect(screenText(term)[1]).toBe("after more");
    term.dispose();
  });

  it("stops quietly after dispose", async () => {
    const term = new GhosttyTerminal();
    term.dispose();
    term.write("x");
    term.resize(10, 10);
    term.dispose();
    expect(term.hasSelection()).toBe(false);
  });
});

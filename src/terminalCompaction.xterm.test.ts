import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

const publicState = (term: Terminal) => {
  const readBuffer = (buffer: Terminal["buffer"]["normal"]) => ({
    type: buffer.type,
    length: buffer.length,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    baseY: buffer.baseY,
    viewportY: buffer.viewportY,
    lines: Array.from({ length: buffer.length }, (_, row) => {
      const line = buffer.getLine(row);
      return {
        wrapped: line?.isWrapped ?? false,
        text: line?.translateToString(false) ?? "",
        cells: Array.from({ length: term.cols }, (_, col) => {
          const cell = line?.getCell(col);
          return cell
            ? {
                chars: cell.getChars(),
                width: cell.getWidth(),
                fgMode: cell.getFgColorMode(),
                fg: cell.getFgColor(),
                bgMode: cell.getBgColorMode(),
                bg: cell.getBgColor(),
                bold: cell.isBold(),
                italic: cell.isItalic(),
                underline: cell.isUnderline(),
              }
            : null;
        }),
      };
    }),
  });
  return {
    cols: term.cols,
    rows: term.rows,
    active: term.buffer.active.type,
    normal: readBuffer(term.buffer.normal),
    alternate: readBuffer(term.buffer.alternate),
    modes: {
      applicationCursorKeysMode: term.modes.applicationCursorKeysMode,
      applicationKeypadMode: term.modes.applicationKeypadMode,
      bracketedPasteMode: term.modes.bracketedPasteMode,
      insertMode: term.modes.insertMode,
      mouseTrackingMode: term.modes.mouseTrackingMode,
      originMode: term.modes.originMode,
      reverseWraparoundMode: term.modes.reverseWraparoundMode,
      sendFocusMode: term.modes.sendFocusMode,
      wraparoundMode: term.modes.wraparoundMode,
    },
  };
};

describe("xterm serialization fidelity used by idle compaction", () => {
  it("round-trips the configured 5,000-row scrollback at its retention limit", async () => {
    const term = new Terminal({ cols: 24, rows: 24, scrollback: 5_000 });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    const output = Array.from(
      { length: 5_100 },
      (_, index) => `line-${index.toString().padStart(4, "0")}\r\n`,
    ).join("");
    await write(term, output);
    expect(term.buffer.normal.length).toBe(5_024);
    const snapshot = serializer.serialize({ scrollback: 5_000 });

    term.reset();
    term.clear();
    expect(term.buffer.normal.length).toBe(24);
    await write(term, snapshot);

    expect(term.buffer.normal.length).toBe(5_024);
    expect(serializer.serialize({ scrollback: 5_000 })).toBe(snapshot);
    term.dispose();
  });

  it("round-trips full normal scrollback, Unicode, attributes and modes", async () => {
    const term = new Terminal({ cols: 16, rows: 3, scrollback: 10 });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    await write(
      term,
      "one\r\ntwo\r\nwrapped-界🙂-content\r\n\u001b[1;3;31mred界🙂\u001b[0m\r\nfour\u001b[?2004h\u001b[2D",
    );
    term.scrollToLine(1);
    const snapshot = serializer.serialize({ scrollback: 10 });
    const before = publicState(term);
    const viewportY = term.buffer.active.viewportY;
    const rowsBefore = term.buffer.normal.length;
    expect(rowsBefore).toBeGreaterThan(term.rows);
    expect(before.normal.lines.some((line) => line.wrapped)).toBe(true);
    expect(term.modes.bracketedPasteMode).toBe(true);

    term.reset();
    term.clear();
    expect(term.buffer.normal.length).toBe(term.rows);
    await write(term, snapshot);
    term.scrollToLine(viewportY);

    expect(serializer.serialize({ scrollback: 10 })).toBe(snapshot);
    expect(publicState(term)).toEqual(before);
    expect(term.buffer.normal.length).toBe(rowsBefore);
    expect(term.modes.bracketedPasteMode).toBe(true);
    term.dispose();
  });

  it("round-trips the alternate screen without corrupting normal history", async () => {
    const term = new Terminal({ cols: 14, rows: 3, scrollback: 10 });
    const serializer = new SerializeAddon();
    term.loadAddon(serializer);
    await write(term, "shell-history\r\n\u001b[?1049h\u001b[Hfull-screen");
    expect(term.buffer.active.type).toBe("alternate");
    const snapshot = serializer.serialize({ scrollback: 10 });
    const before = publicState(term);

    term.reset();
    term.clear();
    await write(term, snapshot);

    expect(term.buffer.active.type).toBe("alternate");
    expect(serializer.serialize({ scrollback: 10 })).toBe(snapshot);
    expect(publicState(term)).toEqual(before);
    term.dispose();
  });
});

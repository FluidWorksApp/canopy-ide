// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { lastPaintedLine, renderPtyText } from "./ptyText";

describe("renderPtyText", () => {
  it("gives back what the terminal painted, not the bytes it was sent", async () => {
    // Colour, a cursor move, and a carriage return overwriting a spinner — the
    // three things a regex strip gets wrong and a terminal parser gets right.
    const raw =
      "\x1b[32mBuilding…\x1b[0m\r\n" +
      "⠋ working\r⠙ working\r\x1b[2Kdone\r\n" +
      "\x1b[1mJOB DONE\x1b[0m: 2 blocking, 1 nit\r\n";
    const text = await renderPtyText(raw, { cols: 40, rows: 10 });
    expect(text).toContain("Building…");
    expect(text).toContain("JOB DONE: 2 blocking, 1 nit");
    // The overwritten spinner frames are gone; only the line as it ended remains.
    expect(text).toContain("done");
    expect(text).not.toContain("⠋");
    expect(text).not.toContain("\x1b[");
  });

  it("keeps the tail, which is the part a finished task is judged on", async () => {
    const raw = Array.from({ length: 400 }, (_, i) => `line ${i}\r\n`).join("");
    const text = await renderPtyText(raw, { cols: 40, rows: 10, maxChars: 200 });
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toContain("line 399");
    expect(text).not.toContain("line 1\n");
  });

  it("survives an empty run rather than throwing on it", async () => {
    expect(await renderPtyText("")).toBe("");
  });

  it("reads the same buffer twice without the first run leaking into the second", async () => {
    await renderPtyText("first run only\r\n", { cols: 40, rows: 10 });
    const second = await renderPtyText("second run\r\n", { cols: 40, rows: 10 });
    expect(second).toContain("second run");
    expect(second).not.toContain("first run only");
  });
});

describe("lastPaintedLine", () => {
  it("takes the last line with anything on it", () => {
    expect(lastPaintedLine("a\nb\n\n  \n")).toBe("b");
    expect(lastPaintedLine("")).toBe("");
  });
});

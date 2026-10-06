import { afterEach, expect, it, vi } from "vitest";

const terminals = vi.hoisted(() => [] as {
  text: string;
  done: () => void;
  dispose: ReturnType<typeof vi.fn>;
}[]);
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    text = "";
    done = () => {};
    dispose = vi.fn();
    buffer = { active: { length: 1, getLine: () => ({ translateToString: () => this.text }) } };
    constructor() { terminals.push(this); }
    write(text: string, done: () => void) { this.text = text; this.done = done; }
  },
}));
import { renderPtyText } from "./ptyText";

afterEach(() => { terminals.length = 0; vi.useRealTimers(); });

it("serializes concurrent captures and disposes their cell graphs", async () => {
  const first = renderPtyText("first");
  const second = renderPtyText("second");
  expect(terminals).toHaveLength(1);
  terminals[0].done();
  expect(await first).toBe("first");
  expect(terminals[0].dispose).toHaveBeenCalledTimes(1);
  await Promise.resolve();
  expect(terminals).toHaveLength(2);
  terminals[1].done();
  expect(await second).toBe("second");
  expect(terminals[1].dispose).toHaveBeenCalledTimes(1);
});

it("disposes a wedged parser and ignores its late callback", async () => {
  vi.useFakeTimers();
  const first = renderPtyText("first");
  const second = renderPtyText("second");
  await vi.advanceTimersByTimeAsync(2000);
  expect(await first).toBe("first");
  expect(terminals[0].dispose).toHaveBeenCalledTimes(1);
  expect(terminals).toHaveLength(2);
  terminals[0].done();
  terminals[1].done();
  expect(await second).toBe("second");
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds a burst of queued captures and their total input bytes", async () => {
  vi.useFakeTimers();
  const captures = Array.from({ length: 20 }, (_, i) => renderPtyText(`capture ${i}`));
  expect(await captures[19]).toBe("capture 19");
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await Promise.all(captures)).toHaveLength(20);
  expect(terminals).toHaveLength(9); // one active plus eight queued
  terminals.length = 0;
  const raw = "x".repeat(1024 * 1024);
  const large = Array.from({ length: 8 }, () => renderPtyText(raw));
  expect(await large[7]).toHaveLength(8000);
  await vi.advanceTimersByTimeAsync(8000);
  await Promise.all(large);
  expect(terminals).toHaveLength(3); // one active plus 4 MiB queued
});

it("refuses oversized input and geometry before allocating a terminal", async () => {
  expect(await renderPtyText("x".repeat(2 * 1024 * 1024))).toHaveLength(8000);
  expect(await renderPtyText("tail", { cols: 65_535 })).toBe("tail");
  expect(await renderPtyText("tail", { rows: NaN })).toBe("tail");
  expect(await renderPtyText("tail", { maxChars: 0 })).toBe("");
  expect(terminals).toHaveLength(0);
});

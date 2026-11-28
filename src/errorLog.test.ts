import { describe, expect, it, vi } from "vitest";
import { forwardConsole } from "./errorLog";

const fakeConsole = () => ({ warn: vi.fn(), error: vi.fn() });

describe("forwardConsole", () => {
  it("still prints, and forwards warnings and errors as one short line", () => {
    const target = fakeConsole();
    const printed = target.warn;
    const write = vi.fn();
    forwardConsole(write, target);
    target.warn("[all] could not read", new Error("timed out"), { id: 3 });
    target.error("boom\n  at x");
    expect(printed).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenNthCalledWith(1, "warn", '[all] could not read timed out {"id":3}');
    expect(write).toHaveBeenNthCalledWith(2, "error", "boom at x");
  });

  it("cuts long lines and drops a repeat of the last one", () => {
    const target = fakeConsole();
    const write = vi.fn();
    forwardConsole(write, target);
    target.warn("x".repeat(5000));
    target.warn("x".repeat(5000));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][1]).toHaveLength(600);
  });

  it("keeps to a budget a minute", () => {
    const target = fakeConsole();
    const write = vi.fn();
    let t = 0;
    forwardConsole(write, target, () => t);
    for (let i = 0; i < 100; i++) target.warn(`line ${i}`);
    expect(write).toHaveBeenCalledTimes(30);
    t = 60_000;
    target.warn("later");
    expect(write).toHaveBeenCalledTimes(31);
    // The same failure again, a minute on, is written again.
    target.warn("later");
    t = 120_000;
    target.warn("later");
    expect(write).toHaveBeenCalledTimes(32);
  });

  it("does not forward what forwarding itself warns, and can be undone", () => {
    const target = fakeConsole();
    const original = target.warn;
    const write = vi.fn(() => target.warn("inner"));
    const undo = forwardConsole(write, target);
    target.warn("outer");
    expect(write).toHaveBeenCalledTimes(1);
    undo();
    expect(target.warn).toBe(original);
  });
});

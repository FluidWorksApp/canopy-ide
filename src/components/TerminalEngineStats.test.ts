import { describe, expect, it } from "vitest";
import { newStats } from "../../shared/terminalEngine/stats";
import { statsLines } from "./TerminalEngineStats";

const zero = { bytes: 0, paints: 0, parseMs: 0, paintMs: 0 };
const ghostty = (over: object) => ({ ...newStats("ghostty"), cols: 80, rows: 24, ...over });

describe("statsLines", () => {
  it("rates the parse over the last sample, not since the terminal opened", () => {
    // Lifetime: 1 MiB in 1000 ms = 1 MB/s. Last second: 4 MiB in 100 ms = 40 MB/s.
    const stats = ghostty({ bytes: 5 * 1048576, parseMs: 1100, paints: 20, paintMs: 40 });
    const prev = { bytes: 1048576, paints: 0, parseMs: 1000, paintMs: 0 };
    expect(statsLines(stats, prev, 1, 0)[2]).toContain("parses 40.0 MB/s");
  });

  it("says idle, not a stale number, when nothing was parsed", () => {
    const stats = ghostty({ bytes: 1048576, parseMs: 50, paints: 3, paintMs: 3 });
    const prev = { bytes: 1048576, paints: 3, parseMs: 50, paintMs: 3 };
    const lines = statsLines(stats, prev, 1, 0);
    expect(lines[2]).toContain("parses idle");
    expect(lines[3]).toBe("paint idle");
  });

  it("averages paint cost over the window", () => {
    const stats = ghostty({ bytes: 10, parseMs: 1, paints: 10, paintMs: 20, lastPaintMs: 9 });
    expect(statsLines(stats, zero, 1, 0)[3]).toBe("paint 2.0 ms avg, 9.0 last · 10 paints/s");
  });
});

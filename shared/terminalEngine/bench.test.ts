import { beforeAll, describe, expect, it } from "vitest";
import { formatBenchmark, runTerminalBenchmark, workload } from "./bench";
import { loadEngineForTests } from "./testEngine";

beforeAll(async () => {
  // jsdom has no matchMedia, which xterm asks for when it opens.
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  await loadEngineForTests();
});

describe("terminal benchmark", () => {
  it("generates the same output every time", () => {
    const a = workload(20000).join("");
    expect(a).toBe(workload(20000).join(""));
    expect(a.length).toBeGreaterThanOrEqual(20000);
    expect(a).toContain("\x1b[");
    expect(a).toContain("日本語");
  });

  it("runs on both engines and reports every number", async () => {
    const seen: string[] = [];
    const results = await runTerminalBenchmark(
      { bytes: 200000, chunk: 16384, echoes: 3, cols: 80, rows: 24, runs: 2 },
      (engine) => seen.push(engine),
    );
    // A warm-up for each, then alternating measured runs.
    expect(seen).toEqual(["ghostty", "xterm", "ghostty", "xterm", "ghostty", "xterm"]);
    expect(results.map((r) => r.ran)).toEqual(["ghostty", "xterm"]);
    for (const r of results) {
      expect(r.runs).toBe(2);
      expect(r.bytes).toBeGreaterThanOrEqual(200000);
      expect(r.dumpMBps).toBeGreaterThan(0);
      expect(Number.isFinite(r.echoP95)).toBe(true);
    }
    expect(results[0].engineMB).toBeGreaterThan(0);
    const text = formatBenchmark(results);
    expect(text[0]).toContain("median of 2 runs");
    expect(text.some((l) => l.startsWith("xterm:"))).toBe(true);
    expect(Math.max(...text.map((l) => l.length))).toBeLessThan(100);
  }, 60000);

  it("counts UTF-8 bytes, not characters", async () => {
    const [ghostty] = await runTerminalBenchmark({ bytes: 5000, chunk: 1000, echoes: 1, runs: 1 });
    const chars = workload(5000).join("");
    expect(ghostty.bytes).toBe(new TextEncoder().encode(chars).length);
    expect(ghostty.bytes).toBeGreaterThan(chars.length);
  }, 60000);
});

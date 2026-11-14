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
      { bytes: 200000, chunk: 16384, echoes: 3, cols: 80, rows: 24 },
      (engine) => seen.push(engine),
    );
    expect(seen).toEqual(["ghostty", "xterm", "ghostty"]);
    expect(results.map((r) => r.ran)).toEqual(["ghostty", "xterm", "ghostty"]);
    for (const r of results) {
      expect(r.bytes).toBeGreaterThanOrEqual(200000);
      expect(r.dumpMs).toBeGreaterThan(0);
      expect(r.dumpMBps).toBeGreaterThan(0);
      expect(Number.isFinite(r.echoP95)).toBe(true);
    }
    expect(results[0].engineMB).toBeGreaterThan(0);
    const text = formatBenchmark(results);
    expect(text).toHaveLength(4);
    expect(text[2]).toMatch(/^xterm/);
  }, 60000);
});

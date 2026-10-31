import { describe, expect, it } from "vitest";
import { loadSample } from "./resourceChip";

const GB = 1024 ** 3;

describe("the status bar graph's samples", () => {
  it("uses the workspace's own cores and memory limit", () => {
    const s = loadSample(
      { cpu: 90, mem_bytes: 9 * GB, procs: 0, includes_webviews: true, workspace: { available: true, memoryLimitBytes: 16 * GB, cpus: 8, workingSetBytes: 4 * GB, cpusUsed: 2 } },
      4,
    );
    expect(s).toEqual({ cpu: 0.25, mem: 0.25 });
  });

  it("on a desktop, shares Canopy's CPU over the cores and reads the computer's memory", () => {
    const s = loadSample({ cpu: 200, mem_bytes: GB, procs: 3, includes_webviews: true, system: { availableBytes: 12 * GB, totalBytes: 16 * GB } }, 8);
    expect(s).toEqual({ cpu: 0.25, mem: 0.25 });
  });

  it("leaves out what isn't reported, and never draws past the edges", () => {
    expect(loadSample({ cpu: Number.NaN, mem_bytes: GB, procs: 1, includes_webviews: true }, 4)).toEqual({ cpu: null, mem: null });
    expect(loadSample({ cpu: 900, mem_bytes: GB, procs: 1, includes_webviews: true }, 4).cpu).toBe(1);
  });
});

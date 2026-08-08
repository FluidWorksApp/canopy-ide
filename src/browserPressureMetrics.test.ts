import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { browserPressureReloadMetrics } from "./browserPressureMetrics";

describe("preview pressure reload diagnostics", () => {
  beforeEach(() => invoke.mockReset());

  it("uses the read-only native scalar metrics command", async () => {
    invoke.mockResolvedValue({ enabled: true, decisions: 0, targets: 0 });
    await browserPressureReloadMetrics();
    expect(invoke).toHaveBeenCalledWith("browser_pressure_reload_metrics");
  });

  it("keeps the diagnostics command in the native invoke registry", () => {
    expect(readFileSync("src-tauri/src/lib.rs", "utf8")).toContain(
      "browser::browser_pressure_reload_metrics,",
    );
  });
});

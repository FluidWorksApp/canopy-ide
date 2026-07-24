import { describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { mockCommands } from "./setup";

// Proves the shared Tauri IPC mock (src/test/setup.ts) that component tests
// lean on: registered commands return their stubbed value, and anything
// unregistered fails loudly rather than hanging on a backend that isn't there.

describe("mockCommands harness", () => {
  it("returns a stubbed value for a registered command", async () => {
    mockCommands({ which_check: { claude: true, codex: false } });
    await expect(invoke("which_check")).resolves.toEqual({ claude: true, codex: false });
  });

  it("passes the invoke args to a handler function", async () => {
    mockCommands({
      store_save: (args: Record<string, unknown>) => `saved:${(args as { data: string }).data}`,
    });
    await expect(invoke("store_save", { data: "x" })).resolves.toBe("saved:x");
  });

  it("throws on an unmocked command instead of hanging", async () => {
    mockCommands({ which_check: {} });
    await expect(invoke("some_other_cmd")).rejects.toThrow(/Unmocked Tauri command/);
  });
});

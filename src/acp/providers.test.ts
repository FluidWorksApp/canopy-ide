import { afterEach, describe, expect, it } from "vitest";
import {
  ACP_PRESETS,
  customAcpRunner,
  joinArgv,
  sanitizeAcpConfig,
  splitArgv,
} from "./providers";
import { AGENT_CLIS, refreshAgentClis, structuredRunnerFor } from "../projects";
import { getSettings, updateSettings } from "../settings";

afterEach(() => {
  localStorage.clear();
  updateSettings({ customClis: [] });
  refreshAgentClis();
});

describe("sanitizeAcpConfig", () => {
  it("keeps argv arrays and valid env", () => {
    expect(sanitizeAcpConfig({ args: ["--acp"], env: { A_B: "1" } })).toEqual({
      args: ["--acp"],
      env: { A_B: "1" },
    });
  });
  it("rejects non-objects and non-array args", () => {
    expect(sanitizeAcpConfig(null)).toBeUndefined();
    expect(sanitizeAcpConfig("--acp")).toBeUndefined();
    expect(sanitizeAcpConfig({ args: "--acp" })).toBeUndefined();
  });
  it("drops non-string args, bad env names and NUL bytes", () => {
    expect(sanitizeAcpConfig({ args: ["a", 1, "b\0"], env: { "bad name": "x", OK: "y" } })).toEqual({
      args: ["a"],
      env: { OK: "y" },
    });
  });
});

describe("argv text", () => {
  it("round-trips quoted groups without a shell", () => {
    expect(splitArgv(`--acp --name "two words" 'x y'`)).toEqual(["--acp", "--name", "two words", "x y"]);
    expect(splitArgv(joinArgv(["--acp", "two words"]))).toEqual(["--acp", "two words"]);
    expect(splitArgv("$(rm -rf /)")).toEqual(["$(rm", "-rf", "/)"]);
  });
});

describe("custom CLI -> ACP runner", () => {
  it("builds an acp-tier runner from the stored args", () => {
    const r = customAcpRunner("x", "X", "x-bin", { args: ["--acp"] });
    expect(r.tier).toBe("acp");
    expect(r.dialect).toBe("acp");
    expect(r.verification.checkedOn).toBe("unverified");
  });

  it("registers a custom entry with acp args as an ACP agent", () => {
    updateSettings({
      customClis: [
        { id: "my-agent", name: "My Agent", bin: "my-agent", acp: { args: ["--acp"] } },
        { id: "plain", name: "Plain", bin: "plain-bin" },
      ],
    });
    refreshAgentClis();
    const runner = structuredRunnerFor("my-agent");
    expect(runner?.tier).toBe("acp");
    expect(runner?.args({ bin: "my-agent", policy: {} as never })).toEqual(["--acp"]);
    expect(structuredRunnerFor("plain")).toBeUndefined();
    expect(AGENT_CLIS.find((c) => c.id === "my-agent")?.custom).toBe(true);
  });

  it("sanitises a corrupt stored acp block back to a plain CLI", () => {
    localStorage.setItem(
      "canopy.settings",
      JSON.stringify({ customClis: [{ id: "a", name: "A", bin: "a", acp: { args: "nope" } }, 5] }),
    );
    // The storage key is an implementation detail: fall back to the API.
    updateSettings({ customClis: [{ id: "a", name: "A", bin: "a", acp: { args: "nope" } as never }] });
    expect(getSettings().customClis[0].acp).toBeUndefined();
  });
});

describe("presets", () => {
  it("are dated and sourced", () => {
    for (const p of ACP_PRESETS) {
      expect(p.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.source).not.toBe("");
      expect(p.args.length).toBeGreaterThan(0);
    }
    expect(ACP_PRESETS.find((p) => p.bin === "gemini")?.args).toEqual(["--acp"]);
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  probeCli,
  probeCliVersion,
  type CliProbeDeps,
  type CliProbeRunResult,
} from "./vibeCliProbe";

const result = (
  overrides: Partial<CliProbeRunResult> = {},
): CliProbeRunResult => ({
  exitCode: 0,
  output: "1.2.3\n",
  timedOut: false,
  ...overrides,
});

const harness = (run: () => Promise<CliProbeRunResult>) => {
  const runArgv = vi.fn(run);
  const deps: CliProbeDeps = { runArgv };
  return { deps, runArgv };
};

describe("vibe CLI probes", () => {
  it("passes the version probe as argv and reports a CLI on PATH", async () => {
    const { deps, runArgv } = harness(async () => result());

    await expect(probeCli("vercel", deps)).resolves.toBe(true);
    expect(runArgv).toHaveBeenCalledWith({ argv: ["vercel", "--version"] });
  });

  it("returns trimmed observed version output", async () => {
    const { deps } = harness(async () => result({ output: "wrangler 4.2.1\r\n" }));

    await expect(probeCliVersion("wrangler", deps)).resolves.toBe("wrangler 4.2.1");
  });

  it("treats non-zero exits and timeouts as absent", async () => {
    const failed = harness(async () => result({ exitCode: 127 }));
    const timedOut = harness(async () => result({ timedOut: true }));

    await expect(probeCli("netlify", failed.deps)).resolves.toBe(false);
    await expect(probeCliVersion("netlify", failed.deps)).resolves.toBeNull();
    await expect(probeCli("flyctl", timedOut.deps)).resolves.toBe(false);
    await expect(probeCliVersion("flyctl", timedOut.deps)).resolves.toBeNull();
  });

  it("turns execution errors into conservative absent results", async () => {
    const { deps } = harness(async () => {
      throw new Error("spawn failed");
    });

    await expect(probeCli("supabase", deps)).resolves.toBe(false);
    await expect(probeCliVersion("supabase", deps)).resolves.toBeNull();
  });

  it("caches only for the lifetime of the call-site deps instance", async () => {
    const first = harness(async () => result({ output: "stripe 1.0.0" }));
    const second = harness(async () => result({ output: "stripe 2.0.0" }));

    await expect(probeCli("stripe", first.deps)).resolves.toBe(true);
    await expect(probeCliVersion("stripe", first.deps)).resolves.toBe("stripe 1.0.0");
    expect(first.runArgv).toHaveBeenCalledTimes(1);

    await expect(probeCliVersion("stripe", second.deps)).resolves.toBe("stripe 2.0.0");
    expect(second.runArgv).toHaveBeenCalledTimes(1);
  });
});

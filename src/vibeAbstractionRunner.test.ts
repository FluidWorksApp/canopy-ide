// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  runAbstractionPlan,
  type AbstractionPtyExit,
  type AbstractionRunnerDeps,
} from "./vibeAbstractionRunner";

const join = (...parts: string[]) => parts.join("");

function harness(
  options: { exitCode?: number | null; output?: string; exit?: boolean; timeoutMs?: number } = {},
) {
  let listener: ((event: AbstractionPtyExit) => void) | null = null;
  const ptySpawnDetached = vi.fn(async () => {
    if (options.exit !== false) {
      queueMicrotask(() => listener?.({ id: 17, exit_code: options.exitCode ?? 0 }));
    }
    return { id: 17 };
  });
  const ptyKill = vi.fn(async () => {});
  const deps: AbstractionRunnerDeps = {
    ptySpawnDetached,
    onPtyExit: vi.fn(async (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    }),
    ptyOutput: vi.fn(async () => options.output ?? ""),
    ptyKill,
    timeoutMs: options.timeoutMs,
  };
  return { deps, ptySpawnDetached, ptyKill };
}

describe("runAbstractionPlan", () => {
  it("passes the plan to the process boundary as argv, unchanged", async () => {
    const { deps, ptySpawnDetached } = harness();
    const argv = ["npm", "install", "safe; still-one-argument"];

    await runAbstractionPlan(argv, "/project", deps);

    expect(ptySpawnDetached).toHaveBeenCalledWith({ cwd: "/project", argv });
  });

  it("returns a non-zero exit as a failure with its exit code", async () => {
    const { deps } = harness({ exitCode: 23, output: "install failed\r\n" });

    const result = await runAbstractionPlan(["npm", "install"], "/project", deps);

    expect(result).toMatchObject({
      ok: false,
      exitCode: 23,
      timedOut: false,
    });
    expect(result.output).toContain("install failed");
  });

  it("times out, reports the timeout, and kills the process", async () => {
    vi.useFakeTimers();
    try {
      const { deps, ptyKill } = harness({ exit: false, timeoutMs: 50 });
      const result = runAbstractionPlan(["vercel"], "/project", deps);

      await vi.advanceTimersByTimeAsync(50);

      await expect(result).resolves.toMatchObject({
        ok: false,
        exitCode: null,
        timedOut: true,
      });
      expect(ptyKill).toHaveBeenCalledWith(17);
    } finally {
      vi.useRealTimers();
    }
  });

  it("redacts credentials from captured output", async () => {
    const credential = join("sk", "_live_", "q".repeat(24));
    const { deps } = harness({ output: `linked with ${credential}\r\n` });

    const result = await runAbstractionPlan(["stripe", "listen"], "/project", deps);

    expect(result.output).not.toContain(credential);
    expect(result.output).toContain("[redacted by Canopy: stripe-secret-key]");
  });
});

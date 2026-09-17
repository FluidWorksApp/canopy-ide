import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { mockCommands } from "../../../test/setup";
import { useCliLauncher } from "./useCliLauncher";

vi.mock("../../../projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../projects")>()),
  // Version probing is its own subsystem; this suite is about install state.
  checkCliUpdates: vi.fn(async () => ({})),
}));

afterEach(() => {
  vi.useRealTimers();
});

describe("useCliLauncher install probe", () => {
  it("never reports a failed probe as missing tools, and retries it", async () => {
    vi.useFakeTimers();
    let calls = 0;
    mockCommands({
      which_check: (args: Record<string, unknown>) => {
        calls += 1;
        // The first round (CLIs and prerequisites) is refused, as the backend
        // does when its capture queue is full.
        if (calls <= 2) throw new Error("process capture admission queue is full");
        const commands = args.commands as string[];
        return Object.fromEntries(commands.map((c) => [c, true]));
      },
    });

    const { result } = renderHook(() => useCliLauncher());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Unknown, not false: no banner, no install badges.
    expect(result.current.prereqs).toEqual({});
    expect(result.current.installed).toEqual({});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(result.current.prereqs).toEqual({ git: true, node: true });
    expect(result.current.installed.claude).toBe(true);
  });
});

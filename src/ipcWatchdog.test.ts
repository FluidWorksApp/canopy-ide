import { afterEach, expect, it, vi } from "vitest";
import { installEarlyWatchdogHeartbeat, ptyRendererRegister } from "./ipc";
import { mockCommands } from "./test/setup";

afterEach(() => vi.useRealTimers());

it("acknowledges liveness from the renderer without a native event listener", async () => {
  vi.useFakeTimers();
  const generations: unknown[] = [];
  mockCommands({
    pty_renderer_register: () => ({ generation: 7, sessions: [] }),
    watchdog_ack: ({ generation }: { generation?: unknown }) => {
      generations.push(generation);
    },
  });
  await ptyRendererRegister();

  const stop = await installEarlyWatchdogHeartbeat();
  expect(generations).toEqual([7]);
  await vi.advanceTimersByTimeAsync(9_000);
  expect(generations).toEqual([7, 7, 7, 7]);

  stop();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(generations).toHaveLength(4);
});

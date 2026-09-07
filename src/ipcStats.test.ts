import { afterEach, expect, it, vi } from "vitest";
import { onAppStats, onPtyStats, type AppStats } from "./ipc";
import { mockCommands } from "./test/setup";

afterEach(() => vi.useRealTimers());

it("pulls shared resource stats without native event listeners", async () => {
  vi.useFakeTimers();
  let ptyPulls = 0;
  let appPulls = 0;
  const app: AppStats = {
    cpu: 2,
    mem_bytes: 3,
    procs: 4,
    includes_webviews: false,
  };
  mockCommands({
    pty_stats: () => {
      ptyPulls += 1;
      return [];
    },
    app_stats: () => {
      appPulls += 1;
      return app;
    },
  });

  const ptyReadings: unknown[] = [];
  const appReadings: AppStats[] = [];
  const stopPty = await onPtyStats((stats) => ptyReadings.push(stats));
  const stopApp = await onAppStats((stats) => appReadings.push(stats));
  await vi.advanceTimersByTimeAsync(0);
  expect(ptyReadings).toEqual([[]]);
  expect(appReadings).toEqual([app]);

  await vi.advanceTimersByTimeAsync(2_000);
  expect(ptyPulls).toBe(2);
  expect(appPulls).toBe(2);

  stopPty();
  stopApp();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(ptyPulls).toBe(2);
  expect(appPulls).toBe(2);
});

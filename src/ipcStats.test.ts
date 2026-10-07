import { afterEach, expect, it, vi } from "vitest";
import { onAppStats, onPtyStats, type AppStats } from "./ipc";
import { installHost } from "./host";
import type {Host} from "./host/contract";
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

it("samples the selected workspace in the same resource subscription and stops when hidden",async()=>{
 vi.useFakeTimers();let unavailable=false;const invoke=vi.fn(async command=>{if(command!=="workspace_metrics")throw Error("Local stats must not be read");if(unavailable)throw Error("offline");return {cpuPercent:12,memoryBytes:1024,memoryLimitBytes:2048,cpus:1,elasticCpu:{minCpus:1,maxCpus:4,currentCpus:1,availableMaxCpus:2,status:"steady",sampledAt:0}};});
 const restore=installHost({kind:"socket",invoke,listen:vi.fn(),channel:vi.fn()} as unknown as Host);
 const readings:AppStats[]=[];let stop:(()=>void)|undefined;
 try{stop=await onAppStats(s=>readings.push(s));await vi.advanceTimersByTimeAsync(0);expect(readings.at(-1)?.workspace?.available).toBe(true);expect(readings.at(-1)?.mem_bytes).toBe(1024);expect(readings.at(-1)?.workspace?.elasticCpu?.maxCpus).toBe(4);unavailable=true;await vi.advanceTimersByTimeAsync(2000);expect(readings.at(-1)?.workspace?.available).toBe(false);stop();stop=undefined;const calls=invoke.mock.calls.length;await vi.advanceTimersByTimeAsync(4000);expect(invoke.mock.calls.length).toBe(calls);}finally{stop?.();restore();}
});

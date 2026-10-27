import { afterEach, expect, it, vi } from "vitest";
import { onAppStats, onPtyStats, workspaceAppStats, type AppStats } from "./ipc";
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

it("adds this computer's free memory to the local app's footprint", async () => {
  vi.useFakeTimers();
  mockCommands({
    app_stats: () => ({ cpu: 1, mem_bytes: 2, procs: 1, includes_webviews: true }),
    memory_info: () => ({ level: 0, total_bytes: 16, available_bytes: 5, used_bytes: 11, free_bytes: 1 }),
  });
  const readings: AppStats[] = [];
  const stop = await onAppStats((s) => readings.push(s));
  await vi.advanceTimersByTimeAsync(0);
  expect(readings.at(-1)?.system).toEqual({ availableBytes: 5, totalBytes: 16 });
  stop();
});

it("reads a workspace's working set, not memory.current, and keeps older hosts as they were", () => {
  const sessions = [{ id: 1, memoryBytes: 3, cpusUsed: 0.5, owner: null }];
  const fresh = workspaceAppStats({ cpuPercent: 25, memoryBytes: 21, memoryLimitBytes: 28, cpus: 8, workingSetBytes: 8, availableBytes: 20, reclaimableBytes: 13, cpusUsed: 2, cpusAvailable: 6, sessions, machine: { memoryTotalBytes: 64, memoryAvailableBytes: 30, cpus: 16, cpusUsed: 1, cpusAvailable: 15, runtimes: [] } });
  expect(fresh.mem_bytes).toBe(8);
  expect(fresh.workspace?.machine?.memoryAvailableBytes).toBe(30);
  expect(fresh.workspace).toMatchObject({ memoryBytes: 21, workingSetBytes: 8, availableBytes: 20, reclaimableBytes: 13, cpusUsed: 2, cpusAvailable: 6, sessions });
  const older = workspaceAppStats({ cpuPercent: 25, memoryBytes: 21, memoryLimitBytes: 28, cpus: 8 });
  expect(older.mem_bytes).toBe(21);
  expect(older.workspace && "workingSetBytes" in older.workspace).toBe(false);
});

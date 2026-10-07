import { afterEach, expect, it, vi } from "vitest";
import { mockCommands } from "./test/setup";
import { ptyStopAndWait } from "./ipc";
afterEach(()=>vi.useRealTimers());
it("waits for authoritative process disappearance after stop acceptance",async()=>{
 vi.useFakeTimers();
 let stopped=false, polls=0;
 mockCommands({pty_kill:()=>{stopped=true;},pty_stats:()=>{expect(stopped).toBe(true);return ++polls<3?[{id:42}]:[];}});
 const pending=ptyStopAndWait(42);
 await vi.advanceTimersByTimeAsync(250);
 await pending;expect(polls).toBe(3);
});
it("does not swallow a failed stop request",async()=>{
 mockCommands({pty_kill:()=>{throw Error("Workspace disconnected");}});
 await expect(ptyStopAndWait(42)).rejects.toThrow("Workspace disconnected");
});
it("fails closed if the process never exits",async()=>{
 vi.useFakeTimers();
 mockCommands({pty_kill:undefined,pty_stats:[{id:42}]});
 const pending=expect(ptyStopAndWait(42)).rejects.toThrow("not stopped");
 await vi.advanceTimersByTimeAsync(10100);
 await pending;
});

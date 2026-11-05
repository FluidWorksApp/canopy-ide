import { expect, it, vi } from "vitest";
import { handOver, type HandoverEffects } from "./accountHandover";

const request = {
  target: { line: "target", profile: "b" },
  original: { line: "original", profile: "a" },
  fresh: { line: "fresh", profile: "b" },
};
/** `alive` answers, per line written, whether that launch keeps the terminal. */
function effects(alive: Record<string, boolean>, overrides: Partial<HandoverEffects> = {}) {
  let current = false;
  const written: string[] = [];
  const steps: string[] = [];
  const value: HandoverEffects = {
    stop: vi.fn(async () => { current = false; }),
    transfer: vi.fn(async () => {}),
    write: vi.fn(async line => { written.push(line); current = alive[line] ?? false; }),
    running: vi.fn(async () => current),
    sleep: vi.fn(async () => {}),
    log: step => { steps.push(step); },
    ...overrides,
  };
  return { value, written, steps };
}

it("moves the conversation and writes nothing else", async () => {
  const run = effects({ target: true });
  expect(await handOver(request, run.value)).toEqual({ outcome: "moved" });
  expect(run.written).toEqual(["target"]);
  expect(run.steps).toEqual(["stopping", "transferring", "launching", "moved"]);
});
it("never touches the transcript unless the stop is proven", async () => {
  const run = effects({}, { stop: vi.fn(async () => { throw Error("did not stop"); }) });
  expect(await handOver(request, run.value)).toEqual({ outcome: "failed", reason: "did not stop" });
  expect(run.value.transfer).not.toHaveBeenCalled();
  expect(run.written).toEqual([]);
});
it("puts the agent back on its account when the transfer fails", async () => {
  const run = effects({ original: true }, { transfer: vi.fn(async () => { throw Error("Target conversation differs"); }) });
  expect(await handOver(request, run.value)).toEqual({ outcome: "restored", reason: "Target conversation differs" });
  expect(run.written).toEqual(["original"]);
});
it("puts the agent back when the target refuses the resume", async () => {
  const run = effects({ original: true, target: false });
  expect((await handOver(request, run.value)).outcome).toBe("restored");
  expect(run.written).toEqual(["target", "original"]);
});
it("catches a CLI that starts and then quits", async () => {
  let looks = 0;
  const run = effects({ original: true, target: true });
  const running = run.value.running;
  run.value.running = vi.fn(async () => (run.written.length === 1 && ++looks > 3 ? false : running()));
  expect((await handOver(request, run.value)).outcome).toBe("restored");
});
it("starts fresh when a tab has no saved conversation yet", async () => {
  const run = effects({ fresh: true }, { transfer: vi.fn(async () => { throw Error("Saved conversation not found"); }) });
  expect(await handOver(request, run.value)).toEqual({ outcome: "started-fresh" });
  expect(run.written).toEqual(["fresh"]);
});
it("says so when even the way back fails, and the shell is left at its prompt", async () => {
  const run = effects({}, { transfer: vi.fn(async () => { throw Error("disk full"); }) });
  expect(await handOver(request, run.value)).toEqual({ outcome: "failed", reason: "disk full" });
  expect(run.steps).toContain("restore-failed");
});
it("reports a terminal that closed instead of throwing", async () => {
  const run = effects({}, { write: vi.fn(async () => { throw Error("no pty session"); }) });
  expect(await handOver(request, run.value)).toEqual({ outcome: "failed", reason: "no pty session" });
});

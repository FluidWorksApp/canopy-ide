import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESTORE_PROBE_MS,
  RESTORE_WATCH_MS,
  reapsFailedRestore,
  refusedResume,
  watchFailedRestore,
} from "./restoreReap";

const SID = "06a16320-640a-4fa2-affc-8cb30dcd8300";
const REFUSAL = `claude --resume ${SID}\r\nNo conversation found with session ID: ${SID}\r\n`;

const dead = (over: Partial<Parameters<typeof reapsFailedRestore>[0]> = {}) => ({
  output: REFUSAL,
  sessionId: SID,
  agentRunning: false,
  sinceInputMs: null,
  ...over,
});

describe("refusedResume", () => {
  it("reads the CLI's refusal for the id we asked for", () => {
    expect(refusedResume(REFUSAL, SID)).toBe(true);
  });

  it("sees through the colour it is printed in", () => {
    const red = `\x1b[31mNo conversation found with session ID: ${SID}\x1b[0m`;
    expect(refusedResume(red, SID)).toBe(true);
  });

  it("ignores a refusal about some other session", () => {
    expect(refusedResume(REFUSAL, "another-id")).toBe(false);
  });

  it("is not fooled by the echoed command alone", () => {
    expect(refusedResume(`claude --resume ${SID}\r\n`, SID)).toBe(false);
  });

  it("needs an id to be about", () => {
    expect(refusedResume(REFUSAL, "  ")).toBe(false);
  });
});

describe("reapsFailedRestore", () => {
  it("reaps a resume the CLI refused", () => {
    expect(reapsFailedRestore(dead())).toBe(true);
  });

  it("leaves a terminal with an agent in it alone", () => {
    // The phrase is just text — an agent working on this very file prints it.
    expect(reapsFailedRestore(dead({ agentRunning: true }))).toBe(false);
  });

  it("leaves a terminal the human has typed into alone", () => {
    expect(reapsFailedRestore(dead({ sinceInputMs: 40_000 }))).toBe(false);
  });

  it("never reaps on silence alone", () => {
    expect(reapsFailedRestore(dead({ output: "" }))).toBe(false);
  });
});

describe("watchFailedRestore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const harness = (over: Partial<Parameters<typeof watchFailedRestore>[0]> = {}) => {
    const reap = vi.fn();
    const cancel = watchFailedRestore({
      sessionId: SID,
      ptyId: () => 7,
      read: async () => REFUSAL,
      look: () => ({ agentRunning: false, sinceInputMs: null }),
      reap,
      ...over,
    });
    return { reap, cancel };
  };

  it("reaps once the pty has said it failed", async () => {
    const { reap } = harness();
    await vi.advanceTimersByTimeAsync(RESTORE_PROBE_MS + 1);
    expect(reap).toHaveBeenCalledTimes(1);
  });

  it("reaps at most once, then stops looking", async () => {
    const { reap } = harness();
    await vi.advanceTimersByTimeAsync(RESTORE_PROBE_MS * 5);
    expect(reap).toHaveBeenCalledTimes(1);
  });

  it("waits for the pty to exist", async () => {
    const { reap } = harness({ ptyId: () => null });
    await vi.advanceTimersByTimeAsync(RESTORE_PROBE_MS * 3);
    expect(reap).not.toHaveBeenCalled();
  });

  it("says nothing about a pty the stats have not described yet", async () => {
    const { reap } = harness({ look: () => undefined });
    await vi.advanceTimersByTimeAsync(RESTORE_PROBE_MS * 3);
    expect(reap).not.toHaveBeenCalled();
  });

  it("gives up on a restore that never failed", async () => {
    const read = vi.fn(async () => "");
    const { reap } = harness({ read });
    await vi.advanceTimersByTimeAsync(RESTORE_WATCH_MS * 2);
    expect(reap).not.toHaveBeenCalled();
    const probes = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RESTORE_WATCH_MS);
    expect(read.mock.calls.length).toBe(probes);
  });

  it("stops when cancelled", async () => {
    const { reap, cancel } = harness();
    cancel();
    await vi.advanceTimersByTimeAsync(RESTORE_PROBE_MS * 3);
    expect(reap).not.toHaveBeenCalled();
  });

  it("does not reap on an answer that arrived after the cancel", async () => {
    let release: (v: string) => void = () => {};
    const { reap, cancel } = harness({
      read: () => new Promise<string>((r) => (release = r)),
    });
    await vi.advanceTimersByTimeAsync(RESTORE_PROBE_MS + 1);
    cancel();
    release(REFUSAL);
    await vi.advanceTimersByTimeAsync(1);
    expect(reap).not.toHaveBeenCalled();
  });
});

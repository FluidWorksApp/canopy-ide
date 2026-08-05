import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRAIN_DEBOUNCE_MS,
  BRAIN_MIN_INTERVAL_MS,
  brainHints,
  configureBrainRunner,
  HINTS_EVENT,
  noteWorkItems,
  resetBrainForTest,
} from "./workItemBrain";

const reply = (labels: Record<string, string>) =>
  JSON.stringify({ labels, assign: [] });

const flush = async () => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  resetBrainForTest();
});

afterEach(() => {
  resetBrainForTest();
  vi.useRealTimers();
});

describe("workItemBrain", () => {
  it("debounces churn into one warm turn and caches the hints", async () => {
    const run = vi.fn(async (_prompt: string) => reply({ s1: "Waze API reuse" }));
    configureBrainRunner(run);
    noteWorkItems("digest v1");
    noteWorkItems("digest v2");
    noteWorkItems("digest v3");
    await vi.advanceTimersByTimeAsync(BRAIN_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain("digest v3");
    expect(brainHints().labels).toEqual({ s1: "Waze API reuse" });
  });

  it("announces on new hints", async () => {
    const heard = vi.fn();
    window.addEventListener(HINTS_EVENT, heard);
    configureBrainRunner(async () => reply({ s1: "x" }));
    noteWorkItems("d");
    await vi.advanceTimersByTimeAsync(BRAIN_DEBOUNCE_MS);
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener(HINTS_EVENT, heard);
  });

  it("never re-asks an answered digest", async () => {
    const run = vi.fn(async (_prompt: string) => reply({ s1: "x" }));
    configureBrainRunner(run);
    noteWorkItems("same");
    await vi.advanceTimersByTimeAsync(BRAIN_DEBOUNCE_MS);
    noteWorkItems("same");
    await vi.advanceTimersByTimeAsync(BRAIN_MIN_INTERVAL_MS * 2);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("floors consecutive turns to the minimum interval", async () => {
    const run = vi.fn(async (_prompt: string) => reply({ s1: "x" }));
    configureBrainRunner(run);
    noteWorkItems("v1");
    await vi.advanceTimersByTimeAsync(BRAIN_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);
    noteWorkItems("v2");
    await vi.advanceTimersByTimeAsync(BRAIN_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BRAIN_MIN_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0]).toContain("v2");
  });

  it("keeps old hints through an unusable reply and does not loop on it", async () => {
    const run = vi
      .fn<(prompt: string) => Promise<string>>()
      .mockResolvedValueOnce(reply({ s1: "good" }))
      .mockResolvedValue("I cannot help with that.");
    configureBrainRunner(run);
    noteWorkItems("v1");
    await vi.advanceTimersByTimeAsync(BRAIN_DEBOUNCE_MS);
    noteWorkItems("v2");
    await vi.advanceTimersByTimeAsync(BRAIN_MIN_INTERVAL_MS * 3);
    expect(brainHints().labels).toEqual({ s1: "good" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("holds work while no runner is wired, then runs on wiring", async () => {
    noteWorkItems("waiting");
    await vi.advanceTimersByTimeAsync(BRAIN_MIN_INTERVAL_MS);
    const run = vi.fn(async (_prompt: string) => reply({ s1: "x" }));
    configureBrainRunner(run);
    await vi.advanceTimersByTimeAsync(BRAIN_DEBOUNCE_MS);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain("waiting");
  });

  it("retries a failed turn on the next change, not in a storm", async () => {
    const run = vi
      .fn<(prompt: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("cli died"))
      .mockResolvedValue(reply({ s1: "recovered" }));
    configureBrainRunner(run);
    noteWorkItems("v1");
    await vi.advanceTimersByTimeAsync(BRAIN_DEBOUNCE_MS);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    // The failure left the digest pending; the scheduled retry respects the floor.
    await vi.advanceTimersByTimeAsync(BRAIN_MIN_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
    expect(brainHints().labels).toEqual({ s1: "recovered" });
  });
});

import { afterEach, expect, it, vi } from "vitest";
import { registerRendererWithRetry } from "./rendererRegistration";

afterEach(() => vi.useRealTimers());

it("keeps only one native registration pending even after its slow warning", async () => {
  vi.useFakeTimers();
  let complete!: (value: number) => void;
  const register = vi.fn(() => new Promise<number>((resolve) => { complete = resolve; }));
  const report = vi.fn();
  const ready = registerRendererWithRetry(register, report);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(register).toHaveBeenCalledTimes(1);
  expect(report).toHaveBeenCalledTimes(1);
  complete(7);
  expect(await ready).toBe(7);
  expect(vi.getTimerCount()).toBe(0);
});

it("retries a rejected registration and clears the failed attempt's warning", async () => {
  vi.useFakeTimers();
  const register = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(8);
  const report = vi.fn();
  const ready = registerRendererWithRetry(register, report);
  await vi.advanceTimersByTimeAsync(100);
  expect(await ready).toBe(8);
  expect(register).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

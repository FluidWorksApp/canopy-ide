import { describe, expect, it, vi } from "vitest";
import { bindMemoryPressure } from "./memoryPressureBinding";

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("memory pressure binding", () => {
  it("does not let an older snapshot overwrite a newer critical event", async () => {
    const initial = deferred<{ level: number } | null>();
    let emit!: (pressure: { level: number }) => void;
    const off = vi.fn();
    const applied: number[] = [];
    const dispose = bindMemoryPressure(
      async (callback) => {
        emit = callback;
        return off;
      },
      () => initial.promise,
      (pressure) => applied.push(pressure.level),
    );
    await Promise.resolve();
    emit({ level: 2 });
    initial.resolve({ level: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([2]);
    dispose();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("applies the initial snapshot when no newer event exists", async () => {
    const applied: number[] = [];
    const dispose = bindMemoryPressure(
      async () => () => {},
      async () => ({ level: 1 }),
      (pressure) => applied.push(pressure.level),
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([1]);
    dispose();
  });

  it("falls back to a snapshot when listener installation fails", async () => {
    const applied: number[] = [];
    const dispose = bindMemoryPressure(
      async () => {
        throw new Error("listener unavailable");
      },
      async () => ({ level: 2 }),
      (pressure) => applied.push(pressure.level),
    );
    await vi.waitFor(() => expect(applied).toEqual([2]));
    dispose();
  });
});

import { describe, expect, it, vi } from "vitest";
import { IoBudget, IoBudgetExceededError } from "./ioBudget";

const limits = {
  maxConcurrent: 2,
  maxConcurrentPerScope: 1,
  maxActiveBytes: 10,
  maxActiveBytesPerScope: 6,
  maxQueued: 4,
  maxQueuedBytes: 12,
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("IoBudget", () => {
  it("enforces global and per-scope count and byte ceilings without head-of-line blocking", async () => {
    const budget = new IoBudget(limits);
    const a = deferred();
    const b = deferred();
    const c = deferred();
    const started: string[] = [];
    const run = (scope: string, bytes: number, gate: ReturnType<typeof deferred>) =>
      budget.run({ scope, bytes }, async () => {
        started.push(scope);
        await gate.promise;
      });

    const first = run("one", 6, a);
    const sameScope = run("one", 1, b);
    const otherScope = run("two", 4, c);
    await vi.waitFor(() => expect(started).toEqual(["one", "two"]));
    expect(budget.snapshot()).toMatchObject({ active: 2, activeBytes: 10, queued: 1 });

    c.resolve();
    await otherScope;
    await vi.waitFor(() => expect(started).toEqual(["one", "two"]));
    a.resolve();
    await first;
    await vi.waitFor(() => expect(started).toEqual(["one", "two", "one"]));
    b.resolve();
    await sameScope;
    expect(budget.snapshot()).toMatchObject({ active: 0, queued: 0 });
  });

  it("removes an aborted waiter without releasing an active lease early", async () => {
    const budget = new IoBudget({ ...limits, maxConcurrent: 1 });
    const gate = deferred();
    const active = budget.run({ scope: "one", bytes: 4 }, () => gate.promise);
    const controller = new AbortController();
    const operation = vi.fn(async () => {});
    const waiting = budget.run(
      { scope: "two", bytes: 3, signal: controller.signal },
      operation,
    );
    await vi.waitFor(() => expect(budget.snapshot().queued).toBe(1));

    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(operation).not.toHaveBeenCalled();
    expect(budget.snapshot()).toMatchObject({ active: 1, activeBytes: 4, queued: 0 });
    gate.resolve();
    await active;
  });

  it("discards a superseded active result but holds admission until it settles", async () => {
    const budget = new IoBudget({ ...limits, maxConcurrent: 1 });
    const gate = deferred();
    const controller = new AbortController();
    const active = budget.run(
      { scope: "one", bytes: 4, signal: controller.signal },
      async () => {
        await gate.promise;
        return "late result";
      },
    );
    await vi.waitFor(() => expect(budget.snapshot().active).toBe(1));
    controller.abort();
    expect(budget.snapshot()).toMatchObject({ active: 1, activeBytes: 4 });
    gate.resolve();
    await expect(active).rejects.toMatchObject({ name: "AbortError" });
    expect(budget.snapshot()).toMatchObject({ active: 0, activeBytes: 0 });
  });

  it("rejects work that cannot fit and bounds the waiting queue", async () => {
    const budget = new IoBudget({ ...limits, maxConcurrent: 1, maxQueued: 1 });
    await expect(
      budget.run({ scope: "one", bytes: 7 }, async () => {}),
    ).rejects.toBeInstanceOf(IoBudgetExceededError);

    const gate = deferred();
    const active = budget.run({ scope: "one", bytes: 4 }, () => gate.promise);
    const queued = budget.run({ scope: "two", bytes: 2 }, async () => {});
    await expect(
      budget.run({ scope: "three", bytes: 1 }, async () => {}),
    ).rejects.toMatchObject({ reason: "queue-full" });
    gate.resolve();
    await Promise.all([active, queued]);
  });

  it("admits another scope immediately even when blocked waiters fill the queue", async () => {
    const budget = new IoBudget({ ...limits, maxQueued: 1 });
    const firstGate = deferred();
    const waitingGate = deferred();
    const otherGate = deferred();
    const started: string[] = [];
    const run = (scope: string, gate: ReturnType<typeof deferred>) =>
      budget.run({ scope, bytes: 1 }, async () => {
        started.push(scope);
        await gate.promise;
      });

    const active = run("one", firstGate);
    const queued = run("one", waitingGate);
    const other = run("two", otherGate);
    await vi.waitFor(() => expect(started).toEqual(["one", "two"]));
    otherGate.resolve();
    firstGate.resolve();
    await Promise.all([active, other]);
    waitingGate.resolve();
    await queued;
  });

  it("releases admission when an operation throws", async () => {
    const budget = new IoBudget(limits);
    await expect(
      budget.run({ scope: "one", bytes: 5 }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(budget.snapshot()).toMatchObject({ active: 0, activeBytes: 0 });
  });
});

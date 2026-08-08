/** Shared renderer-side admission control for work that materialises bytes.
 *
 * This is deliberately an admission budget, not a claim that Tauri invokes can
 * be interrupted after native work has started. A queued request is removable
 * immediately through AbortSignal; an admitted operation keeps its lease until
 * it settles, so aborting a caller can never make the accounting lie while a
 * native read is still allocating or transferring its response.
 */

export interface IoBudgetLimits {
  maxConcurrent: number;
  maxConcurrentPerScope: number;
  maxActiveBytes: number;
  maxActiveBytesPerScope: number;
  maxQueued: number;
  maxQueuedBytes: number;
}

export interface IoAdmission {
  /** A project id/root when one exists; stable feature name otherwise. */
  scope: string;
  /** Known bytes, or a conservative response-size estimate. */
  bytes: number;
  signal?: AbortSignal;
}

export interface IoBudgetSnapshot {
  active: number;
  activeBytes: number;
  queued: number;
  queuedBytes: number;
  scopes: Record<string, { active: number; activeBytes: number }>;
}

export class IoBudgetExceededError extends Error {
  readonly reason: "request-too-large" | "queue-full";

  constructor(reason: "request-too-large" | "queue-full", message: string) {
    super(message);
    this.name = "IoBudgetExceededError";
    this.reason = reason;
  }
}

const abortError = () => {
  const error = new Error("I/O request was superseded");
  error.name = "AbortError";
  return error;
};

interface ScopeUse {
  active: number;
  bytes: number;
}

interface Waiter {
  scope: string;
  bytes: number;
  signal?: AbortSignal;
  resolve: (lease: IoLease) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

interface IoLease {
  release(): void;
}

const positive = (value: number, name: string) => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return Math.floor(value);
};

export class IoBudget {
  private readonly limits: IoBudgetLimits;
  private readonly waiting: Waiter[] = [];
  private readonly scopes = new Map<string, ScopeUse>();
  private active = 0;
  private activeBytes = 0;
  private queuedBytes = 0;

  constructor(limits: IoBudgetLimits) {
    this.limits = {
      maxConcurrent: positive(limits.maxConcurrent, "maxConcurrent"),
      maxConcurrentPerScope: positive(
        limits.maxConcurrentPerScope,
        "maxConcurrentPerScope",
      ),
      maxActiveBytes: positive(limits.maxActiveBytes, "maxActiveBytes"),
      maxActiveBytesPerScope: positive(
        limits.maxActiveBytesPerScope,
        "maxActiveBytesPerScope",
      ),
      maxQueued: positive(limits.maxQueued, "maxQueued"),
      maxQueuedBytes: positive(limits.maxQueuedBytes, "maxQueuedBytes"),
    };
  }

  snapshot(): IoBudgetSnapshot {
    return {
      active: this.active,
      activeBytes: this.activeBytes,
      queued: this.waiting.length,
      queuedBytes: this.queuedBytes,
      scopes: Object.fromEntries(
        [...this.scopes].map(([scope, use]) => [
          scope,
          { active: use.active, activeBytes: use.bytes },
        ]),
      ),
    };
  }

  async run<T>(
    request: IoAdmission,
    operation: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquire(request);
    try {
      if (request.signal?.aborted) throw abortError();
      const result = await operation(request.signal);
      if (request.signal?.aborted) throw abortError();
      return result;
    } finally {
      lease.release();
    }
  }

  private acquire(request: IoAdmission): Promise<IoLease> {
    const scope = request.scope.trim() || "unscoped";
    const bytes = Math.max(0, Math.floor(request.bytes));
    if (!Number.isFinite(request.bytes) || request.bytes < 0) {
      return Promise.reject(
        new IoBudgetExceededError(
          "request-too-large",
          "I/O byte estimate must be finite and non-negative",
        ),
      );
    }
    if (
      bytes > this.limits.maxActiveBytes ||
      bytes > this.limits.maxActiveBytesPerScope
    ) {
      return Promise.reject(
        new IoBudgetExceededError(
          "request-too-large",
          `I/O request (${bytes} bytes) exceeds its admission ceiling`,
        ),
      );
    }
    if (request.signal?.aborted) return Promise.reject(abortError());
    const canStartNow = this.canAdmit({ scope, bytes });
    if (
      !canStartNow &&
      (this.waiting.length >= this.limits.maxQueued ||
        this.queuedBytes + bytes > this.limits.maxQueuedBytes)
    ) {
      return Promise.reject(
        new IoBudgetExceededError("queue-full", "I/O admission queue is full"),
      );
    }

    return new Promise<IoLease>((resolve, reject) => {
      const waiter: Waiter = {
        scope,
        bytes,
        signal: request.signal,
        resolve,
        reject,
      };
      if (request.signal) {
        waiter.onAbort = () => {
          const index = this.waiting.indexOf(waiter);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          this.queuedBytes -= waiter.bytes;
          waiter.reject(abortError());
          this.pump();
        };
        request.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiting.push(waiter);
      this.queuedBytes += bytes;
      this.pump();
    });
  }

  private canAdmit(waiter: Pick<Waiter, "scope" | "bytes">): boolean {
    const scope = this.scopes.get(waiter.scope);
    return (
      this.active < this.limits.maxConcurrent &&
      this.activeBytes + waiter.bytes <= this.limits.maxActiveBytes &&
      (scope?.active ?? 0) < this.limits.maxConcurrentPerScope &&
      (scope?.bytes ?? 0) + waiter.bytes <=
        this.limits.maxActiveBytesPerScope
    );
  }

  private pump(): void {
    while (this.active < this.limits.maxConcurrent) {
      const index = this.waiting.findIndex((waiter) => this.canAdmit(waiter));
      if (index < 0) return;
      const [waiter] = this.waiting.splice(index, 1);
      this.queuedBytes -= waiter.bytes;
      if (waiter.onAbort) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
      }
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }

      this.active++;
      this.activeBytes += waiter.bytes;
      const use = this.scopes.get(waiter.scope) ?? { active: 0, bytes: 0 };
      use.active++;
      use.bytes += waiter.bytes;
      this.scopes.set(waiter.scope, use);
      let released = false;
      waiter.resolve({
        release: () => {
          if (released) return;
          released = true;
          this.active--;
          this.activeBytes -= waiter.bytes;
          const current = this.scopes.get(waiter.scope);
          if (current) {
            current.active--;
            current.bytes -= waiter.bytes;
            if (current.active === 0) this.scopes.delete(waiter.scope);
          }
          this.pump();
        },
      });
    }
  }
}

/** One shared ceiling for renderer work. Feature-local limits remain useful;
 * this prevents several individually-safe surfaces from peaking together. */
export const rendererIoBudget = new IoBudget({
  maxConcurrent: 8,
  maxConcurrentPerScope: 4,
  maxActiveBytes: 64 * 1024 * 1024,
  maxActiveBytesPerScope: 32 * 1024 * 1024,
  maxQueued: 96,
  maxQueuedBytes: 64 * 1024 * 1024,
});

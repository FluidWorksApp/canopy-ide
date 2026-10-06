/** Retain one in-flight operation and one latest value, never a promise queue. */
export function coalesced<T>(send: (value: T) => Promise<unknown>) {
  let pending: { value: T } | undefined;
  let active = false;
  let stopped = false;
  const drain = async () => {
    if (active || stopped || !pending) return;
    const { value } = pending; pending = undefined; active = true;
    try { await send(value); } catch { /* A newer value can still reconcile. */ }
    finally { active = false; if (!stopped) void drain(); }
  };
  return {
    push(value: T) { if (!stopped) { pending = { value }; void drain(); } },
    stop() { stopped = true; pending = undefined; },
  };
}

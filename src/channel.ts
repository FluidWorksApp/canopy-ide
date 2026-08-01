// One observable value, as a factory.
//
// Nine modules grew the same ~20 lines independently — a module-level value, a
// Set of listeners, an emit loop, a subscribe function, a test seam — and each
// copy drifted its own way: one isolated a throwing listener, the rest let it
// take the notify loop down; one compared before notifying, the rest notified
// on every write; two forgot to copy the set before iterating, so a listener
// unsubscribing mid-notify reshaped the loop under it. This is that shape,
// written once, with the drift picked to the safe side of each fork.
//
// What belongs here: the observable core — value, listeners, notify.
// What stays in the owning module: everything about *its* value. Lazy IPC
// wiring, owner-scoped clears, patch helpers, domain accessors. A channel is
// the wire, not the policy.
//
// Deliberately NOT migrated onto this:
//   * browserSignals — the browser watchdog's independent wire. A checker that
//     shares the code under suspicion agrees with it about everything,
//     including the bug (its own header says so).
//   * companionSession — its store core is interleaved with the write gate;
//     the plumbing saved is not worth touching that path.
import { useSyncExternalStore } from "react";

export interface Channel<T> {
  get(): T;
  /** Publish. A write `same` says is unchanged notifies nobody. */
  set(next: T): void;
  subscribe(fn: () => void): () => void;
  /** Test seam: back to the initial value, all listeners forgotten. */
  reset(): void;
}

export interface ChannelOptions<T> {
  /** When a write counts as a change. Default `Object.is` — a fresh object
   *  always notifies, which is what the Partial-patch stores expect. */
  same?: (a: T, b: T) => boolean;
  /** The first subscriber arrived (again — fires on every 0→1 transition).
   *  Where a subscriber-gated resource starts: useSecondTick's interval. */
  onActive?: () => void;
  /** The last subscriber left. Where that resource stops. */
  onIdle?: () => void;
}

export function createChannel<T>(
  initial: T,
  { same = Object.is, onActive, onIdle }: ChannelOptions<T> = {},
): Channel<T> {
  let current = initial;
  const listeners = new Set<() => void>();

  return {
    get: () => current,
    set(next: T) {
      if (same(current, next)) return;
      current = next;
      // Copied: a listener that unsubscribes on this notify must not reshape
      // the set mid-iteration.
      for (const l of [...listeners]) {
        try {
          l();
        } catch {
          // A subscriber's bug is the subscriber's problem — it must not stop
          // the next one hearing about the change.
        }
      }
    },
    subscribe(fn: () => void) {
      if (listeners.size === 0) onActive?.();
      listeners.add(fn);
      return () => {
        const had = listeners.delete(fn);
        if (had && listeners.size === 0) onIdle?.();
      };
    },
    reset() {
      current = initial;
      listeners.clear();
    },
  };
}

/** The React side. Pass the module's own subscribe when it wraps the
 *  channel's (lazy IPC wiring on first subscribe); otherwise the channel's is
 *  used directly. */
export function useChannel<T>(
  ch: Channel<T>,
  subscribe: (fn: () => void) => () => void = ch.subscribe,
): T {
  return useSyncExternalStore(subscribe, ch.get, ch.get);
}

/** A derived read that only re-renders when the *derived* value changes.
 *  `select` must return a primitive (or otherwise stable) value: an object
 *  built fresh per call would defeat the point and loop the store. */
export function useChannelSelect<T, S>(
  ch: Channel<T>,
  select: (v: T) => S,
  subscribe: (fn: () => void) => () => void = ch.subscribe,
): S {
  return useSyncExternalStore(
    subscribe,
    () => select(ch.get()),
    () => select(ch.get()),
  );
}

/** The frontend end of the change channel: one subscription, routed to the
 *  store that owns each id.
 *
 *  A store's own module registers itself here and keeps its existing shape —
 *  its cache, its `refresh`, its CustomEvent. This adds the one thing none of
 *  them had: a way for a write that did not come from this window to reach
 *  them. See `src-tauri/src/change.rs` for the other half.
 *
 *  One listener rather than one per store, because the subscription is
 *  registered asynchronously: N subscriptions mean N windows in which an event
 *  lands with nothing listening, and that race is the shape of the bug this
 *  closes. */

import * as ipc from "./ipc";

type Handler = (e: ipc.StoreChange) => void;

const handlers = new Map<string, Handler>();

/** Re-arm delays. A failed `listen` used to be permanent: the flag was
 *  released but nothing ever called `arm` again, so a transient failure during
 *  startup left the app with no change channel for the rest of the session and
 *  no symptom until a note silently failed to appear. */
const RETRY_MS = [250, 1000, 4000, 15000];

let armed = false;
let attempt = 0;
let timer: number | undefined;

function arm(): void {
  if (armed) return;
  armed = true;
  void ipc
    .onStoreChange((e) => {
      handlers.get(e.store)?.(e);
    })
    .then(() => {
      attempt = 0;
    })
    .catch(() => {
      armed = false;
      // Back off, but never give up: the channel is the only thing standing
      // between an agent's write and a stale panel.
      const wait = RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)];
      attempt += 1;
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(arm, wait);
    });
}

/** Route `store:change` events for one store id to a handler.
 *
 *  Called at module scope by each store, so the subscription exists before any
 *  component mounts — a panel that has never been opened must still have its
 *  store listening, or opening it shows whatever was true when the app
 *  started. */
export function registerStore(store: string, handler: Handler): void {
  handlers.set(store, handler);
  arm();
}

/** Which stores are routed. The guard test reads this to check that every
 *  `change::Store` variant in Rust has a handler here — a variant with no
 *  handler emits into nothing, which looks exactly like the bug. */
export function registeredStores(): string[] {
  return [...handlers.keys()].sort();
}

/** Test seam: drop the subscription state so a case can arm it again. */
export function resetForTests(): void {
  handlers.clear();
  armed = false;
  attempt = 0;
  if (timer !== undefined) window.clearTimeout(timer);
  timer = undefined;
}

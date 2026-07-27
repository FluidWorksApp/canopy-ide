// React's view of the PR watcher. useSyncExternalStore rather than a state +
// effect pair, so every consumer reads the same snapshot in the same render and
// no component ends up owning the subscription.
import { useSyncExternalStore } from "react";
import { getSnapshot, subscribe, type PrWatchState } from "./prWatchStore";

/** With a selector, a consumer only re-renders when its slice changes identity
 *  — ProjectView reads `rows` and shouldn't wake for `nextIn`/`busy` ticks.
 *  The selector must return something the store keeps identity-stable. */
export function usePrWatch(): PrWatchState;
export function usePrWatch<T>(selector: (s: PrWatchState) => T): T;
export function usePrWatch<T>(
  selector?: (s: PrWatchState) => T,
): T | PrWatchState {
  const get: () => T | PrWatchState = selector
    ? () => selector(getSnapshot())
    : getSnapshot;
  return useSyncExternalStore(subscribe, get, get);
}

// React's view of the PR watcher. useSyncExternalStore rather than a state +
// effect pair, so every consumer reads the same snapshot in the same render and
// no component ends up owning the subscription.
import { useSyncExternalStore } from "react";
import { getSnapshot, subscribe, type PrWatchState } from "./prWatchStore";

export function usePrWatch(): PrWatchState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

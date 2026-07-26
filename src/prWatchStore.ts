// One subscription to the PR watcher, shared by everything that wants PRs.
//
// The panel, the rail badge and every open PR tab all want the same rows. If
// each mounted its own listener and its own interval we would be back to the
// per-component polling this whole thing exists to avoid — so: exactly one set
// of Tauri listeners for the life of the window, a module-level store, and
// `useSyncExternalStore` for the React side. Components read; they never fetch.
//
// It also owns the "is the user looking?" signal, because that is what decides
// the poll interval on the Rust side. Focus and visibility are window-global
// facts, not a component's business.
import * as ipc from "./ipc";
import { allRows, applySnapshot } from "./prInbox";

export interface PrWatchState {
  byRepo: Map<string, ipc.PrRow[]>;
  rows: ipc.PrRow[];
  viewer: string;
  /** When the last completed pass finished. */
  fetchedMs: number;
  errors: Record<string, string>;
  /** GraphQL points left in the hour, as GitHub last reported them. */
  remaining: number;
  cost: number;
  /** Seconds the poller intends to sleep before the next pass. */
  nextIn: number;
  /** True between asking for a refresh and the next tick landing. */
  busy: boolean;
}

const empty: PrWatchState = {
  byRepo: new Map(),
  rows: [],
  viewer: "",
  fetchedMs: 0,
  errors: {},
  remaining: 0,
  cost: 0,
  nextIn: 0,
  busy: false,
};

let state: PrWatchState = empty;
const listeners = new Set<() => void>();
let started = false;
/** The repo set we last told Rust about, so identical calls are free. */
let declared = "";
let focused = true;

function emit(next: Partial<PrWatchState>) {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/** Register the window-global listeners once. Idempotent: every consumer calls
 *  it, the first one wins. */
function start() {
  if (started) return;
  started = true;

  void ipc.onPrSnapshot((snap) => {
    const byRepo = applySnapshot(state.byRepo, snap);
    emit({
      byRepo,
      rows: allRows(byRepo),
      viewer: snap.viewer || state.viewer,
      fetchedMs: snap.fetched_ms,
    });
  });
  void ipc.onPrTick((tick) => {
    emit({
      fetchedMs: tick.fetched_ms,
      errors: tick.errors,
      remaining: tick.remaining,
      cost: tick.cost,
      busy: false,
    });
  });
  void ipc.onPrNext((seconds) => emit({ nextIn: seconds }));

  // Focus drives the interval: 90s while the user is here, 10 minutes when they
  // are not. Both events matter — a window can be focused and hidden (another
  // desktop), or visible and unfocused (a second monitor).
  const sync = () => {
    const next = document.visibilityState === "visible" && document.hasFocus();
    if (next === focused) return;
    focused = next;
    if (declared) void ipc.prWatchSet(JSON.parse(declared) as string[], focused);
  };
  window.addEventListener("focus", sync);
  window.addEventListener("blur", sync);
  document.addEventListener("visibilitychange", sync);
}

/** Declare the repos worth watching — the component paths of every open
 *  project. Rust folds them onto their repo toplevels and de-duplicates, so
 *  passing every component of every project is fine and expected. */
export function setPaths(paths: string[]): void {
  start();
  const key = JSON.stringify(paths);
  if (key === declared) return;
  declared = key;
  // Forget rows for repos that are no longer watched, so a closed project's PRs
  // don't linger in the panel until the next pass.
  if (paths.length === 0) {
    emit({ byRepo: new Map(), rows: [] });
  }
  void ipc.prWatchSet(paths, focused);
}

/** The ↻: wake the poller. It coalesces, so double-clicking costs nothing. */
export function refresh(): void {
  start();
  emit({ busy: true });
  void ipc.prWatchNow();
  // Don't leave the spinner up if the pass fails to emit for any reason.
  window.setTimeout(() => emit({ busy: false }), 15_000);
}

export function subscribe(fn: () => void): () => void {
  start();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getSnapshot = (): PrWatchState => state;

/** Rows for one repo, for a PR tab that only cares about its own. */
export const rowFor = (repo: string, number: number): ipc.PrRow | undefined =>
  state.byRepo.get(repo)?.find((r) => r.number === number);

/** Test seam: drop everything, including the once-only listener flag. */
export function __reset(): void {
  state = empty;
  listeners.clear();
  started = false;
  declared = "";
  focused = true;
}

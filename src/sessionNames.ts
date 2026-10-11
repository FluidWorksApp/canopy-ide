// A conversation's names, kept by the conversation rather than by the terminal
// showing it.
//
// A pty is not an identity worth keying on in a remote workspace: the container
// is recreated, the host daemon restarts, the app restarts, and each time every
// terminal comes back with a new pty id under a new instance. The agent's
// session id is the one thing that survives all of those, so that is the key —
// scoped by workspace, the same scope the remembered terminals use.
//
// Opaque on purpose: the names are `DurableNames` from tabName.ts, which is the
// only module that reads or writes a slot. This one only remembers them.
import type { DurableNames } from "./tabName";

const KEY = "canopy.sessionNames";
/** Months of sessions; the oldest go first. */
const CAP = 500;

type Store = Record<string, { names: DurableNames; at: number }>;

const keyFor = (scope: string, sessionId: string) => JSON.stringify([scope, sessionId]);

function read(): Store {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

export function rememberedSessionNames(
  scope: string,
  sessionId: string,
): DurableNames | undefined {
  return read()[keyFor(scope, sessionId)]?.names;
}

/** Record what the conversation is called now. An empty set forgets it, which
 *  is how a cleared rename stays cleared instead of coming back on the next
 *  reconnect. */
export function rememberSessionNames(
  scope: string,
  sessionId: string,
  names: DurableNames,
): void {
  const store = read();
  const key = keyFor(scope, sessionId);
  if (Object.keys(names).length === 0) {
    if (!(key in store)) return;
    delete store[key];
  } else {
    store[key] = { names, at: Date.now() };
    const keys = Object.keys(store);
    if (keys.length > CAP)
      keys
        .sort((a, b) => store[a].at - store[b].at)
        .slice(0, keys.length - CAP)
        .forEach((k) => delete store[k]);
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Storage unavailable: the names still live on the tab for this run.
  }
}

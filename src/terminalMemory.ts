// What was open in a project's terminals last time, so closing the app (or a
// project) doesn't erase the shape of the work.
//
// Agent *sessions* restore with their conversation (see restorable.ts); this
// is the other half — the plain shells, the dev servers, the run commands —
// which have no transcript to resume, only a directory and a command line.
// Kept in localStorage rather than the workspace file: it is a convenience
// record, not part of the project's definition, and a corrupt one should cost
// nothing.

export interface RememberedTerminal {
  cwd: string;
  command?: string;
  title: string;
  icon?: string;
  /** It lived in the RUNS rail rather than the terminal strip. */
  run?: boolean;
}

const KEY = "canopy.terminals";

type Store = Record<string, RememberedTerminal[]>;

function read(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Store;
  } catch {
    return {};
  }
}

export function rememberTerminals(projectId: string, terminals: RememberedTerminal[]) {
  // Never record an empty set. Closing the last tab is exactly when this
  // memory becomes valuable — overwriting it at that moment would erase the
  // thing the user wants back.
  if (terminals.length === 0) return;
  const store = read();
  store[projectId] = terminals.slice(0, 12);
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Storage full or unavailable — a lost convenience record is not worth
    // interrupting anyone over.
  }
}

export function rememberedTerminals(projectId: string): RememberedTerminal[] {
  return read()[projectId] ?? [];
}

export function forgetTerminals(projectId: string) {
  const store = read();
  delete store[projectId];
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // ignore
  }
}

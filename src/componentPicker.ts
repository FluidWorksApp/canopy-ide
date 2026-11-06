// Which component a new shell or agent opens in, when a project has several.
//
// Until now every launch that did not name one fell back to the first component,
// so "new terminal" landed somewhere that felt random. The picker asks, and this
// is its logic: the order (last used first), the filter, and the grey completion.

export interface PickerComponent {
  id: string;
  label: string;
  path: string;
}

const KEY = "canopy.componentRecents.v1";
/** Enough to remember a long project without growing without bound. */
const REMEMBERED = 12;

type Store = Record<string, string[]>;

const read = (): Store => {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return value && typeof value === "object" ? (value as Store) : {};
  } catch {
    return {};
  }
};

/** Component ids a new shell or agent was last opened in for this project, most recent first. */
export const recentComponentIds = (projectId: string): string[] => {
  const ids = read()[projectId];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
};

export function recordRecentComponent(projectId: string, componentId: string) {
  try {
    const store = read();
    store[projectId] = [componentId, ...(store[projectId] ?? []).filter((id) => id !== componentId)].slice(0, REMEMBERED);
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* Private window or blocked storage: the picker still works, it just forgets. */
  }
}

/** The last folder of a path: how people say which repo they mean. */
export const lastFolder = (path: string) => path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? path;

/** The component a path is inside, preferring the most specific. */
export function componentAt<T extends PickerComponent>(components: T[], path: string | null | undefined): T | undefined {
  if (!path) return undefined;
  return [...components]
    .sort((a, b) => b.path.length - a.path.length)
    .find((c) => path === c.path || path.startsWith(`${c.path}/`) || path.startsWith(`${c.path}\\`));
}

/**
 * Last used first, as asked. Ids that no longer exist drop out. Before anything
 * has been recorded the tab you are in comes first, then the project's own order.
 */
export function orderComponents<T extends PickerComponent>(
  components: T[],
  recents: string[],
  activePath?: string | null,
): T[] {
  const byId = new Map(components.map((c) => [c.id, c]));
  const out: T[] = [];
  const seen = new Set<string>();
  const add = (c: T | undefined) => {
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      out.push(c);
    }
  };
  for (const id of recents) add(byId.get(id));
  add(componentAt(components, activePath));
  for (const c of components) add(c);
  return out;
}

/**
 * Filter by what was typed, best match first; ties keep the given (recency)
 * order. Every word has to match: the name beats the folder beats the full path.
 */
export function rankComponents<T extends PickerComponent>(query: string, ordered: T[]): T[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return ordered;
  const scored: { c: T; score: number; at: number }[] = [];
  ordered.forEach((c, at) => {
    const name = c.label.toLowerCase();
    const folder = lastFolder(c.path).toLowerCase();
    const path = c.path.toLowerCase();
    const words = name.split(/[^a-z0-9]+/).filter(Boolean);
    let total = 0;
    for (const token of tokens) {
      const s =
        name.startsWith(token) ? 100
        : words.some((w) => w.startsWith(token)) ? 80
        : folder.startsWith(token) ? 70
        : name.includes(token) ? 60
        : folder.includes(token) ? 50
        : path.includes(token) ? 25
        : 0;
      if (!s) return;
      total += s;
    }
    scored.push({ c, score: total, at });
  });
  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  return scored.map((s) => s.c);
}

/**
 * The letters still to type to finish the best match, shown greyed after the
 * cursor. Only when what is typed is the start of the name (or its folder), so
 * the grey text really is what Tab would fill in.
 */
export function completion(query: string, top: PickerComponent | undefined): { rest: string; full: string } | null {
  if (!top || !query || /\s/.test(query)) return null;
  const q = query.toLowerCase();
  for (const full of [top.label, lastFolder(top.path)]) {
    if (full.length > query.length && full.toLowerCase().startsWith(q)) return { rest: full.slice(query.length), full };
  }
  return null;
}

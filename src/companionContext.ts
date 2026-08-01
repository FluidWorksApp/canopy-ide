// What the user is in front of, as the companion is told it.
//
// The companion runs in no project, so "this", "here" and "the file I'm on"
// have no referent unless Canopy supplies one — and a companion that has to be
// asked "which file do you mean?" before every deictic question reads as one
// that cannot see. This module is the supply line: the visible ProjectView
// publishes what is in front of the user (module store, outside React, same
// shape as companionSession's), and two consumers read it — sendToCompanion
// prepends the envelope line to every message, and the chat panel shows the
// hint so the user can see what the companion will be told.
//
// Deliberately a *spotlight*, not a general "active view" channel: it carries
// exactly what the companion's envelope needs and nothing else. The full
// editor state (open tabs, selection, other projects) stays behind
// `canopy_editor_state`, which the brief points at for anything deeper.

/** The front tab, as `describeTab` describes it — only the fields the
 *  envelope reads are named, and everything is optional because every tab
 *  kind carries a different subset. */
export interface SpotlightTab {
  kind: string;
  path?: string | null;
  label?: string | null;
  url?: string | null;
}

export interface CompanionSpotlight {
  /** The project's display name — what the user and the companion both say. */
  project: string;
  tab: SpotlightTab | null;
  /** Caret position, only when the front tab is the file it sits in. */
  caret: { path: string; line: number } | null;
}

let current: { owner: string; spot: CompanionSpotlight } | null = null;
const listeners = new Set<() => void>();

export function subscribeSpotlight(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function companionSpotlight(): CompanionSpotlight | null {
  return current?.spot ?? null;
}

/** Publish (or clear) the spotlight. `owner` is the publishing project's id:
 *  only the view that set the spotlight may clear it, so a background
 *  project's unmount cannot blank what the visible one just published. */
export function setCompanionSpotlight(
  owner: string,
  spot: CompanionSpotlight | null,
): void {
  if (!spot && current?.owner !== owner) return;
  const next = spot ? { owner, spot } : null;
  // Publishers run on every render; only a real change notifies.
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next;
  for (const cb of [...listeners]) cb();
}

/** What the front tab should be called in prose. Absent for a tab kind with
 *  nothing nameable about it. */
function describe(spot: CompanionSpotlight): string | null {
  const t = spot.tab;
  if (!t) return null;
  if (t.kind === "file" && t.path) {
    const at =
      spot.caret && spot.caret.path === t.path ? ` (caret at line ${spot.caret.line})` : "";
    return `the file ${t.path}${at}`;
  }
  if (t.kind === "preview" && t.url) return `a browser preview of ${t.url}`;
  if (t.label) return `the ${t.kind} "${t.label}"`;
  return null;
}

/** The one line Canopy prepends to every message the user sends the
 *  companion. Bracketed and self-describing, because the model has to be able
 *  to tell it from the user's own words — the brief explains it too, but the
 *  line must survive being read cold in a resumed transcript. */
export function spotlightEnvelope(spot: CompanionSpotlight): string {
  const at = describe(spot);
  return `[Canopy: the user is in project "${spot.project}"${
    at ? `, looking at ${at}` : ""
  }. Context from the IDE, not the user's words.]`;
}

/** The chip in the chat panel: `banana · App.tsx:120`. Short enough for a
 *  350px header — the envelope carries the full paths. */
export function spotlightHint(spot: CompanionSpotlight): string {
  const t = spot.tab;
  if (t?.kind === "file" && t.path) {
    const base = t.path.split("/").pop() || t.path;
    const line = spot.caret && spot.caret.path === t.path ? `:${spot.caret.line}` : "";
    return `${spot.project} · ${base}${line}`;
  }
  if (t?.kind === "preview" && t.url) {
    const short = t.url.replace(/^https?:\/\//, "");
    return `${spot.project} · ${short.length > 28 ? `${short.slice(0, 27)}…` : short}`;
  }
  if (t?.label) return `${spot.project} · ${t.label}`;
  return spot.project;
}

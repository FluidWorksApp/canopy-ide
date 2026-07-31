// What `[[a target]]` points at.
//
// One resolver, because the alternative is that the same link means different
// things depending on which tab you typed it in — which is the exact failure
// the shared <Markdown> component exists to end, reappearing one level up.
//
// Resolution is deliberately by *identity first, name second*. An id
// (`0007-tier-donations`) is stable and survives a rename; a title is what
// people actually type. Trying ids first means a link written the durable way
// keeps working after someone renames the thing, and a link written the human
// way still resolves today.
import type * as ipc from "./ipc";

export type WikilinkTarget =
  | { kind: "note"; id: string; title: string }
  | { kind: "research"; id: string; title: string }
  | { kind: "file"; path: string }
  /** Nothing matched. Obsidian's answer, and the right one: a link to
   *  something that does not exist yet is how you write down an idea before
   *  you have written the idea. Following it creates the note. */
  | { kind: "new"; title: string };

export interface WikilinkCandidates {
  notes: ipc.NoteSummary[];
  research: ipc.ResearchSummary[];
  /** Absolute paths of every file under the project's components. */
  files: string[];
}

/** Loose comparison for titles: case and surrounding punctuation should not
 *  decide whether a link resolves. */
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** The `nnnn-slug` shape both stores mint ids in. */
const looksLikeId = (s: string) => /^\d{4}-[a-z0-9-]+$/.test(s.trim());

/** The file this target names, if the corpus holds exactly one that fits.
 *
 *  "Exactly one" is the whole rule. `[[helpers]]` in a repo with nine
 *  `helpers.ts` is ambiguous, and picking the first is a link that silently
 *  goes somewhere arbitrary — worse than not resolving, because it looks like
 *  it worked. Ambiguity falls through to the next resolver instead. */
function resolveFile(target: string, files: string[]): string | null {
  const t = target.trim();
  if (!t) return null;
  // A path (or a path suffix) is unambiguous by construction, so it wins.
  const byPath = files.filter((f) => f === t || f.endsWith(`/${t}`));
  if (byPath.length === 1) return byPath[0];
  if (byPath.length > 1) return null;

  const wanted = norm(t);
  const base = (f: string) => f.slice(f.lastIndexOf("/") + 1);
  const stem = (f: string) => {
    const b = base(f);
    const dot = b.lastIndexOf(".");
    return dot > 0 ? b.slice(0, dot) : b;
  };
  const byName = files.filter(
    (f) => norm(base(f)) === wanted || norm(stem(f)) === wanted,
  );
  return byName.length === 1 ? byName[0] : null;
}

/** Resolve a wikilink target against everything this project has.
 *
 *  Notes before research before files: a scratchpad link is overwhelmingly
 *  about another thought, and a note named the same as a file is the more
 *  specific thing to have meant. */
export function resolveWikilink(
  target: string,
  candidates: WikilinkCandidates,
): WikilinkTarget {
  const t = target.trim();
  if (!t) return { kind: "new", title: "" };

  if (looksLikeId(t)) {
    const note = candidates.notes.find((n) => n.id === t);
    if (note) return { kind: "note", id: note.id, title: note.title };
    const entry = candidates.research.find((r) => r.id === t);
    if (entry) return { kind: "research", id: entry.id, title: entry.title };
  }

  const wanted = norm(t);
  const note = candidates.notes.find((n) => norm(n.title) === wanted);
  if (note) return { kind: "note", id: note.id, title: note.title };

  const entry = candidates.research.find((r) => norm(r.title) === wanted);
  if (entry) return { kind: "research", id: entry.id, title: entry.title };

  const file = resolveFile(t, candidates.files);
  if (file) return { kind: "file", path: file };

  return { kind: "new", title: t };
}

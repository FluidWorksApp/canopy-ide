// What the companion knows about you, as opposed to what it can look up.
//
// Separate from notes and research on purpose. Both of those belong to a
// project — they are scoped to one repo, they live beside its code, and they
// are about the work. This is about the *user*: how they like things
// delivered, a standing decision that spans repos, the shape of a project its
// files do not show. A companion that had to be told twice would not be one.
//
// Kept outside every repo (~/.canopy) for the same reason: a fact about how
// somebody works does not belong in a checkout, must not be committed by
// accident, and has to survive a project being deleted.
//
// The conversation itself is NOT here. The CLI holds that against the session
// id, and it carries across restarts on its own — so this is deliberately only
// for what outlives the conversation, which is what keeps it from becoming a
// log of everything ever said.

import * as ipc from "./ipc";

export interface Memory {
  id: string;
  /** What it concerns — a project name, or "how they work". Free text: the
   *  companion is the only writer, and forcing it into a taxonomy would mean
   *  the interesting facts land in "other". */
  about: string;
  fact: string;
  /** Unix ms. Shown when recalled, because a standing decision from March
   *  and one from yesterday carry different weight. */
  ts: number;
}

/** Where it lives. Under the same `~/.canopy` roof as the clipboard store and
 *  the session digests — Canopy's own state, never a repo's. The `companion/`
 *  directory is supplied by the Rust side, which is what keeps this from being
 *  a path the webview could choose. */
export const MEMORY_FILE = "memory.json";

/** Cap on what is kept. Not a rotation policy — this is a small set of facts
 *  about a person, and a companion with ten thousand of them has been using it
 *  as a scratchpad, which the tool description explicitly forbids. The cap is
 *  what makes that failure visible rather than unbounded. */
export const MAX_MEMORIES = 500;

/** How many characters of one fact to keep. Long enough for a sentence or two,
 *  short enough that a pasted transcript cannot land here. */
const MAX_FACT = 600;

let cache: Memory[] | null = null;

function parse(raw: string): Memory[] {
  try {
    const list = JSON.parse(raw) as Memory[];
    return Array.isArray(list) ? list.filter((m) => m && typeof m.fact === "string") : [];
  } catch {
    // A corrupt store is not worth failing a companion over; it starts empty
    // and the next write repairs it. Never thrown at the agent mid-turn.
    return [];
  }
}

export async function loadMemories(): Promise<Memory[]> {
  if (cache) return cache;
  const raw = await ipc.canopyStoreRead(MEMORY_FILE).catch(() => null);
  cache = raw ? parse(raw) : [];
  return cache;
}

async function save(list: Memory[]): Promise<void> {
  cache = list;
  await ipc.canopyStoreWrite(MEMORY_FILE, JSON.stringify(list, null, 2)).catch(() => {
    // Losing a memory is a degraded companion, not a broken one — and a failed
    // write must not take down the turn that produced the fact.
  });
}

/** Score a memory against a query. Deliberately crude: this is a few hundred
 *  short facts, so a word-overlap count beats anything that needs an index to
 *  maintain — and the companion re-reads the whole set anyway when it asks
 *  without a query. */
export function scoreMemory(m: Memory, query: string): number {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  if (words.length === 0) return 1;
  const hay = `${m.about} ${m.fact}`.toLowerCase();
  return words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
}

export function recallFrom(list: Memory[], query?: string | null): Memory[] {
  const q = (query ?? "").trim();
  // Position breaks a timestamp tie. Two facts recorded in the same
  // millisecond — which is what happens when the companion writes several in
  // one turn — otherwise come back in insertion order, i.e. oldest first,
  // which is the opposite of what "newest first" promises. The list is
  // append-ordered, so a later index is a later fact.
  const ranked = list.map((m, i) => ({ m, i }));
  if (!q) {
    return ranked.sort((a, b) => b.m.ts - a.m.ts || b.i - a.i).map((r) => r.m);
  }
  return ranked
    .map((r) => ({ ...r, score: scoreMemory(r.m, q) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.m.ts - a.m.ts || b.i - a.i)
    .map((r) => r.m);
}

/** Whether a new fact says the same thing as one already held.
 *
 *  Exists because the companion will re-learn things: it is told "I prefer
 *  worktrees" in March and again in July, and two rows saying it is how a
 *  memory becomes noise. Same `about` and a fact that is a superset or subset
 *  of an existing one counts as the same fact, and the newer wording wins. */
export function isSameFact(a: Memory, about: string, fact: string): boolean {
  if (a.about.trim().toLowerCase() !== about.trim().toLowerCase()) return false;
  const x = a.fact.trim().toLowerCase();
  const y = fact.trim().toLowerCase();
  return x === y || x.includes(y) || y.includes(x);
}

export async function remember(input: {
  fact: string;
  about?: string | null;
  forget?: boolean | null;
}): Promise<{ kept: number; action: "added" | "updated" | "forgotten" | "ignored" }> {
  const fact = input.fact.trim().slice(0, MAX_FACT);
  const about = (input.about ?? "how they work").trim() || "how they work";
  const list = await loadMemories();

  if (input.forget) {
    const next = list.filter((m) => !isSameFact(m, about, fact));
    await save(next);
    return {
      kept: next.length,
      action: next.length === list.length ? "ignored" : "forgotten",
    };
  }
  if (!fact) return { kept: list.length, action: "ignored" };

  const existing = list.findIndex((m) => isSameFact(m, about, fact));
  if (existing >= 0) {
    const next = list.slice();
    // The newer wording wins, and the timestamp moves — being told again is
    // itself evidence the fact is still true.
    next[existing] = { ...next[existing], fact, ts: Date.now() };
    await save(next);
    return { kept: next.length, action: "updated" };
  }
  const next = [
    ...list,
    { id: `mem_${Date.now().toString(36)}_${list.length}`, about, fact, ts: Date.now() },
  ];
  // Oldest first out of the door, since the newest facts are the ones most
  // likely to still be true.
  const trimmed = next.slice(Math.max(0, next.length - MAX_MEMORIES));
  await save(trimmed);
  return { kept: trimmed.length, action: "added" };
}

/** Drop everything — the "start over" in Settings, which has to forget what it
 *  learned as well as the conversation, or the new acquaintance still knows
 *  you. */
export async function forgetAllMemories(): Promise<void> {
  await save([]);
}

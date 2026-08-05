// What a run calls itself, in the agent's own words.
//
// A task is named at launch, before anything has been read: a built-in derives
// its label from the payload ("Review #292"), and everything else — a one-off, a
// note, a question typed into ⌘K — gets the head of the brief cut on a word.
// That is the best a launcher can do, and for the ad-hoc half it is poor: a
// Tasks list reading "⚡ Can you please help in setting…" says what was typed
// and nothing about what the job turned out to be.
//
// The agent knows. It has read the code by the time it has done anything, so it
// is the only party that can say "Task identity, in the harness" and tag it
// `tasks`, `mcp`. So it says: `canopy_name_task` early, and `canopy_job_done`
// carries the same three fields at the end for a job short enough that one call
// is the whole run.
//
// Everything here is defensive. These values come from a model and land in a
// row that is 260px wide, so they are clamped rather than trusted: a title that
// is a paragraph, an icon that is the word "PR", eleven tags — each is a thing
// an agent has done, and none of them may be allowed to reshape the panel.

/** The three fields an agent may set on its own run. Every one optional: an
 *  agent that names nothing leaves the launcher's label standing, which is the
 *  behaviour that existed before this. */
export interface TaskIdentity {
  title?: string;
  icon?: string;
  tags?: string[];
}

/** Room for a short sentence in a row that also carries a dot, a glyph, a
 *  summary and an age. Past this the row would win its fight with the summary,
 *  which is the part that says what happened. */
const MAX_TITLE = 48;

/** Enough for a kind, an area and a verb — "review", "mcp", "rust". A fifth
 *  chip pushes the row to two lines, and tags that wrap are worse than no tags:
 *  the row stops being scannable, which is all it is for. */
export const MAX_TAGS = 4;

/** A tag is a word, occasionally two. Anything longer is a sentence wearing a
 *  chip, and it is the row's width that pays for it. */
const MAX_TAG = 20;

/** One line, no runs of whitespace, trimmed. Titles and tags both arrive from a
 *  model that may have wrapped them. */
const flatten = (s: string): string => s.replace(/\s+/g, " ").trim();

/** Cut on a word boundary when there is one worth cutting on, so a clamped
 *  title reads as a phrase rather than a string that ran out. */
function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:—-]+$/, "")}…`;
}

/** The first grapheme of a string — one visible character, not one code unit.
 *  An emoji is several code points (skin tone, variation selector, ZWJ) and
 *  slicing it anywhere but the cluster boundary produces a mojibake box. */
function firstGlyph(s: string): string {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    for (const g of seg.segment(s)) return g.segment;
    return "";
  }
  return Array.from(s)[0] ?? "";
}

/** One glyph, or nothing.
 *
 *  ASCII is refused wholesale, which is a stricter rule than it looks: every
 *  built-in task's icon (⇈ ⌕ ◎ ⚒ ⑂ ◍ ◈ ◇ ⚡ ▶ ⤴ ↩ ⇥) is a Unicode symbol, and
 *  what an agent reaches for when it has no glyph in mind is "PR", "*", "#" or
 *  ":rocket:" — a letter, a shrug and a literal emoji shortcode, all of which
 *  read as a bug in the panel rather than as an icon. Refusing them leaves the
 *  task's own icon in place, which was always a reasonable answer. */
export function taskGlyph(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const glyph = firstGlyph(flatten(raw));
  if (!glyph) return undefined;
  const first = glyph.codePointAt(0) ?? 0;
  if (first < 0x80) return undefined;
  if (/[\p{L}\p{N}]/u.test(glyph)) return undefined;
  return glyph;
}

/** The tags, deduped case-insensitively and capped. Order is the agent's — it
 *  put the most specific one first often enough that sorting them would lose
 *  something and gain nothing. */
export function taskTags(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const t of raw) {
    if (typeof t !== "string") continue;
    // A leading # is how half the world writes a tag, and it would render as a
    // second one inside a chip that is already a tag.
    const tag = clamp(flatten(t).replace(/^#+/, ""), MAX_TAG);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags.length ? tags : undefined;
}

/** An agent-supplied title, or nothing when it said nothing usable. Never a
 *  fallback to the launcher's label: the caller holds that, and returning it
 *  here would make "the agent named this" impossible to tell from "it didn't". */
export function taskTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return clamp(flatten(raw), MAX_TITLE) || undefined;
}

/** The live focus line has room for one short sentence in the hover card. */
export function taskDescription(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return clamp(flatten(raw), 160) || undefined;
}

/** Everything an agent may say about its own run, cleaned. */
export function taskIdentity(raw: {
  title?: unknown;
  icon?: unknown;
  tags?: unknown;
}): TaskIdentity {
  const id: TaskIdentity = {};
  const title = taskTitle(raw.title);
  const icon = taskGlyph(raw.icon);
  const tags = taskTags(raw.tags);
  if (title) id.title = title;
  if (icon) id.icon = icon;
  if (tags) id.tags = tags;
  return id;
}

/** The same three, shaped as a patch for a run's history entry — `agentIcon`
 *  rather than `icon`, which is the task's own and stays where it is.
 *
 *  Only the fields the agent actually sent. The history merges a patch with a
 *  spread, so an explicit `undefined` is not "leave it alone", it is "blank
 *  it": an agent that named itself early and then passed only an icon at the
 *  end would otherwise erase its own title on the way out. */
export function identityPatch(raw: {
  title?: unknown;
  icon?: unknown;
  tags?: unknown;
}): { title?: string; agentIcon?: string; tags?: string[] } {
  const named = taskIdentity(raw);
  return {
    ...(named.title ? { title: named.title } : {}),
    ...(named.icon ? { agentIcon: named.icon } : {}),
    ...(named.tags ? { tags: named.tags } : {}),
  };
}

/** True when there is anything worth writing down. Guards the store: a
 *  `canopy_name_task` call that survives validation as an empty object must not
 *  fire a history write and repaint every panel watching it. */
export const hasIdentity = (id: TaskIdentity): boolean =>
  Boolean(id.title || id.icon || id.tags?.length);

/** How long the agent's restatement of the ask may be. A paragraph belongs in
 *  the transcript; this is the "before" that sits above the "after", and it is
 *  read at a glance next to it. */
const MAX_ASKED = 240;

/** The agent's one-line reading of what it was asked for.
 *
 *  The history has always shown the brief — but a brief is the launcher's
 *  prose, several hundred words of protocol and instruction, and reading it to
 *  recall what a run was about means reading past all of it. What the agent
 *  understood the job to be is both shorter and more honest: if it misread the
 *  ask, that is precisely the thing worth seeing above the answer. */
export function askedLine(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return clamp(flatten(raw), MAX_ASKED) || undefined;
}

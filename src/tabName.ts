// Every name a terminal tab can carry, and the only place any of them is
// written or read.
//
// What this replaces: a rename landed in `customTitle` when the tab had no pty
// and in `name` when it did — and `name` was also where the native core's
// generated label (Moss, Juniper …) lived. A boolean `renamed` was the only
// surviving evidence of which of the two a given string was. Six writers shared
// those three fields, each with its own idea of what it was entitled to
// overwrite, and the flag that arbitrated between them was set by one of those
// writers and forgotten by the rest. So renaming from the Agents page never set
// it, the next `UserPromptSubmit` saw an unflagged tab, and the name the user
// had chosen was replaced by the first forty-eight characters of their own next
// sentence.
//
// The fix is structural rather than a seventh guard: **one slot per author**.
// No two writers share a field, so no write can clobber another's, and
// authorship is carried by which slot holds the string rather than by a flag
// travelling beside it that somebody will forget. Precedence collapses to a
// single static list, read in exactly one place.
//
// tabNameGuard.test.ts keeps it that way: no file outside this module may name
// a slot, in a patch or in a read.

import { basename } from "./paths";

/** One slot per author. Every field here is written by exactly one route into
 *  `namePatch`, and read only by `tabName`. */
export interface TabNames {
  /** The name the user typed, from anywhere they can type one — the inline tab
   *  rename, a pane header, the Agents page editor. Nothing else ever writes
   *  it, and nothing below it can displace it. */
  userName?: string;
  /** What the agent called its own run, via `canopy_name_task`. */
  agentName?: string;
  /** The opening prompt, standing in until the agent names the work itself. */
  promptName?: string;
  /** The generated session label the native core assigns at spawn. Meaningful
   *  for an agent — it is how the mesh and the Agents page address it — and
   *  noise on a plain shell, which is why `tabName` asks before showing it. */
  nativeName?: string;
  /** The terminal's own OSC title: whatever the running program paints, which
   *  on an idle zsh is `/bin/zsh` several times a minute. */
  oscTitle?: string;
  /** What the launcher called it — a configured run command's name, a CLI's
   *  label, the title a restored tab came back with. */
  launchTitle?: string;
}

/** Who is writing. The argument exists so a caller states its authority rather
 *  than picking a field and thereby implying one. */
export type NameAuthor = "user" | "agent" | "prompt" | "native" | "osc" | "launch";

const SLOT: Record<NameAuthor, keyof TabNames> = {
  user: "userName",
  agent: "agentName",
  prompt: "promptName",
  native: "nativeName",
  osc: "oscTitle",
  launch: "launchTitle",
};

/** Room for a short phrase in a chip that also carries a dot, a glyph and a
 *  directory. Matches taskIdentity's MAX_TITLE — an agent-supplied name has
 *  already been clamped to it, and a user's should not be able to exceed what
 *  the native core accepts (48, see pty.rs). */
const MAX = 48;

const clean = (raw: string | undefined): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const flat = raw.replace(/\s+/g, " ").trim();
  if (!flat) return undefined;
  return flat.length > MAX ? `${flat.slice(0, MAX - 1).trimEnd()}…` : flat;
};

/** Auto titles that name a terminal rather than the work in it. A shell nobody
 *  has titled reports its own name, or the login shell's, or the directory it
 *  sits in — and "zsh" is a worse heading than "claude" or "dashboard dev".
 *  Only ever consulted for `oscTitle`: a user who renames a tab to "shell"
 *  means it, and their slot is never filtered. */
const GENERIC = new Set([
  "shell", "terminal", "term", "console", "agent",
  "sh", "bash", "zsh", "-zsh", "-bash", "fish", "login", "node",
]);

/** On Windows cmd.exe titles itself with its own full path, so every chip
 *  showing it read `C:\Windows\syste…` — forty characters saying nothing, and
 *  two shells side by side reading identically. The tail is the identifying
 *  part. POSIX paths are left alone and rejected wholesale below instead. */
function shorten(title: string): string {
  if (!/^[a-zA-Z]:[\\/]|^\\\\/.test(title)) return title;
  const tail = title.split(/[\\/]/).filter(Boolean).pop();
  return tail || title;
}

/** The OSC title, or nothing when it says less than the tab already shows. */
function informative(raw: string | undefined, agentLabel?: string): string | undefined {
  const title = clean(raw);
  if (!title) return undefined;
  const short = shorten(title);
  if (GENERIC.has(short.toLowerCase())) return undefined;
  // Where it runs, not what it is doing — and the row already carries a
  // directory chip. This is the `/bin/zsh` case.
  if (short.startsWith("/") || short.startsWith("~/")) return undefined;
  // The bin under its own name adds nothing over the identified label, and the
  // label is the tidier spelling of the two.
  if (agentLabel && short.toLowerCase() === agentLabel.toLowerCase()) return undefined;
  return short;
}

/** What a tab needs to carry for `tabName` to answer. */
export interface NamedTab extends TabNames {
  cwd?: string;
  /** A run lives in the RUNS rail: its launch title is a configured name. */
  run?: boolean;
  /** A managed one-shot. Its launch label is durable and its prompt is a
   *  paragraph, so the prompt slot stays shut. */
  micro?: unknown;
}

/**
 * The one place a terminal tab's name is decided.
 *
 * Precedence is a single static list because the slots make it possible for it
 * to be one: a lower author cannot be holding a higher author's string.
 *
 *  1. the user — always, unfiltered, from wherever they typed it
 *  2. the agent's own name for its run
 *  3. the opening prompt, until the agent supplies better
 *  4. a configured run command's name — the user named that in project
 *     settings, so it outranks whatever the shell paints over it. This is what
 *     stopped a dev server's chip from decaying into `/bin/zsh`.
 *  5. the generated session label, for agents only
 *  6. the OSC title, when it says something the tab does not already say
 *  7. the launch title, then the directory, then a last resort
 */
export function tabName(
  tab: NamedTab,
  opts: { agent?: boolean; agentLabel?: string } = {},
): string {
  const { agent = false, agentLabel } = opts;
  return (
    tab.userName ??
    tab.agentName ??
    tab.promptName ??
    (tab.run ? tab.launchTitle : undefined) ??
    (agent ? tab.nativeName : undefined) ??
    informative(tab.oscTitle, agentLabel) ??
    tab.launchTitle ??
    (basename(tab.cwd) || undefined) ??
    agentLabel ??
    "shell"
  );
}

/**
 * The only way to write a name. Returns the patch to apply, or null when the
 * write is a no-op or one this author is not entitled to make.
 *
 * Callers apply the patch with whatever they already use to update tab state —
 * this deliberately does not touch the store, so the same function serves the
 * React tabs array, a snapshot being restored, and a test.
 */
export function namePatch(
  tab: NamedTab,
  author: NameAuthor,
  raw: string | undefined,
): Partial<TabNames> | null {
  const slot = SLOT[author];
  const value = clean(raw);
  // Only the user may empty a slot, and emptying theirs is how a rename is
  // undone. Everyone else reporting nothing means "I have nothing to add" —
  // notably a refused spawn, which announces no session name at all and used to
  // erase the tab's label on its way past.
  if (!value && author !== "user") return null;
  // The opening prompt is a stand-in, not a running commentary: the first one
  // names the tab and every message after it is conversation. A micro-task
  // already carries a durable launch label and its brief is a paragraph.
  if (author === "prompt" && (tab.promptName || tab.micro)) return null;
  if (value === tab[slot]) return null;
  return { [slot]: value };
}

/** True when the user has named this tab. The question every restore path has
 *  to ask, and the reason `renamed` existed — but read off the slot that holds
 *  the name rather than off a flag that has to be kept in step with it. */
export const isUserNamed = (tab: TabNames): boolean => Boolean(tab.userName);

/**
 * The name a session is *addressed* by — what the mesh routes on, what
 * `message_agent` resolves, what the Agents page edits — as opposed to what it
 * is *called*, which is `tabName`.
 *
 * The two are different questions and they have different answers: a tab called
 * "PR 1749 daily duration" is still addressed as "Moss". Keeping them in one
 * module keeps that distinction visible; when it was implicit, surfaces
 * silently substituted one for the other.
 *
 * `liveName` is the value from the stats poller, for a tab whose mirror has not
 * caught up yet. A user's name is the last resort: before the pty exists, it is
 * what the session is about to be called.
 */
export function sessionAddress(
  tab: Pick<TabNames, "nativeName" | "userName"> | undefined,
  liveName?: string,
): string | undefined {
  return tab?.nativeName ?? liveName ?? tab?.userName;
}

/** A tab's names as they go into a snapshot (hibernation, remembered
 *  terminals). `title` stays the display name so an older build reading this
 *  store still shows something sensible; `userName` is what a restore actually
 *  re-asserts. */
export function snapshotNames(
  tab: NamedTab,
  opts: { agent?: boolean; agentLabel?: string } = {},
): { title: string; userName?: string } {
  return {
    title: tabName(tab, opts),
    ...(tab.userName ? { userName: tab.userName } : {}),
  };
}

/** The inverse: a snapshot's names as tab slots.
 *
 *  `renamed` is read for snapshots written before this module existed, where a
 *  user's choice and a generated label shared the `title` field and the flag
 *  was the only thing telling them apart. Nothing writes `renamed` any more. */
export function adoptSnapshotNames(snapshot: {
  title?: string;
  userName?: string;
  renamed?: boolean;
}): TabNames {
  const user = clean(snapshot.userName) ?? (snapshot.renamed ? clean(snapshot.title) : undefined);
  return {
    ...(user ? { userName: user } : {}),
    ...(clean(snapshot.title) ? { launchTitle: clean(snapshot.title) } : {}),
  };
}

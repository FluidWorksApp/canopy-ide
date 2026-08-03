// When the omnibox stops being a search box and becomes a composer.
//
// One input serves two jobs that look identical for the first few keystrokes.
// "prview" is a search. "the PR tab flickers when the diff is wide, look at
// PrView.tsx and fix it" is a prompt — and every source in the registry will
// still gamely rank it, so the palette answers a paragraph with a list of
// filenames that happen to share letters with it.
//
// The switch is not a mode the user sets. It is read off what they are doing:
// a line break, a length no filename has, or a pasted image. Any of those and
// the palette stops offering matches and offers the two things you can do with
// a sentence — run it, or research it.
import { basename } from "./paths";

/** Past this many characters, a query is prose. Deliberately generous: real
 *  searches are short ("prview", "max canon", "browser watchdog"), and the cost
 *  of switching too early is a palette that hides results someone wanted. */
export const PROMPT_CHARS = 80;

/** …and past this many words, whatever the length.
 *
 *  Length alone gets the middle wrong. "the PR tab flickers when the diff is
 *  wide, look at PrView.tsx and fix it" is 77 characters — under any threshold
 *  loose enough to leave `src/components/ProjectView/index.tsx` searchable —
 *  and unmistakably a sentence. Nobody searches in fifteen words; a path is one
 *  word however long it gets. Counting both catches the long search term and
 *  the short instruction, which one number never does. */
export const PROMPT_WORDS = 8;

/** Is this a prompt rather than a query?
 *
 *  An attachment settles it on its own: nobody pastes a screenshot to search
 *  for a filename. */
export function isPrompt(text: string, attachments = 0): boolean {
  if (attachments > 0) return true;
  if (text.includes("\n")) return true;
  const t = text.trim();
  if (t.length > PROMPT_CHARS) return true;
  return t.split(/\s+/).filter(Boolean).length >= PROMPT_WORDS;
}

/** An image the user pasted, once it is on disk where an agent can read it. */
export interface SpotAttachment {
  /** Absolute path under `.canopy/spot/` — what the brief points at. */
  path: string;
  /** A small data URL for the chip. Never the full image: these sit in React
   *  state and a 4K screenshot inlined as base64 is megabytes per keystroke. */
  thumb: string;
}

/** The file name alone, for the chip's label. */
export function attachmentLabel(path: string): string {
  return basename(path) || path;
}

/** The brief an action carries, with the attachments named in it.
 *
 *  The paths go in the text rather than beside it because the thing that
 *  receives this is an agent CLI reading a prompt: it has file tools and no way
 *  to be handed a picture. Same contract the preview's screenshots use — the
 *  pixels are on disk, the prompt says where. */
export function briefWithAttachments(text: string, attachments: SpotAttachment[]): string {
  const body = text.trim();
  if (attachments.length === 0) return body;
  const list = attachments.map((a) => a.path).join(", ");
  const what =
    attachments.length === 1
      ? `The image at ${list} is part of this`
      : `The images at ${list} are part of this`;
  // The instruction to open them is explicit: an agent given a path in prose
  // will often describe it rather than read it.
  return body
    ? `${body}\n\n${what} — they are PNGs on disk, open them with your file tools before answering.`
    : `${what} — they are PNGs on disk, open them with your file tools. Look at them and tell me what you see.`;
}

/** The images in a paste, ignoring everything else on the clipboard.
 *
 *  Reads `items` rather than `files` because a screenshot copied from Preview
 *  or a browser arrives as an item with no file entry on WebKit. */
export function pastedImages(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  for (const item of data.items ?? []) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}

/** How tall the composer should be, in rows — shared with the companion's
 *  chat, so it lives in ./composer and is re-exported here for the callers
 *  that already knew it by this module. */
export { COMPOSER_MAX_ROWS, composerRows } from "./composer";

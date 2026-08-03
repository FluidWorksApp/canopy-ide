// What every field you write a sentence into shares: Enter sends, and there is
// a way to say "not yet, this has another line in it".
//
// Shift+Enter a textarea already does on its own. Option+Enter it does not —
// macOS hands the keypress through with `altKey` set and no character, so a
// field that only checks `shiftKey` treats the chord the user reached for to
// break the line as the one that submits. Both chords are spelled out here so
// both fields agree on them, and the insertion is done by hand for the same
// reason.

/** Enter, held with something that means "new line" rather than "send". */
export function isNewlineChord(e: {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}): boolean {
  if (e.key !== "Enter") return false;
  // Cmd/Ctrl+Enter is a submit chord elsewhere; it is never a line break.
  if (e.metaKey || e.ctrlKey) return false;
  return e.shiftKey || e.altKey;
}

/** Put a line break at the caret and leave the caret after it.
 *
 *  Writes through the DOM node first, then returns the value for React state,
 *  so the re-render finds the textarea already holding what it is about to set
 *  and leaves the selection where the user is typing. */
export function insertNewlineAtCaret(el: HTMLTextAreaElement): string {
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? start;
  if (typeof el.setRangeText === "function") {
    el.setRangeText("\n", start, end, "end");
  } else {
    el.value = `${el.value.slice(0, start)}\n${el.value.slice(end)}`;
    el.selectionStart = el.selectionEnd = start + 1;
  }
  return el.value;
}

/** How tall a composer should be, in rows, for `text`.
 *
 *  Capped: past this the field would eat whatever is under it, and a textarea
 *  that scrolls is a normal thing to type into. */
export const COMPOSER_MAX_ROWS = 8;

export function composerRows(text: string, cols = 60): number {
  if (!text) return 1;
  // Wrapped lines count too, or pasting one long unbroken paragraph leaves a
  // one-line box with the text scrolled out of sight.
  const lines = text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / cols)), 0);
  return Math.max(1, Math.min(COMPOSER_MAX_ROWS, lines));
}

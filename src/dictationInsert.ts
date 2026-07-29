// Typing the streaming preview straight into the focused field, so the words
// appear where they are going rather than in a status pill you then have to
// look away from.
//
// The awkward part is that a streaming hypothesis is not append-only. The
// decoder revises the last few words as more audio arrives, so "recognise
// speech" can become "wreck a nice beach" one pass later. Writing that
// naively would leave both in the field. So we keep the exact string we put
// in, and on each revision delete back to the common prefix and retype the
// rest — the same correction SuprFlow's TextInjectionService does with
// backspaces, except we can address the field directly.
//
// Everything that decides WHAT to change is pure and lives here, so the
// interesting cases are testable without a real text field; applyEdit is the
// only part that touches the DOM.

/** How many leading characters two strings share. */
export function commonPrefixLen(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/** A replacement to perform on the field: select [start, end) and put `text`
 *  there. An empty `text` with start < end is a pure deletion. */
export interface LiveEdit {
  start: number;
  end: number;
  text: string;
}

/** Work out how to turn what we have already written into `next`.
 *
 *  Returns null when the field no longer looks the way we left it — the user
 *  moved the caret or typed something. We then stop writing rather than
 *  guess, because every repair we could attempt risks eating text we did not
 *  put there. Losing the live preview is a papercut; deleting someone's
 *  sentence is not.
 *
 *  `caret` must be a collapsed cursor (selectionStart === selectionEnd);
 *  callers check that before asking. */
export function planLiveEdit(
  value: string,
  caret: number,
  written: string,
  next: string,
): LiveEdit | null {
  const start = caret - written.length;
  if (start < 0) return null;
  // Our text must still be sitting immediately behind the cursor, untouched.
  if (value.slice(start, caret) !== written) return null;
  if (next === written) return null;

  const keep = commonPrefixLen(written, next);
  return { start: start + keep, end: caret, text: next.slice(keep) };
}

/** The edit that swaps the whole streamed region for the final text. Same
 *  consistency check: if the field drifted, the caller inserts normally at the
 *  cursor instead of overwriting a region it no longer owns. */
export function planFinalEdit(
  value: string,
  caret: number,
  written: string,
  final: string,
): LiveEdit | null {
  const start = caret - written.length;
  if (start < 0) return null;
  if (value.slice(start, caret) !== written) return null;
  return { start, end: caret, text: final };
}

/** A field we are willing to stream into.
 *
 *  Deliberately narrow. Plain inputs and textareas are ours to edit: we can
 *  address a range exactly and execCommand fires the input events React
 *  listens for. Excluded, because live correction there would do harm rather
 *  than good:
 *
 *  - xterm's helper textarea — terminal text is already on the wire; taking
 *    it back means writing backspaces into a shell or a TUI and hoping.
 *  - Monaco's hidden textarea — the editor owns and clears it on its own
 *    schedule, so a range we selected a moment ago may no longer mean
 *    anything.
 *  - contenteditable — the caret is a position in a tree, not an offset, and
 *    verifying we still own a region is not something to get subtly wrong.
 *
 *  Those all keep the pill preview and the single insert at the end, exactly
 *  as before. */
export function liveInsertTarget(
  el: Element | null,
): HTMLInputElement | HTMLTextAreaElement | null {
  if (!el) return null;
  const tag = el.tagName;
  if (tag !== "TEXTAREA" && tag !== "INPUT") return null;
  if (el.classList.contains("xterm-helper-textarea")) return null;
  if (el.closest(".monaco-editor")) return null;
  const field = el as HTMLInputElement | HTMLTextAreaElement;
  if (field.readOnly || field.disabled) return null;
  // Only free-text inputs have a usable selection API.
  if (tag === "INPUT") {
    const type = (field as HTMLInputElement).type;
    if (type !== "text" && type !== "search" && type !== "url" && type !== "email") {
      return null;
    }
  }
  return field;
}

/** Apply an edit through execCommand so the host framework sees real input
 *  events — assigning to .value directly would update the pixels and leave
 *  React's state, and anything derived from it, behind. */
export function applyEdit(
  field: HTMLInputElement | HTMLTextAreaElement,
  edit: LiveEdit,
): boolean {
  if (document.activeElement !== field) return false;
  field.setSelectionRange(edit.start, edit.end);
  if (edit.text) {
    return document.execCommand("insertText", false, edit.text);
  }
  if (edit.end > edit.start) {
    return document.execCommand("delete");
  }
  return true;
}

/** Is the cursor a plain caret, rather than a selection we would clobber? */
export function hasCollapsedCaret(
  field: HTMLInputElement | HTMLTextAreaElement,
): boolean {
  return (
    field.selectionStart !== null &&
    field.selectionStart === field.selectionEnd
  );
}

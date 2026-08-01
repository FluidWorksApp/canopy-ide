// What the user is looking at, for the agent tools (canopy_editor_state).
//
// The IDE is the only thing that knows what "this" means in "fix this" — which
// file is in front of the user, where the caret sits, what they highlighted.
// Monaco owns that, and it lives several components below the snapshot
// publisher, so it lands here instead of being threaded through props: the
// editor writes, ProjectView subscribes.
//
// Selections are capped: an agent needs the highlighted expression, not a
// pasted copy of the file.
import { createChannel } from "./channel";

const MAX_SELECTION = 2000;

export interface EditorCaret {
  path: string;
  line: number;
  column: number;
  /** The highlighted text, truncated; absent when the selection is empty. */
  selection?: string;
  selectionStartLine?: number;
  selectionEndLine?: number;
}

const board = createChannel<EditorCaret | null>(null, {
  same: (a, b) =>
    a?.path === b?.path &&
    a?.line === b?.line &&
    a?.column === b?.column &&
    a?.selection === b?.selection,
});

export const setCaret = board.set;

export const getCaret = board.get;

/** Forget a file's caret when its tab closes, so a closed file never reads as
 *  "what the user is looking at". */
export function clearCaret(path: string) {
  if (board.get()?.path === path) board.set(null);
}

export const subscribeCaret = board.subscribe;

export function truncateSelection(text: string): string {
  return text.length > MAX_SELECTION ? `${text.slice(0, MAX_SELECTION)}…` : text;
}

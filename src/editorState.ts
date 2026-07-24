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

let caret: EditorCaret | null = null;
const listeners = new Set<() => void>();

export function setCaret(next: EditorCaret | null) {
  const same =
    caret?.path === next?.path &&
    caret?.line === next?.line &&
    caret?.column === next?.column &&
    caret?.selection === next?.selection;
  if (same) return;
  caret = next;
  for (const l of listeners) l();
}

export function getCaret(): EditorCaret | null {
  return caret;
}

/** Forget a file's caret when its tab closes, so a closed file never reads as
 *  "what the user is looking at". */
export function clearCaret(path: string) {
  if (caret?.path === path) setCaret(null);
}

export function subscribeCaret(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function truncateSelection(text: string): string {
  return text.length > MAX_SELECTION ? `${text.slice(0, MAX_SELECTION)}…` : text;
}

/**
 * Bounded view-state ownership for inactive Monaco editors.
 *
 * Models remain Monaco's source of truth for text/undo history. This cache is
 * deliberately small and stores only cursor/scroll/folding presentation state
 * so an inactive editor instance and its DOM/canvas surfaces can be disposed.
 */

export const EDITOR_VIEW_STATE_LIMIT = 32;

const states = new Map<string, unknown>();

export function rememberEditorViewState(key: string, state: unknown): void {
  if (!key || state == null) return;
  states.delete(key);
  states.set(key, state);
  while (states.size > EDITOR_VIEW_STATE_LIMIT) {
    const oldest = states.keys().next().value as string | undefined;
    if (oldest == null) break;
    states.delete(oldest);
  }
}

export function editorViewState<T = unknown>(key: string): T | null {
  const state = states.get(key);
  if (state == null) return null;
  // Reading is use: move it to the MRU end without duplicating storage.
  states.delete(key);
  states.set(key, state);
  return state as T;
}

export function forgetEditorViewState(key: string): void {
  states.delete(key);
}

export function editorViewStateMetrics(): {
  retained: number;
  limit: number;
} {
  return { retained: states.size, limit: EDITOR_VIEW_STATE_LIMIT };
}

export function resetEditorViewStates(): void {
  states.clear();
}

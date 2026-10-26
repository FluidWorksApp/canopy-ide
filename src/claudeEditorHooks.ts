// The editor's half of the Claude Code IDE link (claudeIde.ts): what Monaco
// calls when its selection moves or the user picks "Add to Claude".
//
// A registry rather than an import of the bridge, so MonacoEditor stays free
// of IPC and of the language-server plumbing the bridge pulls in — the editor
// only ever sees these two functions, or nothing.
import type { editor } from "monaco-editor";
import type { EditorSelection } from "./claudeIde";

/** What the editor calls into. Absent means the link is not running: the
 *  editor then does nothing extra. */
export interface ClaudeEditorHooks {
  selection(model: editor.ITextModel, selection: EditorSelection): void;
  /** Resolves with a sentence for the user when the mention went nowhere. */
  addToClaude(
    model: editor.ITextModel,
    selection: EditorSelection | null,
  ): Promise<string | null>;
}

let editorHooks: ClaudeEditorHooks | null = null;
export function installClaudeEditorHooks(hooks: ClaudeEditorHooks): () => void {
  editorHooks = hooks;
  return () => {
    if (editorHooks === hooks) editorHooks = null;
  };
}
export const claudeEditorHooks = () => editorHooks;

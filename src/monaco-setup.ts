// Central Monaco bootstrap. `monaco-editor` is aliased in package.json to
// @codingame/monaco-vscode-editor-api so the editor instance and
// monaco-languageclient share the exact same monaco-vscode-api build.
//
// monaco-vscode-api requires an explicit service initialization before ANY
// editor/model call resolves (they queue behind a barrier) — MonacoVscodeApiWrapper
// in 'classic' mode wires the minimal service set + monarch highlighting.
import * as monaco from "monaco-editor";
import { MonacoVscodeApiWrapper } from "monaco-languageclient/vscodeApiWrapper";
import { configureDefaultWorkerFactory } from "monaco-languageclient/workerFactory";
// Registers the monarch grammars (typescript, rust, python, ...) used by classic mode.
import "@codingame/monaco-vscode-standalone-languages";
import { registerTauriFileSystem } from "./lsp/fsProvider";

export const monacoReady: Promise<void> = (async () => {
  registerTauriFileSystem();
  const wrapper = new MonacoVscodeApiWrapper({
    $type: "classic",
    viewsConfig: { $type: "EditorService" },
    monacoWorkerFactory: configureDefaultWorkerFactory,
  });
  await wrapper.start();

  monaco.editor.defineTheme("canopy-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1a1b26",
    },
  });
})();

export function languageForPath(path: string): string | undefined {
  const name = path.split("/").pop() ?? path;
  const ext = "." + (name.split(".").pop() ?? "");
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.extensions?.includes(ext) || lang.filenames?.includes(name)) {
      return lang.id;
    }
  }
  return undefined;
}

/** Get or create the shared text model for a file. */
export function modelFor(path: string, content: string): monaco.editor.ITextModel {
  const uri = monaco.Uri.file(path);
  const existing = monaco.editor.getModel(uri);
  if (existing) return existing;
  return monaco.editor.createModel(content, languageForPath(path), uri);
}

export { monaco };

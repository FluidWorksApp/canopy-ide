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
import {
  customLanguageFor,
  extraLanguageFor,
  sanitizeAssociations,
} from "./fileAssociations";
import { getSettings } from "./settings";

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
  monaco.editor.defineTheme("canopy-light", {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#f2f3f7",
    },
  });
  // Vitrine is glass all the way down: the editor paints no surface of its
  // own and the app's ambient field shows through, tinted by
  // `.project-content` in index.css. A slab here would be the one opaque
  // rectangle in the skin, and it covers most of the window.
  monaco.editor.defineTheme("canopy-vitrine", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#00000000",
      "editorGutter.background": "#00000000",
      "minimap.background": "#00000000",
      "editorOverviewRuler.background": "#00000000",
    },
  });
  // Monaco doesn't read CSS variables, so it follows the skin by hand:
  // Daylight maps to canopy-light, Vitrine to canopy-vitrine, everything else
  // to canopy-dark — once at service startup (editors mount with whatever is
  // then active) and again on every live skin switch (settings.ts dispatches
  // canopy:theme).
  const monacoThemeForSkin = () => {
    try {
      const stored = JSON.parse(localStorage.getItem("canopy.settings") ?? "{}") as {
        theme?: string;
      };
      if (stored.theme === "vitrine") return "canopy-vitrine";
      const light =
        stored.theme === "daylight" ||
        (stored.theme === "auto" &&
          !window.matchMedia("(prefers-color-scheme: dark)").matches);
      return light ? "canopy-light" : "canopy-dark";
    } catch {
      return "canopy-dark";
    }
  };
  monaco.editor.setTheme(monacoThemeForSkin());
  // Same pulse every settings write fires: re-read the skin, and re-language
  // open models in case the file associations changed.
  window.addEventListener("canopy:theme", () => {
    monaco.editor.setTheme(monacoThemeForSkin());
    refreshModelLanguages();
  });
})();

/**
 * Language id for a file, resolved in precedence order:
 *
 *   1. the user's own associations (Settings → Editor) — an explicit choice
 *      outranks everything, including a grammar Monaco ships;
 *   2. Monaco's registry — the real grammars, matched on extension or name;
 *   3. Canopy's gap-filling table (fileAssociations.ts) — the closest grammar
 *      for file types Monaco has none for at all (.astro, .cpp, .toml, …).
 *
 * Undefined means "no idea", which Monaco renders as plain text.
 */
function resolveLanguage(path: string, custom: Record<string, string>): string | undefined {
  const own = customLanguageFor(path, custom);
  if (own) return own;
  const name = path.split("/").pop() ?? path;
  const ext = "." + (name.split(".").pop() ?? "");
  for (const lang of monaco.languages.getLanguages()) {
    if (lang.extensions?.includes(ext) || lang.filenames?.includes(name)) {
      return lang.id;
    }
  }
  return extraLanguageFor(path);
}

const userAssociations = () => sanitizeAssociations(getSettings().fileAssociations);

export function languageForPath(path: string): string | undefined {
  return resolveLanguage(path, userAssociations());
}

/** Re-language every open model. Associations are resolved at lookup time, so
 *  a model created before the mapping changed is the only thing that would
 *  otherwise keep the old highlighting until the tab is reopened. */
export function refreshModelLanguages(): void {
  // One settings read for the whole sweep, not one per open file.
  const custom = userAssociations();
  for (const model of monaco.editor.getModels()) {
    const next = resolveLanguage(model.uri.path, custom) ?? "plaintext";
    if (model.getLanguageId() !== next) monaco.editor.setModelLanguage(model, next);
  }
}

/** Get or create the shared text model for a file. */
export function modelFor(path: string, content: string): monaco.editor.ITextModel {
  const uri = monaco.Uri.file(path);
  const existing = monaco.editor.getModel(uri);
  if (existing) return existing;
  return monaco.editor.createModel(content, languageForPath(path), uri);
}

export { monaco };

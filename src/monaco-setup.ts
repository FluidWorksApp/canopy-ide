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
import { SKINS, skinDef } from "./skins/registry";
import { basename } from "./paths";

export const monacoReady: Promise<void> = (async () => {
  registerTauriFileSystem();
  const wrapper = new MonacoVscodeApiWrapper({
    $type: "classic",
    viewsConfig: { $type: "EditorService" },
    monacoWorkerFactory: configureDefaultWorkerFactory,
  });
  await wrapper.start();

  // Monaco doesn't read CSS custom properties, so every skin declares the
  // editor surface it wants in src/skins/<id>.ts and gets a Monaco theme of
  // its own here. One definition per skin beats a light/dark fork: a skin
  // added to the registry can never fall through to somebody else's canvas.
  for (const s of SKINS) {
    monaco.editor.defineTheme(`canopy-${s.id}`, {
      base: s.monaco.base,
      inherit: true,
      rules: [],
      colors: s.monaco.colors,
    });
  }
  // Resolved once at service startup (editors mount with whatever is then
  // active) and again on every live skin switch (settings.ts dispatches
  // canopy:theme). Read from localStorage rather than getSettings() because
  // this runs before the settings module is guaranteed initialised.
  const monacoThemeForSkin = () => {
    try {
      const stored = JSON.parse(localStorage.getItem("canopy.settings") ?? "{}") as {
        theme?: string;
      };
      // "auto" resolves the same way it does everywhere else.
      const id =
        stored.theme === "auto" || !stored.theme
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "gotham"
            : "daylight"
          : stored.theme;
      // skinDef() resolves anything unknown to the base skin, which is where
      // a retired id lands.
      return `canopy-${skinDef(id).id}`;
    } catch {
      return "canopy-gotham";
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
  const name = basename(path) || path;
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

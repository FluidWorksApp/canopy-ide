// What a skin is, as one value.
//
// Before this, adding a skin meant five separate edits — a token block in
// index.css, an id in the Theme union, a row in THEMES, a preview swatch in
// SettingsDialog, an xterm palette in terminalThemes, a Monaco theme in
// monaco-setup — and forgetting any one of them was silent: the app recoloured
// and the terminal quietly stayed Tokyo Night. A skin is now a directory entry
// that declares all of it, and every consumer reads the registry.
//
// The one thing that can't live in TypeScript is the CSS token block itself,
// because switching skins has to stay a single attribute flip on
// <html data-theme="…"> with nothing re-rendering. So each skin ships its
// palette as `src/skins/<id>.css` and skins.css imports it.

/** xterm.js ITheme, restated so this file stays dependency-free (Term.tsx is
 *  where the real type gets used). The terminal renders to a canvas and can't
 *  read CSS custom properties, which is why a skin has to say all sixteen ANSI
 *  slots out loud. */
export interface TermTheme {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** Monaco doesn't read CSS custom properties either. A skin says which built-in
 *  it derives from and which surfaces it repaints — usually just the editor
 *  background, since the token colours of `vs`/`vs-dark` are already tuned. */
export interface MonacoSkin {
  base: "vs" | "vs-dark" | "hc-black";
  colors: Record<string, string>;
}

/** The three swatches the Settings → Appearance card draws over the skin's own
 *  surface. `bg` may be any CSS background (Vitrine previews its field as a
 *  gradient), the rest are flat colours. */
export interface SkinPreview {
  bg: string;
  raised: string;
  text: string;
  accent: string;
}

export interface SkinDef {
  /** Also the `data-theme` value and the persisted settings value — never
   *  renamed once shipped, or everyone who picked it loses their choice. */
  id: string;
  /** Title case, as shown in the picker. */
  label: string;
  /** The one-line note under the name in the picker. Lowercase, no full stop —
   *  "midnight + blue", "glass · dark". */
  note: string;
  preview: SkinPreview;
  term: TermTheme;
  monaco: MonacoSkin;
}

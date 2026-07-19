// Appearance engine: dark/light/system + accent, applied through the CSS
// variables everything already uses. The document root carries data-theme;
// the accent overrides --accent inline; xterm and Monaco (the two surfaces
// that don't read CSS variables) get matching palettes pushed to them.
import { monaco } from "./monaco-setup";
import { getSettings } from "./settings";

export type ThemePref = "system" | "dark" | "light";

export const ACCENTS: Record<string, string> = {
  blue: "#7aa2f7",
  purple: "#bb9af7",
  teal: "#73daca",
  green: "#9ece6a",
  orange: "#ff9e64",
  pink: "#f7768e",
};

export const resolvedTheme = (pref: ThemePref): "dark" | "light" =>
  pref === "system"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light"
    : pref;

/** xterm doesn't read CSS variables — hand it a palette per theme. */
export function xtermTheme(): {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
} {
  return resolvedTheme(getSettings().theme) === "light"
    ? {
        background: "#f2f3f7",
        foreground: "#343b58",
        cursor: "#343b58",
        selectionBackground: "#b6bdd9",
      }
    : {
        background: "#16161e",
        foreground: "#c9d1d9",
        cursor: "#c9d1d9",
        selectionBackground: "#33467c",
      };
}

/** Push the current settings onto the document, Monaco and (via the event)
 *  every mounted terminal. Safe to call any time, including before mount. */
export function applyAppearance() {
  const s = getSettings();
  const mode = resolvedTheme(s.theme);
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.setProperty("--accent", ACCENTS[s.accent] ?? ACCENTS.blue);
  try {
    monaco.editor.setTheme(mode === "light" ? "canopy-light" : "canopy-dark");
  } catch {
    // monaco services not up yet; monaco-setup applies the right theme itself.
  }
  window.dispatchEvent(new CustomEvent("canopy:appearance"));
}

/** Follow the OS while the preference is "system". Returns an unsubscribe. */
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (getSettings().theme === "system") applyAppearance();
  };
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

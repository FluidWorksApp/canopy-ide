// xterm.js color themes, one per skin. The rest of the theme system recolors
// every DOM element for free via CSS custom properties, but the terminal
// renders to a canvas and needs its own JS-side color object pushed
// explicitly — this is that object. Shapes match @xterm/xterm's ITheme
// (background, foreground, cursor, selectionBackground, plus the 16 ANSI
// slots); not imported from xterm here to keep this file dependency-free —
// Term.tsx is where the type actually gets used.
import type { Theme } from "./settings";

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

// Default was already, unlabeled, a Tokyo Night palette (--danger/--ok/--warn
// /--accent are Tokyo Night's red/green/yellow/blue) — this just completes it
// with the rest of the 16 ANSI slots instead of leaving them at xterm's
// generic built-in defaults.
const DEFAULT_TERM_THEME: TermTheme = {
  background: "#16161e",
  foreground: "#c9d1d9",
  cursor: "#c9d1d9",
  selectionBackground: "#33467c",
  black: "#414868",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#f7768e",
  brightGreen: "#9ece6a",
  brightYellow: "#e0af68",
  brightBlue: "#7aa2f7",
  brightMagenta: "#bb9af7",
  brightCyan: "#7dcfff",
  brightWhite: "#c0caf5",
};

const GOTHAM_TERM_THEME: TermTheme = {
  background: "#101317",
  foreground: "#e8e6df",
  cursor: "#d4af37",
  selectionBackground: "#3a3320",
  black: "#2b2f36",
  red: "#e0483e",
  green: "#4caf7d",
  yellow: "#e2943a",
  blue: "#6b93c9",
  magenta: "#b78fce",
  cyan: "#5fb3b3",
  white: "#8b8d93",
  brightBlack: "#57595f",
  brightRed: "#ff6b5e",
  brightGreen: "#6bcf9a",
  brightYellow: "#f0a83c",
  brightBlue: "#8fb4e3",
  brightMagenta: "#d0aee6",
  brightCyan: "#7fd4d4",
  brightWhite: "#e8e6df",
};

// A light background needs darker-than-usual ANSI colors to stay readable —
// the same hue family as Default/the app's --danger/--ok/--warn/--accent
// (which are already darkened for Daylight in index.css), just carried into
// the terminal too.
const DAYLIGHT_TERM_THEME: TermTheme = {
  background: "#ffffff",
  foreground: "#1c1f26",
  cursor: "#3b6fd6",
  selectionBackground: "#cfe0fb",
  black: "#24292e",
  red: "#c9414f",
  green: "#2f9e5c",
  yellow: "#a5690f",
  blue: "#3b6fd6",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6a737d",
  brightBlack: "#586069",
  brightRed: "#e5534b",
  brightGreen: "#3fb950",
  brightYellow: "#c69026",
  brightBlue: "#5b8def",
  brightMagenta: "#a371f7",
  brightCyan: "#39c5cf",
  brightWhite: "#1c1f26",
};

/** The current skin's terminal palette. "custom" starts from Default's and
 *  substitutes the picked accent into cursor/blue/brightBlue — the one
 *  color the user actually chose, same as it does for --accent everywhere
 *  else — rather than asking for 16 colors on top of one. */
export function terminalTheme(theme: Theme, customAccent?: string): TermTheme {
  if (theme === "auto") {
    theme = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "default"
      : "daylight";
  }
  switch (theme) {
    case "gotham":
      return GOTHAM_TERM_THEME;
    case "daylight":
      return DAYLIGHT_TERM_THEME;
    case "custom": {
      const accent = customAccent || DEFAULT_TERM_THEME.blue;
      return { ...DEFAULT_TERM_THEME, cursor: accent, blue: accent, brightBlue: accent };
    }
    default:
      return DEFAULT_TERM_THEME;
  }
}

import type { SkinDef } from "./types";

/** Default is the only skin with no `[data-theme]` block of its own: its
 *  palette IS the `:root` token contract in index.css, and every other skin is
 *  an override of it. So there is no `default.css`. */
export const defaultSkin: SkinDef = {
  id: "default",
  label: "Default",
  note: "midnight + blue",
  preview: {
    bg: "#1a1b26",
    raised: "#1f2335",
    text: "#c9d1d9",
    accent: "#7aa2f7",
  },
  // Default was already, unlabeled, a Tokyo Night palette (--danger/--ok/--warn
  // /--accent are Tokyo Night's red/green/yellow/blue) — this completes it with
  // the rest of the 16 ANSI slots instead of leaving them at xterm's generic
  // built-in defaults.
  term: {
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
  },
  monaco: { base: "vs-dark", colors: { "editor.background": "#1a1b26" } },
};

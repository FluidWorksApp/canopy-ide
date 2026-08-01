import type { SkinDef } from "./types";

export const daylight: SkinDef = {
  id: "daylight",
  label: "Daylight",
  note: "light",
  preview: {
    bg: "#f5f6f8",
    raised: "#ffffff",
    text: "#1c1f26",
    accent: "#3b6fd6",
  },
  // A light background needs darker-than-usual ANSI colours to stay readable —
  // the same hue family as the app's --danger/--ok/--warn/--accent (already
  // darkened for Daylight in the token block), carried into the terminal too.
  term: {
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
  },
  monaco: { base: "vs", colors: { "editor.background": "#f2f3f7" } },
};

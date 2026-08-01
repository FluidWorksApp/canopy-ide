import type { SkinDef } from "./types";

export const slate: SkinDef = {
  id: "slate",
  label: "Slate",
  note: "cool grey + steel",
  preview: {
    bg: "#13171c",
    raised: "#1e242c",
    text: "#dbe2ea",
    accent: "#6fa8dc",
  },
  // The terminal panel paints --bg-alt, so the canvas takes --bg-alt too and the
  // seam between panel and xterm disappears. The status hues are the token block
  // verbatim — a green in the terminal that disagrees with a green in the diff
  // gutter is the thing a skin is supposed to prevent. Brights are the same six
  // hues raised in luminance rather than washed toward white, which is what
  // keeps a steel palette from reading as grey-on-grey once a build starts
  // printing.
  term: {
    background: "#161a20",
    foreground: "#dbe2ea",
    cursor: "#6fa8dc",
    selectionBackground: "#2e3f52",
    black: "#2c343e",
    red: "#e0707f",
    green: "#7cbf8a",
    yellow: "#d9a95f",
    blue: "#6fa8dc",
    magenta: "#a992d8",
    cyan: "#6fc4d4",
    white: "#8d9aa9",
    brightBlack: "#606b77",
    brightRed: "#ef8a97",
    brightGreen: "#96d3a2",
    brightYellow: "#ecc07a",
    brightBlue: "#93c1e8",
    brightMagenta: "#c2aee8",
    brightCyan: "#8fd8e5",
    brightWhite: "#dbe2ea",
  },
  monaco: { base: "vs-dark", colors: { "editor.background": "#13171c" } },
};

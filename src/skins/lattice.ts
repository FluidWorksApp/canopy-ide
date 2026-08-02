import type { SkinDef } from "./types";

export const lattice: SkinDef = {
  id: "lattice",
  label: "Lattice",
  note: "tui · box-drawn",
  // --bg-deep and --bg sit a shade apart rather than merging the way Pixel's
  // do: a TUI draws its panes as boxes on one field, and the field has to be
  // readable as a field. `raised` is what a focused box is filled with — the
  // only fill in the skin, since everything else is a hairline.
  preview: {
    bg: "#080b0e",
    raised: "#10151a",
    text: "#e4e9ed",
    accent: "#35c3d1",
  },
  // A terminal palette for a skin that is already a terminal. The sixteen
  // slots are the skin's own hues rather than a stock ANSI set, so a box drawn
  // by a TUI *inside* the terminal lands on the same teal as the boxes Canopy
  // draws around it — which is the whole illusion this skin is after.
  //
  // The background is --bg-alt, not --bg: the terminal is a pane like any
  // other, and a pane in this style is the panel surface with a line around
  // it. Blue and cyan are deliberately distinct — the accent teal (#35c3d1)
  // takes `cyan`, and a colder #6cb6ff takes `blue`, because a diff that
  // renders both as one hue loses half its meaning, and this is a skin people
  // will read diffs in.
  term: {
    background: "#0a0e12",
    foreground: "#e4e9ed",
    cursor: "#35c3d1",
    selectionBackground: "#2e3d49",
    black: "#10151a",
    red: "#d95c5c",
    green: "#6aac5e",
    yellow: "#c78a33",
    blue: "#4a8fd9",
    magenta: "#a874b8",
    cyan: "#2ba3af",
    white: "#93a1ac",
    brightBlack: "#63727e",
    brightRed: "#ff6b6b",
    brightGreen: "#7ec96f",
    brightYellow: "#e8a33d",
    brightBlue: "#6cb6ff",
    brightMagenta: "#c98bdb",
    brightCyan: "#35c3d1",
    brightWhite: "#e4e9ed",
  },
  monaco: { base: "vs-dark", colors: { "editor.background": "#080b0e" } },
};

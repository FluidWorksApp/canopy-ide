import type { SkinDef } from "./types";

export const plum: SkinDef = {
  id: "plum",
  label: "Plum",
  note: "deep aubergine + rose",
  preview: {
    bg: "#150f1a",
    raised: "#221929",
    text: "#ebe0f0",
    accent: "#e878b0",
  },
  // ANSI red is the skin's own --danger rather than a stock red, because the
  // cursor is rose and a generic red next to it would read as a second cursor.
  // Held at hue 355 against the accent's 330 it stays the one warm thing on
  // screen that isn't the caret.
  //
  // There is no --blue token to derive from, so blue is chosen: a violet-
  // leaning periwinkle, far enough off --magenta's 269 to stay a separate
  // colour and cool enough that an aubergine background doesn't drag it into
  // the accent's family.
  //
  // Bright slots hold their hue and gain luminance — nothing collapses to
  // white, which on a purple background would look like a rendering fault.
  term: {
    background: "#191220",
    foreground: "#ebe0f0",
    cursor: "#e878b0",
    selectionBackground: "#4a2b41",
    black: "#332741",
    red: "#f0616e",
    green: "#6fcf97",
    yellow: "#e0aa55",
    blue: "#7d95e0",
    magenta: "#c79bf5",
    cyan: "#68c9df",
    white: "#9e8daa",
    brightBlack: "#6d5f78",
    brightRed: "#ff828c",
    brightGreen: "#8fe0b1",
    brightYellow: "#f2c477",
    brightBlue: "#9db1ee",
    brightMagenta: "#dcbaff",
    brightCyan: "#8bdcef",
    brightWhite: "#ebe0f0",
  },
  monaco: { base: "vs-dark", colors: { "editor.background": "#150f1a" } },
};

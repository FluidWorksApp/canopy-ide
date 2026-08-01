import type { SkinDef } from "./types";

export const dusk: SkinDef = {
  id: "dusk",
  label: "Dusk",
  note: "sepia night",
  preview: {
    bg: "#191410",
    raised: "#251f18",
    text: "#ece0cf",
    accent: "#e0b060",
  },
  // Everything here that has a token is the token: the terminal is the one
  // surface in the app that can't read them, and a phosphor skin whose terminal
  // drifts from its own shell is the whole point missed.
  //
  // Blue is the exception, and it's chosen rather than derived. A saturated blue
  // is the single thing this skin exists to keep off the screen, so the slot
  // gets a desaturated grey-violet with red lifted over green — enough short
  // wavelength to read as "the blue one" next to cyan and magenta, not enough to
  // be the brightest thing in a log line at midnight.
  term: {
    background: "#1d1813",
    foreground: "#ece0cf",
    cursor: "#e0b060",
    selectionBackground: "#453620",
    black: "#352d24",
    red: "#dd6a5c",
    green: "#8fb56a",
    yellow: "#d99a48",
    blue: "#948da3",
    magenta: "#c294c0",
    cyan: "#78aeae",
    white: "#a8967e",
    brightBlack: "#756757",
    brightRed: "#ef8477",
    brightGreen: "#a8cd84",
    brightYellow: "#f0b665",
    brightBlue: "#b0a8be",
    brightMagenta: "#d8afd6",
    brightCyan: "#94c8c8",
    brightWhite: "#ece0cf",
  },
  monaco: { base: "vs-dark", colors: { "editor.background": "#191410" } },
};

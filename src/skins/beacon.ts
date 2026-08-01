import type { SkinDef } from "./types";

export const beacon: SkinDef = {
  id: "beacon",
  label: "Beacon",
  note: "high contrast · AAA",
  preview: {
    bg: "#000000",
    raised: "#1c1c1c",
    text: "#ffffff",
    accent: "#ffd400",
  },
  // The rest of the roster derives its ANSI ramp straight from its palette and
  // lets the dark slots stay dark, because a dim `black` is what makes box art
  // and de-emphasised output recede. That trade is the one thing this skin
  // doesn't get to make: a person who picked Beacon picked it because dim text
  // is not readable text, and a build log that turns half-invisible in the
  // terminal is the same failure the app just spent eighteen tokens avoiding.
  // So every slot including black/brightBlack and blue is lifted until it
  // clears 7:1 on the background — measured, not eyeballed. The four greys stay
  // evenly spaced so black → brightBlack → white → brightWhite is still four
  // distinguishable rungs rather than four legible ones that all look alike.
  //
  // The background is --bg-alt rather than the pure black of --bg: it is the
  // panel the terminal actually sits in, and leaving #000000 unclaimed keeps it
  // for Void, whose whole identity is the bottom of the range.
  term: {
    background: "#0d0d0d",
    foreground: "#ffffff",
    cursor: "#ffd400",
    // Selection is the one place two requirements pull apart — lift it enough
    // to be seen as a band and the white on top of it starts to fall. This sits
    // at the top of the range that still holds 7:1 for the text, because a
    // selection you can read matters more than a selection you can spot.
    selectionBackground: "#665824",
    black: "#9d9d9d",
    red: "#ff9494",
    green: "#7bec93",
    yellow: "#ffc45c",
    blue: "#9dc4ff",
    magenta: "#dcbcff",
    cyan: "#8ad9fc",
    white: "#d9d9d9",
    brightBlack: "#bdbdbd",
    brightRed: "#ffb8b8",
    brightGreen: "#a6f5b6",
    brightYellow: "#ffd98c",
    brightBlue: "#c2daff",
    brightMagenta: "#ecd8ff",
    brightCyan: "#b4e9fd",
    brightWhite: "#ffffff",
  },
  // hc-black, not vs-dark. Monaco ships a high-contrast base for exactly this
  // reader and it does two things a repainted vs-dark can't: it brightens the
  // syntax tokens themselves — comments and punctuation in vs-dark sit near the
  // floor and would land back where this skin refuses to put text — and it
  // outlines widgets, the suggest list, the find box, so they read as edges
  // rather than as slightly different blacks. That outlining is the same
  // decision the token block makes about borders, made by the editor.
  monaco: { base: "hc-black", colors: { "editor.background": "#000000" } },
};

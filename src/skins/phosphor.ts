import type { SkinDef } from "./types";

export const phosphor: SkinDef = {
  id: "phosphor",
  label: "Phosphor",
  note: "green CRT",
  preview: {
    bg: "#080d09",
    raised: "#121a13",
    text: "#d9ecd3",
    accent: "#7de03f",
  },
  // The skin every other one only borrows from: here the terminal is the thing
  // the palette was drawn for, so this block is where the compromise gets made
  // rather than inherited.
  //
  // A P1 monitor had one hue and nothing else, and a terminal built that way is
  // unusable — a `git diff` in a single hue is a wall of text with no additions
  // and no deletions in it. So the line is drawn per slot by whether the colour
  // carries meaning: red, yellow, magenta and cyan keep their own hue because a
  // failing test, a warning and a stack trace have to separate at a glance
  // across a room. Everything that does not carry meaning is phosphor — the
  // dark slot is the skin's own --border, the greys are --text-dim and
  // --text-faint, and green is the accent itself rather than the mint --ok that
  // the other skins put there, because in this one green is not a status, it is
  // the tube.
  //
  // Blue is the slot with no token behind it. Held towards teal and drained of
  // saturation so a directory listing doesn't look lit from a second source,
  // but kept far enough off --cyan that `ls` still separates the two.
  term: {
    background: "#0b110c",
    foreground: "#d9ecd3",
    cursor: "#7de03f",
    selectionBackground: "#24451c",
    black: "#22301f",
    red: "#ff5a52",
    green: "#7de03f",
    yellow: "#e8c34a",
    blue: "#62a8c8",
    magenta: "#b98cf0",
    cyan: "#56d6d0",
    white: "#8aa082",
    brightBlack: "#5c7057",
    brightRed: "#ff8079",
    brightGreen: "#a8f56e",
    brightYellow: "#f5d76e",
    brightBlue: "#8cc6e0",
    brightMagenta: "#d3b3f7",
    brightCyan: "#86ebe6",
    brightWhite: "#d9ecd3",
  },
  monaco: { base: "vs-dark", colors: { "editor.background": "#080d09" } },
};

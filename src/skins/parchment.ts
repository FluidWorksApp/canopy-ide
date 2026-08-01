import type { SkinDef } from "./types";

export const parchment: SkinDef = {
  id: "parchment",
  label: "Parchment",
  note: "warm paper · low blue",
  preview: {
    bg: "#faf5ec",
    raised: "#ffffff",
    text: "#2a241c",
    accent: "#9a5b28",
  },
  // The terminal is --bg-alt, a half-step deeper than the editor, so a pane
  // split between the two still has an edge without a border doing the work.
  //
  // Every ANSI slot is the skin's own token family darkened until it reads as
  // ink on paper rather than light through glass: a stock palette's #00ff00 is
  // a rumour at this luminance. Each of the sixteen clears 4.5:1 against the
  // background, checked rather than judged by eye.
  //
  // The bright half is the part a dark palette gets to take for granted. There
  // "bright" means lifted toward the light the screen is emitting, which on
  // paper means faded toward the page — so bright is deepened here instead, and
  // the six chromatic brights are the normals with more ink in them. That keeps
  // the one promise the convention actually makes: bright is the emphatic one.
  // brightWhite is the boldest mark on the page rather than the palest, which
  // matters because it is what most programs reach for when they want a line to
  // stand out. brightBlack keeps its usual job — the dimmed timestamp, the
  // comment — so it is the only slot that moves toward the page rather than
  // away, and it stops while it is still readable. `white` sits below it as the
  // low-emphasis ink, since a light grey on parchment is nothing at all.
  term: {
    background: "#efe8dc",
    foreground: "#2a241c",
    cursor: "#9a5b28",
    selectionBackground: "#e3d3ba",
    black: "#2a241c",
    red: "#a83232",
    green: "#356e35",
    yellow: "#7d5a0d",
    // No --blue token in this skin to derive from. A muted slate, held well
    // short of a link blue: it is the one hue a low-blue page cannot borrow.
    blue: "#34567f",
    magenta: "#71428f",
    cyan: "#1a666c",
    white: "#6f6455",
    brightBlack: "#5f5546",
    brightRed: "#8b2626",
    brightGreen: "#275c2c",
    brightYellow: "#6a4a08",
    brightBlue: "#26405f",
    brightMagenta: "#5a3373",
    brightCyan: "#0f5257",
    brightWhite: "#17120c",
  },
  monaco: { base: "vs", colors: { "editor.background": "#faf5ec" } },
};

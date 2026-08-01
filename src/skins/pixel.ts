import type { SkinDef } from "./types";

export const pixel: SkinDef = {
  id: "pixel",
  label: "Pixel",
  note: "8-bit · phosphor",
  // --bg-deep and --bg are the same value in this skin, so the card's field is
  // simply that: the shell and the editor are one surface and there is no
  // fifth grey to choose between. `raised` is --bg-raised, which with a 2px
  // border is the only separation the material allows.
  preview: {
    bg: "#0a0f0b",
    raised: "#18211a",
    text: "#dce8d6",
    accent: "#b4f04a",
  },
  // A hardware palette, not a tuned one: two intensity rows of the same seven
  // hues, every entry fully saturated, nothing sitting between them. That is
  // what a machine with a colour latch actually gave you, and it is the reason
  // the bright row is a lightness step rather than a pastel wash of the
  // normal one. The app's own status hues land in the bright row, so a
  // terminal red is the same red the rest of the window paints.
  //
  // The background is --bg-alt: the terminal is a panel, and this skin has no
  // gradient or wash that would make it anything else. It is also the one
  // green-family value no other skin lands on — Phosphor's panel is a stop
  // darker and Orchard's is editorial forest, not tube.
  //
  // `blue` and its bright twin are the only slots with no token behind them.
  // The palette declares no blue, and a terminal that renders blue as grey
  // loses half of every diff.
  term: {
    background: "#101711",
    foreground: "#dce8d6",
    cursor: "#b4f04a",
    selectionBackground: "#2c3d2d",
    black: "#18211a",
    red: "#d92b2b",
    green: "#3fa62f",
    yellow: "#d99000",
    blue: "#2f6fd9",
    magenta: "#a63fd9",
    cyan: "#2fb8d9",
    white: "#a9bda4",
    brightBlack: "#465b45",
    brightRed: "#ff5555",
    brightGreen: "#b4f04a",
    brightYellow: "#ffb000",
    brightBlue: "#5f9fff",
    brightMagenta: "#d67bff",
    brightCyan: "#63d8f1",
    brightWhite: "#dce8d6",
  },
  monaco: { base: "vs-dark", colors: { "editor.background": "#0a0f0b" } },
};

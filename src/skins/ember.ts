import type { SkinDef } from "./types";

export const ember: SkinDef = {
  id: "ember",
  label: "Ember",
  note: "warm charcoal + copper",
  preview: {
    bg: "#161212",
    raised: "#221d1c",
    text: "#ede4df",
    accent: "#e07a4a",
  },
  // Ember's danger and warn sit close enough in hue that a stock ANSI palette
  // would put a bright generic red and a bright generic orange next to each
  // other and lose both. These are the skin's own --danger/--warn, which are
  // already separated by saturation rather than hue, so `git status` red and a
  // build warning stay distinguishable against a warm background.
  //
  // There is no --blue token in this skin, so blue is chosen rather than
  // derived: a dull steel that a copper surface doesn't push towards purple.
  term: {
    background: "#1a1616",
    foreground: "#ede4df",
    cursor: "#e07a4a",
    selectionBackground: "#4a3122",
    black: "#332b29",
    red: "#e8535b",
    green: "#77b569",
    yellow: "#dfa04a",
    blue: "#7d9bc9",
    magenta: "#c78bd4",
    cyan: "#6fb8bd",
    white: "#a3928a",
    brightBlack: "#6f605a",
    brightRed: "#ff6f76",
    brightGreen: "#93cf85",
    brightYellow: "#f2b866",
    brightBlue: "#9db8e2",
    brightMagenta: "#dda9e8",
    brightCyan: "#8ad3d8",
    brightWhite: "#ede4df",
  },
  monaco: { base: "vs-dark", colors: { "editor.background": "#161212" } },
};

import type { SkinDef } from "./types";

// `void` is a reserved word, so the const can't be named after the id. The id
// stays "void" — it's the persisted settings value and the data-theme.
export const voidSkin: SkinDef = {
  id: "void",
  label: "Void",
  note: "true black · one accent",
  // The card is drawn on the skin's own shell, and the shell is what the skin
  // is about, so `bg` is the true black rather than the editor's #050505 —
  // five levels of grey is a difference nobody can see anyway. On a black card
  // with a white accent chip there is nothing left to draw an edge with, so
  // `raised` takes --bg-overlay instead of --bg-raised: the lightest surface in
  // the palette, and the only one that separates the card from the shell.
  preview: {
    bg: "#000000",
    raised: "#1a1a1a",
    text: "#f2f2f2",
    accent: "#ffffff",
  },
  // The terminal is a panel, so it takes --bg-alt, not the #000 shell — which
  // also keeps true black free for the skin that needs it for contrast rather
  // than for power. #0a0a0a is achromatic to the byte, and Void is the only
  // skin whose neutrals have no tint, so no other palette lands on it.
  //
  // `blue` is the one slot that can't be derived: the accent is white, and a
  // terminal that renders blue as grey loses half of every diff and every
  // prompt. It's a real blue at the same luminance tier as --ok/--warn/--cyan.
  // brightWhite is the accent itself — emphasis in this skin IS white, and it's
  // the one place the terminal shows it.
  term: {
    background: "#0a0a0a",
    foreground: "#f2f2f2",
    cursor: "#ffffff",
    selectionBackground: "#333333",
    black: "#3d3d3d",
    red: "#ff5f6b",
    green: "#4ade80",
    yellow: "#fbbf24",
    blue: "#60a5fa",
    magenta: "#c4a2ff",
    cyan: "#67e8f9",
    white: "#9a9a9a",
    brightBlack: "#666666",
    brightRed: "#ff8a92",
    brightGreen: "#86efac",
    brightYellow: "#fcd34d",
    brightBlue: "#93c5fd",
    brightMagenta: "#dcc6ff",
    brightCyan: "#a5f3fc",
    brightWhite: "#ffffff",
  },
  monaco: { base: "vs-dark", colors: { "editor.background": "#050505" } },
};

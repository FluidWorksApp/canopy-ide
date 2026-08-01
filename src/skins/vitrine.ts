import type { SkinDef } from "./types";

export const vitrine: SkinDef = {
  id: "vitrine",
  label: "Vitrine",
  note: "glass · dark",
  // Previews the field, not a flat surface — the blooms are the skin.
  preview: {
    bg: "radial-gradient(70% 90% at 12% 0%, rgba(255,138,76,.3), transparent 68%), radial-gradient(70% 90% at 95% 100%, rgba(126,166,255,.28), transparent 68%), linear-gradient(155deg, #0b0d11, #07080a)",
    raised: "rgba(255,255,255,.16)",
    text: "#edeff1",
    accent: "#b4f04a",
  },
  // Vitrine's glass stops at the terminal: xterm renders its canvas opaque
  // unless allowTransparency is on, and turning that on costs a full
  // alpha-composited repaint on every frame of scrollback. A dark slab in a
  // glass shell is the honest version — and #08090c is the field's own base
  // gradient at its darkest, so the terminal reads as a well cut into it rather
  // than a foreign surface.
  term: {
    background: "#08090c",
    foreground: "#edeff1",
    cursor: "#b4f04a",
    selectionBackground: "#2c3a1c",
    black: "#1b1f26",
    red: "#ff6b6b",
    green: "#5be08a",
    yellow: "#ffc24b",
    blue: "#7ea6ff",
    magenta: "#c29bff",
    cyan: "#4be3e8",
    white: "#9aa3ae",
    brightBlack: "#4a515c",
    brightRed: "#ffa3a3",
    brightGreen: "#8df0ae",
    brightYellow: "#ffd79a",
    brightBlue: "#a8c4ff",
    brightMagenta: "#d9c0ff",
    brightCyan: "#8af0f3",
    brightWhite: "#edeff1",
  },
  // Glass all the way down: the editor paints no surface of its own and the
  // app's ambient field shows through, tinted by `.project-content` in
  // index.css. A slab here would be the one opaque rectangle in the skin, and
  // it covers most of the window.
  monaco: {
    base: "vs-dark",
    colors: {
      "editor.background": "#00000000",
      "editorGutter.background": "#00000000",
      "minimap.background": "#00000000",
      "editorOverviewRuler.background": "#00000000",
    },
  },
};

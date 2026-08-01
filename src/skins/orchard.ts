import type { SkinDef } from "./types";

export const orchard: SkinDef = {
  id: "orchard",
  label: "Orchard",
  note: "deep forest + lime",
  // Vitrine's card previews its field as a gradient because the field is what
  // that skin is. Orchard's is a flat slab on purpose: the card sits directly
  // beside Vitrine's in the picker, and the difference between them — same
  // accent, one material, one paint — has to be visible without reading the
  // label.
  preview: {
    bg: "#0c1713",
    raised: "#16261f",
    text: "#dfeade",
    accent: "#a8e04a",
  },
  // --bg-alt is the terminal's surface everywhere else in the app, so the
  // terminal keeps it here rather than inventing a darker well; nothing in this
  // skin is translucent, so there is no field for it to cut into.
  //
  // Green is the hard slot: --ok sits on a background that is also green, and a
  // stock ANSI green would disappear into it. #62d68a is pushed towards mint so
  // it separates from the surface by hue as well as luminance, and away from
  // the lime cursor so a prompt marker never reads as output.
  //
  // There is no --blue token in this skin, so blue is chosen rather than
  // derived: a cool periwinkle, held well clear of --cyan, which a forest
  // surface would otherwise pull the two of them together into.
  term: {
    background: "#0f1c17",
    foreground: "#dfeade",
    cursor: "#a8e04a",
    selectionBackground: "#2e4720",
    black: "#22382e",
    red: "#f0666f",
    green: "#62d68a",
    yellow: "#e5b155",
    blue: "#7396e0",
    magenta: "#bb95ef",
    cyan: "#62cfd6",
    white: "#91a89a",
    brightBlack: "#63786c",
    brightRed: "#ff8a90",
    brightGreen: "#86e8a8",
    brightYellow: "#f3c877",
    brightBlue: "#9ab6ef",
    brightMagenta: "#d3b6f6",
    brightCyan: "#8ee2e7",
    brightWhite: "#dfeade",
  },
  monaco: { base: "vs-dark", colors: { "editor.background": "#0c1713" } },
};

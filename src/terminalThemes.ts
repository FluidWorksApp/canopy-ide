// xterm.js color themes, one per skin. The rest of the theme system recolors
// every DOM element for free via CSS custom properties, but the terminal
// renders to a canvas and needs its own JS-side color object pushed
// explicitly — this is that object. Each skin declares it in src/skins/<id>.ts;
// this file is only the resolution rules on top.
import type { Theme } from "./settings";
import { skinDef } from "./skins/registry";
import type { TermTheme } from "./skins/types";

export type { TermTheme } from "./skins/types";

/** The current skin's terminal palette, with the accent (when the user set
 *  one) substituted into cursor/blue/brightBlue on ANY skin — the accent is
 *  orthogonal to the skin everywhere else, and a terminal whose cursor
 *  ignored it looked like a bug. Substituting the one colour the user
 *  actually chose beats asking for 16 on top of it. */
export function terminalTheme(theme: Theme, customAccent?: string): TermTheme {
  if (theme === "auto") {
    theme = window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "default"
      : "daylight";
  }
  // "custom" is Default's palette plus the user's accent, which the
  // substitution below applies — so the lookup falling back to Default is
  // exactly right for it.
  const palette = skinDef(theme).term;
  const accent = (customAccent ?? "").trim();
  return accent
    ? { ...palette, cursor: accent, blue: accent, brightBlue: accent }
    : palette;
}

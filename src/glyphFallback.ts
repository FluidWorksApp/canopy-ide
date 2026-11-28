// Symbols on Linux (scripts/glyph-fallback/build.py makes the fonts).
//
// The UI draws arrows, check marks, triangles, key glyphs and a few emoji that
// no bundled text font has. macOS and Windows fill them from system fonts; a
// Linux machine without a font for one draws a box. On Linux, the fallback
// fonts are loaded and named at the end of every font stack (--glyph-fallback
// in index.css). Elsewhere the stylesheet is never loaded, those names match
// no font, and every symbol is drawn exactly as before.
import { currentPlatform } from "./shortcuts";

/** On Linux: the bundled symbols first; a system colour emoji font, when the
 *  machine has one, before the bundled monochrome emoji. */
export const LINUX_GLYPH_FALLBACK = '"Canopy Symbols", "Noto Color Emoji", "Canopy Emoji"';

export function loadGlyphFallback(platform = currentPlatform()): boolean {
  if (platform !== "linux") return false;
  document.documentElement.style.setProperty("--glyph-fallback", LINUX_GLYPH_FALLBACK);
  void import("./glyphFallback.css");
  return true;
}

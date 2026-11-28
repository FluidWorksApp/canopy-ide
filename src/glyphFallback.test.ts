// The guard that keeps Linux from drawing boxes (glyphFallback.ts).
//
// 1. Every character the UI source draws is in the bundled text font's range
//    or in the bundled fallback fonts. A new symbol that is in neither fails
//    here: run scripts/glyph-fallback/build.py, or pick a symbol that is.
// 2. Every font stack ends in the fallback, so a symbol reaches it whatever
//    element it is in.
//
// Text that arrives as data (chat messages, agent and file names, terminal
// output) is not source and is not covered: that is the system's fonts' job.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { LINUX_GLYPH_FALLBACK, loadGlyphFallback } from "./glyphFallback";

const ROOT = join(__dirname, "..");
const manifest = JSON.parse(
  readFileSync(join(ROOT, "src/assets/fonts/glyph-fallback/manifest.json"), "utf8"),
) as { faces: { file: string; family: string; unicodes: number[] }[] };

/** Characters in source that are never drawn as UI: regular expressions over
 *  terminal output, and sample text in a terminal benchmark. */
const NOT_DRAWN: Record<string, string> = {
  "src/companionTransport.ts": "╭╰│─╮╯❯",
  "shared/terminalEngine/bench.ts": "日本語のテキスト",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const sources = (exts: RegExp) =>
  ["src", "shared"].flatMap((d) => walk(join(ROOT, d))).filter((p) => exts.test(p) && !p.includes(".test."));

const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/gm, "$1");

/** What the browser serves from the bundled text font (its unicode-range). */
function textFontRanges(): [number, number][] {
  const css = readFileSync(join(ROOT, "node_modules/@fontsource-variable/archivo/wght.css"), "utf8");
  const out: [number, number][] = [];
  for (const m of css.matchAll(/unicode-range:\s*([^;]+);/g))
    for (const raw of m[1].split(",")) {
      const part = raw.trim().slice(2);
      const [a, b] = part.includes("-") ? part.split("-") : [part.replace(/\?/g, "0"), part.replace(/\?/g, "F")];
      out.push([parseInt(a, 16), parseInt(b, 16)]);
    }
  return out;
}

describe("glyph fallback", () => {
  it("has a font for every symbol the UI draws", () => {
    const ranges = textFontRanges();
    const bundled = new Set(manifest.faces.flatMap((f) => f.unicodes));
    const missing = new Map<string, Set<string>>();
    for (const path of sources(/\.(tsx|ts|css)$/)) {
      const file = relative(ROOT, path);
      for (const ch of withoutComments(readFileSync(path, "utf8"))) {
        const cp = ch.codePointAt(0)!;
        if (cp <= 127 || /[\p{Cf}\p{Mn}\p{Me}\p{Cc}]/u.test(ch)) continue;
        if (ranges.some(([a, b]) => a <= cp && cp <= b) || bundled.has(cp)) continue;
        if (NOT_DRAWN[file]?.includes(ch)) continue;
        const files = missing.get(ch) ?? new Set();
        files.add(file);
        missing.set(ch, files);
      }
    }
    const report = [...missing].map(([ch, files]) => `${ch} U+${ch.codePointAt(0)!.toString(16).toUpperCase()} in ${[...files].join(", ")}`);
    expect(report, "No bundled font has these: run scripts/glyph-fallback/build.py or pick a covered symbol").toEqual([]);
  });

  it("loads every generated face, and each file exists", () => {
    const css = readFileSync(join(ROOT, "src/glyphFallback.css"), "utf8");
    for (const face of manifest.faces) {
      expect(css).toContain(`glyph-fallback/${face.file}`);
      expect(existsSync(join(ROOT, "src/assets/fonts/glyph-fallback", face.file))).toBe(true);
    }
    expect(new Set(manifest.faces.map((f) => f.family))).toEqual(new Set(["Canopy Symbols", "Canopy Emoji"]));
  });

  it("ends every font stack with the fallback", () => {
    const fontVar = /^var\(--font-(ui|mono|sans)\)$/;
    const bad: string[] = [];
    for (const path of sources(/\.css$/)) {
      if (path.endsWith("glyphFallback.css")) continue;
      const css = withoutComments(readFileSync(path, "utf8"));
      for (const m of css.matchAll(/(?<![-\w])(font-family|font):\s*([^;{}]+);/g)) {
        const value = m[2].trim();
        if (value.includes("var(--glyph-fallback)") || ["inherit", "initial", "unset", "revert"].includes(value)) continue;
        if (m[1] === "font-family" && fontVar.test(value)) continue;
        // A shorthand ending in one of the font variables is covered by it.
        if (m[1] === "font" && /\s(var\(--font-(ui|mono|sans)\))$/.test(value)) continue;
        // A shorthand with no family (a bare keyword) sets none.
        if (m[1] === "font" && !/\d(px|em|rem|%|pt)|var\(--fs-/.test(value)) continue;
        bad.push(`${relative(ROOT, path)}: ${m[1]}: ${value}`);
      }
      for (const m of css.matchAll(/--font-(ui|mono|sans):\s*([^;]+);/g))
        if (!m[2].includes("var(--glyph-fallback)") && !/^\s*var\(--font-(ui|mono|sans)\)\s*$/.test(m[2]))
          bad.push(`${relative(ROOT, path)}: --font-${m[1]} without the fallback`);
    }
    expect(bad, "Append var(--glyph-fallback) to these font stacks").toEqual([]);
  });

  it("loads the fonts on Linux only", () => {
    const style = document.documentElement.style;
    style.removeProperty("--glyph-fallback");
    expect(loadGlyphFallback("macos")).toBe(false);
    expect(loadGlyphFallback("windows")).toBe(false);
    expect(style.getPropertyValue("--glyph-fallback")).toBe("");
    expect(loadGlyphFallback("linux")).toBe(true);
    expect(style.getPropertyValue("--glyph-fallback")).toBe(LINUX_GLYPH_FALLBACK);
  });
});

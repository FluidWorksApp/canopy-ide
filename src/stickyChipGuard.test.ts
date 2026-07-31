// The tab strip's stack chips are sticky: they are painted over the tabs that
// scroll underneath them, so their backdrop is doing occlusion, not decoration.
//
// That makes them one of the few surfaces in the app that cannot use the plain
// surface tokens. The Vitrine skin composites every surface as alpha over an
// ambient field — `--bg-alt` is rgba(255,255,255,0.034) there — so a chip
// painted with it let the tab running beneath read straight through it, and the
// heading and the tab title rendered on top of each other.
//
// jsdom cannot see this: a see-through chip has exactly the right DOM. So the
// rule is guarded at the source, the way the branch-switch and shortcut
// registries are.
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Vitest runs from the repo root; import.meta.url is not a file: URL here.
const CSS = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");

/** The declarations inside a top-level rule, by exact selector. */
function ruleBody(selector: string): string {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  return CSS.slice(open + 1, CSS.indexOf("}", open));
}

describe("sticky stack chips", () => {
  // Every surface that occludes scrolling tabs, and the token it must use.
  const OPAQUE: [string, string][] = [
    [".tab-stack", "--bg-alt-opaque"],
    [".tab-stack-face", "--bg-raised-opaque"],
    [".tab-stack-more", "--bg-raised-opaque"],
  ];

  it.each(OPAQUE)("%s paints on the opaque mirror of its surface token", (sel, token) => {
    const body = ruleBody(sel);
    expect(body).toMatch(/background:/);
    expect(body, `${sel} must use ${token} — a translucent skin shows the tabs through it`)
      .toContain(token);
  });

  it.each(OPAQUE)("%s falls back for skins that declare no mirror", (sel, token) => {
    // var(--x-opaque, var(--x)): the opaque skins never define a mirror, and
    // they don't need one — the token they mirror is already solid there.
    expect(ruleBody(sel)).toMatch(new RegExp(`var\\(\\s*${token}\\s*,\\s*var\\(`));
  });

  it("draws nothing outside its own box", () => {
    // The chip sits immediately before the group's first tab, so anything it
    // paints past its own edge lands on a neighbour. The folded stack used to
    // grow card edges out of the pill this way; they were drawn over the
    // overflow caret and over the first tab, and at chip scale they never read
    // as the stack of paper they were meant to be anyway.
    //
    // Negative insets are the shape of that mistake, so they are what is
    // barred: a chip decoration has to fit in the chip.
    const rules = [...CSS.matchAll(/\n(\.tab-stack[^{]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(4);
    const escaping = rules
      .filter(([, , body]) => /(?:top|right|bottom|left|margin[a-z-]*):\s*-/.test(body))
      .map(([, sel]) => sel.trim());
    expect(escaping, "chip rules painting outside the chip").toEqual([]);
  });
});

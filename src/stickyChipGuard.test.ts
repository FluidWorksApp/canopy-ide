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

  it("hangs the folded-stack card edges off the chip, not off the pill", () => {
    // On the pill they were drawn over whatever came next — the overflow caret
    // beside them, and the group's first tab. On the chip they land in padding
    // reserved for them.
    expect(CSS).toContain(".tab-stack-away::before");
    expect(CSS).not.toContain(".tab-stack-away .tab-stack-face::before");
    expect(ruleBody(".tab-stack-away")).toMatch(/padding-right:/);
  });

  it("keeps the pill above the card edges tucked behind it", () => {
    expect(ruleBody(".tab-stack-face")).toMatch(/z-index:\s*1/);
    expect(ruleBody(".tab-stack-more")).toMatch(/z-index:\s*1/);
  });
});

// The one ordering question the app keeps getting wrong: what paints over the
// command palette.
//
// The palette (⌘P quick open, ⌘⇧F find in files, ⌘K SpotSearch — all three are
// `.palette-backdrop`) is modal. It takes the keyboard, dims the window behind
// it, and the whole surface is a list you are reading while you type. Anything
// that arrives *while* you are typing and paints on top of it — a toast from a
// finished action, the companion standing wherever it was last dropped — is
// covering the thing it interrupted, and there is no way to move it.
//
// It sat at 200 while the transient layer above it kept growing: the notice
// stack at 300, then the companion and its card at 318–320. jsdom cannot see a
// z-order at all, and a screenshot only catches it when something happens to be
// on screen, so the ordering is guarded at the source — the way the sticky chips
// and the shortcut registry are.
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Vitest runs from the repo root; import.meta.url is not a file: URL here.
const CSS = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");

/** The z-index declared on a top-level rule, by exact selector. */
function layer(selector: string): number {
  const at = CSS.indexOf(`\n${selector} {`);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  const body = CSS.slice(open + 1, CSS.indexOf("}", open));
  const z = /z-index:\s*(\d+)/.exec(body);
  expect(z, `${selector} declares no z-index`).not.toBeNull();
  return Number(z![1]);
}

describe("the command palette's layer", () => {
  const palette = () => layer(".palette-backdrop");

  // Everything that can appear on its own, with no user action, while the
  // palette is open.
  const TRANSIENT: string[] = [
    ".notice-stack",
    ".companion",
    ".companion-notice",
    ".companion-panel",
  ];

  it.each(TRANSIENT)("outranks %s, which arrives uninvited", (sel) => {
    expect(
      palette(),
      `${sel} paints over the palette — a scrim that things show through is not a scrim`,
    ).toBeGreaterThan(layer(sel));
  });

  // The other half: raising it must not have raised it over the surfaces that
  // are *meant* to interrupt it. A confirm dialog opened from a palette action
  // has to be readable, and it is opened from on top of the palette.
  const ABOVE: string[] = [".confirm-backdrop", ".dlg-scrim", ".ctx-menu"];

  it.each(ABOVE)("stays under %s, which is a deliberate interruption", (sel) => {
    expect(palette()).toBeLessThan(layer(sel));
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Clicking a note's body opens the editor over the whole tab. It didn't once:
 *  `.note-body-input` carried `min-height: 180px`, so a full-screen note turned
 *  into a letterbox with a scrollbar of its own inside a region that was
 *  already scrolling. The floor has to be the region's height — a pixel value
 *  is the bug, whatever pixel it is. */
describe("note editor", () => {
  const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");

  it("floors at the height of the scroll region, not at a pixel count", () => {
    document.head.innerHTML = `<style>${css}</style>`;
    document.body.innerHTML = `
      <div class="note-view">
        <div class="note-head"></div>
        <div class="note-scroll"><textarea class="note-body-input"></textarea></div>
        <div class="note-actions"></div>
      </div>`;
    const input = document.querySelector<HTMLElement>(".note-body-input")!;
    expect(getComputedStyle(input).minHeight).toBe("100%");
  });

  it("leaves the growing to the region, so the box never scrolls inside it", () => {
    document.head.innerHTML = `<style>${css}</style>`;
    document.body.innerHTML = `<div class="note-scroll"></div>`;
    const scroll = document.querySelector<HTMLElement>(".note-scroll")!;
    expect(getComputedStyle(scroll).overflowY).toBe("auto");
  });
});

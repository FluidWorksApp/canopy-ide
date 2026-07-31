import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The docked side panel's width is the pixels the resize drag writes, and
 *  nothing else. It stopped being that once — `.project-body > *:not(.rail)`
 *  is a two-class selector, so it outranked a bare `.side-dock` and handed the
 *  panel `flex: 1 1 0`; the panel then sized itself off the flex line and grew
 *  to share the row with the editor, deaf to every drag. This asserts the
 *  cascade, not the rule's text: any future `.project-body > *` rule that
 *  outranks the dock again fails here. */
describe("docked side panel", () => {
  it("sizes from its own width, not from the flex line", () => {
    const css = readFileSync(join(process.cwd(), "src", "index.css"), "utf8");
    document.head.innerHTML = `<style>${css}</style>`;
    document.body.innerHTML = `
      <div class="project-body">
        <div class="rail"></div>
        <div class="side-dock open" style="width: 300px"><div class="sidebar"></div></div>
        <div class="project-main"></div>
      </div>`;
    const dock = document.querySelector<HTMLElement>(".side-dock")!;
    const style = getComputedStyle(dock);
    expect(style.flexGrow).toBe("0");
    expect(style.flexShrink).toBe("0");
    expect(style.flexBasis).toBe("auto");
  });
});

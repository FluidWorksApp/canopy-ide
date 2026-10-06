import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("multiplex terminal streaming contract", () => {
  it("streams every onscreen split pane while focusing only the selected pane", () => {
    const project = readFileSync("src/components/ProjectView/index.tsx", "utf8");
    const shownStart = project.indexOf("const shown =", project.indexOf("activePaneRects"));
    const termStart = project.indexOf("<Term", shownStart);
    const termEnd = project.indexOf("onSpawned=", termStart);
    expect(shownStart).toBeGreaterThan(-1);
    expect(termStart).toBeGreaterThan(shownStart);
    expect(termEnd).toBeGreaterThan(termStart);

    const visibility = project.slice(shownStart, termStart);
    const termProps = project.slice(termStart, termEnd);
    // `pane != null` includes every leaf in the active split layout, including
    // leaves that do not own keyboard focus.
    expect(visibility).toContain("pane != null");
    expect(termProps).toContain("streaming={shown}");
    expect(termProps).toContain("tab.id === activeTabId");
    expect(termProps).not.toContain("streaming={active");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
const projectView = readFileSync(
  join(process.cwd(), "src/components/ProjectView/index.tsx"),
  "utf8",
);

describe("multiplex focus hierarchy", () => {
  it("marks the active agent pane and restores its full visual weight", () => {
    expect(projectView).toContain(
      'tab.id === activeTabId ? "term-host-focused" : ""',
    );
    expect(css).toMatch(
      /\.term-host-multiplexed\.term-host-focused\s*{[^}]*opacity:\s*1;[^}]*filter:\s*none;/s,
    );
  });

  it("dims unfocused panes gently and respects reduced motion", () => {
    expect(css).toMatch(
      /\.term-host-multiplexed\s*{[^}]*opacity:\s*0\.68;[^}]*filter:/s,
    );
    expect(css).toContain(".term-host-multiplexed:not(.term-host-focused):hover");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

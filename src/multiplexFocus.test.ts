import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  multiplexPaneFocusState,
  splitLeaf,
  type TerminalGroup,
} from "./terminalGroups";

const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");
const projectView = readFileSync(
  join(process.cwd(), "src/components/ProjectView/index.tsx"),
  "utf8",
);

describe("multiplex focus hierarchy", () => {
  const group: TerminalGroup = {
    id: "mux",
    root: splitLeaf(
      { type: "leaf", tabId: "restored-a" },
      "restored-a",
      "restored-b",
      "horizontal",
    ),
    activeTabId: "pre-crash-active-id",
  };

  it("marks the active agent pane and restores its full visual weight", () => {
    expect(multiplexPaneFocusState(group, "restored-a", "restored-a")).toBe(
      "focused",
    );
    expect(multiplexPaneFocusState(group, "restored-a", "restored-b")).toBe(
      "dimmed",
    );
    expect(projectView).toContain("multiplexPaneFocusState(group, activeTabId, tab.id)");
    expect(css).toMatch(
      /\.term-host-multiplexed\.term-host-focused\s*{[^}]*opacity:\s*1;[^}]*filter:\s*none;/s,
    );
  });

  it("keeps every restored pane normal until a live focus target exists", () => {
    expect(multiplexPaneFocusState(group, null, "restored-a")).toBe("normal");
    expect(
      multiplexPaneFocusState(group, "pre-crash-active-id", "restored-a"),
    ).toBe("normal");
    expect(multiplexPaneFocusState(group, null, "restored-b")).toBe("normal");
    expect(projectView).not.toContain(
      "if (!group || group.activeTabId === tab.id) return;",
    );
    expect(projectView).toContain("if (!group) return;");
    const baseRule = css.match(/\.term-host-multiplexed\s*{([^}]*)}/s)?.[1];
    expect(baseRule).toBeDefined();
    expect(baseRule).not.toMatch(/(?:^|\n)\s*(?:opacity|filter):/);
  });

  it("dims only an explicitly unfocused pane and respects reduced motion", () => {
    expect(css).toMatch(
      /\.term-host-multiplexed\.term-host-dimmed\s*{[^}]*opacity:\s*0\.68;[^}]*filter:/s,
    );
    expect(css).toContain(".term-host-multiplexed.term-host-dimmed:hover");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

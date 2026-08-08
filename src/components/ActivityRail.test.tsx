// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { ActivityRail } from "./ActivityRail";
import { THEME_CHANGE_EVENT } from "../settings";

const props = {
  sideTab: "files" as const,
  open: false,
  pinned: false,
  hoverPeeks: true,
  changeBadge: 0,
  serversBadge: 0,
  prsBadge: 0,
  tasksBadge: 0,
  pendingCount: 0,
  urgentCount: 0,
  teamBadge: 0,
  relayRole: "off" as const,
  onSelectTab: () => {},
  onHoverTab: () => {},
  onHoverCancel: () => {},
  onHoverLeave: () => {},
  onOpenSettings: () => {},
  onToggleSidebar: () => {},
};

describe("ActivityRail", () => {
  // The rail's order is the whole design — which icon leads a group and which
  // ones sit at the foot with Settings. Nothing else asserts it, so a reorder
  // that nobody meant would ship silently.
  it("puts Agents at the head of its group and Tools at the foot by Settings", () => {
    const { container } = render(<ActivityRail {...props} />);
    const labels = [...container.querySelectorAll("button")].map(
      (b) => b.getAttribute("aria-label") ?? b.getAttribute("title"),
    );
    expect(labels).toEqual([
      "Project — Components & files",
      "Project — Servers — every component you can run, start and manage",
      "Project — Integrations — local services, linked accounts and deployments",
      "Source control & Review — Session changes",
      "Source control & Review — Git — branches, commits, worktrees, PRs",
      "Source control & Review — Pull requests — every open project, one list",
      "Source control & Review — Issues — GitHub, Linear, …",
      "Agents — Agents",
      "Agents — Tasks — one-shot agent jobs",
      "Agents — Scratchpad — thoughts, ideas and to-dos you'll pick up later",
      "Agents — Research — what's been investigated, and what shipped from it",
      "Agents — Team — relay, chat, notifications",
      "Tools — MCP servers your agents can reach, from every CLI",
      "Settings (Cmd+,)",
      "Pin sidebar open (Cmd+B)",
    ]);
  });

  // With hover-to-peek on, a tab's tooltip would fire on the same gesture that
  // slides its panel out, so the tabs drop `title`. With it off no panel comes
  // on hover, and the tooltip is the only thing that names an icon — it must
  // come back, or the rail is a column of unlabelled glyphs.
  it("gives the tabs tooltips only when hover-to-peek is off", () => {
    const withHover = render(<ActivityRail {...props} />);
    const files = () =>
      [...withHover.container.querySelectorAll("button")].find(
        (b) => b.getAttribute("aria-label") === "Project — Components & files",
      );
    expect(files()?.getAttribute("title")).toBeNull();

    withHover.rerender(<ActivityRail {...props} hoverPeeks={false} />);
    expect(files()?.getAttribute("title")).toBe("Components & files");
    // The foot buttons never lost theirs; the setting must not touch them.
    expect(
      withHover.container.querySelector('[title="Settings (Cmd+,)"]'),
    ).not.toBeNull();
  });

  // Tools left the tab groups but not the tab behaviour: it still opens a
  // panel, so it must keep the active marker the plain foot buttons lack.
  it("keeps Tools marked active when its panel is the open one", () => {
    const { container } = render(
      <ActivityRail {...props} sideTab="tools" open pinned />,
    );
    const tools = container.querySelector('[aria-label^="Tools"]');
    expect(tools?.className).toContain("rail-btn-active");
    expect(tools?.className).toContain("rail-btn-pinned");
  });

  // The twins are the Pixel skin's only icons, and the swap is invisible to
  // every other assertion in this file: a rail that quietly kept drawing 24px
  // strokes under an 8-bit palette would look wrong and test green. The
  // viewBox is the cheapest thing that can only be true of a twin.
  describe("under the Pixel skin", () => {
    afterEach(() => {
      delete document.documentElement.dataset.theme;
    });

    const boxes = (root: HTMLElement) =>
      [...root.querySelectorAll("svg")].map((s) => s.getAttribute("viewBox"));

    it("draws the 8x8 twins for every icon in the rail", () => {
      document.documentElement.dataset.theme = "pixel";
      const { container } = render(<ActivityRail {...props} />);
      expect(boxes(container)).toEqual(Array(15).fill("0 0 8 8"));
    });

    it("swaps back and forth when the skin changes under it", () => {
      const { container } = render(<ActivityRail {...props} />);
      expect(boxes(container).every((b) => b === "0 0 24 24")).toBe(true);

      // What applyTheme() does, in the order it does it: stamp, then announce.
      act(() => {
        document.documentElement.dataset.theme = "pixel";
        window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
      });
      expect(boxes(container).every((b) => b === "0 0 8 8")).toBe(true);

      act(() => {
        document.documentElement.dataset.theme = "gotham";
        window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
      });
      expect(boxes(container).every((b) => b === "0 0 24 24")).toBe(true);
    });
  });
});

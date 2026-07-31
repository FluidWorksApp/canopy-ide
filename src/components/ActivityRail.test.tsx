// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { ActivityRail } from "./ActivityRail";

const props = {
  sideTab: "files" as const,
  open: false,
  pinned: false,
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
      "Source control & Review — Session changes",
      "Source control & Review — Git — branches, commits, worktrees, PRs",
      "Source control & Review — Pull requests — every open project, one list",
      "Source control & Review — Issues — GitHub, Linear, …",
      "Agents — Agents",
      "Agents — Tasks — one-shot agent jobs",
      "Agents — Research — what's been investigated, and what shipped from it",
      "Agents — Team — relay, chat, notifications",
      "Tools — MCP servers your agents can reach, from every CLI",
      "Settings (Cmd+,)",
      "Pin sidebar open (Cmd+B)",
    ]);
  });

  // Tools left the tab groups but not the tab behaviour: it still opens a
  // panel, so it must keep the active marker the plain foot buttons lack.
  it("keeps Tools marked active when its panel is the open one", () => {
    const { container } = render(<ActivityRail {...props} sideTab="tools" open pinned />);
    const tools = container.querySelector('[aria-label^="Tools"]');
    expect(tools?.className).toContain("rail-btn-active");
    expect(tools?.className).toContain("rail-btn-pinned");
  });
});

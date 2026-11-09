import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TermSubTab } from "./ProjectView/helpers";
import { AgentHierarchyOverlay } from "./AgentHierarchyOverlay";

const tab = (id: string, ptyId: number, over: Partial<TermSubTab> = {}): TermSubTab =>
  ({ id, type: "terminal", cwd: "/repo", ptyId, command: "claude", launchTitle: id, ...over }) as TermSubTab;
const kid = (id: string, ptyId: number, parentPtyId: number) =>
  tab(id, ptyId, { spawnedTask: { runId: "r", attemptId: id, parentPtyId, depth: 1 } });
const TABS = [tab("parent", 1), kid("kid", 2, 1)];

afterEach(cleanup);

describe("AgentHierarchyOverlay", () => {
  it("lists children and selects one on click", () => {
    const onSelect = vi.fn();
    render(<AgentHierarchyOverlay tabs={TABS} activeTabId="parent" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("2 agents"));
    fireEvent.click(screen.getByLabelText("Switch to kid"));
    expect(onSelect).toHaveBeenCalledWith("kid");
  });

  it("offers Back to parent from a child", () => {
    const onSelect = vi.fn();
    render(<AgentHierarchyOverlay tabs={TABS} activeTabId="kid" onSelect={onSelect} />);
    fireEvent.click(screen.getByText("2 agents"));
    fireEvent.click(screen.getByText(/Back to parent/));
    expect(onSelect).toHaveBeenCalledWith("parent");
  });

  it("pins the list open", () => {
    render(<AgentHierarchyOverlay tabs={TABS} activeTabId="parent" onSelect={() => {}} />);
    expect(screen.queryByLabelText("Agents")).toBeNull();
    fireEvent.click(screen.getByText("Pin"));
    expect(screen.getByLabelText("Agents")).toBeTruthy();
    fireEvent.click(screen.getByText("2 agents"));
    expect(screen.getByLabelText("Agents")).toBeTruthy();
  });

  it("renders nothing without a hierarchy", () => {
    const { container } = render(<AgentHierarchyOverlay tabs={[tab("solo", 1)]} activeTabId="solo" onSelect={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});

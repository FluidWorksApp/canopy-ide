import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { StatsPanel } from "./StatsPanel";

vi.mock("../ipc", () => ({
  agentUsage: vi.fn(async () => [
    {
      agent: "claude",
      session_id: "s1",
      cwd: "/repo",
      title: "a session",
      model: "claude-opus-4",
      supported: true,
      updated: 1,
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      cost: 1.25,
    },
  ]),
  planUsage: vi.fn(async () => []),
  profilesList: vi.fn(async () => []),
  cleanupDisk: vi.fn(async () => [
    {
      mount: "/",
      label: "Macintosh HD",
      free_bytes: 27.8e9,
      total_bytes: 460.4e9,
    },
  ]),
}));

describe("StatsPanel layout", () => {
  it("keeps the header outside the scrolling body", async () => {
    const { container } = render(
      <StatsPanel visible roots={["/repo"]} onCleanup={() => {}} />,
    );
    await screen.findByText("By model");
    const panel = container.querySelector(".stats-panel")!;
    const head = panel.querySelector(".stats-head")!;
    const body = screen.getByTestId("stats-body");
    // Siblings, header first: only the body scrolls, the header can't leave.
    expect(head.parentElement).toBe(panel);
    expect(body.parentElement).toBe(panel);
    expect(panel.firstElementChild).toBe(head);
    expect(body.contains(head)).toBe(false);
    expect(head.textContent).toMatch(/Usage & cost/);
    // Every section header lives inside the body, none in the fixed header.
    for (const title of ["Disk", "By CLI", "By model", "Sessions"]) {
      expect(body.contains(screen.getByText(title))).toBe(true);
    }
  });

  it("does not reuse the agents panel's themeable .ap-head", async () => {
    const { container } = render(<StatsPanel visible roots={["/repo"]} />);
    await screen.findByText("By CLI");
    expect(container.querySelector(".ap-head, .ap-title")).toBeNull();
  });

  it("gives truncatable disk text a tooltip with the full figure", async () => {
    const { container } = render(<StatsPanel visible roots={["/repo"]} />);
    await waitFor(() =>
      expect(container.querySelector(".plan-reset-wide")).not.toBeNull(),
    );
    const cell = container.querySelector(".plan-reset-wide")!;
    expect(cell.getAttribute("title")).toBe(cell.textContent);
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AgentLaunchButton } from "./AgentLaunchButton";
import type { AgentTarget } from "./TicketsPanel";
import type { PlacementDecision } from "../placement/types";
import { getAgentPreference } from "../placement/preferences";

vi.mock("../remoteExecution/ProjectSetupDialog", () => ({
  ProjectSetupDialog: ({ projectName, workspaceName }: { projectName: string; workspaceName: string }) => (
    <div>Setup {projectName} on {workspaceName}</div>
  ),
}));

const origin: AgentTarget = {
  tabId: "agent-tab",
  title: "Origin agent",
  ptyId: 42,
  agentId: "opencode",
  dir: "canopy",
  cwd: "/repo/canopy",
};

const other: AgentTarget = {
  ...origin,
  tabId: "other-tab",
  title: "Other agent",
  ptyId: 43,
};

const props = () => ({
  label: "Send feedback",
  agentTargets: [origin],
  installed: { opencode: true },
  newAgentLabel: "New agent",
  onStart: vi.fn(),
  onSend: vi.fn(),
});

describe("AgentLaunchButton", () => {
  it("sends the primary action to the originating agent", () => {
    const p = props();
    render(<AgentLaunchButton {...p} primaryTarget={origin} />);

    fireEvent.click(screen.getByTitle("Send this back to Origin agent"));

    expect(p.onSend).toHaveBeenCalledWith(origin);
    expect(p.onStart).not.toHaveBeenCalled();
  });

  it("starts the preferred agent when no originating agent exists", () => {
    const p = props();
    render(<AgentLaunchButton {...p} />);

    fireEvent.click(screen.getByText("Send feedback", { exact: false }).closest("button")!);

    expect(p.onStart).toHaveBeenCalledTimes(1);
    expect(p.onSend).not.toHaveBeenCalled();
  });

  it("runs a task as the primary action while keeping agents in the caret", () => {
    const p = props();
    const run = vi.fn();
    render(
      <AgentLaunchButton
        {...p}
        primaryTask={{ title: "Run this as a task", onRun: run }}
      />,
    );

    fireEvent.click(screen.getByTitle("Run this as a task"));
    expect(run).toHaveBeenCalledTimes(1);
    expect(p.onStart).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByTitle("Send to a running agent, or start a new one instead"),
    );
    expect(screen.getByText("Origin agent")).toBeInTheDocument();
  });

  it("reflects the task's live state instead of relaunching it", () => {
    const p = props();
    const run = vi.fn();
    const show = vi.fn();
    const task = { title: "Run this as a task", onRun: run, onShow: show };
    const { rerender } = render(
      <AgentLaunchButton {...p} primaryTask={{ ...task, state: "starting" }} />,
    );
    expect(screen.getByText("Starting…").closest("button")).toBeDisabled();

    rerender(
      <AgentLaunchButton {...p} primaryTask={{ ...task, state: "running" }} />,
    );
    fireEvent.click(screen.getByText("Running").closest("button")!);
    expect(show).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps other running agents in the caret menu", () => {
    const p = { ...props(), agentTargets: [origin, other] };
    render(<AgentLaunchButton {...p} primaryTarget={origin} />);

    fireEvent.click(screen.getByTitle("Send to another agent, or start a new one"));
    fireEvent.click(screen.getByText("Other agent"));

    expect(p.onSend).toHaveBeenCalledWith(other);
  });

  describe("placement", () => {
    const project = { id: "p1", name: "App", components: [{ componentId: "c1", label: "web" }] };
    const decision = (d: Partial<PlacementDecision>): PlacementDecision => ({
      target: { kind: "local" }, reason: "", alternatives: [], needsSetup: false, ...d,
    });
    const click = () => fireEvent.click(screen.getByText("Send feedback", { exact: false }).closest("button")!);

    it("launches straight away when the decision is local, passing it along", async () => {
      const p = props();
      const d = decision({});
      render(<AgentLaunchButton {...p} placement={{ project, decide: async () => d }} />);
      click();
      await waitFor(() => expect(p.onStart).toHaveBeenCalledWith(expect.any(String), d));
    });

    it("asks to set the project up before launching on a remote that lacks it", async () => {
      const p = props();
      const d = decision({ target: { kind: "remote", workspaceId: "w1" }, needsSetup: true });
      render(<AgentLaunchButton {...p} placement={{ project, workspaceName: "Cloud", decide: async () => d }} />);
      click();
      expect(await screen.findByText("Setup App on Cloud")).toBeInTheDocument();
      expect(p.onStart).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Launch" }));
      expect(p.onStart).toHaveBeenCalledWith(expect.any(String), d);
    });

    it("does not launch when no target has room", async () => {
      const p = props();
      render(<AgentLaunchButton {...p} placement={{ project, decide: async () => decision({ target: null, reason: "Full." }) }} />);
      click();
      expect(await screen.findByText("Full.")).toBeInTheDocument();
      expect(p.onStart).not.toHaveBeenCalled();
    });

    it("stores the Run on choice per agent from the caret menu", () => {
      localStorage.clear();
      const p = props();
      render(<AgentLaunchButton {...p} placement={{ project, decide: async () => decision({}) }} />);
      fireEvent.click(screen.getByTitle("Send to a running agent, or start a different one"));
      fireEvent.click(screen.getByText("Run on: Remote"));
      expect(getAgentPreference("opencode")).toBe("remote");
    });
  });
});

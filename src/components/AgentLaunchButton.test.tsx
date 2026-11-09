import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentLaunchButton } from "./AgentLaunchButton";
import type { AgentTarget } from "./TicketsPanel";
import type { PlacementDecision } from "../placement/types";
import { getAgentPreference } from "../placement/preferences";
import { targetPreference } from "../placement/types";

const transitionMocks = vi.hoisted(() => ({ active: true, request: vi.fn() }));
vi.mock("../placement/transitions", () => ({
  canLaunchOnActiveTarget: () => transitionMocks.active,
  requestTargetTransition: transitionMocks.request,
}));

vi.mock("../remoteExecution/ProjectSetupDialog", () => ({
  ProjectSetupDialog: ({ projectName, workspaceName, onComplete }: { projectName: string; workspaceName: string; onComplete?: (ok: boolean) => void }) => (
    <div>
      Setup {projectName} on {workspaceName}
      <button onClick={() => onComplete?.(true)}>finish-ok</button>
      <button onClick={() => onComplete?.(false)}>finish-fail</button>
    </div>
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
  beforeEach(() => {
    transitionMocks.active = true;
    transitionMocks.request.mockReset();
    localStorage.clear();
  });
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
      expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
      fireEvent.click(screen.getByText("finish-ok"));
      fireEvent.click(screen.getByRole("button", { name: "Launch" }));
      expect(p.onStart).toHaveBeenCalledWith(expect.any(String), d);
    });

    it("keeps Launch disabled when setup fails", async () => {
      const p = props();
      const d = decision({ target: { kind: "remote", workspaceId: "w1" }, needsSetup: true });
      render(<AgentLaunchButton {...p} placement={{ project, workspaceName: "Cloud", decide: async () => d }} />);
      click();
      await screen.findByText("Setup App on Cloud");
      fireEvent.click(screen.getByText("finish-ok"));
      fireEvent.click(screen.getByText("finish-fail"));
      expect(screen.getByRole("button", { name: "Launch" })).toBeDisabled();
    });

    it("reports a failed decision instead of silently launching locally", async () => {
      const p = props();
      render(<AgentLaunchButton {...p} placement={{ project, decide: async () => { throw new Error("offline"); } }} />);
      click();
      expect(await screen.findByText(/offline/)).toBeInTheDocument();
      expect(p.onStart).not.toHaveBeenCalled();
    });

    it("does not launch when no target has room", async () => {
      const p = props();
      render(<AgentLaunchButton {...p} placement={{ project, decide: async () => decision({ target: null, reason: "Full." }) }} />);
      click();
      expect(await screen.findByText("Full.")).toBeInTheDocument();
      expect(p.onStart).not.toHaveBeenCalled();
    });

    it("stores a concrete Run on choice per agent from the caret menu", () => {
      const p = props();
      const targets = [
        { target: { kind: "local" } as const, name: "This Mac", online: true },
        { target: { kind: "remote", workspaceId: "w1" } as const, name: "Design Studio", online: true },
      ];
      render(<AgentLaunchButton {...p} placement={{ project, targets, decide: async () => decision({}) }} />);
      fireEvent.click(screen.getByTitle("Send to a running agent, or start a different one"));
      expect(screen.getByText("Run on: Use default")).toBeInTheDocument();
      expect(screen.getByText("Run on: Automatic")).toBeInTheDocument();
      fireEvent.click(screen.getByText("Run on: Design Studio"));
      expect(getAgentPreference("opencode")).toEqual(targetPreference({ kind: "remote", workspaceId: "w1" }));
    });

    it("offers a named transition instead of launching on the wrong active machine", async () => {
      transitionMocks.active = false;
      const p = props();
      const d = decision({ target: { kind: "remote", workspaceId: "w1" }, targetName: "Design Studio" });
      render(<AgentLaunchButton {...p} placement={{ project, decide: async () => d }} />);
      click();
      const open = await screen.findByRole("button", { name: "Open Design Studio" });
      expect(p.onStart).not.toHaveBeenCalled();
      fireEvent.click(open);
      expect(transitionMocks.request).toHaveBeenCalledWith({ kind: "remote", workspaceId: "w1" });
    });

    it("opens an unsupported T3 target by name without launching locally", async () => {
      transitionMocks.active = false;
      const p = props();
      const d = decision({ target: { kind: "t3", machineId: "m1" }, targetName: "Build Mini" });
      render(<AgentLaunchButton {...p} placement={{ project, decide: async () => d }} />);
      click();
      expect(await screen.findByText(/Build Mini opens in its machine view/)).toBeInTheDocument();
      expect(p.onStart).not.toHaveBeenCalled();
    });
  });
});

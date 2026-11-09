import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiedWorkspace } from "./UnifiedWorkspace";
import { buildUnifiedRows } from "../placement/unified";
import type { Gathered } from "../placement/gather";
import { getGlobalPreference } from "../placement/preferences";
import { targetPreference } from "../placement/types";

const rows = buildUnifiedRows({
  local: { projects: [{ id: "p", name: "Canopy" }], agents: [{ id: "a", name: "claude", project: "Canopy" }] },
  remotes: [{ workspaceId: "w1", name: "Cloud", state: "ready", projects: [] }],
  t3: [{ machineId: "m1", label: "Studio", projects: [{ id: "tp", title: "Canopy" }], threads: [{ id: "t1", name: "t", project: "tp", status: "running", branch: "main" }] }],
  jobs: [{ jobId: "j", title: "Fix tests", workspace: "Cloud", target: "w1", workspaceId: "w1" }],
});
const data: Gathered = {
  rows,
  notes: ["Only the active host is readable."],
  targets: [
    { target: { kind: "local" }, name: "This Mac", online: true },
    { target: { kind: "remote", workspaceId: "w1" }, name: "Cloud", online: true },
    { target: { kind: "t3", machineId: "m1" }, name: "Studio", online: false },
  ],
  resources: [
    { target: { kind: "local" }, online: true, activeAgents: 1, capacity: 4, lastSeen: 0 },
    { target: { kind: "remote", workspaceId: "w1" }, online: true, activeAgents: 0, capacity: 4, lastSeen: 0 },
    { target: { kind: "t3", machineId: "m1" }, online: false, activeAgents: 0, capacity: 0, lastSeen: 0 },
  ],
};

beforeEach(() => localStorage.clear());

describe("UnifiedWorkspace", () => {
  it("lists local, remote and T3 items together with target badges and load bars", async () => {
    render(<UnifiedWorkspace gather={async () => data} />);
    const canopy = await screen.findByRole("region", { name: "Canopy" });
    const badges = within(canopy).getAllByText(/This Mac|Studio/).map((e) => e.textContent);
    expect(badges).toEqual(expect.arrayContaining(["This Mac", "Studio"]));
    expect(screen.getByRole("region", { name: "Fix tests" })).toBeInTheDocument();
    expect(screen.getByLabelText("This Mac load")).toBeInTheDocument();
    expect(screen.getByText("offline")).toBeInTheDocument();
    expect(screen.getByText("Only the active host is readable.")).toBeInTheDocument();
  });

  it("filters by type and opens a thread", async () => {
    const onOpen = vi.fn();
    render(<UnifiedWorkspace gather={async () => data} onOpen={onOpen} />);
    await screen.findByRole("region", { name: "Canopy" });
    fireEvent.change(screen.getByLabelText("Kind filter"), { target: { value: "thread" } });
    expect(screen.queryByRole("region", { name: "Fix tests" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: "thread" }));
  });

  it("hands a task off to another target using the balancer", async () => {
    const onHandOff = vi.fn();
    render(<UnifiedWorkspace gather={async () => data} onHandOff={onHandOff} />);
    await screen.findByRole("region", { name: "Canopy" });
    fireEvent.change(screen.getByLabelText("Kind filter"), { target: { value: "agent" } });
    fireEvent.click(screen.getByRole("button", { name: "Hand off" }));
    expect(onHandOff).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({ target: { kind: "remote", workspaceId: "w1" } }));
  });

  it("persists the default run-on choice", async () => {
    render(<UnifiedWorkspace gather={async () => data} />);
    await screen.findByRole("region", { name: "Canopy" });
    fireEvent.change(screen.getByLabelText("Default run on"), { target: { value: "remote:w1" } });
    expect(getGlobalPreference()).toEqual(targetPreference({ kind: "remote", workspaceId: "w1" }));
  });

  it("shows a load failure", async () => {
    render(<UnifiedWorkspace gather={async () => { throw new Error("nope"); }} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("nope");
  });
});

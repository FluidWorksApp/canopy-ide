import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiedWorkspace } from "./UnifiedWorkspace";
import { buildUnifiedRows } from "../placement/unified";
import type { Gathered } from "../placement/gather";
import { getGlobalPreference } from "../placement/preferences";
import { targetPreference } from "../placement/types";

const rows = buildUnifiedRows({
  local: { projects: [{ id: "p", name: "Canopy" }], agents: [{ id: "a", name: "claude", project: "Canopy" }] },
  remotes: [{ workspaceId: "w1", name: "Build Box", state: "ready", projects: [] }],
  t3: [{ machineId: "m1", label: "Studio", projects: [{ id: "tp", title: "Canopy" }], threads: [{ id: "t1", name: "t", project: "tp", status: "running", branch: "main" }] }],
  jobs: [{ jobId: "j", title: "Fix tests", workspace: "Build Box", target: "w1", workspaceId: "w1" }],
});
const data: Gathered = {
  rows,
  discoveryFailures: [],
  notes: ["Projects on other machines appear after you switch to them."],
  targets: [
    { target: { kind: "local" }, name: "This Mac", online: true },
    { target: { kind: "remote", workspaceId: "w1" }, name: "Build Box", online: true },
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
  it("renders an accessible machine dashboard with labeled columns and responsive rows", async () => {
    render(<UnifiedWorkspace gather={async () => data} />);
    const table = await screen.findByRole("table", { name: "Work across all machines" });
    for (const heading of ["Work", "Machine", "Type", "Status", "Branch", "Actions"]) expect(within(table).getByRole("columnheader", { name: heading })).toBeInTheDocument();
    const canopyRows = within(table).getAllByRole("row").filter(row => row.textContent?.includes("Canopy"));
    expect(canopyRows.some(row => row.textContent?.includes("This Mac"))).toBe(true);
    expect(canopyRows.some(row => row.textContent?.includes("Studio"))).toBe(true);
    expect(canopyRows.every(row => row.classList.contains("unified-row"))).toBe(true);
    expect(table.querySelector('.unified-target-badge[data-target-id="t3:m1"]')).toHaveTextContent("Studio");
    expect(screen.getByText("Build Box", { selector: ".unified-machine-name" })).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("Projects on other machines appear after you switch to them.")).toBeInTheDocument();
  });

  it("filters by named machine and type, then opens a thread", async () => {
    const onOpen = vi.fn();
    render(<UnifiedWorkspace gather={async () => data} onOpen={onOpen} />);
    await screen.findByRole("table");
    const machine = screen.getByLabelText("Machine filter");
    expect(within(machine).getAllByRole("option").map(option => option.textContent)).toEqual(["All machines", "This Mac", "Build Box", "Studio"]);
    fireEvent.change(machine, { target: { value: "t3:m1" } });
    fireEvent.change(screen.getByLabelText("Type filter"), { target: { value: "thread" } });
    expect(screen.queryByText("Fix tests")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Canopy on Studio" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ kind: "thread", target: { kind: "t3", machineId: "m1" } }));
  });

  it("hands a task off to another target using the balancer", async () => {
    const onHandOff = vi.fn();
    render(<UnifiedWorkspace gather={async () => data} onHandOff={onHandOff} />);
    await screen.findByRole("table");
    fireEvent.change(screen.getByLabelText("Type filter"), { target: { value: "agent" } });
    fireEvent.click(screen.getByRole("button", { name: /Hand off Canopy/ }));
    expect(onHandOff).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent" }), expect.objectContaining({ target: { kind: "remote", workspaceId: "w1" } }));
  });

  it("persists the default run-on choice", async () => {
    render(<UnifiedWorkspace gather={async () => data} />);
    await screen.findByRole("table");
    fireEvent.change(screen.getByLabelText("Default run on"), { target: { value: "remote:w1" } });
    expect(getGlobalPreference()).toEqual(targetPreference({ kind: "remote", workspaceId: "w1" }));
  });

  it("shows a useful empty state", async () => {
    render(<UnifiedWorkspace gather={async () => ({ ...data, rows: [] })} />);
    expect(await screen.findByText("No work is visible yet.")).toBeInTheDocument();
    expect(screen.getByText(/Open or set up a project/)).toBeInTheDocument();
  });

  it("shows useful loading and retryable error states", async () => {
    let reject!: (reason: Error) => void;
    const gather = vi.fn(() => new Promise<Gathered>((_resolve, rejectPromise) => { reject = rejectPromise; }));
    render(<UnifiedWorkspace gather={gather} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading work from your machines…");
    reject(new Error("nope"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load workspaces: nope");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));expect(gather).toHaveBeenCalledTimes(2);
  });
});

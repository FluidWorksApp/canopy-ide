import { beforeEach, describe, expect, it } from "vitest";
import { targetPreference, type Target } from "../../placement/types";
import type { Gathered } from "../../placement/gather";
import { resolveProjectMachineLaunch } from "./placement";

const project = { id: "p1", name: "Canopy" };
const remote: Target = { kind: "remote", workspaceId: "w1" };
const local: Target = { kind: "local" };

const gathered = (over: Partial<Gathered> = {}): Gathered => ({
  rows: [],
  resources: [
    { target: local, online: true, activeAgents: 0, capacity: 4, lastSeen: 1 },
    { target: remote, online: true, activeAgents: 0, capacity: 4, lastSeen: 1 },
  ],
  targets: [
    { target: local, name: "This Mac", online: true },
    { target: remote, name: "Design Studio", online: true },
  ],
  discoveryFailures: [],
  notes: [],
  ...over,
});

beforeEach(() => localStorage.clear());

describe("ProjectView machine launch boundary", () => {
  it("requires setup when a different project has the same display name", async () => {
    const data = gathered({
      rows: [
        { id: "remote:w1:project:p2", projectId: "p2", name: "Canopy", kind: "project", target: remote, targetLabel: "Design Studio", status: "ready", needsSetup: false },
        { id: "remote:w1:setup:p1", projectId: "p1", name: "Canopy", kind: "project", target: remote, targetLabel: "Design Studio", status: "not set up", needsSetup: true },
      ],
    });

    const outcome = await resolveProjectMachineLaunch({
      project,
      agentKind: "opencode",
      requested: targetPreference(remote),
      gather: async () => data,
      canLaunch: () => true,
    });

    expect(outcome).toMatchObject({
      kind: "setup",
      name: "Design Studio",
      decision: { target: remote, needsSetup: true },
    });
  });

  it("returns an exact named transition and never dispatches on the active machine", async () => {
    const outcome = await resolveProjectMachineLaunch({
      project,
      agentKind: "opencode",
      requested: targetPreference(remote),
      gather: async () => gathered(),
      canLaunch: () => false,
    });

    expect(outcome).toEqual({ kind: "transition", target: remote, name: "Design Studio" });
  });

  it("refuses before placement when machine discovery is incomplete", async () => {
    const outcome = await resolveProjectMachineLaunch({
      project,
      agentKind: "opencode",
      requested: targetPreference(local),
      gather: async () => gathered({ discoveryFailures: ["Could not read connected machines: offline"] }),
      canLaunch: () => true,
    });

    expect(outcome).toEqual({ kind: "refusal", reason: "Could not read connected machines: offline" });
  });

  it("allows final dispatch only after the selected active target passes the fresh gather", async () => {
    const outcome = await resolveProjectMachineLaunch({
      project,
      agentKind: "opencode",
      requested: targetPreference(local),
      gather: async () => gathered(),
      canLaunch: (target) => target.kind === "local",
    });

    expect(outcome).toMatchObject({ kind: "launch", decision: { target: local, needsSetup: false } });
  });
});

import { describe, expect, it } from "vitest";
import { displayTargets, projectAvailability } from "./gather";
import type { UnifiedRow } from "./unified";
import type { ResourceSnapshot } from "./types";

const snapshot = (target: ResourceSnapshot["target"], online = true): ResourceSnapshot => ({
  target,
  online,
  activeAgents: 0,
  capacity: online ? 4 : 0,
  lastSeen: 0,
});

describe("displayTargets", () => {
  it("combines This Mac and named workspaces, with each one's online state", () => {
    const resources = [
      snapshot({ kind: "local" }),
      snapshot({ kind: "remote", workspaceId: "w1" }),
      snapshot({ kind: "remote", workspaceId: "w2" }, false),
    ];
    expect(displayTargets(
      resources,
      [{ id: "w1", name: "Design Studio" }, { id: "w2", name: "Build Mini" }],
    )).toEqual([
      { target: { kind: "local" }, name: "This Mac", online: true },
      { target: { kind: "remote", workspaceId: "w1" }, name: "Design Studio", online: true },
      { target: { kind: "remote", workspaceId: "w2" }, name: "Build Mini", online: false },
    ]);
  });
});

describe("projectAvailability", () => {
  it("does not treat an unrelated project on a target as setup for this project", () => {
    const remote = { kind: "remote", workspaceId: "w1" } as const;
    const rows: UnifiedRow[] = [
      { id: "remote:w1:project:p2", projectId: "p2", name: "Other app", kind: "project", target: remote, targetLabel: "Studio", status: "ready", needsSetup: false },
      { id: "remote:w1:setup:p1", projectId: "p1", name: "Canopy", kind: "project", target: remote, targetLabel: "Studio", status: "not set up", needsSetup: true },
    ];

    expect(projectAvailability(rows, { id: "p1", name: "Canopy" })).toEqual([]);
    expect(projectAvailability(rows, { id: "p2", name: "Other app" })).toEqual([remote]);
  });

  it("does not treat a same-name project with another ID as ready", () => {
    const remote = { kind: "remote", workspaceId: "w1" } as const;
    const rows: UnifiedRow[] = [
      { id: "remote:w1:project:p2", projectId: "p2", name: "Canopy", kind: "project", target: remote, targetLabel: "Studio", status: "ready", needsSetup: false },
      { id: "remote:w1:setup:p1", projectId: "p1", name: "Canopy", kind: "project", target: remote, targetLabel: "Studio", status: "not set up", needsSetup: true },
    ];

    expect(projectAvailability(rows, { id: "p1", name: "Canopy" })).toEqual([]);
    expect(projectAvailability(rows, { id: "p2", name: "Canopy" })).toEqual([remote]);
  });
});

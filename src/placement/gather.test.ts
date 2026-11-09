import { describe, expect, it } from "vitest";
import { displayTargets } from "./gather";
import type { ResourceSnapshot } from "./types";

const snapshot = (target: ResourceSnapshot["target"], online = true): ResourceSnapshot => ({
  target,
  online,
  activeAgents: 0,
  capacity: online ? 4 : 0,
  lastSeen: 0,
});

describe("displayTargets", () => {
  it("combines This Mac and named connected machines without collapsing stable IDs", () => {
    const resources = [
      snapshot({ kind: "local" }),
      snapshot({ kind: "remote", workspaceId: "same-id" }),
      snapshot({ kind: "t3", machineId: "same-id" }, false),
    ];
    expect(displayTargets(
      resources,
      [{ id: "same-id", name: "Design Studio" }],
      [{ id: "same-id", label: "Build Mini" }],
    )).toEqual([
      { target: { kind: "local" }, name: "This Mac", online: true },
      { target: { kind: "remote", workspaceId: "same-id" }, name: "Design Studio", online: true },
      { target: { kind: "t3", machineId: "same-id" }, name: "Build Mini", online: false },
    ]);
  });
});

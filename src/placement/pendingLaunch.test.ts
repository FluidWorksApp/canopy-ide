import { beforeEach, describe, expect, it } from "vitest";
import { clearPendingLaunch, PENDING_LAUNCH_TTL_MS, setPendingLaunch, takePendingLaunch } from "./pendingLaunch";

const remote = { kind: "remote", workspaceId: "w9" } as const;
const local = { kind: "local" } as const;

beforeEach(() => {
  localStorage.clear();
});

describe("pending launch", () => {
  it("is handed to the right machine and project once, then gone", () => {
    setPendingLaunch({ agentId: "claude", projectId: "mac-1", componentLabel: "canopy", target: remote }, 1000);
    expect(takePendingLaunch(remote, "mac-1", 2000)).toMatchObject({ agentId: "claude", componentLabel: "canopy" });
    expect(takePendingLaunch(remote, "mac-1", 3000)).toBeNull();
  });

  it("is left alone by another machine or another project, so the right one can still take it", () => {
    setPendingLaunch({ agentId: "claude", projectId: "mac-1", target: remote }, 1000);
    expect(takePendingLaunch(local, "mac-1", 1500)).toBeNull();
    expect(takePendingLaunch(remote, "other", 1500)).toBeNull();
    expect(takePendingLaunch(remote, "mac-1", 1800)).not.toBeNull();
  });

  it("expires, so an abandoned switch cannot start an agent later", () => {
    setPendingLaunch({ agentId: "claude", projectId: "mac-1", target: remote }, 1000);
    expect(takePendingLaunch(remote, "mac-1", 1000 + PENDING_LAUNCH_TTL_MS + 1)).toBeNull();
    expect(localStorage.getItem("canopy:pending-launch:v1")).toBeNull();
  });

  it("ignores garbage and an intent from the future", () => {
    localStorage.setItem("canopy:pending-launch:v1", "{not json");
    expect(takePendingLaunch(remote, "mac-1")).toBeNull();
    localStorage.setItem("canopy:pending-launch:v1", JSON.stringify({ agentId: "claude", projectId: "mac-1", target: remote, at: Date.now() + 3_600_000 }));
    expect(takePendingLaunch(remote, "mac-1")).toBeNull();
    localStorage.setItem("canopy:pending-launch:v1", JSON.stringify({ agentId: 1, projectId: "mac-1", target: remote, at: Date.now() }));
    expect(takePendingLaunch(remote, "mac-1")).toBeNull();
  });

  it("can be cleared", () => {
    setPendingLaunch({ agentId: "claude", projectId: "mac-1", target: local });
    clearPendingLaunch();
    expect(takePendingLaunch(local, "mac-1")).toBeNull();
  });

  it("carries the PR or ticket to start, intact, to the right machine", () => {
    const pr = { number: 7, title: "Fix" };
    setPendingLaunch({ agentId: "codex", projectId: "mac-1", componentLabel: "web", then: { kind: "pr-review", payload: pr }, target: remote }, 1000);
    const got = takePendingLaunch(remote, "mac-1", 2000);
    expect(got?.then).toEqual({ kind: "pr-review", payload: pr });
    expect(got?.componentLabel).toBe("web");
    setPendingLaunch({ agentId: "codex", projectId: "mac-1", then: { kind: "ticket", payload: { id: "T-1" } }, target: local }, 1000);
    expect(takePendingLaunch(remote, "mac-1", 1500)).toBeNull();
    expect(takePendingLaunch(local, "mac-1", 1500)?.then?.kind).toBe("ticket");
  });
});

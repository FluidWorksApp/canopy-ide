import { beforeEach, describe, expect, it } from "vitest";
import { decideHandoff, decideLaunch } from "./launch";
import { setAgentPreference, setGlobalPreference, setProjectPreference } from "./preferences";
import { automaticPreference, inheritPreference, targetPreference, type ResourceSnapshot } from "./types";

const snap = (target: ResourceSnapshot["target"], activeAgents = 0): ResourceSnapshot => ({
  target, online: true, activeAgents, capacity: 4, lastSeen: 0,
});
const local = { kind: "local" } as const;
const workspaceOne = { kind: "remote", workspaceId: "w1" } as const;
const workspaceTwo = { kind: "remote", workspaceId: "w2" } as const;
const resources = [snap(local, 3), snap(workspaceOne, 0), snap(workspaceTwo, 1)];

beforeEach(() => localStorage.clear());

describe("decideLaunch", () => {
  it("uses each persisted level and preserves a concrete target", () => {
    setGlobalPreference(targetPreference(local));
    expect(decideLaunch({ projectId: "p", agentKind: "claude", resources }).target).toEqual(local);
    setProjectPreference("p", targetPreference(workspaceTwo));
    expect(decideLaunch({ projectId: "p", agentKind: "claude", resources }).target).toEqual(workspaceTwo);
    setAgentPreference("claude", targetPreference(workspaceOne));
    expect(decideLaunch({ projectId: "p", agentKind: "claude", resources }).target).toEqual(workspaceOne);
  });

  it("keeps Automatic distinct from Use default", () => {
    setGlobalPreference(targetPreference(local));
    setProjectPreference("p", automaticPreference());
    setAgentPreference("claude", inheritPreference());
    expect(decideLaunch({ projectId: "p", agentKind: "claude", resources, availability: [workspaceOne, workspaceTwo] }).target).toEqual(workspaceOne);
  });

  it("lets a launch-dialog choice override saved preferences", () => {
    setAgentPreference("claude", targetPreference(workspaceOne));
    expect(decideLaunch({
      projectId: "p",
      agentKind: "claude",
      resources,
      requested: targetPreference(workspaceTwo),
    }).target).toEqual(workspaceTwo);
  });

  it("adds the selected machine name and setup state", () => {
    const decision = decideLaunch({
      projectId: "p",
      agentKind: "claude",
      resources,
      requested: targetPreference(workspaceOne),
      availability: [],
      targets: [{ target: workspaceOne, name: "Studio", online: true }],
    });
    expect(decision).toMatchObject({ target: workspaceOne, targetName: "Studio", needsSetup: true });
  });

  it("Automatic picks the least-loaded currently eligible machine", () => {
    setGlobalPreference(automaticPreference());
    expect(decideLaunch({
      projectId: "p", agentKind: "x", resources, availability: [workspaceOne, workspaceTwo],
    }).target).toEqual(workspaceOne);
  });
});

describe("decideHandoff", () => {
  it("never picks the machine the task is already on", () => {
    const decision = decideHandoff({
      projectId: "p", agentKind: "x", resources, from: local, availability: [workspaceOne, workspaceTwo],
    });
    expect(decision.target).toEqual(workspaceOne);
    const none = decideHandoff({ projectId: "p", agentKind: "x", resources: [resources[0]], from: local });
    expect(none.target).toBeNull();
  });
});

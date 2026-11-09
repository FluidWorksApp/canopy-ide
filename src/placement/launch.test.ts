import { beforeEach, describe, expect, it } from "vitest";
import { decideHandoff, decideLaunch } from "./launch";
import { setAgentPreference, setGlobalPreference, setProjectPreference } from "./preferences";
import type { ResourceSnapshot } from "./types";

const snap = (target: ResourceSnapshot["target"], activeAgents = 0): ResourceSnapshot => ({
  target, online: true, activeAgents, capacity: 4, lastSeen: 0,
});
const resources = [snap({ kind: "local" }, 3), snap({ kind: "remote", workspaceId: "w1" }, 0)];

beforeEach(() => localStorage.clear());

describe("decideLaunch", () => {
  it("uses the persisted preference at each level", () => {
    setGlobalPreference("local");
    expect(decideLaunch({ projectId: "p", agentKind: "claude", resources }).target).toEqual({ kind: "local" });
    setProjectPreference("p", "remote");
    expect(decideLaunch({ projectId: "p", agentKind: "claude", resources }).target).toEqual({ kind: "remote", workspaceId: "w1" });
    setAgentPreference("claude", "local");
    expect(decideLaunch({ projectId: "p", agentKind: "claude", resources }).target).toEqual({ kind: "local" });
  });

  it("flags needsSetup when the remote lacks the project", () => {
    setProjectPreference("p", "remote");
    const d = decideLaunch({ projectId: "p", agentKind: "claude", resources, availability: [] });
    expect(d).toMatchObject({ target: { kind: "remote", workspaceId: "w1" }, needsSetup: true });
    const ok = decideLaunch({ projectId: "p", agentKind: "claude", resources, availability: [{ kind: "remote", workspaceId: "w1" }] });
    expect(ok.needsSetup).toBe(false);
  });

  it("balance picks the less loaded target", () => {
    setGlobalPreference("balance");
    expect(decideLaunch({ projectId: "p", agentKind: "x", resources, availability: [{ kind: "remote", workspaceId: "w1" }] }).target).toEqual({ kind: "remote", workspaceId: "w1" });
  });
});

describe("decideHandoff", () => {
  it("never picks the target the task is already on", () => {
    const d = decideHandoff({ projectId: "p", agentKind: "x", resources, from: { kind: "local" }, availability: [{ kind: "remote", workspaceId: "w1" }] });
    expect(d.target).toEqual({ kind: "remote", workspaceId: "w1" });
    const none = decideHandoff({ projectId: "p", agentKind: "x", resources: [resources[0]], from: { kind: "local" } });
    expect(none.target).toBeNull();
  });
});

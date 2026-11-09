import { describe, expect, it } from "vitest";
import { choosePlacement, effectivePreference } from "./balancer";
import type { ResourceSnapshot, Target } from "./types";

const L: Target = { kind: "local" };
const R: Target = { kind: "remote", workspaceId: "w1" };
const snap = (target: Target, o: Partial<ResourceSnapshot> = {}): ResourceSnapshot => ({
  target, online: true, activeAgents: 0, capacity: 4, lastSeen: 0, ...o,
});

describe("effectivePreference", () => {
  it("agent beats project beats global, auto defers", () => {
    expect(effectivePreference({ preference: "local", projectPref: "remote", agentPref: "balance" })).toBe("balance");
    expect(effectivePreference({ preference: "local", projectPref: "remote", agentPref: "auto" })).toBe("remote");
    expect(effectivePreference({ preference: "local", projectPref: "auto" })).toBe("local");
    expect(effectivePreference({})).toBe("balance");
  });
});

describe("choosePlacement", () => {
  const both = [snap(L), snap(R)];
  const avail = [L, R];
  it("honors the preference by precedence", () => {
    const d = choosePlacement({ preference: "local", projectPref: "remote", resources: both, projectAvailability: avail });
    expect(d.target).toEqual(R);
    const a = choosePlacement({ preference: "local", projectPref: "remote", agentPref: "local", resources: both, projectAvailability: avail });
    expect(a.target).toEqual(L);
  });
  it("balance ranks targets with unknown load after known ones", () => {
    const d = choosePlacement({ preference: "balance", resources: [snap(L, { activeAgents: 3 }), snap(R, { loadUnknown: true })], projectAvailability: [L, R] });
    expect(d.target).toEqual(L);
    const only = choosePlacement({ preference: "balance", resources: [snap(L, { online: false }), snap(R, { loadUnknown: true })], projectAvailability: [R] });
    expect(only.target).toEqual(R);
  });

  it("balance picks the lowest utilization", () => {
    const d = choosePlacement({ preference: "balance", resources: [snap(L, { activeAgents: 3 }), snap(R, { activeAgents: 1 })], projectAvailability: avail });
    expect(d.target).toEqual(R);
    expect(d.alternatives).toEqual([L]);
  });
  it("breaks utilization ties by cpu, then by stated preference", () => {
    expect(choosePlacement({ preference: "balance", resources: [snap(L, { cpuLoad: 0.9 }), snap(R, { cpuLoad: 0.1 })], projectAvailability: avail }).target).toEqual(R);
    expect(choosePlacement({ preference: "auto", agentPref: "balance", resources: both, projectAvailability: avail }).target).toEqual(L);
  });
  it("never picks offline or full targets", () => {
    expect(choosePlacement({ preference: "local", resources: [snap(L, { online: false }), snap(R)], projectAvailability: avail })).toMatchObject({ target: R, reason: expect.stringContaining("offline") });
    expect(choosePlacement({ preference: "remote", resources: [snap(L), snap(R, { activeAgents: 4 })], projectAvailability: avail })).toMatchObject({ target: L, reason: expect.stringContaining("full") });
    expect(choosePlacement({ preference: "balance", resources: [snap(L, { online: false }), snap(R, { activeAgents: 4 })] }).target).toBeNull();
  });
  it("flags needsSetup when the project is not on the chosen remote", () => {
    expect(choosePlacement({ preference: "remote", resources: both, projectAvailability: [L] })).toMatchObject({ target: R, needsSetup: true });
    expect(choosePlacement({ preference: "remote", resources: both, projectAvailability: avail }).needsSetup).toBe(false);
  });
  it("prefers a set-up target over one needing setup within a side", () => {
    const R2: Target = { kind: "remote", workspaceId: "w2" };
    const d = choosePlacement({ preference: "remote", resources: [snap(R, { activeAgents: 2 }), snap(R2)], projectAvailability: [L, R] });
    expect(d.target).toEqual(R);
  });
  it("keeps a sticky target while it has room", () => {
    expect(choosePlacement({ preference: "local", sticky: R, resources: both, projectAvailability: avail }).target).toEqual(R);
    expect(choosePlacement({ preference: "local", sticky: R, resources: [snap(L), snap(R, { online: false })] }).target).toEqual(L);
  });
  it("is deterministic regardless of input order", () => {
    const rs = [snap(L), snap(R), snap({ kind: "t3", machineId: "m" })];
    const a = choosePlacement({ preference: "balance", resources: rs });
    const b = choosePlacement({ preference: "balance", resources: [...rs].reverse() });
    expect(a).toEqual(b);
  });
});

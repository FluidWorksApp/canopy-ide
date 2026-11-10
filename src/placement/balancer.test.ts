import { describe, expect, it } from "vitest";
import { choosePlacement, effectivePreference } from "./balancer";
import { automaticPreference, inheritPreference, targetPreference, type ResourceSnapshot, type Target } from "./types";

const L: Target = { kind: "local" };
const R: Target = { kind: "remote", workspaceId: "w1" };
const R2: Target = { kind: "remote", workspaceId: "w2" };
const snap = (target: Target, overrides: Partial<ResourceSnapshot> = {}): ResourceSnapshot => ({
  target, online: true, activeAgents: 0, capacity: 4, lastSeen: 0, ...overrides,
});

describe("effectivePreference", () => {
  it("lets only Use default defer while Automatic remains explicit", () => {
    expect(effectivePreference({
      preference: targetPreference(L),
      projectPref: targetPreference(R),
      agentPref: automaticPreference(),
    })).toEqual(automaticPreference());
    expect(effectivePreference({
      preference: targetPreference(L),
      projectPref: targetPreference(R),
      agentPref: inheritPreference(),
    })).toEqual(targetPreference(R));
    expect(effectivePreference({ preference: targetPreference(L), projectPref: inheritPreference() })).toEqual(targetPreference(L));
    expect(effectivePreference({})).toEqual(automaticPreference());
  });
});

describe("choosePlacement", () => {
  const both = [snap(L), snap(R)];
  const available = [L, R];

  it("honors a concrete target by stable ID", () => {
    expect(choosePlacement({
      preference: targetPreference(R2),
      resources: [snap(R), snap(R2)],
      projectAvailability: [R, R2],
    }).target).toEqual(R2);
  });

  it("never falls back from an unavailable concrete target", () => {
    expect(choosePlacement({
      preference: targetPreference(R),
      resources: [snap(L), snap(R, { online: false })],
      projectAvailability: available,
    })).toMatchObject({ target: null, reason: "The selected machine is offline." });
  });

  it("a chosen machine that is full is still used, with a warning, never replaced by another", () => {
    const decision = choosePlacement({
      preference: targetPreference(R),
      resources: [snap(L), snap(R, { activeAgents: 4 })],
      projectAvailability: available,
    });
    expect(decision.target).toEqual(R);
    expect(decision.warning).toMatch(/is full \(4 of 4 agent slots\)/);
  });

  it("This Mac is never refused, full or not read at all", () => {
    const full = choosePlacement({ preference: targetPreference(L), resources: [snap(L, { activeAgents: 4 })] });
    expect(full.target).toEqual(L);
    expect(full.warning).toMatch(/This Mac is full/);
    const unread = choosePlacement({ preference: targetPreference(L), resources: [] });
    expect(unread.target).toEqual(L);
    expect(unread.warning).toBeUndefined();
  });

  it("Automatic with every machine full starts on this Mac with a warning instead of refusing", () => {
    const decision = choosePlacement({
      preference: automaticPreference(),
      resources: [snap(L, { activeAgents: 4 }), snap(R, { activeAgents: 4 })],
      projectAvailability: available,
    });
    expect(decision.target).toEqual(L);
    expect(decision.warning).toMatch(/full/);
    const none = choosePlacement({ preference: automaticPreference(), resources: [] });
    expect(none.target).toEqual(L);
    expect(none.warning).toMatch(/Starting on this Mac/);
  });

  it("a hand-off still never lands on a machine it was not offered", () => {
    expect(choosePlacement({ preference: automaticPreference(), resources: [], noLocalFallback: true }).target).toBeNull();
  });

  it("Automatic ranks targets with unknown load after known ones", () => {
    const decision = choosePlacement({
      preference: automaticPreference(),
      resources: [snap(L, { activeAgents: 3 }), snap(R, { loadUnknown: true })],
      projectAvailability: available,
    });
    expect(decision.target).toEqual(L);
  });

  it("Automatic uses current availability and load", () => {
    const remote = choosePlacement({
      preference: automaticPreference(),
      resources: [snap(L, { activeAgents: 3 }), snap(R, { activeAgents: 1 })],
      projectAvailability: available,
    });
    expect(remote.target).toEqual(R);
    const local = choosePlacement({
      preference: automaticPreference(),
      resources: [snap(L), snap(R, { online: false })],
      projectAvailability: available,
    });
    expect(local.target).toEqual(L);
  });

  it("flags setup and prefers a machine where the project is ready", () => {
    expect(choosePlacement({
      preference: targetPreference(R), resources: both, projectAvailability: [L],
    })).toMatchObject({ target: R, needsSetup: true });
    const decision = choosePlacement({
      preference: automaticPreference(),
      resources: [snap(R, { activeAgents: 2 }), snap(R2)],
      projectAvailability: [L, R],
    });
    expect(decision.target).toEqual(R);
  });

  it("keeps a sticky target only for Automatic", () => {
    expect(choosePlacement({
      preference: automaticPreference(), sticky: R, resources: both, projectAvailability: available,
    }).target).toEqual(R);
    expect(choosePlacement({
      preference: targetPreference(L), sticky: R, resources: both, projectAvailability: available,
    }).target).toEqual(L);
  });

  it("is deterministic regardless of input order", () => {
    const resources = [snap(L), snap(R), snap({ kind: "t3", machineId: "m" })];
    expect(choosePlacement({ preference: automaticPreference(), resources })).toEqual(
      choosePlacement({ preference: automaticPreference(), resources: [...resources].reverse() }),
    );
  });
});

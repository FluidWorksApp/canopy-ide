import { describe, expect, it } from "vitest";
import type { AccountStatus, IntegrationHealth, PlanUsage } from "./ipc";
import {
  fleetGate,
  fleetState,
  rankFleet,
  type FleetInputs,
} from "./fleetState";

const NOW = 1_700_000_000_000;

const account = (state: AccountStatus["state"]): AccountStatus => ({
  agent: "claude",
  state,
  account: state === "in" ? "sam@fluidwords.app" : null,
});

const plan = (usedPercent: number, observedAgoSecs = 0): PlanUsage => ({
  agent: "claude",
  profile: "default",
  plan: "default_claude_max_5x",
  windows: [{ label: "5h", used_percent: usedPercent, resets_at: null }],
  credits: null,
  observed: Math.floor(NOW / 1000) - observedAgoSecs,
});

const health = (hooks: string, mcp = "ours"): IntegrationHealth => ({
  agent: "claude",
  cli_installed: true,
  hooks,
  mcp,
});

const base: FleetInputs = {
  agent: "claude",
  profile: "default",
  installed: true,
  account: account("in"),
  plan: plan(10),
  health: health("ours"),
};

describe("fleetState", () => {
  it("is ready with no reasons when every signal is good", () => {
    expect(fleetState(base, NOW)).toEqual({
      agent: "claude",
      profile: "default",
      kind: "ready",
      reasons: [],
    });
  });

  it("a missing binary is unusable and moots everything else", () => {
    const s = fleetState({ ...base, installed: false, plan: plan(99) }, NOW);
    expect(s.kind).toBe("unusable");
    expect(s.reasons).toEqual(["not-installed"]);
  });

  it("a signed-out account is unusable", () => {
    const s = fleetState({ ...base, account: account("out") }, NOW);
    expect(s.kind).toBe("unusable");
    expect(s.reasons).toEqual(["signed-out"]);
  });

  it("an unverifiable sign-in demotes without blocking", () => {
    const s = fleetState({ ...base, account: account("unknown") }, NOW);
    expect(s.kind).toBe("degraded");
    expect(s.reasons).toContain("auth-unknown");
    expect(fleetGate(s).allowed).toBe(true);
  });

  it("an absent account probe is not a demotion", () => {
    expect(fleetState({ ...base, account: undefined }, NOW).kind).toBe("ready");
  });

  it("critical headroom demotes; warn only annotates", () => {
    expect(fleetState({ ...base, plan: plan(95) }, NOW).kind).toBe("degraded");
    const warned = fleetState({ ...base, plan: plan(80) }, NOW);
    expect(warned.kind).toBe("ready");
    expect(warned.reasons).toEqual(["plan-warn"]);
  });

  it("a stale reading only matters once headroom is already worth watching", () => {
    const staleLow = fleetState({ ...base, plan: plan(10, 60 * 60) }, NOW);
    expect(staleLow.reasons).toEqual([]);
    const staleHot = fleetState({ ...base, plan: plan(95, 60 * 60) }, NOW);
    expect(staleHot.reasons).toEqual(["plan-critical", "plan-stale"]);
  });

  it("unhealthy integration annotates a ready route", () => {
    const s = fleetState({ ...base, health: health("foreign") }, NOW);
    expect(s.kind).toBe("ready");
    expect(s.reasons).toEqual(["integration-unhealthy"]);
  });

  it("the gate refuses only the unusable", () => {
    expect(fleetGate(fleetState(base, NOW))).toEqual({ allowed: true, why: null });
    const out = fleetGate(fleetState({ ...base, account: account("out") }, NOW));
    expect(out.allowed).toBe(false);
    expect(out.why).toBe("signed out");
  });

  it("ranks ready over degraded over unusable and keeps list order within a tier", () => {
    const ready = fleetState(base, NOW);
    const degraded = fleetState({ ...base, agent: "codex", plan: plan(95) }, NOW);
    const dead = fleetState({ ...base, agent: "aider", installed: false }, NOW);
    expect(rankFleet([dead, degraded, ready]).map((s) => s.agent)).toEqual([
      "claude",
      "codex",
      "aider",
    ]);
    const readyB = fleetState({ ...base, agent: "opencode" }, NOW);
    expect(rankFleet([ready, readyB]).map((s) => s.agent)).toEqual([
      "claude",
      "opencode",
    ]);
  });
});

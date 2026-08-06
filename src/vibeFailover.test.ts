import { describe, expect, it } from "vitest";
import { failoverDecision, rankRoutes, type RouteCandidate } from "./vibeFailover";
import type { FleetState } from "./fleetState";
import type { AttemptOutcome } from "./failureClassifier";

const state = (
  agent: string,
  kind: FleetState["kind"],
  reasons: FleetState["reasons"] = [],
): FleetState => ({ agent, profile: "default", kind, reasons });

const claude = (kind: FleetState["kind"] = "ready"): RouteCandidate => ({
  cli: "claude",
  profileId: "default",
  family: "anthropic",
  state: state("claude", kind, kind === "unusable" ? ["signed-out"] : []),
  choices: [{ id: "claude-fable-5", label: "Fable 5", hint: "" }, { id: "claude-haiku-4-5", label: "Haiku", hint: "" }],
});

const codex = (kind: FleetState["kind"] = "ready"): RouteCandidate => ({
  cli: "codex",
  profileId: "default",
  family: "openai",
  state: state("codex", kind, kind === "degraded" ? ["plan-warn"] : []),
  choices: [{ id: "gpt-5.6-sol", label: "GPT-5.6", hint: "" }, { id: "gpt-5.6-luna", label: "Luna", hint: "" }],
});

describe("route selection", () => {
  it("offers only routes the fleet gate allows", () => {
    const ranked = rankRoutes([claude("unusable"), codex()], "build");
    expect(ranked.map((r) => r.cli)).toEqual(["codex"]);
  });

  it("routes a build to each family's frontier model", () => {
    expect(rankRoutes([claude()], "build")[0]).toMatchObject({
      cli: "claude",
      requestedModel: "claude-fable-5",
      tier: "frontier",
      degradedTier: false,
    });
    expect(rankRoutes([codex()], "build")[0]).toMatchObject({
      requestedModel: "gpt-5.6-sol",
      tier: "frontier",
    });
  });

  it("prefers a ready route over a degraded one and carries its caveat", () => {
    const ranked = rankRoutes([codex("degraded"), claude()], "build");
    expect(ranked.map((r) => r.cli)).toEqual(["claude", "codex"]);
    expect(ranked[0].caveat).toBeNull();
    expect(ranked[1].caveat).toBeTruthy();
  });

  it("flags a served tier below the one the class asked for", () => {
    const haikuOnly: RouteCandidate = {
      ...claude(),
      choices: [{ id: "claude-haiku-4-5", label: "Haiku", hint: "" }],
    };
    expect(rankRoutes([haikuOnly], "build")[0]).toMatchObject({
      tier: "fast",
      degradedTier: true,
    });
  });

  it("drops a route with no recognizable model rather than guessing", () => {
    const unknownModels: RouteCandidate = {
      ...claude(),
      choices: [{ id: "some-internal-build", label: "?", hint: "" }],
    };
    expect(rankRoutes([unknownModels], "build")).toEqual([]);
  });
});

describe("failover decisions", () => {
  const base = {
    history: [] as AttemptOutcome[],
    current: { cli: "claude", profileId: "default" },
    candidates: [claude(), codex()],
    task: "build" as const,
    attemptsUsed: 1,
    attemptCap: 3,
  };

  it("switches to another route when the route itself is out of quota", () => {
    const { action, verdict } = failoverDecision({
      ...base,
      evidence: { agent: "claude", text: "usage limit reached for your plan" },
    });
    expect(verdict.class).toBe("route");
    expect(action.kind).toBe("switch-route");
    if (action.kind !== "switch-route") throw new Error("expected a switch");
    expect(action.to.cli).toBe("codex");
    expect(action.narration).toMatch(/Claude .*quota.*switched to Codex/i);
  });

  it("retries the same route on a transient failure", () => {
    const { action, verdict } = failoverDecision({
      ...base,
      evidence: { text: "connection reset by peer" },
    });
    expect(verdict.class).toBe("transient");
    expect(action.kind).toBe("retry-same");
  });

  it("never switches on a task failure", () => {
    const { action, verdict } = failoverDecision({
      ...base,
      evidence: { text: "prompt is too long: context window exceeded" },
    });
    expect(verdict.class).toBe("task");
    expect(action.kind).toBe("stop");
    expect(action.narration).toMatch(/not the model/i);
  });

  it("stops switching once one signature has failed on two routes", () => {
    const first = failoverDecision({
      ...base,
      evidence: { agent: "claude", text: "usage limit reached for your plan" },
    });
    const { action } = failoverDecision({
      ...base,
      history: [{ route: "claude:default", verdict: first.verdict }],
      current: { cli: "codex", profileId: "default" },
      evidence: { agent: "codex", text: "usage limit reached for your plan" },
      attemptsUsed: 2,
    });
    expect(action.kind).toBe("stop");
    expect(action.reason).toBe("signature-seen-on-two-routes");
    expect(action.narration).toMatch(/isn't the model/i);
  });

  it("retries an unclassified failure once, then stops rather than guessing", () => {
    const once = failoverDecision({ ...base, evidence: { text: "??? weird" } });
    expect(once.action.kind).toBe("retry-same");
    const twice = failoverDecision({
      ...base,
      history: [{ route: "claude:default", verdict: once.verdict }],
      evidence: { text: "??? weird again" },
      attemptsUsed: 2,
    });
    expect(twice.action.kind).toBe("stop");
    expect(twice.action.reason).toBe("unclassified-failure-repeated");
  });

  it("stops at the attempt cap even when a route is available", () => {
    const { action } = failoverDecision({
      ...base,
      evidence: { agent: "claude", text: "usage limit reached for your plan" },
      attemptsUsed: 3,
    });
    expect(action.kind).toBe("stop");
    expect(action.reason).toBe("attempt-cap-reached");
  });

  it("stops, and says so plainly, when no other route is ready", () => {
    const { action } = failoverDecision({
      ...base,
      candidates: [claude(), codex("unusable")],
      evidence: { agent: "claude", text: "usage limit reached for your plan" },
    });
    expect(action.kind).toBe("stop");
    expect(action.reason).toBe("no-alternate-route");
    expect(action.narration).toMatch(/no other agent ready/i);
  });
});

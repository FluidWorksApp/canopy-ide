import { describe, expect, it } from "vitest";
import { portableReseed, type TaskEnvelopeDetail } from "./taskEnvelope";

describe("portable task reseeds", () => {
  it("carry task truth without vendor session state", () => {
    const detail = {
      envelope: {
        runId: "run_1",
        schemaVersion: 1,
        projectId: "p1",
        componentId: "web",
        worktreePath: "/repo",
        kind: "vibe-turn",
        title: "Checkout",
        status: "ready",
        attemptCount: 1,
        goal: "Fix checkout",
        acceptance: ["payment succeeds"],
        taskClasses: { localized_repair: 1 },
        contextSummary: "Stripe sandbox",
        riskClass: "reversible",
        authorityPolicy: {},
        failoverPolicy: {},
        attemptCap: 3,
        baseBaselineId: "base_1",
        lastGreenBaselineId: "green_1",
        createdAt: 1,
        updatedAt: 2,
      },
      attempts: [
        {
          attemptId: "attempt_1",
          runId: "run_1",
          ordinal: 1,
          state: "failed",
          route: {
            cli: "claude",
            profileId: "default",
            harnessVersion: "1",
            promptVersion: "1",
            toolPolicyVersion: "1",
            executionMode: "structured",
          },
        },
      ],
    } satisfies TaskEnvelopeDetail;

    expect(portableReseed(detail)).toEqual({
      goal: "Fix checkout",
      acceptance: ["payment succeeds"],
      contextSummary: "Stripe sandbox",
      riskClass: "reversible",
      baseBaselineId: "base_1",
      lastGreenBaselineId: "green_1",
    });
    expect(portableReseed(detail)).not.toHaveProperty("attempts");
    expect(portableReseed(detail)).not.toHaveProperty("sessionId");
  });
});

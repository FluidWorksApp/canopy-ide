import { describe, expect, it } from "vitest";
import type { TaskEnvelopeDetail } from "./taskEnvelope";
import {
  builderCardForMcpTask,
  mcpInputRequestForCard,
  mcpTaskFromEvidence,
} from "./mcpTasks";

const detail = (status: TaskEnvelopeDetail["envelope"]["status"]): TaskEnvelopeDetail => ({
  envelope: {
    runId: "run-1",
    projectId: "project-1",
    componentId: "component-1",
    kind: "vibe-turn",
    title: "Installing dependencies",
    status,
    attemptCount: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_001_000,
    schemaVersion: 1,
    worktreePath: "/project",
    goal: "Make the app work",
    acceptance: [],
    taskClasses: {},
    contextSummary: "",
    riskClass: "reversible",
    authorityPolicy: {},
    failoverPolicy: {},
    attemptCap: 1,
  },
  attempts: [
    {
      attemptId: "attempt-1",
      runId: "run-1",
      ordinal: 1,
      state: status === "failed" ? "failed" : "running",
      route: {
        cli: "claude",
        profileId: "default",
        harnessVersion: "1",
        promptVersion: "1",
        toolPolicyVersion: "1",
        executionMode: "structured",
      },
      failureCode: status === "failed" ? "compile-failed" : null,
    },
  ],
});

describe("mcpTaskFromEvidence", () => {
  it("turns a BuilderCard decision into standard MRTR without execution details", () => {
    const requests = mcpInputRequestForCard({
      id: "publish",
      kind: "decision",
      reason: "destructive",
      title: "Publish this version?",
      detail: "This changes the live app.",
      actions: [
        { label: "Publish", response: "opaque:publish", tone: "danger" },
        { label: "Not now", response: "opaque:cancel" },
      ],
    });
    expect(requests?.publish).toMatchObject({
      method: "elicitation/create",
      params: {
        mode: "form",
        requestedSchema: {
          properties: {
            response: { enum: ["opaque:publish", "opaque:cancel"] },
          },
        },
      },
      _meta: { reason: "destructive" },
    });
    expect(JSON.stringify(requests)).not.toMatch(/command|diff|environment|output/i);
  });

  it("does not improve a retryable ready envelope into completed", () => {
    const task = mcpTaskFromEvidence(detail("ready"));
    expect(task.status).toBe("working");
    expect(task.resultType).toBe("complete");
  });

  it("accepts a structural supervisor-ready verdict as completion evidence", () => {
    const task = mcpTaskFromEvidence(detail("running"), {
      state: "ready",
      exit: "complete",
      deadlineAt: null,
      prompt: null,
    });
    expect(task.status).toBe("completed");
  });

  it("requires a recorded input request before claiming input_required", () => {
    const bare = mcpTaskFromEvidence(detail("blocked"));
    expect(bare.status).toBe("working");

    const recorded = detail("blocked");
    recorded.envelope.metadata = {
      mcpTask: {
        inputRequests: {
          account: {
            method: "elicitation/create",
            params: {
              mode: "form",
              message: "Choose the account to link",
              requestedSchema: { type: "object" },
            },
            _meta: {
              reason: "account-link",
              actions: [{ label: "Personal", response: "personal" }],
            },
          },
        },
      },
    };
    const task = mcpTaskFromEvidence(recorded);
    expect(task.status).toBe("input_required");
    expect(builderCardForMcpTask(task)).toMatchObject({
      kind: "decision",
      reason: "account-link",
      actions: [{ label: "Personal", response: "personal" }],
    });
  });

  it("keeps non-RPC build failures in-band and out of task failed", () => {
    const task = mcpTaskFromEvidence(detail("failed"));
    expect(task).toMatchObject({
      status: "completed",
      result: { isError: true },
    });
    expect(JSON.stringify(task)).not.toContain("output");
  });

  it("renders structural supervisor failures as in-band warning outcomes", () => {
    const task = mcpTaskFromEvidence(detail("running"), {
      state: "hung",
      exit: "repair",
      deadlineAt: 1_700_000_002_000,
      prompt: null,
    });
    expect(task).toMatchObject({
      status: "completed",
      result: { isError: true },
    });
    expect(builderCardForMcpTask(task)).toMatchObject({
      kind: "outcome",
      tone: "warning",
    });
  });
});

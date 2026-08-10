import { describe, expect, it, vi } from "vitest";
import type { TaskEnvelopeDetail, TaskAttemptState } from "./taskEnvelope";
import { waitForWorkflowAttempt } from "./workflowAttempt";

const detail = (state: TaskAttemptState): TaskEnvelopeDetail => ({
  envelope: {
    schemaVersion: 1,
    runId: "task-1",
    projectId: "project-1",
    componentId: "component-1",
    kind: "workflow-step",
    title: "Build",
    status: state === "completed" ? "completed" : "running",
    attemptCount: 1,
    createdAt: 1,
    updatedAt: 1,
    worktreePath: "/repo",
    goal: "Build it",
    acceptance: [],
    taskClasses: {},
    contextSummary: "",
    riskClass: "read-only",
    authorityPolicy: {},
    failoverPolicy: {},
    attemptCap: 1,
  },
  attempts: [{
    attemptId: "attempt-1",
    runId: "task-1",
    ordinal: 1,
    state,
    route: {
      cli: "codex",
      profileId: "default",
      harnessVersion: "workflow-p1",
      promptVersion: "workflow-p1",
      toolPolicyVersion: "workflow-p1",
      executionMode: "pty",
    },
  }],
});

describe("waitForWorkflowAttempt", () => {
  it("resolves an attempt that was already completed", async () => {
    const unsubscribe = vi.fn();
    await expect(waitForWorkflowAttempt("attempt-1", {
      read: vi.fn().mockResolvedValue(detail("completed")),
      subscribe: vi.fn(() => unsubscribe),
    })).resolves.toEqual({ ok: true, state: "completed", failureText: undefined });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("waits for a store pulse and reports a blocked attempt as failure", async () => {
    let state: TaskAttemptState = "running";
    let pulse = () => {};
    const waiting = waitForWorkflowAttempt("attempt-1", {
      read: vi.fn(async () => detail(state)),
      subscribe: (listener) => { pulse = listener; return vi.fn(); },
    });
    await Promise.resolve();
    state = "blocked";
    pulse();
    await expect(waiting).resolves.toMatchObject({ ok: false, state: "blocked" });
  });
});

import { describe, expect, it, vi } from "vitest";
import type { TaskEnvelopeDetail, TaskReservation } from "./taskEnvelope";
import type { WorkflowDefinition } from "./workflowDefinition";
import type {
  WorkflowRunAdvanceInput,
  WorkflowRunCreateInput,
  WorkflowRunDetail,
  WorkflowStepRecordInput,
} from "./workflowRun";
import {
  answerWorkflowHuman,
  continueWorkflow,
  startWorkflow,
  type WorkflowExecutorDeps,
} from "./workflowExecutor";

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  id: "three-step",
  version: "1",
  name: "Agent, gate, approval",
  triggers: [{ kind: "manual" }],
  constraints: { componentRoots: ["/repo"], branchPatterns: ["feat/*"] },
  start: "agent",
  steps: [
    {
      id: "agent",
      name: "Implement",
      kind: "agent",
      prompt: "Implement the change",
      capabilities: ["workspace-read", "workspace-write"],
    },
    {
      id: "gate",
      name: "Evidence",
      kind: "gate",
      capabilities: [],
      evidence: { stepId: "agent", predicate: "attempt.completed" },
    },
    {
      id: "approve",
      name: "Approve",
      kind: "human",
      capabilities: [],
      card: {
        reason: "choice",
        title: "Accept this workflow result?",
        actions: [
          { label: "Accept", response: "accept", tone: "primary" },
          { label: "Reject", response: "reject" },
        ],
      },
    },
  ],
  edges: [
    { from: "agent", on: "success", to: "gate" },
    { from: "agent", on: "failure", to: "$failed" },
    { from: "gate", on: "pass", to: "approve" },
    { from: "gate", on: "fail", to: "$failed" },
    { from: "approve", on: "accept", to: "$completed" },
    { from: "approve", on: "reject", to: "$failed" },
  ],
};

function harness() {
  let run: WorkflowRunDetail | null = null;
  const task: TaskEnvelopeDetail = {
    envelope: {
      runId: "task-run",
      projectId: "project",
      componentId: "component",
      kind: "workflow-step",
      status: "completed",
      attemptCount: 1,
      createdAt: 1,
      updatedAt: 2,
      schemaVersion: 1,
      worktreePath: "/repo",
      goal: "Implement",
      acceptance: [],
      taskClasses: {},
      contextSummary: "",
      riskClass: "reversible",
      authorityPolicy: {},
      failoverPolicy: {},
      attemptCap: 3,
    },
    attempts: [
      {
        attemptId: "attempt-1",
        runId: "task-run",
        ordinal: 1,
        state: "completed",
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
  };
  const reservation: TaskReservation = {
    envelope: task.envelope,
    attempt: task.attempts[0],
  };
  const reserveTask = vi.fn(async () => reservation);

  const deps: WorkflowExecutorDeps = {
    createRun: async (input: WorkflowRunCreateInput) => {
      run = {
        runId: "workflow-1",
        projectId: input.projectId,
        definitionId: input.definitionId,
        definitionVersion: input.definitionVersion,
        definitionHash: input.definitionHash,
        triggerKind: input.triggerKind,
        status: "running",
        currentStepId: input.startStepId,
        createdAt: 1,
        updatedAt: 1,
        definition: input.definition,
        trigger: input.trigger,
        steps: input.steps.map((step) => ({
          ...step,
          state: step.id === input.startStepId ? "running" : "pending",
          attemptIds: [],
          round: 0,
          updatedAt: 1,
        })),
        edges: [],
      };
      return run;
    },
    getRun: async () => run,
    recordStep: async (input: WorkflowStepRecordInput) => {
      if (!run) throw new Error("no run");
      run = {
        ...run,
        status: input.state === "waiting" ? "waiting" : "running",
        steps: run.steps.map((step) =>
          step.id === input.stepId
            ? {
                ...step,
                state: input.state,
                attemptIds: input.attemptId
                  ? [...step.attemptIds, input.attemptId]
                  : step.attemptIds,
              }
            : step,
        ),
      };
      return run;
    },
    advance: async (input: WorkflowRunAdvanceInput) => {
      if (!run) throw new Error("no run");
      const terminal = input.target.startsWith("$");
      run = {
        ...run,
        status: terminal
          ? (input.target.slice(1) as WorkflowRunDetail["status"])
          : "running",
        currentStepId: terminal ? null : input.target,
        steps: run.steps.map((step) => {
          if (step.id === input.stepId) return { ...step, state: input.stepState };
          if (step.id === input.target) return { ...step, state: "running", round: step.round + 1 };
          return step;
        }),
        edges: [
          ...run.edges,
          {
            seq: run.edges.length + 1,
            fromStepId: input.stepId,
            outcome: input.outcome,
            target: input.target,
            takenAt: 2,
          },
        ],
      };
      return run;
    },
    resume: vi.fn(async () => {
      if (!run) throw new Error("no run");
      run = { ...run, status: "running" };
      return run;
    }),
    reserveTask,
    reserveAttempt: vi.fn(),
    taskGetForAttempt: async () => task,
    routeFor: () => ({
      route: task.attempts[0].route,
      candidates: [],
      taskClass: "build",
      snapshotFor: () => task.attempts[0].route,
    }),
    launchAgent: vi.fn(async () => ({ ok: true })),
    runGitOp: vi.fn(async () => ({ ok: true })),
  };
  return { deps, reserveTask, current: () => run };
}

describe("workflow linear executor", () => {
  it("drives agent, evidence gate, and human card end to end", async () => {
    const { deps, reserveTask } = harness();
    const context = { projectId: "project", componentId: "component", worktreePath: "/repo" };
    const waiting = await startWorkflow(
      definition,
      { kind: "manual", eventId: "manual-1", occurredAt: 1, payload: { requestedBy: "user" } },
      context,
      deps,
    );
    expect(waiting).toMatchObject({
      state: "waiting-human",
      card: { kind: "decision", title: "Accept this workflow result?" },
      run: { currentStepId: "approve", status: "waiting" },
    });
    expect(reserveTask).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          workflow: expect.objectContaining({
            stepId: "agent",
            capabilities: ["workspace-read", "workspace-write"],
          }),
        },
        authorityPolicy: expect.objectContaining({
          capabilities: ["workspace-read", "workspace-write"],
        }),
      }),
    );

    const settled = await answerWorkflowHuman(
      "workflow-1",
      "accept",
      context,
      deps,
    );
    expect(settled).toMatchObject({ state: "settled", run: { status: "completed" } });
  });

  it("surfaces a restart-interrupted run without launching a duplicate agent", async () => {
    const { deps, current } = harness();
    const context = { projectId: "project", componentId: "component", worktreePath: "/repo" };
    await deps.createRun({
      projectId: context.projectId,
      definitionId: definition.id,
      definitionVersion: definition.version,
      definitionHash: "hash",
      definition,
      triggerKind: "manual",
      trigger: { kind: "manual", eventId: "manual-1", occurredAt: 1, payload: {} },
      startStepId: definition.start,
      steps: definition.steps.map((step) => ({ id: step.id, kind: step.kind })),
    });
    const run = current();
    if (!run) throw new Error("test run was not created");
    run.status = "interrupted";

    await expect(continueWorkflow(run.runId, context, deps)).resolves.toMatchObject({
      state: "interrupted",
      run: { status: "interrupted", currentStepId: "agent" },
    });
    expect(deps.launchAgent).not.toHaveBeenCalled();
    expect(deps.resume).not.toHaveBeenCalled();
  });
});

it("reconciles a completed attempt after interruption without launching it again", async () => {
  const { deps } = harness();
  const context = { projectId: "project", componentId: "component", worktreePath: "/repo" };
  const run = await deps.createRun({ projectId: "project", definitionId: definition.id, definitionVersion: "1", definitionHash: "hash", definition, triggerKind: "manual", trigger: { kind: "manual", eventId: "manual-1", occurredAt: 1, payload: {} }, startStepId: "agent", steps: definition.steps.map((step) => ({ id: step.id, kind: step.kind })) });
  await deps.recordStep({ runId: run.runId, stepId: "agent", state: "running", attemptId: "attempt-1" });
  expect((await continueWorkflow(run.runId, context, deps)).state).toBe("waiting-human");
  expect(deps.reserveTask).not.toHaveBeenCalled();
  expect(deps.launchAgent).not.toHaveBeenCalled();
});

it("refuses a duplicate attempt while the existing attempt is still running", async () => {
  const { deps } = harness();
  const evidence = (await deps.taskGetForAttempt("attempt-1"))!;
  evidence.attempts[0].state = "running";
  const run = await deps.createRun({ projectId: "project", definitionId: definition.id, definitionVersion: "1", definitionHash: "hash", definition, triggerKind: "manual", trigger: { kind: "manual", eventId: "manual-1", occurredAt: 1, payload: {} }, startStepId: "agent", steps: definition.steps.map((step) => ({ id: step.id, kind: step.kind })) });
  await deps.recordStep({ runId: run.runId, stepId: "agent", state: "running", attemptId: "attempt-1" });
  await expect(continueWorkflow(run.runId, { projectId: "project", componentId: "component", worktreePath: "/repo" }, deps)).rejects.toThrow(/Reconcile/);
  expect(deps.launchAgent).not.toHaveBeenCalled();
});

it("delivers only later events for the waiting issue", async () => {
  const { deliverWorkflowEvent } = await import("./workflowExecutor");
  const { deps } = harness();
  const watched: WorkflowDefinition = { ...definition, start: "watch", steps: [{ id: "watch", name: "Wait", kind: "watch", event: "issue.closed", capabilities: [] }], edges: [{ from: "watch", on: "pass", to: "$completed" }, { from: "watch", on: "fail", to: "$failed" }] };
  const trigger = { kind: "issue.opened" as const, eventId: "open-1", occurredAt: 1, payload: { source: "github", repo: "owner/repo", issueId: "#1" } };
  const run = await deps.createRun({ projectId: "project", definitionId: watched.id, definitionVersion: "1", definitionHash: "hash", definition: watched, triggerKind: trigger.kind, trigger, startStepId: "watch", steps: [{ id: "watch", kind: "watch" }] });
  const context = { projectId: "project", componentId: "component", worktreePath: "/repo" };
  expect((await continueWorkflow(run.runId, context, deps)).state).toBe("waiting-event");
  const event = { ...trigger, kind: "issue.closed" as const, eventId: "closed-1", occurredAt: 10 };
  expect(await deliverWorkflowEvent(run.runId, { ...event, payload: { ...event.payload, issueId: "#2" } }, context, deps)).toBeNull();
  expect((await deliverWorkflowEvent(run.runId, event, context, deps))?.state).toBe("settled");
  expect(await deliverWorkflowEvent(run.runId, event, context, deps)).toBeNull();
});

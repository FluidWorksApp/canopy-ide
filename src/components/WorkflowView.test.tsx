// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowView } from "./WorkflowView";
import type { WorkflowDefinition } from "../workflowDefinition";

const mocks = vi.hoisted(() => ({
  loadWorkflowDefinitions: vi.fn(),
  refreshWorkflowRuns: vi.fn(),
  workflowGet: vi.fn(),
}));

vi.mock("../workflowDefinition", async (load) => ({
  ...await load<typeof import("../workflowDefinition")>(),
  loadWorkflowDefinitions: mocks.loadWorkflowDefinitions,
}));

vi.mock("../workflowRuns", async (load) => ({
  ...await load<typeof import("../workflowRuns")>(),
  cachedWorkflowRuns: () => [],
  refreshWorkflowRuns: mocks.refreshWorkflowRuns,
  workflowGet: mocks.workflowGet,
}));

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  id: "review-change",
  version: "1",
  name: "Review the change",
  triggers: [{ kind: "manual" }],
  constraints: { componentRoots: ["/repo"], branchPatterns: ["*"] },
  start: "inspect",
  steps: [
    {
      id: "inspect",
      name: "Inspect",
      kind: "agent",
      capabilities: ["workspace-read"],
      prompt: "Review the current change.",
    },
    {
      id: "approve",
      name: "Approve",
      kind: "human",
      capabilities: [],
      card: {
        reason: "choice",
        title: "Accept this review?",
        actions: [
          { label: "Approve", response: "approve", tone: "primary" },
          { label: "Reject", response: "reject", tone: "danger" },
        ],
      },
    },
  ],
  edges: [
    { from: "inspect", on: "success", to: "approve" },
    { from: "inspect", on: "failure", to: "$failed" },
    { from: "approve", on: "approve", to: "$completed" },
    { from: "approve", on: "reject", to: "$failed" },
  ],
};

const summary = {
  runId: "workflow-1",
  projectId: "project-1",
  definitionId: definition.id,
  definitionVersion: definition.version,
  definitionHash: "hash",
  triggerKind: "manual",
  status: "waiting" as const,
  currentStepId: "approve",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

describe("WorkflowView", () => {
  beforeEach(() => {
    mocks.loadWorkflowDefinitions.mockReset().mockResolvedValue({ ok: true, definitions: [definition] });
    mocks.refreshWorkflowRuns.mockReset().mockResolvedValue([summary]);
    mocks.workflowGet.mockReset().mockResolvedValue({
      ...summary,
      definition,
      trigger: { kind: "manual", eventId: "manual-1", occurredAt: 1, payload: {} },
      steps: [
        { id: "inspect", kind: "agent", state: "completed", attemptIds: ["attempt-1"], round: 1, updatedAt: 1 },
        { id: "approve", kind: "human", state: "waiting", attemptIds: [], round: 1, updatedAt: 2 },
      ],
      edges: [{ seq: 1, fromStepId: "inspect", outcome: "success", target: "approve", takenAt: 2 }],
    });
  });

  it("keeps definitions, live steps, and decisions in the workflow surface", async () => {
    const onRun = vi.fn();
    const onAnswer = vi.fn();
    render(
      <WorkflowView
        projectId="project-1"
        projectName="Canopy"
        projectRoot="/repo"
        componentRoots={["/repo"]}
        onRun={onRun}
        onAnswer={onAnswer}
        onResume={vi.fn()}
        onCreateStarter={vi.fn()}
      />,
    );

    expect(await screen.findAllByText("Review the change")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(onRun).toHaveBeenCalledWith(definition);

    expect(await screen.findByText("Accept this review?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onAnswer).toHaveBeenCalledWith("workflow-1", "approve");
    expect(screen.queryByText("Completed tasks")).toBeNull();
  });

  it("turns the empty catalog into a starter workflow without leaving the page", async () => {
    mocks.loadWorkflowDefinitions
      .mockReset()
      .mockResolvedValueOnce({ ok: true, definitions: [] })
      .mockResolvedValue({ ok: true, definitions: [definition] });
    mocks.refreshWorkflowRuns.mockResolvedValue([]);
    const onCreateStarter = vi.fn().mockResolvedValue(undefined);
    render(
      <WorkflowView
        projectId="project-1"
        projectName="Canopy"
        projectRoot="/repo"
        componentRoots={["/repo"]}
        onRun={vi.fn()}
        onAnswer={vi.fn()}
        onResume={vi.fn()}
        onCreateStarter={onCreateStarter}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Create a starter workflow" }));
    expect(onCreateStarter).toHaveBeenCalledOnce();
    expect(await screen.findByRole("button", { name: "Run" })).toBeInTheDocument();
  });
});

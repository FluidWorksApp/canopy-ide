// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowRunsFold } from "./WorkflowRunsFold";
import { WORKFLOW_RUNS_EVENT } from "../workflowRuns";

const { refreshWorkflowRuns, workflowGet } = vi.hoisted(() => ({
  refreshWorkflowRuns: vi.fn(),
  workflowGet: vi.fn(),
}));

vi.mock("../workflowRuns", async (load) => {
  const actual = await load<typeof import("../workflowRuns")>();
  return {
    ...actual,
    cachedWorkflowRuns: () => [],
    refreshWorkflowRuns,
    workflowGet,
  };
});

const summary = {
  runId: "workflow-1",
  projectId: "project-1",
  definitionId: "review",
  definitionVersion: "1",
  definitionHash: "hash",
  triggerKind: "manual",
  status: "waiting" as const,
  currentStepId: "approve",
  createdAt: 1,
  updatedAt: 2,
};

describe("WorkflowRunsFold", () => {
  beforeEach(() => {
    refreshWorkflowRuns.mockReset().mockResolvedValue([summary]);
    workflowGet.mockReset().mockResolvedValue({
      ...summary,
      definition: {},
      trigger: { kind: "manual", eventId: "manual-1", occurredAt: 1, payload: {} },
      steps: [
        { id: "agent", kind: "agent", state: "completed", attemptIds: ["attempt-1"], round: 1, updatedAt: 2 },
        { id: "approve", kind: "human", state: "waiting", attemptIds: [], round: 1, updatedAt: 2 },
      ],
      edges: [],
    });
  });

  it("subscribes to workflow pulses and lazily reads one run's step projection", async () => {
    render(<WorkflowRunsFold projectId="project-1" />);
    expect(await screen.findByText("review")).toBeInTheDocument();
    fireEvent.click(screen.getByText("review"));
    expect(await screen.findByText("agent")).toBeInTheDocument();
    expect(screen.getByText("1 attempt recorded")).toBeInTheDocument();
    expect(workflowGet).toHaveBeenCalledWith("workflow-1");

    window.dispatchEvent(
      new CustomEvent(WORKFLOW_RUNS_EVENT, {
        detail: { projectId: "project-1", runId: "workflow-1" },
      }),
    );
    await waitFor(() => expect(refreshWorkflowRuns).toHaveBeenCalledTimes(2));
  });
});

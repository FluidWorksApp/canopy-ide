import type { WorkflowDefinition, WorkflowTriggerProvenance } from "./workflowDefinition";

export type WorkflowRunStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type WorkflowStepRunState =
  | "pending"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "interrupted";

export interface WorkflowRunSummary {
  runId: string;
  projectId: string;
  definitionId: string;
  definitionVersion: string;
  definitionHash: string;
  triggerKind: string;
  status: WorkflowRunStatus;
  currentStepId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowStepState {
  id: string;
  kind: string;
  state: WorkflowStepRunState;
  attemptIds: string[];
  round: number;
  updatedAt: number;
}

export interface WorkflowEdgeTaken {
  seq: number;
  fromStepId: string;
  outcome: string;
  target: string;
  takenAt: number;
}

export interface WorkflowRunDetail extends WorkflowRunSummary {
  definition: WorkflowDefinition;
  trigger: WorkflowTriggerProvenance;
  steps: WorkflowStepState[];
  edges: WorkflowEdgeTaken[];
}

export interface WorkflowRunCreateInput {
  projectId: string;
  definitionId: string;
  definitionVersion: string;
  definitionHash: string;
  definition: WorkflowDefinition;
  triggerKind: string;
  trigger: WorkflowTriggerProvenance;
  startStepId: string;
  steps: Array<{ id: string; kind: string }>;
}

export interface WorkflowStepRecordInput {
  runId: string;
  stepId: string;
  state: Extract<WorkflowStepRunState, "running" | "waiting">;
  attemptId?: string | null;
}

export interface WorkflowRunAdvanceInput {
  runId: string;
  stepId: string;
  stepState: Extract<WorkflowStepRunState, "completed" | "failed">;
  outcome: string;
  target: string;
}

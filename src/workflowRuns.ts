// Frontend projection of Rust-owned WorkflowRun state. Execution decisions use
// workflow_run_get directly; this cache exists only for an instant read surface.
import * as ipc from "./ipc";
import type {
  WorkflowRunAdvanceInput,
  WorkflowRunCreateInput,
  WorkflowRunDetail,
  WorkflowRunSummary,
  WorkflowStepRecordInput,
} from "./workflowRun";

export const WORKFLOW_RUNS_EVENT = "canopy:workflow-runs-changed";

const cache = new Map<string, WorkflowRunSummary[]>();

const announce = (projectId: string, runId = "") =>
  window.dispatchEvent(
    new CustomEvent(WORKFLOW_RUNS_EVENT, { detail: { projectId, runId } }),
  );

export const cachedWorkflowRuns = (projectId: string): WorkflowRunSummary[] =>
  cache.get(projectId) ?? [];

export async function refreshWorkflowRuns(
  projectId: string,
  changedRunId = "",
): Promise<WorkflowRunSummary[]> {
  const rows = await ipc.workflowRunList(projectId).catch(() => []);
  cache.set(projectId, rows);
  announce(projectId, changedRunId);
  return rows;
}

export function workflowStoreChanged(change: ipc.StoreChange): void {
  if (cache.has(change.scope)) void refreshWorkflowRuns(change.scope, change.id);
  else announce(change.scope, change.id);
}

export const workflowGet = (runId: string): Promise<WorkflowRunDetail | null> =>
  ipc.workflowRunGet(runId);

export const createWorkflowRun = (input: WorkflowRunCreateInput) =>
  ipc.workflowRunCreate(input);

export const recordWorkflowStep = (input: WorkflowStepRecordInput) =>
  ipc.workflowStepRecord(input);

export const advanceWorkflowRun = (input: WorkflowRunAdvanceInput) =>
  ipc.workflowRunAdvance(input);

export const resumeWorkflowRun = (runId: string) => ipc.workflowRunResume(runId);

export function forgetWorkflowRuns(projectId: string): void {
  cache.delete(projectId);
  announce(projectId);
}

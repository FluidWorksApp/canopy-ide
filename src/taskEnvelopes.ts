// Frontend projection of the Rust TaskEnvelope authority. No routing or
// settlement decision may consult this cache; it exists only for instant UI.
import * as ipc from "./ipc";
import type {
  TaskAttemptReserveInput,
  TaskAttemptSettlement,
  TaskEnvelopeDetail,
  TaskEnvelopeSummary,
  TaskEventInput,
  TaskReservation,
  TaskReserveInput,
} from "./taskEnvelope";

export const TASK_ENVELOPES_EVENT = "canopy:task-envelopes-changed";

const cache = new Map<string, TaskEnvelopeSummary[]>();

const announce = (projectId: string, runId = "") =>
  window.dispatchEvent(
    new CustomEvent(TASK_ENVELOPES_EVENT, { detail: { projectId, runId } }),
  );

export const cachedTaskEnvelopes = (projectId: string): TaskEnvelopeSummary[] =>
  cache.get(projectId) ?? [];

export async function refreshTaskEnvelopes(
  projectId: string,
  changedRunId = "",
): Promise<TaskEnvelopeSummary[]> {
  const rows = await ipc.taskList(projectId).catch(() => []);
  cache.set(projectId, rows);
  announce(projectId, changedRunId);
  return rows;
}

/** Called by the central store router. Exported rather than registering here so
 * stores.ts can install every handler without a circular module dependency. */
export function taskStoreChanged(e: ipc.StoreChange): void {
  if (!cache.has(e.scope)) return;
  void refreshTaskEnvelopes(e.scope, e.id);
}

export const taskGet = (runId: string): Promise<TaskEnvelopeDetail | null> =>
  ipc.taskGet(runId);

export async function reserveTask(
  input: TaskReserveInput,
): Promise<TaskReservation> {
  const reservation = await ipc.taskReserve(input);
  await refreshTaskEnvelopes(input.projectId, reservation.envelope.runId);
  return reservation;
}

export const reserveAttempt = (input: TaskAttemptReserveInput) =>
  ipc.taskAttemptReserve(input);

export const startAttempt = (attemptId: string) =>
  ipc.taskAttemptStart(attemptId);

export const settleAttempt = (input: TaskAttemptSettlement) =>
  ipc.taskAttemptSettle(input);

export const appendTaskEvent = (input: TaskEventInput) =>
  ipc.taskEventAppend(input);

export const taskEvents = (runId: string, limit = 200) =>
  ipc.taskEventList(runId, limit);

export const writeTaskArtifact = (args: {
  runId: string;
  attemptId?: string | null;
  kind: string;
  content: string;
}) => ipc.taskArtifactWrite(args);

export function forgetTaskEnvelopes(projectId: string): void {
  cache.delete(projectId);
  announce(projectId);
}

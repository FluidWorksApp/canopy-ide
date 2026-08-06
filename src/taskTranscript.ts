import * as ipc from "./ipc";

export type TaskTranscriptKind =
  | "user"
  | "assistant"
  | "activity"
  | "question"
  | "error"
  | "route-switch"
  | "system";

export interface TaskTranscriptEntry {
  seq: number;
  runId: string;
  attemptId?: string | null;
  kind: TaskTranscriptKind;
  body: string;
  createdAt: number;
}

export const listTranscript = (runId: string, limit = 200) =>
  ipc.taskTranscriptList(runId, limit);

export const appendTranscript = (args: {
  runId: string;
  attemptId?: string | null;
  kind: TaskTranscriptKind;
  body: string;
}) => ipc.taskTranscriptAppend(args);

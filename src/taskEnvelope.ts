/** Durable task execution vocabulary. Rust owns the records; these types are
 * the frontend projection and intentionally contain no PTY or UI state. */

export type TaskEnvelopeStatus =
  "running" | "ready" | "blocked" | "completed" | "failed" | "cancelled";

export type TaskAttemptState =
  | "reserved"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "interrupted"
  | "cancelled";

export interface TaskRouteSnapshot {
  cli: string;
  cliVersion?: string | null;
  executableFingerprint?: string | null;
  profileId: string;
  requestedModel?: string | null;
  observedModel?: string | null;
  harnessVersion: string;
  promptVersion: string;
  toolPolicyVersion: string;
  executionMode: "structured" | "oneshot" | "pty";
  /** The complete eligible/excluded snapshot used by the selecting policy. */
  selection?: unknown;
}

export interface TaskEnvelopeSummary {
  runId: string;
  projectId: string;
  componentId: string;
  kind: string;
  title?: string | null;
  status: TaskEnvelopeStatus;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface TaskAttempt {
  attemptId: string;
  runId: string;
  ordinal: number;
  state: TaskAttemptState;
  route: TaskRouteSnapshot;
  startedAt?: number | null;
  endedAt?: number | null;
  failureClass?: string | null;
  failureCode?: string | null;
  recoveryFromAttemptId?: string | null;
}

export interface TaskEnvelope extends TaskEnvelopeSummary {
  schemaVersion: number;
  worktreePath: string;
  goal: string;
  acceptance: string[];
  taskClasses: unknown;
  contextSummary: string;
  riskClass: string;
  authorityPolicy: unknown;
  failoverPolicy: unknown;
  deadlineAt?: number | null;
  attemptCap: number;
  baseBaselineId?: string | null;
  lastGreenBaselineId?: string | null;
}

export interface TaskEnvelopeDetail {
  envelope: TaskEnvelope;
  attempts: TaskAttempt[];
}

export interface TaskReservation {
  envelope: TaskEnvelopeSummary;
  attempt: TaskAttempt;
}

export interface TaskReserveInput {
  kind: string;
  projectId: string;
  componentId: string;
  worktreePath: string;
  goal: string;
  acceptance?: string[];
  taskClasses?: unknown;
  contextSummary?: string;
  riskClass?: string;
  authorityPolicy?: unknown;
  failoverPolicy?: unknown;
  deadlineAt?: number | null;
  attemptCap?: number;
  title?: string | null;
  route: TaskRouteSnapshot;
}

export interface TaskAttemptReserveInput {
  runId: string;
  route: TaskRouteSnapshot;
  recoveryFromAttemptId?: string | null;
}

export interface TaskAttemptSettlement {
  attemptId: string;
  state: Extract<
    TaskAttemptState,
    "completed" | "failed" | "blocked" | "interrupted" | "cancelled"
  >;
  failureClass?: string | null;
  failureCode?: string | null;
}

/** Privacy-safe durable event. Watchdog incidents and failure verdicts persist
 * through this shape; raw output and tool payloads belong in capped artifacts. */
export interface TaskEventInput {
  runId: string;
  attemptId?: string | null;
  kind: string;
  code?: string | null;
  source: string;
  confidence?: string | null;
  metadata?: unknown;
  occurredAt?: number | null;
}

export interface TaskEvent extends TaskEventInput {
  eventId: string;
  occurredAt: number;
}

/** The only state portable across a route switch. Vendor transcript/session
 * data is deliberately absent. */
export function portableReseed(detail: TaskEnvelopeDetail): {
  goal: string;
  acceptance: string[];
  contextSummary: string;
  riskClass: string;
  baseBaselineId?: string | null;
  lastGreenBaselineId?: string | null;
} {
  const { envelope } = detail;
  return {
    goal: envelope.goal,
    acceptance: [...envelope.acceptance],
    contextSummary: envelope.contextSummary,
    riskClass: envelope.riskClass,
    baseBaselineId: envelope.baseBaselineId,
    lastGreenBaselineId: envelope.lastGreenBaselineId,
  };
}

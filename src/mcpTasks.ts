import type { TaskEnvelopeDetail } from "./taskEnvelope";
import type { BuilderManagedProcessState } from "./vibeBuilderCards";
import type {
  BuilderCard,
  BuilderProgressStage,
} from "./vibeBuilderSessionTypes";

export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

export type McpTaskStatus =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export interface McpTaskInputRequest {
  method: "elicitation/create";
  params: {
    mode: "form";
    message: string;
    requestedSchema: Record<string, unknown>;
  };
  /** Canopy-only presentation data. Responses remain opaque values. */
  _meta?: {
    title?: string;
    detail?: string;
    reason?: "credentials" | "account-link" | "destructive" | "payment" | "choice";
    actions?: readonly { label: string; response: string; tone?: "primary" | "neutral" | "danger" }[];
  };
}

export interface McpTask {
  resultType: "task" | "complete" | "input_required";
  taskId: string;
  status: McpTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  inputRequests?: Record<string, McpTaskInputRequest>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type McpTaskSupervisorEvidence = BuilderManagedProcessState;
export type McpTaskDecisionCard = Extract<BuilderCard, { kind: "decision" }>;

/** The #516 BuilderCard-compatible MRTR boundary. Only human-facing copy and
 * opaque action values survive; command, diff, logs and environment have no
 * representation in either this input or its output. */
export function mcpInputRequestForCard(
  card: McpTaskDecisionCard,
): Record<string, McpTaskInputRequest> | null {
  const actions = card.actions?.filter(
    (action) => action.label.trim() && action.response.trim(),
  );
  if (!actions?.length) return null;
  return {
    [card.id]: {
      method: "elicitation/create",
      params: {
        mode: "form",
        message: card.title,
        requestedSchema: {
          type: "object",
          properties: {
            response: {
              type: "string",
              enum: actions.map((action) => action.response),
            },
          },
          required: ["response"],
          additionalProperties: false,
        },
      },
      _meta: {
        title: card.title,
        ...(card.detail ? { detail: card.detail } : {}),
        reason: card.reason,
        actions,
      },
    },
  };
}

export type McpTaskCard = BuilderCard;

type McpTaskProgressStage = BuilderProgressStage;

interface TaskPresentationMetadata {
  stage?: McpTaskProgressStage;
  statusMessage?: string;
  inputRequests?: Record<string, McpTaskInputRequest>;
  rpcError?: { code: number; message: string; data?: unknown };
}

const metadataFor = (detail: TaskEnvelopeDetail): TaskPresentationMetadata => {
  const metadata = detail.envelope.metadata;
  if (!metadata || typeof metadata !== "object") return {};
  const task = (metadata as Record<string, unknown>).mcpTask;
  return task && typeof task === "object" ? (task as TaskPresentationMetadata) : {};
};

const iso = (millis: number): string => new Date(millis).toISOString();

/**
 * Project durable evidence onto MCP Tasks. A model's narration is never an
 * input: only TaskEnvelope/attempt settlement, a structural supervisor verdict,
 * and a recorded human input request may change status.
 */
export function mcpTaskFromEvidence(
  detail: TaskEnvelopeDetail,
  supervisor?: McpTaskSupervisorEvidence | null,
): McpTask {
  const { envelope } = detail;
  const presentation = metadataFor(detail);
  const inputRequests = presentation.inputRequests;
  const hasInput = Boolean(inputRequests && Object.keys(inputRequests).length > 0);

  let status: McpTaskStatus = "working";
  const rpcError = presentation.rpcError ?? null;
  const supervisorFailure = supervisor?.state === "failed" || supervisor?.state === "hung";
  if (envelope.status === "completed") status = "completed";
  else if (envelope.status === "failed") status = rpcError ? "failed" : "completed";
  else if (envelope.status === "cancelled") status = "cancelled";
  else if (envelope.status === "blocked" && hasInput) status = "input_required";
  else if (supervisor?.state === "ready" || supervisor?.state === "exited-ok") {
    status = "completed";
  } else if (supervisorFailure) {
    status = "completed";
  } else if (supervisor?.state === "waiting-on-input" && hasInput) {
    status = "input_required";
  }

  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  return {
    // `resultType: task` is only the original method's CreateTaskResult.
    // Detailed task reads always use the ordinary-result discriminator.
    resultType: "complete",
    taskId: envelope.runId,
    status,
    statusMessage: presentation.statusMessage ?? envelope.title ?? envelope.goal,
    createdAt: iso(envelope.createdAt),
    lastUpdatedAt: iso(envelope.updatedAt),
    ttlMs: null,
    ...(terminal ? {} : { pollIntervalMs: 750 }),
    ...(status === "input_required" && inputRequests ? { inputRequests } : {}),
    ...(status === "failed" && rpcError
      ? {
          error: rpcError,
        }
      : status === "completed" && (envelope.status === "failed" || supervisorFailure)
        ? {
            result: {
              content: [{ type: "text", text: "The recorded task attempt did not complete." }],
              isError: true,
            },
          }
        : {}),
  };
}

export function builderCardForMcpTask(task: McpTask): McpTaskCard {
  if (task.status === "input_required") {
    const [id, request] = Object.entries(task.inputRequests ?? {})[0] ?? [];
    return {
      id: id ?? `mcp-task:${task.taskId}`,
      kind: "decision",
      reason: request?._meta?.reason ?? "choice",
      title:
        request?._meta?.title ??
        request?.params.message ??
        "I need your help with one thing",
      detail: request?._meta?.detail ?? task.statusMessage,
      actions: request?._meta?.actions,
    };
  }
  if (task.status === "completed") {
    const inBandError = Boolean(
      task.result &&
        typeof task.result === "object" &&
        (task.result as Record<string, unknown>).isError,
    );
    return {
      id: `mcp-task:${task.taskId}`,
      kind: "outcome",
      tone: inBandError ? "warning" : "success",
      title: task.statusMessage ?? "Done",
    };
  }
  if (task.status === "failed" || task.status === "cancelled") {
    return {
      id: `mcp-task:${task.taskId}`,
      kind: "outcome",
      tone: task.status === "failed" ? "warning" : "neutral",
      title: task.statusMessage ?? (task.status === "failed" ? "That didn't finish" : "Stopped"),
    };
  }
  return {
    id: `mcp-task:${task.taskId}`,
    kind: "progress",
    stage: "starting",
    title: task.statusMessage ?? "Starting the preview",
  };
}

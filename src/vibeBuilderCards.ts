import { isOutstanding, targetOf, type AttentionItem } from "./attention";
import type {
  BuilderCard,
  BuilderCardAction,
  BuilderProgressStage,
  BuilderQuestion,
} from "./vibeBuilderSessionTypes";

/** Structural on purpose: managedProcessSupervisor owns the classifier and
 * can feed this boundary without turning terminal evidence into UI state. */
export interface BuilderManagedProcessState {
  state:
    | "spawning"
    | "working"
    | "waiting-on-input"
    | "ready"
    | "exited-ok"
    | "failed"
    | "hung";
  exit: "observe" | "auto-answer" | "complete" | "repair";
  deadlineAt: number | null;
  prompt: { kind: "safe-confirmation" | "interactive" } | null;
}

export interface BuilderManagedProcessContext {
  id: string;
  phase: Extract<BuilderProgressStage, "installing" | "compiling" | "starting">;
  subject?: string;
}

const progressCopy = (
  phase: BuilderManagedProcessContext["phase"],
): Pick<BuilderCard, "title" | "detail"> => {
  switch (phase) {
    case "installing":
      return {
        title: "Installing dependencies",
        detail: "The first setup can take a little while.",
      };
    case "compiling":
      return {
        title: "Compiling — first run takes a few minutes",
        detail: "I’ll open the preview as soon as it’s ready.",
      };
    case "starting":
      return {
        title: "Starting the preview",
        detail: "I’m waiting for the app to say it’s ready.",
      };
  }
};

/** Turn a real managed-process classification into human narration. No raw
 * output crosses this boundary, and no progress percentage is fabricated. */
export function builderCardForManagedProcess(
  process: BuilderManagedProcessState,
  context: BuilderManagedProcessContext,
): BuilderCard {
  if (process.state === "ready" || process.state === "exited-ok") {
    return {
      id: context.id,
      kind: "outcome",
      tone: "success",
      title:
        process.state === "ready"
          ? `${context.subject ?? "Preview"} is ready`
          : "Setup complete",
    };
  }

  if (process.state === "failed" || process.state === "hung") {
    return {
      id: context.id,
      kind: "progress",
      stage: "repairing",
      title: "I’m repairing the preview",
      detail: "I found a startup problem and I’m working through it.",
    };
  }

  if (process.state === "waiting-on-input") {
    return process.exit === "auto-answer"
      ? {
          id: context.id,
          kind: "progress",
          stage: context.phase,
          title: "Continuing setup",
          detail: "I handled a routine setup confirmation.",
          deadlineAt: process.deadlineAt,
        }
      : {
          id: context.id,
          kind: "progress",
          stage: "repairing",
          title: "Checking what the project needs",
          detail: "I won’t guess an account, credential, or destructive answer.",
        };
  }

  return {
    id: context.id,
    kind: "progress",
    stage: context.phase,
    ...progressCopy(context.phase),
    deadlineAt: process.deadlineAt,
  };
}

export interface BuilderRepairVerdict {
  diagnosis: string;
  actions: readonly { did: string }[];
  fixed: boolean;
  blocker?: string;
}

export interface BuilderRepairDecision {
  reason: "credentials" | "account-link" | "destructive" | "payment";
  actions: readonly BuilderCardAction[];
}

/** A repair agent's structured verdict becomes a result, or the one remaining
 * human-only decision. Evidence and tool output remain behind the session. */
export function builderCardForRepairVerdict(
  id: string,
  verdict: BuilderRepairVerdict,
  needsUser?: BuilderRepairDecision,
): BuilderCard {
  const detail = [
    verdict.diagnosis,
    ...verdict.actions.map((action) => action.did),
    verdict.blocker,
  ]
    .filter(Boolean)
    .join(" ");
  if (!verdict.fixed && needsUser) {
    return {
      id,
      kind: "decision",
      reason: needsUser.reason,
      title: "I need your help with one thing",
      detail,
      actions: needsUser.actions,
    };
  }
  return {
    id,
    kind: "outcome",
    tone: verdict.fixed ? "success" : "warning",
    title: verdict.fixed ? "Found it and fixed it" : "I found what’s blocking the fix",
    detail,
  };
}

/** Compatibility for sessions still publishing BuilderQuestion. Technical
 * `diff` is intentionally not copied: Build approves the described outcome,
 * while Engineer retains exact commands and diffs. */
export function builderCardFromQuestion(question: BuilderQuestion): BuilderCard {
  if (question.kind === "notice") {
    return {
      id: question.id,
      kind: "progress",
      stage: "repairing",
      title: question.prompt,
      detail: question.detail,
    };
  }
  return {
    id: question.id,
    kind: "decision",
    reason: "choice",
    title: question.prompt,
    detail: question.detail,
    actions: question.actions,
  };
}

/** Attention remains the app-wide source of outstanding asks. The pane may
 * render the latest project ask as a decision card; clicking it follows the
 * existing deep link instead of pretending a chat reply answered it. */
export function builderCardFromAttention(item: AttentionItem): BuilderCard | null {
  if (!isOutstanding(item) || !targetOf(item)) return null;
  return {
    id: `attention:${item.id}`,
    kind: "decision",
    reason: "choice",
    title: item.title,
    detail: item.body,
    actions: [{ label: "Open request", response: item.id, tone: "primary" }],
  };
}

import type { BuilderCard } from "./vibeBuilderSessionTypes";
import type { TaskEnvelopeDetail, TaskReservation, TaskRouteSnapshot } from "./taskEnvelope";
import {
  failoverDecision,
  type AttemptOutcomeRecord,
  type RouteCandidate,
  type SelectedRoute,
} from "./vibeFailover";
import type { TaskClass } from "./modelRouting";
import {
  reserveAttempt,
  reserveTask,
  taskGetForAttempt,
} from "./taskEnvelopes";
import {
  advanceWorkflowRun,
  createWorkflowRun,
  recordWorkflowStep,
  resumeWorkflowRun,
  workflowGet,
} from "./workflowRuns";
import {
  workflowAcceptsTrigger,
  workflowDefinitionHash,
  type WorkflowAgentStep,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowGateStep,
  type WorkflowGitOpStep,
  type WorkflowHumanStep,
  type WorkflowStep,
  type WorkflowTriggerProvenance,
} from "./workflowDefinition";
import type {
  WorkflowRunAdvanceInput,
  WorkflowRunCreateInput,
  WorkflowRunDetail,
  WorkflowStepRecordInput,
} from "./workflowRun";

export interface WorkflowExecutionContext {
  projectId: string;
  componentId: string;
  worktreePath: string;
}

export interface WorkflowRoutePlan {
  route: TaskRouteSnapshot;
  candidates: RouteCandidate[];
  taskClass: TaskClass;
  snapshotFor(route: SelectedRoute): TaskRouteSnapshot;
}

export interface WorkflowAgentLaunch {
  workflowRunId: string;
  step: WorkflowAgentStep;
  reservation: TaskReservation;
  /** Existing managed runner/spawn paths consume these durable ids. */
  taskRunId: string;
  attemptId: string;
}

export interface WorkflowAgentResult {
  ok: boolean;
  /** Classification input only. Raw output remains a capped task artifact. */
  failureText?: string;
}

export interface WorkflowExecutorDeps {
  createRun(input: WorkflowRunCreateInput): Promise<WorkflowRunDetail>;
  getRun(runId: string): Promise<WorkflowRunDetail | null>;
  recordStep(input: WorkflowStepRecordInput): Promise<WorkflowRunDetail>;
  advance(input: WorkflowRunAdvanceInput): Promise<WorkflowRunDetail>;
  resume(runId: string): Promise<WorkflowRunDetail>;
  reserveTask: typeof reserveTask;
  reserveAttempt: typeof reserveAttempt;
  taskGetForAttempt: typeof taskGetForAttempt;
  routeFor(step: WorkflowAgentStep, selected?: SelectedRoute): WorkflowRoutePlan;
  launchAgent(input: WorkflowAgentLaunch): Promise<WorkflowAgentResult>;
  runGitOp(step: WorkflowGitOpStep, run: WorkflowRunDetail): Promise<{ ok: boolean }>;
}

export const DEFAULT_WORKFLOW_STORE_DEPS = {
  createRun: createWorkflowRun,
  getRun: workflowGet,
  recordStep: recordWorkflowStep,
  advance: advanceWorkflowRun,
  resume: resumeWorkflowRun,
  reserveTask,
  reserveAttempt,
  taskGetForAttempt,
} satisfies Pick<
  WorkflowExecutorDeps,
  "createRun" | "getRun" | "recordStep" | "advance" | "resume" | "reserveTask" | "reserveAttempt" | "taskGetForAttempt"
>;

export type WorkflowExecutionResult =
  | { state: "settled"; run: WorkflowRunDetail }
  | { state: "waiting-human"; run: WorkflowRunDetail; card: BuilderCard }
  | { state: "waiting-event"; run: WorkflowRunDetail };

const edgeFor = (definition: WorkflowDefinition, stepId: string, outcome: string) => {
  const edge = definition.edges.find(
    (candidate) => candidate.from === stepId && candidate.on === outcome,
  );
  if (!edge) throw new Error(`validated workflow lost the ${outcome} exit for ${stepId}`);
  return edge;
};

function edgeTarget(run: WorkflowRunDetail, edge: WorkflowEdge): string {
  if (!edge.loop) return edge.to;
  const traversals = run.edges.filter(
    (taken) =>
      taken.fromStepId === edge.from &&
      taken.outcome === edge.on &&
      taken.target === edge.to,
  ).length;
  return traversals < edge.loop.maxRounds ? edge.to : edge.loop.exhaustedTo;
}

const cardForHuman = (step: WorkflowHumanStep): BuilderCard => ({
  id: `workflow:${step.id}`,
  kind: "decision",
  reason: step.card.reason,
  title: step.card.title,
  detail: step.card.detail,
  actions: step.card.actions,
});

/** A gate reads the task ledger through the attempt reference on the source
 * step. The workflow record never contains a verdict or artifact copy. */
export function evaluateWorkflowGate(
  step: WorkflowGateStep,
  run: WorkflowRunDetail,
  evidence: TaskEnvelopeDetail | null,
): boolean {
  const source = run.steps.find((candidate) => candidate.id === step.evidence.stepId);
  if (!source) return false;
  if (step.evidence.predicate === "step.completed") return source.state === "completed";
  const attemptId = source.attemptIds[source.attemptIds.length - 1];
  if (!attemptId || !evidence) return false;
  const attempt = evidence.attempts.find((candidate) => candidate.attemptId === attemptId);
  return step.evidence.predicate === "attempt.completed"
    ? attempt?.state === "completed"
    : attempt?.state === "failed";
}

async function advance(
  run: WorkflowRunDetail,
  step: WorkflowStep,
  outcome: string,
  deps: WorkflowExecutorDeps,
): Promise<WorkflowRunDetail> {
  const edge = edgeFor(run.definition, step.id, outcome);
  return deps.advance({
    runId: run.runId,
    stepId: step.id,
    stepState: outcome === "failure" || outcome === "fail" ? "failed" : "completed",
    outcome,
    target: edgeTarget(run, edge),
  });
}

async function executeAgent(
  initialRun: WorkflowRunDetail,
  step: WorkflowAgentStep,
  context: WorkflowExecutionContext,
  deps: WorkflowExecutorDeps,
): Promise<WorkflowRunDetail> {
  const firstPlan = deps.routeFor(step);
  const attemptCap = step.attemptCap ?? 3;
  const metadata = {
    workflow: {
      runId: initialRun.runId,
      definitionId: initialRun.definitionId,
      definitionVersion: initialRun.definitionVersion,
      stepId: step.id,
      capabilities: [...step.capabilities],
      constraints: step.constraints ?? initialRun.definition.constraints,
    },
  };
  let reservation = await deps.reserveTask({
    kind: "workflow-step",
    projectId: context.projectId,
    componentId: context.componentId,
    worktreePath: context.worktreePath,
    goal: step.prompt,
    acceptance: step.acceptance ?? [],
    taskClasses: { workflow: step.id },
    contextSummary: `Workflow ${initialRun.definitionId}@${initialRun.definitionVersion}`,
    riskClass: step.capabilities.includes("workspace-write") ? "reversible" : "read-only",
    authorityPolicy: {
      source: "workflow",
      capabilities: [...step.capabilities],
      constraints: step.constraints ?? initialRun.definition.constraints,
    },
    failoverPolicy: { policy: "vibe-failover-decision", attemptCap },
    attemptCap,
    title: step.name,
    metadata,
    route: firstPlan.route,
  });
  let run = await deps.recordStep({
    runId: initialRun.runId,
    stepId: step.id,
    state: "running",
    attemptId: reservation.attempt.attemptId,
  });
  let plan = firstPlan;
  let history: AttemptOutcomeRecord[] = [];

  for (let attemptsUsed = 1; attemptsUsed <= attemptCap; attemptsUsed += 1) {
    const result = await deps.launchAgent({
      workflowRunId: run.runId,
      step,
      reservation,
      taskRunId: reservation.envelope.runId,
      attemptId: reservation.attempt.attemptId,
    });
    if (result.ok) return advance(run, step, "success", deps);

    const decision = failoverDecision({
      evidence: { agent: plan.route.cli, text: result.failureText ?? "workflow agent attempt failed" },
      history,
      current: { cli: plan.route.cli, profileId: plan.route.profileId },
      candidates: plan.candidates,
      task: plan.taskClass,
      attemptsUsed,
      attemptCap,
    });
    history = [
      ...history,
      {
        route: `${plan.route.cli}:${plan.route.profileId}`,
        verdict: decision.verdict,
      },
    ];
    if (decision.action.kind === "stop") return advance(run, step, "failure", deps);
    const selected = decision.action.kind === "switch-route" ? decision.action.to : undefined;
    plan = deps.routeFor(step, selected);
    const nextAttempt = await deps.reserveAttempt({
      runId: reservation.envelope.runId,
      route: plan.route,
      recoveryFromAttemptId: reservation.attempt.attemptId,
    });
    reservation = { envelope: reservation.envelope, attempt: nextAttempt };
    run = await deps.recordStep({
      runId: run.runId,
      stepId: step.id,
      state: "running",
      attemptId: nextAttempt.attemptId,
    });
  }
  return advance(run, step, "failure", deps);
}

export async function continueWorkflow(
  runId: string,
  context: WorkflowExecutionContext,
  deps: WorkflowExecutorDeps,
): Promise<WorkflowExecutionResult> {
  let run = await deps.getRun(runId);
  if (!run) throw new Error("workflow run not found");
  if (run.status === "interrupted") run = await deps.resume(runId);

  for (let transitions = 0; transitions < 512; transitions += 1) {
    if (["completed", "failed", "cancelled"].includes(run.status)) {
      return { state: "settled", run };
    }
    const step = run.definition.steps.find((candidate) => candidate.id === run?.currentStepId);
    if (!step) throw new Error("active workflow step is missing from its pinned definition");

    if (step.kind === "agent") {
      run = await executeAgent(run, step, context, deps);
      continue;
    }
    if (step.kind === "gate") {
      const source = run.steps.find((candidate) => candidate.id === step.evidence.stepId);
      const attemptId = source?.attemptIds[source.attemptIds.length - 1];
      const evidence = attemptId
        ? await deps.taskGetForAttempt(attemptId)
        : null;
      const passed = evaluateWorkflowGate(step, run, evidence);
      run = await advance(run, step, passed ? "pass" : "fail", deps);
      continue;
    }
    if (step.kind === "human") {
      run = await deps.recordStep({ runId, stepId: step.id, state: "waiting" });
      return { state: "waiting-human", run, card: cardForHuman(step) };
    }
    if (step.kind === "watch") {
      if (run.trigger.kind === step.event) {
        run = await advance(run, step, "pass", deps);
        continue;
      }
      run = await deps.recordStep({ runId, stepId: step.id, state: "waiting" });
      return { state: "waiting-event", run };
    }
    const result = await deps.runGitOp(step, run);
    run = await advance(run, step, result.ok ? "success" : "failure", deps);
  }
  throw new Error("workflow exceeded its validated transition bound");
}

export async function startWorkflow(
  definition: WorkflowDefinition,
  trigger: WorkflowTriggerProvenance,
  context: WorkflowExecutionContext,
  deps: WorkflowExecutorDeps,
): Promise<WorkflowExecutionResult> {
  if (!workflowAcceptsTrigger(definition, trigger)) {
    throw new Error(`workflow ${definition.id} does not accept ${trigger.kind}`);
  }
  const run = await deps.createRun({
    projectId: context.projectId,
    definitionId: definition.id,
    definitionVersion: definition.version,
    definitionHash: workflowDefinitionHash(definition),
    definition,
    triggerKind: trigger.kind,
    trigger,
    startStepId: definition.start,
    steps: definition.steps.map((step) => ({ id: step.id, kind: step.kind })),
  });
  return continueWorkflow(run.runId, context, deps);
}

export async function answerWorkflowHuman(
  runId: string,
  response: string,
  context: WorkflowExecutionContext,
  deps: WorkflowExecutorDeps,
): Promise<WorkflowExecutionResult> {
  const run = await deps.getRun(runId);
  if (!run || !run.currentStepId) throw new Error("workflow run is not waiting for a response");
  const step = run.definition.steps.find((candidate) => candidate.id === run.currentStepId);
  if (!step || step.kind !== "human") throw new Error("workflow current step is not human");
  if (!step.card.actions.some((action) => action.response === response)) {
    throw new Error("workflow response is not one of the card actions");
  }
  const next = await advance(run, step, response, deps);
  return continueWorkflow(next.runId, context, deps);
}

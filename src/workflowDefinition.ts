import * as ipc from "./ipc";
import { redactSecrets } from "./vibeSecretScan";

export const WORKFLOW_SCHEMA_VERSION = 1 as const;
export const WORKFLOW_TRIGGER_CATALOG = [
  "manual",
  "pr.comment",
  "research.created",
  "research.status-changed",
  "task.created",
  "task.settled",
  "attempt.failed",
  "git.commit",
  "git.push",
  "git.branch-created",
  "pr.opened",
  "pr.checks-completed",
  "agent.spawned",
  "agent.ended",
  "server.incident",
  "mesh.message",
] as const;

export type WorkflowTriggerKind = (typeof WORKFLOW_TRIGGER_CATALOG)[number];
export type WorkflowStepKind = "agent" | "gate" | "watch" | "human" | "git-op";
export type WorkflowCapability =
  | "workspace-read"
  | "workspace-write"
  | "network"
  | "git-write"
  | "open-pr"
  | "update-branch";

export interface WorkflowConstraints {
  componentRoots: string[];
  branchPatterns: string[];
}

export interface WorkflowTriggerDeclaration {
  kind: WorkflowTriggerKind;
  repo?: string;
  mentions?: string[];
}

interface WorkflowStepBase {
  id: string;
  name: string;
  kind: WorkflowStepKind;
  capabilities: WorkflowCapability[];
  constraints?: WorkflowConstraints;
}

export interface WorkflowAgentStep extends WorkflowStepBase {
  kind: "agent";
  prompt: string;
  acceptance?: string[];
  attemptCap?: number;
}

export interface WorkflowGateStep extends WorkflowStepBase {
  kind: "gate";
  evidence: {
    stepId: string;
    predicate: "attempt.completed" | "attempt.failed" | "step.completed";
  };
}

export interface WorkflowWatchStep extends WorkflowStepBase {
  kind: "watch";
  event: Extract<WorkflowTriggerKind, "pr.comment">;
}

export interface WorkflowHumanStep extends WorkflowStepBase {
  kind: "human";
  card: {
    reason: "credentials" | "account-link" | "destructive" | "payment" | "choice";
    title: string;
    detail?: string;
    actions: Array<{
      label: string;
      response: string;
      tone?: "primary" | "neutral" | "danger";
    }>;
  };
}

export interface WorkflowGitOpStep extends WorkflowStepBase {
  kind: "git-op";
  operation: "open-pr" | "update-branch";
}

export type WorkflowStep =
  | WorkflowAgentStep
  | WorkflowGateStep
  | WorkflowWatchStep
  | WorkflowHumanStep
  | WorkflowGitOpStep;

export type WorkflowTerminal = "$completed" | "$failed" | "$cancelled";
export type WorkflowTarget = string | WorkflowTerminal;

export interface WorkflowEdge {
  from: string;
  to: WorkflowTarget;
  on: string;
  loop?: { maxRounds: number; exhaustedTo: WorkflowTarget };
}

export interface WorkflowDefinition {
  schemaVersion: typeof WORKFLOW_SCHEMA_VERSION;
  id: string;
  version: string;
  name: string;
  triggers: WorkflowTriggerDeclaration[];
  constraints: WorkflowConstraints;
  start: string;
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
}

export interface WorkflowValidationContext {
  projectRoot: string;
  componentRoots: ReadonlySet<string>;
}

export type WorkflowValidation =
  | { ok: true; definition: WorkflowDefinition }
  | { ok: false; errors: string[] };

export type WorkflowDefinitionsLoad =
  | { ok: true; definitions: WorkflowDefinition[] }
  | { ok: false; errors: string[] };

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CAPABILITIES = new Set<WorkflowCapability>([
  "workspace-read",
  "workspace-write",
  "network",
  "git-write",
  "open-pr",
  "update-branch",
]);
const TERMINALS = new Set<WorkflowTerminal>(["$completed", "$failed", "$cancelled"]);
const MAX_STEPS = 128;
const MAX_EDGES = 512;
const MAX_ROUNDS = 16;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const normalize = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
const absolute = (path: string) => /^(?:[A-Za-z]:\/|\/)/.test(normalize(path));
const resolvePath = (root: string, path: string) =>
  normalize(absolute(path) ? path : `${normalize(root)}/${path.replace(/^\.\//, "")}`);
const inside = (root: string, path: string) => {
  const base = normalize(root);
  const target = normalize(path);
  return target === base || target.startsWith(`${base}/`);
};

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
  errors: string[],
) {
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) errors.push(`${at} contains unknown field ${key}`);
  }
}

function validateConstraints(
  value: unknown,
  at: string,
  context: WorkflowValidationContext,
  errors: string[],
) {
  const constraints = record(value);
  if (!constraints) {
    errors.push(`${at} must be an object`);
    return;
  }
  exactKeys(constraints, ["componentRoots", "branchPatterns"], at, errors);
  if (!strings(constraints.componentRoots)) {
    errors.push(`${at}.componentRoots must be a string array`);
  } else {
    for (const root of constraints.componentRoots) {
      const resolved = resolvePath(context.projectRoot, root);
      if (!inside(context.projectRoot, resolved) || !context.componentRoots.has(resolved)) {
        errors.push(`${at}.componentRoots contains an unobserved project root`);
      }
    }
  }
  if (!strings(constraints.branchPatterns)) {
    errors.push(`${at}.branchPatterns must be a string array`);
  } else {
    for (const pattern of constraints.branchPatterns) {
      if (
        !pattern.trim() ||
        pattern.length > 128 ||
        pattern.startsWith("/") ||
        pattern.includes("..") ||
        pattern.includes("\u0000") ||
        pattern.includes("\r") ||
        pattern.includes("\n")
      ) {
        errors.push(`${at}.branchPatterns contains an unsafe pattern`);
      }
    }
  }
}

function expectedOutcomes(step: WorkflowStep): string[] {
  if (step.kind === "human") {
    const card = record(step.card);
    return Array.isArray(card?.actions)
      ? card.actions
          .map((action) => record(action)?.response)
          .filter((response): response is string => typeof response === "string")
      : [];
  }
  if (step.kind === "gate" || step.kind === "watch") return ["pass", "fail"];
  return ["success", "failure"];
}

export function validateWorkflowDefinition(
  value: unknown,
  context: WorkflowValidationContext,
): WorkflowValidation {
  const errors: string[] = [];
  const top = record(value);
  if (!top) return { ok: false, errors: ["workflow definition is not an object"] };
  exactKeys(
    top,
    ["schemaVersion", "id", "version", "name", "triggers", "constraints", "start", "steps", "edges"],
    "workflow",
    errors,
  );
  if (top.schemaVersion !== WORKFLOW_SCHEMA_VERSION) errors.push("unsupported workflow schemaVersion");
  if (!text(top.id) || !ID.test(top.id)) errors.push("workflow.id is invalid");
  if (!text(top.version) || top.version.length > 128) errors.push("workflow.version is invalid");
  if (!text(top.name) || top.name.length > 256) errors.push("workflow.name is invalid");
  if (!text(top.start) || !ID.test(top.start)) errors.push("workflow.start is invalid");
  validateConstraints(top.constraints, "workflow.constraints", context, errors);

  const triggers = Array.isArray(top.triggers) ? top.triggers : [];
  if (triggers.length === 0) errors.push("workflow.triggers must contain at least one declaration");
  triggers.forEach((raw, index) => {
    const at = `workflow.triggers[${index}]`;
    const trigger = record(raw);
    if (!trigger) {
      errors.push(`${at} is not an object`);
      return;
    }
    exactKeys(trigger, ["kind", "repo", "mentions"], at, errors);
    if (!WORKFLOW_TRIGGER_CATALOG.includes(trigger.kind as WorkflowTriggerKind)) {
      errors.push(`${at}.kind is not in the event catalog`);
    }
    if (trigger.repo !== undefined && !text(trigger.repo)) errors.push(`${at}.repo is invalid`);
    if (trigger.mentions !== undefined && !strings(trigger.mentions)) errors.push(`${at}.mentions is invalid`);
  });

  const rawSteps = Array.isArray(top.steps) ? top.steps : [];
  if (rawSteps.length === 0 || rawSteps.length > MAX_STEPS) {
    errors.push(`workflow.steps must contain between 1 and ${MAX_STEPS} steps`);
  }
  const stepIds = new Set<string>();
  const steps: WorkflowStep[] = [];
  rawSteps.forEach((raw, index) => {
    const at = `workflow.steps[${index}]`;
    const step = record(raw);
    if (!step) {
      errors.push(`${at} is not an object`);
      return;
    }
    const common = ["id", "name", "kind", "capabilities", "constraints"];
    const kind = step.kind;
    const specific =
      kind === "agent"
        ? ["prompt", "acceptance", "attemptCap"]
        : kind === "gate"
          ? ["evidence"]
          : kind === "watch"
            ? ["event"]
            : kind === "human"
              ? ["card"]
              : kind === "git-op"
                ? ["operation"]
                : [];
    exactKeys(step, [...common, ...specific], at, errors);
    if (!text(step.id) || !ID.test(step.id)) errors.push(`${at}.id is invalid`);
    else if (stepIds.has(step.id)) errors.push(`${at}.id is duplicated`);
    else stepIds.add(step.id);
    if (!text(step.name)) errors.push(`${at}.name is required`);
    if (!["agent", "gate", "watch", "human", "git-op"].includes(String(kind))) {
      errors.push(`${at}.kind is invalid`);
    }
    if (!Array.isArray(step.capabilities)) {
      errors.push(`${at}.capabilities must be declared`);
    } else {
      const seen = new Set<string>();
      for (const capability of step.capabilities) {
        if (!CAPABILITIES.has(capability as WorkflowCapability)) errors.push(`${at}.capabilities contains an unknown grant`);
        if (seen.has(String(capability))) errors.push(`${at}.capabilities contains a duplicate grant`);
        seen.add(String(capability));
      }
    }
    if (step.constraints !== undefined) validateConstraints(step.constraints, `${at}.constraints`, context, errors);

    if (kind === "agent") {
      if (!text(step.prompt)) errors.push(`${at}.prompt is required`);
      if (!Array.isArray(step.capabilities) || !step.capabilities.includes("workspace-read")) {
        errors.push(`${at} must declare workspace-read`);
      }
      if (step.acceptance !== undefined && !strings(step.acceptance)) errors.push(`${at}.acceptance is invalid`);
      if (step.attemptCap !== undefined && (!Number.isInteger(step.attemptCap) || Number(step.attemptCap) < 1 || Number(step.attemptCap) > 8)) {
        errors.push(`${at}.attemptCap must be between 1 and 8`);
      }
    } else if (kind === "gate") {
      const evidence = record(step.evidence);
      if (!evidence) errors.push(`${at}.evidence is required`);
      else {
        exactKeys(evidence, ["stepId", "predicate"], `${at}.evidence`, errors);
        if (!text(evidence.stepId)) errors.push(`${at}.evidence.stepId is invalid`);
        if (!["attempt.completed", "attempt.failed", "step.completed"].includes(String(evidence.predicate))) {
          errors.push(`${at}.evidence.predicate is invalid`);
        }
      }
    } else if (kind === "watch") {
      if (step.event !== "pr.comment") errors.push(`${at}.event is not wired in P1`);
    } else if (kind === "human") {
      const card = record(step.card);
      if (!card) errors.push(`${at}.card is required`);
      else {
        exactKeys(card, ["reason", "title", "detail", "actions"], `${at}.card`, errors);
        if (!text(card.title)) errors.push(`${at}.card.title is required`);
        if (!["credentials", "account-link", "destructive", "payment", "choice"].includes(String(card.reason))) {
          errors.push(`${at}.card.reason is invalid`);
        }
        const actions = Array.isArray(card.actions) ? card.actions : [];
        if (actions.length === 0) errors.push(`${at}.card.actions must not be empty`);
        const responses = new Set<string>();
        actions.forEach((rawAction, actionIndex) => {
          const action = record(rawAction);
          const actionAt = `${at}.card.actions[${actionIndex}]`;
          if (!action) { errors.push(`${actionAt} is not an object`); return; }
          exactKeys(action, ["label", "response", "tone"], actionAt, errors);
          if (!text(action.label) || !text(action.response)) errors.push(`${actionAt} needs label and response`);
          else if (responses.has(action.response)) errors.push(`${actionAt}.response is duplicated`);
          else responses.add(action.response);
          if (action.tone !== undefined && !["primary", "neutral", "danger"].includes(String(action.tone))) {
            errors.push(`${actionAt}.tone is invalid`);
          }
        });
      }
    } else if (kind === "git-op") {
      if (!["open-pr", "update-branch"].includes(String(step.operation))) errors.push(`${at}.operation is invalid in P1`);
      const grants = Array.isArray(step.capabilities) ? step.capabilities : [];
      for (const required of ["network", "git-write", step.operation]) {
        if (!grants.includes(required)) errors.push(`${at} must declare ${required}`);
      }
    }
    steps.push(step as unknown as WorkflowStep);
  });

  if (text(top.start) && !stepIds.has(top.start)) errors.push("workflow.start does not name a step");
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const step of steps) {
    if (step.kind !== "gate") continue;
    const source = byId.get(step.evidence?.stepId);
    if (!source) errors.push(`gate ${step.id} names missing evidence step ${step.evidence?.stepId}`);
    else if (
      typeof step.evidence?.predicate === "string" &&
      step.evidence.predicate.startsWith("attempt.") &&
      source.kind !== "agent"
    ) {
      errors.push(`gate ${step.id} requires attempt evidence from an agent step`);
    }
  }

  const rawEdges = Array.isArray(top.edges) ? top.edges : [];
  if (rawEdges.length === 0 || rawEdges.length > MAX_EDGES) {
    errors.push(`workflow.edges must contain between 1 and ${MAX_EDGES} edges`);
  }
  const edges: WorkflowEdge[] = [];
  const outcomeKeys = new Set<string>();
  const targetExists = (target: unknown) =>
    typeof target === "string" && (stepIds.has(target) || TERMINALS.has(target as WorkflowTerminal));
  rawEdges.forEach((raw, index) => {
    const at = `workflow.edges[${index}]`;
    const edge = record(raw);
    if (!edge) { errors.push(`${at} is not an object`); return; }
    exactKeys(edge, ["from", "to", "on", "loop"], at, errors);
    if (!text(edge.from) || !stepIds.has(edge.from)) errors.push(`${at}.from does not name a step`);
    if (!targetExists(edge.to)) errors.push(`${at}.to does not land on a step or terminal`);
    if (!text(edge.on)) errors.push(`${at}.on is required`);
    const key = `${edge.from}\0${edge.on}`;
    if (outcomeKeys.has(key)) errors.push(`${at} duplicates an outcome edge`);
    outcomeKeys.add(key);
    if (edge.loop !== undefined) {
      const loop = record(edge.loop);
      if (!loop) errors.push(`${at}.loop is not an object`);
      else {
        exactKeys(loop, ["maxRounds", "exhaustedTo"], `${at}.loop`, errors);
        if (!Number.isInteger(loop.maxRounds) || Number(loop.maxRounds) < 1 || Number(loop.maxRounds) > MAX_ROUNDS) {
          errors.push(`${at}.loop.maxRounds must be between 1 and ${MAX_ROUNDS}`);
        }
        if (!targetExists(loop.exhaustedTo)) errors.push(`${at}.loop.exhaustedTo is invalid`);
      }
    }
    edges.push(edge as unknown as WorkflowEdge);
  });

  for (const step of steps) {
    const actual = new Set(edges.filter((edge) => edge.from === step.id).map((edge) => edge.on));
    for (const outcome of expectedOutcomes(step)) {
      if (!actual.has(outcome)) errors.push(`step ${step.id} has no ${outcome} exit`);
    }
  }

  // All cycles must cross an explicitly bounded loop edge. Removing those
  // edges must leave a DAG; the loop's exhaustedTo is its guaranteed exit.
  const ordinary = new Map<string, string[]>();
  for (const step of steps) ordinary.set(step.id, []);
  for (const edge of edges) {
    if (!edge.loop && stepIds.has(edge.to)) ordinary.get(edge.from)?.push(edge.to);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cyclic = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    if ((ordinary.get(id) ?? []).some(cyclic)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (steps.some((step) => cyclic(step.id))) errors.push("workflow contains a cycle without a bounded loop edge");

  // A disconnected step is dead configuration, and a reachable step with no
  // terminal path is a run that can become stuck despite passing validation.
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    for (const edge of edges.filter((candidate) => candidate.from === id)) {
      if (stepIds.has(edge.to)) visit(edge.to);
      if (edge.loop && stepIds.has(edge.loop.exhaustedTo)) visit(edge.loop.exhaustedTo);
    }
  };
  if (text(top.start) && stepIds.has(top.start)) visit(top.start);
  for (const step of steps) if (!reachable.has(step.id)) errors.push(`step ${step.id} is unreachable from workflow.start`);

  const terminalMemo = new Map<string, boolean>();
  const reachesTerminal = (id: string, stack = new Set<string>()): boolean => {
    const memo = terminalMemo.get(id);
    if (memo !== undefined) return memo;
    if (stack.has(id)) return false;
    const nextStack = new Set(stack).add(id);
    const result = edges.filter((edge) => edge.from === id).some((edge) => {
      const targets = [edge.to, edge.loop?.exhaustedTo].filter(Boolean) as WorkflowTarget[];
      return targets.some((target) => TERMINALS.has(target as WorkflowTerminal) || (stepIds.has(target) && reachesTerminal(target, nextStack)));
    });
    terminalMemo.set(id, result);
    return result;
  };
  for (const step of steps) if (!reachesTerminal(step.id)) errors.push(`step ${step.id} has no path to a terminal state`);

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, definition: value as WorkflowDefinition };
}

export function workflowDefinitionHash(definition: WorkflowDefinition): string {
  const source = JSON.stringify(definition);
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
}

export interface WorkflowDefinitionIo {
  readDir(path: string): Promise<ipc.DirEntry[]>;
  readText(path: string, maxBytes: number): Promise<string>;
}

const DEFAULT_IO: WorkflowDefinitionIo = {
  readDir: (path) => ipc.fsReadDir(path),
  readText: (path, maxBytes) => ipc.fsReadText(path, maxBytes),
};

/** Load committed workflow definitions as one transaction: one malformed,
 * unsafe, or invalid file rejects the set, so callers never execute a partial
 * catalog whose missing edge happened to live in the bad file. */
export async function loadWorkflowDefinitions(
  projectRoot: string,
  context: WorkflowValidationContext,
  io: WorkflowDefinitionIo = DEFAULT_IO,
): Promise<WorkflowDefinitionsLoad> {
  const dir = `${normalize(projectRoot)}/.canopy/workflows`;
  let entries: ipc.DirEntry[];
  try {
    entries = await io.readDir(dir);
  } catch (error) {
    const message = String(error);
    return /not found|no such file/i.test(message)
      ? { ok: true, definitions: [] }
      : { ok: false, errors: [`could not read ${dir}: ${message}`] };
  }
  const files = entries
    .filter((entry) => !entry.is_dir && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const definitions: WorkflowDefinition[] = [];
  const errors: string[] = [];
  for (const file of files) {
    const source = await io.readText(file.path, 256 * 1024).catch((error) => {
      errors.push(`${file.name}: ${String(error)}`);
      return "";
    });
    if (!source) continue;
    if (redactSecrets(source) !== source) {
      errors.push(`${file.name}: definition contains a credential value`);
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(source);
    } catch {
      errors.push(`${file.name}: definition is not valid JSON`);
      continue;
    }
    const validation = validateWorkflowDefinition(value, context);
    if (!validation.ok) errors.push(...validation.errors.map((error) => `${file.name}: ${error}`));
    else definitions.push(validation.definition);
  }
  const ids = new Set<string>();
  for (const definition of definitions) {
    const key = `${definition.id}@${definition.version}`;
    if (ids.has(key)) errors.push(`workflow catalog duplicates ${key}`);
    ids.add(key);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, definitions };
}

export interface WorkflowTriggerProvenance {
  kind: "manual" | "pr.comment";
  eventId: string;
  occurredAt: number;
  payload: Record<string, unknown>;
}

/** P1 dispatches only manual and PR-comment events; the definition catalog is
 * wider so adding the remaining event adapters does not require a schema
 * migration. */
export function workflowAcceptsTrigger(
  definition: WorkflowDefinition,
  event: WorkflowTriggerProvenance,
): boolean {
  return definition.triggers.some((trigger) => {
    if (trigger.kind !== event.kind) return false;
    if (event.kind !== "pr.comment") return true;
    const repo = typeof event.payload.repo === "string" ? event.payload.repo : "";
    const body = typeof event.payload.body === "string" ? event.payload.body : "";
    if (trigger.repo && trigger.repo !== repo) return false;
    return (trigger.mentions ?? []).every((mention) => body.includes(mention));
  });
}

import type { Project, Component, RunCommand } from "./projects";
import { AGENT_CLIS } from "./projects";
import { CANOPY_MCP_ALLOWANCE } from "./agentTools";
import { launchEnvSync } from "./profiles";
import * as ipc from "./ipc";
import { DEFAULT_VIBE_BUILDER_DEPS } from "./vibeBuilderSession";
import type { BuilderSession } from "./vibeBuilderSessionTypes";
import { redactSecrets } from "./vibeSecretScan";
import type { ProjectRunnerController, ProjectRunnerTransport } from "./projectRunner";
import type { StructuredRunnerLaunch } from "./structuredRunners";
import type {
  TaskAttemptReserveInput,
  TaskAttemptSettlement,
  TaskReserveInput,
  TaskReservation,
} from "./taskEnvelope";
import {
  failoverDecision,
  rankRoutes,
  resolveRoute,
  type AttemptOutcomeRecord,
  type RouteCandidate,
  type RouteVersions,
  type SelectedRoute,
} from "./vibeFailover";

export const VIBE_SETUP_SCHEMA_VERSION = 1 as const;
const MAX_COMPONENTS = 64;
const MAX_COMMANDS_PER_COMPONENT = 16;
const MAX_ARGV = 64;
const MAX_SERVICES = 32;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type VibeComponentRole =
  | "web" | "api" | "worker" | "database" | "mobile"
  | "library" | "tooling" | "other";
export type VibeCommandPurpose = "serve" | "check" | "worker" | "setup";

export interface VibeSetupCommandProposal {
  key: string;
  purpose: VibeCommandPurpose;
  label: string;
  argv: [string, ...string[]];
  cwd: string;
  requiredEnvNames: string[];
  readiness:
    | { kind: "http"; path: string }
    | { kind: "port" }
    | { kind: "process-alive" }
    | { kind: "one-shot"; timeoutMs: number };
}

export interface VibeSetupComponentProposal {
  key: string;
  root: string;
  label: string;
  role: VibeComponentRole;
  commands: VibeSetupCommandProposal[];
  nonRunnableReason?: string;
  evidence: string[];
}

export interface VibeProjectSetupProposal {
  schemaVersion: typeof VIBE_SETUP_SCHEMA_VERSION;
  repositoryFingerprint: string;
  components: VibeSetupComponentProposal[];
  preview: { componentKey: string; commandKey: string };
  requiredProcesses: Array<{
    componentKey: string;
    commandKey: string;
    reason: string;
    requiredFor: "preview";
  }>;
  externalServices: Array<{
    key: string;
    providerId: string | null;
    label: string;
    purpose: string;
    requiredForPreview: boolean;
    usedByComponentKeys: string[];
    requiredEnvNames: string[];
    evidence: string[];
  }>;
  deployment: null | {
    providerId: string;
    componentKey: string;
    evidence: string[];
  };
}

export type SetupValidation =
  | { ok: true; proposal: VibeProjectSetupProposal }
  | { ok: false; errors: string[] };

export interface VibeSetupValidationContext {
  projectRoot: string;
  repositoryFingerprint: string;
  /** Canonical absolute paths observed by Canopy, not claimed by the agent. */
  existingPaths: ReadonlySet<string>;
  providerIds: ReadonlySet<string>;
  existingComponents: readonly Component[];
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");
const text = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const normalized = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");
const absolute = (path: string) => /^(?:[A-Za-z]:\/|\/)/.test(normalized(path));
const resolvePath = (root: string, path: string) =>
  normalized(absolute(path) ? path : `${normalized(root)}/${path.replace(/^\.\//, "")}`);

/** Lexical containment is followed by existingPaths membership, whose values
 * are supplied after native canonicalisation. A proposal never gets to define
 * its own filesystem truth. */
function inside(root: string, path: string): boolean {
  const base = normalized(root);
  const target = normalized(path);
  return target === base || target.startsWith(`${base}/`);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], at: string, errors: string[]) {
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) errors.push(`${at} contains unknown field ${key}`);
  }
}

export function parseVibeSetupOutput(output: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(output);
  const source = fenced?.[1] ?? output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1);
  if (!source.trim()) throw new Error("the setup agent returned no JSON object");
  return JSON.parse(source);
}

export function validateVibeSetupProposal(
  value: unknown,
  context: VibeSetupValidationContext,
): SetupValidation {
  const errors: string[] = [];
  const top = record(value);
  if (!top) return { ok: false, errors: ["setup output is not an object"] };
  const serialized = JSON.stringify(value);
  if (redactSecrets(serialized) !== serialized) {
    errors.push("setup output contains a credential value");
  }
  exactKeys(top, ["schemaVersion", "repositoryFingerprint", "components", "preview", "requiredProcesses", "externalServices", "deployment"], "setup", errors);
  if (top.schemaVersion !== VIBE_SETUP_SCHEMA_VERSION) errors.push("unsupported setup schemaVersion");
  if (top.repositoryFingerprint !== context.repositoryFingerprint) errors.push("repository changed while setup was running");
  if (!Array.isArray(top.components) || top.components.length === 0 || top.components.length > MAX_COMPONENTS) {
    errors.push("components must contain between 1 and 64 entries");
  }

  const componentKeys = new Set<string>();
  const commandKeys = new Map<string, Set<string>>();
  const roots = new Set<string>();
  const components = Array.isArray(top.components) ? top.components : [];
  components.forEach((raw, index) => {
    const at = `components[${index}]`;
    const component = record(raw);
    if (!component) { errors.push(`${at} is not an object`); return; }
    exactKeys(component, ["key", "root", "label", "role", "commands", "nonRunnableReason", "evidence"], at, errors);
    if (!text(component.key) || !KEY.test(component.key)) errors.push(`${at}.key is invalid`);
    else if (componentKeys.has(component.key)) errors.push(`${at}.key is duplicated`);
    else componentKeys.add(component.key);
    const componentRoot = text(component.root) ? resolvePath(context.projectRoot, component.root) : "";
    if (!componentRoot || !inside(context.projectRoot, componentRoot) || !context.existingPaths.has(componentRoot)) {
      errors.push(`${at}.root is not an observed directory inside the project`);
    } else if (roots.has(componentRoot)) errors.push(`${at}.root is duplicated`);
    else roots.add(componentRoot);
    if (!text(component.label)) errors.push(`${at}.label is required`);
    if (!["web", "api", "worker", "database", "mobile", "library", "tooling", "other"].includes(String(component.role))) errors.push(`${at}.role is invalid`);
    if (!strings(component.evidence) || component.evidence.length === 0 || component.evidence.some((path) => {
      const resolved = resolvePath(context.projectRoot, path);
      return !inside(context.projectRoot, resolved) || !context.existingPaths.has(resolved);
    })) errors.push(`${at}.evidence must name observed project paths`);
    const commands = Array.isArray(component.commands) ? component.commands : [];
    if (!Array.isArray(component.commands) || commands.length > MAX_COMMANDS_PER_COMPONENT) errors.push(`${at}.commands is invalid`);
    if (commands.length === 0 && !text(component.nonRunnableReason)) errors.push(`${at} has neither a command nor a nonRunnableReason`);
    const mine = new Set<string>();
    commandKeys.set(String(component.key), mine);
    commands.forEach((rawCommand, commandIndex) => {
      const cat = `${at}.commands[${commandIndex}]`;
      const command = record(rawCommand);
      if (!command) { errors.push(`${cat} is not an object`); return; }
      exactKeys(command, ["key", "purpose", "label", "argv", "cwd", "requiredEnvNames", "readiness"], cat, errors);
      if (!text(command.key) || !KEY.test(command.key) || mine.has(command.key)) errors.push(`${cat}.key is invalid or duplicated`);
      else mine.add(command.key);
      if (!["serve", "check", "worker", "setup"].includes(String(command.purpose))) errors.push(`${cat}.purpose is invalid`);
      if (!text(command.label)) errors.push(`${cat}.label is required`);
      if (!strings(command.argv) || command.argv.length === 0 || command.argv.length > MAX_ARGV || command.argv.some((arg) => !arg || arg.includes("\0"))) errors.push(`${cat}.argv is invalid`);
      const cwd = text(command.cwd) ? resolvePath(context.projectRoot, command.cwd) : "";
      if (!cwd || !inside(componentRoot, cwd) || !context.existingPaths.has(cwd)) errors.push(`${cat}.cwd is not an observed path inside its component`);
      if (!strings(command.requiredEnvNames) || command.requiredEnvNames.some((name) => !ENV_NAME.test(name))) errors.push(`${cat}.requiredEnvNames is invalid`);
      const readiness = record(command.readiness);
      if (!readiness || !["http", "port", "process-alive", "one-shot"].includes(String(readiness.kind))) errors.push(`${cat}.readiness is invalid`);
      if (readiness?.kind === "one-shot" && (typeof readiness.timeoutMs !== "number" || readiness.timeoutMs < 1_000 || readiness.timeoutMs > 30 * 60_000)) errors.push(`${cat}.readiness timeout is out of bounds`);
      if (readiness?.kind === "http" && (!text(readiness.path) || !String(readiness.path).startsWith("/"))) errors.push(`${cat}.readiness HTTP path is invalid`);
    });
  });

  // Existing configured roots are minimum coverage. The agent may discover
  // more, but it cannot make a known component disappear.
  for (const existing of context.existingComponents) {
    if (!roots.has(normalized(existing.path))) errors.push(`known component ${existing.id} is missing from setup`);
  }

  const reference = (raw: unknown, at: string) => {
    const ref = record(raw);
    if (!ref || !text(ref.componentKey) || !text(ref.commandKey)) { errors.push(`${at} is invalid`); return; }
    if (!componentKeys.has(ref.componentKey)) errors.push(`${at} names an unknown component`);
    else if (!commandKeys.get(ref.componentKey)?.has(ref.commandKey)) errors.push(`${at} names an unknown command`);
  };
  reference(top.preview, "preview");
  if (!Array.isArray(top.requiredProcesses) || top.requiredProcesses.length === 0) errors.push("requiredProcesses must include the preview process");
  else top.requiredProcesses.forEach((raw, index) => {
    const item = record(raw);
    reference(item, `requiredProcesses[${index}]`);
    if (!item || item.requiredFor !== "preview" || !text(item.reason)) errors.push(`requiredProcesses[${index}] is incomplete`);
  });
  const preview = record(top.preview);
  const requiredHasPreview = Array.isArray(top.requiredProcesses) && top.requiredProcesses.some((raw) => {
    const item = record(raw);
    return item?.componentKey === preview?.componentKey && item?.commandKey === preview?.commandKey;
  });
  if (!requiredHasPreview) errors.push("requiredProcesses omits the preview command");

  if (!Array.isArray(top.externalServices) || top.externalServices.length > MAX_SERVICES) errors.push("externalServices is invalid");
  else {
    const serviceKeys = new Set<string>();
    top.externalServices.forEach((raw, index) => {
    const at = `externalServices[${index}]`;
    const service = record(raw);
    if (!service) { errors.push(`${at} is not an object`); return; }
    exactKeys(service, ["key", "providerId", "label", "purpose", "requiredForPreview", "usedByComponentKeys", "requiredEnvNames", "evidence"], at, errors);
    if (!text(service.key) || !KEY.test(service.key) || serviceKeys.has(service.key) || !text(service.label) || !text(service.purpose)) errors.push(`${at} identity is invalid`);
    else serviceKeys.add(service.key);
    if (service.providerId !== null && (!text(service.providerId) || !context.providerIds.has(service.providerId))) errors.push(`${at}.providerId is not a trusted provider`);
    if (typeof service.requiredForPreview !== "boolean") errors.push(`${at}.requiredForPreview is invalid`);
    if (service.requiredForPreview === true && service.providerId === null) errors.push(`${at} is required but has no trusted account-link provider`);
    if (!strings(service.usedByComponentKeys) || service.usedByComponentKeys.some((key) => !componentKeys.has(key))) errors.push(`${at}.usedByComponentKeys is invalid`);
    if (!strings(service.requiredEnvNames) || service.requiredEnvNames.some((name) => !ENV_NAME.test(name))) errors.push(`${at}.requiredEnvNames is invalid`);
    if (!strings(service.evidence) || service.evidence.length === 0 || service.evidence.some((path) => !context.existingPaths.has(resolvePath(context.projectRoot, path)))) errors.push(`${at}.evidence is invalid`);
    });
  }
  if (top.deployment !== null) {
    const deployment = record(top.deployment);
    if (!deployment || !text(deployment.providerId) || !context.providerIds.has(deployment.providerId) || !text(deployment.componentKey) || !componentKeys.has(deployment.componentKey) || !strings(deployment.evidence) || deployment.evidence.some((path) => !context.existingPaths.has(resolvePath(context.projectRoot, path)))) errors.push("deployment is invalid");
  }
  return errors.length ? { ok: false, errors } : { ok: true, proposal: value as VibeProjectSetupProposal };
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) result = Math.imul(result ^ value.charCodeAt(i), 0x01000193);
  return (result >>> 0).toString(36);
}

const displayArgv = (argv: readonly string[]) => argv.map((arg) => JSON.stringify(arg)).join(" ");

export interface MaterializedVibeSetup {
  project: Project;
  componentIds: Readonly<Record<string, string>>;
  commandIds: Readonly<Record<string, string>>;
}

/** Canopy assigns identity. Agent keys are references within one proposal and
 * never become authority by themselves. Existing canonical roots and identical
 * argv commands keep their IDs; labels may change without moving automation. */
export function materializeVibeSetup(project: Project, proposal: VibeProjectSetupProposal, projectRoot = ""): MaterializedVibeSetup {
  const usedComponents = new Set(project.components.map((item) => item.id));
  const usedCommands = new Set(project.components.flatMap((item) => item.commands?.map((command) => command.id) ?? []));
  const componentIds: Record<string, string> = {};
  const commandIds: Record<string, string> = {};
  const allocate = (prefix: string, seed: string, used: Set<string>) => {
    let attempt = 0;
    for (;;) {
      const id = `${prefix}_${hash(attempt ? `${seed}\0${attempt}` : seed)}`;
      if (!used.has(id)) { used.add(id); return id; }
      attempt += 1;
    }
  };
  const components = proposal.components.map((candidate) => {
    const candidateRoot = projectRoot ? resolvePath(projectRoot, candidate.root) : normalized(candidate.root);
    const existing = project.components.find((item) => normalized(item.path) === candidateRoot);
    const id = existing?.id ?? allocate("cmp", candidateRoot, usedComponents);
    componentIds[candidate.key] = id;
    const commands: RunCommand[] = candidate.commands.map((command) => {
      const same = existing?.commands?.find((item) =>
        item.purpose === command.purpose && JSON.stringify(item.argv) === JSON.stringify(command.argv) && normalized(item.cwd ?? existing.path) === (projectRoot ? resolvePath(projectRoot, command.cwd) : normalized(command.cwd)));
      const commandCwd = projectRoot ? resolvePath(projectRoot, command.cwd) : normalized(command.cwd);
      const commandId = same?.id ?? allocate("run", `${id}\0${command.purpose}\0${JSON.stringify(command.argv)}\0${commandCwd}`, usedCommands);
      commandIds[`${candidate.key}:${command.key}`] = commandId;
      return { id: commandId, name: command.label, command: displayArgv(command.argv), argv: command.argv, cwd: commandCwd, purpose: command.purpose };
    });
    return { id, label: candidate.label, path: candidateRoot, commands };
  });
  const previewComponentId = componentIds[proposal.preview.componentKey];
  const previewRunCommandId = commandIds[`${proposal.preview.componentKey}:${proposal.preview.commandKey}`];
  return {
    componentIds,
    commandIds,
    project: {
      ...project,
      components,
      vibe: {
        version: 1,
        enabled: project.vibe?.enabled ?? true,
        setupRevision: proposal.repositoryFingerprint,
        componentId: previewComponentId,
        runCommandId: previewRunCommandId,
        requiredProcesses: proposal.requiredProcesses.map((item) => ({
          componentId: componentIds[item.componentKey],
          runCommandId: commandIds[`${item.componentKey}:${item.commandKey}`],
        })),
        externalServices: proposal.externalServices.map((item) => ({
          id: item.key,
          providerId: item.providerId,
          label: item.label,
          purpose: item.purpose,
          requiredForPreview: item.requiredForPreview,
          componentIds: item.usedByComponentKeys.map((key) => componentIds[key]),
          requiredEnvNames: item.requiredEnvNames,
        })),
      },
    },
  };
}

export const VIBE_SETUP_USER_MESSAGE = "Inspect this repository and return its complete Build setup as the required JSON object. Do not modify files and do not ask the person technical questions.";

export function vibeSetupSystemPrompt(fingerprint: string): string {
  return `You are Canopy's project setup agent. Read the entire repository, including non-JavaScript components. Do not edit files. Discover every component, how each runs, the one page-serving preview target, every process required for that page to work, external services, and deployment evidence. Return exactly one JSON object with schemaVersion 1 and repositoryFingerprint ${JSON.stringify(fingerprint)}. Commands are argv arrays, never shell strings. Evidence fields contain repository paths. If you cannot determine a complete setup, return no proposal and explain the blocker plainly.`;
}

export interface VibeSetupRepositoryObservation {
  projectRoot: string;
  fingerprint: string;
  paths: ReadonlySet<string>;
}

export async function observeVibeSetupRepository(project: Project): Promise<VibeSetupRepositoryObservation> {
  const roots = project.components.map((component) => normalized(component.path));
  if (roots.length === 0) throw new Error("project has no repository components");
  const split = roots.map((path) => path.split("/"));
  const shared: string[] = [];
  for (let i = 0; i < Math.min(...split.map((parts) => parts.length)); i += 1) {
    if (split.every((parts) => parts[i] === split[0][i])) shared.push(split[0][i]);
    else break;
  }
  const projectRoot = shared.join("/") || "/";
  const paths = new Set<string>(roots);
  const snapshots = await ipc.fsSnapshotFiles(roots, 20_000);
  const facts: string[] = snapshots.map((snapshot) => {
    const path = normalized(snapshot.path);
    paths.add(path);
    // Validation also needs to recognize a command cwd or component root. The
    // native inventory is intentionally files-only, so derive only ancestors
    // that remain inside one of the registered component roots.
    let parent = path.slice(0, path.lastIndexOf("/"));
    while (parent && roots.some((root) => inside(root, parent))) {
      paths.add(parent);
      const slash = parent.lastIndexOf("/");
      if (slash <= 0) break;
      parent = parent.slice(0, slash);
    }
    return `${path}:${snapshot.size}:${snapshot.modified_ms ?? -1}`;
  });
  facts.sort();
  return { projectRoot, paths, fingerprint: `fs-${hash(facts.join("\n"))}` };
}

const SETUP_ROUTE_VERSIONS: RouteVersions = {
  harnessVersion: "vibe-project-setup-1",
  promptVersion: "vibe-project-setup-1",
  toolPolicyVersion: "read-only-no-shell-1",
};

export interface VibeProjectSetupTaskDeps {
  runner: ProjectRunnerController;
  listRoutes(): Promise<RouteCandidate[]>;
  cliVersion(cli: string): Promise<string | null>;
  binFor(cli: string): string | null;
  sessionId(): string;
  reserve(input: TaskReserveInput): Promise<TaskReservation>;
  startAttempt(attemptId: string): Promise<unknown>;
  settleAttempt(input: TaskAttemptSettlement): Promise<unknown>;
  reserveAttempt(input: TaskAttemptReserveInput): Promise<import("./taskEnvelope").TaskAttempt>;
}

export interface VibeProjectSetupTaskInput {
  projectId: string;
  projectName: string;
  projectRoot: string;
  repositoryFingerprint: string;
  attemptCap?: number;
  timeoutMs?: number;
  /** Schema/repository validation owned by Canopy. A JSON object is not a
   * successful attempt merely because it parses. */
  validateOutput?: (output: unknown) => boolean;
  signal?: AbortSignal;
}

export type VibeProjectSetupTaskResult =
  | { ok: true; output: unknown; runId: string; attempts: number }
  | {
      ok: false;
      reason: "no-agent" | "timeout" | "agent-failed" | "invalid-output";
      message: string;
      runId: string | null;
      attempts: number;
    };

type AttemptRun =
  | { kind: "complete"; text: string }
  | { kind: "failed"; text: string; timedOut: boolean };

async function runSetupAttempt(
  transport: ProjectRunnerTransport,
  subscribe: (finish: (result: AttemptRun) => void) => void,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AttemptRun> {
  return new Promise<AttemptRun>((resolve) => {
    let finished = false;
    let timer: number | undefined;
    const abort = () => {
      void transport.stop().catch(() => {});
      finish({ kind: "failed", text: "project setup was cancelled", timedOut: false });
    };
    const finish = (result: AttemptRun) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) window.clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    subscribe(finish);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    timer = window.setTimeout(() => {
      void transport.stop().catch(() => {});
      finish({ kind: "failed", text: "project setup agent timed out", timedOut: true });
    }, timeoutMs);
    void transport.send(VIBE_SETUP_USER_MESSAGE).catch((error) =>
      finish({ kind: "failed", text: String(error), timedOut: false }),
    );
  });
}

/** Reserve and run one bounded, read-only setup task. Route failures use the
 * same policy as Build turns; malformed structured output is about the task,
 * not evidence that a different account/model would be safer. */
export async function runVibeProjectSetupTask(
  input: VibeProjectSetupTaskInput,
  deps: VibeProjectSetupTaskDeps,
): Promise<VibeProjectSetupTaskResult> {
  const attemptCap = Math.max(1, Math.min(3, input.attemptCap ?? 3));
  const timeoutMs = Math.max(1_000, Math.min(180_000, input.timeoutMs ?? 90_000));
  const candidates = await deps.listRoutes().catch(() => []);
  const eligible = rankRoutes(candidates, "build");
  let chosen = eligible[0];
  if (!chosen) {
    return {
      ok: false, reason: "no-agent", runId: null, attempts: 0,
      message: "I couldn't inspect this project because no setup agent is available right now.",
    };
  }
  const routeFor = async (route: SelectedRoute) =>
    resolveRoute(route, eligible, SETUP_ROUTE_VERSIONS, await deps.cliVersion(route.cli).catch(() => null));
  let reservation = await deps.reserve({
    kind: "vibe-project-setup",
    projectId: input.projectId,
    componentId: "project-setup",
    worktreePath: input.projectRoot,
    goal: "Understand and configure this project for Build mode",
    acceptance: [
      "Return a validated structured description of every component.",
      "Name one preview target and every process and service it requires.",
      "Do not modify the repository or ask the person technical questions.",
    ],
    contextSummary: `Automatic project setup for ${input.projectName}`,
    riskClass: "read-only",
    authorityPolicy: { writes: "none", shell: "denied" },
    failoverPolicy: { automatic: true, policy: "vibe-fleet-ranked-1" },
    attemptCap,
    deadlineAt: Date.now() + timeoutMs * attemptCap,
    title: "Understanding your project",
    metadata: { history: true, taskId: "vibe-project-setup", label: "Project setup" },
    route: await routeFor(chosen),
  });
  const runId = reservation.envelope.runId;
  let attempt = reservation.attempt;
  const history: AttemptOutcomeRecord[] = [];
  for (let attemptsUsed = 1; attemptsUsed <= attemptCap; attemptsUsed += 1) {
    await deps.startAttempt(attempt.attemptId);
    const bin = deps.binFor(chosen.cli);
    if (!bin) {
      await deps.settleAttempt({ attemptId: attempt.attemptId, state: "failed", failureClass: "route", failureCode: "missing-cli" });
      return { ok: false, reason: "agent-failed", message: "I couldn't inspect this project because the setup agent is unavailable.", runId, attempts: attemptsUsed };
    }
    let output = "";
    let error = "";
    let finishEvent: ((result: AttemptRun) => void) | null = null;
    let live: ProjectRunnerTransport | null = null;
    const launch: StructuredRunnerLaunch = {
      bin,
      policy: {
        systemPromptAppend: vibeSetupSystemPrompt(input.repositoryFingerprint),
        permissionMode: "plan",
        // The sidecar as a whole — nobody is here to answer a prompt for the
        // one reader that was left off the list. What this agent may do stays
        // decided by disallowedTools and plan mode, not by which canopy_* names
        // someone remembered. See agentTools.ts.
        allowedTools: [CANOPY_MCP_ALLOWANCE],
        disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "KillShell"],
        model: chosen.requestedModel ?? "",
        sessionId: deps.sessionId(),
        cwd: input.projectRoot,
        authority: "read-only",
      },
      // The attempt is recorded against a route that names a profile; without
      // its env the process runs on the default login and the record is
      // fiction. Same miss as the Build executor's.
      env: [...launchEnvSync(chosen.cli), ["CANOPY_VIBE_SETUP", "1"], ["CANOPY_RUN_ID", runId], ["CANOPY_ATTEMPT_ID", attempt.attemptId]],
    };
    let transport: ProjectRunnerTransport;
    try {
      transport = await deps.runner.start(attempt.attemptId, chosen.cli, launch, {
        emit(event) {
          if (event.kind === "delta" || event.kind === "reply") output += event.text;
          else if (event.kind === "error") error = event.message;
          // A setup agent that cannot read the project cannot describe it. Left
          // unread it returns prose instead of JSON and the attempt is filed as
          // a malformed proposal — blaming the model for a launch-policy fault.
          // Ended here instead, on a sentence the classifier reads as a task
          // failure, so the same block is not tried on two more routes.
          else if (event.kind === "blocked") {
            error =
              `Canopy requested permissions to use ${event.tool} in a session it started itself, ` +
              "and the request had nobody to answer it.";
            void live?.stop().catch(() => {});
            finishEvent?.({ kind: "failed", text: error, timedOut: false });
          }
          else if (event.kind === "turnEnd") finishEvent?.({ kind: "complete", text: output });
          else if (event.kind === "exit") finishEvent?.({ kind: "failed", text: error || output || "setup agent exited", timedOut: false });
        },
      }, { resume: false });
      live = transport;
    } catch (spawnError) {
      transport = { send: async () => {}, stop: async () => {} };
      error = String(spawnError);
    }
    const result = error
      ? { kind: "failed", text: error, timedOut: false } as const
      : await runSetupAttempt(transport, (finish) => { finishEvent = finish; }, timeoutMs, input.signal);
    if (result.kind === "complete") {
      try {
        const parsed = parseVibeSetupOutput(result.text);
        if (input.validateOutput && !input.validateOutput(parsed)) {
          await deps.settleAttempt({ attemptId: attempt.attemptId, state: "blocked", failureClass: "task", failureCode: "invalid-setup-schema" });
          return { ok: false, reason: "invalid-output", message: "I couldn't determine a safe complete setup for this project.", runId, attempts: attemptsUsed };
        }
        await deps.settleAttempt({ attemptId: attempt.attemptId, state: "completed" });
        return { ok: true, output: parsed, runId, attempts: attemptsUsed };
      } catch {
        await deps.settleAttempt({ attemptId: attempt.attemptId, state: "blocked", failureClass: "task", failureCode: "invalid-structured-output" });
        return { ok: false, reason: "invalid-output", message: "I couldn't determine a safe complete setup for this project.", runId, attempts: attemptsUsed };
      }
    }
    if (input.signal?.aborted) {
      await deps.settleAttempt({ attemptId: attempt.attemptId, state: "interrupted", failureClass: "lifecycle", failureCode: "project-closed" });
      return { ok: false, reason: "agent-failed", message: "Project setup stopped when the project closed.", runId, attempts: attemptsUsed };
    }
    await deps.settleAttempt({
      attemptId: attempt.attemptId,
      state: "failed",
      failureClass: result.timedOut ? "timeout" : "runner",
      failureCode: result.timedOut ? "setup-timeout" : "setup-agent-failed",
    });
    const decision = failoverDecision({
      evidence: { agent: chosen.cli, text: result.text },
      history,
      current: chosen,
      candidates,
      task: "build",
      attemptsUsed,
      attemptCap,
    });
    history.push({ route: `${chosen.cli}:${chosen.profileId}`, verdict: decision.verdict });
    if (decision.action.kind === "stop") {
      return {
        ok: false,
        reason: result.timedOut ? "timeout" : "agent-failed",
        message: result.timedOut
          ? "I couldn't finish understanding this project in time."
          : "I couldn't determine a safe complete setup for this project.",
        runId,
        attempts: attemptsUsed,
      };
    }
    if (decision.action.kind === "switch-route") chosen = decision.action.to;
    attempt = await deps.reserveAttempt({
      runId,
      route: await routeFor(chosen),
      recoveryFromAttemptId: attempt.attemptId,
    });
    reservation = { envelope: reservation.envelope, attempt };
  }
  return { ok: false, reason: "agent-failed", message: "I couldn't determine a safe complete setup for this project.", runId, attempts: attemptCap };
}

export const DEFAULT_VIBE_PROJECT_SETUP_TASK_DEPS: VibeProjectSetupTaskDeps = {
  runner: DEFAULT_VIBE_BUILDER_DEPS.runner,
  listRoutes: DEFAULT_VIBE_BUILDER_DEPS.listRoutes,
  cliVersion: DEFAULT_VIBE_BUILDER_DEPS.cliVersion,
  binFor: (cli) => AGENT_CLIS.find((candidate) => candidate.id === cli)?.bin ?? null,
  sessionId: DEFAULT_VIBE_BUILDER_DEPS.sessionId,
  reserve: DEFAULT_VIBE_BUILDER_DEPS.reserve,
  startAttempt: DEFAULT_VIBE_BUILDER_DEPS.startAttempt,
  settleAttempt: DEFAULT_VIBE_BUILDER_DEPS.settleAttempt,
  reserveAttempt: DEFAULT_VIBE_BUILDER_DEPS.reserveAttempt,
};

export interface VibeProjectSetupSessionDeps {
  observe(project: Project): Promise<VibeSetupRepositoryObservation>;
  run(input: VibeProjectSetupTaskInput, validation: VibeSetupValidationContext): Promise<VibeProjectSetupTaskResult>;
  providerIds: ReadonlySet<string>;
}

export const DEFAULT_VIBE_PROJECT_SETUP_SESSION_DEPS: VibeProjectSetupSessionDeps = {
  observe: observeVibeSetupRepository,
  run: (input, validation) => runVibeProjectSetupTask({
    ...input,
    validateOutput: (output) => validateVibeSetupProposal(output, validation).ok,
  }, DEFAULT_VIBE_PROJECT_SETUP_TASK_DEPS),
  providerIds: new Set(["supabase", "neon", "firebase", "stripe", "vercel", "netlify", "cloudflare", "fly"]),
};

/** Chat-shaped only because Build already owns that surface. It has no input
 * actions: setup is automatic, and a failure speaks plainly rather than asking
 * a non-engineer to adjudicate commands or components. */
export function createVibeProjectSetupSession(
  project: Project,
  persist: (configured: Project) => Promise<boolean>,
  deps: VibeProjectSetupSessionDeps = DEFAULT_VIBE_PROJECT_SETUP_SESSION_DEPS,
): BuilderSession & { stop(): Promise<void> } {
  const listeners = new Set<(event: import("./structuredEvents").StructuredRunnerEvent) => void>();
  let state: BuilderSession["state"] = { persona: { kind: "turn-progress" }, question: null };
  let stopped = false;
  const abort = new AbortController();
  const publish = (event: import("./structuredEvents").StructuredRunnerEvent) => {
    if (!stopped) for (const listener of listeners) listener(event);
  };
  const execute = async () => {
    publish({ kind: "reply", text: "I'm understanding how this project fits together and starting everything it needs." });
    try {
      const before = await deps.observe(project);
      if (stopped) return;
      const validationContext: VibeSetupValidationContext = {
        projectRoot: before.projectRoot,
        repositoryFingerprint: before.fingerprint,
        existingPaths: before.paths,
        providerIds: deps.providerIds,
        existingComponents: project.components,
      };
      const task = await deps.run({
        projectId: project.id,
        projectName: project.name,
        projectRoot: before.projectRoot,
        repositoryFingerprint: before.fingerprint,
        signal: abort.signal,
      }, validationContext);
      if (stopped) return;
      if (!task.ok) {
        state = { persona: { kind: "incident" }, question: null };
        publish({ kind: "reply", text: task.message });
        return;
      }
      const after = await deps.observe(project);
      const validation = validateVibeSetupProposal(task.output, {
        projectRoot: after.projectRoot,
        repositoryFingerprint: after.fingerprint,
        existingPaths: after.paths,
        providerIds: deps.providerIds,
        existingComponents: project.components,
      });
      if (!validation.ok) {
        state = { persona: { kind: "incident" }, question: null };
        publish({ kind: "reply", text: "I couldn't determine a safe complete setup for this project." });
        return;
      }
      const configured = materializeVibeSetup(project, validation.proposal, after.projectRoot).project;
      if (!(await persist(configured))) {
        state = { persona: { kind: "incident" }, question: null };
        publish({ kind: "reply", text: "I understood the project, but couldn't save its setup." });
        return;
      }
      state = { persona: { kind: "question-answered" }, question: null };
      publish({ kind: "ready" });
    } catch {
      if (stopped) return;
      state = { persona: { kind: "incident" }, question: null };
      publish({ kind: "reply", text: "I couldn't determine a safe complete setup for this project." });
    }
  };
  queueMicrotask(() => void execute());
  return {
    get state() { return state; },
    events$: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    send: async () => {},
    stop: async () => { stopped = true; abort.abort(); },
  };
}

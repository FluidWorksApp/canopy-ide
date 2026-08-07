import type { Project, Component, ComponentRole, RunCommand } from "./projects";
import { AGENT_CLIS } from "./projects";
import { CANOPY_MCP_ALLOWANCE } from "./agentTools";
import { launchEnvSync } from "./profiles";
import * as ipc from "./ipc";
import { DEFAULT_VIBE_BUILDER_DEPS } from "./vibeBuilderSession";
import type { BuilderSession } from "./vibeBuilderSessionTypes";
import { redactSecrets } from "./vibeSecretScan";
import type { ProjectRunnerController, ProjectRunnerTransport } from "./projectRunner";
import { streamsStructured, type StructuredRunnerLaunch } from "./structuredRunners";
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

/** The persisted spelling is the source of truth, so a role survives into the
 *  project file rather than existing only inside a proposal. */
export type VibeComponentRole = ComponentRole;
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
    // Name the paths that failed. "must name observed project paths" is true of
    // an invented file and of a real one Canopy's inventory did not reach, and
    // those want opposite fixes — one is the agent, the other is the cap on
    // fsSnapshotFiles. Undifferentiated, the message sends you to the wrong one.
    if (!strings(component.evidence) || component.evidence.length === 0) {
      errors.push(`${at}.evidence must name observed project paths`);
    } else {
      const unobserved = component.evidence.filter((path) => {
        const resolved = resolvePath(context.projectRoot, path);
        return !inside(context.projectRoot, resolved) || !context.existingPaths.has(resolved);
      });
      if (unobserved.length) {
        errors.push(`${at}.evidence names paths Canopy did not observe: ${unobserved.join(", ")}`);
      }
    }
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
    return { id, label: candidate.label, path: candidateRoot, commands, role: candidate.role };
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

/** How many observed paths are handed over. Enough to recognise every
 *  component and its build files; short of the point where the listing costs
 *  more than the search it replaces. */
const INVENTORY_LIMIT = 1500;

/** The brief, with the project's actual layout in it.
 *
 *  Canopy has already walked these directories — `observeVibeSetupRepository`
 *  snapshots every file to compute the fingerprint, and then used that only to
 *  validate the answer. The agent was left to rediscover the same tree with
 *  glob, from a working directory that is merely the components' common
 *  ancestor: for two sibling checkouts that is whatever folder the person keeps
 *  repositories in, and the search never finished inside the timeout.
 *
 *  So the inventory goes in the brief. Truncation is stated rather than
 *  silent — an agent that believes it has the whole tree will conclude a
 *  component does not exist. */
export function vibeSetupUserMessage(
  componentRoots: readonly string[],
  inventory: readonly string[] = [],
): string {
  if (componentRoots.length === 0) return VIBE_SETUP_USER_MESSAGE;
  const listed = inventory.slice(0, INVENTORY_LIMIT);
  const layout = listed.length
    ? `\n\nCanopy has already observed these files. Use this instead of searching; read individual files only where you need their contents:\n${listed.join("\n")}` +
      (inventory.length > listed.length
        ? `\n(+${inventory.length - listed.length} more files not listed — the components above are complete, this listing is not.)`
        : "")
    : "";
  return (
    `${VIBE_SETUP_USER_MESSAGE}\n\nThe project is exactly these directories:\n${componentRoots.join("\n")}` +
    layout
  );
}

/** What Canopy can state about the project instead of making the agent infer
 *  it. The person configured these components and named them; a survey that
 *  begins by guessing at that is redoing settled work, and guessing differently
 *  each run. */
export interface VibeSetupProjectBrief {
  name: string;
  components: readonly Component[];
}

function briefSection(brief: VibeSetupProjectBrief | undefined): string {
  if (!brief?.components.length) return "";
  const lines = brief.components.map((component) => {
    const commands = (component.commands ?? []).map((command) => {
      const argv = command.argv?.length ? command.argv.join(" ") : command.command;
      const purpose = command.purpose ? ` [${command.purpose}]` : "";
      return `      - "${command.name}"${purpose}: ${argv}${command.cwd ? ` (in ${command.cwd})` : ""}`;
    });
    return (
      `  - ${component.label} — ${normalized(component.path)}\n` +
      (commands.length
        ? `    already configured in Canopy:\n${commands.join("\n")}`
        : "    no run command configured yet")
    );
  });
  return (
    `\n\nThis is the project "${brief.name}". Canopy already holds this much, ` +
    `configured by the person who owns it:\n\n${lines.join("\n")}\n\n` +
    "Treat that as given, not as a hypothesis to re-derive: the labels are the " +
    "person's own words for these directories, and an already-configured " +
    "command is one they have run. Confirm each against the repository and say " +
    "so if one is now wrong, but do not rename what is already named, and do " +
    "not omit a component because you found nothing interesting in it."
  );
}

export function vibeSetupSystemPrompt(
  fingerprint: string,
  componentRoots: readonly string[] = [],
  brief?: VibeSetupProjectBrief,
): string {
  // The working directory is the components' common ancestor, which for two
  // sibling checkouts is whatever folder the person keeps repositories in —
  // here that was ~/Documents/GitHub, 106GB of unrelated projects. Told only
  // to "read the entire repository", the agent globbed all of it and hit the
  // timeout without producing a proposal. The roots are known before launch,
  // so name them rather than leaving it to infer them from where it landed.
  const scope = componentRoots.length
    ? ` The project consists solely of these directories: ${componentRoots.join(", ")}. Confine every search to them; sibling directories under the working directory belong to unrelated projects.`
    : "";
  // The schema is spelled out because validateVibeSetupProposal rejects every
  // unrecognised field, and prose is not a schema. Described rather than shown,
  // the agent turned the sentence into field names — "the one page-serving
  // preview target" came back as `pageServingPreviewTarget`, components carried
  // `name`/`path`/`kind` instead of `label`/`root`/`role` — and a correct
  // survey was thrown away for answering in the wrong shape. Any change to the
  // interfaces above has to be made here too, or that returns.
  return `You are Canopy's project setup agent.${scope} Read the entire repository, including non-JavaScript components. Do not edit files. Discover every component, how each runs, the one page-serving preview target, every process required for that page to work, external services, and deployment evidence.${briefSection(brief)}

Return exactly one JSON object in this shape and no other. Field names are exact; any field not listed here is rejected, and so is any missing one:

{
  "schemaVersion": 1,
  "repositoryFingerprint": ${JSON.stringify(fingerprint)},
  "components": [{
    "key": "short-id",                        // ^[a-z0-9][a-z0-9._-]{0,63}$, unique
    "root": "<absolute directory path>",
    "label": "<human name>",
    "role": "web|api|worker|database|mobile|library|tooling|other",
    "commands": [{
      "key": "short-id",                      // unique within this component
      "purpose": "serve|check|worker|setup",
      "label": "<human name>",
      "argv": ["pnpm", "dev"],                // argv array, never a shell string
      "cwd": "<absolute path inside this component>",
      "requiredEnvNames": ["API_URL"],        // NAMES only, never values
      "readiness": { "kind": "http", "path": "/" }
      // readiness is one of: {"kind":"http","path":"/..."} | {"kind":"port"}
      //   | {"kind":"process-alive"} | {"kind":"one-shot","timeoutMs":120000}
    }],
    "nonRunnableReason": "<only if commands is empty>",
    "evidence": ["<absolute path that exists>"]
  }],
  "preview": { "componentKey": "...", "commandKey": "..." },
  "requiredProcesses": [
    { "componentKey": "...", "commandKey": "...", "reason": "<why the page needs it>", "requiredFor": "preview" }
  ],
  "externalServices": [{
    "key": "short-id",
    "providerId": null,                       // or one of: supabase, neon, firebase, stripe, vercel, netlify, cloudflare, fly
    "label": "<human name>",
    "purpose": "<what it is for>",
    "requiredForPreview": false,              // true requires a non-null providerId
    "usedByComponentKeys": ["..."],
    "requiredEnvNames": ["DATABASE_URL"],
    "evidence": ["<absolute path that exists>"]
  }],
  "deployment": null
  // or { "providerId": "...", "componentKey": "...", "evidence": ["..."] } —
  // providerId must be one of the same ids listed above. Anything else, and
  // anything self-hosted, is null: null means "not one of these", not "no
  // deployment", and a real deployment named here that is not on that list is
  // rejected outright.
}

Work out what each component IS before deciding how it runs, from its manifest
rather than from the shape of the tree: package.json, go.mod, Cargo.toml,
pyproject.toml/requirements.txt, Gemfile, pom.xml, build.gradle(.kts),
*.xcodeproj/Package.swift, pubspec.yaml, composer.json, *.csproj, Dockerfile,
Makefile. The run command is whatever that ecosystem's own is — gradlew
assembleDebug, xcodebuild, go run, cargo run, uvicorn, rails s, mvn spring-boot:run,
flutter run, dotnet run, make — and argv[0] must be a real executable, never a
shell built-in and never a script you assume exists. A component that is an
Android app, an iOS app, a Go service or a Rails API is not served by a
JavaScript command, and "there is no package.json" is not a reason to call it
non-runnable.

Rules: every component directory you were given must appear. requiredProcesses must include the preview entry. Every path in root, cwd and evidence must be a real path you observed. Never include a secret value. If you cannot determine a complete setup, return no JSON object and explain the blocker plainly instead.`;
}

export interface VibeSetupRepositoryObservation {
  projectRoot: string;
  fingerprint: string;
  paths: ReadonlySet<string>;
  /** The configured component directories. Distinct from projectRoot, which is
   *  only their common ancestor and may hold unrelated repositories. */
  componentRoots: string[];
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
  return { projectRoot, paths, componentRoots: roots, fingerprint: `fs-${hash(facts.join("\n"))}` };
}

/** What this task needs from a model, as a class the routing table answers.
 *
 *  Discovery reads files and reports structure. It is not the thinking the
 *  builder does, and asking for the builder's tier spent the frontier model on
 *  enumeration — slower, dearer, and no more correct. Declared once here so the
 *  ranking and the failover that follows it cannot disagree about which job
 *  this is. */
const SETUP_TASK_CLASS = "survey" as const;

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
  /** Named to the agent so it searches the project rather than everything that
   *  happens to sit beside it under projectRoot. */
  componentRoots?: readonly string[];
  /** What Canopy already knows: what each directory is called, and any run
   *  command already attached to it. Withholding it asked the agent to
   *  rediscover, from an unlabelled list of paths, facts the person had
   *  already told Canopy — and to guess at names Canopy could simply state. */
  components?: readonly Component[];
  /** Paths Canopy already observed, handed over so the agent reads rather than
   *  searches. */
  inventory?: readonly string[];
  repositoryFingerprint: string;
  attemptCap?: number;
  timeoutMs?: number;
  /** Schema/repository validation owned by Canopy. A JSON object is not a
   * successful attempt merely because it parses. */
  validateOutput?: (output: unknown) => boolean | Promise<boolean>;
  /** What the agent is doing right now, for the pane. Setup can run for
   *  minutes; without this it prints one line and then looks hung, which is
   *  indistinguishable from being hung. */
  onActivity?: (event: import("./structuredEvents").StructuredRunnerEvent) => void;
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
  brief: string = VIBE_SETUP_USER_MESSAGE,
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
    void transport.send(brief).catch((error) =>
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
  // Setup runs once per repository fingerprint, not once per turn, so a tight
  // budget buys nothing and costs the whole feature. 90s was set against a
  // single-component project; a real one (four components, sixty reads to
  // establish how each runs) does not finish, and the person is told the agent
  // could not understand their project rather than that it was cut off.
  // 300s was still short of what a real project needs: every observed run
  // against a three-repository project expired at exactly 300s, and a
  // two-component one began expiring too once the survey grew. The attempt cap
  // then spends the whole budget again on a second route, so the person waits
  // ten minutes to be told their project could not be understood, when it was
  // only ever cut off mid-read.
  //
  // Raising it is the honest interim and not the fix. A survey of four
  // components should not be one agent turn: split per component it would be
  // bounded, partial results would survive, and one slow repository could not
  // sink the whole run. Until that exists, this at least lets a correct survey
  // finish. onActivity publishes each tool call, so the wait is narrated
  // rather than silent.
  const timeoutMs = Math.max(1_000, Math.min(1_200_000, input.timeoutMs ?? 900_000));
  // Setup reads its result off a JSON stream, so a CLI Canopy can only run
  // one-shot is not a slower route here — it is not a route at all. Ranking it
  // anyway spends the whole attempt budget on `has no verified streaming
  // runner`, thrown before a process exists, and reports it as the agent
  // failing to understand the project.
  const candidates = (await deps.listRoutes().catch(() => [])).filter(
    (candidate) => streamsStructured(candidate.cli),
  );
  // Reading a repository and reporting what is in it is a survey, not a build.
  // Asking for "build" requested the frontier tier — Opus for a job that is
  // enumeration and file reading, where the workhorse is both faster and the
  // class the routing table already assigns to delegated work. The tier is a
  // requirement declared by the task; TIER_FOR_CLASS is where it is answered.
  const eligible = rankRoutes(candidates, SETUP_TASK_CLASS);
  let chosen = eligible[0];
  if (!chosen) {
    return {
      ok: false, reason: "no-agent", runId: null, attempts: 0,
      message: "I couldn't inspect this project because no setup agent is available right now.",
    };
  }
  const routeFor = async (route: SelectedRoute) =>
    resolveRoute(route, eligible, SETUP_ROUTE_VERSIONS, await deps.cliVersion(route.cli).catch(() => null));
  // Where the agent actually runs. The task record and the launch have to name
  // the same directory — the native side rejects a structured runner whose cwd
  // is not its reserved workspace, which is the right check: an attempt filed
  // against a directory the process never ran in is a record of something that
  // did not happen.
  const agentCwd = input.componentRoots?.[0] ?? input.projectRoot;
  let reservation = await deps.reserve({
    kind: "vibe-project-setup",
    projectId: input.projectId,
    componentId: "project-setup",
    worktreePath: agentCwd,
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
    // Built once and both sent and reported. Rebuilt for the log it would have
    // been rebuilt with different arguments, and the number describing what was
    // sent would quietly describe something else.
    const systemPrompt = vibeSetupSystemPrompt(
      input.repositoryFingerprint,
      input.componentRoots ?? [],
      input.components?.length
        ? { name: input.projectName, components: input.components }
        : undefined,
    );
    const userMessage = vibeSetupUserMessage(input.componentRoots ?? [], input.inventory ?? []);
    const launch: StructuredRunnerLaunch = {
      bin,
      policy: {
        systemPromptAppend: systemPrompt,
        permissionMode: "plan",
        // The sidecar as a whole — nobody is here to answer a prompt for the
        // one reader that was left off the list. What this agent may do stays
        // decided by disallowedTools and plan mode, not by which canopy_* names
        // someone remembered. See agentTools.ts.
        allowedTools: [CANOPY_MCP_ALLOWANCE],
        disallowedTools: ["Bash", "Edit", "Write", "NotebookEdit", "KillShell"],
        model: chosen.requestedModel ?? "",
        sessionId: deps.sessionId(),
        // A component root, never projectRoot. projectRoot is only the
        // components' common ancestor and has to stay that way — validation
        // uses it as the containment boundary — but for two sibling checkouts
        // it is whatever folder the person keeps repositories in. Here that
        // was ~/Documents/GitHub: every repository on the machine, 106GB of
        // it, as the agent's working directory. Every relative path it
        // resolved and every listing it took to orient itself started from
        // there. The other roots arrive as additionalDirectories, so landing
        // in one costs nothing and reading the rest still works.
        cwd: agentCwd,
        authority: "read-only",
      },
      // The attempt is recorded against a route that names a profile; without
      // its env the process runs on the default login and the record is
      // fiction. Same miss as the Build executor's.
      // cwd is only the components' common ancestor; these are the directories
      // the project actually is, granted explicitly so reading one never
      // depends on where the launch happened to land.
      additionalDirectories: input.componentRoots ?? [],
      env: [...launchEnvSync(chosen.cli), ["CANOPY_VIBE_SETUP", "1"], ["CANOPY_RUN_ID", runId], ["CANOPY_ATTEMPT_ID", attempt.attemptId]],
    };
    // What was actually spawned. A turn that ends having said nothing is the
    // one failure the transcript cannot explain, because there is no
    // transcript — and the launch is the only remaining suspect. Rebuilding it
    // by hand from four files is how an afternoon goes.
    void ipc.jsLog(
      "error",
      `vibe-setup: launching ${chosen.cli} bin=${deps.binFor(chosen.cli)} model=${chosen.requestedModel ?? "(none)"} ` +
        `cwd=${agentCwd} addDirs=${(input.componentRoots ?? []).length} briefed=${input.components?.length ?? 0} ` +
        `promptChars=${systemPrompt.length}+${userMessage.length} ` +
        `env=${JSON.stringify(launchEnvSync(chosen.cli).map(([name]) => name))}`,
    );
    let transport: ProjectRunnerTransport;
    try {
      transport = await deps.runner.start(attempt.attemptId, chosen.cli, launch, {
        emit(event) {
          // Whatever it is doing, said out loud. A setup that runs for minutes
          // behind one unchanging line is indistinguishable from a hung one,
          // and the person has no way to tell which they are looking at.
          if (event.kind === "tool") input.onActivity?.(event);
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
          // A turn that ended having said nothing did not succeed at producing
          // an empty proposal — it failed, and something already said why.
          // `turn.failed` emits `error` and then `turnEnd`, so settling every
          // turnEnd as complete discarded the reason a moment after receiving
          // it: an API refusing the requested model ("The 'gpt-5.6' model is
          // not supported when using Codex with a ChatGPT account") was
          // reported to the user as the agent returning nothing, which sent us
          // looking at the prompt, the schema and the launch for an hour. The
          // error only wins an empty turn; a turn that produced output and a
          // stray error line is still that output.
          else if (event.kind === "turnEnd") {
            finishEvent?.(output || !error
              ? { kind: "complete", text: output }
              : { kind: "failed", text: error, timedOut: false });
          }
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
      : await runSetupAttempt(
          transport,
          (finish) => { finishEvent = finish; },
          timeoutMs,
          input.signal,
          userMessage,
        );
    if (result.kind === "complete") {
      // Only the parse is guarded. Settling the attempt was inside this try
      // too, so a lifecycle refusal — "attempt is already interrupted", raised
      // when the project closed under a run — was reported as the agent's
      // output failing to parse, with the agent's perfectly good JSON printed
      // beneath it as the evidence. The catch must cover the thing it names.
      let parsed: unknown;
      try {
        parsed = parseVibeSetupOutput(result.text);
      } catch (parseError) {
        // "invalid-output" is returned both when the JSON will not parse and
        // when it parses but breaks a rule, and the two need opposite fixes:
        // one is the agent not answering in the required shape, the other is
        // the answer disagreeing with what Canopy observed. Say which, and
        // show the head of what actually came back — a refusal, a preamble
        // before the JSON, or an empty turn all land here identically.
        void ipc.jsLog(
          "error",
          `vibe-setup: could not parse the output of ${chosen.cli} (${String(parseError)}); it returned: ${result.text.slice(0, 500) || "(nothing)"}`,
        );
        await deps.settleAttempt({ attemptId: attempt.attemptId, state: "blocked", failureClass: "task", failureCode: "invalid-structured-output" });
        return { ok: false, reason: "invalid-output", message: "I couldn't determine a safe complete setup for this project.", runId, attempts: attemptsUsed };
      }
      if (input.validateOutput && !(await input.validateOutput(parsed))) {
        await deps.settleAttempt({ attemptId: attempt.attemptId, state: "blocked", failureClass: "task", failureCode: "invalid-setup-schema" });
        return { ok: false, reason: "invalid-output", message: "I couldn't determine a safe complete setup for this project.", runId, attempts: attemptsUsed };
      }
      await deps.settleAttempt({ attemptId: attempt.attemptId, state: "completed" });
      return { ok: true, output: parsed, runId, attempts: attemptsUsed };
    }
    if (input.signal?.aborted) {
      await deps.settleAttempt({ attemptId: attempt.attemptId, state: "interrupted", failureClass: "lifecycle", failureCode: "project-closed" });
      return { ok: false, reason: "agent-failed", message: "Project setup stopped when the project closed.", runId, attempts: attemptsUsed };
    }
    // The one string that says what actually went wrong. It reaches the
    // failover classifier and then nothing keeps it: every attempt after this
    // reports "setup-agent-failed", which names the outcome and not the cause.
    void ipc.jsLog(
      "error",
      `vibe-setup: attempt ${attemptsUsed} on ${chosen.cli} failed (kind=${result.kind} timedOut=${(result as { timedOut?: boolean }).timedOut}): ${result.text.slice(0, 600)}`,
    );
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
      task: SETUP_TASK_CLASS,
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

/** Absolute-looking strings anywhere in a proposal, capped. Walking the parsed
 *  object rather than naming the fields keeps this from silently missing a
 *  path when the schema gains one. */
function citedPaths(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (found.size >= CONFIRMABLE_PATHS) return found;
  if (typeof value === "string") {
    if (absolute(value)) found.add(normalized(value));
  } else if (Array.isArray(value)) {
    for (const item of value) citedPaths(item, found);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) citedPaths(item, found);
  }
  return found;
}
const CONFIRMABLE_PATHS = 400;

/** Confirm the paths a proposal names that the inventory does not already
 *  hold, and add the ones that are really there.
 *
 *  The inventory comes from fsSnapshotFiles, which skips ignored files — so a
 *  real file could be cited and rejected as unobserved. That is not
 *  hypothetical: a correct survey of this repository was thrown away for citing
 *  src-tauri/onnxruntime/libonnxruntime.dylib, 27MB, present on disk, listed in
 *  .gitignore, and the very file ORT_DYLIB_PATH points at — the agent had
 *  better grounds than the rule that rejected it.
 *
 *  The filesystem still decides, which is the point of existingPaths. A
 *  proposal does not get to assert a path exists; it gets to have the claim
 *  checked. Only paths inside the project are looked at, so this cannot be used
 *  to probe the disk. */
async function confirmCitedPaths(
  output: unknown,
  context: VibeSetupValidationContext,
): Promise<VibeSetupValidationContext> {
  const unconfirmed = [...citedPaths(output)].filter(
    (path) => inside(context.projectRoot, path) && !context.existingPaths.has(path),
  );
  if (!unconfirmed.length) return context;
  const confirmed = await Promise.all(
    unconfirmed.map((path) => ipc.fsStat(path).then(() => path, () => null)),
  );
  const real = confirmed.filter((path): path is string => path !== null);
  if (!real.length) return context;
  return { ...context, existingPaths: new Set([...context.existingPaths, ...real]) };
}

export const DEFAULT_VIBE_PROJECT_SETUP_SESSION_DEPS: VibeProjectSetupSessionDeps = {
  observe: observeVibeSetupRepository,
  run: (input, validation) => runVibeProjectSetupTask({
    ...input,
    validateOutput: async (output) => {
      const result = validateVibeSetupProposal(output, await confirmCitedPaths(output, validation));
      // The rules that rejected it. Without them "invalid-output" says only
      // that forty checks were run and at least one said no, which is the
      // difference between a scope bug, a race with an edit, and the model.
      if (!result.ok) {
        void ipc.jsLog("error", `vibe-setup: proposal failed validation: ${result.errors.join("; ")}`);
      }
      return result.ok;
    },
  }, DEFAULT_VIBE_PROJECT_SETUP_TASK_DEPS),
  providerIds: new Set(["supabase", "neon", "firebase", "stripe", "vercel", "netlify", "cloudflare", "fly"]),
};

type SetupSessionEvent = import("./structuredEvents").StructuredRunnerEvent;
type SetupFlightStatus = "idle" | "running" | "succeeded" | "failed";

interface VibeProjectSetupFlight {
  project: Project;
  persist: (configured: Project) => Promise<boolean>;
  listeners: Set<(event: SetupSessionEvent) => void>;
  state: BuilderSession["state"];
  status: SetupFlightStatus;
  fingerprint: string | null;
  /** When this flight failed, so a remount does not immediately buy another
   *  attempt. See SETUP_RETRY_COOLDOWN_MS. */
  failedAt: number | null;
  abort: AbortController;
  start(): void;
}

/** How long a failed setup stays failed before a remount may try again.
 *
 *  A failure used to drop the flight outright, so the next mount started a
 *  fresh run — and ProjectView mounts on every render pass, every HMR update
 *  and every switch back to the project. Against a project whose setup keeps
 *  failing that is an unbounded loop of model calls, each one able to run the
 *  full timeout before it fails again; roughly sixty launches in twenty
 *  minutes were observed here, most of them 300-second turns, all of them
 *  billed. Retrying is right. Retrying on every render is not, and the person
 *  paying for it has no way to see it happening. */
const SETUP_RETRY_COOLDOWN_MS = 300_000;

/** A setup task belongs to the project and dependency lifetime, not to one
 * React render. ProjectView is intentionally mounted and cleaned up more than
 * once in development, and a person can switch away and back while discovery
 * is running. A WeakMap keeps the production cache app-local and lets injected
 * test dependencies own an isolated cache without a test-only reset hook. */
const setupFlights = new WeakMap<
  VibeProjectSetupSessionDeps,
  Map<string, VibeProjectSetupFlight>
>();

function flightsFor(deps: VibeProjectSetupSessionDeps): Map<string, VibeProjectSetupFlight> {
  let flights = setupFlights.get(deps);
  if (!flights) {
    flights = new Map();
    setupFlights.set(deps, flights);
  }
  return flights;
}

function createVibeProjectSetupFlight(
  project: Project,
  persist: (configured: Project) => Promise<boolean>,
  deps: VibeProjectSetupSessionDeps,
): VibeProjectSetupFlight {
  const flight: VibeProjectSetupFlight = {
    project,
    persist,
    listeners: new Set(),
    state: { persona: { kind: "turn-progress" }, question: null },
    status: "idle",
    fingerprint: null,
    failedAt: null,
    abort: new AbortController(),
    start() {},
  };
  const publish = (event: SetupSessionEvent) => {
    for (const listener of flight.listeners) listener(event);
  };
  const fail = (message: string) => {
    flight.status = "failed";
    flight.failedAt = Date.now();
    flight.state = { persona: { kind: "incident" }, question: null };
    publish({ kind: "reply", text: message });
    // The failed flight is KEPT. Dropping it here made the failure retryable
    // on the next mount, which sounds like resilience and is actually an
    // unbounded loop: ProjectView remounts constantly, so each remount bought
    // another model call. It is released after SETUP_RETRY_COOLDOWN_MS, so a
    // retry still happens — just not sixty times in twenty minutes.
  };
  const execute = async () => {
    publish({ kind: "reply", text: "I'm understanding how this project fits together and starting everything it needs." });
    try {
      const activeProject = flight.project;
      const before = await deps.observe(activeProject);
      const validationContext: VibeSetupValidationContext = {
        projectRoot: before.projectRoot,
        repositoryFingerprint: before.fingerprint,
        existingPaths: before.paths,
        providerIds: deps.providerIds,
        existingComponents: activeProject.components,
      };
      const task = await deps.run({
        projectId: activeProject.id,
        projectName: activeProject.name,
        projectRoot: before.projectRoot,
        componentRoots: before.componentRoots,
        components: activeProject.components,
        inventory: [...before.paths],
        repositoryFingerprint: before.fingerprint,
        onActivity: publish,
        signal: flight.abort.signal,
      }, validationContext);
      if (!task.ok) {
        // Every exit below says the same plain sentence to the person and
        // nothing at all to anyone who has to fix it. The reason code and the
        // run it belongs to are the difference between "the agent couldn't work
        // it out" and knowing the agent never started.
        void ipc.jsLog(
          "error",
          `vibe-setup: task failed (${task.reason}) runId=${task.runId ?? "none"} attempts=${task.attempts}: ${task.message}`,
        );
        fail(task.message);
        return;
      }
      const after = await deps.observe(activeProject);
      // Cited paths are confirmed here too. This is the second of two
      // validation passes — the task checks its own attempt, and this one
      // re-checks against a fresh observation before anything is persisted —
      // and fixing only the first left the real gate rejecting the same
      // correct proposal for the same real file. Two passes over one ruleset
      // means every rule has to be satisfied in both places or the fix is
      // invisible from the outside.
      const validation = validateVibeSetupProposal(task.output, await confirmCitedPaths(task.output, {
        projectRoot: after.projectRoot,
        repositoryFingerprint: after.fingerprint,
        existingPaths: after.paths,
        providerIds: deps.providerIds,
        existingComponents: activeProject.components,
      }));
      if (!validation.ok) {
        // Which rule rejected it, not just that something did. A proposal is
        // refused for one of forty reasons and they are not interchangeable:
        // an unobserved path is a scope bug, a fingerprint mismatch is a race
        // with the person editing, a missing component is the model.
        void ipc.jsLog("error", `vibe-setup: proposal rejected: ${validation.errors.join("; ")}`);
        fail("I couldn't determine a safe complete setup for this project.");
        return;
      }
      const configured = materializeVibeSetup(activeProject, validation.proposal, after.projectRoot).project;
      if (!(await flight.persist(configured))) {
        fail("I understood the project, but couldn't save its setup.");
        return;
      }
      flight.fingerprint = after.fingerprint;
      flight.status = "succeeded";
      flight.state = { persona: { kind: "question-answered" }, question: null };
      publish({ kind: "ready" });
    } catch (error) {
      if (flight.abort.signal.aborted) return;
      // The person is told the same plain thing either way — they cannot act on
      // a stack trace. But the cause has to survive somewhere: this catch
      // covers the whole preflight, including the native file snapshot, which
      // rejects a path outside the registered workspace scope. Discarded, every
      // one of those failures reads as "the agent couldn't work it out" and
      // sends someone hunting the model for a fault in Canopy.
      void ipc.jsLog("error", `vibe-setup: preflight failed: ${String(error)}`);
      fail("I couldn't determine a safe complete setup for this project.");
    }
  };
  flight.start = () => {
    if (flight.status !== "idle") return;
    flight.status = "running";
    // Start after the listener is installed. Besides avoiding work during
    // React render, this makes the first plain-language status observable
    // instead of publishing it into an empty listener set.
    queueMicrotask(() => void execute());
  };
  return flight;
}

/** Chat-shaped only because Build already owns that surface. It has no input
 * actions: setup is automatic, and a failure speaks plainly rather than asking
 * a non-engineer to adjudicate commands or components. */
export function createVibeProjectSetupSession(
  project: Project,
  persist: (configured: Project) => Promise<boolean>,
  deps: VibeProjectSetupSessionDeps = DEFAULT_VIBE_PROJECT_SETUP_SESSION_DEPS,
): BuilderSession & { stop(): Promise<void> } {
  const flights = flightsFor(deps);
  let flight = flights.get(project.id);
  // A known different persisted revision is a different repository setup. An
  // absent revision is commonly the stale ProjectView value from just before
  // this flight persisted; reusing the successful flight prevents that render
  // race from spending a second model call.
  if (
    flight?.status === "succeeded" &&
    project.vibe?.setupRevision &&
    project.vibe.setupRevision !== flight.fingerprint
  ) {
    flights.delete(project.id);
    flight = undefined;
  }
  // A failed flight is held until the cooldown expires, then released so the
  // next mount may try again. Held, it is reused as-is: start() only runs a
  // flight that is idle, so the person keeps seeing the incident instead of
  // watching a new model call begin every time the view remounts.
  if (
    flight?.status === "failed" &&
    flight.failedAt !== null &&
    Date.now() - flight.failedAt >= SETUP_RETRY_COOLDOWN_MS
  ) {
    flights.delete(project.id);
    flight = undefined;
  }
  if (!flight) {
    flight = createVibeProjectSetupFlight(project, persist, deps);
    flights.set(project.id, flight);
  } else if (flight.status === "idle") {
    // Strict Mode may dispose the first facade before Build subscribes. Use the
    // freshest project and persistence callback when the shared flight starts.
    flight.project = project;
    flight.persist = persist;
  }
  const ownedListeners = new Set<(event: SetupSessionEvent) => void>();
  let stopped = false;
  return {
    get state() { return flight.state; },
    events$: {
      subscribe(listener) {
        if (stopped) return () => {};
        // The same callback may be used by two facades. Give each subscription
        // its own identity so stopping one view cannot detach the other.
        const ownedListener = (event: SetupSessionEvent) => listener(event);
        ownedListeners.add(ownedListener);
        flight.listeners.add(ownedListener);
        if (flight.status === "succeeded") {
          queueMicrotask(() => {
            if (!stopped && ownedListeners.has(ownedListener)) ownedListener({ kind: "ready" });
          });
        } else {
          flight.start();
        }
        return () => {
          ownedListeners.delete(ownedListener);
          flight.listeners.delete(ownedListener);
        };
      },
    },
    send: async () => {},
    stop: async () => {
      stopped = true;
      for (const listener of ownedListeners) flight.listeners.delete(listener);
      ownedListeners.clear();
      // Deliberately do not abort: this facade is owned by one ProjectView
      // mount, while the bounded setup flight is owned by the project. A
      // switch or Strict Mode cleanup must not spend another reservation and
      // model call when the person comes back.
    },
  };
}

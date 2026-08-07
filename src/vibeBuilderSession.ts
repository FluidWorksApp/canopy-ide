import * as ipc from "./ipc";
import {
  createProjectRunner,
  type ProjectRunnerController,
  type ProjectRunnerTransport,
} from "./projectRunner";
import { renderPtyText } from "./ptyText";
import type { StructuredRunnerEvent } from "./structuredEvents";
import type { StructuredRunnerLaunch } from "./structuredRunners";
import {
  appendTaskEvent,
  reserveAttempt,
  reserveTask,
  settleAttempt,
  startAttempt,
  writeTaskArtifact,
} from "./taskEnvelopes";
import type { TaskReservation } from "./taskEnvelope";
import type { TaskAttemptSettlement } from "./taskEnvelope";
import { appendTranscript } from "./taskTranscript";
import { fleetGate } from "./fleetState";
import { redactSecrets } from "./vibeSecretScan";
import {
  proposeAbstraction,
  type AbstractionContext,
  type AbstractionProposal,
} from "./vibeAbstractions";
import {
  runAbstractionPlan,
  type AbstractionRunResult,
} from "./vibeAbstractionRunner";
import { parseVibeIntent, type VibeIntent } from "./vibeIntent";
import { PUBLISH_CONFIRMATION, detectDeployProvider } from "./vibeDeploy";
import { providerById } from "./vibeServices";
import { probeCli, type CliProbeDeps } from "./vibeCliProbe";
import { inspectFleetRoute } from "./fleetSnapshot";
import { choicesFor } from "./modelCatalog";
import { AGENT_CLIS, checkCliUpdates, checkInstalledClis } from "./projects";
import type { ComponentRole, RunCommand } from "./projects";
import type { RepairProblem } from "./vibeRepair";
import type { VibeRepairTaskInput, VibeRepairTaskResult } from "./vibeRepairSession";
import { DEFAULT_PROFILE, launchEnvSync, launchProfile } from "./profiles";
import { grantFor } from "./workspaceAuthority";
import {
  FAMILY_FOR_CLI,
  failoverDecision,
  rankRoutes,
  resolveRoute,
  unresolvedRoute,
  type AttemptOutcomeRecord,
  type ResolvedRoute,
  type RouteCandidate,
  type SelectedRoute,
} from "./vibeFailover";
import {
  autoCheckpointObserved,
  recordAutoCheckpointObserved,
} from "./vibeAutoCheckpoint";
import {
  describeSecretFindings,
  scanDiffForSecrets,
  type SecretScanResult,
} from "./vibeSecretScan";
import {
  checkpointDecision,
  type CheckpointContext,
} from "./vibeCheckpoints";
import {
  capturedNetworkObservation,
  judgeVerification,
  type ObservationKind,
  type VerificationContract,
  type VerificationObservation,
  type VerificationOutcome,
} from "./vibeVerification";
import type {
  BuilderQuestion,
  BuilderQuestionAction,
  BuilderSession,
  BuilderSessionState,
} from "./vibeBuilderSessionTypes";

const SAVE_CHECKPOINT = "Save this version";
/** Sentinels a question's own buttons send back. Deliberately not words anyone
 *  would type, so a coincidental "yes" in a build request can never be read as
 *  approval for something the user has scrolled past. */
const ABSTRACTION_CONFIRM = "vibe:abstraction:confirm";
const ABSTRACTION_DECLINE = "vibe:abstraction:decline";
const HARNESS_VERSION = "vibe-mvp-1";
const PROMPT_VERSION = "vibe-builder-1";
const TOOL_POLICY_VERSION = "workspace-write-no-shell-1";
const VIBE_ATTEMPT_CAP = 3;
const ROUTE_VERSIONS = {
  harnessVersion: HARNESS_VERSION,
  promptVersion: PROMPT_VERSION,
  toolPolicyVersion: TOOL_POLICY_VERSION,
};

export interface VibeBuilderSessionOptions {
  projectId: string;
  projectName: string;
  componentId: string;
  componentPath: string;
  cliId: string;
  cliBin: string;
  checkCommand?: string | string[] | null;
  /** Why there is no check command, when there is none — the one sentence
   *  `inferVibeCheck` produces for a project a non-coder set up. Without it the
   *  turn records `check: unknown` forever and says nothing about why, which
   *  leaves a permanently `incomplete` turn looking like a Canopy fault rather
   *  than a missing script the user can add in one line. */
  checkCaveat?: string | null;
  /** The project's other component directories. Writable alongside the
   *  component's own root: a monorepo change that stops at one package is not
   *  a change, and a project's own components are not "somewhere else". */
  siblingPaths?: readonly string[];
  /** Everything the survey established this component can run, so a repair
   *  agent prefers the project's own commands over inventing its own. */
  componentCommands?: readonly RunCommand[];
  previewTabId(): string | null;
}

export interface TurnBaseline {
  cleanAtStart: boolean;
  head: string | null;
  isolated: boolean;
  repoRoot: string;
}

export interface CheckRunResult {
  observation: VerificationObservation;
  output: string;
}

export interface BrowserInspection {
  observations: VerificationObservation[];
  screenshot?: string | null;
}

export interface VibeServerIncidentInput {
  key: string;
  componentId: string;
  runCommandId: string;
  exitCode: number | null;
  crashTimes: number[];
  automaticRestarts: number;
  ports: number[];
  outputBytes: number | null;
  totalCpu: number | null;
  totalMemBytes: number | null;
  logTail: string | Promise<string>;
  /** False for a historical persistence retry after the server recovered. */
  present?: boolean;
  /** Captured once at observation time and retained across persistence retries. */
  activeAttempt?: { runId: string; attemptId: string } | null;
  /** What the caller knows about the crashing component, handed to repair so
   *  the troubleshooter starts from facts rather than rediscovery. Optional:
   *  an incident with no context still gets repaired, from the log alone. */
  component?: { label: string; path: string; role?: ComponentRole };
  /** Every command the survey attached to that component — the repair agent
   *  must prefer these over inventing its own. */
  commands?: RunCommand[];
  /** The crashing command itself, by name and spelling. */
  command?: { name: string; command: string };
}

export interface CheckpointReview {
  context: CheckpointContext;
  repoRoot: string;
  paths: string[];
  diff: string;
  /** What the credential scan found in that diff, so the refusal can name the
   *  rule and the place. Never the matched value — see vibeSecretScan. */
  secrets?: SecretScanResult;
}

/** How a running abstraction reports itself to whoever owns it.
 *
 *  A managed abstraction is the one thing a session starts that outlives the
 *  agent transport: `vercel --prod` keeps running after the project window is
 *  gone, and nothing else in the session holds a handle to it. These callbacks
 *  hand that handle to the session so `stop()` has something to stop. */
export interface AbstractionOwnership {
  /** Called once, as soon as the plan has a process, with the means to end it. */
  spawned(handle: AbstractionHandle): void;
  /** Called for every pty exit the run observes; the owner matches on id. */
  exited(ptyId: number): void;
}

export interface AbstractionHandle {
  id: number;
  kill(): Promise<void>;
}

export interface VibeBuilderSessionDeps {
  runner: ProjectRunnerController;
  reserve: typeof reserveTask;
  startAttempt: typeof startAttempt;
  settleAttempt: typeof settleAttempt;
  appendTranscript: typeof appendTranscript;
  appendEvent: typeof appendTaskEvent;
  writeArtifact: typeof writeTaskArtifact;
  captureBaseline(cwd: string): Promise<TurnBaseline>;
  runCheck(command: string | string[] | null, cwd: string, at: number): Promise<CheckRunResult>;
  beginBrowserTurn(tabId: string | null): Promise<boolean>;
  inspectBrowser(
    tabId: string | null,
    visual: boolean,
    at: number,
    networkScoped: boolean,
  ): Promise<BrowserInspection>;
  reviewCheckpoint(args: {
    cwd: string;
    baseline: TurnBaseline;
    verification: VerificationOutcome;
    noOpenIncident: boolean;
  }): Promise<CheckpointReview>;
  commit(cwd: string, paths: string[], message: string): Promise<string>;
  /** Has a checkpoint commit ever been observed to work on this machine? See
   *  vibeAutoCheckpoint: until one has, the automatic commit is proposed
   *  instead of made, however green the policy. */
  autoCheckpointObserved(): boolean;
  /** Called only after a checkpoint commit actually returned. */
  recordAutoCheckpointObserved(): void;
  /** Replace the run's surface metadata, so a settled turn can carry its own
   *  verification summary into the task panels. */
  updateMetadata(runId: string, metadata: unknown): Promise<unknown>;
  reserveAttempt: typeof reserveAttempt;
  /** Every route Canopy could launch this turn on, with its fleet state. */
  listRoutes(): Promise<RouteCandidate[]>;
  /** Runs one repair task for a reported problem. Injectable so tests never
   *  launch an agent; the default dynamic-imports the runtime, because a
   *  static import of vibeRepairSession → vibeProjectSetup → this module
   *  would close a cycle at init time. */
  repair?(input: VibeRepairTaskInput): Promise<VibeRepairTaskResult>;
  /** Installed version of a CLI, or null when it cannot be probed. */
  cliVersion(cli: string): Promise<string | null>;
  /** Everything the managed-abstraction planners need to judge a request:
   *  the lockfile situation, what is already installed, whether the env file is
   *  tracked, whether the tree is clean. Read fresh per proposal — a plan built
   *  from a stale tree could publish something the user has since changed. */
  abstractionContext(cwd: string, intent: VibeIntent): Promise<AbstractionContext>;
  /** Execute a planned argv. Argv-native by contract: no implementation may
   *  join these into a shell string.
   *
   *  `ownership` is optional so a caller that only wants the result can ignore
   *  it, but the session always passes one: an unowned `vercel --prod` is a
   *  process nobody can stop. */
  runAbstraction(
    argv: string[],
    cwd: string,
    ownership?: AbstractionOwnership,
  ): Promise<AbstractionRunResult>;
  now(): number;
  sessionId(): string;
  sleep(ms: number): Promise<void>;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function nativeRunner(): ProjectRunnerController {
  const controls = new Map<string, string>();
  return createProjectRunner({
    spawn: async (attemptId, opts, onData) => {
      const control = randomId();
      await ipc.structuredRunnerSpawn(attemptId, control, opts, onData);
      controls.set(attemptId, control);
    },
    write: (attemptId, line) => {
      const control = controls.get(attemptId);
      if (!control) return Promise.reject(new Error("structured runner control is missing"));
      return ipc.structuredRunnerWrite(attemptId, control, line);
    },
    kill: async (attemptId) => {
      const control = controls.get(attemptId);
      if (!control) throw new Error("structured runner control is missing");
      try {
        await ipc.structuredRunnerKill(attemptId, control);
      } finally {
        controls.delete(attemptId);
      }
    },
  });
}

async function runDetachedCheck(
  command: string | string[] | null,
  cwd: string,
  at: number,
): Promise<CheckRunResult> {
  if (!command) {
    return {
      observation: {
        kind: "check",
        verdict: "unknown",
        note: "no configured check command is available",
        at,
      },
      output: "",
    };
  }

  let target: number | null = null;
  const early: ipc.PtyExit[] = [];
  let finish!: (event: ipc.PtyExit | null) => void;
  const exited = new Promise<ipc.PtyExit | null>((resolve) => {
    finish = resolve;
  });
  const unlisten = await ipc.onPtyExit((event) => {
    if (target == null) early.push(event);
    else if (event.id === target) finish(event);
  });
  try {
    const spawned = Array.isArray(command)
      ? await ipc.ptySpawnArgv({ cwd, argv: command })
      : await ipc.ptySpawnDetached({ cwd, command });
    target = spawned.id;
    const already = early.find((event) => event.id === target);
    if (already) finish(already);
    const timeout = window.setTimeout(() => finish(null), 10 * 60 * 1000);
    const result = await exited;
    window.clearTimeout(timeout);
    if (!result) await ipc.ptyKill(target);
    const raw = (await ipc.ptyOutput(target, 128 * 1024)) ?? "";
    const output = await renderPtyText(raw, { maxChars: 24_000 });
    if (!result) {
      return {
        observation: {
          kind: "check",
          verdict: "unknown",
          note: `configured check timed out: ${Array.isArray(command) ? command.join(" ") : command}`,
          at,
        },
        output,
      };
    }
    const passed = result.exit_code === 0;
    return {
      observation: {
        kind: "check",
        verdict: passed ? "pass" : "fail",
        note: passed
          ? `configured check passed: ${Array.isArray(command) ? command.join(" ") : command}`
          : `configured check failed with exit ${result.exit_code ?? "signal"}: ${Array.isArray(command) ? command.join(" ") : command}`,
        at,
      },
      output,
    };
  } finally {
    unlisten();
  }
}

function unknownBrowser(at: number, visual: boolean, note: string): BrowserInspection {
  const kinds: ObservationKind[] = ["server", "console", "network"];
  if (visual) kinds.push("screenshot");
  return {
    observations: kinds.map((kind) => ({ kind, verdict: "unknown", note, at })),
  };
}

async function inspectNativeBrowser(
  tabId: string | null,
  visual: boolean,
  at: number,
  networkScoped: boolean,
): Promise<BrowserInspection> {
  if (!tabId) return unknownBrowser(at, visual, "no project preview is available");
  const before = await ipc.browserHere(tabId).catch(() => null);
  if (!before?.url) return unknownBrowser(at, visual, "the project preview has not loaded a route");
  const turnNetwork = networkScoped
    ? await ipc.browserRunOp(tabId, { op: "network", lines: 300 }).catch(() => null)
    : null;
  const beforeDocument = await ipc
    .browserRunOp(tabId, { op: "eval", code: "performance.timeOrigin" })
    .catch(() => null);
  const beforeOrigin = (beforeDocument?.data as { result?: number } | undefined)
    ?.result;
  const reloaded = await ipc.browserNavigate(tabId, null, "reload").then(
    () => true,
    () => false,
  );
  if (!reloaded)
    return unknownBrowser(at, visual, "the project preview could not be reloaded");
  let here: { url: string; title: string } | null = null;
  let painted = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    [here, painted] = await Promise.all([
      ipc.browserHere(tabId).catch(() => null),
      ipc.browserPainted(tabId).catch(() => false),
    ]);
    if (here?.url && painted) break;
  }
  if (!here?.url || !painted) {
    return unknownBrowser(at, visual, "the project preview did not paint after a fresh reload");
  }

  // Paint can precede fetch/XHR completion. Wait for the reloaded document to
  // be complete and for the in-page request counter to go quiet before reading
  // the evidence; an empty log while work is still in flight is not a pass.
  let reloadNetwork: Awaited<ReturnType<typeof ipc.browserRunOp>> = null;
  let reloadSettled = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    const [ready, network] = await Promise.all([
      ipc
        .browserRunOp(tabId, {
          op: "eval",
          code: "({ready:document.readyState, origin:performance.timeOrigin})",
        })
        .catch(() => null),
      ipc.browserRunOp(tabId, { op: "network", lines: 300 }).catch(() => null),
    ]);
    reloadNetwork = network;
    const data = network?.data as
      | { pending?: number; lastActivityAt?: number }
      | undefined;
    const readyData = ready?.data as
      | { result?: { ready?: string; origin?: number } }
      | undefined;
    if (
      ready?.done &&
      ready.ok &&
      readyData?.result?.ready === "complete" &&
      typeof beforeOrigin === "number" &&
      readyData.result.origin !== beforeOrigin &&
      network?.done &&
      network.ok &&
      data?.pending === 0 &&
      Date.now() - (data.lastActivityAt ?? Date.now()) >= 300
    ) {
      reloadSettled = true;
      break;
    }
  }

  const observations: VerificationObservation[] = [
    {
      kind: "server",
      verdict: "pass",
      note: `preview answered at ${here.url}`,
      evidence: here.url,
      at,
    },
  ];

  const consoleAck = await ipc
    .browserRunOp(tabId, { op: "console", lines: 100 })
    .catch(() => null);
  const consoleData = consoleAck?.data as
    | { messages?: { level?: string; text?: string }[] }
    | undefined;
  if (!consoleAck?.done || !consoleAck.ok || !Array.isArray(consoleData?.messages)) {
    observations.push({
      kind: "console",
      verdict: "unknown",
      note: "the preview console could not be read",
      at,
    });
  } else {
    const errors = consoleData.messages.filter((message) => message.level === "error");
    observations.push({
      kind: "console",
      verdict: errors.length ? "fail" : "pass",
      note: errors.length
        ? `${errors.length} console error${errors.length === 1 ? "" : "s"} (first: ${errors[0].text ?? "unknown"})`
        : "no console errors",
      at,
    });
  }

  const captures = [turnNetwork, reloadNetwork].map((ack) => {
    const data = ack?.data as
      | {
          requests?: Parameters<typeof capturedNetworkObservation>[0];
          total?: number;
          pending?: number;
        }
      | undefined;
    return { ack, data };
  });
  const networkComplete =
    networkScoped &&
    reloadSettled &&
    captures.every(
      ({ ack, data }) =>
        ack?.done &&
        ack.ok &&
        Array.isArray(data?.requests) &&
        Number.isInteger(data?.pending) &&
        data!.pending === 0 &&
        Number.isInteger(data?.total) &&
        data!.total! >= 0 &&
        data!.total! <= data!.requests!.length,
    );
  const requests = captures.flatMap(({ data }) => data?.requests ?? []);
  observations.push(
    networkComplete
      ? capturedNetworkObservation(requests, at)
      : {
          kind: "network",
          verdict: "unknown",
          note: networkScoped
            ? "the preview network log was incomplete, truncated, or still active"
            : "the preview network log could not be scoped to this turn",
          at,
        },
  );

  let screenshot: string | null = null;
  if (visual) {
    try {
      screenshot = (await ipc.browserSnapshot(tabId, 1200, "jpeg")).image;
      observations.push({
        kind: "screenshot",
        verdict: "pass",
        note: "captured the project preview",
        at,
      });
    } catch {
      observations.push({
        kind: "screenshot",
        verdict: "unknown",
        note: "the project preview could not be captured",
        at,
      });
    }
  }
  return { observations, screenshot };
}

const normalized = (path: string) => path.replaceAll("\\", "/").replace(/\/$/, "");
const overlaps = (a: string, b: string) =>
  normalized(a) === normalized(b) ||
  normalized(a).startsWith(`${normalized(b)}/`) ||
  normalized(b).startsWith(`${normalized(a)}/`);

function worktreeFor(worktrees: ipc.WorktreeInfo[], cwd: string): ipc.WorktreeInfo | undefined {
  const here = normalized(cwd);
  return worktrees
    .filter((entry) => here === normalized(entry.path) || here.startsWith(`${normalized(entry.path)}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

async function captureGitBaseline(cwd: string): Promise<TurnBaseline> {
  const [status, worktrees] = await Promise.all([
    ipc.gitStatus(cwd),
    ipc.gitWorktrees(cwd).catch(() => []),
  ]);
  const tree = worktreeFor(worktrees, cwd);
  const repoRoot = tree?.path ?? cwd;
  const relevant = scopedGitEntries(status.entries, repoRoot, cwd);
  return {
    cleanAtStart: status.is_repo && relevant.length === 0,
    head: tree?.head ?? null,
    isolated: Boolean(tree && !tree.is_main),
    repoRoot,
  };
}

export function scopedGitEntries(
  entries: ipc.GitStatusResult["entries"],
  repoRoot: string,
  componentPath: string,
): ipc.GitStatusResult["entries"] {
  const root = normalized(repoRoot);
  const component = normalized(componentPath);
  return entries.filter((entry) => {
    if (entry.status === "!!") return false;
    const path = /^(?:[A-Za-z]:\/|\/)/.test(normalized(entry.path))
      ? normalized(entry.path)
      : `${root}/${normalized(entry.path)}`;
    return path === component || path.startsWith(`${component}/`);
  });
}

async function reviewGitCheckpoint(args: {
  cwd: string;
  baseline: TurnBaseline;
  verification: VerificationOutcome;
  noOpenIncident: boolean;
}): Promise<CheckpointReview> {
  const [status, worktrees, claims] = await Promise.all([
    ipc.gitStatus(args.cwd),
    ipc.gitWorktrees(args.cwd).catch(() => []),
    ipc.contextClaims().catch(() => []),
  ]);
  const tree = worktreeFor(worktrees, args.cwd);
  const repoRoot = tree?.path ?? args.baseline.repoRoot;
  const entries = scopedGitEntries(status.entries, repoRoot, args.cwd);
  const paths = entries.map((entry) => entry.path);
  const absolutePaths = paths.map((path) =>
    path.startsWith("/") ? path : `${normalized(repoRoot)}/${path}`,
  );
  const pathsExclusive = !claims.some((claim) =>
    claim.paths.some((claimed) => absolutePaths.some((path) => overlaps(claimed, path))),
  );
  const patches = await Promise.all(
    entries.map(async (entry) => {
      const [staged, unstaged] = await Promise.all([
        ipc.gitDiff(repoRoot, entry.path, true).catch(() => ""),
        ipc.gitDiff(repoRoot, entry.path, false).catch(() => ""),
      ]);
      const patch = [staged && "# staged\n" + staged, unstaged && "# unstaged\n" + unstaged]
        .filter(Boolean)
        .join("\n");
      return `# ${entry.status} ${entry.path}\n${patch || "(content is not available in the diff yet)"}`;
    }),
  );
  const diff = patches.join("\n\n");
  // The scan is over the diff about to be committed, and it throws nothing: a
  // scanner that could fail would make "clean" mean "did not crash". Any
  // failure to *produce* a result is still unknown, and unknown fails closed —
  // which is why the result is computed here and read once, rather than being
  // recomputed by whoever needs the boolean.
  const secrets = scanDiffForSecrets(diff);
  return {
    context: {
      isolatedOrGreenfield: args.baseline.isolated,
      cleanAtTurnStart: args.baseline.cleanAtStart,
      lineageUnchanged:
        args.baseline.head != null && tree?.head === args.baseline.head,
      pathsExclusive,
      secretScanClean: secrets.clean,
      noOpenIncident: args.noOpenIncident,
      verification: args.verification,
    },
    repoRoot,
    paths,
    diff,
    secrets,
  };
}

/** Every CLI Canopy could route this project onto, with its live fleet state
 *  and the models that family currently offers. Only CLIs with a known family
 *  are candidates — a route whose family we cannot name cannot be ranked. */
async function listNativeRoutes(): Promise<RouteCandidate[]> {
  const installed = await checkInstalledClis();
  const candidates = await Promise.all(
    Object.entries(FAMILY_FOR_CLI).map(async ([cli, family]) => {
      const def = AGENT_CLIS.find((c) => c.id === cli);
      if (!def || installed[def.bin] !== true) return null;
      const profileId = launchProfile(cli) ?? DEFAULT_PROFILE;
      const snapshot = await inspectFleetRoute(def, profileId, installed);
      return {
        cli,
        profileId,
        family,
        state: snapshot.state,
        choices: choicesFor(family),
      } satisfies RouteCandidate;
    }),
  );
  return candidates.filter((c): c is RouteCandidate => c !== null);
}

async function nativeCliVersion(cli: string): Promise<string | null> {
  const bin = AGENT_CLIS.find((c) => c.id === cli)?.bin;
  if (!bin) return null;
  const versions = await checkCliUpdates();
  return versions[bin]?.installed ?? null;
}

/** Probing runs a CLI, so it goes through the same argv-only path an
 *  abstraction does. A single shared object because the probe cache is keyed on
 *  deps identity: one instance means one process spends `vercel --version` once
 *  per app run rather than once per message.
 *
 *  Deliberately NOT session-owned, unlike the execution path below. This is a
 *  decision, not an omission: `--version` is idempotent and already capped at
 *  10 seconds, so killing it when a session stops buys nothing and adds a
 *  failure path — and the cache is shared across sessions, so one session's
 *  stop would be tearing down a probe another session is awaiting. The
 *  execution path is unbounded and side-effecting, which is the entire reason
 *  stop() needs a handle on that one. */
const nativeCliProbeDeps: CliProbeDeps = {
  runArgv: ({ argv }) =>
    runAbstractionPlan(argv, ".", {
      ptySpawnDetached: (opts) => ipc.ptySpawnArgv(opts),
      onPtyExit: (listener) =>
        ipc.onPtyExit((e) => listener({ id: e.id, exit_code: e.exit_code ?? null })),
      ptyOutput: ipc.ptyOutput,
      ptyKill: ipc.ptyKill,
      timeoutMs: 10_000,
    }),
};

/** Read the project as the abstraction planners need to see it.
 *
 *  Everything here is observed, never assumed: a missing package.json means no
 *  dependencies rather than a guess, and an unreadable tree means the caller
 *  gets an error instead of a plan built on defaults. */
async function nativeAbstractionContext(
  cwd: string,
  intent: VibeIntent,
): Promise<AbstractionContext> {
  const [entries, status, worktrees, pkg] = await Promise.all([
    ipc.fsReadDir(cwd).then((list) => list.map((e) => e.name)),
    ipc.gitStatus(cwd).catch(() => null),
    ipc.gitWorktrees(cwd).catch(() => []),
    ipc.fsReadFile(`${cwd}/package.json`)
      .then((bytes) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>)
      .catch(() => null),
  ]);

  const record = (value: unknown): Record<string, string> =>
    value && typeof value === "object" ? (value as Record<string, string>) : {};

  // git_status runs with --ignored, so every node_modules entry arrives here
  // as `!!`. Counting those as changes would report every real project as
  // permanently dirty and refuse every publish.
  const all = status?.entries ?? [];
  const ignored = (s: string) => s.includes("!");
  const untracked = (s: string) => s.includes("?");
  const changed = all.filter((e) => !ignored(e.status));

  // A tree we could not read is not a clean tree. `dirty` guards production
  // publishes, so the unreadable case must refuse rather than wave through:
  // git_status returns an empty default for a non-repo directory, which would
  // otherwise read as "nothing changed, go ahead".
  const dirty = !status?.is_repo || changed.length > 0;

  // Whether the env file is TRACKED decides whether writing a service-role key
  // into it would publish that key on the next commit. It has to be positively
  // determined, and the failure mode has to be refusal.
  //
  // git status alone cannot answer it: a tracked file with no local edits does
  // not appear in the output at all, so "absent from status" would read as
  // untracked — the fail-OPEN direction, and the one that leaks. So absence is
  // only safe when the file does not exist yet, which the directory listing
  // says. Everything else defaults to tracked.
  const envFileFor = (): string | null => {
    if (intent.kind !== "link") return null;
    return providerById(intent.provider)?.envFile ?? null;
  };
  const envFile = envFileFor();

  // Anchored to THIS component, not matched by name across the repo.
  //
  // An earlier version took the first entry whose path ended in the file's
  // basename, which in a monorepo is the wrong file and fails open. Given
  // /repo/.env.local gitignored (so present as `!!`) and
  // /repo/apps/web/.env.local committed (so absent from status entirely), the
  // suffix match found the root file, read "ignored, therefore safe", and the
  // absence rule below — which would have refused — never ran. The user would
  // have been told the file stays out of git while writing a key into one git
  // carries.
  //
  // The component is the right anchor because it is the file the plan writes
  // to: planLink's write-env step targets the provider's env file in the
  // working directory, and no other copy is involved.
  const repoRoot = worktreeFor(worktrees, cwd)?.path ?? cwd;
  const absolute = (p: string) =>
    /^(?:[A-Za-z]:\/|\/)/.test(normalized(p))
      ? normalized(p)
      : `${normalized(repoRoot)}/${normalized(p)}`;
  const envPath = envFile ? `${normalized(cwd)}/${envFile}` : null;
  const envStatus = envPath
    ? all.find((e) => absolute(e.path) === envPath)
    : undefined;
  const envFileTracked = !envFile
    ? false
    : envStatus
      ? // Ignored or untracked are the two states that mean "git will not
        // carry this". Any other status means git already knows the file.
        !(ignored(envStatus.status) || untracked(envStatus.status))
      : // Not in status: safe only if it does not exist. If it exists and git
        // is silent about it, it is tracked and unmodified — refuse.
        entries.includes(envFile);

  // Which CLI matters depends on what was asked, so only that one is probed —
  // and only when the answer can change the plan. An unprobed CLI reads as
  // absent, because claiming one exists produces a plan whose first step fails
  // for a reason the user cannot see.
  const linkBin = intent.kind === "link" ? providerById(intent.provider)?.cli?.bin : undefined;
  const deployBin =
    intent.kind === "deploy" ? detectDeployProvider(entries)?.bin : undefined;
  const [linkCliPresent, deployCliPresent] = await Promise.all([
    linkBin ? probeCli(linkBin, nativeCliProbeDeps) : Promise.resolve(false),
    deployBin ? probeCli(deployBin, nativeCliProbeDeps) : Promise.resolve(false),
  ]);

  return {
    cwd,
    entries,
    packageManagerField:
      typeof pkg?.packageManager === "string" ? pkg.packageManager : null,
    dependencies: record(pkg?.dependencies),
    devDependencies: record(pkg?.devDependencies),
    link: {
      cliInstalled: linkCliPresent,
      authenticated: false,
      presentSecrets: [],
      envFileTracked,
    },
    deploy: {
      dirty,
      cliInstalled: deployCliPresent,
    },
  };
}

export const DEFAULT_VIBE_BUILDER_DEPS: VibeBuilderSessionDeps = {
  abstractionContext: nativeAbstractionContext,
  runAbstraction: (argv, cwd, ownership) =>
    runAbstractionPlan(argv, cwd, {
      // Argv crosses to Rust as an array and is spawned without a shell.
      // Wrapped rather than passed straight through so the owner learns the
      // pty id: runAbstractionPlan keeps that id to itself and only kills on
      // its own timeout, which leaves a stopped session's deploy running.
      ptySpawnDetached: async (opts) => {
        const spawned = await ipc.ptySpawnArgv(opts);
        ownership?.spawned({ id: spawned.id, kill: () => ipc.ptyKill(spawned.id) });
        return spawned;
      },
      onPtyExit: (listener) =>
        ipc.onPtyExit((e) => {
          // Every pty exit passes here, not just ours; the owner matches on id.
          ownership?.exited(e.id);
          listener({ id: e.id, exit_code: e.exit_code ?? null });
        }),
      ptyOutput: ipc.ptyOutput,
      ptyKill: ipc.ptyKill,
    }),
  runner: nativeRunner(),
  reserve: reserveTask,
  startAttempt,
  settleAttempt,
  appendTranscript,
  appendEvent: appendTaskEvent,
  writeArtifact: writeTaskArtifact,
  captureBaseline: captureGitBaseline,
  runCheck: runDetachedCheck,
  beginBrowserTurn: async (tabId) => {
    if (!tabId) return false;
    const [, network] = await Promise.all([
      ipc.browserRunOp(tabId, { op: "console", lines: 1, clear: true }).catch(() => null),
      ipc.browserRunOp(tabId, { op: "network", lines: 1, clear: true }).catch(() => null),
    ]);
    return Boolean(network?.done && network.ok);
  },
  inspectBrowser: inspectNativeBrowser,
  reviewCheckpoint: reviewGitCheckpoint,
  commit: (cwd, paths, message) =>
    paths.length === 0 ? Promise.resolve("") : ipc.gitCommitPaths(cwd, message, paths),
  autoCheckpointObserved,
  recordAutoCheckpointObserved,
  updateMetadata: ipc.taskUpdateMetadata,
  reserveAttempt,
  listRoutes: listNativeRoutes,
  cliVersion: nativeCliVersion,
  now: () => Date.now(),
  sessionId: randomId,
  sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
};

function visualTask(goal: string): boolean {
  return /\b(visual|layout|style|colour|color|page|screen|button|form|responsive|mobile|desktop|pixel|design)\b/i.test(
    goal,
  );
}

function contractFor(goal: string): VerificationContract {
  const required: ObservationKind[] = ["check", "server", "console", "network"];
  if (visualTask(goal)) required.push("screenshot");
  return { required };
}

function verificationSummary(
  contract: VerificationContract,
  observations: VerificationObservation[],
  outcome: VerificationOutcome,
  checkCaveat: string | null,
): string {
  const unknown = contract.required.filter(
    (kind) => observations.find((observation) => observation.kind === kind)?.verdict !== "pass",
  );
  if (outcome === "verified") return "I checked the configured command and local preview — all required evidence passed.";
  const failed = observations.filter((observation) => observation.verdict === "fail");
  if (failed.length) return `Verification found a problem: ${failed.map((item) => item.note).join("; ")}`;
  // The caveat rides on every incomplete turn, not just the first. A project
  // with no check script is permanently incomplete, and being told once, in a
  // message that scrolled away, is how a permanent state reads as a glitch.
  return `Verification is incomplete: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} still unknown.${
    checkCaveat ? ` ${checkCaveat}` : ""
  }`;
}

const refusalText: Record<string, string> = {
  "shared-or-converted-dirty": "this is not a dedicated isolated worktree",
  "dirty-at-start": "the checkout already had changes when the turn began",
  "lineage-moved": "the branch moved during the turn",
  "paths-contested": "another session claims one of the changed paths",
  "secrets-flagged": "the changed lines look like they contain a credential",
  "incident-open": "a safety incident is still open",
  "not-verified": "the required verification is not fully green",
};

/** What the reader is told when the policy said yes and the gate still held.
 *  Deliberately about Canopy, not about their change: nothing is wrong with the
 *  turn, and a message that implied otherwise would train someone to distrust a
 *  verified result. */
const FIRST_CHECKPOINT_DETAIL =
  "everything required passed, but Canopy has never saved a version automatically on this computer — the first one is yours to confirm, and after that verified turns save themselves";

export class VibeBuilderSession implements BuilderSession {
  private pendingAbstraction: {
    proposal: Extract<AbstractionProposal, { kind: "run" }>;
    /** Exactly what the user must say. For production this is the publish
     *  phrase, which is why it is compared and never offered as a button. */
    confirm: string;
    requiresTypedPhrase: boolean;
  } | null = null;
  /** The process a confirmed abstraction is running in, for exactly as long as
   *  it is running. Held because nothing else does: runAbstractionPlan keeps
   *  the pty id in a local and kills only on its own timeout, so without this a
   *  session that is stopped mid-`vercel --prod` leaves that deploy running
   *  with no owner left to stop it. */
  private runningAbstraction: AbstractionHandle | null = null;
  private snapshot: BuilderSessionState = { persona: { kind: "idle" }, question: null };
  private listeners = new Set<(event: StructuredRunnerEvent) => void>();
  private reservation: TaskReservation | null = null;
  private transport: ProjectRunnerTransport | null = null;
  private launching: Promise<ProjectRunnerTransport> | null = null;
  private verifying: Promise<void> | null = null;
  private baseline: TurnBaseline | null = null;
  private assistant = "";
  private incidentOpen = false;
  private serverIncidentOpen = false;
  private runtimeIncidentOpen = false;
  private settled = false;
  private stopped = false;
  /** Changes whenever a new turn starts or the current one is cancelled. Async
   * verification and launch work must still belong to this value before they
   * are allowed to present anything. */
  private turnEpoch = 0;
  private closedAttempts = new Set<string>();
  private hasRun = false;
  private cliSessionId: string;
  private sendQueue: Promise<void> = Promise.resolve();
  private finishTurn: (() => void) | null = null;
  private pendingCheckpoint: {
    review: CheckpointReview;
    verification: VerificationOutcome;
  } | null = null;
  private persistQueue: Promise<void> = Promise.resolve();
  private networkScoped = false;
  private serverIncidentKeys = new Set<string>();
  private unsettledServerAttempts = new Map<string, TaskAttemptSettlement>();
  private activeRoute: ResolvedRoute | null = null;
  /** Every settled attempt on this run, so a signature that has failed on two
   *  routes can be recognised as being about the task. */
  private attemptHistory: AttemptOutcomeRecord[] = [];
  /** The last thing the runner complained about, as failure evidence. */
  private lastRunnerError = "";
  /** The most recent verification outcome this session actually reached.
   *  Starts "incomplete" because nothing has been checked yet — which is the
   *  truth, and which refuses a production publish until something has. */
  private lastVerification: VerificationOutcome = "incomplete";
  /** The message being worked on, replayed verbatim onto a reseeded attempt. */
  private currentGoal: string | null = null;
  /** The surface metadata this run was reserved with. Held whole because
   *  `taskUpdateMetadata` replaces the blob rather than patching it, so the
   *  summary can only be added by rewriting what was there. */
  private turnMetadata: Record<string, unknown> | null = null;
  private attemptsUsed = 0;
  private options: VibeBuilderSessionOptions;
  private deps: VibeBuilderSessionDeps;

  readonly events$ = {
    subscribe: (listener: (event: StructuredRunnerEvent) => void) => {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    },
  };

  constructor(
    options: VibeBuilderSessionOptions,
    deps: VibeBuilderSessionDeps = DEFAULT_VIBE_BUILDER_DEPS,
  ) {
    this.options = options;
    this.deps = deps;
    this.cliSessionId = deps.sessionId();
  }

  get state(): BuilderSessionState {
    return this.snapshot;
  }

  private publish(event: StructuredRunnerEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private present(
    persona: BuilderSessionState["persona"],
    question: BuilderQuestion | null = this.snapshot.question ?? null,
  ): void {
    this.snapshot = { persona, question };
    this.publish({ kind: "ready" });
  }

  private persist(work: () => Promise<unknown>): Promise<void> {
    const next = this.persistQueue.then(async () => {
      await work();
    });
    this.persistQueue = next.catch(() => {});
    return next;
  }

  private flushAssistant(): Promise<void> {
    const reservation = this.reservation;
    const body = this.assistant.trim();
    this.assistant = "";
    if (!reservation || !body) return Promise.resolve();
    return this.persist(() =>
      this.deps.appendTranscript({
        runId: reservation.envelope.runId,
        attemptId: reservation.attempt.attemptId,
        kind: "assistant",
        body,
      }),
    );
  }

  /** What the task panels need to show this turn at all.
   *
   *  `history: true` is the gate: TasksPanel and TaskHistoryView both filter on
   *  it (SQL `json_extract(metadata_json,'$.history') = 1` in tasks.rs, and
   *  `if (!metadata?.history) return null` in taskHistory.ts), and the vibe
   *  reserve passed no metadata at all — so a Build turn recorded a complete
   *  evidence ledger and then could not appear anywhere a person looks.
   *
   *  The rest is `TaskRun`'s shape. `label` is what the turn was launched as
   *  and `title` is what it was about, which is the same split every other row
   *  uses. `appInstance` is deliberately absent: a Build attempt still running
   *  when Canopy quits SHOULD be swept to `interrupted` by the startup sweep,
   *  and claiming an instance would exempt it from exactly that. */
  private historyMetadata(goal: string, cli: string): Record<string, unknown> {
    return {
      history: true,
      taskId: "vibe-turn",
      label: "Build turn",
      icon: "◆",
      title: goal.slice(0, 100),
      agent: cli,
      cwd: this.options.componentPath,
      projectId: this.options.projectId,
      projectName: this.options.projectName,
      brief: goal,
    };
  }

  /** The one place a route comes from. Before the first launch this is the
   *  unresolved route — a server incident can be recorded before any turn, and
   *  it must not claim a route nobody selected. */
  private routeSnapshot(): ResolvedRoute {
    return (
      this.activeRoute ?? unresolvedRoute(this.options.cliId, ROUTE_VERSIONS)
    );
  }

  /** Rank the fleet, refuse when nothing can run, and record what was chosen.
   *  This is the gate the vibe launch never had: without it `rankFleet` ranks
   *  nothing and the route tuple is a literal. */
  private async resolveRouteForLaunch(): Promise<SelectedRoute> {
    const candidates = await this.deps.listRoutes();
    const eligible = rankRoutes(candidates, "build");
    const chosen = eligible[0];
    if (!chosen) {
      // Say which of the two reasons it was, because "no agent available" sends
      // someone to the wrong place half the time.
      const gated = candidates.filter((c) => !fleetGate(c.state).allowed);
      throw new Error(
        gated.length === candidates.length && candidates.length > 0
          ? `No agent is ready to build right now: ${gated
              .map((c) => `${c.cli} (${fleetGate(c.state).why})`)
              .join(", ")}`
          : "No agent with a usable model is available to build right now.",
      );
    }
    const cliVersion = await this.deps
      .cliVersion(chosen.cli)
      .catch(() => null);
    this.activeRoute = resolveRoute(chosen, eligible, ROUTE_VERSIONS, cliVersion);
    return chosen;
  }

  private async ensureStarted(goal: string): Promise<ProjectRunnerTransport> {
    if (this.stopped) throw new Error("the builder session is closed");
    if (this.transport) return this.transport;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      this.baseline = await this.deps.captureBaseline(this.options.componentPath);
      if (this.stopped) throw new Error("the builder session was closed during launch");
      // Gate before reserving: a run whose route was never usable should not
      // exist in the store at all.
      const chosen = await this.resolveRouteForLaunch();
      const contract = contractFor(goal);
      const route = this.routeSnapshot();
      this.turnMetadata = this.historyMetadata(goal, chosen.cli);
      const reservation = await this.deps.reserve({
        kind: "vibe-turn",
        projectId: this.options.projectId,
        componentId: this.options.componentId,
        worktreePath: this.options.componentPath,
        goal,
        acceptance: [
          "Implement the requested change in the selected component.",
          "Report configured-check and local-preview evidence independently.",
        ],
        contextSummary: `Build mode in ${this.options.projectName}`,
        riskClass: "reversible",
        authorityPolicy: {
          writes: "workspace",
          shell: "denied",
          verification: contract,
        },
        failoverPolicy: { automatic: false },
        attemptCap: 1,
        title: goal.slice(0, 100),
        metadata: this.turnMetadata,
        route,
      });
      this.reservation = reservation;
      this.settled = false;

      const launch = this.launchSpec(
        reservation.envelope.runId,
        reservation.attempt.attemptId,
        chosen.requestedModel,
        chosen.cli,
      );
      try {
        await this.deps.startAttempt(reservation.attempt.attemptId);
        if (this.stopped) throw new Error("the builder session was closed during launch");
        const transport = await this.deps.runner.start(
          reservation.attempt.attemptId,
          // The route's CLI, not a fixed one. launch.bin already comes from
          // chosen.cli, so naming a different id here ran one CLI's binary
          // under another's argv the moment the fleet resolved to anything but
          // Claude.
          chosen.cli,
          launch,
          {
            emit: (event) =>
              this.onRunnerEvent(event, reservation.attempt.attemptId),
          },
          { resume: this.hasRun },
        );
        if (this.stopped) {
          await transport.stop().catch(() => {});
          throw new Error("the builder session was closed during launch");
        }
        this.transport = transport;
        return transport;
      } catch (error) {
        await this.settle(
          this.stopped ? "interrupted" : "failed",
          this.stopped ? "lifecycle" : "launch",
          this.stopped ? "project-closed" : "spawn-failed",
        );
        throw error;
      } finally {
        this.launching = null;
      }
    })();
    return this.launching;
  }

  /** Chain work onto the send queue AND advance the queue.
   *
   *  Advancing it is the whole point: a branch that only chains off the queue
   *  without reassigning it leaves the queue on the promise it started from, so
   *  the next message chains off that same settled promise and the two run
   *  concurrently. Two proposals racing that way silently overwrite each
   *  other's `pendingAbstraction`, and the user is shown one card while the
   *  other is the one that would have run. */
  private enqueue(work: () => Promise<void>): Promise<void> {
    const queued = this.sendQueue.then(work);
    this.sendQueue = queued.catch(() => {});
    return queued;
  }

  send(text: string): Promise<void> {
    const message = text.trim();
    if (!message || this.stopped) return Promise.resolve();
    if (message === SAVE_CHECKPOINT && this.pendingCheckpoint) {
      return this.enqueue(() => this.saveCheckpoint());
    }
    // An abstraction awaiting an answer owns the next message, so "yes" is read
    // as the answer to what was asked rather than as a new build request.
    //
    // Reading `pendingAbstraction` here and nulling it synchronously inside
    // answerAbstraction is what makes a double-confirm safe: the second call
    // finds it already null and runs nothing. Serialising these branches does
    // not weaken that — it only stops two *proposals* from racing.
    if (this.pendingAbstraction) {
      return this.enqueue(() => this.answerAbstraction(message));
    }
    const intent = parseVibeIntent(message);
    if (intent) {
      return this.enqueue(() => this.proposeIntent(intent, message));
    }
    let sent!: () => void;
    let failed!: (error: unknown) => void;
    const accepted = new Promise<void>((resolve, reject) => {
      sent = resolve;
      failed = reject;
    });
    const queued = this.sendQueue.then(() => this.runTurn(message, sent, failed));
    this.sendQueue = queued.catch(() => {});
    return accepted;
  }

  /** Turn a recognised request into something the user can say yes or no to.
   *  Nothing runs here — this only ever asks. */
  private async proposeIntent(intent: VibeIntent, message: string): Promise<void> {
    // Queued behind an earlier message, so the session may have been stopped in
    // between. A stopped session must not offer a card there is no longer
    // anyone to answer.
    if (this.stopped) return;
    const cwd = this.options.componentPath;
    let proposal: AbstractionProposal;
    try {
      // The session is the only party that watched anything get verified, so
      // it supplies that verdict; the reader supplies the project.
      proposal = proposeAbstraction(
        intent,
        await this.deps.abstractionContext(cwd, intent),
        this.lastVerification,
      );
    } catch {
      if (this.stopped) return;
      // If the project can't be read, the honest answer is to stop, not to
      // guess a plan from defaults and ask the user to approve it.
      this.present(
        { kind: "idle" },
        {
          id: `vibe-abstraction-${this.deps.now()}`,
          kind: "question",
          prompt: "I couldn't read enough about this project to plan that.",
          detail: `Nothing has changed. You asked: "${message}"`,
        },
      );
      return;
    }
    // Reading the project is asynchronous, so the session can have been stopped
    // while it was read. Recheck rather than present onto a closed session.
    if (this.stopped) return;

    if (proposal.kind !== "run") {
      this.pendingAbstraction = null;
      this.present(
        { kind: "idle" },
        {
          id: `vibe-abstraction-${this.deps.now()}`,
          kind: "question",
          prompt: proposal.title,
          detail: proposal.detail,
        },
      );
      return;
    }

    // A production publish must be typed out, so the confirmation cannot be
    // collected by a stray click. Everything else gets a button.
    const requiresTypedPhrase = proposal.confirmLabel === PUBLISH_CONFIRMATION;
    const actions: BuilderQuestionAction[] = requiresTypedPhrase
      ? [{ label: "Cancel", response: ABSTRACTION_DECLINE }]
      : [
          { label: proposal.confirmLabel, response: ABSTRACTION_CONFIRM },
          { label: "Not now", response: ABSTRACTION_DECLINE },
        ];

    this.pendingAbstraction = {
      proposal,
      confirm: requiresTypedPhrase ? PUBLISH_CONFIRMATION : ABSTRACTION_CONFIRM,
      requiresTypedPhrase,
    };
    this.present(
      { kind: "idle" },
      {
        id: `vibe-abstraction-${this.deps.now()}`,
        kind: "confirm",
        prompt: proposal.title,
        detail: [proposal.detail, proposal.caveat].filter(Boolean).join("\n"),
        // The exact command, as argv, so what is approved is what runs.
        diff: proposal.argv.join(" "),
        actions,
      },
    );
  }

  /** Carry a message on to whatever should have handled it, once a pending
   *  question has declined to. A fresh intent gets a fresh proposal; anything
   *  else is a build request and reaches the agent. */
  private async reroute(message: string): Promise<void> {
    const intent = parseVibeIntent(message);
    if (intent) return this.proposeIntent(intent, message);
    let sent!: () => void;
    let failed!: (error: unknown) => void;
    const accepted = new Promise<void>((resolve, reject) => {
      sent = resolve;
      failed = reject;
    });
    void this.runTurn(message, sent, failed);
    return accepted;
  }

  /** The user's answer to a pending proposal. This is the confirmation gate:
   *  anything that is not the required word runs nothing. */
  private async answerAbstraction(message: string): Promise<void> {
    const pending = this.pendingAbstraction;
    if (!pending) return;
    // Nulled synchronously, before any await: this is what makes a second
    // confirm arriving in the same tick a no-op rather than a second run.
    //
    // There is deliberately no `this.stopped` check here. It would be
    // unreachable cover — send() refuses a stopped session, and stop() clears
    // `pendingAbstraction`, so a confirm still queued when the session stops
    // returns at the guard above. A second, redundant guard would only make
    // that clearing impossible to test.
    this.pendingAbstraction = null;

    if (message !== pending.confirm) {
      const why =
        pending.requiresTypedPhrase && message !== ABSTRACTION_DECLINE
          ? `I need exactly "${PUBLISH_CONFIRMATION}" before publishing, so I've left it alone.`
          : "Left it alone.";
      this.present(
        { kind: "idle" },
        {
          id: `vibe-abstraction-declined-${this.deps.now()}`,
          kind: "question",
          prompt: "Nothing ran.",
          detail: why,
        },
      );
      // Someone who changes their mind mid-question types the new thing they
      // want, not a cancellation. Dropping that message would lose a real
      // build request to a card they had already stopped reading, so anything
      // that is not one of our own sentinels carries on as a request.
      if (message !== ABSTRACTION_DECLINE) await this.reroute(message);
      return;
    }

    const { proposal } = pending;
    this.present({ kind: "turn-progress" }, null);
    const result = await this.deps.runAbstraction(proposal.argv, proposal.cwd, {
      spawned: (handle) => {
        // Stopped between the confirmation and the spawn: take the process with
        // us now rather than record a handle nobody will read again.
        if (this.stopped) {
          void handle.kill().catch(() => {});
          return;
        }
        this.runningAbstraction = handle;
      },
      // Every pty exit arrives here, so match on id before letting go.
      exited: (ptyId) => {
        if (this.runningAbstraction?.id === ptyId) this.runningAbstraction = null;
      },
    });
    this.runningAbstraction = null;

    if (this.stopped) {
      // stop() killed the process we were waiting on. What is true is that we
      // stopped watching — NOT that nothing happened. Killing `vercel --prod`
      // does not un-deploy it: whatever it had already done server-side stands,
      // and we cannot see which. So this deliberately does not reuse the
      // declined path's "Nothing ran", which is a claim we are not entitled to.
      this.present(
        { kind: "idle" },
        {
          id: `vibe-abstraction-interrupted-${this.deps.now()}`,
          kind: "question",
          prompt: "I stopped waiting for that.",
          detail: `Closing the project ended \`${proposal.argv.join(" ")}\` here. It may have already finished what it started — I can't tell you either way from this side.`,
        },
      );
      return;
    }

    this.present(
      { kind: "idle" },
      {
        id: `vibe-abstraction-done-${this.deps.now()}`,
        kind: "question",
        prompt: result.ok
          ? proposal.title
          : result.timedOut
            ? "That took too long, so I stopped it."
            : "That didn't work.",
        // Output has already been through redactSecrets in the runner; a deploy
        // in particular prints tokens and URLs on success as readily as failure.
        detail: result.output || (result.ok ? "Done." : "No output."),
      },
    );
  }

  async reportServerIncident(
    input: VibeServerIncidentInput,
  ): Promise<"recorded" | "recorded-unsettled" | "failed"> {
    if (this.serverIncidentKeys.has(input.key)) return "recorded";
    this.serverIncidentKeys.add(input.key);
    if (input.present !== false) {
      this.serverIncidentOpen = true;
      this.incidentOpen = true;
      this.present(
        { kind: "incident" },
        {
          id: `vibe-server-${input.componentId}-${input.runCommandId}`,
          kind: "notice",
          prompt: "The app server keeps stopping.",
          detail: "I'm reading its output to find out why.",
        },
      );
    }

    if (input.activeAttempt === undefined) {
      input.activeAttempt =
        this.reservation && !this.settled && !this.stopped
          ? {
              runId: this.reservation.envelope.runId,
              attemptId: this.reservation.attempt.attemptId,
            }
          : null;
    }
    const active = input.activeAttempt;
    let reservation: TaskReservation | null = null;
    try {
      reservation = await this.deps.reserve({
        kind: "vibe-server-health",
        projectId: this.options.projectId,
        componentId: this.options.componentId,
        worktreePath: this.options.componentPath,
        goal: "Record a Build server crash loop",
        acceptance: ["Retain the observed server failure and its capped log tail."],
        contextSummary: `Build server health in ${this.options.projectName}`,
        riskClass: "reversible",
        authorityPolicy: {
          writes: "none",
          shell: "denied",
          verification: { required: [] },
        },
        failoverPolicy: { automatic: false },
        attemptCap: 1,
        title: "Build server crash loop",
        route: this.routeSnapshot(),
      });
      await this.deps.startAttempt(reservation.attempt.attemptId);
      const { runId } = reservation.envelope;
      const { attemptId } = reservation.attempt;
      const logTail = await Promise.resolve(input.logTail).catch(() => "");
      let recorded = false;
      for (let attempt = 0; attempt < 3 && !recorded; attempt += 1) {
        try {
          const artifact = await this.deps.writeArtifact({
            runId,
            attemptId,
            kind: "vibe-server-log-tail",
            content: logTail,
          });
          await this.deps.appendEvent({
            runId,
            attemptId,
            kind: "watchdog-incident",
            code: "vibe-server-crash-loop",
            source: "vibe-server-health",
            confidence: "observed",
            metadata: {
              componentId: input.componentId,
              runCommandId: input.runCommandId,
              exitCode: input.exitCode,
              crashTimes: input.crashTimes,
              threshold: 3,
              windowMs: 60_000,
              automaticRestarts: input.automaticRestarts,
              lastObservedPorts: input.ports,
              outputBytes: input.outputBytes,
              totalCpu: input.totalCpu,
              totalMemBytes: input.totalMemBytes,
              logArtifactId: artifact.id,
              activeRunId: active?.runId ?? null,
              activeAttemptId: active?.attemptId ?? null,
            },
            occurredAt: this.deps.now(),
          });
          recorded = true;
        } catch {
          // Retry the artifact+event pair. An orphaned artifact is bounded and
          // preferable to claiming an incident whose required log was lost.
          if (attempt < 2) await this.deps.sleep((attempt + 1) * 250);
        }
      }
      if (!recorded) throw new Error("server incident persistence failed");
      const settled = await this.settleServerAttempt({
        attemptId,
        state: "blocked",
        failureClass: "watchdog",
        failureCode: "vibe-server-crash-loop",
      });
      // Recording is not the response — it is the evidence for one. The log
      // tail now goes to a repair agent that reads it, acts inside the
      // component, and asks before anything destructive. Not awaited: the
      // incident is recorded either way, and repair reports through present().
      if (input.present !== false) void this.repairServerCrash(input, logTail);
      if (input.present === false) this.serverIncidentKeys.delete(input.key);
      return settled ? "recorded" : "recorded-unsettled";
    } catch {
      this.serverIncidentKeys.delete(input.key);
      if (reservation) {
        await this.settleServerAttempt({
          attemptId: reservation.attempt.attemptId,
          state: "failed",
          failureClass: "persistence",
          failureCode: "server-incident-write-failed",
        });
      }
      return "failed";
    }
  }

  /** Keys with a repair underway, so a re-reported incident cannot stack a
   *  second agent onto the same broken server. */
  private repairsInFlight = new Set<string>();

  /** The troubleshooter. Where reportServerIncident files evidence, this
   *  spends it: a repair agent gets the log tail, the component, and every
   *  command the survey found, diagnoses, acts inside the component, and asks
   *  the person (canopy_ask_user) before anything destructive. Its verdict is
   *  spoken in Build's own voice — never "the server keeps stopping" with
   *  nothing behind it. */
  private async repairServerCrash(
    input: VibeServerIncidentInput,
    logTail: string,
  ): Promise<void> {
    if (this.stopped || this.repairsInFlight.has(input.key)) return;
    this.repairsInFlight.add(input.key);
    try {
      const component = {
        id: input.componentId,
        label: input.component?.label ?? this.options.projectName,
        path: input.component?.path ?? this.options.componentPath,
        ...(input.component?.role ? { role: input.component.role } : {}),
      };
      const problem: RepairProblem = {
        code: "server-crash-loop",
        statement: `The app server for ${component.label} keeps stopping moments after it starts.`,
        projectId: this.options.projectId,
        projectName: this.options.projectName,
        component,
        ...(input.command
          ? { runCommand: { id: input.runCommandId, ...input.command } }
          : {}),
        commands: input.commands ?? [],
        evidence: {
          logTail,
          exitCode: input.exitCode,
          crashCount: input.crashTimes.length,
        },
      };
      // The default is imported at call time, not module load: a static
      // import of vibeRepairSession → vibeProjectSetup → this module would
      // close a cycle at init.
      const repair =
        this.deps.repair ??
        (async (repairInput: VibeRepairTaskInput): Promise<VibeRepairTaskResult> => {
          const [runtime, setup] = await Promise.all([
            import("./vibeRepairSession"),
            import("./vibeProjectSetup"),
          ]);
          return runtime.runVibeRepairTask(
            repairInput,
            setup.DEFAULT_VIBE_PROJECT_SETUP_TASK_DEPS,
          );
        });
      let result: VibeRepairTaskResult;
      try {
        result = await repair({ problem });
      } catch {
        // A runner rejection is a failed repair, not an unhandled rejection
        // from this fire-and-forget path. Let the next crash try again.
        this.serverIncidentKeys.delete(input.key);
        result = {
          ok: false,
          reason: "agent-failed",
          message: "I tried to fix it and couldn't finish.",
          runId: null,
        };
      }
      if (this.stopped) return;
      if (result.ok && result.verdict.fixed) {
        this.serverIncidentOpen = false;
        this.incidentOpen = false;
        this.resolveServerIncident(input.key);
        this.present(
          { kind: "idle" },
          {
            id: `vibe-repair-fixed-${input.componentId}-${this.deps.now()}`,
            kind: "notice",
            prompt: "Found it and fixed it.",
            detail: [
              result.verdict.diagnosis,
              ...result.verdict.actions.map((action) => action.did),
            ].join(" "),
          },
        );
      } else if (result.ok) {
        this.present(
          { kind: "incident" },
          {
            id: `vibe-repair-blocked-${input.componentId}-${this.deps.now()}`,
            kind: "question",
            prompt: "I found what's wrong, and I need your help with one thing.",
            detail: [result.verdict.diagnosis, result.verdict.blocker]
              .filter(Boolean)
              .join(" "),
          },
        );
      } else {
        this.present(
          { kind: "incident" },
          {
            id: `vibe-repair-failed-${input.componentId}-${this.deps.now()}`,
            kind: "question",
            prompt: "The app server keeps stopping.",
            detail: `${result.message} The failed run keeps the server output for inspection.`,
          },
        );
      }
    } finally {
      this.repairsInFlight.delete(input.key);
    }
  }

  private async settleServerAttempt(
    settlement: TaskAttemptSettlement,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const settled = await this.deps
        .settleAttempt(settlement)
        .then(() => true)
        .catch(() => false);
      if (settled) {
        this.unsettledServerAttempts.delete(settlement.attemptId);
        return true;
      }
      if (attempt < 2) await this.deps.sleep((attempt + 1) * 250);
    }
    this.unsettledServerAttempts.set(settlement.attemptId, settlement);
    return false;
  }

  async repairServerIncidentSettlements(): Promise<boolean> {
    for (const settlement of [...this.unsettledServerAttempts.values()]) {
      await this.settleServerAttempt(settlement);
    }
    return this.unsettledServerAttempts.size === 0;
  }

  resolveServerIncident(key: string): void {
    this.serverIncidentKeys.delete(key);
    this.serverIncidentOpen = false;
    this.incidentOpen = this.runtimeIncidentOpen;
    if (!this.runtimeIncidentOpen) {
      this.present({ kind: "incident-recovered" }, null);
    }
  }

  restoreServerIncident(
    key: string,
    componentId: string,
    runCommandId: string,
  ): void {
    if (this.serverIncidentOpen && this.serverIncidentKeys.has(key)) return;
    this.serverIncidentKeys.add(key);
    this.serverIncidentOpen = true;
    this.incidentOpen = true;
    this.present(
      { kind: "incident" },
      {
        id: `vibe-server-${componentId}-${runCommandId}`,
        kind: "question",
        prompt: "The app server keeps stopping.",
        detail: "I stopped restarting it. The failed run keeps the server output for inspection.",
      },
    );
  }

  private async runTurn(
    message: string,
    sent: () => void,
    failed: (error: unknown) => void,
  ): Promise<void> {
    const turnEpoch = ++this.turnEpoch;
    try {
      if (this.verifying) await this.verifying;
      if (turnEpoch !== this.turnEpoch) {
        sent();
        return;
      }
      if (this.stopped) throw new Error("the builder session is closed");
      this.pendingCheckpoint = null;
      // Held so a reseeded attempt replays the same request verbatim. A
      // failover that paraphrased the goal would be solving a different
      // problem than the one that failed.
      this.currentGoal = message;
      this.attemptsUsed = 1;
      this.attemptHistory = [];
      this.lastRunnerError = "";
      const transport = await this.ensureStarted(message);
      if (turnEpoch !== this.turnEpoch) {
        sent();
        return;
      }
      if (this.stopped) throw new Error("the builder session is closed");
      const reservation = this.reservation;
      if (!reservation) throw new Error("the builder task was not reserved");
      this.runtimeIncidentOpen = false;
      this.incidentOpen = this.serverIncidentOpen;
      this.snapshot = { persona: { kind: "turn-started" }, question: null };
      try {
        await this.persist(() =>
          this.deps.appendTranscript({
            runId: reservation.envelope.runId,
            attemptId: reservation.attempt.attemptId,
            kind: "user",
            body: message,
          }),
        );
      } catch (error) {
        await this.finishAttempt(
          "failed",
          "persistence",
          "transcript-write-failed",
        );
        throw error;
      }
      this.networkScoped = await this.deps.beginBrowserTurn(
        this.options.previewTabId(),
      );
      const completed = new Promise<void>((resolve) => {
        this.finishTurn = resolve;
      });
      await transport.send(message);
      sent();
      await completed;
    } catch (error) {
      this.finishTurn?.();
      this.finishTurn = null;
      if (turnEpoch !== this.turnEpoch) {
        sent();
        return;
      }
      failed(error);
      throw error;
    }
  }

  private onRunnerEvent(event: StructuredRunnerEvent, attemptId: string): void {
    if (this.closedAttempts.has(attemptId)) {
      if (event.kind === "exit") this.closedAttempts.delete(attemptId);
      return;
    }
    const reservation = this.reservation;
    if (!reservation || reservation.attempt.attemptId !== attemptId) return;
    switch (event.kind) {
      case "delta":
        this.assistant += event.text;
        this.snapshot = { ...this.snapshot, persona: { kind: "turn-progress" } };
        break;
      case "reply":
        this.assistant += `${this.assistant ? "\n" : ""}${event.text}`;
        this.snapshot = { ...this.snapshot, persona: { kind: "turn-progress" } };
        break;
      case "tool":
        this.snapshot = { ...this.snapshot, persona: { kind: "turn-progress" } };
        if (reservation) {
          void this.persist(() =>
            this.deps.appendTranscript({
              runId: reservation.envelope.runId,
              attemptId: reservation.attempt.attemptId,
              kind: "activity",
              body: event.detail ? `${event.name}: ${event.detail}` : event.name,
            }),
          );
        }
        break;
      case "error":
        this.lastRunnerError = event.message;
        this.runtimeIncidentOpen = true;
        this.incidentOpen = true;
        this.snapshot = {
          persona: { kind: "incident" },
          question: {
            id: `runner-error-${this.deps.now()}`,
            kind: "question",
            prompt: event.message,
            detail: "Reply with what you want me to try next, or switch to Engineer mode for the raw details.",
          },
        };
        if (reservation) {
          void this.persist(() =>
            this.deps.appendTranscript({
              runId: reservation.envelope.runId,
              attemptId: reservation.attempt.attemptId,
              kind: "error",
              body: event.message,
            }),
          );
        }
        break;
      // Canopy asked itself for permission and had nobody to answer. Left
      // alone the turn ends looking successful, and what reaches a
      // non-engineer is the model's own advice to go and grant the tools —
      // in a screen that does not exist. The attempt ends on it instead, and
      // the stop path speaks (see the tool-permission-denied narration in
      // vibeFailover).
      case "blocked": {
        this.lastRunnerError =
          `Canopy requested permissions to use ${event.tool} in a session it started itself, ` +
          "and the request had nobody to answer it.";
        if (reservation) {
          void this.persist(() =>
            this.deps.appendTranscript({
              runId: reservation.envelope.runId,
              attemptId: reservation.attempt.attemptId,
              kind: "error",
              body: this.lastRunnerError,
            }),
          );
        }
        // Ending the process routes through `exit` to handleAttemptFailure,
        // where the classifier reads that sentence as a task failure and
        // stops — rather than spending two more routes on a block that every
        // route shares.
        void this.transport?.stop().catch(() => {});
        break;
      }
      case "turnEnd":
        if (this.verifying) return;
        this.hasRun = true;
        this.publish(event);
        const turnEpoch = this.turnEpoch;
        let verification!: Promise<void>;
        verification = this.verifyTurn(turnEpoch)
          .catch((error) => {
            if (turnEpoch !== this.turnEpoch) return;
            this.runtimeIncidentOpen = true;
            this.incidentOpen = true;
            this.snapshot = {
              persona: { kind: "incident" },
              question: {
                id: `verification-error-${this.deps.now()}`,
                kind: "question",
                prompt: "Verification could not finish.",
                detail: String(error),
              },
            };
            this.publish({ kind: "error", message: String(error) });
            void this.finishAttempt("failed", "verification", "verification-error");
          })
          .finally(() => {
            if (this.verifying === verification) this.verifying = null;
            if (turnEpoch !== this.turnEpoch) return;
            this.finishTurn?.();
            this.finishTurn = null;
          });
        this.verifying = verification;
        return;
      case "exit":
        this.transport = null;
        // A process that stopped mid-turn is a failed attempt, not the end of
        // the work. Whether to retry, move to another model, or stop is a
        // decision about the evidence — see vibeFailover.
        void this.flushAssistant().finally(() => void this.handleAttemptFailure());
        break;
      case "ready":
        if (this.snapshot.persona.kind === "turn-started") {
          this.snapshot = { ...this.snapshot, persona: { kind: "turn-progress" } };
        }
        break;
    }
    this.publish(event);
  }

  private async verifyTurn(turnEpoch: number): Promise<void> {
    const reservation = this.reservation;
    const baseline = this.baseline;
    if (!reservation || !baseline || this.stopped || turnEpoch !== this.turnEpoch) return;
    const runId = reservation.envelope.runId;
    const attemptId = reservation.attempt.attemptId;
    const goal = reservation.envelope.title ?? reservation.envelope.runId;
    const contract = contractFor(goal);

    await this.flushAssistant();
    if (turnEpoch !== this.turnEpoch) return;

    this.present({ kind: "verify-running" }, null);
    const at = this.deps.now();
    const check = await this.deps.runCheck(
      this.options.checkCommand ?? null,
      this.options.componentPath,
      at,
    );
    if (turnEpoch !== this.turnEpoch) return;
    // With no command to run, the default note ("no configured check command is
    // available") describes Canopy's state rather than the user's: it never
    // says the turn stays unverified until a check script exists, which is the
    // only part they can act on. Recorded on the observation, so the durable
    // ledger carries the reason and not just the absence.
    if (!this.options.checkCommand && this.options.checkCaveat) {
      check.observation.note = this.options.checkCaveat;
    }
    if (check.output) {
      const artifact = await this.deps
        .writeArtifact({ runId, attemptId, kind: "check-output", content: check.output })
        .catch(() => null);
      if (artifact) check.observation.evidence = artifact.id;
    }
    const browser = await this.deps.inspectBrowser(
      this.options.previewTabId(),
      visualTask(goal),
      at,
      this.networkScoped,
    );
    if (turnEpoch !== this.turnEpoch) return;
    if (browser.screenshot) {
      const screenshot = await this.deps
        .writeArtifact({
          runId,
          attemptId,
          kind: "preview-screenshot-base64",
          content: browser.screenshot,
        })
        .catch(() => null);
      const observation = browser.observations.find(
        (candidate) => candidate.kind === "screenshot",
      );
      if (observation && screenshot) observation.evidence = screenshot.id;
      else if (observation) {
        observation.verdict = "unknown";
        observation.note = "the screenshot could not be retained as evidence";
      }
    }
    const observations = [check.observation, ...browser.observations];
    if (this.stopped || turnEpoch !== this.turnEpoch) return;
    for (const observation of observations) {
      await this.deps.appendEvent({
        runId,
        attemptId,
        kind: "verification.observation",
        code: observation.kind,
        source: "canopy",
        confidence: observation.verdict,
        metadata: observation,
        occurredAt: observation.at,
      });
    }
    let verdict = judgeVerification(contract, observations);
    // A failed check is not a result to report. It is a problem to solve.
    //
    // This is the hole the person kept falling into: Canopy ran `pnpm run
    // build`, it exited 1, the captured output said in plain English
    // "node_modules missing, did you mean to install?" — and Canopy wrote that
    // to an artifact and told them "Verification found a problem". It had the
    // fault, the fix and the authority, and used none of them, because repair
    // was wired only to a server crashing three times.
    if (verdict.outcome === "failed" && check.observation.verdict === "fail" && check.output) {
      const retried = await this.repairFailedCheck(check.output, at, turnEpoch);
      if (turnEpoch !== this.turnEpoch || this.stopped) return;
      if (retried) {
        observations[0] = retried.observation;
        if (retried.output) {
          const artifact = await this.deps
            .writeArtifact({ runId, attemptId, kind: "check-output", content: retried.output })
            .catch(() => null);
          if (artifact) retried.observation.evidence = artifact.id;
        }
        // The second observation is filed alongside the first rather than
        // replacing it. Both happened, and a ledger that only kept the ending
        // could not show that anything was repaired.
        await this.deps.appendEvent({
          runId,
          attemptId,
          kind: "verification.observation",
          code: retried.observation.kind,
          source: "canopy",
          confidence: retried.observation.verdict,
          metadata: retried.observation,
          occurredAt: retried.observation.at,
        });
        verdict = judgeVerification(contract, observations);
      }
    }
    // Held so a later "deploy this" is judged against evidence that actually
    // exists. Without it the deploy planner is handed a constant, and a
    // constant is a claim nothing observed.
    this.lastVerification = verdict.outcome;
    await this.deps.appendEvent({
      runId,
      attemptId,
      kind: "verification.verdict",
      code: verdict.outcome,
      source: "canopy",
      confidence: "independent",
      metadata: { contract, observations, verdict },
    });

    const review = await this.deps.reviewCheckpoint({
      cwd: this.options.componentPath,
      baseline,
      verification: verdict.outcome,
      noOpenIncident: !this.incidentOpen,
    });
    if (this.stopped || turnEpoch !== this.turnEpoch) return;
    const safeReview = {
      ...review,
      context: {
        ...review.context,
        noOpenIncident: review.context.noOpenIncident && !this.incidentOpen,
      },
    };
    const decision = checkpointDecision(safeReview.context);
    // The policy is one gate; whether the unattended commit has ever run here
    // is another. "Never executed" and "unverified" are the same state — see
    // vibeAutoCheckpoint — so until a checkpoint has actually happened on this
    // machine the commit is PROPOSED rather than made. The decision, the paths,
    // the baseline and the reasons are recorded either way: this holds the git
    // write, it does not weaken the evidence.
    const armed = this.deps.autoCheckpointObserved();
    const held = decision.checkpoint && !armed;
    let summary = verificationSummary(
      contract,
      observations,
      verdict.outcome,
      this.options.checkCommand ? null : (this.options.checkCaveat ?? null),
    );
    this.pendingCheckpoint = null;

    if (decision.checkpoint && armed && review.paths.length > 0) {
      const commit = await this.deps.commit(
        review.repoRoot,
        review.paths,
        `vibe: ${goal.slice(0, 72)}`,
      );
      if (turnEpoch !== this.turnEpoch) return;
      await this.deps.appendEvent({
        runId,
        attemptId,
        kind: "checkpoint.saved",
        code: "automatic",
        source: "canopy",
        confidence: "independent",
        metadata: { commit, paths: review.paths },
      });
      summary += " Saved this verified version automatically.";
      this.present({ kind: "checkpoint-saved" }, null);
    } else if (review.paths.length > 0) {
      this.pendingCheckpoint = { review: safeReview, verification: verdict.outcome };
      const artifact = await this.deps
        // Redacted before it reaches disk: this artifact exists so a refused
        // turn can be inspected, and the commonest reason to refuse one is a
        // credential in the diff. Persisting it verbatim would leak through a
        // door the finding rules do not cover.
        .writeArtifact({
          runId,
          attemptId,
          kind: "turn-diff",
          content: redactSecrets(review.diff),
        })
        .catch(() => null);
      const reasons = decision.checkpoint ? [] : decision.reasons;
      await this.deps.appendEvent({
        runId,
        attemptId,
        // A held checkpoint is not a refused one: the policy said yes. Recording
        // it as `refused` would put a reason in the ledger that nothing found.
        kind: held ? "checkpoint.held" : "checkpoint.refused",
        code: held ? "auto-checkpoint-never-observed" : (reasons[0] ?? "policy"),
        source: "canopy",
        confidence: "independent",
        metadata: {
          reasons,
          artifactId: artifact?.id ?? null,
          secretScan: review.secrets
            ? review.secrets.clean
              ? "clean"
              : "flagged"
            : "unknown",
          // Never the matched text — findings name a rule and a place only.
          secretFindings: review.secrets?.findings ?? [],
          // The full decision inputs, so a held checkpoint is as auditable as
          // an automatic one would have been.
          context: safeReview.context,
          baselineHead: baseline.head,
          repoRoot: review.repoRoot,
          paths: review.paths,
        },
      });
      const secretDetail =
        !decision.checkpoint && review.secrets && !review.secrets.clean
          ? describeSecretFindings(review.secrets.findings)
          : "";
      this.present(
        verdict.outcome === "failed" ? { kind: "verify-failed" } : { kind: "verify-passed" },
        {
          id: `checkpoint-${attemptId}-${this.deps.now()}`,
          kind: "confirm",
          prompt: held
            ? "This is the first version I'd save here."
            : "This turn was not auto-saved.",
          detail: held
            ? FIRST_CHECKPOINT_DETAIL
            : [
                reasons.map((reason) => refusalText[reason] ?? reason).join("; "),
                secretDetail,
              ]
                .filter(Boolean)
                .join(" "),
          diff: review.diff,
          actions: [{ label: "Save this version", response: SAVE_CHECKPOINT }],
        },
      );
      if (held) summary += ` I haven't saved it — ${FIRST_CHECKPOINT_DETAIL}.`;
    } else {
      this.present(
        verdict.outcome === "verified"
          ? { kind: "verify-passed" }
          : { kind: "verify-failed" },
        null,
      );
    }

    await this.deps.appendTranscript({
      runId,
      attemptId,
      kind: "system",
      body: summary,
    });
    if (turnEpoch !== this.turnEpoch) return;
    // The task panels show a run by its summary line; without this a Build turn
    // reads "No summary reported." next to a full evidence ledger.
    await this.recordTurnSummary(runId, summary);
    this.publish({ kind: "reply", text: summary });
    this.publish({ kind: "turnEnd" });
    await this.finishAttempt(
      verdict.outcome === "verified" ? "completed" : "blocked",
    );
  }

  /** Hand a failed check to a repair agent, and if it says it fixed something,
   *  run the check again so the claim is tested rather than believed.
   *
   *  Returns the second check when one was run, or null when repair did not
   *  happen or reported that it could not fix it. The caller re-judges; this
   *  never decides the turn's verdict itself.
   *
   *  Nothing here is a retry of the same command in the hope of a different
   *  answer — that is the pattern the person named as the whole problem
   *  ("run the command, it fails three times, say it failed"). The command is
   *  only run a second time because something in between actually changed. */
  private async repairFailedCheck(
    output: string,
    at: number,
    turnEpoch: number,
  ): Promise<CheckRunResult | null> {
    if (this.stopped || !this.deps.repair) return null;
    this.present(
      { kind: "incident" },
      {
        id: `vibe-check-repair-${this.deps.now()}`,
        kind: "notice",
        prompt: "That didn't work yet.",
        detail: "I'm reading the error to find out why.",
      },
    );
    const problem: RepairProblem = {
      code: "setup-failed",
      statement: `The project's own check command failed for ${this.options.projectName}.`,
      projectId: this.options.projectId,
      projectName: this.options.projectName,
      component: {
        id: this.options.componentId,
        label: this.options.projectName,
        path: this.options.componentPath,
      },
      commands: [...(this.options.componentCommands ?? [])],
      evidence: {
        logTail: output,
        context: this.options.checkCommand
          ? `The command was: ${
              Array.isArray(this.options.checkCommand)
                ? this.options.checkCommand.join(" ")
                : this.options.checkCommand
            }`
          : undefined,
      },
    };
    const result = await this.deps
      .repair({ problem })
      .catch(() => null);
    if (this.stopped || turnEpoch !== this.turnEpoch) return null;
    if (!result?.ok || !result.verdict.fixed) {
      // Say what was learned even when it could not be fixed. "It failed" and
      // "it failed, here is why, and here is what stopped me" are different
      // messages to someone who cannot read the log themselves.
      const verdictText = result?.ok
        ? [result.verdict.diagnosis, result.verdict.blocker].filter(Boolean).join(" ")
        : null;
      if (verdictText) {
        this.present(
          { kind: "incident" },
          {
            id: `vibe-check-repair-blocked-${this.deps.now()}`,
            kind: "question",
            prompt: "I found what's wrong, and I need your help with one thing.",
            detail: verdictText,
          },
        );
      }
      return null;
    }
    this.present(
      { kind: "verify-running" },
      {
        id: `vibe-check-repair-fixed-${this.deps.now()}`,
        kind: "notice",
        prompt: "Fixed it — checking again.",
        detail: result.verdict.diagnosis,
      },
    );
    return this.deps
      .runCheck(this.options.checkCommand ?? null, this.options.componentPath, at)
      .catch(() => null);
  }

  /** One launch spec for both the first attempt and any reseeded one, so a
   *  retry cannot quietly run under different rules than the attempt it
   *  replaces. */
  private launchSpec(
    runId: string,
    attemptId: string,
    model: string | null,
    cli: string,
  ): StructuredRunnerLaunch {
    // Authority is not decided here any more — see workspaceAuthority.ts. It
    // was, and the answer was wrong in a way that capped what Build could be:
    // "do not use a shell" meant a turn could add a dependency to package.json
    // and had no way on earth to install it, so the change it had just written
    // could not run and the person was shown `node_modules missing, did you
    // mean to install?`. Making something work is the job, and a job whose
    // tools stop at editing text cannot do it.
    const grant = grantFor("build", {
      root: this.options.componentPath,
      siblings: this.options.siblingPaths ?? [],
    });
    return {
      bin: AGENT_CLIS.find((c) => c.id === cli)?.bin ?? this.options.cliBin,
      policy: {
        systemPromptAppend:
          `You are the Build-mode executor for ${this.options.projectName}. ` +
          `Work inside ${this.options.componentPath}. Make the change and make it actually run: ` +
          "install what it needs, build it, and check your own work. " +
          "Explain outcomes in plain language — the person reading you does not read stack traces. " +
          "Canopy runs verification independently.",
        permissionMode: grant.permissionMode,
        // The whole sidecar, not the three tools someone thought of. Nobody is
        // sitting in this session to answer a prompt, and a Build turn reaches
        // well past starting a server — it waits on a port, restarts, opens the
        // preview and reads the console back. See agentTools.ts.
        allowedTools: grant.allowedTools,
        disallowedTools: grant.disallowedTools,
        network: grant.network,
        writableRoots: grant.writableRoots,
        // The model the route asked for, actually applied — it becomes
        // `--model`/`-m` at launch. Recording a requestedModel we never passed
        // would make the attempt record fiction.
        model: model ?? "",
        sessionId: this.cliSessionId,
        cwd: this.options.componentPath,
        authority: grant.authority,
      },
      env: [
        // The route this attempt is recorded against names a profile
        // (listNativeRoutes ranks per profile). Without this the process runs
        // on the default login regardless, and the attempt record says an
        // account the turn never used.
        ...launchEnvSync(cli),
        ["CANOPY_VIBE", "1"],
        ["CANOPY_RUN_ID", runId],
        ["CANOPY_ATTEMPT_ID", attemptId],
      ],
    };
  }

  /** An attempt ended badly. Classify it, let the failover policy decide
   *  whether to retry here, move to another model, or stop — and say which,
   *  out loud. A silent model switch is the same lie as a silent failure. */
  private async handleAttemptFailure(): Promise<void> {
    const reservation = this.reservation;
    const route = this.activeRoute;
    if (this.stopped || !reservation || !route) return;

    const candidates = await this.deps.listRoutes().catch(() => []);
    const { action, verdict } = failoverDecision({
      evidence: { agent: route.cli, text: this.lastRunnerError },
      history: this.attemptHistory,
      current: { cli: route.cli, profileId: route.profileId },
      candidates,
      task: "build",
      attemptsUsed: this.attemptsUsed,
      attemptCap: VIBE_ATTEMPT_CAP,
    });
    this.attemptHistory.push({
      route: `${route.cli}:${route.profileId}`,
      verdict,
    });
    await this.deps
      .appendEvent({
        runId: reservation.envelope.runId,
        attemptId: reservation.attempt.attemptId,
        kind: "failover.decision",
        code: action.kind,
        source: "canopy",
        confidence: "independent",
        metadata: { verdict, reason: action.reason },
        occurredAt: this.deps.now(),
      })
      .catch(() => {});

    if (action.kind === "stop") {
      this.finishTurn?.();
      this.finishTurn = null;
      this.runtimeIncidentOpen = true;
      this.incidentOpen = true;
      this.snapshot = {
        persona: { kind: "permission-stall" },
        question: {
          id: `runner-exit-${this.deps.now()}`,
          kind: "question",
          prompt: action.narration,
          detail: "Send another message to start a fresh managed attempt.",
        },
      };
      this.publish({ kind: "reply", text: action.narration });
      await this.settle("failed", verdict.class, verdict.signature ?? action.reason);
      return;
    }

    // Retrying or switching. Say so before doing it, so nobody watches silence
    // while a second model starts.
    this.publish({ kind: "reply", text: action.narration });
    await this.deps
      .appendTranscript({
        runId: reservation.envelope.runId,
        attemptId: reservation.attempt.attemptId,
        kind: "system",
        body: action.narration,
      })
      .catch(() => {});
    await this.settle("failed", verdict.class, verdict.signature ?? action.reason);
    const switched = action.kind === "switch-route" ? action.to : null;
    if (switched) {
      const cliVersion = await this.deps.cliVersion(switched.cli).catch(() => null);
      this.activeRoute = resolveRoute(switched, [switched], ROUTE_VERSIONS, cliVersion);
    }
    await this.reseed(reservation, switched);
  }

  /** Start a fresh attempt on the same run, linked to the one that failed.
   *  `recoveryFromAttemptId` is the only thread joining them: it records that
   *  this attempt exists because that one failed, without either attempt
   *  claiming the other's evidence. */
  private async reseed(
    failed: TaskReservation,
    switched: SelectedRoute | null,
  ): Promise<void> {
    const goal = this.currentGoal;
    if (!goal || this.stopped) return;
    const route = this.routeSnapshot();
    try {
      // A switched route is a different CLI, so the old session id means
      // nothing to it; a same-route retry keeps its id and can resume.
      if (switched) this.cliSessionId = this.deps.sessionId();
      const attempt = await this.deps.reserveAttempt({
        runId: failed.envelope.runId,
        route,
        recoveryFromAttemptId: failed.attempt.attemptId,
      });
      this.reservation = { envelope: failed.envelope, attempt };
      this.settled = false;
      this.attemptsUsed += 1;
      await this.deps.startAttempt(attempt.attemptId);
      const transport = await this.deps.runner.start(
        attempt.attemptId,
        route.cli,
        this.launchSpec(
          failed.envelope.runId,
          attempt.attemptId,
          route.requestedModel,
          route.cli,
        ),
        { emit: (event) => this.onRunnerEvent(event, attempt.attemptId) },
        { resume: !switched },
      );
      if (this.stopped) {
        await transport.stop().catch(() => {});
        return;
      }
      this.transport = transport;
      this.lastRunnerError = "";
      await transport.send(goal);
    } catch (error) {
      this.publish({
        kind: "error",
        message: `Could not start another attempt: ${String(error)}`,
      });
      this.finishTurn?.();
      this.finishTurn = null;
      await this.settle("failed", "route", "reseed-failed");
    }
  }

  private async finishAttempt(
    state: "completed" | "blocked" | "failed",
    failureClass?: string,
    failureCode?: string,
  ): Promise<void> {
    if (this.stopped) return;
    if (this.transport) {
      if (this.reservation) {
        this.closedAttempts.add(this.reservation.attempt.attemptId);
      }
      await this.transport.stop().catch(() => {});
      this.transport = null;
    }
    await this.settle(state, failureClass, failureCode);
  }

  /** Put the turn's verification summary on the run's history row. Rewrites the
   *  whole blob because `taskUpdateMetadata` replaces rather than patches, and
   *  fails quietly: a row that reads "No summary reported." is a worse surface,
   *  not a broken turn, and the durable transcript still holds the sentence. */
  private async recordTurnSummary(runId: string, summary: string): Promise<void> {
    const metadata = this.turnMetadata;
    if (!metadata) return;
    this.turnMetadata = { ...metadata, summary };
    await this.deps
      .updateMetadata(runId, this.turnMetadata)
      .catch(() => {});
  }

  private async saveCheckpoint(): Promise<void> {
    const reservation = this.reservation;
    const pending = this.pendingCheckpoint;
    if (!reservation || !pending) return;
    try {
      const refreshed = await this.deps.reviewCheckpoint({
        cwd: this.options.componentPath,
        baseline: this.baseline ?? {
          cleanAtStart: false,
          head: null,
          isolated: false,
          repoRoot: pending.review.repoRoot,
        },
        verification: pending.verification,
        noOpenIncident: !this.incidentOpen,
      });
      if (
        refreshed.repoRoot !== pending.review.repoRoot ||
        refreshed.diff !== pending.review.diff ||
        refreshed.paths.join("\n") !== pending.review.paths.join("\n")
      ) {
        this.pendingCheckpoint = { review: refreshed, verification: pending.verification };
        this.present(this.snapshot.persona, {
          id: `checkpoint-changed-${reservation.attempt.attemptId}-${this.deps.now()}`,
          kind: "confirm",
          prompt: "The diff changed after you reviewed it.",
          detail: "Review the updated diff, then choose Save this version again.",
          diff: refreshed.diff,
          actions: [{ label: "Save this version", response: SAVE_CHECKPOINT }],
        });
        return;
      }
      const commit = await this.deps.commit(
        refreshed.repoRoot,
        refreshed.paths,
        `vibe: ${(reservation.envelope.title ?? "saved version").slice(0, 72)}`,
      );
      // The commit returned, so the checkpoint path has now been observed
      // working on this machine — the live observation, and the only thing
      // allowed to arm the automatic one. Recorded after `commit` resolves and
      // never before: an arm on the attempt would be the same untested claim
      // the gate exists to refuse.
      this.deps.recordAutoCheckpointObserved();
      await this.deps.appendEvent({
        runId: reservation.envelope.runId,
        attemptId: reservation.attempt.attemptId,
        kind: "checkpoint.saved",
        code: "explicit",
        source: "user",
        confidence: "confirmed",
        metadata: { commit, paths: refreshed.paths },
      });
      await this.deps.appendTranscript({
        runId: reservation.envelope.runId,
        attemptId: reservation.attempt.attemptId,
        kind: "system",
        body: "Saved this version after explicit confirmation.",
      });
      this.pendingCheckpoint = null;
      this.present({ kind: "checkpoint-saved" }, null);
      this.publish({ kind: "reply", text: "Saved this version." });
      this.publish({ kind: "turnEnd" });
    } catch (error) {
      this.publish({ kind: "error", message: `Could not save this version: ${String(error)}` });
    }
  }

  private async settle(
    state: "completed" | "blocked" | "failed" | "interrupted" | "cancelled",
    failureClass?: string,
    failureCode?: string,
  ): Promise<void> {
    if (this.settled || !this.reservation) return;
    const settled = await this.deps
      .settleAttempt({
        attemptId: this.reservation.attempt.attemptId,
        state,
        failureClass,
        failureCode,
      })
      .then(() => true)
      .catch(() => false);
    if (settled) this.settled = true;
  }

  async cancelCurrentTurn(): Promise<void> {
    if (this.stopped) return;
    const reservation = this.reservation;
    const launching = this.launching;
    const transport = this.transport;
    const abstraction = this.runningAbstraction;
    if (
      !reservation &&
      !launching &&
      !transport &&
      !abstraction &&
      !this.finishTurn &&
      !this.verifying
    ) {
      return;
    }

    // Invalidate first. A check, browser read or slow launch already past its
    // cancellation boundary may still resolve, but it no longer owns the
    // presentation and cannot turn a stopped request green afterwards.
    this.turnEpoch += 1;
    this.pendingAbstraction = null;
    this.pendingCheckpoint = null;
    this.currentGoal = null;
    this.finishTurn?.();
    this.finishTurn = null;
    this.verifying = null;
    if (reservation) this.closedAttempts.add(reservation.attempt.attemptId);

    this.runningAbstraction = null;
    if (abstraction) await abstraction.kill().catch(() => {});
    const launched = launching ? await launching.catch(() => null) : null;
    await (transport ?? launched)?.stop().catch(() => {});
    if (this.transport === transport || this.transport === launched) {
      this.transport = null;
    }

    if (reservation && this.reservation === reservation) {
      await this.flushAssistant().catch(() => {});
      await this.deps
        .appendTranscript({
          runId: reservation.envelope.runId,
          attemptId: reservation.attempt.attemptId,
          kind: "system",
          body: "Stopped by the person in Build.",
        })
        .catch(() => {});
      await this.settle("cancelled", "user", "user-stopped");
      this.reservation = null;
    }
    this.baseline = null;
    this.assistant = "";
    this.snapshot = { persona: { kind: "idle" }, question: null };
    this.publish({ kind: "reply", text: "Stopped." });
    this.publish({ kind: "turnEnd" });
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // A proposal nobody can answer any more must not survive the session: left
    // set, a queued `answerAbstraction` would still find it and run the plan on
    // a closed session.
    this.pendingAbstraction = null;
    // The transport is not the only thing this session started. An abstraction
    // is detached, so nothing else will ever end it — kill it here, first,
    // before any of the slower teardown.
    const abstraction = this.runningAbstraction;
    this.runningAbstraction = null;
    if (abstraction) await abstraction.kill().catch(() => {});
    if (this.reservation) {
      this.closedAttempts.add(this.reservation.attempt.attemptId);
    }
    this.finishTurn?.();
    this.finishTurn = null;
    const launching = this.launching;
    if (launching) {
      const transport = await launching.catch(() => null);
      await transport?.stop().catch(() => {});
    }
    await this.transport?.stop().catch(() => {});
    this.transport = null;
    await this.flushAssistant().catch(() => {});
    await this.settle("interrupted", "lifecycle", "project-closed");
  }
}

export function createVibeBuilderSession(
  options: VibeBuilderSessionOptions,
  deps: VibeBuilderSessionDeps = DEFAULT_VIBE_BUILDER_DEPS,
): VibeBuilderSession {
  return new VibeBuilderSession(options, deps);
}

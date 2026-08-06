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
import { inspectFleetRoute } from "./fleetSnapshot";
import { choicesFor } from "./modelCatalog";
import { AGENT_CLIS, checkCliUpdates, checkInstalledClis } from "./projects";
import { DEFAULT_PROFILE, launchProfile } from "./profiles";
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
  BuilderSession,
  BuilderSessionState,
} from "./vibeBuilderSessionTypes";

const SAVE_CHECKPOINT = "Save this version";
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
  checkCommand?: string | null;
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
}

export interface CheckpointReview {
  context: CheckpointContext;
  repoRoot: string;
  paths: string[];
  diff: string;
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
  runCheck(command: string | null, cwd: string, at: number): Promise<CheckRunResult>;
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
  reserveAttempt: typeof reserveAttempt;
  /** Every route Canopy could launch this turn on, with its fleet state. */
  listRoutes(): Promise<RouteCandidate[]>;
  /** Installed version of a CLI, or null when it cannot be probed. */
  cliVersion(cli: string): Promise<string | null>;
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
  command: string | null,
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
    const spawned = await ipc.ptySpawnDetached({ cwd, command });
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
          note: `configured check timed out: ${command}`,
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
          ? `configured check passed: ${command}`
          : `configured check failed with exit ${result.exit_code ?? "signal"}: ${command}`,
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
  return {
    context: {
      isolatedOrGreenfield: args.baseline.isolated,
      cleanAtTurnStart: args.baseline.cleanAtStart,
      lineageUnchanged:
        args.baseline.head != null && tree?.head === args.baseline.head,
      pathsExclusive,
      // No in-app secret scanner exists yet. Unknown must fail closed.
      secretScanClean: false,
      noOpenIncident: args.noOpenIncident,
      verification: args.verification,
    },
    repoRoot,
    paths,
    diff: patches.join("\n\n"),
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

export const DEFAULT_VIBE_BUILDER_DEPS: VibeBuilderSessionDeps = {
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
): string {
  const unknown = contract.required.filter(
    (kind) => observations.find((observation) => observation.kind === kind)?.verdict !== "pass",
  );
  if (outcome === "verified") return "I checked the configured command and local preview — all required evidence passed.";
  const failed = observations.filter((observation) => observation.verdict === "fail");
  if (failed.length) return `Verification found a problem: ${failed.map((item) => item.note).join("; ")}`;
  return `Verification is incomplete: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} still unknown.`;
}

const refusalText: Record<string, string> = {
  "shared-or-converted-dirty": "this is not a dedicated isolated worktree",
  "dirty-at-start": "the checkout already had changes when the turn began",
  "lineage-moved": "the branch moved during the turn",
  "paths-contested": "another session claims one of the changed paths",
  "secrets-flagged": "an independent secret scan is not available yet",
  "incident-open": "a safety incident is still open",
  "not-verified": "the required verification is not fully green",
};

export class VibeBuilderSession implements BuilderSession {
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
  /** The message being worked on, replayed verbatim onto a reseeded attempt. */
  private currentGoal: string | null = null;
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
          "claude",
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

  send(text: string): Promise<void> {
    const message = text.trim();
    if (!message || this.stopped) return Promise.resolve();
    if (message === SAVE_CHECKPOINT && this.pendingCheckpoint) {
      return this.sendQueue.then(() => this.saveCheckpoint());
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
          kind: "question",
          prompt: "The app server keeps stopping.",
          detail: "I stopped restarting it. The failed run keeps the server output for inspection.",
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
    try {
      if (this.verifying) await this.verifying;
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
      case "turnEnd":
        if (this.verifying) return;
        this.hasRun = true;
        this.publish(event);
        this.verifying = this.verifyTurn()
          .catch((error) => {
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
            this.verifying = null;
            this.finishTurn?.();
            this.finishTurn = null;
          });
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

  private async verifyTurn(): Promise<void> {
    const reservation = this.reservation;
    const baseline = this.baseline;
    if (!reservation || !baseline || this.stopped) return;
    const runId = reservation.envelope.runId;
    const attemptId = reservation.attempt.attemptId;
    const goal = reservation.envelope.title ?? reservation.envelope.runId;
    const contract = contractFor(goal);

    await this.flushAssistant();

    this.present({ kind: "verify-running" }, null);
    const at = this.deps.now();
    const check = await this.deps.runCheck(
      this.options.checkCommand ?? null,
      this.options.componentPath,
      at,
    );
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
    if (this.stopped) return;
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
    const verdict = judgeVerification(contract, observations);
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
    if (this.stopped) return;
    const safeReview = {
      ...review,
      context: {
        ...review.context,
        noOpenIncident: review.context.noOpenIncident && !this.incidentOpen,
      },
    };
    const decision = checkpointDecision(safeReview.context);
    let summary = verificationSummary(contract, observations, verdict.outcome);
    this.pendingCheckpoint = null;

    if (decision.checkpoint && review.paths.length > 0) {
      const commit = await this.deps.commit(
        review.repoRoot,
        review.paths,
        `vibe: ${goal.slice(0, 72)}`,
      );
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
    } else if (!decision.checkpoint && review.paths.length > 0) {
      this.pendingCheckpoint = { review: safeReview, verification: verdict.outcome };
      const artifact = await this.deps
        .writeArtifact({ runId, attemptId, kind: "turn-diff", content: review.diff })
        .catch(() => null);
      await this.deps.appendEvent({
        runId,
        attemptId,
        kind: "checkpoint.refused",
        code: decision.reasons[0] ?? "policy",
        source: "canopy",
        confidence: "independent",
        metadata: {
          reasons: decision.reasons,
          artifactId: artifact?.id ?? null,
          secretScan: "unknown",
        },
      });
      this.present(
        verdict.outcome === "failed" ? { kind: "verify-failed" } : { kind: "verify-passed" },
        {
          id: `checkpoint-${attemptId}-${this.deps.now()}`,
          kind: "confirm",
          prompt: "This turn was not auto-saved.",
          detail: decision.reasons.map((reason) => refusalText[reason] ?? reason).join("; "),
          diff: review.diff,
          actions: [{ label: "Save this version", response: SAVE_CHECKPOINT }],
        },
      );
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
    this.publish({ kind: "reply", text: summary });
    this.publish({ kind: "turnEnd" });
    await this.finishAttempt(
      verdict.outcome === "verified" ? "completed" : "blocked",
    );
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
    return {
      bin: AGENT_CLIS.find((c) => c.id === cli)?.bin ?? this.options.cliBin,
      policy: {
        systemPromptAppend:
          `You are the Build-mode executor for ${this.options.projectName}. ` +
          `Work only inside ${this.options.componentPath}. Use Edit, Write, Read, Grep and Glob; ` +
          "do not use a shell. Explain outcomes in plain language. Canopy runs verification independently.",
        permissionMode: "acceptEdits",
        disallowedTools: ["Bash", "KillShell", "NotebookEdit"],
        // The model the route asked for, actually applied — it becomes
        // `--model`/`-m` at launch. Recording a requestedModel we never passed
        // would make the attempt record fiction.
        model: model ?? "",
        sessionId: this.cliSessionId,
        cwd: this.options.componentPath,
        authority: "workspace-write",
      },
      env: [
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

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
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

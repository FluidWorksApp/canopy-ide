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
  reserveTask,
  settleAttempt,
  startAttempt,
  writeTaskArtifact,
} from "./taskEnvelopes";
import type { TaskReservation } from "./taskEnvelope";
import { appendTranscript } from "./taskTranscript";
import {
  checkpointDecision,
  type CheckpointContext,
} from "./vibeCheckpoints";
import {
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

export interface VibeBuilderSessionOptions {
  projectId: string;
  projectName: string;
  componentId: string;
  componentPath: string;
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
  beginBrowserTurn(tabId: string | null): Promise<void>;
  inspectBrowser(
    tabId: string | null,
    visual: boolean,
    at: number,
  ): Promise<BrowserInspection>;
  reviewCheckpoint(args: {
    cwd: string;
    baseline: TurnBaseline;
    verification: VerificationOutcome;
    noOpenIncident: boolean;
  }): Promise<CheckpointReview>;
  commit(cwd: string, paths: string[], message: string): Promise<string>;
  now(): number;
  sessionId(): string;
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
): Promise<BrowserInspection> {
  if (!tabId) return unknownBrowser(at, visual, "no project preview is available");
  const before = await ipc.browserHere(tabId).catch(() => null);
  if (!before?.url) return unknownBrowser(at, visual, "the project preview has not loaded a route");
  await ipc.browserNavigate(tabId, null, "reload").catch(() => {});
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

  observations.push({
    kind: "network",
    verdict: "unknown",
    note: "network capture is page-lifetime, so this turn cannot claim it as independent evidence yet",
    at,
  });

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
  const prefix = component === root ? "" : `${component.slice(root.length).replace(/^\//, "")}/`;
  return entries.filter(
    (entry) =>
      entry.status !== "!!" &&
      (!prefix || entry.path === prefix.slice(0, -1) || entry.path.startsWith(prefix)),
  );
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
    if (!tabId) return;
    await ipc.browserRunOp(tabId, { op: "console", lines: 1, clear: true }).catch(() => null);
  },
  inspectBrowser: inspectNativeBrowser,
  reviewCheckpoint: reviewGitCheckpoint,
  commit: (cwd, paths, message) =>
    paths.length === 0 ? Promise.resolve("") : ipc.gitCommitPaths(cwd, message, paths),
  now: () => Date.now(),
  sessionId: randomId,
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

  private async ensureStarted(goal: string): Promise<ProjectRunnerTransport> {
    if (this.stopped) throw new Error("the builder session is closed");
    if (this.transport) return this.transport;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      this.baseline = await this.deps.captureBaseline(this.options.componentPath);
      if (this.stopped) throw new Error("the builder session was closed during launch");
      const contract = contractFor(goal);
      const route = {
        cli: "claude",
        cliVersion: null,
        executableFingerprint: null,
        profileId: "default",
        requestedModel: null,
        observedModel: null,
        harnessVersion: HARNESS_VERSION,
        promptVersion: PROMPT_VERSION,
        toolPolicyVersion: TOOL_POLICY_VERSION,
        executionMode: "structured" as const,
        selection: { policy: "vibe-mvp-claude", eligible: ["claude"] },
      };
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

      const launch: StructuredRunnerLaunch = {
        bin: this.options.cliBin,
        policy: {
          systemPromptAppend:
            `You are the Build-mode executor for ${this.options.projectName}. ` +
            `Work only inside ${this.options.componentPath}. Use Edit, Write, Read, Grep and Glob; ` +
            "do not use a shell. Explain outcomes in plain language. Canopy runs verification independently.",
          permissionMode: "acceptEdits",
          disallowedTools: ["Bash", "KillShell", "NotebookEdit"],
          model: "",
          sessionId: this.cliSessionId,
          cwd: this.options.componentPath,
          authority: "workspace-write",
        },
        env: [
          ["CANOPY_VIBE", "1"],
          ["CANOPY_RUN_ID", reservation.envelope.runId],
          ["CANOPY_ATTEMPT_ID", reservation.attempt.attemptId],
        ],
      };
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

  private async runTurn(
    message: string,
    sent: () => void,
    failed: (error: unknown) => void,
  ): Promise<void> {
    try {
      if (this.verifying) await this.verifying;
      if (this.stopped) throw new Error("the builder session is closed");
      this.pendingCheckpoint = null;
      const transport = await this.ensureStarted(message);
      if (this.stopped) throw new Error("the builder session is closed");
      const reservation = this.reservation;
      if (!reservation) throw new Error("the builder task was not reserved");
      this.incidentOpen = false;
      this.snapshot = { persona: { kind: "turn-started" }, question: null };
      await this.persist(() =>
        this.deps.appendTranscript({
          runId: reservation.envelope.runId,
          attemptId: reservation.attempt.attemptId,
          kind: "user",
          body: message,
        }),
      );
      await this.deps.beginBrowserTurn(this.options.previewTabId());
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
        this.finishTurn?.();
        this.finishTurn = null;
        this.incidentOpen = true;
        this.snapshot = {
          persona: { kind: "permission-stall" },
          question: {
            id: `runner-exit-${this.deps.now()}`,
            kind: "question",
            prompt: "The builder process stopped.",
            detail: "Send another message to start a fresh managed attempt.",
          },
        };
        void this.flushAssistant().finally(() =>
          this.settle("failed", "route", "process-exit"),
        );
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
    const decision = checkpointDecision(review.context);
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
      this.pendingCheckpoint = { review, verification: verdict.outcome };
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
    this.settled = true;
    await this.deps
      .settleAttempt({
        attemptId: this.reservation.attempt.attemptId,
        state,
        failureClass,
        failureCode,
      })
      .catch(() => {});
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

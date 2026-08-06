import * as ipc from "../ipc";
import {
  DEFAULT_VIBE_BUILDER_DEPS,
  type BrowserInspection,
  type CheckpointReview,
  type CheckRunResult,
  type VibeBuilderSessionDeps,
} from "../vibeBuilderSession";
import type { ProjectRunnerController } from "../projectRunner";
import type { StructuredRunnerEvent, StructuredRunnerHost } from "../structuredEvents";
import type { RouteCandidate } from "../vibeFailover";
import { scanDiffForSecrets } from "../vibeSecretScan";

export type VibeFixtureMode = "success" | "route-failure" | "task-failure" | "unusable" | "secret" | "deploy-dirty" | "deploy-clean";

export interface VibeFixtureTrace {
  hosts: StructuredRunnerHost[];
  events: StructuredRunnerEvent[];
  sends: string[];
  processBindings: string[];
  stoppedBindings: string[];
  checkRuns: number;
  browserBegins: number;
  browserInspections: number;
  mode: VibeFixtureMode;
  abstractionRuns: string[][];
  secret: string;
}

const route = (cli: "claude" | "codex", family: "anthropic" | "openai"): RouteCandidate => ({
  cli,
  profileId: "selftest",
  family,
  state: { agent: cli, profile: "selftest", kind: "ready", reasons: [] },
  choices: [{
    id: cli === "claude" ? "claude-selftest" : "gpt-selftest",
    label: `${cli} selftest`,
    hint: "deterministic selftest fixture",
  }],
});

const observation = (kind: "check" | "server" | "console" | "network" | "screenshot") => ({
  kind,
  verdict: "pass" as const,
  note: `${kind} observed by the deterministic selftest fixture`,
  at: Date.now(),
});

/**
 * External-world fixture for the selftest. Durable task/evidence operations
 * remain the production implementations from DEFAULT_VIBE_BUILDER_DEPS.
 */
export function createVibeSelftestFixture(projectDir: string): {
  deps: VibeBuilderSessionDeps;
  trace: VibeFixtureTrace;
  setMode(mode: VibeFixtureMode): void;
} {
  const trace: VibeFixtureTrace = {
    hosts: [], events: [], sends: [], processBindings: [], stoppedBindings: [],
    checkRuns: 0, browserBegins: 0, browserInspections: 0,
    mode: "success", abstractionRuns: [],
    secret: `AKIA${"S3LFTEST"}${"Q".repeat(8)}`,
  };

  const emit = (host: StructuredRunnerHost, event: StructuredRunnerEvent) => {
    trace.events.push(event);
    host.emit(event);
  };
  const runner: ProjectRunnerController = {
    start: async (attemptId, cliId, launch, host) => {
      trace.hosts.push(host);
      trace.processBindings.push(attemptId);
      return {
        send: async (message) => {
          trace.sends.push(message);
          if (trace.mode === "route-failure" && cliId === "claude") {
            emit(host, { kind: "error", message: "usage limit reached for your plan" });
            emit(host, { kind: "exit" });
            return;
          }
          if (trace.mode === "task-failure") {
            emit(host, { kind: "error", message: "prompt is too long: context window exceeded" });
            emit(host, { kind: "exit" });
            return;
          }
          emit(host, { kind: "tool", name: "Read", detail: "index.html" });
          emit(host, { kind: "tool", name: "Edit", detail: "primary button" });
          emit(host, { kind: "tool", name: "Read", detail: "verify colour" });
          emit(host, { kind: "delta", text: "I changed the " });
          const content = trace.mode === "secret"
            ? `<!doctype html><script>const API_KEY = "${trace.secret}"</script><button>Primary</button>`
            : "<!doctype html><button id=primary style=\"background:#2563eb;color:white\">Primary</button>";
          await ipc.fsWriteFile(
            `${launch.policy.cwd ?? projectDir}/index.html`,
            content,
          );
          emit(host, { kind: "delta", text: "primary button to blue." });
          // Let React paint the streamed chunks before verification replaces
          // the progress state. The scenario observes the intermediate DOM.
          await new Promise((resolve) => setTimeout(resolve, 100));
          emit(host, { kind: "turnEnd" });
        },
        stop: async () => { trace.stoppedBindings.push(attemptId); },
      };
    },
  };

  const runCheck = async (): Promise<CheckRunResult> => {
    trace.checkRuns += 1;
    return { observation: observation("check"), output: "selftest check passed" };
  };
  const inspectBrowser = async (): Promise<BrowserInspection> => {
    trace.browserInspections += 1;
    return { observations: [observation("server"), observation("console"), observation("network"), observation("screenshot")] };
  };
  const reviewCheckpoint = async (args: Parameters<VibeBuilderSessionDeps["reviewCheckpoint"]>[0]): Promise<CheckpointReview> => {
    const diff = trace.mode === "secret"
      ? `diff --git a/index.html b/index.html\n+++ b/index.html\n@@ -1,0 +1,1 @@\n+const API_KEY = "${trace.secret}";`
      : "diff --git a/index.html b/index.html\n+<button id=primary>Primary</button>";
    const secrets = scanDiffForSecrets(diff);
    return {
    context: {
      isolatedOrGreenfield: true,
      cleanAtTurnStart: true,
      lineageUnchanged: true,
      pathsExclusive: true,
      secretScanClean: secrets.clean,
      noOpenIncident: args.noOpenIncident,
      verification: args.verification,
    },
    repoRoot: projectDir,
    paths: ["index.html"],
    diff,
    secrets,
  };
  };

  const deps: VibeBuilderSessionDeps = {
      ...DEFAULT_VIBE_BUILDER_DEPS,
      runner,
      listRoutes: async () => trace.mode === "unusable"
        ? [{ ...route("claude", "anthropic"), state: { agent: "claude", profile: "selftest", kind: "unusable", reasons: ["signed-out"] } }]
        : [route("claude", "anthropic"), route("codex", "openai")],
      cliVersion: async () => "selftest",
      captureBaseline: async () => ({ cleanAtStart: true, head: "selftest-head", isolated: true, repoRoot: projectDir }),
      runCheck,
      beginBrowserTurn: async () => { trace.browserBegins += 1; return true; },
      inspectBrowser,
      reviewCheckpoint,
      autoCheckpointObserved: () => false,
      sleep: async () => {},
      abstractionContext: async (cwd, intent) => ({
        cwd,
        entries: intent.kind === "deploy" ? ["package.json", "vercel.json"] : ["package.json"],
        packageManagerField: "npm@selftest",
        dependencies: {}, devDependencies: {},
        link: { cliInstalled: true, authenticated: true, presentSecrets: [], envFileTracked: false },
        deploy: { dirty: trace.mode === "deploy-dirty", cliInstalled: true },
      }),
      runAbstraction: async (argv) => {
        trace.abstractionRuns.push(argv);
        return { ok: true, exitCode: 0, output: "selftest abstraction complete", timedOut: false };
      },
  };
  return {
    trace,
    deps,
    setMode: (mode) => { trace.mode = mode; },
  };
}

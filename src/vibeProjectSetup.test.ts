import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "./projects";
import {
  materializeVibeSetup,
  plainSetupActivity,
  observeVibeSetupRepository,
  parseVibeSetupOutput,
  validateVibeSetupProposal,
  runVibeProjectSetupTask,
  createVibeProjectSetupSession,
  type VibeProjectSetupProposal,
  type VibeSetupValidationContext,
} from "./vibeProjectSetup";
import * as ipc from "./ipc";
import type { RouteCandidate } from "./vibeFailover";
import { CANOPY_MCP_ALLOWANCE } from "./agentTools";
import { streamsStructured } from "./structuredRunners";
import type {
  VibeProjectSetupSessionDeps,
  VibeProjectSetupTaskDeps,
  VibeProjectSetupTaskResult,
} from "./vibeProjectSetup";

const launchEnvSync = vi.fn((_cliId: string) => [] as [string, string][]);
// Only launchEnvSync is faked. DEFAULT_PROFILE and launchProfile stay real, so
// this cannot pass by accident on a mock that also hides a real drift in
// those two.
vi.mock("./profiles", async (orig) => ({
  ...(await orig<typeof import("./profiles")>()),
  launchEnvSync: (cliId: string) => launchEnvSync(cliId),
}));

const root = "/repo";
const proposal = (): VibeProjectSetupProposal => ({
  schemaVersion: 1,
  repositoryFingerprint: "tree-1",
  components: [
    {
      key: "web",
      root: "/repo/apps/web",
      label: "Website",
      role: "web",
      commands: [{
        key: "dev",
        purpose: "serve",
        label: "Start website",
        argv: ["pnpm", "dev"],
        cwd: "/repo/apps/web",
        requiredEnvNames: ["API_URL"],
        readiness: { kind: "http", path: "/" },
      }, {
        key: "check",
        purpose: "check",
        label: "Check website",
        argv: ["pnpm", "typecheck"],
        cwd: "/repo/apps/web",
        requiredEnvNames: [],
        readiness: { kind: "one-shot", timeoutMs: 120_000 },
      }],
      evidence: ["/repo/apps/web/package.json"],
    },
    {
      key: "api",
      root: "/repo/services/api",
      label: "API",
      role: "api",
      commands: [{
        key: "serve",
        purpose: "serve",
        label: "Start API",
        argv: ["go", "run", "./cmd/api"],
        cwd: "/repo/services/api",
        requiredEnvNames: ["DATABASE_URL"],
        readiness: { kind: "http", path: "/health" },
      }],
      evidence: ["/repo/services/api/go.mod"],
    },
  ],
  preview: { componentKey: "web", commandKey: "dev" },
  requiredProcesses: [
    { componentKey: "web", commandKey: "dev", reason: "serves the page", requiredFor: "preview" },
    { componentKey: "api", commandKey: "serve", reason: "the page loads its data here", requiredFor: "preview" },
  ],
  externalServices: [{
    key: "database",
    providerId: "neon",
    label: "Database",
    purpose: "stores application data",
    requiredForPreview: true,
    usedByComponentKeys: ["api"],
    requiredEnvNames: ["DATABASE_URL"],
    evidence: ["/repo/services/api/go.mod"],
  }],
  deployment: null,
});

const project = (): Project => ({
  id: "p1",
  name: "Product",
  components: [
    { id: "cmp-web", label: "Old web label", path: "/repo/apps/web", commands: [] },
    { id: "cmp-api", label: "API", path: "/repo/services/api", commands: [] },
  ],
  vibe: { version: 1, enabled: true },
});

const context = (): VibeSetupValidationContext => ({
  projectRoot: root,
  repositoryFingerprint: "tree-1",
  existingPaths: new Set([
    "/repo", "/repo/apps/web", "/repo/apps/web/package.json",
    "/repo/services/api", "/repo/services/api/go.mod",
  ]),
  providerIds: new Set(["neon", "stripe"]),
  existingComponents: project().components,
});

describe("project setup repository observation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses one bounded native snapshot and derives directories for validation", async () => {
    const snapshot = vi.spyOn(ipc, "fsSnapshotFiles").mockResolvedValue([
      { path: "/repo/apps/web/package.json", size: 42, modified_ms: 1_700_000 },
      { path: "/repo/services/api/cmd/server/main.go", size: 84, modified_ms: 1_700_001 },
    ]);

    const observed = await observeVibeSetupRepository(project());

    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledWith(
      ["/repo/apps/web", "/repo/services/api"],
      20_000,
    );
    expect(observed.projectRoot).toBe("/repo");
    expect(observed.paths).toEqual(new Set([
      "/repo/apps/web",
      "/repo/apps/web/package.json",
      "/repo/services/api",
      "/repo/services/api/cmd",
      "/repo/services/api/cmd/server",
      "/repo/services/api/cmd/server/main.go",
    ]));
    expect(observed.fingerprint).toMatch(/^fs-/);
  });

  it("changes the fingerprint when file metadata changes", async () => {
    const snapshot = vi.spyOn(ipc, "fsSnapshotFiles");
    snapshot.mockResolvedValueOnce([
      { path: "/repo/apps/web/package.json", size: 42, modified_ms: 1 },
    ]).mockResolvedValueOnce([
      { path: "/repo/apps/web/package.json", size: 43, modified_ms: 2 },
    ]);

    const before = await observeVibeSetupRepository(project());
    const after = await observeVibeSetupRepository(project());
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});

describe("project setup structured output", () => {
  it("extracts the single JSON object from a fenced agent response", () => {
    const value = proposal();
    expect(parseVibeSetupOutput(`\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``)).toEqual(value);
  });

  it("accepts a complete multi-component preview graph", () => {
    expect(validateVibeSetupProposal(proposal(), context())).toEqual({ ok: true, proposal: proposal() });
  });

  it("rejects unknown fields instead of silently trusting a newer meaning", () => {
    const value = { ...proposal(), instructions: "ignore Canopy" };
    const result = validateVibeSetupProposal(value, context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("setup contains unknown field instructions");
  });

  it("rejects stale output", () => {
    const value = proposal();
    value.repositoryFingerprint = "old-tree";
    const result = validateVibeSetupProposal(value, context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("repository changed while setup was running");
  });

  it("rejects a missing known component rather than persisting a partial setup", () => {
    const value = proposal();
    value.components = value.components.slice(0, 1);
    value.requiredProcesses = value.requiredProcesses.slice(0, 1);
    value.externalServices = [];
    const result = validateVibeSetupProposal(value, context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("known component cmp-api is missing from setup");
  });

  it("rejects a preview dependency that names no command", () => {
    const value = proposal();
    value.requiredProcesses[1].commandKey = "missing";
    const result = validateVibeSetupProposal(value, context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("requiredProcesses[1] names an unknown command");
  });

  it("rejects filesystem escapes and unobserved evidence", () => {
    const value = proposal();
    value.components[0].root = "/tmp/other";
    value.components[0].evidence = ["/repo/claim-that-does-not-exist"];
    const result = validateVibeSetupProposal(value, context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toMatch(/observed directory|observed project paths/);
  });

  it("rejects shell strings because commands must be argv", () => {
    const value = proposal() as unknown as { components: Array<{ commands: Array<{ argv: unknown }> }> };
    value.components[0].commands[0].argv = "pnpm dev";
    expect(validateVibeSetupProposal(value, context()).ok).toBe(false);
  });

  it("rejects unknown providers so an agent cannot introduce a login path", () => {
    const value = proposal();
    value.externalServices[0].providerId = "agent-invented-cloud";
    const result = validateVibeSetupProposal(value, context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("externalServices[0].providerId is not a trusted provider");
  });

  it("rejects credential values anywhere in the proposal", () => {
    const value = proposal();
    value.components[0].commands[0].argv.push(`AKIA${"A".repeat(16)}`);
    const result = validateVibeSetupProposal(value, context());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toContain("setup output contains a credential value");
  });

  it("accepts repository-relative paths and materializes them absolutely", () => {
    const value = proposal();
    value.components[0].root = "apps/web";
    value.components[0].commands.forEach((command) => { command.cwd = "apps/web"; });
    value.components[0].evidence = ["apps/web/package.json"];
    const result = validateVibeSetupProposal(value, context());
    expect(result.ok).toBe(true);
    expect(materializeVibeSetup(project(), value, root).project.components[0].path).toBe("/repo/apps/web");
  });
});

describe("setup identity materialization", () => {
  it("preserves component ids and persists explicit preview and dependency ids", () => {
    const result = materializeVibeSetup(project(), proposal());
    expect(result.componentIds).toEqual({ web: "cmp-web", api: "cmp-api" });
    expect(result.project.vibe).toMatchObject({
      version: 1,
      componentId: "cmp-web",
      requiredProcesses: [
        { componentId: "cmp-web", runCommandId: expect.any(String) },
        { componentId: "cmp-api", runCommandId: expect.any(String) },
      ],
    });
    expect(result.project.components[0].commands?.[0].argv).toEqual(["pnpm", "dev"]);
  });

  it("keeps what each component is, so nothing downstream has to guess it", () => {
    // The survey establishes a role per component and materialization dropped
    // it, so the only surviving record of "this is an API with no UI" was the
    // proposal, which is not persisted. Anything reading the project later —
    // Build's starter suggestions were the case that caught this — could then
    // only infer a role from the directory name, which is the guessing this
    // whole survey exists to replace.
    const result = materializeVibeSetup(project(), proposal());
    expect(result.project.components.map((item) => item.role)).toEqual(["web", "api"]);
  });

  it("keeps ids stable across label-only changes", () => {
    const first = materializeVibeSetup(project(), proposal()).project;
    const renamed = proposal();
    renamed.components[0].label = "Customer-facing product";
    renamed.components[0].commands[0].label = "Open product";
    const second = materializeVibeSetup(first, renamed).project;
    expect(second.components[0].id).toBe(first.components[0].id);
    expect(second.components[0].commands?.[0].id).toBe(first.components[0].commands?.[0].id);
  });

  it("allocates a new command id when argv changes rather than silently retargeting", () => {
    const first = materializeVibeSetup(project(), proposal()).project;
    const changed = proposal();
    changed.components[0].commands[0].argv = ["pnpm", "dev", "--turbo"];
    const second = materializeVibeSetup(first, changed).project;
    expect(second.components[0].commands?.[0].id).not.toBe(first.components[0].commands?.[0].id);
  });
});

const routes = (): RouteCandidate[] => [{
  cli: "claude", profileId: "default", family: "anthropic",
  state: { agent: "claude", profile: "default", kind: "ready", reasons: [] },
  choices: [{ id: "claude-fable-5", label: "Fable", hint: "" }],
}, {
  cli: "codex", profileId: "default", family: "openai",
  state: { agent: "codex", profile: "default", kind: "ready", reasons: [] },
  choices: [{ id: "gpt-5.6-sol", label: "GPT", hint: "" }],
}];

function taskDeps(events: Array<Array<{ kind: string; text?: string; message?: string; tool?: string }>>): VibeProjectSetupTaskDeps & {
  launches: Array<{ cli: string; launch: import("./structuredRunners").StructuredRunnerLaunch }>;
  killed: string[];
  settlements: Array<{ state: string; failureCode?: string | null }>;
} {
  let ordinal = 1;
  const launches: Array<{ cli: string; launch: import("./structuredRunners").StructuredRunnerLaunch }> = [];
  const killed: string[] = [];
  const settlements: Array<{ state: string; failureCode?: string | null }> = [];
  return {
    launches, killed, settlements,
    listRoutes: async () => routes(),
    cliVersion: async () => "selftest",
    binFor: (cli) => cli,
    sessionId: () => `session-${ordinal}`,
    reserve: async (input) => ({
      envelope: { runId: "setup-run", projectId: input.projectId, componentId: input.componentId, kind: input.kind, status: "running", attemptCount: 1, createdAt: 1, updatedAt: 1 },
      attempt: { attemptId: "attempt-1", runId: "setup-run", ordinal: 1, state: "reserved", route: input.route },
    }),
    startAttempt: async () => {},
    settleAttempt: async (input) => { settlements.push(input); },
    reserveAttempt: async (input) => ({ attemptId: `attempt-${++ordinal}`, runId: input.runId, ordinal, state: "reserved", route: input.route, recoveryFromAttemptId: input.recoveryFromAttemptId }),
    runner: {
      start: async (attemptId, cli, launch, host) => {
        launches.push({ cli, launch });
        const mine = events.shift() ?? [];
        return {
          send: async () => {
            queueMicrotask(() => mine.forEach((event) => host.emit(event as never)));
          },
          stop: async () => { killed.push(attemptId); },
        };
      },
    },
  };
}

const taskInput = { projectId: "p1", projectName: "Product", projectRoot: "/repo", repositoryFingerprint: "tree-1", timeoutMs: 1_000 };

describe("bounded setup agent task", () => {
  afterEach(() => vi.useRealTimers());

  it("launches the agent read-only and returns parsed structured output", async () => {
    const deps = taskDeps([[{ kind: "delta", text: JSON.stringify(proposal()) }, { kind: "turnEnd" }]]);
    const result = await runVibeProjectSetupTask(taskInput, deps);
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(deps.launches[0]).toMatchObject({
      cli: "claude",
      launch: { policy: {
        authority: "read-only",
        // The whole sidecar, so a reader nobody listed cannot raise a prompt
        // with no one to answer it. Read-only is still enforced — by plan mode
        // and by what disallowedTools withholds, not by the canopy_* names.
        allowedTools: [CANOPY_MCP_ALLOWANCE],
        disallowedTools: expect.arrayContaining(["Bash", "Edit", "Write"]),
      } },
    });
    expect(deps.settlements).toContainEqual(expect.objectContaining({ state: "completed" }));
  });

  it("does not reserve a fictional task when no route is usable", async () => {
    const deps = taskDeps([]);
    deps.listRoutes = async () => [];
    const reserve = vi.spyOn(deps, "reserve");
    await expect(runVibeProjectSetupTask(taskInput, deps)).resolves.toMatchObject({ ok: false, reason: "no-agent", attempts: 0 });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("treats invalid structured output as a task failure without model shopping", async () => {
    const deps = taskDeps([[{ kind: "delta", text: "I think it is web" }, { kind: "turnEnd" }]]);
    const result = await runVibeProjectSetupTask(taskInput, deps);
    expect(result).toMatchObject({ ok: false, reason: "invalid-output", attempts: 1 });
    expect(deps.launches).toHaveLength(1);
    expect(deps.settlements).toContainEqual(expect.objectContaining({ state: "blocked", failureCode: "invalid-structured-output" }));
  });

  it("settles parseable but invalid schema as blocked rather than completed", async () => {
    const deps = taskDeps([[{ kind: "delta", text: JSON.stringify({ schemaVersion: 1 }) }, { kind: "turnEnd" }]]);
    const result = await runVibeProjectSetupTask({ ...taskInput, validateOutput: () => false }, deps);
    expect(result).toMatchObject({ ok: false, reason: "invalid-output", attempts: 1 });
    expect(deps.settlements).toContainEqual(expect.objectContaining({ state: "blocked", failureCode: "invalid-setup-schema" }));
    expect(deps.settlements).not.toContainEqual(expect.objectContaining({ state: "completed" }));
  });

  it("never fails over to a CLI it cannot launch", async () => {
    // The fixture runner will start anything; production cannot. Setup reads
    // its result off a JSON stream, and startStructured throws "has no verified
    // streaming runner" before a process exists for any CLI without one —
    // ranked anyway, every attempt in the cap died on that throw and Build
    // reported it as the agent failing to understand the project, with no
    // transcript, because no agent ever ran.
    //
    // Asserted against the capability rather than a name on purpose. This test
    // used to say "not codex", which was true only while codex had no runner —
    // so the day it got one the test failed for the wrong reason and the real
    // rule went unguarded. `amp` stands in for the CLIs that still have none.
    const deps = taskDeps([
      [{ kind: "error", message: "usage limit reached for your plan" }, { kind: "exit" }],
      [{ kind: "delta", text: JSON.stringify(proposal()) }, { kind: "turnEnd" }],
    ]);
    deps.listRoutes = async () => [
      ...routes(),
      {
        cli: "amp", profileId: "default", family: "anthropic",
        state: { agent: "amp", profile: "default", kind: "ready", reasons: [] },
        choices: [{ id: "claude-fable-5", label: "Fable", hint: "" }],
      },
    ];
    await runVibeProjectSetupTask(taskInput, deps);
    expect(deps.launches.length).toBeGreaterThan(0);
    for (const { cli } of deps.launches) expect(streamsStructured(cli)).toBe(true);
    expect(deps.launches.map((item) => item.cli)).not.toContain("amp");
  });

  it("fails over to codex, which now has a runner of its own", async () => {
    // The point of the whole one-shot runner: a person whose default agent is
    // codex, or whose claude route is rate-limited, gets a second place to go.
    // Before it existed the only eligible CLI was claude, so a route failure
    // had nowhere to go and retried the same exhausted account.
    const deps = taskDeps([
      [{ kind: "error", message: "usage limit reached for your plan" }, { kind: "exit" }],
      [{ kind: "delta", text: JSON.stringify(proposal()) }, { kind: "turnEnd" }],
    ]);
    const result = await runVibeProjectSetupTask(taskInput, deps);
    expect(deps.launches.map((item) => item.cli)).toEqual(["claude", "codex"]);
    expect(result).toMatchObject({ ok: true });
  });

  it("kills a timed-out attempt and returns a plain-language failure", async () => {
    vi.useFakeTimers();
    const deps = taskDeps([[]]);
    const pending = runVibeProjectSetupTask({ ...taskInput, attemptCap: 1 }, deps);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ ok: false, reason: "timeout", attempts: 1 });
    expect(deps.killed).toEqual(["attempt-1"]);
  });

  it("kills and interrupts an attempt when its project closes", async () => {
    const deps = taskDeps([[]]);
    const abort = new AbortController();
    const pending = runVibeProjectSetupTask({ ...taskInput, signal: abort.signal }, deps);
    await vi.waitFor(() => expect(deps.launches).toHaveLength(1));
    abort.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, attempts: 1 });
    expect(deps.killed).toEqual(["attempt-1"]);
    expect(deps.settlements).toContainEqual(expect.objectContaining({ state: "interrupted", failureCode: "project-closed" }));
  });

  it("ends the attempt on a block instead of filing it as a malformed proposal", async () => {
    // Before this fix, a setup agent that could not read the project returned
    // prose instead of JSON, and the attempt was filed as invalid-output —
    // blaming the model for what was actually a launch-policy fault.
    const deps = taskDeps([[{ kind: "blocked", tool: "mcp__canopy__canopy_project" }]]);
    const result = await runVibeProjectSetupTask(taskInput, deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toBe("invalid-output");
    // Every route shares the launch policy that blocked, so trying another one
    // would spend an attempt on an identical refusal.
    expect(deps.launches).toHaveLength(1);
  });

  it("carries the active profile's env into the setup launch, without shadowing Canopy's own", async () => {
    launchEnvSync.mockReturnValueOnce([["CLAUDE_CONFIG_DIR", "/tmp/profile/.claude"]]);
    const deps = taskDeps([[{ kind: "delta", text: JSON.stringify(proposal()) }, { kind: "turnEnd" }]]);
    await runVibeProjectSetupTask(taskInput, deps);
    const launch = deps.launches[0];
    expect(launch).toBeDefined();
    expect(launch!.launch.env).toBeDefined();
    const env = launch!.launch.env!;
    expect(env[0]).toEqual(["CLAUDE_CONFIG_DIR", "/tmp/profile/.claude"]);
    // Fixed and last, so the profile's entries — whatever a CLI adds later —
    // can never shadow the ones the attempt is correlated by.
    expect(env.slice(-3)).toEqual([
      ["CANOPY_VIBE_SETUP", "1"],
      ["CANOPY_RUN_ID", "setup-run"],
      ["CANOPY_ATTEMPT_ID", "attempt-1"],
    ]);
  });
});

describe("non-technical setup surface", () => {
  it("does not begin repository work until the Build surface owns the session", async () => {
    const observe = vi.fn(async () => ({
      projectRoot: root,
      componentRoots: ["/repo/apps/web", "/repo/services/api"],
      fingerprint: "tree-1",
      paths: context().existingPaths,
    }));
    const session = createVibeProjectSetupSession(
      project(),
      async () => true,
      {
        observe,
        run: async () => ({
          ok: false,
          reason: "agent-failed",
          message: "I couldn't inspect this project.",
          runId: null,
          attempts: 0,
        }),
        providerIds: context().providerIds,
      },
    );

    await Promise.resolve();
    expect(observe).not.toHaveBeenCalled();

    const unsubscribe = session.events$.subscribe(() => {});
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
    unsubscribe();
    await session.stop();
  });

  it("persists a valid proposal without ever presenting a technical question", async () => {
    const configured: Project[] = [];
    const ready = new Promise<void>((resolve) => {
      const session = createVibeProjectSetupSession(
        project(),
        async (next) => { configured.push(next); return true; },
        {
          observe: async () => ({
            projectRoot: root,
            componentRoots: ["/repo/apps/web", "/repo/services/api"],
            fingerprint: "tree-1",
            paths: context().existingPaths,
          }),
          run: async () => ({ ok: true, output: proposal(), runId: "setup-run", attempts: 1 }),
          providerIds: context().providerIds,
        },
      );
      expect(session.state.question).toBeNull();
      session.events$.subscribe((event) => {
        expect(session.state.question).toBeNull();
        if (event.kind === "ready") resolve();
      });
    });
    await ready;
    expect(configured).toHaveLength(1);
    expect(configured[0].vibe?.version).toBe(1);
  });

  it("keeps a correct survey when an unrelated file was saved while it ran", async () => {
    // Setup runs while the person is in Build, and a Build turn edits files —
    // so comparing the proposal's fingerprint against a FRESH observation made
    // Canopy invalidate its own setup by working. Observed against this
    // repository: a correct survey rejected for a stylesheet saved a minute
    // earlier. The echo check must stay pinned to what the agent was handed.
    const configured: Project[] = [];
    let observations = 0;
    const ready = new Promise<void>((resolve) => {
      const session = createVibeProjectSetupSession(
        project(),
        async (next) => { configured.push(next); return true; },
        {
          observe: async () => ({
            projectRoot: root,
            componentRoots: ["/repo/apps/web", "/repo/services/api"],
            // The second observation sees a changed tree, as it would after
            // any save anywhere in the project.
            fingerprint: (observations += 1) === 1 ? "tree-1" : "tree-2",
            paths: context().existingPaths,
          }),
          run: async () => ({ ok: true, output: proposal(), runId: "setup-run", attempts: 1 }),
          providerIds: context().providerIds,
        },
      );
      session.events$.subscribe((event) => {
        if (event.kind === "ready") resolve();
      });
    });
    await ready;
    expect(observations).toBe(2);
    expect(configured).toHaveLength(1);
  });

  it("does not buy a new model call every time a failed project is remounted", async () => {
    // A failure used to drop the flight, so the next mount started a fresh
    // run — and ProjectView remounts on every render pass, HMR update and
    // switch back. Against a project whose setup keeps failing that is an
    // unbounded loop of billed model calls, each able to run the full timeout
    // first. Sixty launches in twenty minutes were observed before this.
    const deps: VibeProjectSetupSessionDeps = {
      observe: vi.fn(async () => ({
        projectRoot: root,
        componentRoots: ["/repo/apps/web", "/repo/services/api"],
        fingerprint: "tree-1",
        paths: context().existingPaths,
      })),
      run: vi.fn(async () => ({
        ok: false as const,
        reason: "agent-failed" as const,
        message: "I couldn't determine a safe complete setup for this project.",
        runId: "setup-run",
        attempts: 2,
      })),
      providerIds: context().providerIds,
    };

    const first = createVibeProjectSetupSession(project(), async () => true, deps);
    const failed = new Promise<void>((resolve) => {
      first.events$.subscribe((event) => {
        if (event.kind === "reply" && event.text.includes("couldn't determine")) resolve();
      });
    });
    await failed;
    expect(deps.run).toHaveBeenCalledTimes(1);

    // Three remounts inside the cooldown. Each one replays the incident; none
    // of them spends anything.
    await first.stop();
    for (let mount = 0; mount < 3; mount += 1) {
      const again = createVibeProjectSetupSession(project(), async () => true, deps);
      again.events$.subscribe(() => {});
      await Promise.resolve();
      await again.stop();
    }
    expect(deps.run).toHaveBeenCalledTimes(1);
  });

  it("keeps one project-owned setup flight across view switches and an unchanged completed revision", async () => {
    let finishRun!: (result: VibeProjectSetupTaskResult) => void;
    const pendingRun = new Promise<VibeProjectSetupTaskResult>((resolve) => {
      finishRun = resolve;
    });
    const deps: VibeProjectSetupSessionDeps = {
      observe: vi.fn(async () => ({
        projectRoot: root,
        componentRoots: ["/repo/apps/web", "/repo/services/api"],
        fingerprint: "tree-1",
        paths: context().existingPaths,
      })),
      run: vi.fn(async () => pendingRun),
      providerIds: context().providerIds,
    };
    const persisted: Project[] = [];
    const persist = vi.fn(async (configured: Project) => {
      persisted.push(configured);
      return true;
    });

    const firstView = createVibeProjectSetupSession(project(), persist, deps);
    firstView.events$.subscribe(() => {});
    await vi.waitFor(() => expect(deps.run).toHaveBeenCalledTimes(1));

    // ProjectView cleanup represents both a Strict Mode replay and switching
    // away. Returning while discovery is live must attach to that same task,
    // not reserve and launch another one.
    await firstView.stop();
    const secondView = createVibeProjectSetupSession(project(), persist, deps);
    const ready = new Promise<void>((resolve) => {
      secondView.events$.subscribe((event) => {
        if (event.kind === "ready") resolve();
      });
    });
    await Promise.resolve();
    expect(deps.run).toHaveBeenCalledTimes(1);

    finishRun({ ok: true, output: proposal(), runId: "setup-run", attempts: 1 });
    await ready;
    expect(persist).toHaveBeenCalledTimes(1);

    // A render with the just-persisted project and the same repository
    // revision can replay the terminal result, but cannot spend another model
    // call or race a second persist against the first.
    const completedProject = persisted[0];
    expect(completedProject.vibe?.setupRevision).toBe("tree-1");
    const thirdView = createVibeProjectSetupSession(completedProject, persist, deps);
    const replayed = new Promise<void>((resolve) => {
      thirdView.events$.subscribe((event) => {
        if (event.kind === "ready") resolve();
      });
    });
    await replayed;
    expect(deps.run).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("stops plainly on invalid setup instead of falling back to a picker", async () => {
    const replies: string[] = [];
    const done = new Promise<void>((resolve) => {
      const session = createVibeProjectSetupSession(
        project(),
        async () => true,
        {
          observe: async () => ({
            projectRoot: root,
            componentRoots: ["/repo/apps/web", "/repo/services/api"],
            fingerprint: "tree-1",
            paths: context().existingPaths,
          }),
          run: async () => ({ ok: true, output: { nope: true }, runId: "setup-run", attempts: 1 }),
          providerIds: context().providerIds,
        },
      );
      session.events$.subscribe((event) => {
        if (event.kind === "reply") {
          replies.push(event.text);
          if (/safe complete setup/.test(event.text)) resolve();
        }
      });
    });
    await done;
    expect(replies.at(-1)).toBe("I couldn't determine a safe complete setup for this project.");
  });
});

describe("what the person is told a setup run is doing", () => {
  it("never puts a shell invocation in a pane that promises no technical steps", () => {
    // Codex reports a command as its literal argv — /bin/zsh -lc "sed -n
    // '1,220p' /Users/…" — and forwarding the tool event verbatim printed that
    // as a chip in Build, directly above the words "No technical steps needed".
    expect(plainSetupActivity("Shell")).toBe("Looking through your project");
    expect(plainSetupActivity("canopy_project")).toBe("Checking what Canopy already knows");
    // Silence for anything unnamed: a tool we have no phrasing for is more
    // likely jargon than not, and saying nothing beats leaking it.
    expect(plainSetupActivity("NotebookEdit")).toBeNull();
    expect(plainSetupActivity("mcp__someone_elses__tool")).toBeNull();
  });
});

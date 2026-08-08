import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskReservation } from "./taskEnvelope";
import {
  createVibeBuilderSession,
  DEFAULT_VIBE_BUILDER_DEPS,
  type VibeBuilderSessionDeps,
  type VibeBuilderSessionOptions,
  type VibeServerIncidentInput,
} from "./vibeBuilderSession";
import type { VibeRepairTaskResult } from "./vibeRepairSession";

const route = {
  cli: "claude",
  profileId: "default",
  harnessVersion: "1",
  promptVersion: "1",
  toolPolicyVersion: "1",
  executionMode: "structured" as const,
};

function reservation(): TaskReservation {
  return {
    envelope: {
      runId: "repair-record-run",
      projectId: "project-1",
      componentId: "web",
      kind: "vibe-server-health",
      title: "Build server crash loop",
      status: "running",
      attemptCount: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    attempt: {
      attemptId: "repair-record-attempt",
      runId: "repair-record-run",
      ordinal: 1,
      state: "reserved",
      route,
    },
  };
}

const options: VibeBuilderSessionOptions = {
  projectId: "project-1",
  projectName: "Paper Plane",
  componentId: "web",
  componentPath: "/repo/apps/web",
  cliId: "claude",
  cliBin: "claude",
  checkCommand: "pnpm check",
  projectComponents: [
    { id: "web", label: "Website", path: "/repo/apps/web", role: "web", commands: [] },
    { id: "api", label: "API", path: "/repo/services/api", role: "api", commands: [] },
  ],
  componentLinks: [{
    fromComponentId: "web",
    toComponentId: "api",
    kind: "http",
    description: "Website calls API",
  }],
  previewTabId: () => "preview-1",
};

const commands = [
  {
    id: "setup",
    name: "Install dependencies",
    command: "pnpm install",
    purpose: "setup" as const,
  },
  {
    id: "dev",
    name: "Start website",
    command: "pnpm dev",
    purpose: "serve" as const,
  },
];

function incident(
  over: Partial<VibeServerIncidentInput> = {},
): VibeServerIncidentInput {
  return {
    key: "web:dev",
    componentId: "web",
    runCommandId: "dev",
    exitCode: 127,
    crashTimes: [1_000, 2_000, 3_000],
    automaticRestarts: 2,
    ports: [5173],
    outputBytes: 72,
    totalCpu: 4,
    totalMemBytes: 1_024,
    logTail: Promise.resolve("sh: vite: command not found"),
    component: {
      label: "Website",
      path: "/repo/apps/web",
      role: "web",
    },
    commands,
    command: { name: "Start website", command: "pnpm dev" },
    ...over,
  };
}

type Repair = NonNullable<VibeBuilderSessionDeps["repair"]>;

function harness(repair: Repair) {
  const deps: VibeBuilderSessionDeps = {
    ...DEFAULT_VIBE_BUILDER_DEPS,
    reserve: vi.fn(async () => reservation()),
    startAttempt: vi.fn(async () => reservation().attempt),
    writeArtifact: vi.fn(async ({ kind }) => ({
      id: `artifact-${kind}`,
      runId: "repair-record-run",
      attemptId: "repair-record-attempt",
      kind,
      bytes: 32,
      createdAt: 1,
    })),
    appendEvent: vi.fn(async () => ({} as never)),
    settleAttempt: vi.fn(async () => reservation().attempt),
    sleep: vi.fn(async () => {}),
    now: () => 10,
    sessionId: () => "session-1",
    repair,
  };
  return { session: createVibeBuilderSession(options, deps), deps };
}

const fixed = (): VibeRepairTaskResult => ({
  ok: true,
  verdict: {
    diagnosis: "The project's dependencies had not been installed.",
    actions: [{ did: "Installed the dependencies and restarted the server." }],
    fixed: true,
  },
  runId: "repair-run",
});

const blocked = (blocker: string): VibeRepairTaskResult => ({
  ok: true,
  verdict: {
    diagnosis: "Another process is using the app's port.",
    actions: [],
    fixed: false,
    blocker,
  },
  runId: "repair-run",
});

beforeEach(() => vi.clearAllMocks());

describe("crash-loop repair wiring", () => {
  it("hands the resolved crash evidence and configured component to one repair", async () => {
    const repair = vi.fn<Repair>(async () => blocked("Close the other app."));
    const h = harness(repair);

    await expect(h.session.reportServerIncident(incident())).resolves.toBe("recorded");
    await vi.waitFor(() => expect(repair).toHaveBeenCalledTimes(1));

    expect(repair).toHaveBeenCalledWith({
      problem: expect.objectContaining({
        code: "server-crash-loop",
        component: {
          id: "web",
          label: "Website",
          path: "/repo/apps/web",
          role: "web",
        },
        commands,
        topology: expect.objectContaining({
          components: expect.arrayContaining([
            expect.objectContaining({ id: "api", path: "/repo/services/api" }),
          ]),
          componentLinks: [expect.objectContaining({ kind: "http" })],
        }),
        evidence: {
          logTail: "sh: vite: command not found",
          exitCode: 127,
          crashCount: 3,
        },
      }),
    });
  });

  it("presents a fixed verdict and lets the same incident key repair again", async () => {
    const repair = vi.fn<Repair>(async () => fixed());
    const h = harness(repair);

    await h.session.reportServerIncident(incident());
    await vi.waitFor(() => {
      expect(h.session.state.question?.prompt).toBe("Found it and fixed it.");
    });
    expect(h.session.state.persona.kind).toBe("idle");

    await h.session.reportServerIncident(incident());
    await vi.waitFor(() => expect(repair).toHaveBeenCalledTimes(2));
  });

  it("keeps a blocked repair presented as an incident and names the blocker", async () => {
    const blocker = "Please close the other app that is using port 5173.";
    const repair = vi.fn<Repair>(async () => blocked(blocker));
    const h = harness(repair);

    await h.session.reportServerIncident(incident());
    await vi.waitFor(() => {
      expect(h.session.state.question?.detail).toContain(blocker);
    });

    expect(h.session.state.persona.kind).toBe("incident");
    expect(h.session.state.question?.prompt).toBe(
      "I found what's wrong, and I need your help with one thing.",
    );
  });

  it("does not overlap repairs after recovery removes the incident dedupe key", async () => {
    let finishRepair!: (result: VibeRepairTaskResult) => void;
    const pendingRepair = new Promise<VibeRepairTaskResult>((resolve) => {
      finishRepair = resolve;
    });
    const repair = vi.fn<Repair>(() => pendingRepair);
    const h = harness(repair);
    const input = incident();

    await h.session.reportServerIncident(input);
    await vi.waitFor(() => expect(repair).toHaveBeenCalledTimes(1));
    h.session.resolveServerIncident(input.key);

    await h.session.reportServerIncident(input);
    expect(repair).toHaveBeenCalledTimes(1);

    finishRepair(blocked("Close the other app."));
    await vi.waitFor(() => {
      expect(h.session.state.question?.detail).toContain("Close the other app.");
    });
  });

  it("contains a rejected repair and leaves its incident key retryable", async () => {
    let calls = 0;
    const repair = vi.fn<Repair>(async () => {
      calls += 1;
      if (calls === 1) throw new Error("repair runner disconnected");
      return blocked("Reconnect the repair runner.");
    });
    const h = harness(repair);
    const input = incident();

    await expect(h.session.reportServerIncident(input)).resolves.toBe("recorded");
    await vi.waitFor(() => {
      expect(h.session.state.question?.detail).toContain(
        "The failed run keeps the server output for inspection.",
      );
    });

    await expect(h.session.reportServerIncident(input)).resolves.toBe("recorded");
    await vi.waitFor(() => expect(repair).toHaveBeenCalledTimes(2));
  });
});

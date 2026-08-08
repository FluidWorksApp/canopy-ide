import { describe, expect, it, vi } from "vitest";
import { runVibeRepairTask } from "./vibeRepairSession";
import type { VibeProjectSetupTaskDeps } from "./vibeProjectSetup";
import type { StructuredRunnerLaunch } from "./structuredRunners";
import type { TaskReserveInput } from "./taskEnvelope";
import type { RouteCandidate } from "./vibeFailover";
import { getVibePreviewAttemptTabId } from "./vibePreviewContext";

describe("environment provisioning repair launch", () => {
  it("records and launches with network authority instead of asking a non-technical person to provision", async () => {
    let reserved: TaskReserveInput | null = null;
    let launch: StructuredRunnerLaunch | null = null;
    let previewDuringRepair: string | null | undefined;
    const route: RouteCandidate = {
      cli: "claude",
      profileId: "default",
      family: "anthropic",
      state: { agent: "claude", profile: "default", kind: "ready" as const, reasons: [] },
      choices: [{ id: "claude-fable-5", label: "Fable", hint: "" }],
    };
    const deps: VibeProjectSetupTaskDeps = {
      listRoutes: async () => [route],
      cliVersion: async () => "selftest",
      binFor: () => "claude",
      sessionId: () => "session-1",
      reserve: async (input) => {
        reserved = input;
        return {
          envelope: {
            runId: "repair-run",
            projectId: input.projectId,
            componentId: input.componentId,
            kind: input.kind,
            status: "running",
            attemptCount: 1,
            createdAt: 1,
            updatedAt: 1,
          },
          attempt: {
            attemptId: "repair-attempt",
            runId: "repair-run",
            ordinal: 1,
            state: "reserved",
            route: input.route,
          },
        };
      },
      startAttempt: async () => {},
      settleAttempt: async () => {},
      reserveAttempt: vi.fn(async () => { throw new Error("not used"); }),
      runner: {
        start: async (_attemptId, _cli, policy, host) => {
          previewDuringRepair = getVibePreviewAttemptTabId(
            "project-1",
            "repair-attempt",
          );
          launch = policy;
          return {
            send: async () => queueMicrotask(() => {
              host.emit({
                kind: "delta",
                text: JSON.stringify({
                  diagnosis: "The package manager was missing.",
                  actions: [{ did: "Enabled it with Corepack and verified it." }],
                  fixed: true,
                }),
              });
              host.emit({ kind: "turnEnd" });
            }),
            stop: async () => {},
          };
        },
      },
    };

    await expect(runVibeRepairTask({
      timeoutMs: 2_000,
      previewTabId: "preview-original",
      problem: {
        code: "environment-missing",
        statement: "A tool this project needs is not installed yet.",
        projectId: "project-1",
        projectName: "Paper Plane",
        component: { id: "web", label: "Website", path: "/repo/apps/web" },
        commands: [],
        evidence: { context: "pnpm did not resolve." },
      },
    }, deps)).resolves.toMatchObject({ ok: true, verdict: { fixed: true } });

    expect(reserved).toMatchObject({
      authorityPolicy: {
        network: "allowed",
        provisioning: "corepack-version-manager-brew",
      },
    });
    expect(launch).toMatchObject({
      policy: { authority: "workspace-write", network: true },
    });
    expect(previewDuringRepair).toBe("preview-original");
    expect(getVibePreviewAttemptTabId("project-1", "repair-attempt")).toBeUndefined();
  });
});

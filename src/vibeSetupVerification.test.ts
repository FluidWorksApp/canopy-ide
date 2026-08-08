import { describe, expect, it, vi } from "vitest";
import type { Project, RunCommand } from "./projects";
import {
  verifyVibeSetupBeforePersist,
  type VibeSetupVerificationDeps,
} from "./vibeSetupVerification";

const command = (
  id: string,
  argv: string[],
  purpose: RunCommand["purpose"],
): RunCommand => ({
  id,
  name: id,
  command: argv.join(" "),
  argv,
  purpose,
  automatic: true,
  readiness: purpose === "setup"
    ? { kind: "one-shot", timeoutMs: 60_000 }
    : { kind: "process-alive" },
});

const project = (commands: RunCommand[]): Project => ({
  id: "project-1",
  name: "Paper Plane",
  components: [{
    id: "web",
    label: "Website",
    path: "/repo/apps/web",
    commands,
  }],
  vibe: {
    version: 1,
    enabled: true,
    requiredProcesses: commands
      .filter((item) => item.purpose !== "setup")
      .map((item) => ({
        componentId: "web",
        runCommandId: item.id,
        requiredFor: "project" as const,
      })),
  },
});

const deps = (installed: Record<string, boolean> = {}): VibeSetupVerificationDeps => ({
  which: vi.fn(async (executables: string[]) => Object.fromEntries(
    executables.map((executable: string) => [executable, installed[executable] ?? true]),
  )),
  proveReadiness: vi.fn(async () => ({ ok: true as const })),
});

describe("setup verification before persistence", () => {
  it("refuses a package-manager/lockfile mismatch before resolving or starting anything", async () => {
    const run = deps();
    const result = await verifyVibeSetupBeforePersist(
      project([
        command("install", ["pnpm", "install"], "setup"),
        command("serve", ["pnpm", "dev"], "serve"),
      ]),
      new Set(["/repo/apps/web/package-lock.json"]),
      run,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: "package-manager-mismatch",
        context: expect.stringContaining("selected pnpm"),
      },
    });
    expect(run.which).not.toHaveBeenCalled();
    expect(run.proveReadiness).not.toHaveBeenCalled();
  });

  it("understands corepack's selected manager and ambiguous nearest lockfiles", async () => {
    const result = await verifyVibeSetupBeforePersist(
      project([command("install", ["corepack", "pnpm", "install"], "setup")]),
      new Set([
        "/repo/apps/web/pnpm-lock.yaml",
        "/repo/apps/web/package-lock.json",
      ]),
      deps(),
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "package-manager-mismatch" },
    });
  });

  it("uses the workspace lockfile above a nested component", async () => {
    const run = deps();
    await expect(verifyVibeSetupBeforePersist(
      project([
        command("install", ["pnpm", "install"], "setup"),
        command("serve", ["pnpm", "dev"], "serve"),
      ]),
      new Set(["/repo/pnpm-lock.yaml"]),
      run,
    )).resolves.toEqual({ ok: true });
    expect(run.proveReadiness).toHaveBeenCalledTimes(1);
  });

  it("verifies survey argv without overwriting a person's persisted command spelling", async () => {
    const run = deps();
    const configured = project([command("serve", ["pnpm", "dev"], "serve")]);
    const persisted = configured.components[0].commands![0];
    persisted.command = "ORT_DYLIB_PATH=./lib.dylib pnpm dev";
    delete persisted.argv;

    await expect(verifyVibeSetupBeforePersist(
      configured,
      new Set(["/repo/pnpm-lock.yaml"]),
      run,
      undefined,
      new Map([["web:serve", ["pnpm", "dev"]]]),
    )).resolves.toEqual({ ok: true });

    expect(run.which).toHaveBeenCalledWith(["pnpm"]);
    expect(run.proveReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        argv: ["pnpm", "dev"],
        command: expect.objectContaining({
          command: "ORT_DYLIB_PATH=./lib.dylib pnpm dev",
        }),
      }),
      undefined,
    );
    expect(vi.mocked(run.proveReadiness).mock.calls[0][0].command)
      .not.toHaveProperty("argv");
  });

  it("classifies every unresolved argv[0] as environment-missing before proving readiness", async () => {
    const run = deps({ pnpm: false, go: false });
    const result = await verifyVibeSetupBeforePersist(
      project([
        command("install", ["pnpm", "install"], "setup"),
        command("api", ["go", "run", "./cmd/api"], "serve"),
      ]),
      new Set(["/repo/apps/web/pnpm-lock.yaml"]),
      run,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: "environment-missing",
        missingExecutables: ["pnpm", "go"],
      },
    });
    expect(run.which).toHaveBeenCalledWith(["pnpm", "go"]);
    expect(run.proveReadiness).not.toHaveBeenCalled();
  });

  it("requires every configured process to demonstrate readiness once", async () => {
    const run = deps();
    const configured = project([
      command("install", ["npm", "install"], "setup"),
      command("web", ["npm", "run", "dev"], "serve"),
      command("jobs", ["node", "worker.js"], "worker"),
    ]);

    await expect(verifyVibeSetupBeforePersist(
      configured,
      new Set(["/repo/apps/web/package-lock.json"]),
      run,
    )).resolves.toEqual({ ok: true });

    expect(run.which).toHaveBeenCalledWith(["npm", "node"]);
    expect(run.proveReadiness).toHaveBeenCalledTimes(2);
    expect(vi.mocked(run.proveReadiness).mock.calls.map(([target]) => target.command.id))
      .toEqual(["web", "jobs"]);
  });

  it("stops at the first process that cannot demonstrate readiness", async () => {
    const run = deps();
    vi.mocked(run.proveReadiness)
      .mockResolvedValueOnce({ ok: false, context: "readiness deadline expired" });
    const result = await verifyVibeSetupBeforePersist(
      project([command("web", ["npm", "run", "dev"], "serve")]),
      new Set(),
      run,
    );

    expect(result).toMatchObject({
      ok: false,
      failure: {
        code: "readiness-failed",
        context: "readiness deadline expired",
      },
    });
  });
});

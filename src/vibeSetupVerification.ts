import * as ipc from "./ipc";
import {
  classifyManagedProcess,
  MANAGED_PROCESS_ENV,
  type ManagedProcessClassification,
} from "./managedProcessSupervisor";
import type { Component, Project, RunCommand } from "./projects";

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface VibeSetupVerificationTarget {
  component: Component;
  command: RunCommand;
  /** Survey argv used for verification when persistence preserves a person's
   * richer legacy display spelling instead of replacing it. */
  argv: string[];
}

export type VibeSetupVerificationFailure =
  | {
      code: "environment-missing";
      statement: string;
      target: VibeSetupVerificationTarget;
      missingExecutables: string[];
      context: string;
    }
  | {
      code: "package-manager-mismatch";
      statement: string;
      target: VibeSetupVerificationTarget;
      missingExecutables: [];
      context: string;
    }
  | {
      code: "readiness-failed";
      statement: string;
      target: VibeSetupVerificationTarget;
      missingExecutables: [];
      context: string;
    };

export type VibeSetupVerificationResult =
  | { ok: true }
  | { ok: false; failure: VibeSetupVerificationFailure };

export interface VibeSetupVerificationDeps {
  which(commands: string[]): Promise<Record<string, boolean>>;
  proveReadiness(
    target: VibeSetupVerificationTarget,
    signal?: AbortSignal,
  ): Promise<{ ok: true; release?: () => Promise<void> } | { ok: false; context: string }>;
}

const LOCKFILES: ReadonlyArray<readonly [string, PackageManager]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const trimSlash = (path: string) => path.replace(/\/+$/, "");
const inside = (root: string, path: string) => {
  const base = trimSlash(root);
  return path === base || path.startsWith(`${base}/`);
};
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/"))) || "/";

function packageManagerFor(argv: readonly string[]): PackageManager | null {
  const executable = basename(argv[0] ?? "").toLowerCase();
  const candidate = executable === "corepack"
    ? (argv[1] ?? "").toLowerCase()
    : executable;
  if (candidate === "npm" || candidate === "npx") return "npm";
  if (candidate === "pnpm" || candidate === "pnpx") return "pnpm";
  if (candidate === "yarn" || candidate === "yarnpkg") return "yarn";
  if (candidate === "bun" || candidate === "bunx") return "bun";
  return null;
}

function lockfileManagers(
  cwd: string,
  existingPaths: ReadonlySet<string>,
): PackageManager[] {
  const roots = [...existingPaths]
    .filter((path) => LOCKFILES.some(([name]) => basename(path) === name))
    // A workspace lockfile commonly lives above the component (for example
    // /repo/pnpm-lock.yaml for /repo/apps/web). It governs the command when
    // its directory is an ancestor of cwd; sibling components never match.
    .filter((path) => inside(dirname(path), cwd))
    .sort((a, b) => dirname(b).length - dirname(a).length);
  if (!roots.length) return [];
  const nearest = dirname(roots[0]);
  return [...new Set(roots
    .filter((path) => dirname(path) === nearest)
    .flatMap((path) => LOCKFILES
      .filter(([name]) => basename(path) === name)
      .map(([, manager]) => manager)))];
}

function requiredTargets(
  project: Project,
  proposedArgv: ReadonlyMap<string, string[]>,
): VibeSetupVerificationTarget[] {
  return (project.vibe?.requiredProcesses ?? []).flatMap((required) => {
    const component = project.components.find((item) => item.id === required.componentId);
    const command = component?.commands?.find((item) => item.id === required.runCommandId);
    const argv = command?.argv ?? proposedArgv.get(`${required.componentId}:${required.runCommandId}`);
    return component && command && argv?.length ? [{ component, command, argv }] : [];
  });
}

function commandsToResolve(
  project: Project,
  proposedArgv: ReadonlyMap<string, string[]>,
): VibeSetupVerificationTarget[] {
  const setup = project.components.flatMap((component) =>
    (component.commands ?? [])
      .filter((command) => command.purpose === "setup" && command.automatic !== false)
      .flatMap((command) => {
        const argv = command.argv ?? proposedArgv.get(`${component.id}:${command.id}`);
        return argv?.length ? [{ component, command, argv }] : [];
      }),
  );
  const seen = new Set<string>();
  return [...setup, ...requiredTargets(project, proposedArgv)].filter(({ component, command }) => {
    const key = `${component.id}:${command.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The last gate before setup is persisted. It deliberately validates every
 * executable and every package-manager choice before starting even one
 * proposed process. That all-at-once preflight is what prevents a later
 * missing binary from leaving an earlier install half-applied.
 */
export async function verifyVibeSetupBeforePersist(
  project: Project,
  existingPaths: ReadonlySet<string>,
  deps: VibeSetupVerificationDeps,
  signal?: AbortSignal,
  proposedArgv: ReadonlyMap<string, string[]> = new Map(),
): Promise<VibeSetupVerificationResult> {
  const targets = commandsToResolve(project, proposedArgv);

  for (const target of targets) {
    const { component, command } = target;
    if (command.purpose !== "setup") continue;
    const selected = packageManagerFor(target.argv);
    if (!selected) continue;
    const observed = lockfileManagers(
      command.cwd ?? component.path,
      existingPaths,
    );
    if (observed.length === 1 && observed[0] === selected) continue;
    if (observed.length === 0) continue;
    return {
      ok: false,
      failure: {
        code: "package-manager-mismatch",
        statement: `The proposed setup does not match this component's dependency files.`,
        target,
        missingExecutables: [],
        context: `The command selected ${selected}, while the nearest lockfile selects ${observed.join(" and ")}. No setup command was started.`,
      },
    };
  }

  const executables = [...new Set(targets.map(({ argv }) => argv[0]))];
  const installed = executables.length ? await deps.which(executables) : {};
  const missing = executables.filter((command) => installed[command] !== true);
  if (missing.length) {
    const target = targets.find(({ argv }) => missing.includes(argv[0]));
    if (target) {
      return {
        ok: false,
        failure: {
          code: "environment-missing",
          statement: "A tool this project needs is not installed yet.",
          target,
          missingExecutables: missing,
          context: `These executables did not resolve on the login-shell PATH: ${missing.join(", ")}.`,
        },
      };
    }
  }

  const releases: Array<() => Promise<void>> = [];
  const completed = new Set<string>();
  const visiting = new Set<string>();
  const ordered: VibeSetupVerificationTarget[] = [];
  const keyOf = (target: VibeSetupVerificationTarget) => `${target.component.id}:${target.command.id}`;
  const visit = (target: VibeSetupVerificationTarget) => {
    const key = keyOf(target);
    if (completed.has(key)) return;
    if (visiting.has(key)) throw new Error(`Cyclic process dependency: ${key}`);
    visiting.add(key);
    const identity = project.vibe?.requiredProcesses?.find((item) => `${item.componentId}:${item.runCommandId}` === key);
    for (const dependency of identity?.dependsOn ?? []) {
      const next = targets.find((candidate) => keyOf(candidate) === `${dependency.componentId}:${dependency.runCommandId}`);
      if (!next) throw new Error(`Missing process dependency: ${dependency.componentId}:${dependency.runCommandId}`);
      visit(next);
    }
    for (const setup of targets.filter((candidate) => candidate.component.id === target.component.id && candidate.command.purpose === "setup")) {
      if (setup !== target && !completed.has(keyOf(setup))) {
        ordered.push(setup);
        completed.add(keyOf(setup));
      }
    }
    if (!completed.has(key)) ordered.push(target);
    completed.add(key);
    visiting.delete(key);
  };
  for (const target of requiredTargets(project, proposedArgv)) visit(target);
  for (const target of targets) if (!completed.has(keyOf(target))) visit(target);

  try {
    for (const target of ordered) {
      if (signal?.aborted) throw new DOMException("Setup verification was cancelled", "AbortError");
      const proof = await deps.proveReadiness(target, signal);
      if (proof.ok && proof.release) releases.push(proof.release);
      if (!proof.ok) {
        return {
          ok: false,
          failure: {
            code: "readiness-failed",
            statement: `${target.component.label} did not become ready from its proposed start command.`,
            target,
            missingExecutables: [],
            context: proof.context,
          },
        };
      }
    }
    return { ok: true };
  } finally {
    // Keep DB/API dependencies alive through the entire proof, then unwind in
    // reverse startup order. Never stop processes outside this verification.
    for (const release of releases.reverse()) await release().catch(() => {});
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms));

async function proveReadinessWithManagedProcess(
  target: VibeSetupVerificationTarget,
  signal?: AbortSignal,
): Promise<{ ok: true; release?: () => Promise<void> } | { ok: false; context: string }> {
  const { component, command } = target;
  const startedAt = Date.now();
  let targetId: number | null = null;
  let exited: ipc.PtyExit | null = null;
  const early: ipc.PtyExit[] = [];
  let retained = false;
  const unlisten = await ipc.onPtyExit((event) => {
    if (targetId == null) early.push(event);
    else if (event.id === targetId) exited = event;
  });
  try {
    const spawned = await ipc.ptySpawnArgv({
      cwd: command.cwd ?? component.path,
      argv: target.argv,
      env: [...MANAGED_PROCESS_ENV],
    });
    targetId = spawned.id;
    exited = early.find((event) => event.id === targetId) ?? null;
    let handledPromptAt: number | null = null;
    while (!signal?.aborted) {
      const now = Date.now();
      const stats = (await ipc.ptyStats()).find((sample) => sample.id === targetId);
      const rawOutput = (await ipc.ptyOutput(targetId, 16 * 1024)) ?? "";
      const httpReady = command.readiness?.kind === "http"
        ? (await Promise.all((stats?.ports ?? []).map((port) => ipc.probeHttpReadiness(port, command.readiness!.kind === "http" ? command.readiness!.path : "/").catch(() => false)))).some(Boolean)
        : false;
      const classification: ManagedProcessClassification = classifyManagedProcess({
        kind: command.purpose,
        now,
        spawnedAt: startedAt,
        outputBytes: stats?.output_bytes ?? 0,
        quietMs: stats?.quiet_ms ?? now - startedAt,
        ports: stats?.ports ?? [],
        readinessKind: command.readiness?.kind,
        readinessTimeoutMs: command.readiness?.timeoutMs,
        httpReady,
        rawOutput,
        exited: exited !== null,
        exitCode: exited?.exit_code ?? null,
        safePromptHandledAt: handledPromptAt,
      });
      if (classification.exit === "auto-answer" && classification.prompt?.kind === "safe-confirmation") {
        if (handledPromptAt == null) {
          handledPromptAt = now;
          await ipc.ptyWrite(targetId, classification.prompt.response);
        }
      } else if (classification.state === "ready") {
        retained = true;
        return { ok: true, release: async () => {
          unlisten();
          if (targetId != null && exited == null) await ipc.ptyKill(targetId);
        } };
      } else if (classification.state === "exited-ok") {
        return { ok: true };
      } else if (classification.exit === "repair") {
        return {
          ok: false,
          context: classification.state === "waiting-on-input"
            ? "The command stopped for an interactive decision before it became ready."
            : classification.state === "hung"
              ? "The command reached its readiness deadline without becoming ready."
              : `The command exited before becoming ready (exit ${exited?.exit_code ?? "signal"}).`,
        };
      } else if (exited !== null) {
        return { ok: false, context: "The command exited before demonstrating readiness." };
      }
      await sleep(500);
    }
    throw new DOMException("Setup verification was cancelled", "AbortError");
  } finally {
    if (!retained) {
      unlisten();
      if (targetId != null && exited == null) await ipc.ptyKill(targetId);
    }
  }
}

export const DEFAULT_VIBE_SETUP_VERIFICATION_DEPS: VibeSetupVerificationDeps = {
  which: (commands) => ipc.whichCheck(commands),
  proveReadiness: proveReadinessWithManagedProcess,
};

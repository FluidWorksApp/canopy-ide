import { describe, expect, it } from "vitest";
import {
  classifyManagedProcess,
  detectManagedProcessPrompt,
  MANAGED_PROCESS_ENV,
  MANAGED_PROCESS_KINDS,
  MANAGED_PROCESS_STALL_MS,
  MANAGED_PROCESS_STATES,
  MANAGED_PROMPT_RESPONSE_TIMEOUT_MS,
  plainManagedOutput,
  unattendedManagedRunCommand,
  type ManagedProcessObservation,
} from "./managedProcessSupervisor";

describe("unattended managed run commands", () => {
  it("stamps the shared unattended environment", () => {
    expect(Object.fromEntries(MANAGED_PROCESS_ENV)).toMatchObject({
      CI: "1",
      npm_config_yes: "true",
      NO_UPDATE_NOTIFIER: "1",
    });
  });

  it("suppresses npx installation and Trigger.dev update prompts", () => {
    expect(unattendedManagedRunCommand({
      command: "npx trigger.dev@latest dev",
      purpose: "worker",
    })).toBe("npx --yes trigger.dev@latest dev --skip-update-check");
  });

  it("keeps already unattended flags idempotent", () => {
    const command = "npx --yes trigger.dev@latest dev --skip-update-check";
    expect(unattendedManagedRunCommand({ command, purpose: "worker" })).toBe(command);
  });

  it("only forces a bare pnpm setup install", () => {
    expect(unattendedManagedRunCommand({ command: "pnpm install", purpose: "setup" }))
      .toBe("pnpm install --force");
    expect(unattendedManagedRunCommand({ command: "pnpm install react", purpose: "setup" }))
      .toBe("pnpm install react");
    expect(unattendedManagedRunCommand({ command: "pnpm install", purpose: "serve" }))
      .toBe("pnpm install");
  });

  it("uses npm's documented yes configuration for a setup install", () => {
    expect(unattendedManagedRunCommand({ command: "npm install", purpose: "setup" }))
      .toBe("npm install --yes");
  });
});

describe("managed process prompt detection", () => {
  it("recognizes the npx install confirmation through terminal colour", () => {
    const prompt = detectManagedProcessPrompt(
      "\u001b[33mNeed to install the following packages:\u001b[0m\r\ntrigger.dev@4.5.10\r\nOk to proceed? (y)",
    );
    expect(prompt).toMatchObject({
      kind: "safe-confirmation",
      code: "npx-install",
      response: "y\r",
    });
  });

  it("recognizes pnpm's incompatible modules reinstall confirmation", () => {
    expect(detectManagedProcessPrompt(
      'The modules directory at "/repo/node_modules" will be removed and reinstalled from scratch. Proceed? (Y/n)',
    )).toMatchObject({ kind: "safe-confirmation", code: "pnpm-modules-reinstall" });
  });

  it("routes account and selection prompts for agent inspection", () => {
    expect(detectManagedProcessPrompt("Authenticate with Trigger.dev? Open the browser:"))
      .toMatchObject({ kind: "interactive", code: "authentication" });
    expect(detectManagedProcessPrompt("Choose a project:"))
      .toMatchObject({ kind: "interactive", code: "selection" });
  });

  it("does not treat normal server output as a prompt", () => {
    expect(detectManagedProcessPrompt("ready - started server on 0.0.0.0:3000")).toBeNull();
    expect(plainManagedOutput("\u001b[32mready\u001b[0m")).toBe("ready");
  });
});

describe("managed process exit matrix", () => {
  const at = 100_000;
  const base: ManagedProcessObservation = {
    now: at,
    spawnedAt: at - 1_000,
    outputBytes: 0,
    quietMs: 1_000,
    ports: [],
    readinessKind: "process-alive",
    rawOutput: "",
  };

  const samples = {
    spawning: { ...base },
    working: { ...base, outputBytes: 20, rawOutput: "Compiling" },
    "waiting-on-input": { ...base, rawOutput: "Choose a project:" },
    ready: {
      ...base,
      spawnedAt: at - 3_000,
      outputBytes: 20,
      rawOutput: "Worker online",
    },
    "exited-ok": { ...base, exited: true, exitCode: 0 },
    failed: { ...base, exited: true, exitCode: 1 },
    hung: { ...base, spawnedAt: at - MANAGED_PROCESS_STALL_MS },
  } satisfies Record<(typeof MANAGED_PROCESS_STATES)[number], ManagedProcessObservation>;
  const expectedExit = {
    spawning: "observe",
    working: "observe",
    "waiting-on-input": "repair",
    ready: "complete",
    "exited-ok": "complete",
    failed: "repair",
    hung: "repair",
  } as const;

  const matrix = MANAGED_PROCESS_KINDS.flatMap((kind) =>
    MANAGED_PROCESS_STATES.map((state) => ({ kind, state })),
  );

  it.each(matrix)("maps $kind × $state to a bounded agent/chat exit", ({ kind, state }) => {
    const result = classifyManagedProcess({ ...samples[state], kind });
    expect(result).toMatchObject({ kind, state, exit: expectedExit[state] });
    expect(["agent-exit", "chat-card-exit"]).toContain(result.surface);
    if (state !== "ready" && state !== "exited-ok") {
      expect(result.deadlineAt).not.toBeNull();
    }
  });

  it("uses the declared HTTP path result, never an unrelated listening port", () => {
    expect(classifyManagedProcess({
      ...base,
      readinessKind: "http",
      ports: [3000],
      httpReady: false,
    })).toMatchObject({ state: "spawning", exit: "observe" });
    expect(classifyManagedProcess({
      ...base,
      readinessKind: "http",
      ports: [3000],
      httpReady: true,
    })).toMatchObject({ state: "ready", exit: "complete" });
  });

  it("anchors readiness deadlines to spawn even while output keeps changing", () => {
    const before = classifyManagedProcess({
      ...base,
      spawnedAt: at - MANAGED_PROCESS_STALL_MS + 1,
      outputBytes: 500,
      quietMs: 0,
      readinessKind: "http",
      httpReady: false,
    });
    expect(before).toMatchObject({ state: "working", deadlineAt: at + 1 });
    expect(classifyManagedProcess({
      ...base,
      spawnedAt: at - MANAGED_PROCESS_STALL_MS,
      outputBytes: 600,
      quietMs: 0,
      readinessKind: "http",
      httpReady: false,
    })).toMatchObject({ state: "hung", exit: "repair", deadlineAt: at });
  });

  it("honours a one-shot command's declared bounded timeout", () => {
    expect(classifyManagedProcess({
      ...base,
      readinessKind: "one-shot",
      readinessTimeoutMs: 120_000,
      spawnedAt: at - 60_000,
    })).toMatchObject({ state: "spawning", deadlineAt: at + 60_000 });
  });

  it("auto-answers a supported prompt, then repairs if it stays stuck", () => {
    const rawOutput = "Need to install the following packages:\nfoo@1\nOk to proceed? (y)";
    expect(classifyManagedProcess({ ...base, rawOutput })).toMatchObject({
      state: "waiting-on-input",
      exit: "auto-answer",
    });
    expect(classifyManagedProcess({
      ...base,
      rawOutput,
      safePromptHandledAt: at - MANAGED_PROMPT_RESPONSE_TIMEOUT_MS,
    })).toMatchObject({ state: "waiting-on-input", exit: "repair" });
  });

  it("routes decisions to repair without guessing an answer", () => {
    expect(classifyManagedProcess({ ...base, rawOutput: "Choose a project:" }))
      .toMatchObject({ state: "waiting-on-input", exit: "repair" });
  });
});

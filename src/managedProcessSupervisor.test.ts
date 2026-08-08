import { describe, expect, it } from "vitest";
import {
  classifyManagedProcess,
  detectManagedProcessPrompt,
  MANAGED_PROCESS_ENV,
  MANAGED_PROCESS_STALL_MS,
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

  it.each([
    ["spawning", { ...base }, "observe"],
    ["working", { ...base, outputBytes: 20, rawOutput: "Compiling" }, "observe"],
    ["ready", { ...base, spawnedAt: at - 3_000, outputBytes: 20, rawOutput: "Worker online" }, "complete"],
    ["ready", { ...base, readinessKind: "port" as const, ports: [3000] }, "complete"],
    ["exited-ok", { ...base, exited: true, exitCode: 0 }, "complete"],
    ["failed", { ...base, exited: true, exitCode: 1 }, "repair"],
    ["hung", { ...base, quietMs: MANAGED_PROCESS_STALL_MS }, "repair"],
  ] as const)("maps %s to its required exit", (state, observation, exit) => {
    expect(classifyManagedProcess(observation)).toMatchObject({ state, exit });
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

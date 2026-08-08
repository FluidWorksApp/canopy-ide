import { describe, expect, it } from "vitest";
import {
  REPAIR_AUTONOMOUS,
  REPAIR_CONFIRM_FIRST,
  parseRepairVerdict,
  plainRepairActivity,
  repairPrompt,
  type RepairProblem,
} from "./vibeRepair";

const problem = (): RepairProblem => ({
  code: "server-crash-loop",
  statement: "The app stopped three times while it was starting.",
  projectId: "project-1",
  projectName: "Paper Plane",
  component: {
    id: "component-web",
    label: "Website",
    path: "/repo/apps/web",
    role: "web",
  },
  runCommand: {
    id: "command-dev",
    name: "Start website",
    command: "pnpm dev",
  },
  commands: [
    {
      id: "command-install",
      name: "Install dependencies",
      command: "pnpm install",
      purpose: "setup",
    },
    {
      id: "command-check",
      name: "Check website",
      command: "pnpm typecheck",
      purpose: "check",
    },
    {
      id: "command-dev",
      name: "Start website",
      command: "pnpm dev",
      purpose: "serve",
    },
  ],
  evidence: {
    logTail: "Error: Cannot find module 'vite'",
    exitCode: 1,
    crashCount: 3,
    context: "The server never became ready.",
  },
});

describe("repair prompt", () => {
  it("includes every authority clause verbatim and stops after declined confirmation", () => {
    const { system } = repairPrompt(problem());

    for (const clause of REPAIR_AUTONOMOUS) expect(system).toContain(clause);
    for (const clause of REPAIR_CONFIRM_FIRST) expect(system).toContain(clause);
    expect(system).toContain(
      "If the user says no or does not answer, do not do the action and do not find a sneaky equivalent. Report it as the blocker instead.",
    );
  });

  it("names the component scope and embeds the exact verdict shape", () => {
    const { system } = repairPrompt(problem());

    expect(system).toContain("repair agent for Paper Plane");
    expect(system).toContain("failure surfaced in /repo/apps/web");
    expect(system).toContain("trace the failure across component, process, API, queue, and database boundaries");
    expect(system).toContain("Edits remain limited to /repo/apps/web");
    expect(system).toContain('"diagnosis"');
    expect(system).toContain('"actions"');
    expect(system).toContain('"fixed"');
    expect(system).toContain('"blocker"');
  });

  it("embeds the evidence and known command purposes", () => {
    const { user } = repairPrompt(problem());

    expect(user).toContain("```text\nError: Cannot find module 'vite'\n```");
    expect(user).toContain("Exit code: 1");
    expect(user).toContain("Crash count: 3");
    expect(user).toContain("Install dependencies [purpose: setup]: pnpm install");
    expect(user).toContain("Check website [purpose: check]: pnpm typecheck");
    expect(user).toContain("Start website [purpose: serve]: pnpm dev");
    expect(user).toContain("Diagnose first from the evidence given");
    expect(user).toContain("Verify that the fix actually works");
  });
});

describe("repair verdict", () => {
  it("accepts fenced JSON surrounded by prose and preserves confirmation", () => {
    const verdict = {
      diagnosis: "A dependency used to start the app was missing.",
      actions: [
        { did: "Installed the dependencies from the project manifest." },
        { did: "Removed a generated cache directory.", confirmed: true },
      ],
      fixed: true,
    };

    expect(parseRepairVerdict(
      `I found the problem.\n\n\`\`\`json\n${JSON.stringify(verdict)}\n\`\`\`\nDone.`,
    )).toEqual(verdict);
  });

  it("accepts an unfenced verdict surrounded by prose", () => {
    expect(parseRepairVerdict(
      'Result:\n{"diagnosis":"The port was busy.","actions":[],"fixed":false,"blocker":"Another app still owns the port."}\nEnd.',
    )).toEqual({
      diagnosis: "The port was busy.",
      actions: [],
      fixed: false,
      blocker: "Another app still owns the port.",
    });
  });

  it("rejects a verdict missing fixed instead of guessing", () => {
    expect(parseRepairVerdict(
      '{"diagnosis":"A dependency was missing.","actions":[]}',
    )).toBeNull();
  });

  it("rejects malformed actions and blocker states", () => {
    expect(parseRepairVerdict(
      '{"diagnosis":"Broken.","actions":[{"did":4}],"fixed":true}',
    )).toBeNull();
    expect(parseRepairVerdict(
      '{"diagnosis":"Broken.","actions":[],"fixed":false}',
    )).toBeNull();
    expect(parseRepairVerdict(
      '{"diagnosis":"Fixed.","actions":[],"fixed":true,"blocker":"Still broken."}',
    )).toBeNull();
    expect(parseRepairVerdict(
      '{"diagnosis":"Fixed.","actions":[],"fixed":true,"confidence":1}',
    )).toBeNull();
  });
});

describe("plain repair activity", () => {
  it.each([
    ["Shell", "Trying a fix"],
    ["Bash", "Trying a fix"],
    ["Read", "Reading the error"],
    ["Grep", "Reading the error"],
    ["Glob", "Reading the error"],
    ["canopy_server_status", "Checking the server"],
    ["canopy_restart_server", "Checking the server"],
    ["canopy_wait_for", "Checking the server"],
    ["canopy_browser_open", "Looking at the app"],
    ["canopy_ask_user", "Waiting for your OK"],
  ])("maps %s without exposing tool details", (tool, expected) => {
    expect(plainRepairActivity(tool)).toBe(expected);
  });

  it("does not show shell text or unknown tools", () => {
    expect(plainRepairActivity("Bash")).toBe("Trying a fix");
    expect(plainRepairActivity("pnpm dev")).toBeNull();
    expect(plainRepairActivity("UnknownTool")).toBeNull();
  });
});

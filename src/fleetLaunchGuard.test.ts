/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const projectView = readFileSync(
  join(ROOT, "src/components/ProjectView/index.tsx"),
  "utf8",
);
const settings = readFileSync(
  join(ROOT, "src/components/SettingsDialog.tsx"),
  "utf8",
);

function bodyBetween(start: string, end: string): string {
  const from = projectView.indexOf(start);
  const to = projectView.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThanOrEqual(0);
  expect(to, end).toBeGreaterThan(from);
  return projectView.slice(from, to);
}

describe("managed launch fleet gates", () => {
  it("gates a fresh agent before creating its command or terminal", () => {
    const body = bodyBetween("const startAgentInDir", "const [microRuns");
    expect(body.indexOf("gateManagedLaunch(cli, installed)")).toBeLessThan(
      body.indexOf("startCommandParked(agent"),
    );
    expect(body.indexOf("gateManagedLaunch(cli, installed)")).toBeLessThan(
      body.indexOf("addTerminal("),
    );
  });

  it("gates a micro-task before isolation, command creation, or spawning", () => {
    const body = bodyBetween("const startMicroTask", "const startPrQuickTask");
    const gate = body.indexOf("gateManagedLaunch(cli, installed)");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(body.indexOf("switchTo(repo"));
    expect(gate).toBeLessThan(body.indexOf("startCommandParked(agent"));
    expect(gate).toBeLessThan(body.indexOf("ptySpawnDetached"));
  });

  it("does not add a polling loop to the Settings fleet readout", () => {
    const from = settings.indexOf("function AgentFleetReadout");
    const to = settings.indexOf("function AgentAccounts", from);
    const body = settings.slice(from, to);
    expect(body).not.toContain("setInterval");
    expect(body).toContain("PROFILE_CHANGE_EVENT");
    expect(body).toContain("CLI_INSTALLS_CHANGED_EVENT");
    expect(body).toContain("onIntegrationHealth");
  });
});

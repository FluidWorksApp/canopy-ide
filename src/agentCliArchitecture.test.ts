import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_CLI_ID } from "../shared/agentCliIdentity";
import { MODEL_SWITCH } from "./agentModels";
import {
  AGENT_CLIS,
  agentCliFor,
  canonicalAgentCliId,
  routingAgentClis,
  startCommand,
  streamsStructured,
  structuredRunnerFor,
} from "./projects";
import { STRUCTURED_RUNNERS } from "./structuredRunners";

const root = resolve(import.meta.dirname, "..");
const sources = (dir: string, pattern = /\.(?:ts|tsx)$/): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (["node_modules", "dist", "target"].includes(name)) return [];
  return statSync(path).isDirectory() ? sources(path, pattern) : pattern.test(name) ? [path] : [];
});
const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

describe("first-class agent CLI architecture", () => {
  it("keeps vendor ids inside manifests and protocol adapters", () => {
    const allowed = new Set([
      "shared/agentCliIdentity.ts",
      "shared/notifications.ts",
      "src/agentModels.ts",
      "src/modelCatalog.ts",
      "src/projects.ts",
      "src/projectRunner.ts",
      "src/structuredEvents.ts",
      "src/structuredRunners.ts",
    ]);
    const vendorLiteral = /(["'])(?:claude|codex|amp|aider|agy|opencode|omp)\1/g;
    const violations = [resolve(root, "src"), resolve(root, "shared"), resolve(root, "portal/src")]
      .flatMap((dir) => sources(dir))
      .flatMap((path) => {
      const name = relative(root, path).replaceAll("\\", "/");
      if (
        allowed.has(name) ||
        name.includes("/selftest/") ||
        name.endsWith(".test.ts") ||
        name.endsWith(".test.tsx")
      ) return [];
      const found = [...stripComments(readFileSync(path, "utf8")).matchAll(vendorLiteral)];
      return found.map((match) => `${name}:${match[0]}`);
      });
    expect(violations).toEqual([]);
  });

  it("keeps native vendor branches inside native manifests and protocol adapters", () => {
    const allowed = new Set([
      "src-tauri/src/agent_cli.rs",
      "src-tauri/src/agentid.rs",
      "src-tauri/src/agents.rs",
      "src-tauri/src/bin/canopy_hook.rs",
      "src-tauri/src/instructions.rs",
      "src-tauri/src/mcp.rs",
      "src-tauri/src/profiles.rs",
      "src-tauri/src/stores.rs",
    ]);
    const vendorBranch = /(?:[=!]=\s*"(?:claude|codex|amp|aider|agy|opencode|omp)"|"(?:claude|codex|amp|aider|agy|opencode|omp)"\s*=>|Some\("(?:claude|codex|amp|aider|agy|opencode|omp)"[^)]*\))/g;
    const violations = sources(resolve(root, "src-tauri/src"), /\.rs$/)
      .flatMap((path) => {
        const name = relative(root, path).replaceAll("\\", "/");
        if (allowed.has(name)) return [];
        const production = readFileSync(path, "utf8").split("#[cfg(test)]", 1)[0];
        return [...stripComments(production).matchAll(vendorBranch)].map(
          (match) => `${name}:${match[0]}`,
        );
      });
    expect(violations).toEqual([]);
  });

  it("resolves historical ids without coupling identity to display name", () => {
    const cli = agentCliFor(DEFAULT_AGENT_CLI_ID)!;
    const name = cli.name;
    const aliases = cli.aliases;
    cli.name = "Renamed Product";
    cli.aliases = ["historical-agent-id"];
    try {
      expect(agentCliFor(DEFAULT_AGENT_CLI_ID)).toBe(cli);
      expect(canonicalAgentCliId("historical-agent-id")).toBe(DEFAULT_AGENT_CLI_ID);
      expect(startCommand("historical-agent-id", "hello")?.command).toContain(cli.bin);
    } finally {
      cli.name = name;
      cli.aliases = aliases;
    }
  });

  it("owns routing and protocol adapters on the CLI model", () => {
    for (const cli of routingAgentClis()) {
      expect(streamsStructured(cli.id), cli.id).toBe(true);
      expect(structuredRunnerFor(cli.id)).toBe(cli.structuredRunner);
    }
    for (const [id, runner] of Object.entries(STRUCTURED_RUNNERS)) {
      expect(agentCliFor(id)?.structuredRunner, id).toBe(runner);
    }
    for (const [id, modelSwitch] of Object.entries(MODEL_SWITCH)) {
      const cli = agentCliFor(id);
      if (cli) expect(cli.modelSwitch, id).toBe(modelSwitch);
    }
    expect(new Set(AGENT_CLIS.map((cli) => cli.id)).size).toBe(AGENT_CLIS.length);
  });
});

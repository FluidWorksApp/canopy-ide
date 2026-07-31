import { describe, expect, it } from "vitest";
import {
  MODEL_SWITCH,
  modelCommandLine,
  modelSwitchFor,
} from "./agentModels";
import { BUILTIN_AGENT_CLIS } from "./projects";

describe("modelSwitchFor", () => {
  it("has nothing to offer for an unidentified terminal", () => {
    expect(modelSwitchFor(null)).toBeNull();
    expect(modelSwitchFor(undefined)).toBeNull();
    expect(modelSwitchFor("")).toBeNull();
  });

  it("stays silent for CLIs whose command could not be verified", () => {
    // Both have a "/model"-ish string in their binary that turned out to be
    // something else — an error message, an HTTP route. Whichever way that is
    // resolved later, it must not be by guessing here.
    expect(modelSwitchFor("amp")).toBeNull();
    expect(modelSwitchFor("omp")).toBeNull();
  });

  it("names only agents the rest of the app can identify", () => {
    const known = new Set([
      ...BUILTIN_AGENT_CLIS.map((c) => c.id),
      // Bare binaries with no registry entry, per EXTRA_AGENT_BINS.
      "gemini",
    ]);
    for (const id of Object.keys(MODEL_SWITCH)) expect(known).toContain(id);
  });
});

describe("modelCommandLine", () => {
  it("appends the chosen model for an inline switch", () => {
    const claude = modelSwitchFor("claude")!;
    expect(claude.kind).toBe("inline");
    expect(modelCommandLine(claude, "fable")).toBe("/model fable");
  });

  it("passes a picker's command through untouched", () => {
    // The argument is what a picker CLI has no syntax for — Codex's /model
    // takes none, and a stray word after it would be typed into the composer.
    const codex = modelSwitchFor("codex")!;
    expect(modelCommandLine(codex, "gpt-5")).toBe("/model");
    expect(modelCommandLine(modelSwitchFor("gemini")!)).toBe("/model manage");
  });

  it("falls back to the bare command when an inline switch names no model", () => {
    expect(modelCommandLine(modelSwitchFor("aider")!)).toBe("/model");
  });

  it("never builds a line with a trailing space or a doubled slash", () => {
    for (const sw of Object.values(MODEL_SWITCH)) {
      const model = sw.kind === "inline" ? sw.choices[0].id : undefined;
      const line = modelCommandLine(sw, model);
      expect(line).toBe(line.trim());
      expect(line.startsWith("/")).toBe(true);
      expect(line).not.toMatch(/\/\//);
    }
  });
});

describe("inline choices", () => {
  it("gives every choice a unique id, a label and a hint", () => {
    for (const [agent, sw] of Object.entries(MODEL_SWITCH)) {
      if (sw.kind !== "inline") continue;
      const ids = sw.choices.map((c) => c.id);
      expect(new Set(ids).size, agent).toBe(ids.length);
      for (const c of sw.choices) {
        expect(c.label.length, `${agent} ${c.id}`).toBeGreaterThan(0);
        expect(c.hint.length, `${agent} ${c.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("keeps Claude's aliases rather than pinned model ids", () => {
    const claude = modelSwitchFor("claude")!;
    if (claude.kind !== "inline") throw new Error("claude switch went picker");
    // A dated id (claude-opus-4-5-20251101) goes stale on the next release;
    // the alias is what Claude Code repoints for us.
    for (const c of claude.choices) expect(c.id).not.toMatch(/\d{6,}/);
  });
});

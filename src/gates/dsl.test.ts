import { describe, expect, it } from "vitest";
import {
  GATE_TYPES,
  compilePrompt,
  normalizeGate,
  plainLanguage,
  portableRegex,
  suggestPrompt,
  validateCompiled,
  validateSuggestions,
} from "./dsl";

describe("normalizeGate", () => {
  it("rejects unknown types and non-objects", () => {
    expect(normalizeGate({ type: "run-anything", command: "rm -rf /" })).toBeNull();
    expect(normalizeGate({ type: "deny-path-writes", globs: ["x"] })).toBeNull();
    expect(normalizeGate(null)).toBeNull();
    expect(normalizeGate("deny-command")).toBeNull();
    expect(normalizeGate({ globs: ["migrations/"] })).toBeNull();
  });

  it("keeps each known shape, cleaned", () => {
    expect(normalizeGate({ type: "deny-path-write", globs: [" migrations/ ", "migrations/", 3] })).toEqual({
      type: "deny-path-write",
      globs: ["migrations/"],
    });
    expect(normalizeGate({ type: "protect-tests" })).toEqual({ type: "protect-tests", globs: [] });
    expect(normalizeGate({ type: "package-denylist", names: ["moment", "rm -rf"] })).toEqual({
      type: "package-denylist",
      names: ["moment"],
    });
    expect(normalizeGate({ type: "egress-allowlist", hosts: ["https://api.github.com/x", "*.example.com", "not a host"] })).toEqual({
      type: "egress-allowlist",
      hosts: ["api.github.com", "*.example.com"],
    });
    expect(normalizeGate({ type: "require-confirm", match: "publish" })).toEqual({ type: "require-confirm", match: "publish" });
    expect(normalizeGate({ type: "unenforceable" })?.type).toBe("unenforceable");
  });

  it("refuses gates that would protect everything or nothing", () => {
    expect(normalizeGate({ type: "deny-path-write", globs: ["**"] })).toBeNull();
    expect(normalizeGate({ type: "deny-path-write", globs: ["*", "/", "../etc"] })).toBeNull();
    expect(normalizeGate({ type: "deny-command", patterns: [] })).toBeNull();
    expect(normalizeGate({ type: "require-confirm", match: "teleport" })).toBeNull();
  });

  it("only accepts regexes Rust's linear-time engine can compile too", () => {
    expect(portableRegex("^npm\\s+publish\\b")).toBe(true);
    expect(portableRegex("(?=x)y")).toBe(false);
    expect(portableRegex("(?<!a)b")).toBe(false);
    expect(portableRegex("(a)\\1")).toBe(false);
    expect(portableRegex("(")).toBe(false);
    expect(normalizeGate({ type: "deny-command", patterns: ["(?!safe)deploy", "^git\\s+push\\b.*--force"] })).toEqual({
      type: "deny-command",
      patterns: ["^git\\s+push\\b.*--force"],
    });
  });
});

describe("plainLanguage", () => {
  it("says what will be stopped, for every type", () => {
    expect(plainLanguage({ type: "deny-path-write", globs: ["migrations/"] })).toBe(
      "Agents can't create, change or delete files matching migrations/.",
    );
    expect(plainLanguage({ type: "unenforceable", reason: "naming needs judgment" })).toMatch(/^Suggestion only/);
    expect(plainLanguage({ type: "require-confirm", match: "publish" })).toMatch(/approve publishing/);
    for (const type of GATE_TYPES) {
      const sample = normalizeGate({ type, globs: ["a/"], patterns: ["^x"], names: ["x"], hosts: ["x.io"], match: "push", reason: "r" });
      expect(sample, type).not.toBeNull();
      expect(plainLanguage(sample!).length).toBeGreaterThan(10);
    }
  });
});

describe("the compile contract", () => {
  it("puts the rule and the closed DSL in the prompt", () => {
    const p = compilePrompt("Never touch migrations/", { files: ["db/migrations", "src"] });
    expect(p).toContain('"""Never touch migrations/"""');
    for (const type of GATE_TYPES) expect(p).toContain(`"type":"${type}"`);
    expect(p).toContain("db/migrations");
    expect(p).toMatch(/without lookahead/i);
  });

  it("accepts a valid reply and rejects an unknown gate", () => {
    expect(validateCompiled({ gate: { type: "deny-path-write", globs: ["migrations"] }, explanation: "No migration edits." })).toEqual({
      gate: { type: "deny-path-write", globs: ["migrations"] },
      explanation: "No migration edits.",
    });
    expect(validateCompiled({ gate: { type: "shell", run: "x" } })).toBeNull();
    expect(validateCompiled({ explanation: "x" })).toBeNull();
    // A missing explanation falls back to our own wording.
    expect(validateCompiled({ gate: { type: "protect-tests", globs: [] } })?.explanation).toMatch(/test files/);
  });

  it("keeps only suggestions quoting a real line of the file", () => {
    const file = "# Rules\n- Never edit files in migrations/\n- Write clear names\n";
    expect(suggestPrompt("CLAUDE.md", file)).toContain("Never edit files in migrations/");
    const out = validateSuggestions(
      {
        suggestions: [
          { line: "- Never edit files in migrations/", rule: "Never touch migrations/", why: "w", gate: { type: "deny-path-write", globs: ["migrations/"] } },
          { line: "- Not in the file", rule: "x", gate: { type: "deny-command", patterns: ["^x"] } },
          { line: "- Write clear names", rule: "Clear names", gate: { type: "unenforceable", reason: "judgment" } },
          { line: "- Write clear names", rule: "y", gate: { type: "bogus" } },
        ],
      },
      file,
    );
    expect(out).toHaveLength(1);
    expect(out![0].rule).toBe("Never touch migrations/");
    expect(validateSuggestions({ nope: 1 }, file)).toBeNull();
  });
});

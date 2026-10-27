import { describe, expect, it } from "vitest";
import { ruleCoverage } from "./coverage";

describe("rule coverage per agent CLI", () => {
  it("lists every hooked CLI as enforced and Aider as guidance only", () => {
    const rows = ruleCoverage();
    const by = new Map(rows.map((r) => [r.id, r]));
    for (const id of ["claude", "codex", "cursor", "grok", "agy", "opencode", "omp", "amp"]) {
      expect(by.get(id)?.enforced, id).toBe(true);
      expect(by.get(id)?.how, id).toBeTruthy();
    }
    expect(by.get("aider")?.enforced).toBe(false);
    expect(by.get("aider")?.how).toMatch(/asks you before running each shell command/);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const askBrain = vi.hoisted(() => vi.fn());
vi.mock("../brainCall", () => ({ askBrain: (req: unknown) => askBrain(req) }));

import { compileRule, removeLines, suggestRules } from "./compile";

// A block body: a returned function would be taken for a teardown hook.
beforeEach(() => {
  askBrain.mockReset();
});

describe("compileRule", () => {
  it("asks the brain on the main tier under the gates feature, as JSON", async () => {
    askBrain.mockImplementation(async (req: { validate: (v: unknown) => unknown }) => ({
      ok: true,
      text: "{}",
      value: req.validate({ gate: { type: "deny-path-write", globs: ["migrations/"] }, explanation: "No edits to migrations." }),
      costUsd: 0.01,
    }));
    const r = await compileRule("Never touch migrations/", "/repo", { files: ["migrations"] });
    expect(r).toEqual({ ok: true, value: { gate: { type: "deny-path-write", globs: ["migrations/"] }, explanation: "No edits to migrations." } });
    const req = askBrain.mock.calls[0][0];
    expect(req).toMatchObject({ feature: "gates", tier: "main", json: true, cwd: "/repo" });
    expect(req.prompt).toContain("Never touch migrations/");
    // The validator is the DSL's: an unknown type is not a gate.
    expect(req.validate({ gate: { type: "exec" } })).toBeNull();
  });

  it("explains a failure in one line and never throws", async () => {
    askBrain.mockResolvedValue({ ok: false, reason: "no-brain", message: "" });
    expect(await compileRule("x", "/repo")).toEqual({ ok: false, message: expect.stringMatching(/No brain connected/) });
    askBrain.mockResolvedValue({ ok: false, reason: "invalid-output", message: "{...}" });
    expect(await compileRule("x", "/repo")).toEqual({ ok: false, message: expect.stringMatching(/isn't a gate|wasn't a gate/) });
  });

  it("retries from home when the project path only exists in a cloud workspace", async () => {
    askBrain
      .mockResolvedValueOnce({ ok: false, reason: "failed", message: "brain call cwd does not exist" })
      .mockResolvedValueOnce({ ok: true, text: "", value: { gate: { type: "protect-tests", globs: [] }, explanation: "e" } });
    const r = await compileRule("Don't edit tests", "/workspace/app");
    expect(r.ok).toBe(true);
    expect(askBrain.mock.calls.map((c) => c[0].cwd)).toEqual(["/workspace/app", ""]);
  });
});

describe("suggestRules", () => {
  it("validates suggestions against the file it sent", async () => {
    askBrain.mockImplementation(async (req: { validate: (v: unknown) => unknown }) => ({
      ok: true,
      text: "",
      value: req.validate({
        suggestions: [{ line: "- never run npm publish", rule: "No publishing", gate: { type: "deny-command", patterns: ["^npm\\s+publish"] } }],
      }),
    }));
    const r = await suggestRules("AGENTS.md", "# A\n- never run npm publish\n", "/repo");
    expect(r.ok && r.value.map((s) => s.rule)).toEqual(["No publishing"]);
    expect(askBrain.mock.calls[0][0]).toMatchObject({ feature: "gates", tier: "main" });
  });

  it("removes exactly the accepted lines", () => {
    expect(removeLines("a\n- never run npm publish\nb\n", ["- never run npm publish"])).toBe("a\nb\n");
    expect(removeLines("a\nb", ["c"])).toBe("a\nb");
  });
});

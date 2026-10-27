import { beforeEach, describe, expect, it, vi } from "vitest";
import { compactCommand, compactHeadless, compactInstructions, compactPlan } from "./contextCompaction";
import { contextUseText, contextWindowFor, noteContextWindows } from "./contextWindow";
import type { StructuredRunnerOut } from "./ipc";

const CLAUDE = "claude";

describe("what a compaction sends", () => {
  it("steers the CLI's own command to a turn", () => {
    expect(compactCommand(CLAUDE, { kind: "all" })).toBe("/compact");
    expect(compactCommand(CLAUDE, { kind: "all", note: "keep the API design" })).toBe("/compact keep the API design");
    const from = compactCommand(CLAUDE, { kind: "from", turn: { n: 3, prompt: "Add a login\npage" } })!;
    expect(from).toMatch(/^\/compact Keep everything before turn 3 \("Add a login page"\)/);
    expect(from).not.toContain("\n");
    expect(compactInstructions({ kind: "upto", turn: { n: 2 }, note: "the schema" })).toMatch(
      /^Condense everything up to and including turn 2 .* Also: the schema$/,
    );
  });

  it("offers nothing on a CLI whose compaction nobody has verified", () => {
    expect(compactCommand("codex", { kind: "all" })).toBeNull();
    expect(compactPlan({ agent: "codex", live: true, lifeState: "idle" }).route).toBe("unavailable");
  });
});

describe("when and how it is delivered", () => {
  it("types only at an idle prompt; mid-turn it waits; a question is left alone", () => {
    expect(compactPlan({ agent: CLAUDE, live: true, lifeState: "idle" }).route).toBe("terminal");
    expect(compactPlan({ agent: CLAUDE, live: true, lifeState: "working" }).route).toBe("wait");
    expect(compactPlan({ agent: CLAUDE, live: true, lifeState: "starting" }).route).toBe("wait");
    expect(compactPlan({ agent: CLAUDE, live: true, lifeState: "waiting" }).route).toBe("unavailable");
  });

  it("resumes a session with no terminal headlessly, on this computer or in its cloud workspace", () => {
    expect(compactPlan({ agent: CLAUDE, live: false }).route).toBe("runner");
    expect(compactPlan({ agent: CLAUDE, live: true, lifeState: "ended" }).route).toBe("runner");
    expect(compactPlan({ agent: CLAUDE, live: false, remote: true }).route).toBe("runner");
  });
});

describe("compactHeadless", () => {
  beforeEach(() => localStorage.clear());

  it("runs the verified resume argv and reports the CLI's before/after", async () => {
    const spawn = vi.fn(async (_id: string, opts: { args: string[]; command: string }, on: (o: StructuredRunnerOut) => void) => {
      expect(opts.args.slice(0, 2)).toEqual(["-p", "--output-format"]);
      expect(opts.args).toContain("--resume");
      expect(opts.args[opts.args.indexOf("--resume") + 1]).toBe("sess-1");
      expect(opts.args.at(-1)).toBe("/compact keep it");
      expect(opts.args.at(-2)).toBe("--");
      on({ kind: "line", text: JSON.stringify({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 23221, post_tokens: 7305 } }) });
      on({ kind: "line", text: JSON.stringify({ type: "result", subtype: "success", result: "", modelUsage: { "model-x": { contextWindow: 1_000_000 } } }) });
    });
    const kill = vi.fn(async () => {});
    const r = await compactHeadless({ agent: CLAUDE, sessionId: "sess-1", cwd: "/repo", command: "/compact keep it" }, { spawn, kill } as never);
    expect(r).toEqual({ ok: true, preTokens: 23221, postTokens: 7305 });
    expect(kill).toHaveBeenCalled();
    // The CLI's own window report is remembered for the context meter.
    expect(contextWindowFor("model-x")).toBe(1_000_000);
  });

  it("in a cloud workspace compacts inside the workspace, sending only the instructions", async () => {
    const spawn = vi.fn();
    const remote = vi.fn(async () => ({ ok: true, preTokens: 90_000, postTokens: 9_000, contextWindows: { "model-y": 200_000 } }));
    const r = await compactHeadless(
      { agent: CLAUDE, sessionId: "s9", cwd: "/workspace/app", command: "/compact keep it", instructions: "keep it", profile: "work" },
      { spawn, kill: async () => {}, remote } as never,
    );
    expect(r).toEqual({ ok: true, preTokens: 90_000, postTokens: 9_000 });
    expect(spawn).not.toHaveBeenCalled();
    expect(remote).toHaveBeenCalledWith({ agent: CLAUDE, sessionId: "s9", cwd: "/workspace/app", instructions: "keep it", profile: "work" });
    expect(contextWindowFor("model-y")).toBe(200_000);
    const failed = await compactHeadless(
      { agent: CLAUDE, sessionId: "s9", cwd: "/w", command: "/compact" },
      { spawn, kill: async () => {}, remote: async () => ({ ok: false, message: "The session's folder is not in this workspace." }) } as never,
    );
    expect(failed).toEqual({ ok: false, message: "The session's folder is not in this workspace." });
  });

  it("says so when the CLI ends without compacting", async () => {
    const spawn = vi.fn(async (_id: string, _o: unknown, on: (o: StructuredRunnerOut) => void) => {
      on({ kind: "line", text: JSON.stringify({ type: "result", subtype: "success", result: "hi" }) });
    });
    const r = await compactHeadless({ agent: CLAUDE, sessionId: "s", cwd: "/r", command: "/compact" }, { spawn, kill: async () => {} } as never);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/without compacting/);
  });
});

describe("the context meter's words", () => {
  beforeEach(() => localStorage.clear());
  it("shows the window only when the CLI reported it", () => {
    expect(contextUseText(44_846, null)).toBe("44.8k");
    noteContextWindows({ m: 200_000 });
    expect(contextUseText(44_846, contextWindowFor("m"))).toBe("44.8k of 200k · 22%");
    expect(contextUseText(250_000, 1_000_000)).toBe("250k of 1M · 25%");
    expect(contextWindowFor("unknown")).toBeNull();
  });
});

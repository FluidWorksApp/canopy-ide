import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({
  whichCheck: vi.fn(async () => ({})),
  brainCallSpawn: vi.fn(),
  brainKill: vi.fn(async () => {}),
  profileEnv: vi.fn(async () => [["CODEX_HOME", "/profiles/work/codex"]]),
}));

import * as ipc from "./ipc";
import {
  BRAIN_BACKGROUND_CONCURRENCY,
  askBrain,
  classifyBrainFailure,
  extractJsonObject,
  resetBrainCallForTests,
  setBrainInstalledPredicate,
} from "./brainCall";
import { brainSpend, recordBrainCall, resetBrainMeterForTests } from "./brainMeter";
import { brainConnection, resetBrainConnectionForTests } from "./brainStatus";
import { agentCliFor } from "./projects";
import { updateSettings } from "./settings";
import { mockCommands } from "./test/setup";
import { CLAUDE_RUNNER, CODEX_RUNNER, brainArgs } from "./structuredRunners";

type Out = ipc.StructuredRunnerOut;
const spawnMock = ipc.brainCallSpawn as unknown as ReturnType<typeof vi.fn>;
const killMock = ipc.brainKill as unknown as ReturnType<typeof vi.fn>;

const claude = agentCliFor("claude")!;
const codex = agentCliFor("codex")!;

const result = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "OK",
    total_cost_usd: 0.0029,
    duration_ms: 2125,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 14142,
      cache_read_input_tokens: 11019,
      output_tokens: 4,
    },
    modelUsage: { "claude-haiku-5-5": {} },
    ...over,
  });

/** Make the next spawn emit these outputs (asynchronously, like a channel). */
function scripted(outputs: Out[]) {
  spawnMock.mockImplementationOnce(async (_id: string, _opts: unknown, onData: (o: Out) => void) => {
    queueMicrotask(() => outputs.forEach((o) => onData(o)));
  });
}
const line = (text: string): Out => ({ kind: "line", text });

beforeEach(() => {
  localStorage.clear();
  resetBrainCallForTests();
  resetBrainMeterForTests();
  resetBrainConnectionForTests();
  vi.clearAllMocks();
  updateSettings({ defaultAgent: "claude" });
  setBrainInstalledPredicate((bin) => bin === claude.bin);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("askBrain", () => {
  it("asks again from home when the project path is a cloud workspace's, absent here", async () => {
    spawnMock.mockImplementationOnce(async () => {
      throw new Error("brain call cwd does not exist: /workspace/app");
    });
    scripted([line(result()), { kind: "exit", code: 0 }]);
    const answer = await askBrain({ feature: "plan", prompt: "hi", cwd: "/workspace/app" });
    expect(answer.ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1][1]).toMatchObject({ cwd: "" });
    // The call that never started is not metered.
    expect(brainSpend().calls).toBe(1);
  });

  it("runs the brain one-shot and read-only, and reads the result line", async () => {
    scripted([
      line(JSON.stringify({ type: "system", subtype: "init", model: "claude-haiku-5-5" })),
      line(result()),
      { kind: "exit", code: 0 },
    ]);
    const answer = await askBrain({ feature: "receipt", prompt: "hi", cwd: "/repo", tier: "background" });
    expect(answer).toMatchObject({
      ok: true,
      text: "OK",
      costUsd: 0.0029,
      inputTokens: 2 + 14142 + 11019,
      outputTokens: 4,
      durationMs: 2125,
      model: "claude-haiku-5-5",
    });
    const [, opts] = spawnMock.mock.calls[0] as [string, { command: string; args: string[]; cwd: string }];
    expect(opts.command).toBe(claude.bin);
    expect(opts.cwd).toBe("/repo");
    expect(opts.args).toContain("--no-session-persistence");
    expect(opts.args.join(" ")).toContain("--permission-mode plan");
    // Background tier picks the runner's cheap alias.
    expect(opts.args.join(" ")).toContain("--model haiku");
    // The prompt is the last argv value, after `--`.
    expect(opts.args.slice(-2)).toEqual(["--", "hi"]);
    // Metered and reflected in the connection state.
    expect(brainSpend({ feature: "receipt" })).toMatchObject({ calls: 1, failures: 0, outputTokens: 4 });
    expect(brainConnection().state).toBe("connected");
    // The answer arrived before exit too, so the call is reaped either way.
    expect(killMock).toHaveBeenCalled();
  });

  it("uses the brainModel setting on the main tier and no model by default", async () => {
    scripted([line(result())]);
    await askBrain({ feature: "plan", prompt: "p", cwd: "/r" });
    expect((spawnMock.mock.calls[0][1] as { args: string[] }).args).not.toContain("--model");
    updateSettings({ brainModel: "opus", brainBackgroundModel: "sonnet" });
    scripted([line(result())]);
    await askBrain({ feature: "plan", prompt: "p", cwd: "/r" });
    expect((spawnMock.mock.calls[1][1] as { args: string[] }).args.join(" ")).toContain("--model opus");
    scripted([line(result())]);
    await askBrain({ feature: "plan", prompt: "p", cwd: "/r", tier: "background" });
    expect((spawnMock.mock.calls[2][1] as { args: string[] }).args.join(" ")).toContain("--model sonnet");
  });

  it("parses JSON answers, fences and all, and validates them", async () => {
    scripted([line(result({ result: 'Sure:\n```json\n{"verdict":"pass","n":2}\n```' }))]);
    const ok = await askBrain<{ verdict: string }>({
      feature: "review",
      prompt: "judge",
      cwd: "/r",
      json: true,
      validate: (v) => (v && typeof (v as { verdict?: unknown }).verdict === "string" ? (v as { verdict: string }) : null),
    });
    expect(ok.ok && ok.value).toEqual({ verdict: "pass", n: 2 });
    const prompt = (spawnMock.mock.calls[0][1] as { args: string[] }).args.at(-1)!;
    expect(prompt).toMatch(/^judge\n\nReply with exactly one JSON object/);

    scripted([line(result({ result: "I cannot answer that." }))]);
    const bad = await askBrain({ feature: "review", prompt: "judge", cwd: "/r", json: true });
    expect(bad).toEqual({ ok: false, reason: "invalid-output", message: "I cannot answer that." });

    scripted([line(result({ result: '{"verdict":1}' }))]);
    const rejected = await askBrain({ feature: "review", prompt: "j", cwd: "/r", json: true, validate: () => null });
    expect(rejected).toMatchObject({ ok: false, reason: "invalid-output" });
  });

  it("maps rate limits and sign-outs from the stream and stderr", async () => {
    scripted([line(result({ is_error: true, result: "Claude AI usage limit reached|1793094000" }))]);
    expect(await askBrain({ feature: "memory", prompt: "x", cwd: "/r" })).toMatchObject({ ok: false, reason: "rate-limited" });
    expect(brainConnection().state).toBe("rate-limited");

    scripted([
      line(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected" } })),
      line(result({ is_error: true, result: "Request refused" })),
    ]);
    expect(await askBrain({ feature: "memory", prompt: "x", cwd: "/r" })).toMatchObject({ reason: "rate-limited" });

    scripted([{ kind: "stderr", text: "Invalid API key · Please run /login" }, { kind: "exit", code: 1 }]);
    expect(await askBrain({ feature: "memory", prompt: "x", cwd: "/r" })).toMatchObject({ ok: false, reason: "signed-out" });
    expect(brainConnection().state).toBe("signed-out");

    scripted([{ kind: "stderr", text: "segfault" }, { kind: "exit", code: 139 }]);
    expect(await askBrain({ feature: "memory", prompt: "x", cwd: "/r" })).toMatchObject({ ok: false, reason: "failed", message: "segfault" });

    // A later success flips the state back.
    scripted([line(result())]);
    await askBrain({ feature: "memory", prompt: "x", cwd: "/r" });
    expect(brainConnection().state).toBe("connected");
    // Every one of those reached the CLI, so every one is metered.
    expect(brainSpend({ feature: "memory" })).toMatchObject({ calls: 5, failures: 4 });
  });

  it("refuses before spawning when the feature is over budget", async () => {
    updateSettings({ brainFeatureBudgetsUsd: { awareness: 0.01 } });
    recordBrainCall({ feature: "awareness", ts: Date.now(), costUsd: 0.02, inputTokens: 1, outputTokens: 1, ok: true });
    const answer = await askBrain({ feature: "awareness", prompt: "x", cwd: "/r" });
    expect(answer).toMatchObject({ ok: false, reason: "over-budget" });
    expect(spawnMock).not.toHaveBeenCalled();
    // Other features are unaffected by that feature's cap.
    scripted([line(result())]);
    expect((await askBrain({ feature: "receipt", prompt: "x", cwd: "/r" })).ok).toBe(true);
    // The daily total caps everyone — except the connection probe.
    updateSettings({ brainDailyBudgetUsd: 0.01 });
    expect(await askBrain({ feature: "receipt", prompt: "x", cwd: "/r" })).toMatchObject({ reason: "over-budget" });
    scripted([line(result())]);
    expect((await askBrain({ feature: "connect-probe", prompt: "x", cwd: "" })).ok).toBe(true);
  });

  it("runs on the active account, like the person's own sessions", async () => {
    updateSettings({ defaultAgent: "codex", activeProfile: "work" });
    setBrainInstalledPredicate((bin) => bin === codex.bin);
    spawnMock.mockImplementationOnce(async (_id: string, _opts: unknown, onData: (o: Out) => void) => {
      queueMicrotask(() => onData({ kind: "exit", code: 0 }));
    });
    await askBrain({ feature: "lens", prompt: "x", cwd: "" });
    expect(ipc.profileEnv).toHaveBeenCalledWith("codex", "work");
    expect(spawnMock.mock.calls[0][1]).toMatchObject({ env: [["CODEX_HOME", "/profiles/work/codex"]] });
  });

  it("never runs another vendor when the chosen brain isn't installed", async () => {
    updateSettings({ defaultAgent: "claude" });
    setBrainInstalledPredicate((bin) => bin === codex.bin);
    const answer = await askBrain({ feature: "lens", prompt: "x", cwd: "" });
    expect(answer).toMatchObject({ ok: false, reason: "no-brain" });
    expect(answer.ok ? "" : answer.message).toContain(`${claude.name} is your brain`);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("answers no-brain when nothing usable is installed", async () => {
    setBrainInstalledPredicate(() => false);
    expect(await askBrain({ feature: "lens", prompt: "x", cwd: "/r" })).toMatchObject({ ok: false, reason: "no-brain" });
    expect(brainConnection().state).toBe("missing");
    // An installed CLI without a verified runner cannot be the brain either.
    const runnerless = (agentCliFor("aider") ?? agentCliFor("amp"))!;
    updateSettings({ defaultAgent: runnerless.id });
    setBrainInstalledPredicate((bin) => bin === runnerless.bin);
    expect(await askBrain({ feature: "lens", prompt: "x", cwd: "/r" })).toMatchObject({ reason: "no-brain" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("detects the desktop's installed CLIs through which_check when no host predicate is set", async () => {
    setBrainInstalledPredicate(null);
    const which = vi.fn(() => ({ [claude.bin]: true }));
    mockCommands({ which_check: which });
    scripted([line(result())]);
    expect((await askBrain({ feature: "receipt", prompt: "x", cwd: "/r" })).ok).toBe(true);
    // Cached: a second call does not look again.
    scripted([line(result())]);
    await askBrain({ feature: "receipt", prompt: "x", cwd: "/r" });
    expect(which).toHaveBeenCalledTimes(1);
  });

  it("times out, kills the call and reports timeout", async () => {
    spawnMock.mockImplementationOnce(async () => {});
    const answer = await askBrain({ feature: "gates", prompt: "x", cwd: "/r", timeoutMs: 20 });
    expect(answer).toMatchObject({ ok: false, reason: "timeout" });
    expect(killMock).toHaveBeenCalledTimes(1);
  });

  it("stops on abort", async () => {
    spawnMock.mockImplementationOnce(async () => {});
    const ctl = new AbortController();
    const pending = askBrain({ feature: "gates", prompt: "x", cwd: "/r", signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 5));
    ctl.abort();
    expect(await pending).toMatchObject({ ok: false, reason: "failed" });
    expect(killMock).toHaveBeenCalled();
  });

  it("caps concurrent background calls and queues the rest", async () => {
    const finishers: Array<() => void> = [];
    spawnMock.mockImplementation(async (_id: string, _o: unknown, onData: (o: Out) => void) => {
      finishers.push(() => onData(line(result())));
    });
    const calls = Array.from({ length: BRAIN_BACKGROUND_CONCURRENCY + 2 }, () =>
      askBrain({ feature: "awareness", prompt: "x", cwd: "/r", tier: "background" }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(spawnMock).toHaveBeenCalledTimes(BRAIN_BACKGROUND_CONCURRENCY);
    finishers.shift()!();
    await new Promise((r) => setTimeout(r, 5));
    expect(spawnMock).toHaveBeenCalledTimes(BRAIN_BACKGROUND_CONCURRENCY + 1);
    // Main-tier calls are never queued behind background work.
    const main = askBrain({ feature: "plan", prompt: "x", cwd: "/r" });
    await new Promise((r) => setTimeout(r, 5));
    expect(spawnMock).toHaveBeenCalledTimes(BRAIN_BACKGROUND_CONCURRENCY + 2);
    while (finishers.length || spawnMock.mock.calls.length < BRAIN_BACKGROUND_CONCURRENCY + 3) {
      finishers.shift()?.();
      await new Promise((r) => setTimeout(r, 5));
    }
    const answers = await Promise.all([...calls, main]);
    expect(answers.every((a) => a.ok)).toBe(true);
    spawnMock.mockReset();
  });
});

describe("pure helpers", () => {
  it("extracts the first balanced JSON object", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('Here you go: {"a":"}{","b":{"c":[1]}} — done')).toEqual({ a: "}{", b: { c: [1] } });
    expect(extractJsonObject("```json\n{\"x\":true}\n```")).toEqual({ x: true });
    expect(extractJsonObject("{not json} then {\"ok\":1}")).toEqual({ ok: 1 });
    expect(extractJsonObject("[1,2]")).toBeUndefined();
    expect(extractJsonObject("no braces")).toBeUndefined();
  });

  it("classifies account failures by wording", () => {
    expect(classifyBrainFailure("Claude AI usage limit reached")).toBe("rate-limited");
    expect(classifyBrainFailure("429 Too Many Requests")).toBe("rate-limited");
    expect(classifyBrainFailure("Not logged in · Please run /login")).toBe("signed-out");
    expect(classifyBrainFailure("Invalid API key")).toBe("signed-out");
    expect(classifyBrainFailure("OAuth token has expired")).toBe("signed-out");
    expect(classifyBrainFailure("ENOENT")).toBeNull();
  });

  it("builds brain argv from the runner manifest", () => {
    const launch = {
      bin: "x",
      policy: {
        systemPromptAppend: "brief",
        permissionMode: "plan",
        disallowedTools: ["Edit"],
        model: "",
        sessionId: "",
        authority: "read-only" as const,
      },
    };
    const structured = brainArgs(CLAUDE_RUNNER, launch, "q")!;
    expect(structured).toContain("--append-system-prompt");
    expect(structured).not.toContain("--input-format");
    expect(structured.slice(-2)).toEqual(["--", "q"]);
    // A oneshot runner without a system-prompt flag gets the brief inline.
    const oneshot = brainArgs(CODEX_RUNNER, launch, "q")!;
    expect(oneshot.join(" ")).toContain("-s read-only");
    expect(oneshot.at(-1)).toBe("brief\n\n---\n\nq");
    // A structured runner with no one-shot form cannot be the brain.
    expect(brainArgs({ ...CLAUDE_RUNNER, oneshotArgs: undefined }, launch, "q")).toBeNull();
    expect(codex.structuredRunner).toBe(CODEX_RUNNER);
  });
});

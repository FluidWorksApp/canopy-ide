import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({
  whichCheck: vi.fn(async () => ({})),
  brainCallSpawn: vi.fn(),
  brainWrite: vi.fn(),
  brainHome: vi.fn(async () => "/home/me"),
  brainKill: vi.fn(async () => {}),
  profilesListDesktop: vi.fn(async () => []),
  profileEnvDesktop: vi.fn(async () => []),
}));

import * as ipc from "./ipc";
import { BRAIN_BACKGROUND_CONCURRENCY, askBrain, resetBrainCallForTests, setBrainInstalledPredicate } from "./brainCall";
import { brainSpend, resetBrainMeterForTests } from "./brainMeter";
import { brainConnection, resetBrainConnectionForTests } from "./brainStatus";
import { agentCliFor } from "./projects";
import { updateSettings } from "./settings";

type Out = ipc.StructuredRunnerOut;
type Msg = Record<string, unknown>;
const spawnMock = ipc.brainCallSpawn as unknown as ReturnType<typeof vi.fn>;
const writeMock = ipc.brainWrite as unknown as ReturnType<typeof vi.fn>;
const killMock = ipc.brainKill as unknown as ReturnType<typeof vi.fn>;

const kiro = agentCliFor("kiro")!;

interface Ctx {
  /** what the client has written so far */
  written: Msg[];
  say(m: Msg): void;
  out(o: Out): void;
  update(u: Msg): void;
  /** answer the session/prompt request */
  finish(result?: Msg): void;
  fail(message: string): void;
  promptId: number;
}
interface Script {
  /** Called when session/prompt arrives. Default: answer "OK". */
  onPrompt?(ctx: Ctx): void;
  /** Called for every other client message, after the defaults. */
  onMessage?(ctx: Ctx, m: Msg): void;
  /** Called as soon as the process is "spawned". */
  onSpawn?(ctx: Ctx): void;
}

/** Install a fake ACP process for the next spawn. No real binary is run. */
function fakeAgent(script: Script = {}) {
  const written: Msg[] = [];
  let emit: (o: Out) => void = () => {};
  let id = "";
  let promptId = 0;
  const say = (m: Msg) => emit({ kind: "line", text: JSON.stringify({ jsonrpc: "2.0", ...m }) });
  const ctx: Ctx = {
    written,
    say,
    out: (o) => emit(o),
    update: (u) => say({ method: "session/update", params: { sessionId: "s1", update: u } }),
    finish: (result = { stopReason: "end_turn" }) => say({ id: promptId, result }),
    fail: (message) => say({ id: promptId, error: { code: -32000, message } }),
    get promptId() {
      return promptId;
    },
  };
  const spawned: { command: string; args: string[]; cwd: string; keepStdin?: boolean; env?: unknown }[] = [];
  spawnMock.mockImplementationOnce(async (callId: string, opts: (typeof spawned)[number], onData: (o: Out) => void) => {
    id = callId;
    emit = onData;
    spawned.push(opts);
    queueMicrotask(() => script.onSpawn?.(ctx));
  });
  writeMock.mockImplementation(async (callId: string, line: string) => {
    if (callId !== id) return;
    const m = JSON.parse(line) as Msg;
    written.push(m);
    queueMicrotask(() => {
      if (m.method === "initialize") say({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      else if (m.method === "session/new") say({ id: m.id, result: { sessionId: "s1" } });
      else if (m.method === "session/prompt") {
        promptId = m.id as number;
        if (script.onPrompt) script.onPrompt(ctx);
        else {
          ctx.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "OK" } });
          ctx.finish();
        }
      } else script.onMessage?.(ctx, m);
    });
  });
  return { ctx, written, spawned, sent: (method: string) => written.filter((m) => m.method === method) };
}

beforeEach(() => {
  localStorage.clear();
  resetBrainCallForTests();
  resetBrainMeterForTests();
  resetBrainConnectionForTests();
  vi.clearAllMocks();
  spawnMock.mockReset();
  writeMock.mockReset();
  updateSettings({ defaultAgent: "kiro" });
  setBrainInstalledPredicate((bin) => bin === kiro.bin);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("askBrain over ACP", () => {
  it("runs one read-only prompt, returns the reply and reaps the process", async () => {
    const a = fakeAgent();
    const answer = await askBrain({ feature: "receipt", prompt: "hello", cwd: "/repo" });
    expect(answer).toMatchObject({ ok: true, text: "OK", costUsd: null, inputTokens: null, outputTokens: null });

    expect(a.spawned[0]).toMatchObject({ command: kiro.bin, cwd: "/repo", keepStdin: true });
    // Never the trust-all flag: that is for workspace-write only.
    expect(a.spawned[0].args).toEqual(["acp", "--agent", "canopy"]);
    expect(a.sent("session/new")[0].params).toMatchObject({ cwd: "/repo" });
    const prompt = a.sent("session/prompt")[0].params as { prompt: { text: string }[] };
    expect(prompt.prompt[0].text).toMatch(/^You are answering one question for Canopy/);
    expect(prompt.prompt[0].text).toMatch(/hello$/);
    // Metered and reflected in the connection state, like a headless call.
    expect(brainSpend({ feature: "receipt" })).toMatchObject({ calls: 1, failures: 0 });
    expect(brainConnection().state).toBe("connected");
    // The process is reaped after the transport has cancelled and closed the session.
    await vi.waitFor(() => expect(killMock).toHaveBeenCalled());
  });

  it("runs a project-less call from the home directory ACP is told about", async () => {
    const a = fakeAgent();
    await askBrain({ feature: "connect-probe", prompt: "x", cwd: "" });
    expect(a.sent("session/new")[0].params).toMatchObject({ cwd: "/home/me" });
    expect(a.spawned[0].cwd).toBe("/home/me");
  });

  it("passes the brain model setting through the runner's model flag", async () => {
    updateSettings({ brainModel: "claude-sonnet" });
    const a = fakeAgent();
    await askBrain({ feature: "plan", prompt: "x", cwd: "/r" });
    expect(a.spawned[0].args).toEqual(["acp", "--agent", "canopy", "--model", "claude-sonnet"]);
  });

  it("refuses a permission request and still answers", async () => {
    const a = fakeAgent({
      onPrompt: (ctx) => {
        ctx.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
        ctx.say({
          id: 90,
          method: "session/request_permission",
          params: {
            sessionId: "s1",
            toolCall: { toolCallId: "t", title: "Write a.ts" },
            options: [
              { optionId: "always", kind: "allow_always" },
              { optionId: "once", kind: "allow_once" },
              { optionId: "no", kind: "reject_once" },
            ],
          },
        });
      },
      onMessage: (ctx, m) => {
        if (m.id === 90) ctx.finish();
      },
    });
    const answer = await askBrain({ feature: "plan", prompt: "edit it", cwd: "/r" });
    expect(answer).toMatchObject({ ok: true, text: "done" });
    const reply = a.written.find((m) => m.id === 90)!;
    expect(reply.result).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
  });

  it("cancels a permission request when the agent offers no refusal", async () => {
    const a = fakeAgent({
      onPrompt: (ctx) => {
        ctx.say({
          id: 91,
          method: "session/request_permission",
          params: {
            sessionId: "s1",
            toolCall: { toolCallId: "t", title: "Run rm" },
            options: [{ optionId: "yes", kind: "allow_once" }],
          },
        });
      },
      onMessage: (ctx, m) => {
        if (m.id === 91) ctx.finish();
      },
    });
    await askBrain({ feature: "plan", prompt: "x", cwd: "/r" });
    expect(a.written.find((m) => m.id === 91)!.result).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("times out, reaps the process and reports the timeout", async () => {
    vi.useFakeTimers();
    const a = fakeAgent({ onPrompt: () => {} });
    const pending = askBrain({ feature: "plan", prompt: "x", cwd: "/r", timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await pending).toMatchObject({ ok: false, reason: "timeout" });
    await vi.waitFor(() => expect(killMock).toHaveBeenCalledTimes(1));
    expect(a.sent("session/cancel").length).toBeLessThanOrEqual(1);
    expect(brainSpend({ feature: "plan" })).toMatchObject({ calls: 1, failures: 1 });
    // A timeout is not a connection verdict for a non-probe feature.
    expect(brainConnection().state).not.toBe("error");
  });

  it("reports a probe timeout as a connection error", async () => {
    vi.useFakeTimers();
    fakeAgent({ onPrompt: () => {} });
    const pending = askBrain({ feature: "connect-probe", prompt: "x", cwd: "", timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await pending).toMatchObject({ reason: "timeout" });
    expect(brainConnection().state).toBe("error");
  });

  it("stops when aborted mid-prompt", async () => {
    const abort = new AbortController();
    fakeAgent({
      onPrompt: () => {
        abort.abort();
      },
    });
    const answer = await askBrain({ feature: "plan", prompt: "x", cwd: "/r", signal: abort.signal });
    expect(answer).toEqual({ ok: false, reason: "failed", message: "Cancelled." });
    await vi.waitFor(() => expect(killMock).toHaveBeenCalledTimes(1));
  });

  it("does not spawn when already aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    fakeAgent();
    const answer = await askBrain({ feature: "plan", prompt: "x", cwd: "/r", signal: abort.signal });
    expect(answer).toMatchObject({ ok: false, message: "Cancelled." });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("fails with the agent's stderr when the process exits before answering", async () => {
    fakeAgent({
      onPrompt: (ctx) => {
        ctx.out({ kind: "stderr", text: "segfault in agent" });
        ctx.out({ kind: "exit", code: 139 });
      },
    });
    const answer = await askBrain({ feature: "plan", prompt: "x", cwd: "/r" });
    expect(answer).toMatchObject({ ok: false, reason: "failed" });
    expect((answer as { message: string }).message).toContain("segfault in agent");
    expect(brainSpend({ feature: "plan" })).toMatchObject({ failures: 1 });
  });

  it("fails when the process exits during the handshake", async () => {
    fakeAgent({
      onSpawn: (ctx) => {
        ctx.out({ kind: "stderr", text: "Please run /login" });
        ctx.out({ kind: "exit", code: 1 });
      },
    });
    const answer = await askBrain({ feature: "plan", prompt: "x", cwd: "/r" });
    expect(answer).toMatchObject({ ok: false, reason: "signed-out" });
    expect(brainConnection().state).toBe("signed-out");
  });

  it("maps an agent error on the prompt to a rate limit", async () => {
    fakeAgent({ onPrompt: (ctx) => ctx.fail("usage limit reached") });
    expect(await askBrain({ feature: "plan", prompt: "x", cwd: "/r" })).toMatchObject({
      ok: false,
      reason: "rate-limited",
    });
  });

  it("parses a JSON reply, and rejects a reply that is not JSON", async () => {
    fakeAgent({
      onPrompt: (ctx) => {
        ctx.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: 'Sure: ```json\n{"v":1}\n```' } });
        ctx.finish();
      },
    });
    const ok = await askBrain<{ v: number }>({ feature: "review", prompt: "j", cwd: "/r", json: true });
    expect(ok.ok && ok.value).toEqual({ v: 1 });

    const a = fakeAgent({
      onPrompt: (ctx) => {
        ctx.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "I cannot say." } });
        ctx.finish();
      },
    });
    const bad = await askBrain({ feature: "review", prompt: "j", cwd: "/r", json: true });
    expect(bad).toEqual({ ok: false, reason: "invalid-output", message: "I cannot say." });
    const asked = (a.sent("session/prompt")[0].params as { prompt: { text: string }[] }).prompt[0].text;
    expect(asked).toMatch(/Reply with exactly one JSON object/);
  });

  it("asks again from home when the project path does not exist here", async () => {
    spawnMock.mockImplementationOnce(async () => {
      throw new Error("brain call cwd does not exist: /workspace/app");
    });
    const a = fakeAgent();
    const answer = await askBrain({ feature: "plan", prompt: "x", cwd: "/workspace/app" });
    expect(answer.ok).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(a.sent("session/new")[0].params).toMatchObject({ cwd: "/home/me" });
    expect(brainSpend().calls).toBe(1);
  });

  it("reports a missing binary as no brain", async () => {
    spawnMock.mockImplementationOnce(async () => {
      throw new Error("could not start `kiro-cli`: No such file — Canopy could not find it on this machine's PATH");
    });
    expect(await askBrain({ feature: "plan", prompt: "x", cwd: "/r" })).toMatchObject({ ok: false, reason: "no-brain" });
  });

  it("keeps background calls to the shared concurrency cap", async () => {
    const release: (() => void)[] = [];
    const ids: string[] = [];
    spawnMock.mockReset();
    writeMock.mockReset();
    const emits = new Map<string, (o: Out) => void>();
    spawnMock.mockImplementation(async (id: string, _o: unknown, onData: (o: Out) => void) => {
      ids.push(id);
      emits.set(id, onData);
    });
    writeMock.mockImplementation(async (id: string, line: string) => {
      const m = JSON.parse(line) as Msg;
      const say = (x: Msg) => emits.get(id)!({ kind: "line", text: JSON.stringify({ jsonrpc: "2.0", ...x }) });
      queueMicrotask(() => {
        if (m.method === "initialize") say({ id: m.id, result: { protocolVersion: 1 } });
        else if (m.method === "session/new") say({ id: m.id, result: { sessionId: "s" } });
        else if (m.method === "session/prompt") release.push(() => say({ id: m.id, result: { stopReason: "end_turn" } }));
      });
    });
    const calls = Array.from({ length: BRAIN_BACKGROUND_CONCURRENCY + 1 }, () =>
      askBrain({ feature: "awareness", prompt: "x", cwd: "/r", tier: "background" }),
    );
    await vi.waitFor(() => expect(release.length).toBe(BRAIN_BACKGROUND_CONCURRENCY));
    expect(spawnMock).toHaveBeenCalledTimes(BRAIN_BACKGROUND_CONCURRENCY);
    release.shift()!();
    await vi.waitFor(() => expect(release.length).toBe(BRAIN_BACKGROUND_CONCURRENCY));
    expect(spawnMock).toHaveBeenCalledTimes(BRAIN_BACKGROUND_CONCURRENCY + 1);
    release.forEach((r) => r());
    const done = await Promise.all(calls);
    expect(done.every((d) => d.ok)).toBe(true);
  });

  it("works for a user-added ACP CLI too", async () => {
    const { refreshAgentClis } = await import("./projects");
    updateSettings({
      customClis: [{ id: "my-acp", name: "My ACP", bin: "my-acp-bin", acp: { args: ["--acp"] } }],
      defaultAgent: "my-acp",
    });
    refreshAgentClis();
    setBrainInstalledPredicate((bin) => bin === "my-acp-bin");
    const a = fakeAgent();
    expect((await askBrain({ feature: "plan", prompt: "x", cwd: "/r" })).ok).toBe(true);
    expect(a.spawned[0]).toMatchObject({ command: "my-acp-bin", args: ["--acp"] });
    updateSettings({ customClis: [] });
    refreshAgentClis();
  });
});

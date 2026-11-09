import { describe, expect, it } from "vitest";
import { startStructured, type ProjectRunnerOutput, type ProjectRunnerProcess } from "../projectRunner";
import type { StructuredRunnerEvent } from "../structuredEvents";
import type { StructuredRunnerLaunch } from "../structuredRunners";

type Msg = Record<string, unknown>;

/** A scripted ACP agent: replies to what the client writes. */
function fakeAgent(opts: { loadSession?: boolean } = {}) {
  const written: Msg[] = [];
  const spawned: { command: string; args: string[]; keepStdin?: boolean }[] = [];
  let emit: (out: ProjectRunnerOutput) => void = () => {};
  let killed = false;
  const say = (m: Msg) => emit({ kind: "line", text: JSON.stringify({ jsonrpc: "2.0", ...m }) });
  const process: ProjectRunnerProcess = {
    spawn: async (_id, o, onData) => {
      spawned.push(o);
      emit = onData;
    },
    kill: async () => {
      killed = true;
    },
    write: async (_id, line) => {
      const m = JSON.parse(line) as Msg;
      written.push(m);
      queueMicrotask(() => {
        if (m.method === "initialize") {
          say({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: opts.loadSession ?? false } } });
        } else if (m.method === "session/new") {
          say({ id: m.id, result: { sessionId: "sess-1" } });
        } else if (m.method === "session/load") {
          say({ id: m.id, result: {} });
        } else if (m.method === "session/prompt") {
          const update = (u: Msg) => say({ method: "session/update", params: { sessionId: "sess-1", update: u } });
          update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } });
          update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit", locations: [{ path: "a.ts" }] });
          say({
            id: 77,
            method: "session/request_permission",
            params: {
              sessionId: "sess-1",
              toolCall: { toolCallId: "t1", title: "Edit" },
              options: [
                { optionId: "always", kind: "allow_always" },
                { optionId: "once", kind: "allow_once" },
                { optionId: "no", kind: "reject_once" },
              ],
            },
          });
        }
        if (m.id === 77) say({ id: lastPromptId, result: { stopReason: "end_turn" } });
        if (m.method === "session/prompt") lastPromptId = m.id as number;
      });
    },
  };
  let lastPromptId = 0;
  return { process, written, spawned, say, isKilled: () => killed, emitOut: (o: ProjectRunnerOutput) => emit(o) };
}

const launch = (authority: "read-only" | "workspace-write", extra: Partial<StructuredRunnerLaunch["policy"]> = {}): StructuredRunnerLaunch => ({
  bin: "kiro-cli",
  policy: {
    systemPromptAppend: "BRIEF",
    permissionMode: "",
    disallowedTools: [],
    model: "",
    sessionId: "canopy-sess",
    cwd: "/work",
    authority,
    ...extra,
  },
});

async function run(authority: "read-only" | "workspace-write", resume = false, loadSession = false) {
  const agent = fakeAgent({ loadSession });
  const events: StructuredRunnerEvent[] = [];
  const transport = await startStructured("a1", "kiro", launch(authority), { emit: (e) => events.push(e) }, {
    resume,
    process: agent.process,
  });
  return { agent, events, transport };
}

describe("AcpTransport", () => {
  it("plays initialize, session/new, prompt, permission and stop", async () => {
    const { agent, events, transport } = await run("workspace-write");
    expect(agent.spawned[0]).toMatchObject({ command: "kiro-cli", args: ["acp", "--trust-all-tools"], keepStdin: true });
    await transport.send("do it");
    expect(events.map((e) => e.kind)).toEqual(["ready", "delta", "tool", "reply", "turnEnd"]);
    expect(events.find((e) => e.kind === "reply")).toEqual({ kind: "reply", text: "Done" });
    const init = agent.written.find((m) => m.method === "initialize") as { params: Msg };
    expect(init.params).toMatchObject({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    expect(agent.written.find((m) => m.method === "session/new")).toMatchObject({ params: { cwd: "/work", mcpServers: [] } });
    const prompt = agent.written.find((m) => m.method === "session/prompt") as { params: { prompt: { text: string }[] } };
    expect(prompt.params.prompt[0].text).toBe("BRIEF\n\n---\n\ndo it");
    const answer = agent.written.find((m) => m.id === 77 && m.result) as { result: unknown };
    expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    await transport.stop();
    expect(agent.written.some((m) => m.method === "session/cancel")).toBe(true);
    expect(agent.isKilled()).toBe(true);
  });

  it("rejects once and reports blocked under read-only", async () => {
    const { agent, events, transport } = await run("read-only");
    expect(agent.spawned[0].args).toEqual(["acp"]);
    await transport.send("x");
    const answer = agent.written.find((m) => m.id === 77 && m.result) as { result: unknown };
    expect(answer.result).toEqual({ outcome: { outcome: "selected", optionId: "no" } });
    expect(events).toContainEqual({ kind: "blocked", tool: "Edit" });
  });

  it("loads the session when resuming and the agent supports it", async () => {
    const { agent, transport } = await run("read-only", true, true);
    await transport.send("x");
    expect(agent.written.find((m) => m.method === "session/load")).toMatchObject({ params: { sessionId: "canopy-sess" } });
    expect(agent.written.some((m) => m.method === "session/new")).toBe(false);
  });

  it("starts fresh when resuming but the agent cannot load", async () => {
    const { agent, transport } = await run("read-only", true, false);
    await transport.send("x");
    expect(agent.written.some((m) => m.method === "session/load")).toBe(false);
    expect(agent.written.some((m) => m.method === "session/new")).toBe(true);
  });

  it("reports an exit before the handshake finishes", async () => {
    const agent = fakeAgent();
    const events: StructuredRunnerEvent[] = [];
    // Never answer initialize.
    const silent: ProjectRunnerProcess = { ...agent.process, write: async () => {} };
    const transport = await startStructured("a2", "kiro", launch("read-only"), { emit: (e) => events.push(e) }, { resume: false, process: silent });
    agent.emitOut({ kind: "stderr", text: "not signed in" });
    agent.emitOut({ kind: "exit", code: 1 });
    await expect(transport.send("x")).rejects.toThrow("not signed in");
    expect(events).toContainEqual({ kind: "error", message: "not signed in" });
    expect(events).toContainEqual({ kind: "exit" });
  });
});

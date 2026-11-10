import { describe, expect, it } from "vitest";
import type { StructuredRunnerEvent } from "../structuredEvents";
import { AcpEventMapper } from "./events";
import { constrainChoice, decidePermission } from "./permissions";
import type { AcpPermissionRequest } from "./protocol";

function mapper() {
  const events: StructuredRunnerEvent[] = [];
  return { events, m: new AcpEventMapper({ emit: (e) => events.push(e) }) };
}

describe("AcpEventMapper", () => {
  it("emits thoughts, plans and usage, and not the reply", () => {
    const { events, m } = mapper();
    m.beginTurn();
    m.handleUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
    m.handleUpdate({
      sessionUpdate: "plan",
      entries: [{ content: "Read", status: "pending", priority: "high" }, { content: "Edit", status: "pending" }],
    });
    m.handleUpdate({ sessionUpdate: "usage_update", used: 10, size: 200, cost: { amount: 0.5, currency: "USD" } });
    m.endTurn("end_turn");
    expect(events).toEqual([
      { kind: "thought", text: "hmm" },
      {
        kind: "plan",
        entries: [{ content: "Read", status: "pending", priority: "high" }, { content: "Edit", status: "pending" }],
      },
      { kind: "usage", used: 10, size: 200, cost: { amount: 0.5, currency: "USD" } },
      { kind: "turnEnd" },
    ]);
  });

  it("drops malformed plan and usage payloads", () => {
    const { events, m } = mapper();
    m.handleUpdate({ sessionUpdate: "plan" });
    m.handleUpdate({ sessionUpdate: "usage_update", used: "x" as unknown as number, size: 1 });
    m.handleUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "image" } });
    expect(events).toEqual([]);
  });

  it("reports a failed tool call once, under the name it was announced with", () => {
    const { events, m } = mapper();
    m.handleUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit", locations: [{ path: "a.ts" }] });
    m.handleUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
    m.handleUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" });
    m.handleUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed" });
    expect(events).toEqual([
      { kind: "tool", name: "Edit", detail: "a.ts" },
      { kind: "toolFailed", name: "Edit", detail: "a.ts" },
    ]);
  });

  it("ignores updates that only change session state", () => {
    const { events, m } = mapper();
    for (const sessionUpdate of [
      "user_message_chunk",
      "available_commands_update",
      "session_info_update",
      "current_mode_update",
      "config_option_update",
    ]) {
      m.handleUpdate({ sessionUpdate });
    }
    expect(events).toEqual([]);
  });

  it("streams message chunks as deltas and the whole as one reply", () => {
    const { events, m } = mapper();
    m.beginTurn();
    m.handleUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
    m.handleUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
    m.endTurn("end_turn");
    expect(events).toEqual([
      { kind: "delta", text: "Hel" },
      { kind: "delta", text: "lo" },
      { kind: "reply", text: "Hello" },
      { kind: "turnEnd" },
    ]);
  });

  it("announces a tool call once, with the path as detail", () => {
    const { events, m } = mapper();
    m.handleUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "1",
      title: "Read file",
      locations: [{ path: "/a/b.ts" }],
    });
    m.handleUpdate({ sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed" });
    expect(events).toEqual([{ kind: "tool", name: "Read file", detail: "/a/b.ts" }]);
  });

  it("falls back to rawInput for detail, and announces a call first seen as an update", () => {
    const { events, m } = mapper();
    m.handleUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "2",
      title: "Run",
      rawInput: { command: "ls -la" },
    });
    expect(events).toEqual([{ kind: "tool", name: "Run", detail: "ls -la" }]);
  });

  it("ignores vendor updates", () => {
    const { events, m } = mapper();
    for (const sessionUpdate of ["_vendor/thing"]) {
      m.handleUpdate({ sessionUpdate, content: { type: "text", text: "x" } });
    }
    expect(events).toEqual([]);
  });

  it("reports a refusal and a failure", () => {
    const { events, m } = mapper();
    m.endTurn("refusal");
    m.fail("boom");
    expect(events).toEqual([
      { kind: "error", message: "The agent refused to continue this turn." },
      { kind: "turnEnd" },
      { kind: "error", message: "boom" },
      { kind: "turnEnd" },
    ]);
  });
});

const request: AcpPermissionRequest = {
  sessionId: "s",
  toolCall: { toolCallId: "1", title: "Write" },
  options: [
    { optionId: "aa", kind: "allow_always" },
    { optionId: "ao", kind: "allow_once" },
    { optionId: "ro", kind: "reject_once" },
    { optionId: "ra", kind: "reject_always" },
  ],
};

describe("permission policy", () => {
  it("rejects once under read-only", () => {
    expect(decidePermission(request, "read-only")).toEqual({
      response: { outcome: { outcome: "selected", optionId: "ro" } },
      denied: true,
    });
  });

  it("allows once, never always, under workspace-write", () => {
    expect(decidePermission(request, "workspace-write").response).toEqual({
      outcome: { outcome: "selected", optionId: "ao" },
    });
  });

  it("cancels when no one-shot option exists", () => {
    const only = { ...request, options: [{ optionId: "aa", kind: "allow_always" }] };
    expect(decidePermission(only, "workspace-write").response).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("downgrades an interactive allow_always choice", () => {
    expect(constrainChoice(request, "aa")?.response).toEqual({
      outcome: { outcome: "selected", optionId: "ao" },
    });
    expect(constrainChoice(request, "nonsense")).toBeNull();
    expect(constrainChoice(request, null)?.denied).toBe(true);
  });
});

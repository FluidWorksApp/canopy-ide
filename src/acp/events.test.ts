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

  it("ignores thoughts, plans, commands, modes and vendor updates", () => {
    const { events, m } = mapper();
    for (const sessionUpdate of [
      "agent_thought_chunk",
      "plan",
      "available_commands_update",
      "current_mode_update",
      "_vendor/thing",
    ]) {
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

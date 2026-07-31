import { describe, expect, it } from "vitest";
import {
  OneshotTransport,
  StructuredTransport,
  newText,
  type CompanionEvent,
} from "./companionTransport";

function collector() {
  const events: CompanionEvent[] = [];
  return { events, emit: (e: CompanionEvent) => void events.push(e) };
}

const line = (o: unknown) => JSON.stringify(o);

const delta = (text: string) =>
  line({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });

describe("the streaming protocol", () => {
  it("streams token deltas in order", () => {
    const host = collector();
    const t = new StructuredTransport(host);
    t.handleLine(delta("Three "));
    t.handleLine(delta("call sites"));
    expect(host.events).toEqual([
      { kind: "delta", text: "Three " },
      { kind: "delta", text: "call sites" },
    ]);
  });

  it("does not print a reply twice when the full message follows its deltas", () => {
    // The failure this exists for: `assistant` messages arrive as well as the
    // deltas that built them, so naively handling both doubles every reply.
    const host = collector();
    const t = new StructuredTransport(host);
    t.handleLine(delta("Hello"));
    t.handleLine(
      line({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }),
    );
    expect(host.events.filter((e) => e.kind === "delta")).toEqual([
      { kind: "delta", text: "Hello" },
    ]);
  });

  it("falls back to the whole message when the CLI did not stream", () => {
    const host = collector();
    const t = new StructuredTransport(host);
    t.handleLine(
      line({ type: "assistant", message: { content: [{ type: "text", text: "Whole" }] } }),
    );
    expect(host.events).toEqual([{ kind: "delta", text: "Whole" }]);
  });

  it("surfaces tool calls with the field that says what they touched", () => {
    const host = collector();
    const t = new StructuredTransport(host);
    t.handleLine(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "canopy_workspace_git", input: {} },
            { type: "tool_use", name: "Read", input: { file_path: "/repo/src/a.ts" } },
          ],
        },
      }),
    );
    expect(host.events).toEqual([
      { kind: "tool", name: "canopy_workspace_git", detail: undefined },
      { kind: "tool", name: "Read", detail: "/repo/src/a.ts" },
    ]);
  });

  it("truncates a long tool detail rather than blowing out the chip", () => {
    const host = collector();
    const t = new StructuredTransport(host);
    t.handleLine(
      line({
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Bash", input: { command: "x".repeat(200) } }],
        },
      }),
    );
    const tool = host.events[0];
    expect(tool.kind).toBe("tool");
    expect(tool.kind === "tool" && tool.detail?.length).toBeLessThanOrEqual(60);
    expect(tool.kind === "tool" && tool.detail?.endsWith("…")).toBe(true);
  });

  it("ends the turn on a result, and reports one that failed", () => {
    const host = collector();
    const t = new StructuredTransport(host);
    t.handleLine(line({ type: "result", subtype: "success" }));
    expect(host.events).toEqual([{ kind: "turnEnd" }]);

    const host2 = collector();
    const t2 = new StructuredTransport(host2);
    t2.handleLine(line({ type: "result", is_error: true, result: "ran out of budget" }));
    expect(host2.events).toEqual([
      { kind: "error", message: "ran out of budget" },
      { kind: "turnEnd" },
    ]);
  });

  it("resets the delta guard between turns", () => {
    // Otherwise a turn that streamed silences the *next* turn's non-streamed
    // reply, and the chat goes blank after the first answer.
    const host = collector();
    const t = new StructuredTransport(host);
    t.handleLine(delta("first"));
    t.handleLine(line({ type: "result" }));
    t.handleLine(
      line({ type: "assistant", message: { content: [{ type: "text", text: "second" }] } }),
    );
    expect(host.events).toContainEqual({ kind: "delta", text: "second" });
  });

  it("ignores anything it does not know, including non-JSON banners", () => {
    // A CLI adding a message type, or printing a version banner, must not
    // break the chat.
    const host = collector();
    const t = new StructuredTransport(host);
    t.handleLine("Claude Code v2.1.0");
    t.handleLine("");
    t.handleLine(line({ type: "some_future_thing", payload: 1 }));
    t.handleLine(line({ type: "user", message: { content: [] } }));
    expect(host.events).toEqual([]);
  });

  it("reports the session being ready", () => {
    const host = collector();
    const t = new StructuredTransport(host);
    t.handleLine(line({ type: "system", subtype: "init" }));
    expect(host.events).toEqual([{ kind: "ready" }]);
  });
});

describe("recovering a reply from a redrawing terminal", () => {
  it("returns everything on a first read", () => {
    expect(newText("", "hello\nworld")).toBe("hello\nworld");
  });

  it("returns only what is new", () => {
    expect(newText("a\nb", "a\nb\nc")).toBe("c");
  });

  it("survives the screen being redrawn rather than appended", () => {
    // A TUI rewrites the whole frame, so the old lines come back every time;
    // a byte diff would report the entire screen as new.
    const before = "> question\nthinking…";
    const after = "> question\nthinking…\nThe answer is 41.";
    expect(newText(before, after)).toBe("The answer is 41.");
  });

  it("drops the prompt furniture the CLI redraws", () => {
    const after = "The answer.\n╭──────────╮\n│          │\n╰──────────╯\n> ";
    expect(newText("The answer.", after)).toBe("");
    expect(newText("", "Answer\n> ")).toBe("Answer\n>");
  });

  it("ignores trailing-whitespace churn", () => {
    expect(newText("a   \nb", "a\nb  \nc")).toBe("c");
  });
});

describe("the oneshot protocol (codex)", () => {
  function oneshot() {
    const host = collector();
    const sent: { message: string; sessionId: string | null }[] = [];
    let learned: string | null = null;
    const t = new OneshotTransport({
      host,
      sessionId: null,
      onSession: (id) => void (learned = id),
      launch: async (message, sessionId) => void sent.push({ message, sessionId }),
    });
    return { t, host, sent, learned: () => learned };
  }

  it("learns the thread id from the first turn", () => {
    // Unlike claude's --session-id, codex reports the id rather than accepting
    // one — so this is what makes the next turn a continuation.
    const o = oneshot();
    o.t.handleLine(line({ type: "thread.started", thread_id: "019fb7e5-acdb" }));
    expect(o.learned()).toBe("019fb7e5-acdb");
    expect(o.host.events).toContainEqual({ kind: "ready" });
  });

  it("resumes that id on the next message rather than starting over", async () => {
    const o = oneshot();
    o.t.handleLine(line({ type: "thread.started", thread_id: "T1" }));
    await o.t.send("second question");
    expect(o.sent).toEqual([{ message: "second question", sessionId: "T1" }]);
  });

  it("reads the reply out of a completed agent_message", () => {
    const o = oneshot();
    o.t.handleLine(
      line({ type: "item.completed", item: { type: "agent_message", text: "CODEX-OK" } }),
    );
    expect(o.host.events).toContainEqual({ kind: "reply", text: "CODEX-OK" });
  });

  it("surfaces shell and MCP calls as tool chips", () => {
    const o = oneshot();
    o.t.handleLine(
      line({ type: "item.completed", item: { type: "command_execution", command: "git status" } }),
    );
    o.t.handleLine(
      line({ type: "item.completed", item: { type: "mcp_tool_call", name: "canopy_workspace" } }),
    );
    expect(o.host.events).toContainEqual({ kind: "tool", name: "Shell", detail: "git status" });
    expect(o.host.events).toContainEqual({
      kind: "tool",
      name: "canopy_workspace",
      detail: undefined,
    });
  });

  it("ends the turn on turn.completed, and reports one that failed", () => {
    const o = oneshot();
    o.t.handleLine(line({ type: "turn.completed" }));
    expect(o.host.events).toEqual([{ kind: "turnEnd" }]);

    const b = oneshot();
    b.t.handleLine(line({ type: "turn.failed", error: { message: "rate limited" } }));
    expect(b.host.events).toEqual([
      { kind: "error", message: "rate limited" },
      { kind: "turnEnd" },
    ]);
  });

  it("ignores what it does not know", () => {
    const o = oneshot();
    o.t.handleLine("Reading additional input from stdin...");
    o.t.handleLine(line({ type: "turn.started" }));
    o.t.handleLine(line({ type: "item.started", item: { type: "reasoning" } }));
    expect(o.host.events).toEqual([]);
  });
});

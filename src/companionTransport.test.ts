import { describe, expect, it } from "vitest";
import {
  OneshotTransport,
  newText,
} from "./companionTransport";
import {
  StructuredEventParser,
  type StructuredRunnerEvent,
} from "./structuredEvents";

function collector() {
  const events: StructuredRunnerEvent[] = [];
  return { events, emit: (e: StructuredRunnerEvent) => void events.push(e) };
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
    const t = new StructuredEventParser(host);
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
    const t = new StructuredEventParser(host);
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
    const t = new StructuredEventParser(host);
    t.handleLine(
      line({ type: "assistant", message: { content: [{ type: "text", text: "Whole" }] } }),
    );
    expect(host.events).toEqual([{ kind: "delta", text: "Whole" }]);
  });

  it("surfaces tool calls with the field that says what they touched", () => {
    const host = collector();
    const t = new StructuredEventParser(host);
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
    const t = new StructuredEventParser(host);
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
    const t = new StructuredEventParser(host);
    t.handleLine(line({ type: "result", subtype: "success" }));
    expect(host.events).toEqual([{ kind: "turnEnd" }]);

    const host2 = collector();
    const t2 = new StructuredEventParser(host2);
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
    const t = new StructuredEventParser(host);
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
    const t = new StructuredEventParser(host);
    t.handleLine("Claude Code v2.1.0");
    t.handleLine("");
    t.handleLine(line({ type: "some_future_thing", payload: 1 }));
    t.handleLine(line({ type: "user", message: { content: [] } }));
    expect(host.events).toEqual([]);
  });

  it("reports the session being ready", () => {
    const host = collector();
    const t = new StructuredEventParser(host);
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
  function oneshot(sessionId: string | null = null) {
    const host = collector();
    const sent: { message: string; sessionId: string | null }[] = [];
    let learned: string | null = null;
    let forgotten = 0;
    const t = new OneshotTransport({
      host,
      sessionId,
      onSession: (id) => void (learned = id),
      onForget: () => void (forgotten += 1),
      launch: async (message, sessionId) => void sent.push({ message, sessionId }),
    });
    return { t, host, sent, learned: () => learned, forgotten: () => forgotten };
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

  it("starts over when the thread it resumed has gone, without telling the user", async () => {
    // The failure that left codex companions dead: the CLI keeps the id and
    // loses the rollout behind it, so every turn fails against the same dead
    // thread. The oneshot tier cannot fall back on companionSession's stale-
    // resume heal — it emits `ready` the moment the transport exists, so that
    // branch is unreachable here.
    const o = oneshot("DEAD");
    await o.t.send("can you start the website");
    o.t.handleLine(
      line({
        type: "turn.failed",
        error: {
          message:
            "thread/resume: thread/resume failed: no rollout found for thread id DEAD (code -32600)",
        },
      }),
    );
    // The same question, asked again as a first meeting.
    expect(o.sent).toEqual([
      { message: "can you start the website", sessionId: "DEAD" },
      { message: "can you start the website", sessionId: null },
    ]);
    expect(o.forgotten()).toBe(1);
    // Nothing shown: the user asked a question, and a dead id is Canopy's
    // problem to fix rather than a failure to report.
    expect(o.host.events).not.toContainEqual(
      expect.objectContaining({ kind: "error" }),
    );
    // The abandoned attempt's exit must not end the turn the replacement is
    // about to answer into.
    expect(o.t.consumeReplay()).toBe(true);
    expect(o.t.consumeReplay()).toBe(false);
  });

  it("heals on the bytes codex actually prints, which never reach handleLine", async () => {
    // Verified against codex 2026-08-02: `codex exec resume <dead-id>` writes
    // nothing to stdout, prints this one line to stderr and exits 1. So there
    // is no `turn.failed` JSONL to read — the stderr filter is the only place
    // this can be caught, which is why healing lives behind a method the spawn
    // closure can call rather than inside handleLine.
    const o = oneshot("d811f427-426f-420a-a215-32407360fda5");
    await o.t.send("can you start the website");
    const stderr =
      "Error: thread/resume: thread/resume failed: no rollout found for thread id " +
      "d811f427-426f-420a-a215-32407360fda5 (code -32600)";
    expect(o.t.healIfConversationGone(stderr)).toBe(true);
    expect(o.sent[1]).toEqual({
      message: "can you start the website",
      sessionId: null,
    });
    expect(o.forgotten()).toBe(1);
  });

  it("only heals once, so a CLI that always says that cannot loop", async () => {
    const o = oneshot("DEAD");
    await o.t.send("hello");
    const gone = line({
      type: "turn.failed",
      error: { message: "no rollout found for thread id DEAD" },
    });
    o.t.handleLine(gone);
    o.t.handleLine(gone);
    expect(o.sent).toHaveLength(2);
    expect(o.host.events).toContainEqual(
      expect.objectContaining({ kind: "error" }),
    );
  });

  it("reports an ordinary turn failure rather than swallowing it", async () => {
    const o = oneshot("T1");
    await o.t.send("hello");
    o.t.handleLine(
      line({ type: "turn.failed", error: { message: "usage limit reached" } }),
    );
    expect(o.sent).toHaveLength(1);
    expect(o.host.events).toContainEqual({
      kind: "error",
      message: "usage limit reached",
    });
  });

  it("reads the reply out of a completed agent_message", () => {
    const o = oneshot();
    o.t.handleLine(
      line({ type: "item.completed", item: { type: "agent_message", text: "CODEX-OK" } }),
    );
    expect(o.host.events).toContainEqual({ kind: "reply", text: "CODEX-OK" });
  });

  it("reads the MCP tool name from the field codex actually sends", () => {
    // Verified against codex-cli 0.146.0. The event is:
    //   {"type":"mcp_tool_call","server":"canopy","tool":"canopy_project",…}
    // We read `item.name`, which is never set on these, so the companion ran
    // tools on codex and showed an empty trail — a panel that answered from
    // nowhere. The server is dropped when it is our own: "canopy" beside every
    // canopy_* call is a word repeated on every line.
    const o = oneshot();
    o.t.handleLine(
      line({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "mcp_tool_call",
          server: "canopy",
          tool: "canopy_project",
          status: "completed",
        },
      }),
    );
    expect(o.host.events).toContainEqual({
      kind: "tool",
      name: "canopy_project",
      detail: undefined,
    });
  });

  it("names the server when the call is not to ours", () => {
    const o = oneshot();
    o.t.handleLine(
      line({
        type: "item.completed",
        item: { type: "mcp_tool_call", server: "MCP_DOCKER", tool: "list_containers" },
      }),
    );
    expect(o.host.events).toContainEqual({
      kind: "tool",
      name: "list_containers",
      detail: "MCP_DOCKER",
    });
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

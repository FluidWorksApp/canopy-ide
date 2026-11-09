import type { StructuredRunnerHost } from "../structuredEvents";
import type { AcpSessionUpdate, AcpToolCallFields } from "./protocol";

/** One line's worth of argument, as the other dialects do. */
function shorten(text: string): string {
  const t = text.trim();
  return t.length > 60 ? `${t.slice(0, 57)}\u2026` : t;
}

function toolDetail(call: Partial<AcpToolCallFields>): string | undefined {
  const path = call.locations?.find((l) => typeof l.path === "string" && l.path)?.path;
  if (path) return shorten(path);
  const input = call.rawInput;
  if (input && typeof input === "object") {
    for (const key of ["path", "file_path", "pattern", "command", "url", "query"]) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return shorten(value);
    }
  }
  return undefined;
}

/** Maps `session/update` notifications onto the normalized event vocabulary. */
export class AcpEventMapper {
  private reply = "";
  private announced = new Set<string>();
  private host: StructuredRunnerHost;

  constructor(host: StructuredRunnerHost) {
    this.host = host;
  }

  beginTurn(): void {
    this.reply = "";
    this.announced.clear();
  }

  handleUpdate(update: AcpSessionUpdate | undefined): void {
    if (!update) return;
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text) {
          this.reply += content.text;
          this.host.emit({ kind: "delta", text: content.text });
        }
        return;
      }
      case "tool_call": {
        const call = update as unknown as AcpToolCallFields;
        if (this.announced.has(call.toolCallId)) return;
        this.announced.add(call.toolCallId);
        this.host.emit({
          kind: "tool",
          name: call.title || call.kind || "tool",
          detail: toolDetail(call),
        });
        return;
      }
      case "tool_call_update": {
        // The agent often names the call only after it starts. Announce a call
        // first seen as an update; later updates are progress on a known row.
        const call = update as unknown as AcpToolCallFields;
        if (this.announced.has(call.toolCallId)) return;
        if (call.title || call.kind) {
          this.announced.add(call.toolCallId);
          this.host.emit({ kind: "tool", name: call.title || call.kind || "tool", detail: toolDetail(call) });
        }
        return;
      }
      // Thoughts, plans, command lists and mode changes have no event kind;
      // no host renders them, so they are dropped rather than invented.
      default:
        return;
    }
  }

  /** A permission refusal is reported against the tool the agent named. */
  blocked(tool: string): void {
    this.host.emit({ kind: "blocked", tool });
  }

  /** The `session/prompt` response arrived: the turn is over. */
  endTurn(stopReason: string | undefined): void {
    if (this.reply) this.host.emit({ kind: "reply", text: this.reply });
    this.reply = "";
    if (stopReason === "refusal") {
      this.host.emit({ kind: "error", message: "The agent refused to continue this turn." });
    } else if (stopReason === "max_tokens" || stopReason === "max_turn_requests") {
      this.host.emit({ kind: "error", message: `The turn stopped early (${stopReason}).` });
    }
    this.host.emit({ kind: "turnEnd" });
  }

  fail(message: string): void {
    this.reply = "";
    this.host.emit({ kind: "error", message });
    this.host.emit({ kind: "turnEnd" });
  }
}

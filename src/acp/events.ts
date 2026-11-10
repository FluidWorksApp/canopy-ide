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
  private announced = new Map<string, { name: string; detail?: string }>();
  private failed = new Set<string>();
  private host: StructuredRunnerHost;

  constructor(host: StructuredRunnerHost) {
    this.host = host;
  }

  beginTurn(): void {
    this.reply = "";
    this.announced.clear();
    this.failed.clear();
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
      case "agent_thought_chunk": {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (content?.type === "text" && content.text) {
          this.host.emit({ kind: "thought", text: content.text });
        }
        return;
      }
      case "plan": {
        const entries = (update as { entries?: unknown }).entries;
        if (!Array.isArray(entries)) return;
        this.host.emit({
          kind: "plan",
          entries: entries.flatMap((e) => {
            const row = e as { content?: unknown; status?: unknown; priority?: unknown };
            if (typeof row?.content !== "string") return [];
            return [
              {
                content: row.content,
                status: typeof row.status === "string" ? row.status : "pending",
                ...(typeof row.priority === "string" ? { priority: row.priority } : {}),
              },
            ];
          }),
        });
        return;
      }
      case "usage_update": {
        const u = update as { used?: unknown; size?: unknown; cost?: { amount?: unknown; currency?: unknown } | null };
        if (typeof u.used !== "number" || typeof u.size !== "number") return;
        const cost =
          typeof u.cost?.amount === "number" && typeof u.cost.currency === "string"
            ? { amount: u.cost.amount, currency: u.cost.currency }
            : undefined;
        this.host.emit({ kind: "usage", used: u.used, size: u.size, ...(cost ? { cost } : {}) });
        return;
      }
      case "tool_call":
      case "tool_call_update": {
        // The agent often names the call only after it starts, so a call first
        // seen as an update is announced then; later updates are progress on a
        // known row, except a failure, which is reported once.
        const call = update as unknown as AcpToolCallFields;
        let known = this.announced.get(call.toolCallId);
        if (!known && (update.sessionUpdate === "tool_call" || call.title || call.kind)) {
          known = { name: call.title || call.kind || "tool", detail: toolDetail(call) };
          this.announced.set(call.toolCallId, known);
          this.host.emit({ kind: "tool", name: known.name, detail: known.detail });
        }
        if (call.status === "failed" && !this.failed.has(call.toolCallId)) {
          this.failed.add(call.toolCallId);
          const name = known?.name ?? (call.title || call.kind || "tool");
          this.host.emit({ kind: "toolFailed", name, detail: known?.detail ?? toolDetail(call) });
        }
        return;
      }
      // user_message_chunk (history replay), available_commands_update,
      // session_info_update, current_mode_update and config_option_update
      // carry session state, not turn output. AcpSession keeps the state it
      // needs (mode, config options); no host shows the rest, so the mapper
      // drops them here on purpose.
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

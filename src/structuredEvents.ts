/** Normalized events shared by every structured chat surface. */
export type StructuredRunnerEvent =
  | { kind: "ready" }
  | { kind: "delta"; text: string }
  | { kind: "reply"; text: string }
  | { kind: "tool"; name: string; detail?: string }
  /** A tool call the CLI refused for want of a permission nobody can grant. */
  | { kind: "blocked"; tool: string }
  | { kind: "turnEnd" }
  | { kind: "error"; message: string }
  | { kind: "exit" };

export interface StructuredRunnerHost {
  emit(event: StructuredRunnerEvent): void;
}

interface StreamMessage {
  type?: string;
  subtype?: string;
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
  };
  message?: {
    content?: {
      type?: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
      /** A tool_result's payload: a bare string, or the block form of one. */
      content?: string | { type?: string; text?: string }[];
    }[];
  };
  result?: string;
  is_error?: boolean;
}

/** What the CLI says when a tool call needed a permission it never got.
 *
 * Matched on its shape because it arrives as prose in a tool_result and there
 * is no machine-readable form of it. A miss here degrades to the old
 * behaviour — the turn looks like it worked — so the pattern stays broad
 * enough to survive rewording and narrow enough that no ordinary result
 * matches it. */
const DENIED = /requested permissions? to use (\S+?),? but/i;

function resultText(
  content: string | { type?: string; text?: string }[] | undefined,
): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((part) => part.text ?? "").join("\n");
}

function toolDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ["path", "file_path", "pattern", "command", "url", "query", "project"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const text = value.trim();
      return text.length > 60 ? `${text.slice(0, 57)}\u2026` : text;
    }
  }
  return undefined;
}

/** Parses one vendor stream into the stable event vocabulary. */
export class StructuredEventParser {
  private sawDelta = false;
  private host: StructuredRunnerHost;

  constructor(host: StructuredRunnerHost) {
    this.host = host;
  }

  beginTurn(): void {
    this.sawDelta = false;
  }

  handleLine(raw: string): void {
    let msg: StreamMessage;
    try {
      msg = JSON.parse(raw) as StreamMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") this.host.emit({ kind: "ready" });
        return;
      case "stream_event": {
        const delta = msg.event?.delta;
        if (msg.event?.type === "content_block_delta" && delta?.type === "text_delta") {
          const text = delta.text ?? "";
          if (text) {
            this.sawDelta = true;
            this.host.emit({ kind: "delta", text });
          }
        }
        return;
      }
      case "assistant":
        for (const block of msg.message?.content ?? []) {
          if (block.type === "tool_use" && block.name) {
            this.host.emit({
              kind: "tool",
              name: block.name,
              detail: toolDetail(block.input),
            });
          } else if (block.type === "text" && block.text && !this.sawDelta) {
            this.host.emit({ kind: "delta", text: block.text });
          }
        }
        return;
      // Tool results come back on a `user` line. Only one of them is read: a
      // refusal for want of permission is the one outcome Canopy has to act on
      // itself, because the session it spawned cannot.
      case "user":
        for (const block of msg.message?.content ?? []) {
          if (block.type !== "tool_result") continue;
          const denied = DENIED.exec(resultText(block.content));
          if (denied) this.host.emit({ kind: "blocked", tool: denied[1] });
        }
        return;
      case "result":
        if (msg.is_error) {
          this.host.emit({
            kind: "error",
            message: msg.result || "The agent ended the turn with an error.",
          });
        }
        this.beginTurn();
        this.host.emit({ kind: "turnEnd" });
        return;
      default:
        return;
    }
  }
}

export function encodeStructuredUserMessage(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

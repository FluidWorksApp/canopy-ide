/** Normalized events shared by every structured chat surface. */
export type StructuredRunnerEvent =
  | { kind: "ready" }
  | { kind: "delta"; text: string }
  | { kind: "reply"; text: string }
  | { kind: "tool"; name: string; detail?: string }
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
    }[];
  };
  result?: string;
  is_error?: boolean;
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

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

/** Which vendor's JSON a structured stream is written in.
 *
 *  Two CLIs, two schemas, one vocabulary above. Claude and Codex agree on
 *  nothing at the wire — `system`/`stream_event`/`assistant`/`result` against
 *  `thread.started`/`item.completed`/`turn.completed` — so the dialect is
 *  declared per runner (structuredRunners.ts) and handed in here, rather than
 *  sniffed from the first line. Sniffing would have to guess, and the lines a
 *  failing launch actually produces are the ones least likely to identify
 *  themselves: a codex turn that dies on a bad flag emits clap's usage text on
 *  stderr and nothing at all on stdout. */
export type StructuredDialect = "claude" | "codex";

/** `codex exec --json` emits one of these per line. Fields are those observed
 *  against codex-cli 0.146.1; everything else on the line is ignored, which is
 *  what lets an unknown item type degrade to silence instead of a throw. */
interface CodexMessage {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
  error?: { message?: string };
}

interface CodexItem {
  id?: string;
  type?: string;
  /** `agent_message` — the reply itself. */
  text?: string;
  /** `command_execution` — the shell line, already assembled by codex. */
  command?: string;
  /** `mcp_tool_call` — codex names the tool `tool`, with `server` beside it. */
  tool?: string;
  server?: string;
  name?: string;
  /** `file_change` — every path the edit touched, with what happened to it. */
  changes?: { path?: string; kind?: string }[];
  /** `error` — informational, NOT a failed turn. See codexItem below. */
  message?: string;
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

/** One line's worth of argument. The trail is a single row per call, so a
 *  shell command with a heredoc in it has to stop somewhere. */
function shorten(text: string): string {
  const t = text.trim();
  return t.length > 60 ? `${t.slice(0, 57)}\u2026` : t;
}

function toolDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ["path", "file_path", "pattern", "command", "url", "query", "project"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return shorten(value);
  }
  return undefined;
}

/** Parses one vendor stream into the stable event vocabulary. */
export class StructuredEventParser {
  private sawDelta = false;
  private host: StructuredRunnerHost;
  private dialect: StructuredDialect;
  /** Codex reports the thread id it minted; Canopy never gets to choose one. */
  private onThread: ((threadId: string) => void) | undefined;
  /** Codex item ids already announced from `item.started`, so the matching
   *  `item.completed` does not put the same shell command in the trail twice. */
  private announced = new Set<string>();

  constructor(
    host: StructuredRunnerHost,
    opts?: {
      dialect?: StructuredDialect;
      onThread?: (threadId: string) => void;
    },
  ) {
    this.host = host;
    this.dialect = opts?.dialect ?? "claude";
    this.onThread = opts?.onThread;
  }

  beginTurn(): void {
    this.sawDelta = false;
    this.announced.clear();
  }

  handleLine(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (this.dialect === "codex") {
      this.codexLine(parsed as CodexMessage);
      return;
    }
    this.claudeLine(parsed as StreamMessage);
  }

  // ------------------------------------------------------------------ codex

  private codexLine(msg: CodexMessage): void {
    switch (msg.type) {
      case "thread.started":
        // The id is minted by codex on the first turn, not passed in — so
        // capturing it here is the only thing that can make a second turn a
        // continuation rather than a stranger. `codex exec resume <id>` takes
        // it positionally. Verified: resuming replays the same id back.
        if (msg.thread_id) this.onThread?.(msg.thread_id);
        this.host.emit({ kind: "ready" });
        return;
      // Every item arrives twice — `started` then `completed`. The trail is
      // drawn from `started` so a five-minute `pnpm install` shows up while it
      // is running rather than after it, and `completed` only fills in the ones
      // that were never announced (an item codex finishes instantly emits both
      // in the same breath, and some emit only `completed`).
      case "item.started":
        this.codexItem(msg.item);
        return;
      case "item.completed":
        this.codexItem(msg.item);
        return;
      case "turn.failed":
        this.host.emit({
          kind: "error",
          message: msg.error?.message || "The agent ended the turn with an error.",
        });
        this.beginTurn();
        this.host.emit({ kind: "turnEnd" });
        return;
      case "turn.completed":
        this.beginTurn();
        this.host.emit({ kind: "turnEnd" });
        return;
      // `turn.started`, `usage`, and whatever codex adds next: silence. An
      // unknown line must never throw — the parser is fed straight off the
      // process, and one bad line would take down a turn that is otherwise
      // fine.
      default:
        return;
    }
  }

  private codexItem(item: CodexItem | undefined): void {
    if (!item) return;
    if (item.id) {
      if (this.announced.has(item.id)) return;
      this.announced.add(item.id);
    }
    switch (item.type) {
      case "agent_message":
        // Codex has no token stream in `exec --json`; the reply arrives whole.
        if (item.text) this.host.emit({ kind: "reply", text: item.text });
        return;
      case "command_execution":
        if (item.command) {
          this.host.emit({ kind: "tool", name: "Shell", detail: shorten(item.command) });
        }
        return;
      case "file_change": {
        const paths = (item.changes ?? []).map((c) => c.path).filter(Boolean);
        this.host.emit({
          kind: "tool",
          name: "Edit",
          detail: paths.length ? shorten(paths.join(", ")) : undefined,
        });
        return;
      }
      case "mcp_tool_call": {
        const name = item.tool ?? item.name;
        if (!name) return;
        this.host.emit({
          kind: "tool",
          name,
          // Only when it is not our own server: "canopy" beside every canopy_*
          // call is a word repeated on every line of the trail.
          detail: item.server && item.server !== "canopy" ? item.server : undefined,
        });
        return;
      }
      // An `error` ITEM is not a failed turn, and reading it as one is the
      // difference between Codex working and Codex never working: codex reports
      // ordinary housekeeping through it, and a stock install emits
      //   {"type":"error","message":"Skill descriptions were shortened to fit
      //    the 2% skills context budget…"}
      // on the FIRST item of EVERY turn. Surfaced as `error` that would set the
      // caller's failure string on every run (vibeProjectSetup reads the last
      // one), so a perfectly good setup would be reported as the agent failing.
      // The turn's real verdict is `turn.failed` vs `turn.completed`, which is
      // where it is read.
      case "error":
        return;
      // `reasoning`, `todo_list`, `web_search`, and whatever comes next: an
      // unknown item is not an error, it is a thing this parser has no opinion
      // about yet.
      default:
        return;
    }
  }

  // ----------------------------------------------------------------- claude

  private claudeLine(msg: StreamMessage): void {
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

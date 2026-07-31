// How the companion's chat reaches an agent CLI.
//
// Two transports behind one interface, because the user picks the CLI and
// Canopy does not get to require a particular one. The split is the tier in
// companion.ts:
//
//   structured — the CLI documents a streaming JSON protocol on stdio. Replies
//     arrive as tokens, tool calls arrive as events, and the chat can render
//     thinking, tools and prose as the different things they are. Runs on plain
//     pipes (companion.rs).
//
//   terminal — every other CLI. Driven through a PTY the way a person drives
//     it, with the reply recovered by replaying what it painted (ptyText.ts).
//     Universal, and honestly worse: a redrawing TUI has no turn boundaries to
//     read, so the reply arrives whole after the screen settles, and tool calls
//     cannot be labelled. The settings screen says so rather than letting the
//     user find out.
//
// Both are driven the same way by companionSession.ts: `send` a message, get
// events until `turnEnd`.

import * as ipc from "./ipc";
import { COMPANION_RUNNERS, type CompanionLaunch } from "./companion";
import { renderPtyText } from "./ptyText";

/** What the chat renders. Deliberately smaller than either CLI's own protocol:
 *  a surface that models every field of one vendor's stream cannot be fed by
 *  the other. */
export type CompanionEvent =
  | { kind: "ready" }
  /** A slice of the reply being written, for the streaming tier. */
  | { kind: "delta"; text: string }
  /** A whole reply at once, for the terminal tier. */
  | { kind: "reply"; text: string }
  /** A tool the agent is running, named for the status chip. */
  | { kind: "tool"; name: string; detail?: string }
  /** The agent has finished this turn and is waiting on the user. */
  | { kind: "turnEnd" }
  /** Something the user needs told. Not fatal on its own. */
  | { kind: "error"; message: string }
  /** The CLI is gone. Everything after this needs a fresh start. */
  | { kind: "exit" };

export interface CompanionTransport {
  send(text: string): Promise<void>;
  stop(): Promise<void>;
}

export interface TransportHost {
  emit(event: CompanionEvent): void;
}

// ------------------------------------------------------------- structured

/**
 * The message types this understands, from the CLI's documented stream. Anything
 * else is ignored rather than treated as an error: a CLI that adds a message
 * type in a later release must not break the chat, and it is the *absence* of a
 * handler that keeps this from having to be updated in lockstep.
 */
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

/** A short, human phrase for the tool chip: the tool's name plus the one field
 *  that says *what* it is acting on. Anything longer belongs in the transcript,
 *  not on a chip in a 352px panel. */
function toolDetail(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ["path", "file_path", "pattern", "command", "url", "query", "project"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      const text = value.trim();
      return text.length > 60 ? `${text.slice(0, 57)}…` : text;
    }
  }
  return undefined;
}

/** Exported for its test. The line parser is where a protocol misreading would
 *  show up as duplicated or missing replies, and it is worth pinning down
 *  without a CLI in the loop. */
export class StructuredTransport implements CompanionTransport {
  /** Whether this turn has produced any token deltas. Full `assistant`
   *  messages arrive *as well as* the deltas that built them, so emitting both
   *  would print every reply twice; this is what decides which one is the
   *  source of truth for a given turn. */
  private sawDelta = false;

  private host: TransportHost;

  constructor(host: TransportHost) {
    this.host = host;
  }

  handleLine(raw: string): void {
    let msg: StreamMessage;
    try {
      msg = JSON.parse(raw) as StreamMessage;
    } catch {
      // Not JSON. A CLI that prints a banner or a warning on stdout is common
      // enough that this must not be reported as a failure — the protocol
      // messages will still parse.
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
      case "assistant": {
        for (const block of msg.message?.content ?? []) {
          if (block.type === "tool_use" && block.name) {
            this.host.emit({
              kind: "tool",
              name: block.name,
              detail: toolDetail(block.input),
            });
          } else if (block.type === "text" && block.text && !this.sawDelta) {
            // No deltas for this turn — either the CLI does not stream, or the
            // reply arrived in one piece. Either way this is the reply.
            this.host.emit({ kind: "delta", text: block.text });
          }
        }
        return;
      }
      case "result": {
        if (msg.is_error) {
          this.host.emit({
            kind: "error",
            message: msg.result || "The agent ended the turn with an error.",
          });
        }
        this.sawDelta = false;
        this.host.emit({ kind: "turnEnd" });
        return;
      }
      default:
        return;
    }
  }

  async send(text: string): Promise<void> {
    this.sawDelta = false;
    await ipc.companionWrite(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      }),
    );
  }

  async stop(): Promise<void> {
    await ipc.companionKill();
  }
}

/** Start a CLI that speaks the streaming protocol. Resolves once the process is
 *  up — not once the agent is ready, which arrives later as a `ready` event. */
export async function startStructured(
  cliId: string,
  launch: CompanionLaunch,
  host: TransportHost,
  opts: { resume: boolean; cwd?: string; env?: [string, string][] },
): Promise<CompanionTransport> {
  const runner = COMPANION_RUNNERS[cliId];
  if (!runner) throw new Error(`${cliId} has no verified streaming runner`);
  const transport = new StructuredTransport(host);
  const args = opts.resume
    ? runner.resumeArgs({ ...launch, sessionId: launch.sessionId })
    : runner.args(launch);
  await ipc.companionSpawn(
    { command: launch.bin, args, cwd: opts.cwd, env: opts.env },
    (out) => {
      if (out.kind === "line") transport.handleLine(out.text);
      else if (out.kind === "stderr") {
        // Only the lines that read like a failure. Agent CLIs are chatty on
        // stderr and forwarding all of it would bury the chat.
        if (/error|fatal|not found|denied|invalid/i.test(out.text)) {
          host.emit({ kind: "error", message: out.text });
        }
      } else if (out.kind === "exit") host.emit({ kind: "exit" });
    },
  );
  return transport;
}

// ---------------------------------------------------------------- oneshot

/**
 * A CLI whose non-interactive mode ends with its turn.
 *
 * `codex exec` has no long-lived stdin to write the next message to, so this
 * runs one process per turn and stitches the conversation together with the
 * thread id the CLI reports. Not a workaround — it is the shape of the CLI, and
 * it still gives structured events and a real memory, which is everything the
 * chat needs and everything the terminal tier cannot manage.
 *
 * The thread id arrives on the FIRST turn rather than being chosen up front, so
 * `onSession` hands it back for storing; every later turn resumes it.
 */
export class OneshotTransport implements CompanionTransport {
  private host: TransportHost;
  private launch: (message: string, sessionId: string | null) => Promise<void>;
  private sessionId: string | null;
  private onSession: (id: string) => void;

  constructor(opts: {
    host: TransportHost;
    sessionId: string | null;
    onSession: (id: string) => void;
    launch: (message: string, sessionId: string | null) => Promise<void>;
  }) {
    this.host = opts.host;
    this.sessionId = opts.sessionId;
    this.onSession = opts.onSession;
    this.launch = opts.launch;
  }

  /** One JSONL line from `codex exec --json`. */
  handleLine(raw: string): void {
    let msg: {
      type?: string;
      thread_id?: string;
      item?: { type?: string; text?: string; name?: string; command?: string };
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "thread.started":
        // First turn: this is the id that makes the next one a continuation.
        if (msg.thread_id && msg.thread_id !== this.sessionId) {
          this.sessionId = msg.thread_id;
          this.onSession(msg.thread_id);
        }
        this.host.emit({ kind: "ready" });
        return;
      case "item.completed": {
        const item = msg.item;
        if (!item) return;
        if (item.type === "agent_message" && item.text) {
          this.host.emit({ kind: "reply", text: item.text });
        } else if (item.type === "command_execution" && item.command) {
          this.host.emit({ kind: "tool", name: "Shell", detail: item.command.slice(0, 60) });
        } else if (item.type === "mcp_tool_call" && item.name) {
          this.host.emit({ kind: "tool", name: item.name });
        }
        return;
      }
      case "turn.failed":
        this.host.emit({
          kind: "error",
          message: msg.error?.message || "The agent ended the turn with an error.",
        });
        this.host.emit({ kind: "turnEnd" });
        return;
      case "turn.completed":
        this.host.emit({ kind: "turnEnd" });
        return;
      default:
        return;
    }
  }

  async send(text: string): Promise<void> {
    await this.launch(text, this.sessionId);
  }

  async stop(): Promise<void> {
    await ipc.companionKill();
  }
}

/** Start a oneshot-tier CLI. Nothing is spawned until the first message: the
 *  process IS the turn, so there is nothing to keep warm. `ready` is emitted so
 *  the panel is usable immediately rather than looking dead until first use. */
export function startOneshot(
  cliId: string,
  launch: CompanionLaunch,
  host: TransportHost,
  opts: {
    sessionId: string | null;
    onSession: (id: string) => void;
    cwd?: string;
    env?: [string, string][];
  },
): CompanionTransport {
  const runner = COMPANION_RUNNERS[cliId];
  if (!runner) throw new Error(`${cliId} has no verified runner`);
  let transport: OneshotTransport;
  const spawn = async (message: string, sessionId: string | null) => {
    const args = sessionId
      ? runner.resumeArgs({ ...launch, sessionId })
      : runner.args(launch);
    await ipc.companionSpawn(
      {
        command: launch.bin,
        // The brief rides on every turn: a fresh process has no memory of it,
        // and a resumed one was never told it in a way that survives.
        args: [...args, `${launch.systemPrompt}\n\n---\n\n${message}`],
        cwd: opts.cwd,
        env: opts.env,
      },
      (out) => {
        if (out.kind === "line") transport.handleLine(out.text);
        else if (out.kind === "stderr") {
          if (/error|fatal|not found|denied|invalid/i.test(out.text)) {
            host.emit({ kind: "error", message: out.text });
          }
        } else if (out.kind === "exit") {
          // A turn ending is the process ending, so this is normal — never the
          // "the agent stopped" that a streaming tier's exit means.
          host.emit({ kind: "turnEnd" });
        }
      },
    );
  };
  transport = new OneshotTransport({
    host,
    sessionId: opts.sessionId,
    onSession: opts.onSession,
    launch: spawn,
  });
  host.emit({ kind: "ready" });
  return transport;
}

// --------------------------------------------------------------- terminal

/** How long the screen has to stop changing before the reply is taken as
 *  finished. A TUI has no end-of-turn marker to read, so quiet is the only
 *  signal available — long enough that a pause mid-answer is not mistaken for
 *  the end, short enough not to feel broken. */
const SETTLE_MS = 1600;
const POLL_MS = 400;
/** Give up waiting after this long, so a CLI that sits redrawing a spinner
 *  forever still returns the user to a usable input. */
const TURN_CEILING_MS = 10 * 60 * 1000;

class TerminalTransport implements CompanionTransport {
  private timer: number | null = null;
  private baseline = "";
  private stopped = false;

  private ptyId: number;
  private host: TransportHost;

  constructor(ptyId: number, host: TransportHost) {
    this.ptyId = ptyId;
    this.host = host;
  }

  /** Everything the terminal has painted, as text. */
  private async screen(): Promise<string> {
    const raw = await ipc.ptyOutput(this.ptyId, 128 * 1024);
    if (raw == null) return "";
    return renderPtyText(raw, { maxChars: 24_000 });
  }

  /** Record where the transcript stands, so the next reply can be told from
   *  everything that came before it. */
  async mark(): Promise<void> {
    this.baseline = await this.screen();
  }

  async send(text: string): Promise<void> {
    await this.mark();
    // Body then CR a beat later. One burst ending in a carriage return is read
    // by every agent TUI as a paste and never submits.
    await ipc.ptyWrite(this.ptyId, text);
    window.setTimeout(() => void ipc.ptyWrite(this.ptyId, "\r"), 250);
    this.watch();
  }

  /** Poll until the screen settles, then hand over whatever is new. */
  private watch(): void {
    if (this.timer != null) window.clearInterval(this.timer);
    let last = "";
    let quietFor = 0;
    let waited = 0;
    this.timer = window.setInterval(async () => {
      if (this.stopped) return;
      waited += POLL_MS;
      const now = await this.screen();
      if (now === last) quietFor += POLL_MS;
      else {
        quietFor = 0;
        last = now;
      }
      if (quietFor < SETTLE_MS && waited < TURN_CEILING_MS) return;
      this.finish(now, waited >= TURN_CEILING_MS);
    }, POLL_MS) as unknown as number;
  }

  private finish(screen: string, timedOut: boolean): void {
    if (this.timer != null) window.clearInterval(this.timer);
    this.timer = null;
    const reply = newText(this.baseline, screen);
    this.baseline = screen;
    if (reply) this.host.emit({ kind: "reply", text: reply });
    if (timedOut) {
      this.host.emit({
        kind: "error",
        message: "The agent is still working — this is what it has said so far.",
      });
    }
    this.host.emit({ kind: "turnEnd" });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer != null) window.clearInterval(this.timer);
    await ipc.ptyKill(this.ptyId);
  }
}

/** What the screen gained since the baseline.
 *
 *  A TUI redraws rather than appends, so this cannot be a byte diff: the whole
 *  screen is rewritten every frame, and the visible transcript scrolls. Working
 *  in whole lines and dropping the ones that were already there is the closest
 *  honest approximation, and it is why this tier does not stream — a partial
 *  frame would come out as scrambled lines.
 *
 *  Exported for its test: this heuristic is the weakest part of the fallback
 *  and the one most worth pinning down. */
export function newText(before: string, after: string): string {
  if (!before) return after.trim();
  const seen = new Set(before.split("\n").map((l) => l.trimEnd()));
  const gained = after
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l && !seen.has(l));
  // Drop the CLI's own furniture: the prompt line it redraws, and the echo of
  // what the user just typed.
  return gained
    .filter((l) => !/^[\s>❯$╭╰│─╮╯]*$/.test(l))
    .join("\n")
    .trim();
}

/** Start a CLI that has no streaming protocol: its own TUI, in a detached PTY
 *  with no tab. The brief is typed in as the opening message, because there is
 *  no flag to carry it — which is the other reason this tier is the fallback. */
export async function startTerminal(
  host: TransportHost,
  opts: { command: string; cwd?: string; env?: [string, string][] },
): Promise<CompanionTransport> {
  const { id } = await ipc.ptySpawnDetached({
    cwd: opts.cwd,
    command: opts.command,
    env: opts.env,
  });
  const transport = new TerminalTransport(id, host);
  // Let the TUI come up before anything is typed at it — the same 2.5s the
  // micro-task launcher waits, for the same reason.
  window.setTimeout(() => {
    void transport.mark().then(() => host.emit({ kind: "ready" }));
  }, 2500);
  return transport;
}

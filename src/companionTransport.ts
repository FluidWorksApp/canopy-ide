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
import {
  companionRunnerLaunch,
  type CompanionLaunch,
} from "./companion";
import { renderPtyText } from "./ptyText";
import type { StructuredRunnerHost } from "./structuredEvents";
import {
  StructuredTransport,
  startStructured as startProjectStructured,
  type ProjectRunnerTransport,
} from "./projectRunner";
import { STRUCTURED_RUNNERS } from "./structuredRunners";

export { StructuredTransport };

export interface CompanionTransport extends ProjectRunnerTransport {
  /** Stop only the turn in flight while leaving a reusable transport. */
  cancelTurn?: () => Promise<void>;
  /** Re-run the last one-shot turn after a visible failure. */
  retryTurn?: () => Promise<void>;
}

export interface TransportHost extends StructuredRunnerHost {}

// ------------------------------------------------------------- structured

export async function startStructured(
  cliId: string,
  launch: CompanionLaunch,
  host: TransportHost,
  opts: { resume: boolean; cwd?: string; env?: [string, string][] },
): Promise<CompanionTransport> {
  return startProjectStructured(
    "companion",
    cliId,
    companionRunnerLaunch(launch, opts),
    host,
    {
      resume: opts.resume,
      process: {
        spawn: (_attemptId, spawn, onData) => ipc.companionSpawn(spawn, onData),
        write: (_attemptId, line) => ipc.companionWrite(line),
        kill: () => ipc.companionKill(),
      },
    },
  );
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
/** The conversation this id names is gone — the CLI kept the id and lost the
 *  transcript behind it. Codex says "no rollout found for thread id …", claude
 *  "No conversation found with session ID: …"; both mean the same thing and
 *  both are recoverable by forgetting the id. Matched on the phrase rather than
 *  a code because the code (-32600) is JSON-RPC's "invalid request", which is
 *  not specific to this at all. */
const CONVERSATION_GONE = /no rollout found|no conversation found|thread .{0,40}not found|session .{0,40}not found/i;
export const ONESHOT_TURN_CEILING_MS = 5 * 60 * 1000;
const WAITING_FOR_STDIN = /reading additional input from stdin/i;
const MCP_AUTH_REQUIRED =
  /AuthRequired|www_authenticate_header|oauth-protected-resource/i;

/** Codex prints MCP startup failures as Rust transport diagnostics. They belong
 * in a log, not in a chat card; translate the recoverable authentication case
 * into the action the person can actually take. */
export function companionMcpAuthError(text: string): string | null {
  if (!MCP_AUTH_REQUIRED.test(text)) return null;
  const id =
    /https?:\/\/(?:mcp\.)?([a-z0-9-]+)\./i.exec(text)?.[1]?.toLowerCase() ??
    /\b([a-z0-9-]+) MCP\b/i.exec(text)?.[1]?.toLowerCase();
  if (!id) {
    return "An MCP server needs authentication. Sign in to it from Codex, then Retry, or disable that MCP server in Codex.";
  }
  const label = `${id[0].toUpperCase()}${id.slice(1)}`;
  return `${label} MCP needs authentication. Run \`codex mcp login ${id}\` in a terminal, then Retry. To use Jarvis without it, disable that MCP server in Codex.`;
}

export class OneshotTransport implements CompanionTransport {
  private host: TransportHost;
  private launch: (message: string, sessionId: string | null) => Promise<void>;
  private sessionId: string | null;
  private onSession: (id: string) => void;
  private onForget: () => void;
  /** The turn in flight, kept only so a stale id can be healed by running it
   *  again — the user typed it once and should not have to type it twice. */
  private pending: string | null = null;
  /** A heal is in flight: the process that is about to exit belongs to the
   *  attempt we just abandoned, so its exit ends nothing. */
  private replaying = false;
  private active = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timeoutMs: number;
  private abort: () => Promise<void>;

  constructor(opts: {
    host: TransportHost;
    sessionId: string | null;
    onSession: (id: string) => void;
    onForget?: () => void;
    launch: (message: string, sessionId: string | null) => Promise<void>;
    abort?: () => Promise<void>;
    timeoutMs?: number;
  }) {
    this.host = opts.host;
    this.sessionId = opts.sessionId;
    this.onSession = opts.onSession;
    this.onForget = opts.onForget ?? (() => {});
    this.launch = opts.launch;
    this.abort = opts.abort ?? (() => ipc.companionKill());
    this.timeoutMs = opts.timeoutMs ?? ONESHOT_TURN_CEILING_MS;
  }

  private clearTimer(): void {
    if (this.timer != null) clearTimeout(this.timer);
    this.timer = null;
  }

  private endTurn(): boolean {
    if (!this.active) return false;
    this.active = false;
    this.clearTimer();
    this.host.emit({ kind: "turnEnd" });
    return true;
  }

  private failTurn(message: string): boolean {
    if (!this.active) return false;
    this.host.emit({ kind: "error", message });
    return this.endTurn();
  }

  /** Process exit is the normal one-shot turn boundary. Kept here so a
   *  timeout/cancel that already ended the turn cannot end it twice. */
  handleExit(): void {
    if (this.consumeReplay()) return;
    this.endTurn();
  }

  /** Stderr is normally diagnostic only. This particular Codex banner means
   *  the process is blocked on the exact stdin contract this transport must
   *  never violate, so fail immediately instead of waiting for the ceiling. */
  handleStderr(text: string): void {
    if (WAITING_FOR_STDIN.test(text)) {
      if (this.failTurn("Codex waited for stdin instead of starting the turn. Retry after updating Canopy.")) {
        void this.abort();
      }
      return;
    }
    const authError = companionMcpAuthError(text);
    if (authError) {
      if (this.failTurn(authError)) void this.abort();
      return;
    }
    if (/error|fatal|not found|denied|invalid/i.test(text)) {
      if (!this.healIfConversationGone(text)) {
        this.host.emit({ kind: "error", message: companionCliError(text) });
      }
    }
  }

  /** Whether the exit now arriving belongs to an abandoned attempt. Consumed,
   *  so the replacement turn's own exit still ends the turn. */
  consumeReplay(): boolean {
    const was = this.replaying;
    this.replaying = false;
    return was;
  }

  /** A turn that failed only because the conversation it resumed no longer
   *  exists. The oneshot tier could never recover from this on its own: it
   *  emits `ready` the moment the transport is built (there is no process to
   *  wait for), so the stale-resume heal in companionSession — which fires on a
   *  resume that dies before reaching `ready` — is unreachable here, and every
   *  turn from then on failed with the same error against the same dead id.
   *
   *  Forget the id and run the same turn again as a first meeting. The reply
   *  comes back without the conversation's history, which is the honest cost:
   *  the history is what has gone missing. Once only, and only while an id is
   *  held, so a CLI that fails this way for any other reason cannot loop. */
  healIfConversationGone(message: string): boolean {
    if (!this.sessionId || !CONVERSATION_GONE.test(message)) return false;
    const text = this.pending;
    if (!text) return false;
    this.sessionId = null;
    this.pending = null;
    this.replaying = true;
    this.onForget();
    void this.launch(text, null);
    return true;
  }

  /** One JSONL line from `codex exec --json`. */
  handleLine(raw: string): void {
    let msg: {
      type?: string;
      thread_id?: string;
      item?: {
        type?: string;
        text?: string;
        name?: string;
        tool?: string;
        server?: string;
        command?: string;
      };
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
        } else if (item.type === "mcp_tool_call") {
          // Codex calls the field `tool`, with the server beside it:
          //   {"type":"mcp_tool_call","server":"canopy","tool":"canopy_project"}
          // We read `name`, which is undefined on every one of these — so the
          // companion ran tools on codex and showed no trail at all, and the
          // panel looked like it had answered out of thin air. `name` stays as
          // a fallback rather than a replacement: it costs nothing, and this is
          // the second field name this event has had.
          const name = item.tool ?? item.name;
          if (name) {
            this.host.emit({
              kind: "tool",
              name,
              // Only when it is not our own server: "canopy" beside every
              // canopy_* call is a word repeated on every line of the trail.
              detail: item.server && item.server !== "canopy" ? item.server : undefined,
            });
          }
        }
        return;
      }
      case "turn.failed": {
        const message = msg.error?.message || "The agent ended the turn with an error.";
        // Silent on purpose when it heals: the user asked a question, and a
        // dead thread id is Canopy's problem to fix, not a failure to report.
        if (this.healIfConversationGone(message)) return;
        this.failTurn(message);
        return;
      }
      case "turn.completed":
        this.endTurn();
        return;
      default:
        return;
    }
  }

  async send(text: string): Promise<void> {
    if (this.active) return;
    this.pending = text;
    this.active = true;
    this.clearTimer();
    this.timer = setTimeout(() => {
      if (this.failTurn("The companion did not finish within 5 minutes. The turn was stopped; you can retry.")) {
        void this.abort();
      }
    }, this.timeoutMs);
    try {
      await this.launch(text, this.sessionId);
    } catch (err) {
      this.active = false;
      this.clearTimer();
      throw err;
    }
  }

  async cancelTurn(): Promise<void> {
    if (!this.failTurn("Turn cancelled.")) return;
    await this.abort();
  }

  async retryTurn(): Promise<void> {
    const text = this.pending;
    if (!text) throw new Error("There is no companion turn to retry.");
    await this.send(text);
  }

  async stop(): Promise<void> {
    this.active = false;
    this.clearTimer();
    await this.abort();
  }
}

/** CLI error streams sometimes wrap the only useful sentence in a protocol
 * envelope. Keep the diagnostic human-readable without hiding unknown text. */
export function companionCliError(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      message?: unknown;
      error?: { message?: unknown };
    };
    const message = parsed.error?.message ?? parsed.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // Plain stderr is already the best diagnostic available.
  }
  return text;
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
    /** Drop the stored id: the conversation it named is gone. */
    onForget?: () => void;
    cwd?: string;
    env?: [string, string][];
  },
): CompanionTransport {
  const runner = STRUCTURED_RUNNERS[cliId];
  if (!runner) throw new Error(`${cliId} has no verified runner`);
  let transport: OneshotTransport;
  const spawn = async (message: string, sessionId: string | null) => {
    const runnerLaunch = companionRunnerLaunch(
      sessionId ? { ...launch, sessionId } : launch,
      opts,
    );
    const args = sessionId
      ? runner.resumeArgs(runnerLaunch)
      : runner.args(runnerLaunch);
    await ipc.companionSpawn(
      {
        command: launch.bin,
        // The brief rides on every turn: a fresh process has no memory of it,
        // and a resumed one was never told it in a way that survives.
        args: [...args, `${launch.systemPrompt}\n\n---\n\n${message}`],
        cwd: opts.cwd,
        env: opts.env,
        // Codex treats a piped stdin as additional prompt text and reads it to
        // EOF. The complete prompt is already the final argv value.
        keepStdin: false,
      },
      (out) => {
        if (out.kind === "line") transport.handleLine(out.text);
        else if (out.kind === "stderr") transport.handleStderr(out.text);
        else if (out.kind === "exit") {
          // A turn ending is the process ending, so this is normal — never the
          // "the agent stopped" that a streaming tier's exit means. Except when
          // the transport has already abandoned this attempt and started the
          // turn again on a fresh thread: ending the turn here would close the
          // reply the replacement is about to write into.
          transport.handleExit();
        }
      },
    );
  };
  transport = new OneshotTransport({
    host,
    sessionId: opts.sessionId,
    onSession: opts.onSession,
    onForget: opts.onForget,
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

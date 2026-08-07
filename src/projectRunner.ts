import {
  StructuredEventParser,
  encodeStructuredUserMessage,
  type StructuredDialect,
  type StructuredRunnerEvent,
  type StructuredRunnerHost,
} from "./structuredEvents";
import {
  STRUCTURED_RUNNERS,
  streamsStructured,
  type StructuredRunner,
  type StructuredRunnerLaunch,
} from "./structuredRunners";

export interface ProjectRunnerTransport {
  send(text: string): Promise<void>;
  stop(): Promise<void>;
}

export type ProjectRunnerOutput =
  | { kind: "line"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "exit"; code: number | null };

/** Native process control is keyed before spawn so attempts cannot collide. */
export interface ProjectRunnerProcess {
  spawn(
    attemptId: string,
    opts: {
      command: string;
      args: string[];
      cwd?: string;
      env?: [string, string][];
      /** Whether the child keeps a writable stdin. Defaults to true, which is
       *  what a streaming CLI needs. A one-shot CLI must have it CLOSED: with
       *  the pipe held open `codex exec` waits on stdin for EOF forever and the
       *  turn never starts, whatever was passed as the prompt. */
      keepStdin?: boolean;
    },
    onData: (out: ProjectRunnerOutput) => void,
  ): Promise<void>;
  write(attemptId: string, line: string): Promise<void>;
  kill(attemptId: string): Promise<void>;
}

export class StructuredTransport implements ProjectRunnerTransport {
  private parser: StructuredEventParser;
  private attemptId: string;
  private process: ProjectRunnerProcess;

  constructor(
    attemptId: string,
    host: StructuredRunnerHost,
    process: ProjectRunnerProcess,
    dialect: StructuredDialect = "claude",
  ) {
    this.attemptId = attemptId;
    this.process = process;
    this.parser = new StructuredEventParser(host, { dialect });
  }

  handleLine(raw: string): void {
    this.parser.handleLine(raw);
  }

  async send(text: string): Promise<void> {
    this.parser.beginTurn();
    await this.process.write(this.attemptId, encodeStructuredUserMessage(text));
  }

  async stop(): Promise<void> {
    await this.process.kill(this.attemptId);
  }
}

/** How much of a failed launch's stderr is worth keeping to explain it. */
const STDERR_KEEP = 2000;

/**
 * A CLI whose non-interactive mode ends with its turn.
 *
 * `codex exec` has no long-lived stdin to write the next message to: the prompt
 * is an argument to launching, so one turn is one process and a follow-up is a
 * NEW process resuming the conversation by id. Everything above this class is
 * unchanged by that — same `ProjectRunnerTransport`, same events, same
 * `send`/`turnEnd` rhythm — because the difference is genuinely confined to
 * what `send` does.
 *
 * Three things here are not obvious and each is load-bearing:
 *
 *  1. The thread id is MINTED BY CODEX on the first turn and reported on
 *     `thread.started`; Canopy cannot pass its own `sessionId` in. So the id is
 *     captured off the stream and every later turn resumes it. It also means
 *     `opts.resume` is meaningless on the first turn of a fresh transport —
 *     Canopy's sessionId is not a codex thread id, and resuming it would fail
 *     with "no rollout found for thread id".
 *
 *  2. The process exiting is NORMAL — it is the turn finishing, never the
 *     "the agent stopped" that a streaming tier's exit means. Emitting `exit`
 *     here would be read by vibeProjectSetup as the attempt failing, on every
 *     single turn, including the ones that worked.
 *
 *  3. stderr is not an error channel on this CLI. codex logs MCP transport
 *     warnings at ERROR level on ordinary healthy runs, so matching /error/i
 *     and reporting it would decorate every good turn with a failure. What IS
 *     worth reporting is stderr from a process that died without ever speaking
 *     JSON — a rejected flag prints clap's usage there and nothing on stdout,
 *     which is exactly the invisible launch failure this whole runner exists to
 *     stop happening.
 */
export class OneshotStructuredTransport implements ProjectRunnerTransport {
  private parser: StructuredEventParser;
  private threadId: string | null = null;
  private turnOpen = false;
  /** Whether the CLI got far enough to say anything at all this turn. */
  private spoke = false;
  private stderr = "";
  /** Resolves when the previous turn's process has left the attempt slot. The
   *  native side refuses a second spawn under a live attempt id, so a follow-up
   *  sent the instant `turn.completed` arrives would collide with a process
   *  that has not finished exiting. */
  private settled: Promise<void> = Promise.resolve();

  private attemptId: string;
  private host: StructuredRunnerHost;
  private process: ProjectRunnerProcess;
  private runner: StructuredRunner;
  private launch: StructuredRunnerLaunch;

  constructor(
    attemptId: string,
    host: StructuredRunnerHost,
    process: ProjectRunnerProcess,
    runner: StructuredRunner,
    launch: StructuredRunnerLaunch,
  ) {
    this.attemptId = attemptId;
    this.host = host;
    this.process = process;
    this.runner = runner;
    this.launch = launch;
    // The parser reports the turn's end to the host; this transport has to know
    // it happened too, so that the process exit arriving a moment later does
    // not end the same turn twice.
    const watched: StructuredRunnerHost = {
      emit: (event: StructuredRunnerEvent) => {
        if (event.kind === "turnEnd") this.turnOpen = false;
        if (event.kind === "ready") this.spoke = true;
        this.host.emit(event);
      },
    };
    this.parser = new StructuredEventParser(watched, {
      dialect: runner.dialect,
      onThread: (id) => {
        this.threadId = id;
      },
    });
  }

  /** The argv for this turn, and whether it is a continuation. */
  private turnArgs(): string[] {
    if (!this.threadId) return this.runner.args(this.launch);
    // `codex exec resume` takes the id positionally, so it rides in as the
    // sessionId the runner already knows how to place.
    return this.runner.resumeArgs({
      ...this.launch,
      policy: { ...this.launch.policy, sessionId: this.threadId },
    });
  }

  async send(text: string): Promise<void> {
    await this.settled;
    this.parser.beginTurn();
    this.turnOpen = true;
    this.spoke = false;
    this.stderr = "";
    let done = () => {};
    this.settled = new Promise<void>((resolve) => {
      done = resolve;
    });
    const brief = this.launch.policy.systemPromptAppend;
    // The brief rides on every turn. There is no `--append-system-prompt` on
    // this CLI, a fresh process has no memory of it, and a resumed one only has
    // it as far back as the transcript goes.
    const prompt = brief ? `${brief}\n\n---\n\n${text}` : text;
    await this.process.spawn(
      this.attemptId,
      {
        command: this.launch.bin,
        args: [...this.turnArgs(), prompt],
        cwd: this.launch.policy.cwd,
        env: this.launch.env,
        // Without this the turn never starts at all — see ProjectRunnerProcess.
        keepStdin: false,
      },
      (out) => {
        if (out.kind === "line") {
          this.spoke = true;
          this.parser.handleLine(out.text);
        } else if (out.kind === "stderr") {
          if (this.stderr.length < STDERR_KEEP) this.stderr += `${out.text}\n`;
        } else if (out.kind === "exit") {
          if (this.turnOpen) {
            // Died mid-turn. If it never produced a single JSON line, the only
            // account of why is on stderr, and saying nothing here is what makes
            // a bad flag look like a bad agent.
            if (!this.spoke) {
              this.host.emit({
                kind: "error",
                message:
                  this.stderr.trim() ||
                  `${this.launch.bin} exited without starting the turn.`,
              });
            }
            this.turnOpen = false;
            this.host.emit({ kind: "turnEnd" });
          }
          done();
        }
      },
    );
  }

  async stop(): Promise<void> {
    await this.process.kill(this.attemptId);
  }
}

export interface ProjectRunnerController {
  start(
    attemptId: string,
    cliId: string,
    launch: StructuredRunnerLaunch,
    host: StructuredRunnerHost,
    opts: { resume: boolean },
  ): Promise<ProjectRunnerTransport>;
}

/** Build one controller over a caller-owned attempt-keyed process manager. */
export function createProjectRunner(
  process: ProjectRunnerProcess,
): ProjectRunnerController {
  return {
    start: (attemptId, cliId, launch, host, opts) =>
      startStructured(attemptId, cliId, launch, host, { ...opts, process }),
  };
}

export async function startStructured(
  attemptId: string,
  cliId: string,
  launch: StructuredRunnerLaunch,
  host: StructuredRunnerHost,
  opts: { resume: boolean; process: ProjectRunnerProcess },
): Promise<ProjectRunnerTransport> {
  if (!attemptId) throw new Error("A structured runner requires an attempt id");
  const runner = STRUCTURED_RUNNERS[cliId];
  // One rule, asked in one place. `streamsStructured` is the same predicate the
  // route eligibility filter uses (vibeProjectSetup, vibeBuilderSession), and it
  // is called here rather than re-stated: this launcher used to carry its own
  // copy of the test, and the copies drifted the moment one of them was
  // widened. A gate that says yes to a launcher that says no does not degrade —
  // it burns every attempt in the cap on a throw that happens before a process
  // exists, which reads as the agent failing and hides the real cause.
  if (!runner || !streamsStructured(cliId)) {
    throw new Error(`${cliId} has no verified streaming runner`);
  }
  // A one-shot CLI takes its prompt at launch, so there is nothing to start
  // until there is something to say. The process arrives with the first `send`.
  if (runner.tier === "oneshot") {
    return new OneshotStructuredTransport(
      attemptId,
      host,
      opts.process,
      runner,
      launch,
    );
  }
  const transport = new StructuredTransport(
    attemptId,
    host,
    opts.process,
    runner.dialect,
  );
  const args = opts.resume ? runner.resumeArgs(launch) : runner.args(launch);
  await opts.process.spawn(
    attemptId,
    {
      command: launch.bin,
      args,
      cwd: launch.policy.cwd,
      env: launch.env,
    },
    (out) => {
      if (out.kind === "line") transport.handleLine(out.text);
      else if (out.kind === "stderr") {
        if (/error|fatal|not found|denied|invalid/i.test(out.text)) {
          host.emit({ kind: "error", message: out.text });
        }
      } else if (out.kind === "exit") host.emit({ kind: "exit" });
    },
  );
  return transport;
}

import {
  withSessionEnv,
  type ProjectRunnerProcess,
  type ProjectRunnerTransport,
} from "../projectRunner";
import type { StructuredRunnerHost } from "../structuredEvents";
import type {
  StructuredRunner,
  StructuredRunnerLaunch,
} from "../structuredRunners";
import { fsReadText, fsWriteFileConfined } from "../ipc";
import { AcpSession, type AcpFileSystem } from "./client";
import type { AcpPermissionRequest } from "./protocol";

const STDERR_KEEP = 2000;
/** Larger files are refused by the reader instead of filling the renderer. */
const FS_READ_MAX_BYTES = 8 * 1024 * 1024;

/** The Tauri file commands. Writes go through the confined command, which
 *  resolves symlinks and re-checks the roots and protected files. */
const tauriFileSystem: AcpFileSystem = {
  readTextFile: (path) => fsReadText(path, FS_READ_MAX_BYTES),
  writeTextFile: (path, content, roots) => fsWriteFileConfined(path, content, roots),
};

/** A long-lived ACP agent behind the same `send`/`turnEnd` rhythm as every
 *  other runner. The process outlives the turn; `send` is `session/prompt`. */
export class AcpTransport implements ProjectRunnerTransport {
  private session: AcpSession;
  private ready: Promise<void> = Promise.resolve();
  private briefed = false;
  private stderr = "";
  private exited = false;
  private turns: Promise<void> = Promise.resolve();

  private attemptId: string;
  private host: StructuredRunnerHost;
  private process: ProjectRunnerProcess;
  private runner: StructuredRunner;
  private launch: StructuredRunnerLaunch;
  private opts: {
    resume: boolean;
    onPermission?: (request: AcpPermissionRequest) => Promise<string | null | undefined>;
    fs?: AcpFileSystem;
    /** Appended to a failure before `ready`, e.g. how to switch ACP off. */
    failureHint?: string;
  };

  constructor(
    attemptId: string,
    host: StructuredRunnerHost,
    process: ProjectRunnerProcess,
    runner: StructuredRunner,
    launch: StructuredRunnerLaunch,
    opts: {
      resume: boolean;
      onPermission?: (request: AcpPermissionRequest) => Promise<string | null | undefined>;
      fs?: AcpFileSystem;
      failureHint?: string;
    },
  ) {
    this.attemptId = attemptId;
    this.host = host;
    this.process = process;
    this.runner = runner;
    this.launch = launch;
    this.opts = opts;
    const policy = launch.policy;
    this.session = new AcpSession({
      write: (line) => this.process.write(this.attemptId, line),
      host,
      authority: policy.authority,
      cwd: policy.cwd ?? "",
      modeId: runner.acp?.defaultMode?.[policy.authority],
      modelId: policy.model || undefined,
      systemPrompt: policy.systemPromptAppend || undefined,
      authHint: runner.acp?.authHint,
      fs: opts.fs ?? tauriFileSystem,
      onPermission: opts.onPermission,
    });
  }

  get sessionId(): string | null {
    return this.session.sessionId;
  }

  async start(): Promise<void> {
    await this.process.spawn(
      this.attemptId,
      {
        command: this.runner.acp?.adapter ? this.runner.acp.command : this.launch.bin,
        args: this.opts.resume ? this.runner.resumeArgs(this.launch) : this.runner.args(this.launch),
        cwd: this.launch.policy.cwd,
        env: withSessionEnv(this.launch.env, this.runner.sessionEnv),
        keepStdin: true,
      },
      (out) => {
        if (out.kind === "line") this.session.handleLine(out.text);
        else if (out.kind === "stderr") {
          if (this.stderr.length < STDERR_KEEP) this.stderr += `${out.text}\n`;
        } else if (out.kind === "exit") {
          this.exited = true;
          this.session.close(
            this.stderr.trim() || `${this.launch.bin} exited before the session finished.`,
          );
          this.host.emit({ kind: "exit" });
        }
      },
    );
    const cwd = this.launch.policy.cwd ?? "";
    this.ready = (
      /^([/\\]|[A-Za-z]:[\\/])/.test(cwd)
        ? this.session.start(this.opts.resume ? this.launch.policy.sessionId : undefined)
        : Promise.reject(new Error("ACP needs an absolute working directory."))
    )
      .then(() => this.host.emit({ kind: "ready" }));
    // Reported on the host now; `send` rethrows it through `ready`.
    this.ready.catch((e) => {
      const message = e instanceof Error ? e.message : String(e);
      this.host.emit({
        kind: "error",
        message: this.opts.failureHint ? `${message} ${this.opts.failureHint}` : message,
      });
    });
  }

  async send(text: string): Promise<void> {
    // One prompt at a time: overlapping sends would share the reply buffer.
    const run = this.turns.then(() => this.sendNow(text));
    this.turns = run.catch(() => {});
    return run;
  }

  private async sendNow(text: string): Promise<void> {
    await this.ready;
    // An agent that advertises `systemPrompt` already has the brief from
    // session setup. Any other gets it on the first turn, where it stays in
    // the session history.
    const brief = this.launch.policy.systemPromptAppend;
    const prompt =
      !this.briefed && brief && !this.session.briefDelivered ? `${brief}\n\n---\n\n${text}` : text;
    this.briefed = true;
    await this.session.prompt(prompt);
  }

  async stop(): Promise<void> {
    if (!this.exited) await this.session.cancel().catch(() => {});
    await this.session.stop();
    await this.process.kill(this.attemptId);
  }
}

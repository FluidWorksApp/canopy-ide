import {
  StructuredEventParser,
  encodeStructuredUserMessage,
  type StructuredRunnerHost,
} from "./structuredEvents";
import {
  STRUCTURED_RUNNERS,
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
  ) {
    this.attemptId = attemptId;
    this.process = process;
    this.parser = new StructuredEventParser(host);
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
  if (!runner || runner.tier !== "structured") {
    throw new Error(`${cliId} has no verified streaming runner`);
  }
  const transport = new StructuredTransport(attemptId, host, opts.process);
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

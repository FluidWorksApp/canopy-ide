// One-shot brain calls over the Agent Client Protocol.
//
// brainCall.ts runs a headless CLI whose argv takes a prompt and ends with its
// answer. An ACP agent has no such argv: it is a long-lived JSON-RPC server, so
// one question is spawn → initialize → session/new → one session/prompt →
// terminate. This file is that sequence and nothing else. The protocol itself
// stays in src/acp (AcpTransport → AcpSession → AcpEventMapper); this only
// supplies a process backed by the brain_* commands (so the call gets the same
// scrubbed environment, process group and hard ceiling as a headless call) and
// a host that gathers the reply.
//
// Authority is always read-only: AcpSession answers every
// `session/request_permission` with reject_once (or cancels when the agent
// offers no reject option), Canopy advertises no fs or terminal client
// capabilities, and the runner's `--trust-all` style flag is only ever added for
// workspace-write. An agent's own non-permissioned tools are outside what the
// protocol lets Canopy gate; see the caveat in structuredRunners.ts.

import * as ipc from "./ipc";
import { AcpTransport } from "./acp/transport";
import type { ProjectRunnerProcess } from "./projectRunner";
import type { StructuredRunnerEvent, StructuredRunSummary } from "./structuredEvents";
import type { StructuredRunner } from "./structuredRunners";

export interface BrainRunResult {
  summary: StructuredRunSummary | null;
  stderr: string[];
  exitCode: number | null;
  /** How the run ended, from askBrain's side. */
  end: "done" | "exit" | "timeout" | "aborted" | "spawn-failed";
  spawnError?: string;
}

export interface AcpBrainRun {
  id: string;
  bin: string;
  runner: StructuredRunner;
  /** Already carries the JSON instruction when the caller wants JSON. */
  prompt: string;
  brief: string;
  model: string;
  cwd: string;
  env: [string, string][];
  timeoutMs: number;
  signal?: AbortSignal;
}

const emptySummary = (): StructuredRunSummary => ({
  done: false,
  text: "",
  isError: false,
  errorMessage: null,
  costUsd: null,
  inputTokens: null,
  outputTokens: null,
  durationMs: null,
  model: null,
  rateLimited: false,
});

/** Run one question against an ACP agent and reap it. Never throws. */
export async function runAcpBrainOnce(run: AcpBrainRun): Promise<BrainRunResult> {
  const summary = emptySummary();
  const stderr: string[] = [];
  if (run.signal?.aborted) return { summary, stderr, exitCode: null, end: "aborted" };

  let cwd = run.cwd;
  if (!cwd) {
    // ACP says the working directory in session/new and wants it absolute; a
    // project-less call (the connection probe) runs from home, as headless ones do.
    try {
      cwd = await ipc.brainHome();
    } catch (err) {
      return { summary, stderr, exitCode: null, end: "spawn-failed", spawnError: String(err) };
    }
  }

  return new Promise<BrainRunResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let transport: AcpTransport | null = null;
    const started = Date.now();
    const replyParts: string[] = [];
    let exitCodeSeen: number | null = null;

    const finish = (end: BrainRunResult["end"], exitCode: number | null = null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      run.signal?.removeEventListener("abort", onAbort);
      if (end !== "exit" && end !== "spawn-failed") {
        // Reap whatever is left. stop() cancels the turn, closes the session's
        // pending requests (brain_kill takes the process out of Rust's table
        // without an exit message, so nothing else would) and kills the
        // process. Without a transport yet there is no session to close.
        void (transport ? transport.stop() : ipc.brainKill(run.id)).catch(() => {});
      }
      resolve({ summary, stderr, exitCode, end, spawnError });
    };
    const onAbort = () => finish("aborted");
    run.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish("timeout"), run.timeoutMs);

    const host = {
      emit: (e: StructuredRunnerEvent) => {
        if (settled) return;
        switch (e.kind) {
          case "reply":
            replyParts.push(e.text);
            return;
          case "error":
            summary.isError = true;
            summary.errorMessage = summary.errorMessage ? `${summary.errorMessage}\n${e.message}` : e.message;
            return;
          case "turnEnd":
            summary.done = true;
            summary.text = replyParts.join("");
            summary.durationMs = Date.now() - started;
            finish("done");
            return;
          case "exit":
            finish("exit", exitCodeSeen);
            return;
          default:
            // ready, delta, tool, blocked: nothing a one-shot answer needs.
            return;
        }
      },
    };

    const process: ProjectRunnerProcess = {
      spawn: (id, o, onData) =>
        ipc.brainCallSpawn(
          id,
          {
            command: o.command,
            args: o.args,
            cwd: o.cwd ?? "",
            env: o.env,
            // A little past our own deadline, so Rust's ceiling is only the
            // backstop for a renderer that went away.
            timeoutMs: run.timeoutMs + 5_000,
            keepStdin: true,
          },
          (out) => {
            if (out.kind === "stderr") stderr.push(out.text);
            if (out.kind === "exit") exitCodeSeen = out.code;
            onData(out);
          },
        ),
      write: (id, line) => ipc.brainWrite(id, line),
      kill: (id) => ipc.brainKill(id),
    };
    transport = new AcpTransport(run.id, host, process, run.runner, {
      bin: run.bin,
      env: run.env,
      policy: {
        systemPromptAppend: run.brief,
        permissionMode: "",
        disallowedTools: [],
        model: run.model,
        sessionId: "",
        cwd,
        authority: "read-only",
      },
    }, { resume: false });

    void (async () => {
      try {
        await transport.start();
        // Aborted or timed out while the spawn was in flight: nothing reaped
        // it, because it did not exist yet.
        if (settled) void ipc.brainKill(run.id).catch(() => {});
        await transport.send(run.prompt);
      } catch (err) {
        if (settled) return;
        const message = err instanceof Error ? err.message : String(err);
        // Nothing ran if the spawn itself failed; otherwise the handshake or
        // the prompt failed and the process still has to be reaped.
        if (!transport.sessionId && /could not start|could not find|cwd does not exist|No such file/i.test(message)) {
          finish("spawn-failed", null, message);
          return;
        }
        summary.isError = true;
        summary.errorMessage = summary.errorMessage ?? message;
        finish("done");
      }
    })();
  });
}

// Codex, read off the real CLI.
//
// Every line in CODEX_TURN and CODEX_RESUME below was captured verbatim from
// `codex exec --json` (codex-cli 0.146.1) — a turn told to run a shell command,
// read a file and edit it, then a second turn resuming the same thread. They are
// pasted rather than invented because the one bug this parser exists to avoid is
// a schema someone guessed: a wrong item name does not throw, it just silently
// drops the reply, and the task reports the agent saying nothing.
//
// Only two edits were made to the captured text: absolute scratch paths were
// rewritten to /repo, and one command's `aggregated_output` was truncated. No
// type name, field name or event name was touched.

import { describe, expect, it } from "vitest";
import {
  StructuredEventParser,
  type StructuredRunnerEvent,
} from "./structuredEvents";
import {
  STRUCTURED_RUNNERS,
  codexResumeSandbox,
  codexSandbox,
  streamsStructured,
  type StructuredRunnerLaunch,
} from "./structuredRunners";
import {
  startStructured,
  type ProjectRunnerOutput,
  type ProjectRunnerProcess,
} from "./projectRunner";

const CODEX_TURN = [
  `{"type":"thread.started","thread_id":"019fd9f6-3e33-72e0-89e8-49e33838d1cf"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest."}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"I’ll perform the three filesystem actions in the exact order given."}}`,
  `{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc 'ls -la'","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"/bin/zsh -lc 'ls -la'","aggregated_output":"total 32\\ndrwxr-xr-x@ 6 shoaib  wheel  19","exit_code":0,"status":"completed"}}`,
  `{"type":"item.started","item":{"id":"item_4","type":"file_change","changes":[{"path":"/repo/notes.txt","kind":"update"}],"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_4","type":"file_change","changes":[{"path":"/repo/notes.txt","kind":"update"}],"status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_5","type":"agent_message","text":"DONE"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":79281,"cached_input_tokens":60416,"cache_write_input_tokens":0,"output_tokens":301,"reasoning_output_tokens":19}}`,
];

const CODEX_RESUME = [
  `{"type":"thread.started","thread_id":"019fd9f6-3e33-72e0-89e8-49e33838d1cf"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"notes.txt"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":99831,"cached_input_tokens":71424,"cache_write_input_tokens":0,"output_tokens":307,"reasoning_output_tokens":19}}`,
];

function readCodex(lines: string[]): {
  events: StructuredRunnerEvent[];
  threads: string[];
} {
  const events: StructuredRunnerEvent[] = [];
  const threads: string[] = [];
  const parser = new StructuredEventParser(
    { emit: (event) => void events.push(event) },
    { dialect: "codex", onThread: (id) => void threads.push(id) },
  );
  for (const line of lines) parser.handleLine(line);
  return { events, threads };
}

describe("the codex event schema", () => {
  it("reads a real turn into the shared vocabulary", () => {
    const { events, threads } = readCodex(CODEX_TURN);

    expect(threads).toEqual(["019fd9f6-3e33-72e0-89e8-49e33838d1cf"]);
    expect(events[0]).toEqual({ kind: "ready" });
    expect(events.at(-1)).toEqual({ kind: "turnEnd" });
    expect(events.filter((e) => e.kind === "reply")).toEqual([
      { kind: "reply", text: "I’ll perform the three filesystem actions in the exact order given." },
      { kind: "reply", text: "DONE" },
    ]);
    expect(events.filter((e) => e.kind === "tool")).toEqual([
      { kind: "tool", name: "Shell", detail: "/bin/zsh -lc 'ls -la'" },
      { kind: "tool", name: "Edit", detail: "/repo/notes.txt" },
    ]);
  });

  it("does not mistake the skills-budget notice for a failed turn", () => {
    // codex opens EVERY turn on a stock install with an item of type "error"
    // saying skill descriptions were shortened. Read as a failure it would set
    // the caller's error string on every run, and a setup that worked perfectly
    // would be reported as the agent failing.
    const { events } = readCodex(CODEX_TURN);
    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(events).toContainEqual({ kind: "turnEnd" });
  });

  it("announces a long-running command once, not twice", () => {
    // Every item arrives as `started` then `completed`. Emitting both put the
    // same shell line in the trail twice; ignoring `started` meant a five-minute
    // install showed nothing until it was over.
    const { events } = readCodex(CODEX_TURN);
    const shells = events.filter((e) => e.kind === "tool" && e.name === "Shell");
    expect(shells).toHaveLength(1);
  });

  it("reports a genuine turn failure, and only that", () => {
    const { events } = readCodex([
      CODEX_TURN[0],
      `{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}`,
    ]);
    expect(events).toContainEqual({
      kind: "error",
      message: "stream disconnected before completion",
    });
    expect(events.at(-1)).toEqual({ kind: "turnEnd" });
  });

  it("degrades silently on an item type it has never seen", () => {
    // Codex adds item types between releases. An unknown one must be nothing at
    // all — a throw here happens inside the process's own data callback, where
    // there is no turn left to report it to.
    const { events } = readCodex([
      `{"type":"item.completed","item":{"id":"x","type":"some_future_item","text":"?"}}`,
      `{"type":"some.future.event"}`,
      `not json at all`,
      `{"type":"turn.completed"}`,
    ]);
    expect(events).toEqual([{ kind: "turnEnd" }]);
  });

  it("replays the same thread id when resuming, so the id is not lost", () => {
    const { threads } = readCodex(CODEX_RESUME);
    expect(threads).toEqual(["019fd9f6-3e33-72e0-89e8-49e33838d1cf"]);
  });
});

describe("the codex argv", () => {
  const launch = (
    authority: "read-only" | "workspace-write" = "workspace-write",
  ): StructuredRunnerLaunch => ({
    bin: "codex",
    policy: {
      systemPromptAppend: "Build only in this project.",
      permissionMode: "bypassPermissions",
      disallowedTools: ["Bash"],
      model: "gpt-5.6-sol",
      sessionId: "canopy-minted-uuid",
      cwd: "/repo/app",
      authority,
    },
    additionalDirectories: ["/repo/lib"],
  });

  it("expresses authority with the flag `codex exec` actually has", () => {
    // Verified against `codex exec --help`: `-s, --sandbox <read-only |
    // workspace-write | danger-full-access>`.
    expect(codexSandbox("read-only")).toEqual(["-s", "read-only"]);
    expect(codexSandbox("workspace-write")).toEqual(["-s", "workspace-write"]);

    const args = STRUCTURED_RUNNERS.codex.args(launch());
    expect(args.slice(0, 3)).toEqual(["exec", "--json", "--skip-git-repo-check"]);
    expect(args).toEqual(expect.arrayContaining(["-s", "workspace-write"]));
    expect(args).toEqual(expect.arrayContaining(["-C", "/repo/app"]));
    expect(args).toEqual(expect.arrayContaining(["--add-dir", "/repo/lib"]));
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("danger-full-access");
  });

  it("does not pass `-s` to resume, which refuses it outright", () => {
    // `codex exec resume` is a different clap command with a much smaller flag
    // set. `-s` there is not ignored, it is fatal:
    //     error: unexpected argument '-s' found
    // printed on stderr with no JSON on stdout, so the turn presents as the
    // agent dying. The config key below is the equivalent it does accept, and
    // both keys were confirmed to exist by probing with `--strict-config`.
    const args = STRUCTURED_RUNNERS.codex.resumeArgs(launch());
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "canopy-minted-uuid"]);
    expect(args).not.toContain("-s");
    expect(args).not.toContain("-C");
    expect(args).not.toContain("--add-dir");
    expect(args).toEqual(
      expect.arrayContaining(["-c", 'sandbox_mode="workspace-write"']),
    );
  });

  it("names writable roots only when something may be written", () => {
    expect(codexResumeSandbox("read-only", ["/repo/lib"])).toEqual([
      "-c",
      'sandbox_mode="read-only"',
    ]);
    expect(codexResumeSandbox("workspace-write", ["/repo/lib"])).toEqual([
      "-c",
      'sandbox_mode="workspace-write"',
      "-c",
      'sandbox_workspace_write.writable_roots=["/repo/lib"]',
    ]);
  });

  it("is eligible for a task, which is the whole point", () => {
    expect(streamsStructured("codex")).toBe(true);
    expect(streamsStructured("claude")).toBe(true);
    // Still the gate for everything with no verified runner.
    expect(streamsStructured("amp")).toBe(false);
    expect(streamsStructured("aider")).toBe(false);
  });
});

function processHarness() {
  const spawned: {
    attemptId: string;
    opts: { args: string[]; cwd?: string; keepStdin?: boolean };
  }[] = [];
  const writes: string[] = [];
  let onData: ((out: ProjectRunnerOutput) => void) | null = null;
  const process: ProjectRunnerProcess = {
    spawn: async (attemptId, opts, next) => {
      spawned.push({ attemptId, opts });
      onData = next;
    },
    write: async (_attemptId, line) => void writes.push(line),
    kill: async () => {},
  };
  return {
    process,
    spawned,
    writes,
    emit: (out: ProjectRunnerOutput) => onData?.(out),
  };
}

const codexLaunch: StructuredRunnerLaunch = {
  bin: "codex",
  policy: {
    systemPromptAppend: "You are setting up a project.",
    permissionMode: "plan",
    disallowedTools: [],
    model: "",
    sessionId: "canopy-minted-uuid",
    cwd: "/repo",
    authority: "read-only",
  },
};

describe("the one-shot launch lifecycle", () => {
  it("starts nothing until there is something to say", async () => {
    const io = processHarness();
    await startStructured(
      "attempt-1",
      "codex",
      codexLaunch,
      { emit: () => {} },
      { resume: false, process: io.process },
    );
    // The process IS the turn, so there is nothing to keep warm — and a codex
    // spawned at `start` would sit holding the attempt slot the first `send`
    // needs.
    expect(io.spawned).toEqual([]);
  });

  it("carries the prompt as an argument, never on stdin", async () => {
    const io = processHarness();
    const transport = await startStructured(
      "attempt-1",
      "codex",
      codexLaunch,
      { emit: () => {} },
      { resume: false, process: io.process },
    );
    await transport.send("Describe this project");

    expect(io.writes).toEqual([]);
    // `codex exec` blocks on stdin for EOF whenever stdin is a pipe, even with
    // the prompt supplied as an argument. Held open, the turn never starts at
    // all — verified: no output and still running after two minutes.
    expect(io.spawned[0].opts.keepStdin).toBe(false);
    expect(io.spawned[0].opts.args.at(-1)).toBe(
      "You are setting up a project.\n\n---\n\nDescribe this project",
    );
  });

  it("makes the second turn a continuation of the id codex minted", async () => {
    const io = processHarness();
    const events: StructuredRunnerEvent[] = [];
    const transport = await startStructured(
      "attempt-1",
      "codex",
      codexLaunch,
      { emit: (event) => void events.push(event) },
      { resume: false, process: io.process },
    );

    await transport.send("first");
    // Canopy's own sessionId is not a codex thread id and never can be — codex
    // mints its own and reports it here. This is the only place it is learnable.
    expect(io.spawned[0].opts.args).not.toContain("resume");
    for (const line of CODEX_TURN) io.emit({ kind: "line", text: line });
    io.emit({ kind: "exit", code: 0 });

    await transport.send("second");
    expect(io.spawned[1].opts.args.slice(0, 3)).toEqual([
      "exec",
      "resume",
      "019fd9f6-3e33-72e0-89e8-49e33838d1cf",
    ]);
  });

  it("treats the process ending as the turn ending, not the agent stopping", async () => {
    const io = processHarness();
    const events: StructuredRunnerEvent[] = [];
    const transport = await startStructured(
      "attempt-1",
      "codex",
      codexLaunch,
      { emit: (event) => void events.push(event) },
      { resume: false, process: io.process },
    );
    await transport.send("go");
    for (const line of CODEX_TURN) io.emit({ kind: "line", text: line });
    io.emit({ kind: "exit", code: 0 });

    // vibeProjectSetup reads `exit` as the attempt failing. On a CLI whose
    // process ends with every turn, emitting it would fail every good run.
    expect(events).not.toContainEqual({ kind: "exit" });
    expect(events.filter((e) => e.kind === "turnEnd")).toHaveLength(1);
  });

  it("says why when the CLI dies before producing any JSON", async () => {
    const io = processHarness();
    const events: StructuredRunnerEvent[] = [];
    const transport = await startStructured(
      "attempt-1",
      "codex",
      codexLaunch,
      { emit: (event) => void events.push(event) },
      { resume: false, process: io.process },
    );
    await transport.send("go");
    // A rejected flag prints clap's usage on stderr and nothing on stdout.
    // Silence here is the invisible launch failure this runner exists to end.
    io.emit({ kind: "stderr", text: "error: unexpected argument '-s' found" });
    io.emit({ kind: "exit", code: 2 });

    expect(events).toContainEqual({
      kind: "error",
      message: "error: unexpected argument '-s' found",
    });
    expect(events.at(-1)).toEqual({ kind: "turnEnd" });
  });

  it("keeps codex's routine stderr chatter out of a healthy turn", async () => {
    const io = processHarness();
    const events: StructuredRunnerEvent[] = [];
    const transport = await startStructured(
      "attempt-1",
      "codex",
      codexLaunch,
      { emit: (event) => void events.push(event) },
      { resume: false, process: io.process },
    );
    await transport.send("go");
    // Observed on every run with MCP servers configured. Matching /error/i and
    // reporting it would decorate every good turn with a failure.
    io.emit({
      kind: "stderr",
      text: "ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed",
    });
    for (const line of CODEX_TURN) io.emit({ kind: "line", text: line });
    io.emit({ kind: "exit", code: 0 });

    expect(events.filter((e) => e.kind === "error")).toEqual([]);
    expect(events).toContainEqual({ kind: "reply", text: "DONE" });
  });
});

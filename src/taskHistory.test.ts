import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ipc from "./ipc";
import {
  clearTaskHistory,
  completedTaskRuns,
  endAbandonedRun,
  recordTaskEnd,
  recordTaskStart,
  removeTaskRun,
  resetTaskHistoryForTests,
  runIcon,
  runTitle,
  canResumeRun,
  sweepStaleRuns,
  taskRuns,
  updateTaskRun,
  type TaskRun,
  researchEntryForFile,
  resolveTaskFile,
  tidyOutput,
  hydrateTaskHistory,
  loadTaskRunOutput,
  MAX_EAGER_OUTPUTS,
  MAX_RETAINED_OUTPUT_CHARS,
  MAX_SINGLE_OUTPUT_CHARS,
  OUTPUT_READ_CONCURRENCY,
  refreshTaskHistory,
} from "./taskHistory";

const start = (over: Partial<Omit<TaskRun, "id" | "status" | "startedAt">> = {}) =>
  recordTaskStart({
    taskId: "raise-pr",
    label: "Raise PR",
    agent: "claude",
    cwd: "/repo",
    projectId: "p1",
    brief: "Open a pull request.",
    ...over,
  });

beforeEach(() => {
  localStorage.clear();
  resetTaskHistoryForTests();
  vi.restoreAllMocks();
});

describe("legacy adoption", () => {
  it("hands localStorage rows to TaskEnvelope once, then reads the store", async () => {
    const legacyId = start();
    const summary = {
      runId: "run-imported",
      projectId: "p1",
      componentId: "p1",
      kind: "raise-pr",
      title: "Raise PR",
      status: "failed" as const,
      attemptCount: 1,
      createdAt: 10,
      updatedAt: 20,
      metadata: {
        history: true,
        legacySourceId: legacyId,
        attemptId: "attempt-imported",
        taskId: "raise-pr",
        label: "Raise PR",
        agent: "claude",
        cwd: "/repo",
        projectId: "p1",
        brief: "Open a pull request.",
        startedAt: 10,
      },
    };
    vi.spyOn(ipc, "taskListHistory")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([summary]);
    vi.spyOn(ipc, "taskReserve").mockResolvedValue({
      envelope: { ...summary, status: "running", metadata: {} },
      attempt: {
        attemptId: "attempt-imported",
        runId: "run-imported",
        ordinal: 1,
        state: "reserved",
        route: {
          cli: "claude",
          profileId: "default",
          harnessVersion: "legacy",
          promptVersion: "legacy",
          toolPolicyVersion: "legacy",
          executionMode: "pty",
        },
      },
    });
    vi.spyOn(ipc, "taskUpdateMetadata").mockResolvedValue(summary);
    const settle = vi.spyOn(ipc, "taskAttemptSettle").mockResolvedValue({
      attemptId: "attempt-imported",
      runId: "run-imported",
      ordinal: 1,
      state: "interrupted",
      route: {
        cli: "claude",
        profileId: "default",
        harnessVersion: "legacy",
        promptVersion: "legacy",
        toolPolicyVersion: "legacy",
        executionMode: "pty",
      },
    });

    await hydrateTaskHistory();

    expect(localStorage.getItem("canopy.taskHistory")).toBeNull();
    expect(taskRuns()).toMatchObject([
      { id: "run-imported", attemptId: "attempt-imported", status: "stopped" },
    ]);
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: "attempt-imported",
        state: "interrupted",
      }),
    );
  });
});

describe("recordTaskStart", () => {
  it("logs a running entry that a stop or finish can key on", () => {
    const id = start();
    const runs = taskRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].id).toBe(id);
    expect(runs[0].status).toBe("running");
    expect(runs[0].startedAt).toBeGreaterThan(0);
    expect(runs[0].endedAt).toBeUndefined();
  });

  it("keeps newest first", () => {
    start({ label: "first" });
    start({ label: "second" });
    expect(taskRuns().map((r) => r.label)).toEqual(["second", "first"]);
  });
});

describe("recordTaskEnd", () => {
  it("stamps the outcome and an end time", () => {
    const id = start();
    recordTaskEnd(id, { status: "done", summary: "Opened #136", url: "https://x/1" });
    const run = taskRuns()[0];
    expect(run.status).toBe("done");
    expect(run.summary).toBe("Opened #136");
    expect(run.url).toBe("https://x/1");
    expect(run.endedAt).toBeGreaterThanOrEqual(run.startedAt);
  });

  // The tab-close path fires after job_done on every task that succeeds, so
  // without the guard every completed run would be relabelled "stopped".
  it("never overwrites a run that already ended", () => {
    const id = start();
    recordTaskEnd(id, { status: "done", summary: "kept" });
    recordTaskEnd(id, { status: "stopped", summary: "clobbered" });
    expect(taskRuns()[0].status).toBe("done");
    expect(taskRuns()[0].summary).toBe("kept");
  });

  it("ignores an unknown id", () => {
    start();
    recordTaskEnd("nope", { status: "done" });
    expect(taskRuns()[0].status).toBe("running");
  });
});

describe("completedTaskRuns", () => {
  it("leaves out the ones still going", () => {
    const done = start({ label: "done" });
    start({ label: "still going" });
    recordTaskEnd(done, { status: "done" });
    expect(completedTaskRuns().map((r) => r.label)).toEqual(["done"]);
  });

  // The log is app-wide, but every surface showing it sits inside a project.
  it("scopes to one project when asked, and to all when not", () => {
    const a = start({ label: "here", projectId: "p1" });
    const b = start({ label: "elsewhere", projectId: "p2" });
    recordTaskEnd(a, { status: "done" });
    recordTaskEnd(b, { status: "done" });
    expect(completedTaskRuns("p1").map((r) => r.label)).toEqual(["here"]);
    expect(completedTaskRuns().map((r) => r.label)).toEqual(["elsewhere", "here"]);
  });
});

describe("abandoned runs", () => {
  // "It needed you and you never came back" is a different outcome from "you
  // called it off", and it's the only thing that ever writes `blocked`.
  it("settles as blocked when the agent had asked for the user", () => {
    const id = start();
    updateTaskRun(id, { summary: "Need a token", askedForUser: true });
    endAbandonedRun(id, "tail");
    const run = taskRuns()[0];
    expect(run.status).toBe("blocked");
    expect(run.summary).toBe("Need a token");
    expect(run.output).toBe("tail");
  });

  it("settles as stopped otherwise", () => {
    const id = start();
    endAbandonedRun(id);
    expect(taskRuns()[0].status).toBe("stopped");
  });

  it("leaves a run that already reported done alone", () => {
    const id = start();
    recordTaskEnd(id, { status: "done", summary: "shipped" });
    endAbandonedRun(id);
    expect(taskRuns()[0].status).toBe("done");
  });
});

describe("sweepStaleRuns", () => {
  // A micro-task in flight when the app quits has no tab to come back to, so it
  // can never report — without the sweep it stays "running" forever: invisible
  // to the history tab and still holding one of the 200 slots.
  it("settles anything left running by a previous launch", () => {
    const running = start({ label: "orphan" });
    const blocked = start({ label: "orphan asking" });
    updateTaskRun(blocked, { askedForUser: true });
    const finished = start({ label: "finished" });
    recordTaskEnd(finished, { status: "done" });

    sweepStaleRuns();

    const byId = Object.fromEntries(taskRuns().map((r) => [r.id, r]));
    expect(byId[running].status).toBe("stopped");
    expect(byId[blocked].status).toBe("blocked");
    expect(byId[finished].status).toBe("done");
    expect(completedTaskRuns()).toHaveLength(3);
  });

  it("does nothing, and writes nothing, when everything already settled", () => {
    const id = start();
    recordTaskEnd(id, { status: "done" });
    const before = localStorage.getItem("canopy.taskHistory");
    sweepStaleRuns();
    expect(localStorage.getItem("canopy.taskHistory")).toBe(before);
  });
});

describe("bounds", () => {
  it("keeps at most 200 runs, dropping the oldest", () => {
    for (let i = 0; i < 205; i++) start({ label: `t${i}` });
    const runs = taskRuns();
    expect(runs).toHaveLength(200);
    expect(runs[0].label).toBe("t204");
    expect(runs.at(-1)?.label).toBe("t5");
  });

  // The record outlives its transcript: 200 × 8KB would be most of the
  // localStorage budget the workspace and settings also live in.
  it("ages the captured output out well before the record", () => {
    const ids: string[] = [];
    for (let i = 0; i < 70; i++) ids.push(start({ label: `t${i}` }));
    for (const id of ids) recordTaskEnd(id, { status: "done", output: "scrollback" });
    const runs = taskRuns();
    expect(runs[0].output).toBe("scrollback");
    expect(runs[59].output).toBe("scrollback");
    expect(runs[60].output).toBeUndefined();
    // The run itself is still there — only its transcript went.
    expect(runs[60].status).toBe("done");
    expect(runs).toHaveLength(70);
  });
});

const storedSummary = (n: number) => ({
  runId: `run-${n}`,
  projectId: "p1",
  componentId: "p1",
  kind: "adhoc",
  title: `Task ${n}`,
  status: "completed" as const,
  attemptCount: 1,
  createdAt: 100 - n,
  updatedAt: 200 - n,
  metadata: {
    history: true,
    taskId: "adhoc",
    label: `Task ${n}`,
    agent: "codex",
    cwd: "/repo",
    projectId: "p1",
    brief: "do it",
    startedAt: 100 - n,
    outputArtifactId: `artifact-${n}`,
  },
});

describe("durable output hydration bounds", () => {
  it("hydrates only the newest window with bounded concurrency", async () => {
    vi.spyOn(ipc, "taskListHistory").mockResolvedValue(
      Array.from({ length: MAX_EAGER_OUTPUTS + 3 }, (_, n) => storedSummary(n)),
    );
    let active = 0;
    let peak = 0;
    const read = vi.spyOn(ipc, "taskArtifactRead").mockImplementation(async (id) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active--;
      return `tail:${id}`;
    });

    await refreshTaskHistory();

    expect(peak).toBeLessThanOrEqual(OUTPUT_READ_CONCURRENCY);
    expect(read).toHaveBeenCalledTimes(MAX_EAGER_OUTPUTS);
    expect(read.mock.calls.map(([id]) => id)).toEqual(
      Array.from({ length: MAX_EAGER_OUTPUTS }, (_, n) => `artifact-${n}`),
    );
    expect(taskRuns()[MAX_EAGER_OUTPUTS].output).toBeUndefined();
  });

  it("stops an older refresh before it starts another output batch", async () => {
    vi.spyOn(ipc, "taskListHistory")
      .mockResolvedValueOnce(
        Array.from({ length: MAX_EAGER_OUTPUTS }, (_, n) => storedSummary(n)),
      )
      .mockResolvedValueOnce([]);
    const releases: Array<() => void> = [];
    const read = vi.spyOn(ipc, "taskArtifactRead").mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          releases.push(() => resolve("late tail"));
        }),
    );

    const stale = refreshTaskHistory();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(OUTPUT_READ_CONCURRENCY));
    await refreshTaskHistory();
    releases.forEach((release) => release());
    await stale;

    expect(read).toHaveBeenCalledTimes(OUTPUT_READ_CONCURRENCY);
    expect(taskRuns()).toEqual([]);
  });

  it("caps individual and aggregate retained output characters", async () => {
    vi.spyOn(ipc, "taskListHistory").mockResolvedValue(
      Array.from({ length: MAX_EAGER_OUTPUTS }, (_, n) => storedSummary(n)),
    );
    vi.spyOn(ipc, "taskArtifactRead").mockImplementation(async () =>
      "x".repeat(MAX_SINGLE_OUTPUT_CHARS + 100),
    );

    await refreshTaskHistory();

    const outputs = taskRuns().flatMap((run) => (run.output ? [run.output] : []));
    expect(outputs[0].length).toBe(MAX_SINGLE_OUTPUT_CHARS);
    expect(outputs[0]).toContain("history output truncated");
    expect(outputs.reduce((sum, output) => sum + output.length, 0)).toBeLessThanOrEqual(
      MAX_RETAINED_OUTPUT_CHARS,
    );
  });

  it("loads an older tail on demand and shares concurrent requests", async () => {
    vi.spyOn(ipc, "taskListHistory").mockResolvedValue(
      Array.from({ length: MAX_EAGER_OUTPUTS + 1 }, (_, n) => storedSummary(n)),
    );
    let release: ((value: string) => void) | undefined;
    const read = vi.spyOn(ipc, "taskArtifactRead").mockImplementation(async (id) => {
      if (id !== `artifact-${MAX_EAGER_OUTPUTS}`) return `tail:${id}`;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    });
    await refreshTaskHistory();

    const first = loadTaskRunOutput(`run-${MAX_EAGER_OUTPUTS}`);
    const second = loadTaskRunOutput(`run-${MAX_EAGER_OUTPUTS}`);
    expect(first).toBe(second);
    expect(
      read.mock.calls.filter(([id]) => id === `artifact-${MAX_EAGER_OUTPUTS}`),
    ).toHaveLength(1);
    release?.("older tail");
    await first;

    expect(taskRuns().find((run) => run.id === `run-${MAX_EAGER_OUTPUTS}`)?.output).toBe(
      "older tail",
    );
  });
});

describe("removal", () => {
  it("drops one run and clears the lot", () => {
    const a = start({ label: "a" });
    start({ label: "b" });
    removeTaskRun(a);
    expect(taskRuns().map((r) => r.label)).toEqual(["b"]);
    clearTaskHistory();
    expect(taskRuns()).toEqual([]);
  });
});

describe("corrupt storage", () => {
  it("reads as empty rather than throwing", () => {
    localStorage.setItem("canopy.taskHistory", "{not json");
    expect(taskRuns()).toEqual([]);
    expect(() => start()).not.toThrow();
  });

  it("ignores a stored value that isn't a list", () => {
    localStorage.setItem("canopy.taskHistory", '{"runs":[]}');
    expect(taskRuns()).toEqual([]);
  });
});

describe("tidyOutput", () => {
  it("collapses the blank rows a cleared status line leaves behind", () => {
    // The real shape: a CLI paints a line, clears it, and the stripped
    // scrollback keeps the empty rows. Verbatim that filled a 340px box with
    // one word at the top and one at the bottom.
    const raw = "m\n\n\n\n\n\n\n\n\nRan 6 shell commands\n";
    expect(tidyOutput(raw)).toBe("m\n\nRan 6 shell commands");
  });

  it("keeps a single blank line, which is real spacing", () => {
    expect(tidyOutput("one\n\ntwo")).toBe("one\n\ntwo");
    expect(tidyOutput("one\ntwo")).toBe("one\ntwo");
  });

  it("drops trailing whitespace and normalises carriage returns", () => {
    expect(tidyOutput("a   \nb\t\n")).toBe("a\nb");
    expect(tidyOutput("a\r\nb\rc")).toBe("a\nb\nc");
    // Indentation is meaning in a terminal tail; only trailing space goes.
    expect(tidyOutput("  indented\n")).toBe("  indented");
  });

  it("survives output that is nothing but whitespace", () => {
    expect(tidyOutput("\n\n   \n\n")).toBe("");
    expect(tidyOutput("")).toBe("");
  });
});

describe("resolveTaskFile", () => {
  const wt = "/Users/me/code/canopy-wt-pr-177";
  const repo = "/Users/me/code/canopy";

  it("makes a relative path absolute, or the chip opens nothing", () => {
    // The hook records a file relative to the session cwd when it is under it,
    // and absolutely when it is not, so `files` is a mix. Nothing joined the
    // relative half back on — and fs_stat rejects a relative path — so every
    // chip for a file the run edited inside its own project failed, silently.
    expect(resolveTaskFile("src/microTasks.ts", repo)).toBe(
      "/Users/me/code/canopy/src/microTasks.ts",
    );
    // An absolute one is already answerable and must not be mangled.
    expect(resolveTaskFile("/tmp/scratch/notes.md", repo)).toBe(
      "/tmp/scratch/notes.md",
    );
    // No cwd recorded: better to hand back what we have than to invent a root.
    expect(resolveTaskFile("src/a.ts", "")).toBe("src/a.ts");
  });

  it("still maps a relative path out of a throwaway worktree", () => {
    // Both rules at once: join it on, then map the deleted worktree back to
    // the repo that still has the committed file.
    expect(resolveTaskFile("src/git.rs", wt)).toBe(`${repo}/src/git.rs`);
  });

  it("maps a throwaway worktree's path back onto the repo", () => {
    // The brief's last step deletes the worktree, so this path is gone by the
    // time anyone clicks it — but the agent committed and pushed the file, so
    // the same relative path exists in the repo.
    expect(resolveTaskFile(`${wt}/src/app.ts`, wt)).toBe(`${repo}/src/app.ts`);
    expect(resolveTaskFile(`${wt}/a/b/c.rs`, wt)).toBe(`${repo}/a/b/c.rs`);
  });

  it("leaves a real worktree alone — its copy is the one that was worked in", () => {
    const mine = "/Users/me/code/canopy-feature";
    expect(resolveTaskFile(`${mine}/src/app.ts`, mine)).toBe(`${mine}/src/app.ts`);
    expect(resolveTaskFile(`${repo}/src/app.ts`, repo)).toBe(`${repo}/src/app.ts`);
  });

  it("does not rewrite a path that isn't under the worktree", () => {
    // Artifacts are written to the repo's .canopy/ precisely so they survive;
    // rewriting those would point at a directory that never existed.
    expect(resolveTaskFile(`${repo}/.canopy/review.md`, wt)).toBe(
      `${repo}/.canopy/review.md`,
    );
    // A sibling whose name merely starts the same way is not inside it.
    expect(resolveTaskFile(`${wt}-old/src/app.ts`, wt)).toBe(`${wt}-old/src/app.ts`);
  });
});

describe("completedTaskRuns ordering", () => {
  beforeEach(() => localStorage.clear());

  it("orders by when a run finished, not when it started", () => {
    // The store is newest-first by start time, which is a different order as
    // soon as two runs overlap: the long one started first and came back last.
    const slow = recordTaskStart({
      taskId: "pr-review",
      label: "Review",
      agent: "claude",
      cwd: "/repo",
      projectId: "p1",
      brief: "review it",
    });
    const quick = recordTaskStart({
      taskId: "adhoc",
      label: "Quick",
      agent: "claude",
      cwd: "/repo",
      projectId: "p1",
      brief: "quick one",
    });
    recordTaskEnd(quick, { status: "done", endedAt: 1_000 });
    recordTaskEnd(slow, { status: "done", endedAt: 2_000 });

    expect(completedTaskRuns("p1").map((r) => r.label)).toEqual([
      "Review",
      "Quick",
    ]);
  });

  it("falls back to the start time for a run that never recorded an end", () => {
    const a = recordTaskStart({
      taskId: "adhoc",
      label: "Ended",
      agent: "claude",
      cwd: "/repo",
      projectId: "p1",
      brief: "b",
    });
    recordTaskEnd(a, { status: "done", endedAt: 5_000 });
    // Settled without an endedAt of its own.
    const b = recordTaskStart({
      taskId: "adhoc",
      label: "Swept",
      agent: "claude",
      cwd: "/repo",
      projectId: "p1",
      brief: "b",
    });
    updateTaskRun(b, { startedAt: 9_000 } as never);
    sweepStaleRuns();
    const labels = completedTaskRuns("p1").map((r) => r.label);
    expect(labels).toContain("Ended");
    expect(labels).toContain("Swept");
  });
});


describe("researchEntryForFile", () => {
  it("recognises a research artifact and names its entry", () => {
    // These live outside every registered workspace root by design, so the
    // editor's reader cannot open them — the chip has to lead to the entry,
    // which is where the file means anything.
    expect(
      researchEntryForFile(
        "/Users/me/.canopy/research/p-123/0007-index-staleness/research.md",
      ),
    ).toEqual({ projectId: "p-123", id: "0007-index-staleness" });
    expect(
      researchEntryForFile(
        "/Users/me/.canopy/research/p-123/0007-index-staleness/sources/01-x.md",
      ),
    ).toEqual({ projectId: "p-123", id: "0007-index-staleness" });
  });

  it("leaves ordinary files to the editor", () => {
    expect(researchEntryForFile("/Users/me/code/canopy/src/a.ts")).toBeNull();
    // Shaped like the store but not it — a repo that happens to have the word.
    expect(researchEntryForFile("/Users/me/code/research/notes.md")).toBeNull();
    // The store's own root, with no entry in the path.
    expect(researchEntryForFile("/Users/me/.canopy/research/p-123/")).toBeNull();
  });
});

describe("what a run is called on screen", () => {
  it("prefers what the agent named it over what it was launched as", () => {
    const id = start({ label: "Can you please help in setting…", icon: "⚡" });
    updateTaskRun(id, { title: "Task identity, in the harness", agentIcon: "◈" });
    const run = taskRuns()[0];
    expect(runTitle(run)).toBe("Task identity, in the harness");
    expect(runIcon(run)).toBe("◈");
    // The launcher's name is kept, not replaced: "run again" and the search
    // index both want the words the user actually typed.
    expect(run.label).toBe("Can you please help in setting…");
  });

  it("falls back to the launcher's name for a run that never named itself", () => {
    start({ label: "Raise PR", icon: "⇈" });
    const run = taskRuns()[0];
    expect(runTitle(run)).toBe("Raise PR");
    expect(runIcon(run)).toBe("⇈");
  });
});

describe("canResumeRun", () => {
  it("needs a session id — a run that never reported one has nothing to reopen", () => {
    const id = start();
    expect(canResumeRun(taskRuns()[0])).toBe(false);
    updateTaskRun(id, { sessionId: "s-1" });
    expect(canResumeRun(taskRuns()[0])).toBe(true);
  });

  /** `--resume <id>` is resolved inside the CLI's own config dir, keyed by the
   *  directory the conversation ran in. A task that made itself a worktree
   *  deletes it on the way out, so there is nowhere left to resume — offering
   *  it would be a button that lands you in a CLI error. */
  it("refuses a run whose worktree was thrown away", () => {
    const id = start({ ephemeralCwd: true });
    updateTaskRun(id, { sessionId: "s-1" });
    expect(canResumeRun(taskRuns()[0])).toBe(false);
  });
});

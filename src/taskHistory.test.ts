import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTaskHistory,
  completedTaskRuns,
  endAbandonedRun,
  recordTaskEnd,
  recordTaskStart,
  removeTaskRun,
  sweepStaleRuns,
  taskRuns,
  updateTaskRun,
  type TaskRun,
  tidyOutput,
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

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearTaskHistory,
  completedTaskRuns,
  recordTaskEnd,
  recordTaskStart,
  removeTaskRun,
  taskRuns,
  type TaskRun,
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

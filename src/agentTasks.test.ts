import { describe, expect, it } from "vitest";
import {
  completePrompt,
  focusPrompt,
  normalizeTasks,
  summarizeTasks,
  taskHeadline,
  withRequests,
} from "./agentTasks";

describe("normalizeTasks", () => {
  it("keeps valid steps, drops blanks, and treats unknown status as pending", () => {
    expect(
      normalizeTasks([
        { text: " Parse ", status: "completed" },
        { text: "", status: "pending" },
        { text: "Wire", status: "running" },
        { text: "Odd", status: "weird" },
        null,
        "x",
      ]),
    ).toEqual([
      { text: "Parse", status: "completed" },
      { text: "Wire", status: "running" },
      { text: "Odd", status: "pending" },
    ]);
  });
  it("is empty for anything that is not a list", () => {
    expect(normalizeTasks(undefined)).toEqual([]);
    expect(normalizeTasks({})).toEqual([]);
  });
  it("is bounded", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      text: `t${i}`,
      status: "pending",
    }));
    expect(normalizeTasks(many)).toHaveLength(50);
  });
});

describe("summarizeTasks", () => {
  const tasks = normalizeTasks([
    { text: "a", status: "completed" },
    { text: "b", status: "running" },
    { text: "c", status: "pending" },
  ]);
  it("counts and finds the current step", () => {
    const s = summarizeTasks(tasks);
    expect(s).toMatchObject({ total: 3, done: 1, running: 1, pending: 1 });
    expect(s.current?.text).toBe("b");
    expect(taskHeadline(s)).toBe("1 done · 1 in progress · 1 not started");
  });
  it("falls back to the first pending step when nothing is running", () => {
    const s = summarizeTasks(
      normalizeTasks([
        { text: "a", status: "completed" },
        { text: "b", status: "pending" },
      ]),
    );
    expect(s.current?.text).toBe("b");
  });
  it("reads as done when everything is", () => {
    const s = summarizeTasks(
      normalizeTasks([{ text: "a", status: "completed" }]),
    );
    expect(s.current).toBeNull();
    expect(taskHeadline(s)).toBe("All 1 done");
    expect(taskHeadline(summarizeTasks([]))).toBe("No tasks");
  });
  it("builds prompts that name the task", () => {
    expect(focusPrompt(tasks[1])).toContain("b");
    expect(completePrompt(tasks[2])).toContain("c");
  });
});

describe("task text is safe to type into a terminal", () => {
  it("turns control characters and newlines into spaces", () => {
    expect(
      normalizeTasks([
        { text: "fix it\n\u001b[31mnow\u0007", status: "pending" },
      ])[0].text,
    ).toBe("fix it [31mnow");
  });
  it("drops a task that is only control characters", () => {
    expect(normalizeTasks([{ text: "\n\t\u001b", status: "pending" }])).toEqual(
      [],
    );
  });
});

describe("withRequests", () => {
  it("adds only the requests the agent did not list", () => {
    const agent = [
      { text: "Fix the login redirect", status: "running" as const },
    ];
    const out = withRequests(agent, [
      { title: "Fix login redirect", status: "open" },
      { title: "Rename settings page", status: "open" },
      { title: "Add dark mode", status: "done" },
    ]);
    expect(out.map((t) => t.text)).toEqual([
      "Fix the login redirect",
      "Rename settings page",
      "Add dark mode",
    ]);
    expect(out[1]).toMatchObject({ fromUser: true, status: "pending" });
    expect(out[2]).toMatchObject({ fromUser: true, status: "completed" });
  });
});

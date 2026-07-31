import { describe, expect, it } from "vitest";
import { lastStepFor, parseAgentEvent } from "./notifications";
import {
  elapsedLabel,
  findRun,
  patchRun,
  runNote,
  withRun,
  withoutRun,
  type MicroRun,
} from "./microRuns";

const run = (over: Partial<MicroRun> = {}): MicroRun => ({
  ptyId: 7,
  runId: "r1",
  taskId: "review-pr",
  label: "Review PR",
  cwd: "/repo",
  agent: "claude",
  startedAt: 1_000,
  ...over,
});

describe("the running-task list", () => {
  it("keeps one row per terminal", () => {
    // Pty ids are recycled, and two rows on one pty would both try to reap it.
    const runs = withRun(withRun([], run()), run({ label: "Fix CI" }));
    expect(runs).toHaveLength(1);
    expect(runs[0].label).toBe("Fix CI");
  });

  it("finds, patches and drops by pty id", () => {
    const runs = withRun(
      withRun([], run()),
      run({ ptyId: 8, label: "Raise PR" }),
    );
    expect(findRun(runs, 8)?.label).toBe("Raise PR");
    expect(findRun(runs, 99)).toBeUndefined();
    expect(findRun(runs, null)).toBeUndefined();
    expect(findRun(patchRun(runs, 7, { blocked: true }), 7)?.blocked).toBe(
      true,
    );
    expect(
      findRun(patchRun(runs, 7, { blocked: true }), 8)?.blocked,
    ).toBeUndefined();
    expect(withoutRun(runs, 7).map((r) => r.ptyId)).toEqual([8]);
  });
});

describe("elapsedLabel", () => {
  it("stays in the largest unit that is still true", () => {
    expect(elapsedLabel(0)).toBe("0s");
    expect(elapsedLabel(45_000)).toBe("45s");
    expect(elapsedLabel(90_000)).toBe("2m");
    expect(elapsedLabel(3 * 3600_000 + 240_000)).toBe("3h 4m");
    // A clock that ticked backwards must not print a negative age.
    expect(elapsedLabel(-5_000)).toBe("0s");
  });
});

// Lives in notifications.ts with the rest of the hook-stream readers, but it
// exists for these rows: it is the only live progress a task with no tab has.
describe("lastStepFor", () => {
  const ev = (o: Record<string, unknown>, ts: number) => ({
    ts,
    data: parseAgentEvent(JSON.stringify(o)),
  });

  it("takes the newest finished tool from that terminal", () => {
    const events = [
      ev(
        { canopy_pty: 7, hook_event_name: "PostToolUse", tool_name: "Read" },
        1,
      ),
      ev(
        { canopy_pty: 8, hook_event_name: "PostToolUse", tool_name: "Edit" },
        2,
      ),
      ev(
        { canopy_pty: 7, hook_event_name: "PostToolUse", tool_name: "Bash" },
        3,
      ),
      ev({ canopy_pty: 7, hook_event_name: "Stop" }, 4),
    ];
    expect(lastStepFor(events, 7)).toBe("Bash");
    expect(lastStepFor(events, 8)).toBe("Edit");
    expect(lastStepFor(events, 9)).toBeUndefined();
  });

  it("ignores unnamed tools and unparseable lines", () => {
    const events = [
      ev(
        { canopy_pty: 7, hook_event_name: "PostToolUse", tool_name: "Bash" },
        1,
      ),
      { ts: 2, data: parseAgentEvent("{not json") },
      ev({ canopy_pty: 7, hook_event_name: "PostToolUse", tool_name: "" }, 3),
    ];
    expect(lastStepFor(events, 7)).toBe("Bash");
  });
});

describe("runNote", () => {
  const now = 1_000 + 120_000;

  it("puts needing the user above everything else", () => {
    // Both spellings of blocked: the tool said so, or the hook state did.
    expect(runNote(run({ blocked: true }), "working", "Bash", now)).toBe(
      "Needs you · 2m",
    );
    expect(runNote(run(), "waiting", "Bash", now)).toBe("Needs you · 2m");
  });

  it("names the last tool when a hook reported one", () => {
    expect(runNote(run(), "working", "Bash", now)).toBe("Bash · 2m");
  });

  it("falls back to the lifecycle state", () => {
    expect(runNote(run(), "working", undefined, now)).toBe("Working · 2m");
    expect(runNote(run(), "idle", undefined, now)).toBe("Started 2m ago");
    expect(runNote(run(), "ended", "Bash", now)).toBe("Wrapping up · 2m");
  });
});

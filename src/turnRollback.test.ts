import { beforeEach, describe, expect, it, vi } from "vitest";

const turnSnapshot = vi.fn();
const turnNativeCheckpoint = vi.fn();
vi.mock("./ipc", () => ({
  turnSnapshot: (o: unknown) => turnSnapshot(o),
  turnNativeCheckpoint: (s: string, u: string) => turnNativeCheckpoint(s, u),
}));

import type { TurnList, TurnPoint, TurnSnapRef } from "./ipc";
import {
  LATE_CAVEAT,
  PREV_END_CAVEAT,
  boundaryOf,
  buildTimeline,
  observeTurnEvents,
  recordNativeCheckpoint,
  timelineWords,
} from "./turnRollback";
import { updateSettings } from "./settings";
import { StructuredEventParser } from "./structuredEvents";
import { withSessionEnv } from "./projectRunner";
import { CLAUDE_RUNNER, type StructuredRunnerLaunch } from "./structuredRunners";

const snap = (ref: string, ts = 1): TurnSnapRef => ({ ref, commit: "c", tree: "t", ts_ms: ts });
const S = (n: number) => snap(`refs/canopy/turns/s/${n}`, n * 1000);
const E = (n: number) => snap(`refs/canopy/turn-ends/s/${n}`, n * 1000 + 500);
const turn = (n: number, p: Partial<TurnPoint> = {}): TurnPoint => ({
  n,
  start: S(n),
  end: E(n),
  prompt: `prompt ${n}`,
  late: false,
  native_uuid: null,
  ...p,
});
const list = (turns: TurnPoint[]): TurnList => ({
  git: true,
  root: "/r",
  shared: false,
  peers: [],
  turns,
  restores: [],
});

describe("buildTimeline", () => {
  it("undoes to the turn's start and goes back to its end", () => {
    const [t1, t2] = buildTimeline(list([turn(2), turn(1)]));
    expect(t1.n).toBe(1);
    expect(t1.undo).toEqual({ target: S(1).ref, nativeUuid: null, caveat: null });
    expect(t1.backToHere?.target).toBe(E(1).ref);
    expect(t2.undo?.target).toBe(S(2).ref);
    expect(t1.running || t2.running).toBe(false);
  });

  it("prefers the previous turn's end when this turn's start was taken late", () => {
    const [, t2] = buildTimeline(list([turn(1), turn(2, { late: true })]));
    expect(t2.undo).toEqual({ target: E(1).ref, nativeUuid: null, caveat: PREV_END_CAVEAT });
  });

  it("falls back to a late start with a caveat, unless Claude's rewind covers it", () => {
    const [t1] = buildTimeline(list([turn(1, { late: true })]));
    expect(t1.undo).toEqual({ target: S(1).ref, nativeUuid: null, caveat: LATE_CAVEAT });
    const [n1] = buildTimeline(list([turn(1, { late: true, native_uuid: "u1" })]));
    expect(n1.undo).toEqual({ target: S(1).ref, nativeUuid: "u1", caveat: null });
  });

  it("pairs native checkpoints: undo uses this turn's, back-to-here the next one's", () => {
    const [t1, t2] = buildTimeline(
      list([turn(1, { native_uuid: "u1" }), turn(2, { native_uuid: "u2" })]),
    );
    expect(t1.undo?.nativeUuid).toBe("u1");
    expect(t1.backToHere?.nativeUuid).toBe("u2");
    // The newest turn's end is "now" in Claude's terms: no checkpoint for it.
    expect(t2.backToHere?.nativeUuid).toBeNull();
  });

  it("marks the newest open turn running and uses the next start when an end is missing", () => {
    const [t1, t2] = buildTimeline(list([turn(1, { end: null }), turn(2, { end: null })]));
    expect(t1.running).toBe(false);
    expect(t1.backToHere?.target).toBe(S(2).ref);
    expect(t2.running).toBe(true);
    expect(t2.backToHere).toBeNull();
  });

  it("offers back-to-here but no undo for an end-only turn", () => {
    const [t1] = buildTimeline(list([turn(1, { start: null })]));
    expect(t1.undo).toBeNull();
    expect(t1.backToHere?.target).toBe(E(1).ref);
  });

  it("speaks plainly in the Build lens", () => {
    expect(timelineWords(true).title).toBe("Go back to when it worked");
    expect(timelineWords(false).undo).toBe("Undo this turn");
    expect(timelineWords(false).back).toBe("Back to here");
  });
});

describe("snapshot triggers", () => {
  beforeEach(() => {
    turnSnapshot.mockReset().mockResolvedValue({ taken: true, ref: "r", n: 1, late: false, note: null });
    turnNativeCheckpoint.mockReset().mockResolvedValue(undefined);
    updateSettings({ turnRollback: true });
  });

  const ev = (event: string, agent = "") => ({
    sessionId: "sess",
    cwd: "/repo",
    pty: null,
    runId: null,
    attemptId: null,
    event,
    tool: "",
    agent,
    prompt: event === "UserPromptSubmit" ? "fix it" : undefined,
  });

  it("maps Claude's UserPromptSubmit and Stop, nothing else, no other CLI", () => {
    expect(boundaryOf(ev("UserPromptSubmit"))).toBe("start");
    expect(boundaryOf(ev("Stop", "claude"))).toBe("end");
    expect(boundaryOf(ev("StopFailure"))).toBeNull();
    expect(boundaryOf(ev("SubagentStop"))).toBeNull();
    expect(boundaryOf(ev("PostToolUse"))).toBeNull();
    expect(boundaryOf(ev("Stop", "codex"))).toBeNull();
  });

  it("asks Rust for start then end, in order, with the prompt", async () => {
    observeTurnEvents([ev("UserPromptSubmit"), ev("PostToolUse"), null, ev("Stop")], 42);
    await vi.waitFor(() => expect(turnSnapshot).toHaveBeenCalledTimes(2));
    expect(turnSnapshot.mock.calls[0][0]).toEqual({
      cwd: "/repo",
      sessionId: "sess",
      kind: "start",
      prompt: "fix it",
      observedMs: 42,
    });
    expect(turnSnapshot.mock.calls[1][0]).toMatchObject({ kind: "end", prompt: undefined });
  });

  it("takes nothing when the setting is off", async () => {
    updateSettings({ turnRollback: false });
    observeTurnEvents([ev("UserPromptSubmit")]);
    recordNativeCheckpoint("sess", "u");
    await Promise.resolve();
    expect(turnSnapshot).not.toHaveBeenCalled();
    expect(turnNativeCheckpoint).not.toHaveBeenCalled();
  });
});

describe("Claude native checkpoint plumbing", () => {
  it("reports the replayed prompt's uuid, not tool results or live lines", () => {
    const seen: string[] = [];
    const p = new StructuredEventParser({ emit: () => {} }, { onCheckpoint: (u) => seen.push(u) });
    // Shapes captured from claude 2.1.310 stream-json with --replay-user-messages.
    p.handleLine(JSON.stringify({ type: "user", isReplay: true, uuid: "u-prompt", message: { content: [{ type: "text", text: "hi" }] } }));
    p.handleLine(JSON.stringify({ type: "user", uuid: "u-tool", message: { content: [{ type: "tool_result", content: "ok" }] } }));
    p.handleLine(JSON.stringify({ type: "user", uuid: "u-live", message: { content: [{ type: "text", text: "x" }] } }));
    expect(seen).toEqual(["u-prompt"]);
  });

  const launch: StructuredRunnerLaunch = {
    bin: "claude",
    policy: {
      systemPromptAppend: "",
      permissionMode: "",
      disallowedTools: [],
      model: "",
      sessionId: "sid",
      authority: "read-only",
    },
  };

  it("launches with replay, an explicit permission mode and file checkpointing", () => {
    for (const args of [CLAUDE_RUNNER.args(launch), CLAUDE_RUNNER.resumeArgs(launch)]) {
      expect(args).toContain("--replay-user-messages");
      const i = args.indexOf("--permission-mode");
      expect(args[i + 1]).toBe("manual");
    }
    const plan = CLAUDE_RUNNER.args({ ...launch, policy: { ...launch.policy, permissionMode: "plan" } });
    expect(plan[plan.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(withSessionEnv([["A", "1"]], CLAUDE_RUNNER.sessionEnv)).toEqual([
      ["CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "true"],
      ["A", "1"],
    ]);
    // A caller's explicit value wins.
    expect(
      withSessionEnv([["CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "false"]], CLAUDE_RUNNER.sessionEnv),
    ).toEqual([["CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "false"]]);
  });
});

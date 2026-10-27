import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./ipc", () => ({ ledgerRoot: vi.fn(), agentEdits: vi.fn() }));

import type { AgentEventData } from "../shared/notifications";
import {
  filesInWindow,
  observeAgentPtyExit,
  observeAgentTurns,
  onAgentSessionEnd,
  watchAgentSessionExits,
  onAgentTurnEnd,
  onAgentTurnStart,
  resetAgentTurnsForTests,
  setAgentTurnDepsForTests,
  type AgentTurnEnd,
  type AgentTurnStart,
  type AgentSessionEnd,
} from "./agentTurns";

const ev = (event: string, over: Partial<AgentEventData> = {}): AgentEventData => ({
  sessionId: "s1",
  cwd: "/repo/wt",
  pty: 7,
  event,
  tool: "",
  agent: "",
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

let edits: { ts: number; path: string }[] = [];
const editsCalls: string[] = [];

beforeEach(() => {
  resetAgentTurnsForTests();
  edits = [];
  editsCalls.length = 0;
  setAgentTurnDepsForTests({
    root: async (cwd) => (cwd.startsWith("/repo") ? "/repo" : cwd),
    edits: async (cwd) => {
      editsCalls.push(cwd);
      return edits;
    },
  });
});

describe("agent turns", () => {
  it("announces a start and an end with the files the turn touched", async () => {
    const starts: AgentTurnStart[] = [];
    const ends: AgentTurnEnd[] = [];
    onAgentTurnStart((t) => starts.push(t));
    onAgentTurnEnd((t) => ends.push(t));

    observeAgentTurns([ev("UserPromptSubmit", { prompt: "fix it" })], 100_000);
    edits = [
      { ts: 50, path: "old.ts" }, // an earlier turn
      { ts: 101, path: "a.ts" },
      { ts: 105, path: "a.ts" },
      { ts: 110, path: "b.ts" },
    ];
    observeAgentTurns([ev("PreToolUse"), ev("Stop", { pty: null })], 112_000);
    await flush();

    expect(starts).toEqual([
      {
        turnId: "s1:100000",
        ptyId: 7,
        sessionId: "s1",
        cli: "claude",
        cwd: "/repo/wt",
        root: "/repo",
        prompt: "fix it",
        startedAt: 100_000,
      },
    ]);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      turnId: "s1:100000",
      // The end's event lost the pty stamp; the start's is kept.
      ptyId: 7,
      root: "/repo",
      prompt: "fix it",
      startedAt: 100_000,
      endedAt: 112_000,
      filesTouched: ["a.ts", "b.ts"],
    });
    expect(ends[0].partial).toBeUndefined();
    // The journal is read for the agent's own checkout, not the main one.
    expect(editsCalls).toEqual(["/repo/wt"]);
  });

  it("marks an end whose start was never seen as partial", async () => {
    const ends: AgentTurnEnd[] = [];
    onAgentTurnEnd((t) => ends.push(t));
    observeAgentTurns([ev("Stop", { agent: "other-cli", sessionId: "s2" })], 5_000);
    await flush();
    expect(ends[0]).toMatchObject({ partial: true, startedAt: 5_000, cli: "other-cli", turnId: "s2:5000" });
    // The next unobserved start falls back to the previous end.
    observeAgentTurns([ev("Stop", { sessionId: "s2" })], 9_000);
    await flush();
    expect(ends[1]).toMatchObject({ partial: true, startedAt: 5_000, endedAt: 9_000 });
  });

  it("ignores events without a session or cwd, and unsubscribes", async () => {
    const cb = vi.fn();
    const off = onAgentTurnEnd(cb);
    observeAgentTurns([null, ev("Stop", { sessionId: "" }), ev("Stop", { cwd: "" })]);
    await flush();
    expect(cb).not.toHaveBeenCalled();
    off();
    observeAgentTurns([ev("Stop")]);
    await flush();
    expect(cb).not.toHaveBeenCalled();
  });

  it("keeps a short turn's start ahead of its end", async () => {
    const order: string[] = [];
    let release!: () => void;
    setAgentTurnDepsForTests({
      root: () => new Promise((r) => (release = () => r("/slow"))),
      edits: async () => [],
    });
    onAgentTurnStart(() => order.push("start"));
    onAgentTurnEnd(() => order.push("end"));
    observeAgentTurns([ev("UserPromptSubmit", { cwd: "/slow" }), ev("Stop", { cwd: "/slow" })], 1);
    await flush();
    release();
    await flush();
    await flush();
    expect(order).toEqual(["start", "end"]);
  });

  it("announces a session's end once, from SessionEnd or its terminal exiting", async () => {
    const ends: AgentSessionEnd[] = [];
    onAgentSessionEnd((e) => ends.push(e));
    observeAgentTurns([ev("UserPromptSubmit", { agent: "cli-a" })], 1_000);
    observeAgentTurns([ev("SessionEnd", { agent: "cli-a" })], 2_000);
    await flush();
    await flush();
    expect(ends).toEqual([
      { sessionId: "s1", ptyId: 7, cli: "cli-a", cwd: "/repo/wt", root: "/repo", endedAt: 2_000, via: "session-end" },
    ]);
    // The terminal closing afterwards is the same end, not a second one.
    observeAgentPtyExit(7, 3_000);
    await flush();
    expect(ends).toHaveLength(1);
  });

  it("treats a terminal exiting as the end of the session it ran", async () => {
    const ends: AgentSessionEnd[] = [];
    onAgentSessionEnd((e) => ends.push(e));
    let fire: ((e: { id: number }) => void) | null = null;
    const stop = watchAgentSessionExits(async (cb) => {
      fire = cb;
      return () => {};
    });
    await flush();
    observeAgentTurns([ev("UserPromptSubmit", { sessionId: "s9", pty: 12 })], 1_000);
    fire!({ id: 99 });
    fire!({ id: 12 });
    await flush();
    await flush();
    expect(ends.map((e) => [e.sessionId, e.via])).toEqual([["s9", "process-exit"]]);
    stop();
  });

  it("carries the plan id the session was launched with, and announces the session's end after its last turn", async () => {
    const starts: AgentTurnStart[] = [];
    const order: string[] = [];
    onAgentTurnStart((t) => starts.push(t));
    onAgentTurnEnd((t) => order.push(`end:${t.planId}`));
    onAgentSessionEnd((e) => order.push(`session:${e.planId}`));
    observeAgentTurns(
      [ev("UserPromptSubmit", { planId: "pl-a-b", prompt: "Read /tmp/brief.md" }), ev("Stop", { planId: "pl-a-b" }), ev("SessionEnd", { planId: "pl-a-b" })],
      1_000,
    );
    await flush();
    await flush();
    expect(starts[0].planId).toBe("pl-a-b");
    expect(order).toEqual(["end:pl-a-b", "session:pl-a-b"]);
  });

  it("windows journal seconds against turn milliseconds", () => {
    expect(filesInWindow([{ ts: 9, path: "a" }, { ts: 10, path: "b" }, { ts: 23, path: "c" }], 10_500, 20_200)).toEqual(["a", "b"]);
  });
});

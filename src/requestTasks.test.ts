import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRequestTasks,
  enqueueForTests,
  handlePrompt,
  handleReply,
  isNotification,
  requestTasksFor,
  setRequestTaskDepsForTests,
} from "./requestTasks";
import type { Answer, Decision } from "./systemOne";

const choice = (c: string, confidence = 0.9): Answer => ({ type: "choice", choice: c, confidence, probabilities: {} });
const no: Answer = { type: "noul", noul: 0.02 };
const ok = (answers: Record<string, Answer>): Decision => ({ ok: true, answers, latencyMs: 1 });
const prompt = (kind: string, task = "new_request") => ok({ kind: choice(kind), task: choice(task), several: no });
const brain = (value: unknown) =>
  vi.fn(async () => ({ ok: true as const, text: "", value, costUsd: 0, inputTokens: 1, outputTokens: 1, durationMs: 1, model: null }));
const S = "s1";

let decideImpl: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clearRequestTasks();
  decideImpl = vi.fn();
});
afterEach(() => setRequestTaskDepsForTests(null));
const stub = (askBrain: ReturnType<typeof vi.fn>, enabled = true) =>
  setRequestTaskDepsForTests({ decide: decideImpl as never, askBrain: askBrain as never, enabled: () => enabled });

describe("a prompt", () => {
  it("a question or chatter stops at System One: no System 2 call", async () => {
    const b = brain({ tasks: ["x"] });
    stub(b);
    for (const k of ["question", "chatter"]) {
      decideImpl.mockResolvedValue(prompt(k));
      await handlePrompt(S, "why is it slow?");
    }
    expect(b).not.toHaveBeenCalled();
    expect(requestTasksFor(S)).toEqual([]);
  });

  it("a new request is titled by System 2, never stored as raw text", async () => {
    stub(brain({ tasks: ["Add task list to card"] }));
    decideImpl.mockResolvedValue(prompt("request"));
    await handlePrompt(S, "can you add a task list to the card please, thanks a lot");
    expect(requestTasksFor(S).map((t) => [t.title, t.status])).toEqual([["Add task list to card", "open"]]);
  });

  it("a bare approval still goes to System 2, which sees the last reply", async () => {
    const b = brain({ tasks: ["Wire System One"] });
    stub(b);
    await handleReply(S, "I can wire System One to the task list. Want me to?");
    decideImpl.mockResolvedValue(prompt("approval"));
    await handlePrompt(S, "wire it");
    expect(b).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(b.mock.calls[0])).toContain("I can wire System One");
    expect(JSON.stringify(b.mock.calls[0])).toContain("background");
    expect(requestTasksFor(S).map((t) => t.title)).toEqual(["Wire System One"]);
  });

  it("a follow-up of an open task adds nothing and asks no one", async () => {
    stub(brain({ tasks: ["A"] }));
    decideImpl.mockResolvedValue(prompt("request"));
    await handlePrompt(S, "do A");
    const b = brain({ tasks: ["dup"] });
    stub(b);
    decideImpl.mockResolvedValue(prompt("request", "task_0"));
    await handlePrompt(S, "still A please");
    expect(b).not.toHaveBeenCalled();
    expect(requestTasksFor(S)).toHaveLength(1);
  });

  it("System 2 saying nothing is new, or a duplicate title, adds nothing", async () => {
    decideImpl.mockResolvedValue(prompt("request"));
    stub(brain({ tasks: [] }));
    await handlePrompt(S, "ok");
    stub(brain({ tasks: ["Fix card", "fix card"] }));
    await handlePrompt(S, "fix card");
    expect(requestTasksFor(S).map((t) => t.title)).toEqual(["Fix card"]);
  });

  it("no System One, off, over budget or no brain: nothing is written", async () => {
    decideImpl.mockResolvedValue({ ok: false, reason: "unavailable" });
    const b = brain({ tasks: ["x"] });
    stub(b);
    await handlePrompt(S, "do x");
    expect(b).not.toHaveBeenCalled();
    decideImpl.mockResolvedValue(prompt("request"));
    stub(b, false);
    await handlePrompt(S, "do x");
    expect(decideImpl).toHaveBeenCalledTimes(1);
    stub(vi.fn(async () => ({ ok: false as const, reason: "over-budget", message: "" })));
    await handlePrompt(S, "do x");
    expect(requestTasksFor(S)).toEqual([]);
  });
});

describe("a reply", () => {
  const seed = async () => {
    stub(brain({ tasks: ["Fix card", "Ship build"] }));
    decideImpl.mockResolvedValue(prompt("request"));
    await handlePrompt(S, "fix the card and ship");
  };
  const done = (p: Record<string, number>) =>
    ok({
      raised_pr: no,
      made_asset: no,
      blocked: no,
      ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { type: "noul", noul: v } as Answer])),
    });

  it("marks a candidate done only when System 2 confirms it", async () => {
    await seed();
    decideImpl.mockResolvedValue(done({ done_0: 0.9, done_1: 0.05 }));
    stub(brain({ done: [0] }));
    await handleReply(S, "Fixed the card.");
    expect(requestTasksFor(S).map((t) => t.status)).toEqual(["done", "open"]);
  });

  it("a candidate System 2 rejects stays open; no candidates means no System 2 call", async () => {
    await seed();
    decideImpl.mockResolvedValue(done({ done_0: 0.3, done_1: 0.01 }));
    stub(brain({ done: [] }));
    await handleReply(S, "Started on the card.");
    expect(requestTasksFor(S).every((t) => t.status === "open")).toBe(true);
    const b = brain({ done: [0] });
    stub(b);
    decideImpl.mockResolvedValue(done({ done_0: 0.01, done_1: 0.01 }));
    await handleReply(S, "Unrelated.");
    expect(b).not.toHaveBeenCalled();
  });

  it("System 2 cannot finish a task that was not a candidate", async () => {
    await seed();
    decideImpl.mockResolvedValue(done({ done_0: 0.9, done_1: 0.01 }));
    stub(brain({ done: [1] }));
    await handleReply(S, "x");
    expect(requestTasksFor(S).every((t) => t.status === "open")).toBe(true);
  });

  it("long replies keep their tail, where the summary is", async () => {
    await seed();
    stub(brain({ done: [] }));
    decideImpl.mockResolvedValue(done({ done_0: 0.01, done_1: 0.01 }));
    await handleReply(S, "a".repeat(50_000) + " THE END");
    const sent = String(decideImpl.mock.calls.at(-1)![0]);
    expect(sent).toContain("THE END");
    expect(sent.length).toBeLessThan(7000);
  });
});

describe("ordering", () => {
  it("a session's jobs run one at a time, in order", async () => {
    const order: string[] = [];
    const slow = (n: string, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(n);
    };
    await Promise.all([enqueueForTests(S, slow("first", 20)), enqueueForTests(S, slow("second", 1))]);
    expect(order).toEqual(["first", "second"]);
  });
});


describe("where a job stopped (content-free trace)", () => {
  const traced: string[] = [];
  const stubTrace = (askBrain: ReturnType<typeof vi.fn>) =>
    setRequestTaskDepsForTests({
      decide: decideImpl as never,
      askBrain: askBrain as never,
      enabled: () => true,
      trace: (s: string) => traced.push(s),
    });
  beforeEach(() => {
    traced.length = 0;
  });
  const done = (scores: Record<string, number>) =>
    ok(Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, { type: "noul", noul: v } as Answer])));
  const seed = async () => {
    stubTrace(brain({ tasks: ["A"] }));
    decideImpl.mockResolvedValue(prompt("request"));
    await handlePrompt(S, "do A");
  };

  it("a background task's report is never treated as the person's request", async () => {
    const b = brain({ tasks: ["x"] });
    stubTrace(b);
    await handlePrompt(S, "<task-notification> <task-id>b1</task-id> done </task-notification>");
    expect(decideImpl).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(traced).toEqual(["prompt-notification-skipped"]);
    expect(isNotification("please fix <task-notification> handling")).toBe(false);
  });

  it("names each step a reply check can stop at", async () => {
    stubTrace(brain({ done: [] }));
    await handleReply(S, "nothing open yet");
    expect(traced.at(-1)).toBe("reply-no-open");

    await seed();
    decideImpl.mockResolvedValue({ ok: false, reason: "timeout" });
    await handleReply(S, "x");
    expect(traced.at(-1)).toBe("reply-s1-timeout");

    decideImpl.mockResolvedValue(done({ done_0: 0.01 }));
    await handleReply(S, "x");
    expect(traced.at(-1)).toBe("reply-s1-none");

    decideImpl.mockResolvedValue(done({ done_0: 0.9 }));
    stubTrace(vi.fn(async () => ({ ok: false as const, reason: "timeout", message: "" })));
    await handleReply(S, "x");
    expect(traced.at(-1)).toBe("reply-s2-failed");

    stubTrace(brain({ done: [] }));
    await handleReply(S, "x");
    expect(traced.at(-1)).toBe("reply-s2-none");

    stubTrace(brain({ done: [0] }));
    await handleReply(S, "A is done.");
    expect(traced.at(-1)).toBe("reply-marked");
    expect(requestTasksFor(S)[0].status).toBe("done");
  });

  it("every code it can send is one the backend keeps (lib.rs REQUEST_STAGES)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const lib = readFileSync(join(process.cwd(), "src-tauri/src/lib.rs"), "utf8");
    const codes = [
      "prompt-notification-skipped",
      "reply-no-open",
      ...["unavailable", "timeout", "http", "invalid"].map((r) => `reply-s1-${r}`),
      "reply-s1-none",
      "reply-s2-failed",
      "reply-s2-none",
      "reply-marked",
    ];
    for (const c of codes) expect(lib).toContain(`"requests-stage:${c}"`);
  });
});

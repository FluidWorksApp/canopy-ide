import { beforeEach, describe, expect, it } from "vitest";
import {
  buildRequest,
  confident,
  decide,
  parseAnswers,
  resetBackoff,
  promptQuestions,
  readPrompt,
  readReply,
  replyQuestions,
  yes,
  type Answer,
} from "./systemOne";

const reply = (body: unknown, ok = true) =>
  (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

describe("System One client", () => {
  beforeEach(resetBackoff);

  it("stops trying a server that is not there, for a while", async () => {
    let calls = 0;
    const down = (async () => {
      calls++;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const q = replyQuestions([]);
    await decide("x", q, { fetchImpl: down });
    await decide("x", q, { fetchImpl: down });
    await decide("x", q, { fetchImpl: down });
    expect(calls).toBe(1);
  });

  it("builds the request the wire expects", () => {
    const q = promptQuestions(["Fix the card"]);
    const req = buildRequest("hello there", q);
    expect(req.state).toBe("hello there");
    expect(req.model).toBe("kev-latest");
    expect(q.kind.type).toBe("choice");
    expect(q.several.type).toBe("noul");
    expect(Object.keys((q.task as { criteria: object }).criteria)).toEqual(["new_request", "task_0"]);
  });

  it("reads the answers the server returns, and only those", () => {
    const q = replyQuestions(["a", "b", "c"]);
    const body = {
      answers: {
        raised_pr: { type: "noul", noul: 0.93 },
        made_asset: { type: "noul", noul: 0.1 },
        blocked: { type: "noul", noul: 0.5 },
        done_0: { type: "noul", noul: 0.04 },
        done_1: { type: "noul", noul: 0.31 },
        done_2: { type: "noul", noul: 0.9 },
      },
    };
    const got = parseAnswers(body, q)!;
    expect(readReply(got)).toEqual({ raisedPr: true, madeAsset: false, blocked: null, doneCandidates: [1, 2] });
  });

  it("asks about every open task, each on its own", () => {
    expect(Object.keys(replyQuestions(["x", "y"]))).toEqual(["raised_pr", "made_asset", "blocked", "done_0", "done_1"]);
    expect(Object.keys(replyQuestions(Array(30).fill("t"))).filter((k) => k.startsWith("done_"))).toHaveLength(20);
  });

  it("refuses a reply that is wrong in any part", () => {
    const q = replyQuestions([]);
    expect(parseAnswers({}, q)).toBeNull();
    expect(parseAnswers({ answers: { raised_pr: { type: "noul", noul: 2 } } }, q)).toBeNull();
    const bad = {
      answers: {
        raised_pr: { type: "noul", noul: 0.9 },
        made_asset: { type: "noul", noul: 0.9 },
        blocked: { type: "choice", choice: "yes", confidence: 0.9, probabilities: {} },
      },
    };
    expect(parseAnswers(bad, q)).toBeNull();
  });

  it("never throws: a missing, slow or broken server is just no answer", async () => {
    const q = replyQuestions([]);
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(await decide("x", q, { fetchImpl: down })).toEqual({ ok: false, reason: "unavailable" });
    resetBackoff();
    expect(await decide("x", q, { fetchImpl: reply({}, false) })).toEqual({ ok: false, reason: "http" });
    expect(await decide("x", q, { fetchImpl: reply({ nope: 1 }) })).toEqual({ ok: false, reason: "invalid" });
    resetBackoff();
    const slow = ((_: string, init: RequestInit) =>
      new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    expect(await decide("x", q, { fetchImpl: slow, timeoutMs: 20 })).toEqual({ ok: false, reason: "timeout" });
  });

  it("gets answers from a good server", async () => {
    const q = { raised: { type: "noul", instructions: "?" } } as const;
    const d = await decide("x", q, { fetchImpl: reply({ answers: { raised: { type: "noul", noul: 0.9 } } }) });
    expect(d.ok && d.answers.raised).toEqual({ type: "noul", noul: 0.9 });
  });

  it("is only sure when the probability is far from the middle", () => {
    expect(yes({ type: "noul", noul: 0.93 })).toBe(true);
    expect(yes({ type: "noul", noul: 0.05 })).toBe(false);
    expect(yes({ type: "noul", noul: 0.5 })).toBeNull();
    expect(confident({ type: "choice", choice: "a", confidence: 0.3, probabilities: {} })).toBe(false);
  });
});

describe("a message from the person", () => {
  const choice = (c: string, confidence = 0.9): Answer => ({ type: "choice", choice: c, confidence, probabilities: {} });
  const no: Answer = { type: "noul", noul: 0.05 };
  const open = ["Mirror the phone", "Task list on the card"];

  it("a new request becomes a task", () => {
    expect(readPrompt({ kind: choice("request"), task: choice("new_request"), several: no }, open)).toEqual({
      is: "new-task",
      several: false,
    });
  });

  it("a multi-part request is flagged so it can be split", () => {
    const v = readPrompt({ kind: choice("request"), task: choice("new_request"), several: { type: "noul", noul: 0.95 } }, open);
    expect(v).toEqual({ is: "new-task", several: true });
  });

  it("a repeat or follow-up points at the task it is about, instead of adding one", () => {
    expect(readPrompt({ kind: choice("request"), task: choice("task_1"), several: no }, open)).toEqual({
      is: "follow-up",
      taskIndex: 1,
    });
  });

  it("an approval, a question and chatter are not tasks", () => {
    for (const k of ["approval", "question", "chatter"]) {
      expect(readPrompt({ kind: choice(k), task: choice("new_request"), several: no }, open)).toEqual({
        is: "not-a-task",
        kind: k,
      });
    }
  });

  it("an unsure model decides nothing, so the caller can ask the CLI brain", () => {
    expect(readPrompt({ kind: choice("request", 0.3), task: choice("new_request"), several: no }, open)).toEqual({
      is: "unsure",
    });
    expect(readPrompt({ kind: choice("request"), task: choice("task_9"), several: no }, open)).toEqual({ is: "unsure" });
  });
});

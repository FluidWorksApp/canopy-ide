import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerText,
  asksFor,
  asksPrompt,
  clearAsks,
  composeAnswers,
  dismissAsk,
  handlePrompt,
  handleReply,
  markAsksAnswered,
  normalizeAsk,
  openAsksFor,
  replyOf,
  setWaitingDepsForTests,
  togglePick,
  MAX_OPEN_ASKS,
  type Ask,
} from "./waitingOnYou";
import type { Answer, Decision } from "./systemOne";

const noul = (n: number): Answer => ({ type: "noul", noul: n });
const ok = (answers: Record<string, Answer>): Decision => ({ ok: true, answers, latencyMs: 1 });
const brain = (value: unknown) =>
  vi.fn(async (_req: { prompt: string; feature: string; tier: string }) => ({
    ok: true as const,
    text: "",
    value,
    costUsd: 0,
    inputTokens: 1,
    outputTokens: 1,
    durationMs: 1,
    model: null,
  }));
/** A brain that runs the real validator, as askBrain does. */
const validating = (raw: unknown) =>
  vi.fn(async (req: { validate: (v: unknown) => unknown }) => {
    const value = req.validate(raw);
    return value
      ? { ok: true as const, text: "", value, costUsd: 0, inputTokens: 1, outputTokens: 1, durationMs: 1, model: null }
      : { ok: false as const, reason: "invalid" };
  });
const S = "s1";

let decideImpl: ReturnType<typeof vi.fn>;
let traces: string[];
beforeEach(() => {
  clearAsks();
  decideImpl = vi.fn();
  traces = [];
});
afterEach(() => setWaitingDepsForTests(null));
const stub = (askBrain: unknown, enabled = true) =>
  setWaitingDepsForTests({ decide: decideImpl as never, askBrain: askBrain as never, enabled: () => enabled, now: () => 1000, trace: (s) => void traces.push(s) });

const ask = (over: Partial<Ask> = {}): Ask => ({ id: "a", question: "Which database?", type: "single", options: ["Postgres", "SQLite"], freeText: false, status: "open", addedAt: 0, ...over });

describe("a reply", () => {
  it("that asks nothing stops at System One: no System 2 call", async () => {
    const b = validating({ asks: [{ question: "x" }] });
    stub(b);
    decideImpl.mockResolvedValue(ok({ asks: noul(0.03) }));
    await handleReply(S, "Done. All 42 tests pass.");
    expect(b).not.toHaveBeenCalled();
    expect(asksFor(S)).toEqual([]);
    expect(traces).toEqual(["reply-s1-none"]);
  });

  it("that asks is written out by System 2, each question with the kind of answer it takes", async () => {
    const b = validating({
      asks: [
        { question: "Should I delete the old migration files?", type: "yes_no", options: ["yes", "no"], free_text: false },
        { question: "Which database should the service use?", type: "single", options: ["Postgres", "SQLite"], free_text: true },
        { question: "Which platforms should the build target?", type: "multiple", options: ["macOS", "Linux", "Windows"], free_text: false },
        { question: "What should the environment variable be called?", type: "text", options: [], free_text: false },
      ],
      settled: [],
    });
    stub(b);
    decideImpl.mockResolvedValue(ok({ asks: noul(0.8) }));
    await handleReply(S, "Before I go on: delete the old migrations? Postgres or SQLite? Which platforms? What should I call the variable?");
    expect(openAsksFor(S).map((a) => [a.type, a.options, a.freeText])).toEqual([
      ["yes_no", ["Yes", "No"], false],
      ["single", ["Postgres", "SQLite"], true],
      ["multiple", ["macOS", "Linux", "Windows"], false],
      ["text", [], true],
    ]);
    expect(openAsksFor(S)[0]).toMatchObject({ question: "Should I delete the old migration files?", status: "open", addedAt: 1000 });
    expect(b).toHaveBeenCalledTimes(1);
    const sent = b.mock.calls[0][0] as unknown as { prompt: string; feature: string; tier: string };
    expect(sent.feature).toBe("asks");
    expect(sent.tier).toBe("background");
    expect(sent.prompt).toContain("Before I go on");
  });

  it("a faint signal still goes to System 2: a missed question is the costly mistake", async () => {
    const b = validating({ asks: [{ question: "Want me to also update the docs?", type: "yes_no" }], settled: [] });
    stub(b);
    decideImpl.mockResolvedValue(ok({ asks: noul(0.2) }));
    await handleReply(S, "Shipped. Want me to also update the docs?");
    expect(openAsksFor(S).map((a) => a.question)).toEqual(["Want me to also update the docs?"]);
  });

  it("does not list the same question twice, and tells System 2 what is already listed", async () => {
    const b = validating({ asks: [{ question: "Which database should the service use?", type: "single", options: ["Postgres", "SQLite"] }], settled: [] });
    stub(b);
    decideImpl.mockResolvedValue(ok({ asks: noul(0.9), settled_0: noul(0.01) }));
    await handleReply(S, "Postgres or SQLite?");
    const again = validating({ asks: [{ question: "which database should the service use", type: "text" }, { question: "Should the port be configurable?", type: "yes_no" }], settled: [] });
    stub(again);
    await handleReply(S, "Still need to know: Postgres or SQLite? And should the port be configurable?");
    expect(openAsksFor(S).map((a) => a.question)).toEqual(["Which database should the service use?", "Should the port be configurable?"]);
    expect((again.mock.calls[0][0] as unknown as { prompt: string }).prompt).toContain("Already listed (do not repeat these):\n1. Which database should the service use?");
  });

  it("drops a listed question the reply shows is no longer waiting on the person", async () => {
    stub(validating({ asks: [{ question: "Postgres or SQLite?", type: "single", options: ["Postgres", "SQLite"] }, { question: "Rename the module?", type: "yes_no" }], settled: [] }));
    decideImpl.mockResolvedValue(ok({ asks: noul(0.9) }));
    await handleReply(S, "Postgres or SQLite? Rename the module?");
    const b = validating({ asks: [], settled: [1, 7] });
    stub(b);
    // Nothing new is asked, but System One thinks the first question is settled.
    decideImpl.mockResolvedValue(ok({ asks: noul(0.02), settled_0: noul(0.7), settled_1: noul(0.01) }));
    await handleReply(S, "I went with Postgres since the schema needs JSONB.");
    expect(b).toHaveBeenCalledTimes(1);
    expect(asksFor(S).map((a) => [a.question, a.status])).toEqual([
      ["Postgres or SQLite?", "dropped"],
      ["Rename the module?", "open"],
    ]);
  });

  it("writes nothing when System One is off, silent, or System 2 fails", async () => {
    const b = validating({ asks: [{ question: "x?" }], settled: [] });
    stub(b, false);
    await handleReply(S, "Should I?");
    expect(decideImpl).not.toHaveBeenCalled();

    stub(b);
    decideImpl.mockResolvedValue({ ok: false, reason: "unavailable" });
    await handleReply(S, "Should I?");
    expect(b).not.toHaveBeenCalled();

    stub(vi.fn(async () => ({ ok: false, reason: "budget" })));
    decideImpl.mockResolvedValue(ok({ asks: noul(0.9) }));
    await handleReply(S, "Should I?");
    stub(validating({ nonsense: true }));
    await handleReply(S, "Should I?");
    expect(asksFor(S)).toEqual([]);
    expect(traces).toEqual(["reply-s1-unavailable", "reply-s2-failed", "reply-s2-failed"]);
  });

  it("keeps at most a dozen questions open for one session", async () => {
    decideImpl.mockResolvedValue(ok({ asks: noul(0.9) }));
    for (let round = 0; round < 3; round++) {
      stub(validating({ asks: Array.from({ length: 8 }, (_, i) => ({ question: `Question ${round}-${i}?`, type: "yes_no" })), settled: [] }));
      await handleReply(S, "many questions");
    }
    expect(openAsksFor(S)).toHaveLength(MAX_OPEN_ASKS);
  });
});

describe("a message from the person", () => {
  const seed = async () => {
    stub(validating({ asks: [{ question: "Postgres or SQLite?", type: "single", options: ["Postgres", "SQLite"] }, { question: "Rename the module?", type: "yes_no" }], settled: [] }));
    decideImpl.mockResolvedValue(ok({ asks: noul(0.9) }));
    await handleReply(S, "Postgres or SQLite? Rename the module?");
  };

  it("costs nothing while no question is open", async () => {
    const b = brain({ answered: [1] });
    stub(b);
    await handlePrompt(S, "use postgres");
    expect(decideImpl).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("marks answered only what System 2 confirms, and leaves the rest waiting", async () => {
    await seed();
    const b = brain({ answered: [1] });
    stub(b);
    decideImpl.mockResolvedValue(ok({ answered_0: noul(0.9), answered_1: noul(0.03) }));
    await handlePrompt(S, "go with postgres");
    expect(asksFor(S).map((a) => [a.question, a.status])).toEqual([
      ["Postgres or SQLite?", "answered"],
      ["Rename the module?", "open"],
    ]);
    // Only the candidate was put to System 2.
    const sent = (b.mock.calls[0][0] as { prompt: string }).prompt;
    expect(sent).toContain("1. Postgres or SQLite?");
    expect(sent).not.toContain("Rename the module?");
    expect(sent).toContain("go with postgres");
  });

  it("a message about something else answers nothing, without a System 2 call", async () => {
    await seed();
    const b = brain({ answered: [1, 2] });
    stub(b);
    decideImpl.mockResolvedValue(ok({ answered_0: noul(0.02), answered_1: noul(0.05) }));
    await handlePrompt(S, "also the pinned tabs don't survive a restart");
    expect(b).not.toHaveBeenCalled();
    expect(openAsksFor(S)).toHaveLength(2);

    // System One thought so; System 2 did not agree.
    stub(brain({ answered: [] }));
    decideImpl.mockResolvedValue(ok({ answered_0: noul(0.4), answered_1: noul(0.4) }));
    await handlePrompt(S, "hmm");
    expect(openAsksFor(S)).toHaveLength(2);
  });

  it("a background-task report is not the person answering", async () => {
    await seed();
    const b = brain({ answered: [1, 2] });
    stub(b);
    decideImpl.mockReset();
    await handlePrompt(S, "<task-notification><status>completed</status></task-notification>");
    expect(decideImpl).not.toHaveBeenCalled();
    expect(openAsksFor(S)).toHaveLength(2);
  });
});

describe("the list itself", () => {
  it("answering or dismissing on the card needs no model, and the open list is stable between changes", async () => {
    stub(validating({ asks: [{ question: "A?", type: "yes_no" }, { question: "B?", type: "yes_no" }, { question: "C?", type: "yes_no" }], settled: [] }));
    decideImpl.mockResolvedValue(ok({ asks: noul(0.9) }));
    await handleReply(S, "A? B? C?");
    const [a, b2, c] = openAsksFor(S);
    expect(openAsksFor(S)).toBe(openAsksFor(S));
    markAsksAnswered(S, [a.id]);
    dismissAsk(S, b2.id);
    expect(asksFor(S).map((x) => x.status)).toEqual(["answered", "dropped", "open"]);
    expect(openAsksFor(S)).toEqual([c]);
    const before = openAsksFor(S);
    markAsksAnswered(S, [a.id]); // already settled: nothing changes
    expect(openAsksFor(S)).toBe(before);
    expect(openAsksFor("other")).toEqual([]);
    expect(openAsksFor("other")).toBe(openAsksFor("nobody"));
  });
});

describe("what System 2 writes is made safe to draw", () => {
  it("fits the options to the type", () => {
    expect(normalizeAsk({ question: "  Ship   it?  ", type: "yes_no", options: ["sure", "nope"], free_text: true })).toEqual({ question: "Ship it?", type: "yes_no", options: ["Yes", "No"], freeText: true });
    // A choice with nothing to choose from is answered in words.
    expect(normalizeAsk({ question: "Which?", type: "single", options: [] })).toEqual({ question: "Which?", type: "text", options: [], freeText: true });
    // One option is a suggestion, not a choice: it can be picked or replaced.
    expect(normalizeAsk({ question: "Which?", type: "multiple", options: ["main"] })).toEqual({ question: "Which?", type: "single", options: ["main"], freeText: true });
    // No type given: options make it a pick, none makes it words.
    expect(normalizeAsk({ question: "Which?", options: ["a", "b"] })).toMatchObject({ type: "single", freeText: false });
    expect(normalizeAsk({ question: "Name?", type: "essay" })).toMatchObject({ type: "text", freeText: true });
    expect(normalizeAsk({ question: "Pick", type: "multiple", options: ["a", "A", " b ", 3, "", "c"], free_text: true })).toEqual({ question: "Pick", type: "multiple", options: ["a", "b", "c"], freeText: true });
  });

  it("refuses what is not a question, and bounds what is", () => {
    expect(normalizeAsk(null)).toBeNull();
    expect(normalizeAsk("Which?")).toBeNull();
    expect(normalizeAsk({ question: "   " })).toBeNull();
    const long = normalizeAsk({ question: "x".repeat(500), type: "single", options: Array.from({ length: 20 }, (_, i) => `option ${i} ${"y".repeat(200)}`) })!;
    expect(long.question.length).toBe(200);
    expect(long.options).toHaveLength(8);
    expect(long.options.every((o) => o.length <= 80)).toBe(true);
  });

  it("the prompt names every answer type and what is already listed", () => {
    const p = asksPrompt("Postgres or SQLite?", ["Rename the module?"]);
    for (const word of ['"yes_no"', '"single"', '"multiple"', '"text"', '"free_text"', '"settled"']) expect(p).toContain(word);
    expect(p).toContain("1. Rename the module?");
    expect(asksPrompt("x", [])).toContain("Already listed (do not repeat these):\n(none)");
  });
});

describe("answering", () => {
  it("picks one for a single choice and yes/no, any number for a multiple choice", () => {
    const single = ask();
    let d = togglePick(single, { picked: [], text: "" }, "Postgres");
    d = togglePick(single, d, "SQLite");
    expect(d.picked).toEqual(["SQLite"]);
    expect(togglePick(single, d, "SQLite").picked).toEqual([]);

    const multi = ask({ type: "multiple", options: ["macOS", "Linux", "Windows"] });
    let m = togglePick(multi, { picked: [], text: "" }, "Windows");
    m = togglePick(multi, m, "macOS");
    expect(m.picked).toEqual(["macOS", "Windows"]); // the question's order
    expect(togglePick(multi, m, "Windows").picked).toEqual(["macOS"]);
  });

  it("words each kind of answer", () => {
    expect(answerText(ask({ type: "yes_no", options: ["Yes", "No"] }), { picked: ["No"], text: "" })).toBe("No");
    expect(answerText(ask(), { picked: ["Postgres"], text: "ignored: the question takes no words" })).toBe("Postgres");
    expect(answerText(ask({ freeText: true }), { picked: ["Postgres"], text: " version 16 \n please " })).toBe("Postgres (version 16 please)");
    expect(answerText(ask({ freeText: true }), { picked: [], text: "MySQL, actually" })).toBe("MySQL, actually");
    expect(answerText(ask({ type: "multiple", options: ["macOS", "Linux", "Windows"], freeText: true }), { picked: ["macOS", "Linux"], text: "arm64 only" })).toBe("macOS, Linux (arm64 only)");
    expect(answerText(ask({ type: "text", options: [], freeText: true }), { picked: [], text: "DATABASE_URL" })).toBe("DATABASE_URL");
    // Nothing filled in, or a pick that is not one of the options: no answer.
    expect(answerText(ask(), undefined)).toBe("");
    expect(answerText(ask(), { picked: ["Oracle"], text: "" })).toBe("");
    expect(answerText(ask({ type: "text", options: [], freeText: true }), { picked: [], text: "   " })).toBe("");
  });

  it("sends every answer given as one line, and skips the questions left blank", () => {
    const db = ask({ id: "1" });
    const rename = ask({ id: "2", question: "Rename the module?", type: "yes_no", options: ["Yes", "No"] });
    const name = ask({ id: "3", question: "What should the variable be called", type: "text", options: [], freeText: true });
    expect(composeAnswers([{ ask: db, draft: { picked: ["Postgres"], text: "" } }])).toBe('Answering your question "Which database": Postgres');
    const all = composeAnswers([
      { ask: db, draft: { picked: ["Postgres"], text: "" } },
      { ask: rename, draft: undefined },
      { ask: name, draft: { picked: [], text: "DATABASE_URL" } },
    ]);
    expect(all).toBe("Answering your questions. (1) Which database: Postgres; (2) What should the variable be called: DATABASE_URL");
    expect(all).not.toContain("\n");
    expect(composeAnswers([{ ask: rename, draft: undefined }])).toBe("");
  });
});

describe("how much of a reply is read", () => {
  it("a short reply is read whole", () => {
    expect(replyOf("Shall I?", "Shall I?")).toBe("Shall I?");
    expect(replyOf("only the start", undefined)).toBe("only the start");
    expect(replyOf(undefined, "only the end")).toBe("only the end");
    expect(replyOf(undefined, undefined)).toBe("");
  });

  it("a long reply is its start and its end, joined where they overlap", () => {
    const message = Array.from({ length: 900 }, (_, i) => `line ${i} of the report.`).join(" ");
    const head = message.slice(0, 4000);
    // Overlapping: together they are the whole message.
    expect(replyOf(head, `…${message.slice(-(message.length - 3000))}`)).toBe(message);
    // A gap between them is marked, never papered over.
    const tail = message.slice(-6000);
    const joined = replyOf(head, `…${tail}`);
    expect(message.length).toBeGreaterThan(10_000);
    expect(joined).toBe(`${head}\n[…]\n${tail}`);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLedger } from "./testLedger";

const ledger = memoryLedger();
let log = [{ hash: "base0", short: "base0", author: "", date: "", subject: "init", refs: "" }];

vi.mock("../ledger", () => ({
  appendLedger: (...a: Parameters<typeof ledger.appendLedger>) => ledger.appendLedger(...a),
  queryLedger: (...a: Parameters<typeof ledger.queryLedger>) => ledger.queryLedger(...a),
}));
vi.mock("../ipc", () => ({ gitLog: vi.fn(async () => log) }));

import {
  createPlan,
  expectRun,
  linkTurnEnd,
  linkTurnStart,
  notePlanQuestionAnswered,
  plansForSession,
  resetPlanStoreForTests,
} from "./planStore";
import type { PlanData } from "./plan";

const data = (planId = "pl-a-1"): PlanData => ({
  planId,
  goal: "g",
  decisions: [],
  touches: [],
  acceptance: ["tests pass"],
  wontDo: [],
  risk: "low",
  size: "tiny",
  taskClass: "bugfix",
  request: "r",
  dir: "/repo/wt",
  source: "task",
  gate: "inline",
  gateWhy: [],
});

const turn = (over: Record<string, unknown> = {}) => ({
  turnId: "s1:1",
  ptyId: 7,
  sessionId: "s1",
  cli: "x",
  cwd: "/repo/wt",
  root: "/repo",
  prompt: "Read your brief from /tmp/brief.txt",
  startedAt: 5,
  ...over,
});

beforeEach(() => {
  ledger.rows.length = 0;
  resetPlanStoreForTests();
  log = [{ hash: "base0", short: "base0", author: "", date: "", subject: "init", refs: "" }];
});

describe("plan lifecycle in the ledger", () => {
  it("links a dispatched plan to the run's session, then records done and its commits", async () => {
    await createPlan(data(), "approved");
    await expectRun("pl-a-1", "/repo/wt");
    await linkTurnStart(turn());
    let [head] = await plansForSession("/repo", "s1");
    expect(head.status).toBe("in-progress");
    expect(head.ref).toEqual({ kind: "session", id: "s1" });
    expect(head.data).toMatchObject({ sessionId: "s1", ptyId: 7, baseHead: "base0" });

    log = [{ hash: "c2", short: "c2", author: "", date: "", subject: "Fix it", refs: "" }, ...log];
    await linkTurnEnd({ sessionId: "s1", cwd: "/repo/wt", endedAt: 9 });
    [head] = await plansForSession("/repo", "s1");
    expect(head.status).toBe("done");
    expect(head.data.commits).toEqual([{ sha: "c2", subject: "Fix it" }]);
    // One chain: exactly one plan head.
    expect(ledger.heads().filter((r) => r.kind === "plan")).toHaveLength(1);
  });

  it("links by the plan marker in the prompt, even from another directory", async () => {
    await createPlan(data("pl-b-2"), "approved");
    await linkTurnStart(turn({ cwd: "/elsewhere", prompt: "[Canopy plan pl-b-2] Goal: g" }));
    const [head] = await plansForSession("/repo", "s1");
    expect(head.data.planId).toBe("pl-b-2");
  });

  it("does not claim an unrelated session", async () => {
    await createPlan(data(), "approved");
    await expectRun("pl-a-1", "/repo/wt");
    await linkTurnStart(turn({ cwd: "/other/project" }));
    expect(await plansForSession("/repo", "s1")).toEqual([]);
  });

  it("records a mid-run canopy_ask_user answer as a decision on the plan", async () => {
    await createPlan(data(), "approved");
    await expectRun("pl-a-1", "/repo/wt");
    await linkTurnStart(turn());
    await notePlanQuestionAnswered({ ptyId: 7, route: "/repo/wt", question: "Keep the old endpoint?", options: ["Yes", "No"], answer: "Yes" });
    const [head] = await plansForSession("/repo", "s1");
    expect(head.data.decisions).toEqual([
      expect.objectContaining({ question: "Keep the old endpoint?", answer: "Yes", source: "mid-run", options: ["Yes", "No"] }),
    ]);
  });

  it("finds the in-progress plan by checkout when the pty is unknown here", async () => {
    await createPlan({ ...data(), ptyId: 3 }, "in-progress");
    const r = await notePlanQuestionAnswered({ ptyId: null, route: "/repo/wt", question: "q?", options: [], answer: "(the user skipped this question — decide for yourself)" });
    expect(r?.data.decisions[0]).toMatchObject({ answer: "Left to the agent" });
  });

  it("ignores answers to agents that are not running a plan", async () => {
    expect(await notePlanQuestionAnswered({ ptyId: 9, route: "/nowhere", question: "q", options: [], answer: "a" })).toBeNull();
  });
});

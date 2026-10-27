import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLedger } from "../test/memoryLedger";

const ledger = memoryLedger();
let log = [{ hash: "base0", short: "base0", author: "", date: "", subject: "init", refs: "" }];

vi.mock("../ledger", () => ({
  appendLedger: (...a: Parameters<typeof ledger.appendLedger>) => ledger.appendLedger(...a),
  queryLedger: (...a: Parameters<typeof ledger.queryLedger>) => ledger.queryLedger(...a),
}));
vi.mock("../ipc", () => ({ gitLog: vi.fn(async () => log) }));

import {
  applyChatApproval,
  completeSessionPlan,
  completeTicketPlans,
  createPlan,
  expectRun,
  findPlan,
  linkTurnEnd,
  linkTurnStart,
  notePlanQuestionAnswered,
  plansForSession,
  resetPlanStoreForTests,
  revisePlan,
} from "./planStore";
import { resetReceiptsForTests, setReceipt } from "../receipts/store";
import type { ReceiptRecord } from "../receipts/types";
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
  localStorage.clear();
  resetPlanStoreForTests();
  resetReceiptsForTests();
  log = [{ hash: "base0", short: "base0", author: "", date: "", subject: "init", refs: "" }];
});

describe("plan lifecycle in the ledger", () => {
  it("links a dispatched plan to the run's session, then records done and its commits", async () => {
    await createPlan(data(), "approved");
    await expectRun("pl-a-1", "/repo/wt");
    // The brief was parked in a file: only the env-carried id names the plan.
    await linkTurnStart(turn({ planId: "pl-a-1" }));
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

  it("never guesses: a turn in the same folder without the plan's id is not its run", async () => {
    await createPlan(data(), "approved");
    await expectRun("pl-a-1", "/repo/wt");
    await linkTurnStart(turn());
    expect(await plansForSession("/repo", "s1")).toEqual([]);
  });

  it("keeps two plans dispatched into one checkout apart by their ids", async () => {
    await createPlan(data("pl-a-1"), "approved");
    await createPlan(data("pl-b-2"), "approved");
    await expectRun("pl-a-1", "/repo/wt");
    await expectRun("pl-b-2", "/repo/wt");
    await linkTurnStart(turn({ sessionId: "s2", turnId: "s2:1", planId: "pl-b-2" }));
    await linkTurnStart(turn({ sessionId: "s1", planId: "pl-a-1" }));
    expect((await plansForSession("/repo", "s1"))[0].data.planId).toBe("pl-a-1");
    expect((await plansForSession("/repo", "s2"))[0].data.planId).toBe("pl-b-2");
  });

  it("keeps an interactive session's plan in progress across turns until its ticket is done", async () => {
    await createPlan({ ...data(), mode: "interactive", ticketId: "T-1" }, "approved");
    await expectRun("pl-a-1", "/repo/wt", { mode: "interactive", ticketId: "T-1" });
    await linkTurnStart(turn({ planId: "pl-a-1" }));
    await linkTurnEnd({ sessionId: "s1", cwd: "/repo/wt", endedAt: 9, planId: "pl-a-1" });
    expect((await plansForSession("/repo", "s1"))[0].status).toBe("in-progress");
    await completeTicketPlans("T-1");
    const [head] = await plansForSession("/repo", "s1");
    expect(head.status).toBe("done");
    expect(head.data.doneBecause).toBe("the ticket was marked done");
  });

  it("finishes an interactive plan when its session ends", async () => {
    await createPlan({ ...data(), mode: "interactive" }, "approved");
    await expectRun("pl-a-1", "/repo/wt", { mode: "interactive" });
    await linkTurnStart(turn({ planId: "pl-a-1" }));
    await completeSessionPlan("other-session");
    expect((await plansForSession("/repo", "s1"))[0].status).toBe("in-progress");
    await completeSessionPlan("s1", "pl-a-1");
    expect((await plansForSession("/repo", "s1"))[0].data.doneBecause).toBe("the agent session ended");
  });

  it("finishes an interactive plan when a receipt proves every acceptance check", async () => {
    await createPlan({ ...data(), mode: "interactive" }, "approved");
    await expectRun("pl-a-1", "/repo/wt", { mode: "interactive" });
    await linkTurnStart(turn({ planId: "pl-a-1" }));
    const receipt = (id: string, met: boolean) =>
      ({ id, ts: Number(id.slice(1)), root: "/repo", sessionId: "s1", ptyId: 7, status: "proven", verdict: { acceptance: [{ item: "tests pass", met, evidence: "" }] } }) as unknown as ReceiptRecord;
    setReceipt(receipt("r1", false));
    await new Promise((r) => setTimeout(r, 0));
    expect((await findPlan("/repo/wt", "pl-a-1"))!.status).toBe("in-progress");
    setReceipt(receipt("r2", true));
    await vi.waitFor(async () => expect((await findPlan("/repo/wt", "pl-a-1"))!.status).toBe("done"));
  });

  it("takes a chat approval only from an approver the author named", async () => {
    await createPlan(data(), "proposed");
    await revisePlan("/repo/wt", "pl-a-1", () => ({ data: { approvers: ["u-dana"] } }));
    await applyChatApproval("pl-a-1", { id: "u-eve", name: "Eve" });
    expect((await findPlan("/repo/wt", "pl-a-1"))!.status).toBe("proposed");
    await applyChatApproval("pl-a-1", { id: "u-dana", name: "Dana" });
    const head = (await findPlan("/repo/wt", "pl-a-1"))!;
    expect(head.status).toBe("approved");
    expect(head.data.approvedBy).toBe("Dana (team chat)");
  });

  it("records a mid-run canopy_ask_user answer as a decision on the plan", async () => {
    await createPlan(data(), "approved");
    await expectRun("pl-a-1", "/repo/wt");
    await linkTurnStart(turn({ planId: "pl-a-1" }));
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

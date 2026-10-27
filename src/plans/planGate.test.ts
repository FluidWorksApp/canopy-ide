import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryLedger } from "../test/memoryLedger";

const ledger = memoryLedger();
const askBrain = vi.fn();

vi.mock("../brainCall", () => ({ askBrain: (...a: unknown[]) => askBrain(...a) }));
vi.mock("../ledger", () => ({
  appendLedger: (...a: Parameters<typeof ledger.appendLedger>) => ledger.appendLedger(...a),
  queryLedger: (...a: Parameters<typeof ledger.queryLedger>) => ledger.queryLedger(...a),
  subscribeLedger: (...a: Parameters<typeof ledger.subscribeLedger>) => ledger.subscribeLedger(...a),
}));
vi.mock("../ipc", () => ({
  fsReadDir: vi.fn(async () => [{ name: "src", path: "/repo/src", is_dir: true }]),
  fsSearch: vi.fn(async () => [{ path: "/repo/src/orders.ts", line: 1, text: "orders" }]),
  gitLog: vi.fn(async () => [{ hash: "base0", short: "base0", author: "", date: "", subject: "init", refs: "" }]),
}));

import { approvePlan, dispatchWithPlan, dropPlan, planGateItems, resetPlanGateForTests, skipPlanning } from "./planGate";
import { applyChatApproval, resetPlanStoreForTests } from "./planStore";
import { updateSettings } from "../settings";
import type { PlanData } from "./plan";

const reply = (over: Record<string, unknown> = {}) => ({
  ok: true,
  text: "",
  costUsd: 0,
  inputTokens: 1,
  outputTokens: 1,
  value: {
    goal: "Paginate the orders list",
    decisions: [{ question: "Pages or infinite scroll?", options: ["Pages", "Infinite"], recommended: "Pages", why: "" }],
    touches: ["src/orders.ts"],
    acceptance: ["npm test passes"],
    wontDo: [],
    risk: "low",
    size: "tiny",
    taskClass: "feature",
    ...over,
  },
});

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  ledger.rows.length = 0;
  askBrain.mockReset();
  resetPlanGateForTests();
  resetPlanStoreForTests();
  localStorage.clear();
});
afterEach(() => {
  resetPlanGateForTests();
});

describe("dispatchWithPlan", () => {
  it("plans with the main-tier brain and starts tiny low-risk work at once with the plan in the brief", async () => {
    askBrain.mockResolvedValue(reply());
    const launch = vi.fn();
    await dispatchWithPlan({ request: "paginate orders", dir: "/repo", source: "task" }, launch);
    const req = askBrain.mock.calls[0][0];
    expect(req).toMatchObject({ feature: "plan", tier: "main", json: true, cwd: "/repo" });
    expect(req.prompt).toContain("paginate orders");
    expect(req.prompt).toContain("src/orders.ts");
    expect(launch).toHaveBeenCalledTimes(1);
    const brief = launch.mock.calls[0][0] as string;
    expect(brief).toContain("Goal: Paginate the orders list");
    expect(brief).toContain("Pages or infinite scroll? → Pages");
    expect(brief).toContain("Task: paginate orders");
    const entry = ledger.heads().find((r) => r.kind === "plan")!;
    expect(entry.status).toBe("approved");
    expect((entry.data as PlanData).gate).toBe("inline");
    expect((entry.data as PlanData).acceptance).toEqual(["npm test passes"]);
    expect(planGateItems()[0].phase).toBe("inline");
  });

  it("holds risky plans until the person answers and approves", async () => {
    askBrain.mockResolvedValue(reply({ risk: "high", touches: ["src/auth/login.ts"] }));
    const launch = vi.fn();
    const done = dispatchWithPlan({ request: "fix login", dir: "/repo", source: "ticket" }, launch);
    await vi.waitFor(() => expect(planGateItems()[0]?.phase).toBe("approval"));
    expect(launch).not.toHaveBeenCalled();
    const item = planGateItems()[0] as Extract<ReturnType<typeof planGateItems>[number], { phase: "approval" }>;
    expect(item.entry.status).toBe("proposed");
    expect(item.entry.data.gateWhy).toEqual(expect.arrayContaining(["high risk", "touches auth"]));
    await approvePlan(item.id, {
      decisions: [{ ...item.entry.data.decisions[0], answer: "Infinite" }],
      acceptance: ["Login works with SSO", "npm test passes"],
    });
    await done;
    expect(launch).toHaveBeenCalledTimes(1);
    const brief = launch.mock.calls[0][0] as string;
    expect(brief).toContain("Pages or infinite scroll? → Infinite");
    expect(brief).toContain("(1) Login works with SSO");
    const head = ledger.heads().find((r) => r.kind === "plan")!;
    expect(head.status).toBe("approved");
    expect((head.data as PlanData).acceptance).toEqual(["Login works with SSO", "npm test passes"]);
    expect(planGateItems()).toEqual([]);
  });

  it("launches when the plan is approved from team chat", async () => {
    askBrain.mockResolvedValue(reply({ risk: "medium" }));
    const launch = vi.fn();
    const done = dispatchWithPlan({ request: "x", dir: "/repo", source: "task" }, launch);
    await vi.waitFor(() => expect(planGateItems()[0]?.phase).toBe("approval"));
    const item = planGateItems()[0] as Extract<ReturnType<typeof planGateItems>[number], { phase: "approval" }>;
    await applyChatApproval(item.entry.data.planId, "Dana");
    await done;
    expect(launch).toHaveBeenCalledTimes(1);
    // What the teammate approved is the plan as shared: open decisions at
    // their recommendation, and the agent is told so.
    expect(launch.mock.calls[0][0]).toContain("Pages or infinite scroll? → Pages");
    expect(launch.mock.calls[0][1]).toBe(item.entry.data.planId);
    expect(ledger.heads().find((r) => r.kind === "plan")!.data).toMatchObject({ approvedBy: "Dana (team chat)" });
  });

  it("marks a plan dropped on Don't start, and never launches", async () => {
    askBrain.mockResolvedValue(reply({ risk: "medium" }));
    const launch = vi.fn();
    const done = dispatchWithPlan({ request: "x", dir: "/repo", source: "task" }, launch);
    await vi.waitFor(() => expect(planGateItems()[0]?.phase).toBe("approval"));
    dropPlan(planGateItems()[0].id);
    await done;
    await flush();
    expect(launch).not.toHaveBeenCalled();
    expect(ledger.heads().find((r) => r.kind === "plan")!.status).toBe("dropped");
  });

  it("starts without a plan, with a one-line note, when the brain can't plan", async () => {
    askBrain.mockResolvedValue({ ok: false, reason: "no-brain", message: "" });
    const launch = vi.fn();
    await dispatchWithPlan({ request: "do it", dir: "/repo", source: "task" }, launch);
    expect(launch).toHaveBeenCalledWith("do it");
    const note = planGateItems()[0];
    expect(note.phase).toBe("note");
    expect(note.phase === "note" && note.message).toBe("Started without a plan: no brain is connected.");
    expect(ledger.rows).toEqual([]);
  });

  it("lets the person skip planning and start now", async () => {
    let release!: (v: unknown) => void;
    askBrain.mockReturnValue(new Promise((r) => (release = r)));
    const launch = vi.fn();
    const done = dispatchWithPlan({ request: "now", dir: "/repo", source: "task" }, launch);
    await vi.waitFor(() => expect(askBrain).toHaveBeenCalled());
    skipPlanning(planGateItems()[0].id);
    expect(launch).toHaveBeenCalledWith("now");
    release(reply());
    await done;
    expect(launch).toHaveBeenCalledTimes(1);
    expect(askBrain.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it("does nothing but launch when planning is turned off", async () => {
    updateSettings({ planBeforeDispatch: false });
    const launch = vi.fn();
    await dispatchWithPlan({ request: "raw", dir: "/repo", source: "task" }, launch);
    expect(launch).toHaveBeenCalledWith("raw");
    expect(askBrain).not.toHaveBeenCalled();
  });
});

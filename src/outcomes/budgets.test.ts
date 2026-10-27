import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as ipc from "../ipc";
import type { AttentionInput } from "../attention";
import { updateSettings } from "../settings";
import type { AgentTurnEnd, AgentTurnStart } from "../agentTurns";
import {
  budgetLevel,
  createBudgetMonitor,
  parseBudget,
  resetBudgetsForTests,
  resolveBudget,
  sessionBudget,
  sessionBudgetStates,
  setSessionBudget,
  storeSessionBudget,
  type BudgetDeps,
} from "./budgets";

const start = (over: Partial<AgentTurnStart> = {}): AgentTurnStart => ({
  turnId: "s1:1",
  ptyId: 9,
  sessionId: "s1",
  cli: "cli-a",
  cwd: "/repo",
  root: "/repo",
  startedAt: 1,
  ...over,
});
const end = (over: Partial<AgentTurnEnd> = {}): AgentTurnEnd => ({
  ...start(),
  filesTouched: [],
  endedAt: 2,
  ...over,
});

function harness(over: Partial<BudgetDeps> = {}) {
  let cost = 0;
  const deps = {
    usage: vi.fn(async () => [
      {
        session_id: "s1",
        agent: "cli-a",
        supported: true,
        cost,
        model: null,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      } as unknown as ipc.AgentSessionUsage,
    ]),
    ptyWrite: vi.fn<(id: number, data: string) => void>(),
    notify: vi.fn<(input: AttentionInput) => void>(),
    resolveNotice: vi.fn<(key: string) => void>(),
    isPrototype: vi.fn(() => false),
    planBudget: vi.fn(async () => null as number | null),
  };
  const monitor = createBudgetMonitor({ ...deps, ...over });
  return { deps, monitor, setCost: (c: number) => (cost = c) };
}

beforeEach(() => {
  resetBudgetsForTests();
  updateSettings({ sessionBudgetUsd: null, builderSessionCapUsd: 10, budgetPauseAtLimit: true });
});
afterEach(() => resetBudgetsForTests());

describe("budget rules", () => {
  it("parses a budget from a prompt", () => {
    expect(parseBudget("Fix the header. Budget $5")).toBe(5);
    expect(parseBudget("budget: $12.50 please")).toBe(12.5);
    expect(parseBudget("budget of $3")).toBe(3);
    expect(parseBudget("spend $5 on it")).toBeNull();
    expect(parseBudget(undefined)).toBeNull();
  });

  it("resolves session over plan over defaults; prototype cap when lower", () => {
    const base = { isPrototype: false, defaultUsd: null, prototypeCapUsd: 10 };
    expect(resolveBudget({ ...base, session: 5, plan: 8 })).toEqual({ usd: 5, source: "session" });
    expect(resolveBudget({ ...base, plan: 8 })).toEqual({ usd: 8, source: "plan" });
    expect(resolveBudget(base)).toBeNull();
    expect(resolveBudget({ ...base, isPrototype: true })).toEqual({ usd: 10, source: "prototype" });
    expect(resolveBudget({ ...base, isPrototype: true, defaultUsd: 4 })).toEqual({ usd: 4, source: "default" });
    expect(resolveBudget({ ...base, isPrototype: true, defaultUsd: 40 })).toEqual({ usd: 10, source: "prototype" });
  });

  it("levels at 80% and 100%", () => {
    const b = { usd: 10, source: "session" as const };
    expect(budgetLevel(7.9, b)).toBe("ok");
    expect(budgetLevel(8, b)).toBe("warn");
    expect(budgetLevel(10, b)).toBe("over");
    expect(budgetLevel(100, null)).toBe("none");
  });

  it("stores and clears a session's own budget", () => {
    storeSessionBudget("s1", 5);
    expect(sessionBudget("s1")).toBe(5);
    storeSessionBudget("s1", null);
    expect(sessionBudget("s1")).toBeNull();
  });
});

describe("budget monitor", () => {
  it("warns once at 80% without pausing", async () => {
    const h = harness();
    storeSessionBudget("s1", 10);
    h.setCost(8.5);
    await h.monitor.onTurnStart(start());
    await h.monitor.tick();
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
    expect(h.deps.notify.mock.calls[0][0]).toMatchObject({ kind: "fyi", tone: "warn" });
    expect(h.deps.notify.mock.calls[0][0].title).toContain("85%");
    expect(h.deps.ptyWrite).not.toHaveBeenCalled();
    expect(sessionBudgetStates().get("s1")?.level).toBe("warn");
  });

  it("pauses mid-turn at 100% with one Esc and asks to raise the budget", async () => {
    const h = harness();
    storeSessionBudget("s1", 5);
    h.setCost(2);
    await h.monitor.onTurnStart(start());
    expect(h.deps.ptyWrite).not.toHaveBeenCalled();
    h.setCost(5.2);
    await h.monitor.tick();
    await h.monitor.tick();
    expect(h.deps.ptyWrite).toHaveBeenCalledTimes(1);
    expect(h.deps.ptyWrite).toHaveBeenCalledWith(9, "\x1b");
    const q = h.deps.notify.mock.calls.find((c) => c[0].kind === "question")![0];
    expect(q.title).toContain("paused");
    expect(q.where).toEqual({ kind: "terminal", ptyId: 9 });
    expect(sessionBudgetStates().get("s1")?.level).toBe("over");
  });

  it("pauses at the start of a turn when already over budget", async () => {
    const h = harness();
    storeSessionBudget("s1", 1);
    h.setCost(3);
    await h.monitor.onTurnStart(start());
    expect(h.deps.ptyWrite).toHaveBeenCalledWith(9, "\x1b");
  });

  it("a 'Budget $X' prompt raises the budget before the check", async () => {
    const h = harness();
    storeSessionBudget("s1", 1);
    h.setCost(3);
    await h.monitor.onTurnStart(start({ prompt: "keep going. Budget $10" }));
    expect(h.deps.ptyWrite).not.toHaveBeenCalled();
    expect(sessionBudget("s1")).toBe(10);
  });

  it("warns loudly instead of pausing when the terminal is unknown", async () => {
    const h = harness();
    storeSessionBudget("s1", 1);
    h.setCost(3);
    await h.monitor.onTurnStart(start({ ptyId: null }));
    expect(h.deps.ptyWrite).not.toHaveBeenCalled();
    const q = h.deps.notify.mock.calls[0][0];
    expect(q).toMatchObject({ kind: "question", tone: "error" });
    expect(q.body).toContain("cannot pause");
  });

  it("only warns when pausing is turned off", async () => {
    updateSettings({ budgetPauseAtLimit: false });
    const h = harness();
    storeSessionBudget("s1", 1);
    h.setCost(3);
    await h.monitor.onTurnStart(start());
    expect(h.deps.ptyWrite).not.toHaveBeenCalled();
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
  });

  it("does not press Esc after the turn has ended", async () => {
    const h = harness();
    storeSessionBudget("s1", 1);
    await h.monitor.onTurnEnd(end(), 4);
    expect(h.deps.ptyWrite).not.toHaveBeenCalled();
    expect(h.deps.notify.mock.calls[0][0].body).toContain("another step");
  });

  it("raising the budget answers the pause question", async () => {
    const h = harness();
    storeSessionBudget("s1", 1);
    h.setCost(3);
    await h.monitor.onTurnStart(start());
    setSessionBudget("s1", 20);
    await vi.waitFor(() => expect(h.deps.resolveNotice).toHaveBeenCalledWith("budget:s1"));
    expect(sessionBudgetStates().get("s1")?.level).toBe("ok");
  });

  it("applies the plan budget and the prototype cap", async () => {
    const h = harness({ planBudget: vi.fn(async () => 2) });
    h.setCost(2.5);
    await h.monitor.onTurnStart(start());
    expect(sessionBudgetStates().get("s1")?.budget).toEqual({ usd: 2, source: "plan" });

    resetBudgetsForTests();
    const p = harness({ isPrototype: vi.fn(() => true) });
    p.setCost(11);
    await p.monitor.onTurnStart(start());
    expect(sessionBudgetStates().get("s1")?.budget).toEqual({ usd: 10, source: "prototype" });
    expect(p.deps.ptyWrite).toHaveBeenCalledWith(9, "\x1b");
  });
});

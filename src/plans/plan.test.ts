import { describe, expect, it } from "vitest";
import {
  buildPlanPrompt,
  planBrief,
  planGate,
  planIdInPrompt,
  settleWithRecommendations,
  validatePlan,
  type PlanData,
} from "./plan";
import { forcedHighReason, hotspotReason } from "./hotspots";
import { requestKeywords } from "./planContext";

const raw = {
  goal: "Add pagination to the orders list",
  decisions: [
    { question: "Pagination or infinite scroll?", options: ["Pages", "Infinite scroll"], recommended: "Pages", why: "Matches the admin tables" },
    { question: "", options: ["dropped"] },
  ],
  touches: ["src/orders/List.tsx"],
  acceptance: ["npm test passes", "Orders list shows 50 per page"],
  wontDo: ["Change the API"],
  risk: "low",
  size: "small",
  taskClass: "feature",
};

const plan = (over: Partial<PlanData> = {}): PlanData => ({
  ...(validatePlan(raw) as NonNullable<ReturnType<typeof validatePlan>>),
  planId: "pl-abc-123",
  request: "add pagination to orders",
  dir: "/repo",
  source: "task",
  gate: "approval",
  gateWhy: [],
  ...over,
});

describe("plan prompt", () => {
  it("carries the request, repo context, memory and the JSON contract", () => {
    const p = buildPlanPrompt("add pagination to orders", {
      tree: ["src/", "package.json"],
      relevant: ["src/orders/List.tsx"],
      memory: ["Orders API is keyset-paginated"],
    });
    expect(p).toContain("add pagination to orders");
    expect(p).toContain("src/  package.json");
    expect(p).toContain("- src/orders/List.tsx");
    expect(p).toContain("Orders API is keyset-paginated");
    for (const key of ['"goal"', '"decisions"', '"touches"', '"acceptance"', '"wontDo"', '"risk"', '"size"', '"taskClass"'])
      expect(p).toContain(key);
    expect(p).toMatch(/CONSEQUENTIAL decisions/);
  });

  it("omits empty context sections", () => {
    const p = buildPlanPrompt("x", { tree: [], relevant: [], memory: [] });
    expect(p).not.toContain("REPO TOP LEVEL");
    expect(p).not.toContain("recent memory");
  });

  it("picks identifier-like keywords first and drops filler", () => {
    expect(requestKeywords("please make the `orderList` paginate with useOrders hook")).toEqual(
      expect.arrayContaining(["orderList", "useOrders"]),
    );
    expect(requestKeywords("please make this with that")).toEqual([]);
  });
});

describe("validatePlan", () => {
  it("normalises a good reply and drops malformed decisions", () => {
    const v = validatePlan(raw)!;
    expect(v.goal).toBe("Add pagination to the orders list");
    expect(v.decisions).toHaveLength(1);
    expect(v.decisions[0]).toMatchObject({ recommended: "Pages", source: "plan" });
    expect(v.risk).toBe("low");
    expect(v.taskClass).toBe("feature");
  });

  it("requires a goal; unknown enums err towards caution", () => {
    expect(validatePlan({ decisions: [] })).toBeNull();
    expect(validatePlan(null)).toBeNull();
    expect(validatePlan([])).toBeNull();
    const v = validatePlan({ goal: "g", risk: "tiny?", size: 3, taskClass: "chore" })!;
    expect(v.risk).toBe("medium");
    expect(v.size).toBe("small");
    expect(v.taskClass).toBe("feature");
    expect(v.acceptance).toEqual([]);
  });

  it("defaults a missing recommendation to the first option", () => {
    const v = validatePlan({ goal: "g", decisions: [{ question: "q?", options: ["a", "b"] }] })!;
    expect(v.decisions[0].recommended).toBe("a");
  });
});

describe("blast-radius gate", () => {
  it("lets tiny low-risk work start inline", () => {
    expect(planGate({ risk: "low", size: "tiny", touches: ["src/components/Button.tsx"] })).toEqual({ gate: "inline", why: [] });
  });

  it("holds medium/high risk and large changes for approval", () => {
    expect(planGate({ risk: "medium", size: "small", touches: [] }).gate).toBe("approval");
    expect(planGate({ risk: "high", size: "tiny", touches: [] }).why).toContain("high risk");
    expect(planGate({ risk: "low", size: "large", touches: [] }).why).toContain("large change");
  });

  it("holds low-risk plans that touch auth, data, money or shared plumbing", () => {
    for (const touch of ["src/auth/login.ts", "db/migrations/0003_add.sql", "src/billing/invoice.ts", "package.json", ".github/workflows/ci.yml"]) {
      const g = planGate({ risk: "low", size: "tiny", touches: [touch] });
      expect(g.gate, touch).toBe("approval");
      expect(g.why.join(), touch).toMatch(/touches/);
    }
  });

  it("knows the forced-high layers by path", () => {
    expect(forcedHighReason("src/auth/session.ts")).toBe("auth");
    expect(forcedHighReason("db/migrations/2024_users.sql")).toBe("migration");
    expect(forcedHighReason("prisma/schema.prisma")).toBe("data");
    expect(forcedHighReason("src/payments/stripe.ts")).toBe("money");
    expect(forcedHighReason("src/components/author.tsx")).toBeNull();
    expect(forcedHighReason("src/tokenizer.ts")).toBeNull();
    expect(hotspotReason("Cargo.lock")).toBe("lockfile");
    expect(hotspotReason("README.md")).toBeNull();
  });
});

describe("plan brief", () => {
  it("folds goal, resolved decisions, acceptance and won't-do into one line", () => {
    const b = planBrief(plan({ decisions: settleWithRecommendations(plan().decisions) }));
    expect(b).not.toContain("\n");
    expect(b).toContain("[Canopy plan pl-abc-123, approved by the user]");
    expect(b).toContain("Goal: Add pagination to the orders list");
    expect(b).toContain("Pagination or infinite scroll? → Pages");
    expect(b).toContain("(1) npm test passes (2) Orders list shows 50 per page");
    expect(b).toContain("Out of scope, do not do: Change the API");
    expect(b).toContain("canopy_ask_user");
    expect(b).toContain("Task: add pagination to orders");
    expect(planIdInPrompt(b)).toBe("pl-abc-123");
  });

  it("leaves unanswered decisions out", () => {
    expect(planBrief(plan())).not.toContain("Decisions already made");
  });
});

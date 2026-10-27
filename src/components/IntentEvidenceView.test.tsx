import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
  gitLog: vi.fn(async () => []),
  gitCommitDetail: vi.fn(async () => ({ body: "" })),
}));

import { IntentEvidenceView } from "./IntentEvidenceView";
import { updateSettings } from "../settings";
import { resetEvidenceForTests } from "../review/evidence";
import { resetReviewCacheForTests } from "../review/intentReview";
import type { PlanData } from "../plans/plan";

const patch = [
  "diff --git a/src/orders.ts b/src/orders.ts",
  "--- a/src/orders.ts",
  "+++ b/src/orders.ts",
  "@@ -1 +1,2 @@",
  "-old",
  "+new",
  "+more",
  "diff --git a/src/auth/session.ts b/src/auth/session.ts",
  "--- a/src/auth/session.ts",
  "+++ b/src/auth/session.ts",
  "@@ -1 +1 @@",
  "+token check",
].join("\n");

const planData: PlanData = {
  planId: "pl-v-1",
  goal: "Paginate the orders list",
  decisions: [{ question: "Pages or scroll?", options: ["Pages", "Scroll"], recommended: "Pages", why: "", answer: "Pages" }],
  touches: ["src/orders.ts"],
  acceptance: ["npm test passes"],
  wontDo: [],
  risk: "medium",
  size: "small",
  taskClass: "feature",
  request: "r",
  dir: "/repo",
  source: "task",
  gate: "approval",
  gateWhy: [],
  sessionId: "s1",
};

async function seed() {
  await ledger.appendLedger("/repo", {
    kind: "plan",
    author: { kind: "brain", name: "plan" },
    scope: "project",
    ref: { kind: "session", id: "s1" },
    data: planData,
    status: "done",
  });
  await ledger.appendLedger("/repo", {
    kind: "receipt",
    author: { kind: "brain", name: "receipt" },
    scope: "project",
    ref: { kind: "turn", id: "s1:100" },
    data: { verdict: "proven", did: "Added a pager to the orders list", checks: [{ name: "npm test", exit: 0 }], evidence: ["41 tests passed"], gaps: [] },
  });
}

beforeEach(() => {
  ledger.rows.length = 0;
  askBrain.mockReset();
  localStorage.clear();
  resetEvidenceForTests();
  resetReviewCacheForTests();
});
afterEach(cleanup);

// The suite runs on a loaded machine: give async UI more than the 1s default.
configure({ asyncUtilTimeout: 8000 });

describe("IntentEvidenceView", () => {
  it("opens on the plan, the brain's deviation summary, the receipt and a risk map", async () => {
    await seed();
    askBrain.mockResolvedValue({
      ok: true,
      text: "",
      costUsd: 0,
      inputTokens: 1,
      outputTokens: 1,
      value: {
        summary: "Adds pages to the orders list as planned, but also edits the session check.",
        deviations: [{ what: "Touched the session token check", where: "src/auth/session.ts", severity: "high" }],
        unplanned: ["src/auth/session.ts"],
        missing: [],
        risk: [{ file: "src/orders.ts", level: "medium", why: "list behaviour" }],
      },
    });
    const onRiskOrder = vi.fn();
    const onOpenFile = vi.fn();
    render(<IntentEvidenceView cwd="/repo" sessionIds={["s1"]} patch={patch} onRiskOrder={onRiskOrder} onOpenFile={onOpenFile} />);

    expect(await screen.findByText(/Adds pages to the orders list as planned/)).toBeInTheDocument();
    expect(screen.getByText("Paginate the orders list", { exact: false })).toBeInTheDocument();
    expect(screen.getByText(/Touched the session token check/)).toBeInTheDocument();
    expect(screen.getByText(/Not in the plan:/).parentElement).toHaveTextContent("src/auth/session.ts");
    // The receipt the sibling feature wrote, matched by the run's session.
    expect(screen.getByText("Proven")).toBeInTheDocument();
    expect(screen.getByText("Added a pager to the orders list")).toBeInTheDocument();
    expect(screen.getByText("41 tests passed")).toBeInTheDocument();
    // The brain was asked with the plan and the receipt in the prompt.
    const req = askBrain.mock.calls[0][0];
    expect(req).toMatchObject({ feature: "review", tier: "main" });
    expect(req.prompt).toContain("Goal: Paginate the orders list");
    expect(req.prompt).toContain("verdict proven");
    // Auth is forced high and leads the risk map; the host hears the order.
    const rows = within(screen.getByRole("list", { name: "" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("high · read lines");
    expect(rows[0]).toHaveTextContent("src/auth/session.ts");
    expect(onRiskOrder).toHaveBeenLastCalledWith(["src/auth/session.ts", "src/orders.ts"]);
    await userEvent.click(rows[1]);
    expect(onOpenFile).toHaveBeenCalledWith("src/orders.ts");
    // The autonomy ledger's line for this kind of work.
    expect(await screen.findByText(/Track record for/)).toHaveTextContent("Track record for feature in this repo: 1 proven, 0 reverted");
  }, 30_000);

  it("says No receipt yet and degrades quietly without a brain", async () => {
    askBrain.mockResolvedValue({ ok: false, reason: "no-brain", message: "" });
    render(<IntentEvidenceView cwd="/repo" sessionIds={[]} patch={patch} />);
    expect(await screen.findByText("No receipt yet.")).toBeInTheDocument();
    expect(await screen.findByText(/No brain is connected/)).toBeInTheDocument();
    expect(screen.getByText(/No plan was recorded/)).toBeInTheDocument();
    // Path-based risk still works.
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("src/auth/session.ts");
  }, 30_000);

  it("offers to split an over-budget change and sends the brain's suggestion to the agent", async () => {
    updateSettings({ reviewSliceBudgetLines: 50 });
    const big = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      ...Array.from({ length: 80 }, (_, i) => `+line ${i}`),
    ].join("\n");
    askBrain.mockResolvedValue({
      ok: true,
      text: "",
      costUsd: 0,
      inputTokens: 1,
      outputTokens: 1,
      value: { summary: "Big.", deviations: [], unplanned: [], missing: [], risk: [], sliceSuggestion: "Split the parser from the UI." },
    });
    const onAskAgent = vi.fn(async () => ({ delivered: true, note: "" }));
    render(<IntentEvidenceView cwd="/repo" sessionIds={[]} patch={big} onAskAgent={onAskAgent} />);
    await screen.findByText("Big.");
    expect(screen.getByText(/over the 50-line budget/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Ask the agent to split this" }));
    expect(onAskAgent).toHaveBeenCalledWith(expect.stringContaining("Suggested split: Split the parser from the UI."));
    expect(await screen.findByText("Sent to the agent.")).toBeInTheDocument();
  }, 30_000);

  it("does not stream brain calls while a working agent's diff keeps moving", async () => {
    askBrain.mockResolvedValue({ ok: true, text: "", costUsd: 0, inputTokens: 1, outputTokens: 1, value: { summary: "First.", deviations: [], unplanned: [], missing: [], risk: [] } });
    const { rerender } = render(<IntentEvidenceView cwd="/repo" sessionIds={[]} patch={patch} />);
    expect(await screen.findByText("First.")).toBeInTheDocument();
    rerender(<IntentEvidenceView cwd="/repo" sessionIds={[]} patch={`${patch}\n+edit 2`} />);
    rerender(<IntentEvidenceView cwd="/repo" sessionIds={[]} patch={`${patch}\n+edit 2\n+edit 3`} />);
    await new Promise((r) => setTimeout(r, 300));
    // The later diffs wait to settle; the first answer stays on screen.
    expect(askBrain).toHaveBeenCalledTimes(1);
    expect(screen.getByText("First.")).toBeInTheDocument();
  }, 30_000);

  it("waits for a click while the agent is mid-turn", async () => {
    askBrain.mockResolvedValue({ ok: true, text: "", costUsd: 0, inputTokens: 1, outputTokens: 1, value: { summary: "Asked.", deviations: [], unplanned: [], missing: [], risk: [] } });
    render(<IntentEvidenceView cwd="/repo" sessionIds={[]} patch={patch} paused />);
    const button = await screen.findByRole("button", { name: "Summarize against the plan" });
    expect(askBrain).not.toHaveBeenCalled();
    await userEvent.click(button);
    expect(await screen.findByText("Asked.")).toBeInTheDocument();
  }, 30_000);

  it("waits for a click when automatic summaries are off", async () => {
    updateSettings({ reviewAutoSummary: false });
    askBrain.mockResolvedValue({ ok: true, text: "", costUsd: 0, inputTokens: 1, outputTokens: 1, value: { summary: "On request.", deviations: [], unplanned: [], missing: [], risk: [] } });
    render(<IntentEvidenceView cwd="/repo" sessionIds={[]} patch={patch} />);
    const button = await screen.findByRole("button", { name: "Summarize against the plan" });
    expect(askBrain).not.toHaveBeenCalled();
    await userEvent.click(button);
    expect(await screen.findByText("On request.")).toBeInTheDocument();
  }, 30_000);
});

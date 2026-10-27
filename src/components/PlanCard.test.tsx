import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { memoryLedger } from "../plans/testLedger";

const ledger = memoryLedger();
const askBrain = vi.fn();
const openShareDialog = vi.fn();

vi.mock("../brainCall", () => ({ askBrain: (...a: unknown[]) => askBrain(...a) }));
vi.mock("../ledger", () => ({
  appendLedger: (...a: Parameters<typeof ledger.appendLedger>) => ledger.appendLedger(...a),
  queryLedger: (...a: Parameters<typeof ledger.queryLedger>) => ledger.queryLedger(...a),
  subscribeLedger: (...a: Parameters<typeof ledger.subscribeLedger>) => ledger.subscribeLedger(...a),
}));
vi.mock("../ipc", () => ({
  fsReadDir: vi.fn(async () => []),
  fsSearch: vi.fn(async () => []),
  gitLog: vi.fn(async () => []),
}));
vi.mock("../shareCards", () => ({ openShareDialog: (...a: unknown[]) => openShareDialog(...a) }));

// The suite runs on a loaded machine: give async UI more than the 1s default.
configure({ asyncUtilTimeout: 8000 });

import { PlanCard } from "./PlanCard";
import { PlanGateHost } from "./PlanGateHost";
import { dispatchWithPlan, resetPlanGateForTests } from "../plans/planGate";
import { resetPlanStoreForTests } from "../plans/planStore";
import type { PlanData } from "../plans/plan";

const plan: PlanData = {
  planId: "pl-x-1",
  goal: "Show orders in pages",
  decisions: [
    { question: "Pages or infinite scroll?", options: ["Pages", "Infinite scroll"], recommended: "Pages", why: "Admin tables page" },
    { question: "Page size?", options: ["25", "50"], recommended: "", why: "" },
  ],
  touches: ["src/orders/List.tsx"],
  acceptance: ["npm test passes"],
  wontDo: ["Change the API"],
  risk: "medium",
  size: "small",
  taskClass: "feature",
  request: "paginate orders",
  dir: "/repo",
  source: "task",
  gate: "approval",
  gateWhy: ["medium risk"],
};

beforeEach(() => {
  ledger.rows.length = 0;
  askBrain.mockReset();
  openShareDialog.mockReset();
  resetPlanGateForTests();
  resetPlanStoreForTests();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  resetPlanGateForTests();
});

describe("PlanCard", () => {
  it("needs every decision answered before approval and returns the answers and edited checks", async () => {
    const onApprove = vi.fn();
    render(<PlanCard plan={plan} mode="approval" onApprove={onApprove} />);
    expect(screen.getByText("Show orders in pages")).toBeInTheDocument();
    expect(screen.getByText(/Needs your approval: medium risk/)).toBeInTheDocument();
    // The second decision has no recommendation, so it starts open.
    const approve = screen.getByRole("button", { name: "Answer 1 more" });
    expect(approve).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Your own answer: Page size?"), { target: { value: "100" } });
    await userEvent.click(screen.getByRole("radio", { name: "Infinite scroll" }));
    fireEvent.change(screen.getByLabelText("Acceptance check 1"), { target: { value: "Orders page shows 100 rows" } });
    await userEvent.click(screen.getByRole("button", { name: "+ Add a check" }));
    fireEvent.change(screen.getByLabelText("Acceptance check 2"), { target: { value: "npm test passes" } });
    await userEvent.click(screen.getByRole("button", { name: "Approve & start" }));
    expect(onApprove).toHaveBeenCalledWith({
      decisions: [
        expect.objectContaining({ question: "Pages or infinite scroll?", answer: "Infinite scroll" }),
        expect.objectContaining({ question: "Page size?", answer: "100" }),
      ],
      acceptance: ["Orders page shows 100 rows", "npm test passes"],
    });
  }, 30_000);

  it("reads back a settled plan without inputs", () => {
    render(<PlanCard plan={{ ...plan, decisions: [{ ...plan.decisions[0], answer: "Pages" }] }} mode="view" status="in-progress" />);
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText(/→ Pages/)).toBeInTheDocument();
    expect(screen.queryByRole("radio")).toBeNull();
  });
});

describe("PlanGateHost", () => {
  it("launches the agent with the answered decisions in its brief", async () => {
    askBrain.mockResolvedValue({
      ok: true,
      text: "",
      costUsd: 0,
      inputTokens: 1,
      outputTokens: 1,
      value: { ...plan, decisions: [plan.decisions[0]], risk: "high" },
    });
    const launch = vi.fn();
    render(<PlanGateHost />);
    let done!: Promise<void>;
    act(() => {
      done = dispatchWithPlan({ request: "paginate orders", dir: "/repo", source: "task", label: "Orders" }, launch);
    });
    const dialog = await screen.findByRole("dialog", { name: /Approve the plan/ });
    expect(dialog).toHaveTextContent("Before the agent starts · Orders");
    await userEvent.click(screen.getByRole("button", { name: "Share plan to team" }));
    expect(openShareDialog).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "share", card: expect.objectContaining({ type: "plan", goal: "Show orders in pages" }) }),
    );
    await userEvent.click(screen.getByRole("radio", { name: "Infinite scroll" }));
    await userEvent.click(screen.getByRole("button", { name: "Approve & start" }));
    await act(() => done);
    expect(launch).toHaveBeenCalledTimes(1);
    const brief = launch.mock.calls[0][0] as string;
    expect(brief).toContain("Pages or infinite scroll? → Infinite scroll");
    expect(brief).toContain("(1) npm test passes");
    expect(brief).toContain("Out of scope, do not do: Change the API");
    expect(screen.queryByRole("dialog")).toBeNull();
  }, 30_000);

  it("shows an inline plan in the corner for small work and lets the person open it", async () => {
    askBrain.mockResolvedValue({
      ok: true,
      text: "",
      costUsd: 0,
      inputTokens: 1,
      outputTokens: 1,
      value: { ...plan, risk: "low", size: "tiny", touches: ["src/ui/Button.tsx"] },
    });
    const launch = vi.fn();
    render(<PlanGateHost />);
    await act(() => dispatchWithPlan({ request: "tweak button", dir: "/repo", source: "task" }, launch));
    expect(launch).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Started with a plan:")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show plan" }));
    expect(screen.getByRole("region", { name: "Plan" })).toHaveTextContent("Change the API");
  }, 30_000);
});

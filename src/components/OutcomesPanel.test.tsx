import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateSettings } from "../settings";
import { OutcomesPanel } from "./OutcomesPanel";
import type { OutcomesReport } from "../outcomes/reconcile";
import type { OutcomeData, SpendData } from "../outcomes/types";


const now = Date.now();

const spend = (sessionId: string, over: Partial<SpendData> = {}): SpendData => ({
  type: "session",
  sessionId,
  cli: "cli-a",
  profile: "default",
  person: "You",
  cwd: "/repo",
  costUsd: 2,
  costReported: true,
  inputTokens: 0,
  outputTokens: 0,
  turns: 3,
  model: null,
  files: [],
  firstTs: now - 1000,
  lastTs: now - 1000,
  ...over,
});

const outcome = (sessionId: string, over: Partial<OutcomeData> = {}): OutcomeData => ({
  type: "session",
  sessionId,
  cli: "cli-a",
  person: "You",
  taskClass: "deps",
  costUsd: 2,
  mergedPrs: [],
  merged: false,
  reverted: false,
  reworked: false,
  lastTs: now - 1000,
  ...over,
});

const report: OutcomesReport = {
  root: "/repo",
  sinceMs: now - 30 * 86_400_000,
  generatedAt: now,
  spends: [spend("d1", { taskClass: "deps" }), spend("u1", { taskClass: "ui-feature", costUsd: 6 })],
  outcomes: [
    outcome("d1", { merged: true, mergedPrs: [4], reviewHours: 5 }),
    outcome("u1", { taskClass: "ui-feature", costUsd: 6, reworked: true }),
  ],
  receipts: [
    { sessionId: "d1", verdict: "proven", ts: now },
    { sessionId: "u1", verdict: "partial", ts: now },
  ],
  mergedInWindow: 1,
  gitUnavailable: false,
  planTitles: new Map(),
};

beforeEach(() => {
  localStorage.clear();
  updateSettings({ outcomesInsight: true });
});

describe("OutcomesPanel", () => {
  it("shows the brain's insight above the metrics", async () => {
    const reconcile = vi.fn(async () => report);
    const insight = vi.fn(async () => ({
      state: "fresh" as const,
      at: now,
      insight: {
        headline: "Dependency bumps pay off; UI features get redone",
        wins: ["Dependency bumps: 1 proven, 0 reverted — consider auto-merge"],
        concerns: ["UI features: 100% reworked within a week"],
        suggestions: ["Require plans for UI features"],
      },
    }));
    render(<OutcomesPanel repos={["/repo"]} reconcile={reconcile} insight={insight} />);

    expect(await screen.findByText("Dependency bumps pay off; UI features get redone", undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByText(/consider auto-merge/)).toBeTruthy();
    expect(screen.getByText("Require plans for UI features")).toBeTruthy();
    // The brain saw aggregated numbers for this repo, not raw data.
    const [root, input] = insight.mock.calls[0] as unknown as [string, { total: { sessions: number } }];
    expect(root).toBe("/repo");
    expect(input.total.sessions).toBe(2);

    // Metrics: total spend $8, cost per merged change $2, half the receipts proven.
    expect(screen.getByTitle(/2 agent sessions in the last 30 days/).textContent).toContain("$8.00");
    expect(screen.getByTitle(/1 merged pull requests came from agent sessions/).textContent).toContain("$2.00");
    expect(screen.getByTitle(/1 proven, 1 partial/).textContent).toContain("50%");
    expect(screen.getByTitle(/1 sessions had files edited again/).textContent).toContain("50%");
    expect(screen.getByTitle(/Median time from a pull request/).textContent).toContain("5.0h");
    // The breakdown lists each task class.
    expect(screen.getByRole("rowheader", { name: "ui-feature" })).toBeTruthy();
    expect(screen.getByRole("rowheader", { name: "deps" })).toBeTruthy();
  });

  it("refreshes the insight on demand", async () => {
    const insight = vi.fn(async () => ({
      state: "cached" as const,
      at: now,
      insight: { headline: "Steady week", wins: [], concerns: [], suggestions: [] },
    }));
    render(<OutcomesPanel repos={["/repo"]} reconcile={async () => report} insight={insight} />);
    await screen.findByText("Steady week", undefined, { timeout: 5000 });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(insight).toHaveBeenCalledTimes(2));
    expect((insight.mock.calls[1] as unknown[])[2]).toMatchObject({ force: true });
  });

  it("degrades to one line when there is no brain", async () => {
    const insight = vi.fn(async () => ({ state: "failed" as const, reason: "no-brain" as const, message: "", cached: null }));
    render(<OutcomesPanel repos={["/repo"]} reconcile={async () => report} insight={insight} />);
    expect(await screen.findByText(/No brain connected/, undefined, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByTitle(/2 agent sessions in the last 30 days/).textContent).toContain("$8.00");
  });

  it("does not call the brain when the insight is turned off", async () => {
    updateSettings({ outcomesInsight: false });
    const insight = vi.fn();
    render(<OutcomesPanel repos={["/repo"]} reconcile={async () => report} insight={insight as never} />);
    expect((await screen.findByTitle(/2 agent sessions in the last 30 days/, undefined, { timeout: 5000 })).textContent).toContain("$8.00");
    expect(screen.getByText(/weekly insight is off/)).toBeTruthy();
    expect(insight).not.toHaveBeenCalled();
  });

  it("asks for a repository when there is none", () => {
    render(<OutcomesPanel repos={[]} reconcile={vi.fn()} insight={vi.fn() as never} />);
    expect(screen.getByText(/Add a git repository/)).toBeTruthy();
  });
});

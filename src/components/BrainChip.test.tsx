import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("../brainStatus", () => {
  let state: Record<string, unknown> = { state: "unknown", cli: null, label: null, checkedAt: null };
  const subs = new Set<() => void>();
  return {
    brainConnection: () => state,
    checkBrainConnection: vi.fn(async () => state),
    subscribeBrainConnection: (cb: () => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    __set: (next: Record<string, unknown>) => {
      state = next;
      subs.forEach((cb) => cb());
    },
  };
});

vi.mock("../brainMeter", () => ({
  startOfToday: () => 0,
  subscribeBrainMeter: () => () => {},
  brainSpendByFeature: vi.fn(() => ({
    "commit-message": { calls: 3, failures: 0, costUsd: 0.12, inputTokens: 1, outputTokens: 1 },
    "session-title": { calls: 5, failures: 1, costUsd: 0.004, inputTokens: 1, outputTokens: 1 },
  })),
}));

import * as status from "../brainStatus";
import { OPEN_BRAIN_CONNECT_EVENT } from "../brainConnect";
import { getSettings, updateSettings } from "../settings";
import { BrainChip } from "./BrainChip";

const setState = (status as unknown as { __set: (s: Record<string, unknown>) => void }).__set;
const checkMock = status.checkBrainConnection as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  checkMock.mockClear();
});

describe("BrainChip", () => {
  it("shows the brain and its state, and opens the spend popover", async () => {
    setState({ state: "connected", cli: "x", label: "Brain CLI", checkedAt: 1 });
    render(<BrainChip />);
    const chip = screen.getByRole("button", { name: "Brain: Brain CLI, Connected" });
    expect(chip).toHaveTextContent("Brain CLI");
    await userEvent.click(chip);
    const pop = screen.getByRole("dialog", { name: "Brain" });
    const rows = within(pop).getAllByRole("row");
    // Biggest spender first, plain names, totals in the footer.
    expect(rows[1]).toHaveTextContent(/Commit messages\s*3\s*\$0\.12/);
    expect(rows[2]).toHaveTextContent(/Session names\s*5\s*<\$0\.01/);
    expect(rows[3]).toHaveTextContent(/All features\s*8\s*\$0\.12/);
  });

  it("edits the daily and per-feature budgets", async () => {
    setState({ state: "connected", cli: "x", label: "Brain CLI", checkedAt: 1 });
    render(<BrainChip />);
    await userEvent.click(screen.getByRole("button", { name: /Brain: Brain CLI/ }));
    const daily = screen.getByLabelText("Daily brain budget in dollars");
    await userEvent.type(daily, "2.5{Enter}");
    expect(getSettings().brainDailyBudgetUsd).toBe(2.5);
    const feature = screen.getByLabelText("Commit messages daily cap in dollars");
    await userEvent.type(feature, "0.5");
    await userEvent.tab();
    expect(getSettings().brainFeatureBudgetsUsd).toEqual({ "commit-message": 0.5 });
    // Clearing a cap removes it rather than setting zero.
    await userEvent.clear(screen.getByLabelText("Commit messages daily cap in dollars"));
    await userEvent.tab();
    expect(getSettings().brainFeatureBudgetsUsd).toEqual({});
  });

  it("shows the last error and checks again", async () => {
    updateSettings({ brainDailyBudgetUsd: null });
    setState({ state: "rate-limited", cli: "x", label: "Brain CLI", checkedAt: 1, message: "usage limit reached" });
    render(<BrainChip />);
    await userEvent.click(screen.getByRole("button", { name: "Brain: Brain CLI, Rate-limited" }));
    expect(screen.getByText("usage limit reached")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(checkMock).toHaveBeenCalledTimes(1);
  });

  it("when disconnected, says so and opens the connect flow instead", async () => {
    setState({ state: "signed-out", cli: "x", label: "Brain CLI", checkedAt: 1 });
    const opened = vi.fn();
    window.addEventListener(OPEN_BRAIN_CONNECT_EVENT, opened);
    try {
      render(<BrainChip />);
      const chip = screen.getByRole("button", { name: "Connect your brain (Signed out)" });
      expect(chip).toHaveTextContent("Connect your brain");
      await userEvent.click(chip);
    } finally {
      window.removeEventListener(OPEN_BRAIN_CONNECT_EVENT, opened);
    }
    expect(opened).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Brain" })).toBeNull();
  });
});

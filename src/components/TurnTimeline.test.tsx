// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { TurnList } from "../ipc";

const turnList = vi.fn();
vi.mock("../ipc", async (orig) => ({
  ...(await orig<typeof import("../ipc")>()),
  turnList: (...a: unknown[]) => turnList(...a),
}));
vi.mock("../gates/timeline", () => ({ irreversibleByTurn: async () => new Map() }));
vi.mock("../lensSteps", () => ({
  lensStepsVersion: () => 0,
  subscribeLensSteps: () => () => {},
  stepSummariesFor: async () => [],
  matchStepSummary: () => null,
}));

import { TurnTimeline } from "./TurnTimeline";

const list = (prompts: (string | null)[]): TurnList => ({
  git: true,
  root: "/r",
  shared: false,
  peers: [],
  restores: [],
  turns: prompts.map((prompt, i) => ({
    n: i + 1,
    start: { ref: `refs/canopy/turns/s/${i + 1}`, commit: "c", tree: "t", ts_ms: 1000 * (i + 1) },
    end: { ref: `refs/canopy/turn-ends/s/${i + 1}`, commit: "c", tree: "t", ts_ms: 1000 * (i + 1) + 500 },
    prompt,
    late: false,
    native_uuid: null,
  })),
});

// As stored before prompts were condensed: cut inside <output-file>.
const CUT =
  "<task-notification> <task-id>b8ewe1566</task-id> <tool-use-id>toolu_01WTbhbmr3dAYGUQSUi5u6pu</tool-use-id> <output-file>/private/tmp/claude-501/-Users-me-Documents-GitHub-canopy/537bebf7-1489";

const show = async (prompts: (string | null)[], onSummarize = vi.fn()) => {
  turnList.mockResolvedValue(list(prompts));
  const view = render(
    <TurnTimeline cwd="/r" sessionId="s" agent="claude" onNotice={() => {}} onSummarize={onSummarize} />,
  );
  await waitFor(() => expect(view.container.querySelector(".aw-turn")).not.toBeNull());
  const row = (n: number) => screen.getByText(`Turn ${n}`).closest("li")!;
  return { ...view, row, onSummarize };
};

afterEach(() => {
  cleanup();
  turnList.mockReset();
});

describe("TurnTimeline rows", () => {
  it("never prints a raw payload", async () => {
    const { container, row } = await show([
      CUT,
      '<task-notification><status>failed</status><summary>Background command "Wait for CI" failed with exit code 144</summary>',
      "[Image #3] [Image #4]Also, only one shell",
    ]);
    expect(container.textContent).not.toMatch(/<task-|tool-use-id|toolu_|\[Image #/);
    expect(within(row(1)).getByText("Background task")).toBeTruthy();
    expect(within(row(2)).getByText("failed, exit 144")).toBeTruthy();
    expect(within(row(2)).getByText("Wait for CI")).toBeTruthy();
    expect(within(row(3)).getByText("2 images")).toBeTruthy();
    expect(within(row(3)).getByText("Also, only one shell")).toBeTruthy();
    expect(row(2).className).toContain("aw-turn-auto");
    expect(row(3).className).not.toContain("aw-turn-auto");
  });

  it("opens the newest turn's actions, and another turn's when it is pressed", async () => {
    const { row } = await show(["first ask", CUT, "latest ask"]);
    expect(within(row(3)).getByText("Undo this turn")).toBeTruthy();
    expect(within(row(1)).queryByText("Undo this turn")).toBeNull();

    fireEvent.click(within(row(2)).getByRole("button", { expanded: false }));
    // A background task's turn can change files too: it keeps its restore points.
    expect(within(row(2)).getByText("Undo this turn")).toBeTruthy();
    expect(within(row(2)).getByText("Back to here")).toBeTruthy();
    expect(within(row(3)).queryByText("Undo this turn")).toBeNull();

    fireEvent.click(within(row(2)).getByRole("button", { expanded: true }));
    expect(screen.queryByText("Undo this turn")).toBeNull();
  });

  it("hands compaction the words of the turn, not its payload", async () => {
    const { row, onSummarize } = await show([
      "Please complete this task now: Ship it. Mark it done in your task list when it is finished.",
    ]);
    fireEvent.click(within(row(1)).getByText("Summarize from here"));
    expect(onSummarize).toHaveBeenCalledWith("from", { n: 1, prompt: "Ship it" });
  });
});

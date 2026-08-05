import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingAgentClose } from "../agentClose";
import { AgentCloseUndo } from "./AgentCloseUndo";

describe("AgentCloseUndo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => vi.useRealTimers());

  const pending: PendingAgentClose = {
    id: "close:a",
    tabIds: ["a"],
    title: "Claude",
    deadline: 11_000,
    restoreTabId: "a",
    groups: {},
  };

  it("shows the deadline and restores the matching transaction", () => {
    const onRestore = vi.fn();
    render(<AgentCloseUndo pending={[pending]} onRestore={onRestore} />);

    expect(screen.getByText("closes in 10s")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(onRestore).toHaveBeenCalledWith("close:a");
  });

  it("updates from the shared second clock", () => {
    render(<AgentCloseUndo pending={[pending]} onRestore={() => {}} />);

    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText("closes in 9s")).toBeInTheDocument();
  });
});

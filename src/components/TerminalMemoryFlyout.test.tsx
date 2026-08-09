import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TerminalBudgetStatus } from "../ipc";
import { TerminalMemoryFlyout } from "./TerminalMemoryFlyout";

const status: TerminalBudgetStatus = {
  id: 7,
  state: "awaiting_grant",
  budget_generation: 1,
  base_allowance_bytes: 1024 ** 3,
  granted_bytes: 0,
  remembered_default_bytes: 0,
  allowance_bytes: 1024 ** 3,
  max_allowance_bytes: null,
  current_bytes: 900 * 1024 ** 2,
  peak_bytes: 900 * 1024 ** 2,
  ema_bytes: 0,
  growth_bytes_per_second: 0,
  samples: 2,
  grant_request: null,
  stop_request_id: "stop-7",
  cli_key: "claude",
};

describe("TerminalMemoryFlyout", () => {
  it("shows allowance-owned context and routes all three recovery actions", () => {
    const onPurge = vi.fn();
    const onRestart = vi.fn();
    const onHibernate = vi.fn();
    render(
      <TerminalMemoryFlyout
        members={[
          { status, session: { name: "Juniper", agent: true } },
        ]}
        quota={{
          members: [status],
          state: "awaiting_grant",
          current_bytes: status.current_bytes,
          allowance_bytes: status.allowance_bytes,
          peak_bytes: status.peak_bytes,
        }}
        onPurge={onPurge}
        onRestart={onRestart}
        onHibernate={onHibernate}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByRole("complementary", { name: "Memory actions for Juniper" })).toHaveTextContent("1.0 GB combined allowance");
    fireEvent.click(screen.getByRole("button", { name: "Purge / compact" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart tab" }));
    fireEvent.click(screen.getByRole("button", { name: "Hibernate" }));
    expect(onPurge).toHaveBeenCalledOnce();
    expect(onRestart).toHaveBeenCalledOnce();
    expect(onHibernate).toHaveBeenCalledOnce();
  });
});

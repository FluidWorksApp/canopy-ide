// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TerminalGovernorDialog } from "./TerminalGovernorDialog";

const status = {
  id: 7,
  budget_generation: 3,
  state: "awaiting_grant" as const,
  base_allowance_bytes: 1024,
  granted_bytes: 0,
  allowance_bytes: 1024,
  current_bytes: 950,
  peak_bytes: 990,
  ema_bytes: 900,
  growth_bytes_per_second: 12,
  samples: 4,
  grant_request: {
    request_id: "grant-7",
    budget_generation: 3,
    increments: [512 * 1024 * 1024, 1024 * 1024 * 1024],
  },
};

const capability = {
  platform: "macos",
  enforcement: "monitor_only" as const,
  measurement: "physical_footprint_sum",
  hard_limit: false,
  pause: false,
};

describe("TerminalGovernorDialog", () => {
  it("requires an explicit grant and states monitor-only truthfully", () => {
    const onGrant = vi.fn();
    render(
      <TerminalGovernorDialog
        status={status}
        capability={capability}
        onGrant={onGrant}
        onStop={() => {}}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByText(/currently monitor-only/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Allow \+512/ }));
    expect(onGrant).toHaveBeenCalledWith(512 * 1024 * 1024);
  });

  it("offers an explicit terminal stop without calling it a throttle", () => {
    const onStop = vi.fn();
    render(
      <TerminalGovernorDialog
        status={{ ...status, state: "over_allowance" }}
        capability={capability}
        onGrant={() => {}}
        onStop={onStop}
        onDismiss={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop terminal" }));
    expect(onStop).toHaveBeenCalledOnce();
  });
});

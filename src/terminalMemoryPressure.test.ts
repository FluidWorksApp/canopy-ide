import { describe, expect, it } from "vitest";
import type { TerminalBudgetStatus } from "./ipc";
import {
  isTerminalMemoryWarning,
  strongestTerminalMemoryWarning,
} from "./terminalMemoryPressure";

const status = (state: TerminalBudgetStatus["state"], id = 1): TerminalBudgetStatus => ({
  id,
  state,
  budget_generation: 1,
  base_allowance_bytes: 100,
  granted_bytes: 0,
  remembered_default_bytes: 0,
  allowance_bytes: 100,
  current_bytes: 80,
  peak_bytes: 80,
  ema_bytes: 80,
  growth_bytes_per_second: 0,
  samples: 2,
  grant_request: null,
  stop_request_id: `stop-${id}`,
  cli_key: null,
});

describe("terminal memory warning", () => {
  it.each([
    ["normal", false],
    ["warned", true],
    ["relief", false],
    ["awaiting_grant", true],
    ["over_allowance", true],
    ["stopping", false],
    ["exited", false],
  ] as const)("maps the governor's %s state without a byte threshold", (stateName, warned) => {
    expect(isTerminalMemoryWarning(status(stateName))).toBe(warned);
  });

  it("uses the strongest governor state in a multiplexed tab", () => {
    expect(
      strongestTerminalMemoryWarning([
        status("warned", 1),
        status("over_allowance", 2),
        status("awaiting_grant", 3),
      ])?.id,
    ).toBe(2);
  });
});

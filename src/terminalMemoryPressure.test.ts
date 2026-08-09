import { describe, expect, it } from "vitest";
import type { TerminalBudgetStatus } from "./ipc";
import {
  isTerminalMemoryWarning,
  terminalMemoryQuotaWarning,
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
    max_allowance_bytes: null,
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

  it("compares multiplex usage with the sum of per-agent allowances", () => {
    const first = { ...status("over_allowance", 1), current_bytes: 110 };
    const second = { ...status("normal", 2), current_bytes: 20 };
    expect(terminalMemoryQuotaWarning([first, second])).toBeNull();

    const pressured = terminalMemoryQuotaWarning([
      { ...first, current_bytes: 121 },
      { ...second, current_bytes: 80 },
    ]);
    expect(pressured).toMatchObject({
      state: "over_allowance",
      current_bytes: 201,
      allowance_bytes: 200,
    });
    expect(pressured?.members.map((member) => member.id)).toEqual([1, 2]);
  });
});

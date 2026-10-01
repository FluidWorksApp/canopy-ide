import { describe, expect, it } from "vitest";
import type { TerminalBudgetStatus } from "./ipc";
import {
  beginGovernorPromptCooldown,
  GOVERNOR_PROMPT_COOLDOWN_MS,
  governorPromptEligible,
  pruneGovernorPromptCooldowns,
} from "./governorPrompt";

const status = (requestId: string, id = 7): TerminalBudgetStatus => ({
  id,
  budget_generation: 1,
  state: "over_allowance",
  base_allowance_bytes: 100,
  granted_bytes: 0,
  remembered_default_bytes: 0,
  allowance_bytes: 100,
  max_allowance_bytes: null,
  current_bytes: 110,
  peak_bytes: 110,
  ema_bytes: 110,
  growth_bytes_per_second: 0,
  samples: 2,
  grant_request: {
    request_id: requestId,
    budget_generation: 1,
    increments: [50],
  },
  stop_request_id: "stop-7",
  cli_key: "bin:quill",
});

describe("governor prompt cooldown", () => {
  it("keeps the shown request open but suppresses a fresh request for that PTY", () => {
    const now = 10_000;
    const cooldowns = beginGovernorPromptCooldown({}, 7, now);
    expect(
      governorPromptEligible(status("shown"), new Set(), cooldowns, "shown", now),
    ).toBe(true);
    expect(
      governorPromptEligible(status("fresh"), new Set(), cooldowns, null, now),
    ).toBe(false);
    expect(
      governorPromptEligible(status("other", 8), new Set(), cooldowns, null, now),
    ).toBe(true);
    expect(
      governorPromptEligible(
        status("fresh"),
        new Set(),
        pruneGovernorPromptCooldowns(cooldowns, now + GOVERNOR_PROMPT_COOLDOWN_MS),
        null,
        now + GOVERNOR_PROMPT_COOLDOWN_MS,
      ),
    ).toBe(true);
  });

  it("waits for the native sustained breach and survives a brief raw dip", () => {
    const notYetSustained = {
      ...status("stale"),
      state: "awaiting_grant" as const,
      current_bytes: 1.5 * 1024 ** 3,
      allowance_bytes: 2 * 1024 ** 3,
      peak_bytes: 4.6 * 1024 ** 3,
    };
    expect(
      governorPromptEligible(notYetSustained, new Set(), {}, null, 10_000),
    ).toBe(false);
    expect(
      governorPromptEligible(
        { ...status("held"), current_bytes: 90 },
        new Set(),
        {},
        null,
        10_000,
      ),
    ).toBe(true);
  });

  it("paces a continuing breach unless current usage is actively growing", () => {
    const now = 10_000;
    const cooldowns = beginGovernorPromptCooldown({}, 7, now);
    expect(governorPromptEligible(status("steady"), new Set(), cooldowns, null, now)).toBe(false);
    const growing = {
      ...status("growing"),
      growth_bytes_per_second: 2 * 1024 ** 2,
    };
    expect(governorPromptEligible(growing, new Set(), cooldowns, null, now)).toBe(false);
    expect(
      governorPromptEligible(growing, new Set(), cooldowns, null, now + 60_000),
    ).toBe(true);
  });
});

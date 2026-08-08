import type {
  TerminalBudgetState,
  TerminalBudgetStatus,
  TerminalGovernorSnapshot,
} from "./ipc";

/** These are the governor states that mean this terminal is currently using a
 * relatively high share of its own allowance. `relief` is intentionally not a
 * warning: the governor has already observed it below the clear watermark. */
export const TERMINAL_MEMORY_WARNING_STATES = new Set<TerminalBudgetState>([
  "warned",
  "awaiting_grant",
  "over_allowance",
]);

export function isTerminalMemoryWarning(
  status: TerminalBudgetStatus | null | undefined,
): status is TerminalBudgetStatus {
  return Boolean(status && TERMINAL_MEMORY_WARNING_STATES.has(status.state));
}

export function terminalGovernorByPty(
  snapshot: TerminalGovernorSnapshot | null | undefined,
): Map<number, TerminalBudgetStatus> {
  return new Map((snapshot?.sessions ?? []).map((status) => [status.id, status]));
}

const severity = (state: TerminalBudgetState): number => {
  switch (state) {
    case "over_allowance": return 3;
    case "awaiting_grant": return 2;
    case "warned": return 1;
    default: return 0;
  }
};

/** A multiplexed visual tab represents several PTYs. Show the strongest live
 * governor state among them, without inventing an aggregate byte threshold. */
export function strongestTerminalMemoryWarning(
  statuses: Array<TerminalBudgetStatus | null | undefined>,
): TerminalBudgetStatus | null {
  return statuses
    .filter(isTerminalMemoryWarning)
    .sort((a, b) => severity(b.state) - severity(a.state))[0] ?? null;
}

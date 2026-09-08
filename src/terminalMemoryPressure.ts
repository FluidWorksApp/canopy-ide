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

export interface TerminalMemoryQuotaGroup {
  members: TerminalBudgetStatus[];
  state: Extract<TerminalBudgetState, "warned" | "awaiting_grant" | "over_allowance">;
  current_bytes: number;
  allowance_bytes: number;
  peak_bytes: number;
}

/** Aggregate the current view without independently reclassifying it. Prompt
 * callers use the native governor's debounced state so one raw dip cannot
 * withdraw a decision that took a sustained breach to open. */
export function terminalMemoryQuotaSummary(
  statuses: Array<TerminalBudgetStatus | null | undefined>,
  state: TerminalMemoryQuotaGroup["state"],
): TerminalMemoryQuotaGroup | null {
  const members = statuses.filter(
    (status): status is TerminalBudgetStatus => status != null,
  );
  if (members.length === 0) return null;
  return {
    members,
    state,
    current_bytes: members.reduce((sum, status) => sum + status.current_bytes, 0),
    allowance_bytes: members.reduce(
      (sum, status) => sum + status.allowance_bytes,
      0,
    ),
    peak_bytes: members.reduce((sum, status) => sum + status.peak_bytes, 0),
  };
}

/** A multiplexed tab is a view over several independently-owned allowances.
 * Its warning compares summed usage with summed allowances; no member's quota
 * is borrowed as a quota for the whole visual tab. Grants remain on `members`. */
export function terminalMemoryQuotaWarning(
  statuses: Array<TerminalBudgetStatus | null | undefined>,
): TerminalMemoryQuotaGroup | null {
  const members = statuses.filter(
    (status): status is TerminalBudgetStatus => status != null,
  );
  if (members.length === 0) return null;
  if (members.length === 1) {
    const member = members[0];
    if (!isTerminalMemoryWarning(member)) return null;
    return terminalMemoryQuotaSummary(
      members,
      member.state as TerminalMemoryQuotaGroup["state"],
    );
  }

  const current_bytes = members.reduce(
    (sum, status) => sum + status.current_bytes,
    0,
  );
  const allowance_bytes = members.reduce(
    (sum, status) => sum + status.allowance_bytes,
    0,
  );
  const allowance = Math.max(1, allowance_bytes);
  const state = current_bytes > allowance
    ? "over_allowance"
    : current_bytes * 100 >= allowance * 90
      ? "awaiting_grant"
      : current_bytes * 100 >= allowance * 75
        ? "warned"
        : null;
  return state == null ? null : terminalMemoryQuotaSummary(members, state);
}

import type { TerminalBudgetStatus } from "./ipc";

export const GOVERNOR_PROMPT_COOLDOWN_MS = 5 * 60 * 1000;
const ACTIVE_GROWTH_BYTES_PER_SECOND = 1024 ** 2;
const GROWING_ESCALATION_MS = 60 * 1000;

export function governorPromptEligible(
  status: TerminalBudgetStatus,
  dismissed: ReadonlySet<string>,
  cooldowns: Readonly<Record<number, number>>,
  activeRequestId: string | null,
  now: number,
): boolean {
  const request = status.grant_request;
  if (request == null || dismissed.has(request.request_id)) return false;
  // State and peak are historical. Only a live breach may ask a question.
  if (status.current_bytes <= status.allowance_bytes) return false;
  if (activeRequestId === request.request_id) return true;
  const cooldownUntil = cooldowns[status.id] ?? 0;
  if (cooldownUntil <= now) return true;
  const shownAt = cooldownUntil - GOVERNOR_PROMPT_COOLDOWN_MS;
  return (
    status.growth_bytes_per_second >= ACTIVE_GROWTH_BYTES_PER_SECOND &&
    now >= shownAt + GROWING_ESCALATION_MS
  );
}

export function beginGovernorPromptCooldown(
  cooldowns: Readonly<Record<number, number>>,
  id: number,
  now: number,
): Record<number, number> {
  return { ...cooldowns, [id]: now + GOVERNOR_PROMPT_COOLDOWN_MS };
}

export function pruneGovernorPromptCooldowns(
  cooldowns: Readonly<Record<number, number>>,
  now: number,
): Record<number, number> {
  return Object.fromEntries(
    Object.entries(cooldowns).filter(([, expiresAt]) => expiresAt > now),
  );
}

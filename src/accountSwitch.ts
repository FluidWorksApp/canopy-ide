// What switching accounts should do to the agents already running.
//
// A conversation cannot move between accounts: its transcript lives inside the
// config directory the session ran under, so `--resume <id>` under a different
// login looks in a store that has never heard of it. "Reload as this account"
// therefore means picking up *that account's* work in the same directory —
// resuming its own newest session there, or starting the CLI fresh when it has
// none — never carrying the old conversation across.
//
// Anything the new account has no login for is left running untouched. Killing
// a working agent to land it at a login prompt would be the worst outcome of
// the two, and the account it is on is still the right one for it.

import type { AccountStatus } from "./ipc";
import type { Restorable } from "./restorable";
import { DEFAULT_PROFILE, supportsProfiles } from "./profiles";

/** An agent terminal that is open right now. */
export interface OpenAgent {
  tabId: string;
  agentId: string;
  cwd: string;
  /** What the tab is called, for the confirmation list. */
  label: string;
}

export type ReloadAction =
  /** The account has its own session in this directory — reopen that one. */
  | { kind: "resume"; command: string; cwd: string; sessionId: string }
  /** Signed in, but nothing of this account's to reopen here. */
  | { kind: "fresh" };

/** Why an agent is being left alone. */
export type SkipReason = "single-account" | "not-signed-in";

export interface ReloadItem {
  agent: OpenAgent;
  /** Null when the agent is left running exactly as it is. */
  action: ReloadAction | null;
  reason?: SkipReason;
}

/**
 * What a switch to `profile` would do to each open agent.
 *
 * Pure: the caller supplies what is open, who is signed in there, and every
 * session on disk. Nothing here reads state or spawns anything.
 */
export function reloadPlan(opts: {
  open: OpenAgent[];
  /** Sign-in state per CLI *in the account being switched to*. */
  accounts: AccountStatus[];
  restorables: Restorable[];
  profile: string;
}): ReloadItem[] {
  const { open, accounts, restorables, profile } = opts;
  return open.map((agent) => {
    if (!supportsProfiles(agent.agentId)) {
      return { agent, action: null, reason: "single-account" as const };
    }
    // "unknown" counts as not signed in: reloading into an account we cannot
    // confirm holds a login risks killing a working agent for a login prompt.
    const state = accounts.find((a) => a.agent === agent.agentId)?.state;
    if (state !== "in") {
      return { agent, action: null, reason: "not-signed-in" as const };
    }
    const mine = restorables
      .filter(
        (r) =>
          r.agentId === agent.agentId &&
          (r.profile || DEFAULT_PROFILE) === profile &&
          r.cwd === agent.cwd,
      )
      .sort((a, b) => (b.digest.updated ?? 0) - (a.digest.updated ?? 0))[0];
    return {
      agent,
      action: mine
        ? {
            kind: "resume" as const,
            command: mine.command,
            cwd: mine.cwd,
            sessionId: mine.digest.session_id,
          }
        : { kind: "fresh" as const },
    };
  });
}

/** Agents the plan would actually touch. */
export const reloading = (plan: ReloadItem[]) => plan.filter((p) => p.action);

/** One line per agent for the confirmation dialog. */
export function reloadSummary(item: ReloadItem): string {
  if (!item.action) {
    return item.reason === "single-account"
      ? "can't hold a second login — left as is"
      : "no login in this account — left as is";
  }
  return item.action.kind === "resume"
    ? "reopens this account's session here"
    : "starts fresh here";
}

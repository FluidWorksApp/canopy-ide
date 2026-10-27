// Carrying a plan's id into the agent session that runs it.
//
// A plan is written before its agent exists. The link between the two used to
// be guessed — the brief's `[Canopy plan <id>]` mark when the prompt reached
// the hook, else "the first turn in that folder within ten minutes" — and a
// brief parked in a file, or two dispatches into one checkout, broke the guess.
//
// Now the id rides in the agent's environment: every launch of planned work
// sets CANOPY_PLAN_ID, canopy-hook stamps it on each event it publishes
// (`canopy_plan_id`), and the turn events carry it (agentTurns.ts `planId`).
// Launch surfaces mostly know only the command line they are about to run, so
// `startCommandParked` notes which command carries which plan, and the
// terminal launcher asks for that command's env here.
//
// Pure and synchronous: imported by agentSeed.ts and ProjectView's launchers.

import { PLAN_ID, planIdInPrompt } from "./plan";

export const PLAN_ENV = "CANOPY_PLAN_ID";

/** The env a planned launch adds; empty for anything else. */
export function planEnv(planId: string | null | undefined): [string, string][] {
  return planId && PLAN_ID.test(planId) ? [[PLAN_ENV, planId]] : [];
}

/** The plan a brief was planned under, read off the mark planBrief writes. */
export const planIdOfBrief = (brief: string | undefined): string | null => planIdInPrompt(brief);

const byCommand = new Map<string, string>();
const KEEP = 100;

/** `command` starts the agent for `planId` (the command line as typed, which
 *  for a parked brief is only a pointer to the file). */
export function notePlanCommand(command: string, planId: string | null | undefined): void {
  if (!command || !planId || !PLAN_ID.test(planId)) return;
  byCommand.delete(command);
  byCommand.set(command, planId);
  while (byCommand.size > KEEP) byCommand.delete(byCommand.keys().next().value!);
}

/** The env for a command a planned launch is about to run: the noted plan, or
 *  the mark in a command that still carries the whole brief. */
export function planEnvForCommand(command: string | undefined): [string, string][] {
  if (!command) return [];
  return planEnv(byCommand.get(command) ?? planIdInPrompt(command));
}

/** Tests only. */
export function resetPlanLaunchForTests(): void {
  byCommand.clear();
}

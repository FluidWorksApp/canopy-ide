// "Share plan to team": a plan as a team-chat card (cardSchema `plan`), so the
// people the work lands on can read it, comment in its thread and approve it
// before code exists. An approval in the thread flows back to the ledger on
// the author's machine (ChatCard → applyChatApproval), and a launch waiting on
// that approval goes ahead.

import { openShareDialog } from "../shareCards";
import { LIMITS, cleanLine, type PlanCard } from "../teamMessaging/cardSchema";
import type { PlanData } from "./plan";
import { revisePlan } from "./planStore";

const line = (s: string, n: number = LIMITS.planItem) => cleanLine(s, n);
const lines = (xs: string[], max: number) => xs.map((x) => line(x)).filter(Boolean).slice(0, max);

/** The card for a plan, clipped to what the wire schema accepts. */
export function buildPlanCard(plan: PlanData): PlanCard {
  const decisions = plan.decisions
    .map((d) => ({ q: line(d.question), a: line(d.answer || d.recommended || "Undecided") }))
    .filter((d) => d.q && d.a)
    .slice(0, LIMITS.planDecisions);
  const wontDo = lines(plan.wontDo, LIMITS.planWontDo);
  return {
    type: "plan",
    v: 1,
    plan: plan.planId,
    goal: line(plan.goal, LIMITS.planGoal) || "Untitled plan",
    ...(decisions.length ? { decisions } : {}),
    acceptance: lines(plan.acceptance, LIMITS.planChecks),
    ...(wontDo.length ? { wontDo } : {}),
    risk: plan.risk,
    size: plan.size,
  };
}

/** Open the share dialog with this plan; remembers that it was shared. */
export function sharePlan(plan: PlanData): void {
  openShareDialog({ kind: "share", card: buildPlanCard(plan) });
  void revisePlan(plan.dir, plan.planId, () => ({ data: { sharedAt: Date.now() } })).catch(() => {});
}

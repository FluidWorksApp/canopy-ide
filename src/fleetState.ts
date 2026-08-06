// Whether one CLI route is usable right now — the composition Canopy never
// had. Install state, sign-in state, plan headroom and integration health each
// exist today, read by three different surfaces that never agree; this module
// folds one route's signals into a single verdict so the launcher, the router
// and the fleet table all answer from the same place.
//
// Pure by construction: callers fetch the inputs (ipc.profileAccounts,
// ipc.planUsage, ipc.agentIntegrationHealth, checkInstalledClis) and hand them
// in. Nothing here polls, caches or invokes.

import type { AccountStatus, IntegrationHealth, PlanUsage } from "./ipc";
import { CRITICAL_PERCENT, WARN_PERCENT } from "./planUsage";

export interface FleetInputs {
  agent: string;
  profile: string;
  installed: boolean;
  /** The account row for this agent under this profile, when one was fetched.
   *  Absent means the probe was not run, not that the user is signed out. */
  account?: AccountStatus;
  /** This route's plan row (planFor already matches agent+profile). */
  plan?: PlanUsage | null;
  health?: IntegrationHealth;
}

/** Why a route is not simply ready. Structured so the UI can word and mute
 *  each one deliberately — a permanently `auth-unknown` CLI is not news the
 *  way `plan-critical` is. */
export type FleetReason =
  | "not-installed"
  | "signed-out"
  | "auth-unknown"
  | "plan-critical"
  | "plan-warn"
  | "plan-stale"
  | "integration-unhealthy";

export const FLEET_REASON_LABELS: Record<FleetReason, string> = {
  "not-installed": "not installed",
  "signed-out": "signed out",
  "auth-unknown": "sign-in state unknown",
  "plan-critical": "plan nearly spent",
  "plan-warn": "plan running low",
  "plan-stale": "usage reading is stale",
  "integration-unhealthy": "Canopy integration needs repair",
};

/** ready — launch freely (cautions are notes, not objections).
 *  degraded — launchable, but the router should prefer another route.
 *  unusable — launching cannot work; the gate refuses. */
export type FleetKind = "ready" | "degraded" | "unusable";

export interface FleetState {
  agent: string;
  profile: string;
  kind: FleetKind;
  /** Why, worst first. Empty exactly when kind is "ready" with nothing to say. */
  reasons: FleetReason[];
}

/** A rate-limited request returns no limit headers, so a reading goes stale
 *  precisely when the user is blocked. A critical reading that has also gone
 *  quiet for this long is the out-of-tokens signature, not a coincidence. */
const STALE_SECS = 30 * 60;

function planReasons(plan: PlanUsage | null | undefined, now: number): FleetReason[] {
  if (!plan || plan.windows.length === 0) return [];
  const worst = Math.max(0, ...plan.windows.map((w) => w.used_percent));
  const stale = now / 1000 - plan.observed >= STALE_SECS;
  const out: FleetReason[] = [];
  if (worst >= CRITICAL_PERCENT) out.push("plan-critical");
  else if (worst >= WARN_PERCENT) out.push("plan-warn");
  if (stale && worst >= WARN_PERCENT) out.push("plan-stale");
  return out;
}

function healthUnhealthy(h: IntegrationHealth | undefined): boolean {
  if (!h) return false;
  const bad = (s: string) => s === "missing" || s === "foreign" || s === "unreadable";
  return bad(h.hooks) || bad(h.mcp);
}

/** The one verdict. Severity order: a missing binary or a signed-out account
 *  makes every other signal moot; a nearly-spent plan or an unverifiable
 *  sign-in demotes the route without forbidding it; everything else rides
 *  along as a reason on a still-ready route. */
export function fleetState(inputs: FleetInputs, now = Date.now()): FleetState {
  const { agent, profile } = inputs;
  const state = (kind: FleetKind, reasons: FleetReason[]): FleetState => ({
    agent,
    profile,
    kind,
    reasons,
  });

  if (!inputs.installed) return state("unusable", ["not-installed"]);
  if (inputs.account?.state === "out") return state("unusable", ["signed-out"]);

  const reasons: FleetReason[] = [];
  const plan = planReasons(inputs.plan, now);
  reasons.push(...plan);
  if (inputs.account?.state === "unknown") reasons.push("auth-unknown");
  if (healthUnhealthy(inputs.health)) reasons.push("integration-unhealthy");

  // plan-critical or an unverifiable sign-in demote; warn-level notes do not.
  const demoted = plan.includes("plan-critical") || inputs.account?.state === "unknown";
  return state(demoted ? "degraded" : "ready", reasons);
}

/** The launch gate: refuses only what cannot work. Degraded routes launch —
 *  the demotion is the router's business, not the user's obstacle. */
export function fleetGate(s: FleetState): { allowed: boolean; why: string | null } {
  if (s.kind !== "unusable") {
    const note = s.reasons[0];
    return { allowed: true, why: note ? FLEET_REASON_LABELS[note] : null };
  }
  return { allowed: false, why: s.reasons.map((r) => FLEET_REASON_LABELS[r]).join(", ") };
}

const KIND_RANK: Record<FleetKind, number> = { ready: 0, degraded: 1, unusable: 2 };

/** Router ordering: ready before degraded before unusable, fewer objections
 *  first within a tier. Stable beyond that — the caller's list order stands,
 *  so a deliberate default (the user's chosen CLI first) survives the sort. */
export function rankFleet(states: FleetState[]): FleetState[] {
  return [...states].sort(
    (a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.reasons.length - b.reasons.length,
  );
}

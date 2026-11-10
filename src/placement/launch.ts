// Glue between the stored preferences and choosePlacement, so every launch
// surface asks the same question the same way.
import { choosePlacement } from "./balancer";
import {
  getAgentPreference,
  getGlobalPreference,
  getProjectPreference,
} from "./preferences";
import {
  sameTarget,
  type DisplayTarget,
  type PlacementDecision,
  type Preference,
  type ResourceSnapshot,
  type Target,
} from "./types";

export interface LaunchQuery {
  projectId: string;
  agentKind: string;
  resources: ResourceSnapshot[];
  /** A choice made in this launch dialog overrides stored defaults. */
  requested?: Preference;
  /** Targets the project is known to be set up on (local is implied). */
  availability?: Target[];
  /** Names gathered alongside resources, used by actionable transitions. */
  targets?: DisplayTarget[];
  sticky?: Target;
  /** See PlacementInput.noLocalFallback (hand-offs). */
  noLocalFallback?: boolean;
}

export function decideLaunch(query: LaunchQuery): PlacementDecision {
  const decision = choosePlacement({
    preference: getGlobalPreference(),
    projectPref: getProjectPreference(query.projectId),
    agentPref: query.requested ?? getAgentPreference(query.agentKind),
    resources: query.resources,
    projectAvailability: query.availability,
    sticky: query.sticky,
    noLocalFallback: query.noLocalFallback,
  });
  const targetName = decision.target
    ? query.targets?.find((item) => sameTarget(item.target, decision.target as Target))?.name
    : undefined;
  return targetName ? { ...decision, targetName } : decision;
}

/** Re-dispatch a task somewhere other than where it is: the same decision with
 * the current target taken out of the running. */
export function decideHandoff(query: LaunchQuery & { from: Target }): PlacementDecision {
  return decideLaunch({
    ...query,
    sticky: undefined,
    noLocalFallback: true,
    resources: query.resources.filter((resource) => !sameTarget(resource.target, query.from)),
  });
}

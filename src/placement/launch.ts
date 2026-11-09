// Glue between the stored preferences and choosePlacement, so every launch
// surface asks the same question the same way.
import { choosePlacement } from "./balancer";
import {
  getAgentPreference,
  getGlobalPreference,
  getProjectPreference,
} from "./preferences";
import { sameTarget, type PlacementDecision, type ResourceSnapshot, type Target } from "./types";

export interface LaunchQuery {
  projectId: string;
  agentKind: string;
  resources: ResourceSnapshot[];
  /** Targets the project is known to be set up on (local is implied). */
  availability?: Target[];
  sticky?: Target;
}

export function decideLaunch(q: LaunchQuery): PlacementDecision {
  return choosePlacement({
    preference: getGlobalPreference(),
    projectPref: getProjectPreference(q.projectId),
    agentPref: getAgentPreference(q.agentKind),
    resources: q.resources,
    projectAvailability: q.availability,
    sticky: q.sticky,
  });
}

/** Re-dispatch a task somewhere other than where it is: the same decision with
 *  the current target taken out of the running. */
export function decideHandoff(q: LaunchQuery & { from: Target }): PlacementDecision {
  return decideLaunch({
    ...q,
    sticky: undefined,
    resources: q.resources.filter((r) => !sameTarget(r.target, q.from)),
  });
}

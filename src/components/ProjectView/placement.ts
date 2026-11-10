import { decideLaunch } from "../../placement/launch";
import { effectivePreference } from "../../placement/balancer";
import { getAgentPreference, getGlobalPreference, getProjectPreference } from "../../placement/preferences";
import { canLaunchOnActiveTarget } from "../../placement/transitions";
import type { Gathered } from "../../placement/gather";
import type { PlacementDecision, Preference, Target } from "../../placement/types";
import { sameTarget } from "../../placement/types";

export type ProjectMachineLaunchOutcome =
  | { kind: "launch"; decision: PlacementDecision }
  | { kind: "setup"; decision: PlacementDecision; name: string }
  | { kind: "transition"; target: Target; name: string }
  | { kind: "refusal"; reason: string };

interface ProjectMachineLaunchInput {
  project: { id: string; name: string };
  agentKind: string;
  requested: Preference;
  gather?: () => Promise<Gathered>;
  canLaunch?: (target: Target) => boolean;
}

/** One fresh placement check immediately before ProjectView dispatches. */
export async function resolveProjectMachineLaunch({
  project,
  agentKind,
  requested,
  gather = async () => (await import("../../placement/gather")).gatherUnified(),
  canLaunch = canLaunchOnActiveTarget,
}: ProjectMachineLaunchInput): Promise<ProjectMachineLaunchOutcome> {
  // Where this launch is headed, before anything is read. If that is this Mac,
  // being unable to read the other machines must not stop it: they only matter
  // for choosing among them or setting a project up on one.
  const local: Target = { kind: "local" };
  const wanted = effectivePreference({
    preference: getGlobalPreference(),
    projectPref: getProjectPreference(project.id),
    agentPref: requested ?? getAgentPreference(agentKind),
  });
  const headedForThisMac = wanted.mode === "automatic" || (wanted.mode === "target" && sameTarget(wanted.target, local));
  const startHere = async (why: string): Promise<ProjectMachineLaunchOutcome> => {
    const decision: PlacementDecision = {
      target: local,
      reason: "Starting on this Mac.",
      alternatives: [],
      needsSetup: false,
      targetName: "This Mac",
      warning: `${why} Starting on this Mac.`,
    };
    return canLaunch(local) ? { kind: "launch", decision } : { kind: "transition", target: local, name: "This Mac" };
  };

  let gathered: Gathered;
  try {
    gathered = await gather();
  } catch (error) {
    const reason = `Could not read connected machines: ${String((error as { message?: string })?.message ?? error)}`;
    return headedForThisMac ? startHere(reason) : { kind: "refusal", reason };
  }
  if (gathered.discoveryFailures.length) {
    const reason = gathered.discoveryFailures.join(" ");
    return headedForThisMac ? startHere(reason) : { kind: "refusal", reason };
  }
  const { projectAvailability } = await import("../../placement/gather");
  const decision = decideLaunch({
    projectId: project.id,
    agentKind,
    resources: gathered.resources,
    requested,
    availability: projectAvailability(gathered.rows, project),
    targets: gathered.targets,
  });
  if (!decision.target) return { kind: "refusal", reason: decision.reason };
  const name = decision.targetName ?? (decision.target.kind === "local" ? "This Mac" : "the selected machine");
  if (!canLaunch(decision.target)) return { kind: "transition", target: decision.target, name };
  if (decision.target.kind === "remote" && decision.needsSetup)
    return { kind: "setup", decision, name };
  return { kind: "launch", decision };
}

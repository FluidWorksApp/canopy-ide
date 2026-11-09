import { decideLaunch } from "../../placement/launch";
import { canLaunchOnActiveTarget } from "../../placement/transitions";
import type { Gathered } from "../../placement/gather";
import type { PlacementDecision, Preference, Target } from "../../placement/types";

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
  let gathered: Gathered;
  try {
    gathered = await gather();
  } catch (error) {
    return {
      kind: "refusal",
      reason: `Could not read connected machines: ${String((error as { message?: string })?.message ?? error)}`,
    };
  }
  if (gathered.discoveryFailures.length) {
    return { kind: "refusal", reason: gathered.discoveryFailures.join(" ") };
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

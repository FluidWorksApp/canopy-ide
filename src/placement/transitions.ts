import { isRemoteHost } from "../host";
import { SHOW_WORKSPACE_EVENT } from "../readableLinks";
import { activeWorkspace } from "../remoteExecution/workspace";
import { setExecutionMode } from "../executionMode";
import { sameTarget, type Target } from "./types";

export const OPEN_T3_MACHINE_EVENT = "canopy:open-t3-machine";
export interface OpenT3MachineDetail { machineId: string }

export function activeExecutionTarget(): Target {
  const workspaceId = isRemoteHost() ? activeWorkspace()?.connection.workspaceId : undefined;
  return workspaceId ? { kind: "remote", workspaceId } : { kind: "local" };
}

export const canLaunchOnActiveTarget = (target: Target) =>
  target.kind !== "t3" && sameTarget(target, activeExecutionTarget());

/** Continue through the surface that owns the selected machine. This function
 * never launches an agent itself. */
export async function requestTargetTransition(target: Target): Promise<void> {
  if (target.kind === "local") {
    if (!canLaunchOnActiveTarget(target)) await setExecutionMode("local");
    return;
  }
  if (target.kind === "remote") {
    window.dispatchEvent(
      new CustomEvent(SHOW_WORKSPACE_EVENT, {
        detail: { workspaceId: target.workspaceId, connect: true },
      }),
    );
    return;
  }
  window.dispatchEvent(
    new CustomEvent<OpenT3MachineDetail>(OPEN_T3_MACHINE_EVENT, {
      detail: { machineId: target.machineId },
    }),
  );
}

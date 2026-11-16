import { isRemoteHost } from "../host";
import { SHOW_WORKSPACE_EVENT } from "../readableLinks";
import { activeWorkspace } from "../remoteExecution/workspace";
import { setExecutionMode } from "../executionMode";
import { sameTarget, type Target } from "./types";

export function activeExecutionTarget(): Target {
  const workspaceId = isRemoteHost() ? activeWorkspace()?.connection.workspaceId : undefined;
  return workspaceId ? { kind: "remote", workspaceId } : { kind: "local" };
}

export const canLaunchOnActiveTarget = (target: Target) => sameTarget(target, activeExecutionTarget());

/** Continue through the surface that owns the selected machine. This function
 * never launches an agent itself. */
export async function requestTargetTransition(target: Target): Promise<void> {
  if (target.kind === "local") {
    if (!canLaunchOnActiveTarget(target)) await setExecutionMode("local");
    return;
  }
  window.dispatchEvent(
    new CustomEvent(SHOW_WORKSPACE_EVENT, {
      detail: { workspaceId: target.workspaceId, connect: true },
    }),
  );
}

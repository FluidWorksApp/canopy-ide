// Everything a cloud workspace keeps in step with this computer on each
// connect: the open projects' Rules policy, its agent hooks and team memory.
// App calls startCloudSync once when the IDE runs against a workspace.
import { isWorkspaceHost } from "../host";
import { activeWorkspace } from "./workspace";
import { onWorkspaceConnect, startWorkspaceSync } from "./workspaceSync";
import { checkWorkspaceHooks, pushWorkspacePolicies } from "./workspaceRules";

export function startCloudSync(roots: () => string[]): () => void {
  const ws = activeWorkspace();
  if (!isWorkspaceHost() || !ws || ws.readOnly) return () => {};
  const offs = [
    onWorkspaceConnect("rules", pushWorkspacePolicies),
    onWorkspaceConnect("hooks", () => checkWorkspaceHooks()),
  ];
  const stop = startWorkspaceSync({ endpoint: ws.connection.endpoint, workspaceId: ws.connection.workspaceId, roots });
  return () => {
    stop();
    offs.forEach((off) => off());
  };
}

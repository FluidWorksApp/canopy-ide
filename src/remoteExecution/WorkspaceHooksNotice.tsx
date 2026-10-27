import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Button } from "../components/ui";
import { agentCliFor } from "../projects";
import "./workspace.css";
import {
  dismissWorkspaceHooks,
  subscribeWorkspaceHooks,
  updateWorkspaceHooks,
  workspaceHooksState,
} from "./workspaceRules";

const names = (agents: string[]) => agents.map((a) => agentCliFor(a)?.name ?? a).join(" and ");

/** Offers a one-click hook update when the workspace's agent hooks are older
 *  than this app: without them, Rules gates never run in the workspace. */
export function WorkspaceHooksNotice() {
  const hooks = useSyncExternalStore(subscribeWorkspaceHooks, workspaceHooksState);
  if (hooks.state === "unknown" || hooks.state === "current") return null;
  const title =
    hooks.state === "updated"
      ? "Agent hooks updated"
      : hooks.state === "failed"
        ? `Couldn't update the agent hooks for ${names(hooks.agents)}`
        : `This workspace's agent hooks for ${names(hooks.agents)} need updating`;
  const detail =
    hooks.state === "updated"
      ? "Agents you start from now on use them. Restart running agents to pick them up."
      : hooks.state === "failed"
        ? hooks.summary
        : "Until they're updated, rules you approved aren't enforced in this workspace, and some agent activity isn't tracked.";
  return createPortal(
    <aside className="workspace-progress-float" aria-label="Agent hooks">
      <div className="workspace-progress-line">
        <span className="workspace-progress-dot" aria-hidden="true" />
        <strong>{title}</strong>
        {hooks.state === "updating" && <span role="status">Updating…</span>}
      </div>
      <div className="workspace-progress-meta">
        <small>{detail}</small>
        <div className="workspace-inline-actions">
          {(hooks.state === "outdated" || hooks.state === "failed") && (
            <Button size="sm" onClick={() => void updateWorkspaceHooks()}>
              {hooks.state === "failed" ? "Try again" : "Update agent hooks"}
            </Button>
          )}
          {hooks.state !== "updating" && (
            <Button size="sm" onClick={dismissWorkspaceHooks}>
              {hooks.state === "updated" ? "Done" : "Not now"}
            </Button>
          )}
        </div>
      </div>
    </aside>,
    document.body,
  );
}

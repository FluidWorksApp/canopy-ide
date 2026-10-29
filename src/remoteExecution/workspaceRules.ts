// Rules and agent hooks for a cloud workspace, kept current on every connect
// (workspaceSync.ts runs these).
//
// The Rules panel publishes a project's policy when it loads, but a workspace
// whose agents start before anyone opens that panel would run them against an
// old policy — or none. So each connect writes every open project's approved
// policy into the VM (gates_policy_write, routed to the host), where the
// agents' hook reads it.
//
// A gate is only as good as the hook that runs it: a workspace set up before
// the Rules panel existed registered no PreToolUse hook for Claude Code, and
// its gates never fire. The host's agent_integration_health reports that as
// hooks "missing"; this module keeps that answer in a small store the
// workspace's "Update agent hooks" notice reads.
import * as ipc from "../ipc";
import { loadRules, publishPolicy } from "../gates/rules";

/** Write each project's current policy where the workspace's hook reads it. */
export async function pushWorkspacePolicies(roots: string[]): Promise<void> {
  for (const root of [...new Set(roots)]) {
    try {
      await publishPolicy(root, await loadRules(root));
    } catch {
      // One unreadable ledger or a missing directory costs that project only.
    }
  }
}

export type HooksState =
  | { state: "unknown" }
  | { state: "current" }
  /** Hooks for these CLIs are missing or predate the Rules gates. */
  | { state: "outdated"; agents: string[] }
  | { state: "updating"; agents: string[] }
  | { state: "updated"; summary: string }
  | { state: "failed"; agents: string[]; summary: string };

let hooks: HooksState = { state: "unknown" };
let dismissed = false;
const listeners = new Set<() => void>();
const set = (next: HooksState) => {
  hooks = next;
  listeners.forEach((fn) => fn());
};

// One object, not a fresh literal per call: useSyncExternalStore compares
// snapshots by identity, and a new object each read re-renders forever.
const DISMISSED: HooksState = { state: "unknown" };
export const workspaceHooksState = () => (dismissed ? DISMISSED : hooks);
export function subscribeWorkspaceHooks(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Ask the host whether the VM's agent hooks are current. Only CLIs that are
 *  installed in the VM count: a missing CLI has nothing to update. */
export async function checkWorkspaceHooks(): Promise<HooksState> {
  if (hooks.state === "updating") return hooks;
  try {
    const health = await ipc.agentIntegrationHealth();
    const agents = health.filter((h) => h.cli_installed && h.hooks !== "ours").map((h) => h.agent);
    set(agents.length ? { state: "outdated", agents } : { state: "current" });
  } catch {
    set({ state: "unknown" });
  }
  return hooks;
}

/** The notice's one click: rewrite the hooks for every outdated CLI. */
export async function updateWorkspaceHooks(): Promise<void> {
  if (hooks.state !== "outdated" && hooks.state !== "failed") return;
  const agents = hooks.agents;
  set({ state: "updating", agents });
  const failed: string[] = [];
  const lines: string[] = [];
  for (const agent of agents) {
    try {
      const report = await ipc.setupAgentHooks(agent);
      if (!report.ok) failed.push(agent);
      lines.push(report.summary);
    } catch (e) {
      failed.push(agent);
      lines.push(String(e instanceof Error ? e.message : e));
    }
  }
  const summary = lines.join(" ");
  set(failed.length ? { state: "failed", agents: failed, summary } : { state: "updated", summary });
}

export function dismissWorkspaceHooks(): void {
  dismissed = true;
  listeners.forEach((fn) => fn());
}

/** Tests only. */
export function resetWorkspaceHooksForTests(): void {
  hooks = { state: "unknown" };
  dismissed = false;
  listeners.clear();
}

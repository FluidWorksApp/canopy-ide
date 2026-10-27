// What a Linux (cloud) workspace can and cannot do, for the commands that are
// not simply routed to its host. docs/linux-workspace-parity.md explains each
// decision; remoteParity.test.ts fails when a new invoke() command is in none
// of these lists, so a gap shows up in review instead of as a user's toast.
import { isNativeCommand } from "../../packages/remote-host/native-commands.mjs";

/** Category (d): features a cloud workspace deliberately does not offer. The
 *  host refuses them before any network call, with this message, and the UI
 *  that would offer them hides or disables itself (isRemoteUnsupported). */
const UNSUPPORTED: Record<string, string> = {};
const unsupported = (feature: string, commands: string[]) => {
  for (const command of commands) UNSUPPORTED[command] = feature;
};
// The embedded native webview lives in the desktop window and can only load
// pages this computer can reach. A workspace replaces it: previews stream a
// browser running in the VM (chrome_stream_open → workspace_chrome_stream_open)
// and browser_supported answers false, so these are never sent; refusing them
// keeps a stray call from reaching either machine.
unsupported("The built-in native browser", [
  "browser_open", "browser_close", "browser_navigate", "browser_set_bounds", "browser_set_visible",
  "browser_command", "browser_run_op", "browser_snapshot", "browser_frame", "browser_here",
  "browser_painted", "browser_clear_data",
]);
// Showing a VM path in this computer's file manager cannot work; the menu
// items that offer it are hidden in a workspace (isRemoteUnsupported).
unsupported("Reveal in file manager", ["fs_reveal"]);
export const UNSUPPORTED_REMOTE: ReadonlySet<string> = new Set(Object.keys(UNSUPPORTED));
export const isRemoteUnsupported = (command: string) => Object.hasOwn(UNSUPPORTED, command);
export const remoteUnsupportedMessage = (command: string) =>
  `${UNSUPPORTED[command] ?? "This feature"} isn't available in a cloud workspace.`;

/** Readable names for the features behind host commands, for the one message a
 *  person sees when their workspace runs an older host than this app. */
const FEATURES: [string, string][] = [
  ["gh_", "GitHub pull requests and issues"],
  ["git_worktree_", "agent worktrees"],
  ["git_sync_", "branch sync"],
  ["git_", "this Git action"],
  ["task_", "agent tasks"],
  ["workflow_", "workflows"],
  ["turn_", "undo turn"],
  ["provenance_", "pull request history"],
  ["research_", "research"],
  ["instructions_", "agent instructions"],
  ["cleanup_", "disk cleanup"],
  ["agent_", "the agent changes panel"],
  ["context_", "agent claims and messages"],
];
export const hostFeatureName = (command: string) =>
  FEATURES.find(([prefix]) => command.startsWith(prefix))?.[1] ?? command.replaceAll("_", " ");

export const HOST_OUTDATED_EVENT = "canopy:workspace-host-outdated";
export const hostOutdatedMessage = (command?: string) =>
  `This workspace is running an older Canopy host. Restart or update the workspace to use ${command ? hostFeatureName(command) : "everything in this version of Canopy"}.`;

/** The command an "unsupported command" answer names, when it is one a current
 *  host serves: then the workspace host is older than this app, not lacking
 *  the feature. */
export function outdatedHostCommand(error: unknown): string | null {
  const command = /does not support (\S+) yet/.exec(String(error))?.[1];
  return command && isNativeCommand(command) ? command : null;
}

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
// pages this computer can reach; workspace previews stream a browser running
// in the VM instead (chrome_stream_open → workspace_chrome_stream_open).
unsupported("The built-in native browser", [
  "browser_open", "browser_close", "browser_navigate", "browser_set_bounds", "browser_set_visible",
  "browser_command", "browser_run_op", "browser_snapshot", "browser_frame", "browser_here",
  "browser_painted", "browser_clear_data",
]);
// Showing a VM path in this computer's file manager cannot work.
unsupported("Reveal in file manager", ["fs_reveal"]);
// The desktop's per-terminal memory budgets have no equivalent: one cgroup
// limit covers the whole workspace (terminal_governor_status says monitor_only).
unsupported("Per-terminal memory budgets", [
  "terminal_governor_grant", "terminal_governor_stop", "terminal_governor_remember_default",
  "terminal_governor_set_memory_maximum",
]);
// Peer-to-peer LAN sessions are hosted by the desktop app; a workspace is
// shared through its own members and links instead (relay_status reports off).
unsupported("LAN relay sessions", [
  "relay_host_start", "relay_host_stop", "relay_connect", "relay_disconnect", "relay_regenerate_code",
  "relay_send_chat", "relay_send_collab", "relay_send_command", "relay_offer_file", "relay_accept_file",
]);
// Building and installing needs the Android SDK next to the project; the VM
// image has none, and the devices are attached to the person's computer.
unsupported("Running Android apps", ["android_run", "android_describe"]);

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

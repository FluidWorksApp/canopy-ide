// Every command the IDE invokes must have a known home in a Linux workspace:
// served by the workspace host, answered by NativeWorkspaceHost itself, run on
// the desktop (LOCAL_UI), or deliberately unsupported with a message. A new
// invoke("…") that is none of these would reach the user as "The Linux
// workspace does not support … yet" — this test fails first instead.
// docs/linux-workspace-parity.md records why each command sits where it does.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isNativeCommand } from "../../packages/remote-host/native-commands.mjs";
import { WORKSPACE_ADAPTER_COMMANDS, isDesktopLocal } from "./NativeWorkspaceHost";
import { UNSUPPORTED_REMOTE } from "./remoteSupport";
import { isHarnessCommand } from "./harnessCommands";

/** Invoked only through `@tauri-apps/api/core` directly (never the workspace
 *  host): the account, workspace switcher and sign-in plumbing of the desktop. */
const DESKTOP_DIRECT = new Set([
  "execution_remote_account_candidates", "execution_remote_activate", "execution_remote_forget",
  "execution_remote_import_accounts", "execution_remote_list", "execution_remote_login_prepare",
  "canopy_account_cache_key",
]);
/** Callers that branch on isRemoteHost() and never send this command to a
 *  workspace (the remote branch asks something else). */
const REMOTE_BRANCHED = new Set([
  "app_stats", // workspace_metrics remotely (ipc.ts)
  // The preview proxy only serves the proxy engine; previewEngine() picks the
  // workspace's Chrome stream for every web page in a workspace.
  "preview_start", "preview_stop",
  // onPtyExit/onPtySpawned listen for the adapter's pty:exit/pty:spawned events
  // remotely instead of polling for them (ipc.ts).
  "pty_renderer_events",
]);

const SRC = join(__dirname, "..");
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.harness\.|\.d\.ts$/.test(name)) out.push(path);
  }
  return out;
}
/** `invoke("name"` / `invoke<T>("name"` — not invokeDesktop, which always
 *  reaches the desktop. */
function invokedCommands() {
  const found = new Map<string, string>();
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\binvoke\s*(?:<[^()]*?>)?\(\s*["'`]([a-z][a-z0-9_]*)["'`]/g))
      if (!found.has(match[1])) found.set(match[1], file.slice(SRC.length + 1));
  }
  return found;
}

describe("Linux workspace command coverage", () => {
  const invoked = invokedCommands();
  it("finds the IDE's commands", () => {
    expect(invoked.size).toBeGreaterThan(300);
  });
  it("gives every invoked command a home in a workspace", () => {
    const adapter = new Set<string>(WORKSPACE_ADAPTER_COMMANDS);
    const homeless = [...invoked]
      .filter(([command]) =>
        !isNativeCommand(command) && !adapter.has(command) && !isDesktopLocal(command) &&
        !UNSUPPORTED_REMOTE.has(command) && !isHarnessCommand(command) && !DESKTOP_DIRECT.has(command) && !REMOTE_BRANCHED.has(command))
      .map(([command, file]) => `${command} (${file})`)
      .sort();
    expect(homeless).toEqual([]);
  });
  // A host may still answer a command that later moved to the desktop (an
  // older app sends it there); an unsupported one must have no other home.
  it("never marks a served command unsupported", () => {
    const both = [...UNSUPPORTED_REMOTE].filter((command) => isNativeCommand(command) || isDesktopLocal(command));
    expect(both).toEqual([]);
  });
  it("lists only commands the adapter really handles", () => {
    const body = readFileSync(join(__dirname, "NativeWorkspaceHost.ts"), "utf8").split("async invoke<T>")[1];
    for (const command of WORKSPACE_ADAPTER_COMMANDS) expect(body, command).toContain(`'${command}'`);
  });
});

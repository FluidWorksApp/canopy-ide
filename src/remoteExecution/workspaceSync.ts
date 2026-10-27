// What a cloud workspace needs from this computer each time the IDE connects
// to it — on first connect and again after every reconnect, not only when a
// panel that owns the data happens to open:
//
//  - each open project's approved Rules policy, written into the VM where the
//    agents' hook reads it (gates/rules.ts publishPolicy);
//  - approved team memory, copied to the workspace's Canopy service so its
//    agents' canopy_memory answers from it, and their proposals brought back
//    to the ledger here (memorySync.ts);
//  - whether the VM's agent hooks are current: a workspace set up before the
//    Rules panel existed has no PreToolUse gate, so it is offered a one-click
//    update (WorkspaceHooksNotice).
//
// Every task is best effort and independent: one failing never stops another,
// and none of them blocks the IDE.
import { connectionKey, connectionStateOf, subscribeConnectionStates } from "./connectionState";

export type ConnectTask = (roots: string[]) => Promise<unknown>;

const tasks = new Map<string, ConnectTask>();

/** Register (or replace) something to run on every connect. */
export function onWorkspaceConnect(name: string, task: ConnectTask): () => void {
  tasks.set(name, task);
  return () => {
    if (tasks.get(name) === task) tasks.delete(name);
  };
}

/** Run every task now. Resolves once all have settled. */
export async function runWorkspaceConnectTasks(roots: string[]): Promise<void> {
  await Promise.all([...tasks.values()].map((task) => task(roots).catch(() => {})));
}

/** Start syncing a workspace connection: once now, then whenever it goes
 *  from not-connected back to connected. `roots` lists the open projects'
 *  directories at the time of each run. */
export function startWorkspaceSync(opts: {
  endpoint: string;
  workspaceId: string;
  roots: () => string[];
  /** Tests: a debounce shorter than the real one. */
  settleMs?: number;
}): () => void {
  const key = connectionKey(opts.endpoint, opts.workspaceId);
  let wasConnected = connectionStateOf(key).phase === "connected";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const schedule = () => {
    clearTimeout(timer);
    // A reconnect flaps a few times as streams come back; run once it settles.
    timer = setTimeout(() => {
      if (!stopped) void runWorkspaceConnectTasks(opts.roots());
    }, opts.settleMs ?? 2000);
  };
  schedule();
  const off = subscribeConnectionStates(() => {
    const connected = connectionStateOf(key).phase === "connected";
    if (connected && !wasConnected) schedule();
    wasConnected = connected;
  });
  return () => {
    stopped = true;
    clearTimeout(timer);
    off();
  };
}

// Typed calls for the T3 methods Canopy uses, over the generic RPC client.
import type { StreamHandle, T3RpcClient } from "./rpc";
import {
  T3_METHODS,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type OrchestrationV2ShellStreamItem,
  type ProjectListEntriesInput,
  type ProjectListEntriesResult,
  type ProjectReadFileInput,
  type ProjectReadFileResult,
  type ProjectSearchEntriesInput,
  type ProjectSearchEntriesResult,
  type ProjectWriteFileInput,
  type ProjectWriteFileResult,
  type ServerConfig,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalCloseInput,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalSessionSnapshot,
  type TerminalWriteInput,
} from "./contracts";

export const t3 = {
  getConfig: (rpc: T3RpcClient) => rpc.call<ServerConfig>(T3_METHODS.serverGetConfig, {}),
  listEntries: (rpc: T3RpcClient, input: ProjectListEntriesInput) =>
    rpc.call<ProjectListEntriesResult>(T3_METHODS.projectsListEntries, input),
  searchEntries: (rpc: T3RpcClient, input: ProjectSearchEntriesInput) =>
    rpc.call<ProjectSearchEntriesResult>(T3_METHODS.projectsSearchEntries, input),
  readFile: (rpc: T3RpcClient, input: ProjectReadFileInput) =>
    rpc.call<ProjectReadFileResult>(T3_METHODS.projectsReadFile, input),
  writeFile: (rpc: T3RpcClient, input: ProjectWriteFileInput) =>
    rpc.call<ProjectWriteFileResult>(T3_METHODS.projectsWriteFile, input),
  terminalOpen: (rpc: T3RpcClient, input: TerminalOpenInput) =>
    rpc.call<TerminalSessionSnapshot>(T3_METHODS.terminalOpen, input),
  terminalAttach: (rpc: T3RpcClient, input: TerminalAttachInput, onEvent: (event: TerminalAttachStreamEvent) => void | Promise<void>): StreamHandle =>
    rpc.stream<TerminalAttachStreamEvent>(T3_METHODS.terminalAttach, input, async values => {
      for (const value of values) await onEvent(value);
    }),
  terminalWrite: (rpc: T3RpcClient, input: TerminalWriteInput) => rpc.call<void>(T3_METHODS.terminalWrite, input),
  terminalResize: (rpc: T3RpcClient, input: TerminalResizeInput) => rpc.call<void>(T3_METHODS.terminalResize, input),
  terminalClose: (rpc: T3RpcClient, input: TerminalCloseInput) => rpc.call<void>(T3_METHODS.terminalClose, input),
};

/** The projects the web app lists: orchestration.subscribeShell's first
 *  snapshot (apps/web reads its shell state the same way). Resolves with the
 *  snapshot's projects, unarchived, and ends the subscription. */
export function listProjects(rpc: T3RpcClient): Promise<OrchestrationProjectShell[]> {
  return listShell(rpc).then(shell => shell.projects);
}

/** Projects and threads from the same first snapshot. Threads without a string
 *  id are dropped; archived ones are hidden like archived projects. */
export function listShell(rpc: T3RpcClient): Promise<{ projects: OrchestrationProjectShell[]; threads: OrchestrationThreadShell[] }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const handle = rpc.stream<OrchestrationV2ShellStreamItem>(T3_METHODS.subscribeShell, {}, values => {
      for (const item of values) {
        if (settled || item.kind !== "snapshot") continue;
        settled = true;
        const snapshot = (item as Extract<OrchestrationV2ShellStreamItem, { kind: "snapshot" }>).snapshot;
        resolve({
          projects: snapshot.projects.filter(project => !project.archivedAt),
          threads: (Array.isArray(snapshot.threads) ? snapshot.threads : []).filter(t => t && typeof t.id === "string" && !t.archivedAt),
        });
        handle.cancel();
      }
    });
    handle.done.then(
      () => { if (!settled) { settled = true; reject(new Error("The shell subscription ended without a snapshot")); } },
      error => { if (!settled) { settled = true; reject(error); } },
    );
  });
}

/** T3 terminals belong to a thread id the client picks (TerminalThreadInput);
 *  Canopy's own terminals use one fixed id per machine so they never mix with
 *  a T3 thread's terminals. */
export const CANOPY_TERMINAL_THREAD_ID = "canopy";

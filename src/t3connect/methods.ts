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
  type RuntimeMode,
  type ServerProvider,
  type ThreadCommand,
  type ThreadLaunchInput,
  type ThreadLaunchResult,
  type ThreadProjection,
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
  /** Needs `orchestration:operate`. */
  launchThread: (rpc: T3RpcClient, input: ThreadLaunchInput) => rpc.call<ThreadLaunchResult>(T3_METHODS.launchThread, input),
  getThreadProjection: (rpc: T3RpcClient, threadId: string) => rpc.call<ThreadProjection>(T3_METHODS.getThreadProjection, { threadId }),
  /** Needs `orchestration:operate`. */
  dispatchCommand: (rpc: T3RpcClient, command: ThreadCommand) => rpc.call<{ sequence: number }>(T3_METHODS.dispatchCommand, command),
};

/** The providers a machine can start a thread with: enabled, installed and not
 *  in error (a CLI that is not signed in reports `error`), with a model to
 *  start on, in the machine's own order. Anything unreadable is dropped. */
export function usableProviders(config: ServerConfig): ServerProvider[] {
  const raw = (config as { providers?: unknown }).providers;
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is ServerProvider =>
    !!p && typeof p === "object" && typeof (p as ServerProvider).instanceId === "string" && (p as ServerProvider).enabled === true && (p as ServerProvider).installed === true
      && (p as ServerProvider).status !== "error" && (p as ServerProvider).status !== "disabled" && defaultModel(p as ServerProvider) !== undefined);
}

/** A provider's default model: the one it marks, else the first current one. */
export function defaultModel(provider: ServerProvider): string | undefined {
  const models = (provider.models ?? []).filter(m => typeof m.slug === "string");
  return (models.find(m => m.isDefault) ?? models.find(m => !m.isLegacy) ?? models[0])?.slug;
}

/** What a thread says right now, in a few words. */
export function threadStatus(projection: ThreadProjection): "working" | "waiting" | "idle" | "failed" {
  if (projection.runtimeRequests?.some(r => r.status === "pending" || r.status === "open")) return "waiting";
  const last = projection.runs[projection.runs.length - 1];
  const status = last?.status ?? "";
  if (/fail|error/i.test(status)) return "failed";
  if (/running|started|active|queued|pending|prepar/i.test(status) || projection.messages.some(m => m.streaming)) return "working";
  return "idle";
}

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

/** Where each runtime mode is offered, in the order a person would reach for them. */
export const RUNTIME_MODES: ReadonlyArray<{ readonly id: RuntimeMode; readonly label: string; readonly hint: string }> = [
  { id: "full-access", label: "Full access", hint: "Runs commands and edits files without asking (T3's own default)" },
  { id: "auto-accept-edits", label: "Accept edits", hint: "Edits files freely, asks before running commands" },
  { id: "auto", label: "Auto", hint: "The provider decides what needs asking" },
  { id: "approval-required", label: "Ask first", hint: "Asks before every change. Answer in T3 Code: Canopy cannot yet" },
];

/** The launch for a thread started from the machine view: in the project's own
 *  folder, titled by its first line, with the message as the opening prompt. */
export function threadLaunchInput(args: {
  projectId: string;
  provider: ServerProvider;
  model: string;
  mode: RuntimeMode;
  prompt: string;
}): ThreadLaunchInput {
  const prompt = args.prompt.trim();
  const firstLine = prompt.split("\n")[0]?.trim() ?? "";
  return {
    commandId: crypto.randomUUID(),
    creationSource: "mobile",
    projectId: args.projectId,
    title: (firstLine || "Canopy thread").slice(0, 80),
    generateTitle: true,
    modelSelection: { instanceId: args.provider.instanceId, model: args.model },
    runtimeMode: args.mode,
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
    initialMessage: { text: prompt, attachments: [] },
  };
}

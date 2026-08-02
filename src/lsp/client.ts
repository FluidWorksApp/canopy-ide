// monaco-languageclient wired to a local LSP subprocess over Tauri IPC.
// The Rust core owns the process and the Content-Length framing; we exchange
// complete JSON-RPC messages through a Channel (reader) and invoke (writer).
// No WebSocket, no Node sidecar for the bridge. Adding a language = one more
// entry in SERVERS (servers.ts).
import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageReader,
  type MessageWriter,
} from "vscode-jsonrpc";
import * as ipc from "../ipc";
import { monaco } from "../monaco-setup";
import {
  SUPPORTED_LANGUAGES,
  resolveServerRoot,
  resolveTypescriptLaunch,
  serverUnavailableMessage,
  specForPath,
  type ServerLaunch,
  type ServerSpec,
} from "./servers";
import { basename } from "../paths";

class IpcMessageReader extends AbstractMessageReader implements MessageReader {
  private callback: DataCallback | null = null;
  private buffered: Message[] = [];

  push(raw: string) {
    try {
      const message = JSON.parse(raw) as Message;
      if (this.callback) this.callback(message);
      else this.buffered.push(message);
    } catch (err) {
      this.fireError(err);
    }
  }

  notifyClosed() {
    this.fireClose();
  }

  listen(callback: DataCallback): Disposable {
    this.callback = callback;
    for (const m of this.buffered) callback(m);
    this.buffered = [];
    return { dispose: () => (this.callback = null) };
  }
}

class IpcMessageWriter extends AbstractMessageWriter implements MessageWriter {
  private serverId: () => number | null;
  constructor(serverId: () => number | null) {
    super();
    this.serverId = serverId;
  }
  async write(message: Message): Promise<void> {
    const id = this.serverId();
    if (id == null) throw new Error("lsp server not running");
    await ipc.lspSend(id, JSON.stringify(message));
  }
  end(): void {}
}

/** What a server is busy with, read off the wire rather than from the language
 *  client: vscode-languageclient consumes `$/progress` for the tokens it
 *  created, so a handler registered on the client never sees rust-analyzer's
 *  indexing. The raw message callback sees everything. */
interface ProgressState {
  active: Set<string>;
  lastEnd: number;
}

interface RunningServer {
  serverId: number;
  /** The directory the server was actually started in — a marker dir under the
   *  project root, not necessarily the root itself. */
  serverRoot: string;
  progress: ProgressState;
  stop: () => Promise<void>;
  /** The live client, so agent tools can ask the server questions the editor
   *  UI never asks it (references, definition, hover, symbols). Absent while
   *  starting. */
  request?: (method: string, params: unknown) => Promise<unknown>;
}

// (spec.id, serverRoot) -> running client
const running = new Map<string, RunningServer>();
/** Why the server for (spec.id, serverRoot) isn't there, in words an agent can
 *  act on. Kept after the failure so a later tool call can say "rust-analyzer
 *  not found" instead of "no language server covers this file". */
const failures = new Map<string, string>();
let unlistenExit: Promise<() => void> | null = null;

const keyFor = (specId: string, serverRoot: string) => `${specId}\0${serverRoot}`;

const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

const exists = (path: string) =>
  ipc.fsStat(path).then(
    () => true,
    () => false,
  );

// One stat walk per (spec, root, directory); the answer can't change while the
// project is open, and every agent tool call would otherwise re-walk it.
const rootCache = new Map<string, Promise<string>>();

function serverRootFor(spec: ServerSpec, path: string, root: string): Promise<string> {
  if (!spec.rootMarkers?.length) return Promise.resolve(root);
  const key = `${spec.id}\0${root}\0${path.slice(0, path.lastIndexOf("/"))}`;
  let hit = rootCache.get(key);
  if (!hit) {
    hit = resolveServerRoot(path, root, spec, exists);
    rootCache.set(key, hit);
  }
  return hit;
}

async function serverCommand(spec: ServerSpec, root: string): Promise<string> {
  // Prefer a workspace-local install so projects pin their own server version.
  const local = `${root}/node_modules/.bin/${spec.command}`;
  try {
    await ipc.fsStat(local);
    return local;
  } catch {
    return spec.command; // Rust resolves via login-shell PATH
  }
}

/** What to spawn for this project. TypeScript is the one server whose answer
 *  depends on what the project has installed (see resolveTypescriptLaunch);
 *  everything else runs the spec as written. */
async function launchFor(spec: ServerSpec, root: string): Promise<ServerLaunch> {
  const command = await serverCommand(spec, root);
  if (spec.id !== "typescript") {
    return { command, args: spec.args, initializationOptions: spec.initializationOptions };
  }
  return resolveTypescriptLaunch(spec, root, command, exists);
}

/** Fold a raw `$/progress` frame into the server's busy state. Cheap enough to
 *  run on every message because the substring test rejects almost all of them. */
function observeProgress(state: ProgressState, raw: string) {
  if (!raw.includes("$/progress")) return;
  try {
    const m = JSON.parse(raw) as {
      method?: string;
      params?: { token?: unknown; value?: { kind?: string } };
    };
    if (m.method !== "$/progress") return;
    const token = String(m.params?.token ?? "");
    const kind = m.params?.value?.kind;
    if (kind === "begin") state.active.add(token);
    else if (kind === "end") {
      state.active.delete(token);
      state.lastEnd = Date.now();
    }
  } catch {
    // A frame we can't parse tells us nothing about progress; the reader will
    // complain about it on its own.
  }
}

export async function ensureLanguageServer(path: string, root: string): Promise<void> {
  const spec = specForPath(path);
  if (!spec) return;
  const serverRoot = await serverRootFor(spec, path, root);
  const key = keyFor(spec.id, serverRoot);
  if (running.has(key)) return;
  const progress: ProgressState = { active: new Set(), lastEnd: 0 };
  // Reserve the slot immediately so concurrent opens don't double-spawn.
  running.set(key, { serverId: -1, serverRoot, progress, stop: async () => {} });

  try {
    const reader = new IpcMessageReader();
    let serverId: number | null = null;

    const launch = await launchFor(spec, serverRoot);
    serverId = await ipc.lspStart(launch.command, launch.args, serverRoot, (msg) => {
      observeProgress(progress, msg);
      reader.push(msg);
    });

    if (!unlistenExit) {
      unlistenExit = ipc.onLspExit(() => reader.notifyClosed());
    }

    const { MonacoLanguageClient } = await import("monaco-languageclient");
    const writer = new IpcMessageWriter(() => serverId);

    const initializationOptions = launch.initializationOptions;

    const client = new MonacoLanguageClient({
      name: `${spec.id} language client`,
      clientOptions: {
        documentSelector: spec.languages,
        workspaceFolder: {
          uri: monaco.Uri.file(serverRoot) as unknown as import("vscode").Uri,
          name: basename(serverRoot) || serverRoot,
          index: 0,
        },
        initializationOptions,
      },
      messageTransports: { reader, writer },
    });
    await client.start();
    failures.delete(key);
    console.info(`LSP started: ${spec.id} for ${serverRoot} (server #${serverId})`);
    const { invoke } = await import("@tauri-apps/api/core");
    void invoke("js_log", {
      level: "info",
      message: `LSP started: ${spec.id} for ${serverRoot}`,
    }).catch(() => {});

    running.set(key, {
      serverId,
      serverRoot,
      progress,
      request: (method, params) =>
        client.sendRequest(method, params as never) as Promise<unknown>,
      stop: async () => {
        try {
          await client.stop(1000);
        } catch {
          // server may already be gone
        }
        if (serverId != null) await ipc.lspStop(serverId);
      },
    });
  } catch (err) {
    running.delete(key);
    const reason = serverUnavailableMessage(spec, err);
    failures.set(key, reason);
    console.warn(`LSP unavailable for ${spec.id} (${serverRoot}):`, err);
    const { invoke } = await import("@tauri-apps/api/core");
    void invoke("js_log", {
      level: "warn",
      message: `LSP unavailable for ${spec.id} (${serverRoot}): ${reason}`,
    }).catch(() => {});
  }
}

async function serverFor(path: string, root: string): Promise<RunningServer | null> {
  const spec = specForPath(path);
  if (!spec) return null;
  const serverRoot = await serverRootFor(spec, path, root);
  return running.get(keyFor(spec.id, serverRoot)) ?? null;
}

/** Ask the language server serving `path` a raw LSP question. Null when no
 *  server covers that file (unsupported language, or it failed to start) —
 *  the agent tools turn that into `describeMissingServer` rather than
 *  pretending there are no references. */
export async function lspRequest(
  path: string,
  root: string,
  method: string,
  params: unknown,
): Promise<unknown | null> {
  const server = await serverFor(path, root);
  if (!server?.request) return null;
  return server.request(method, params);
}

/** Whether a server is actually answering for this file. `lspRequest` returning
 *  null is ambiguous — no server, or a server that answered null (a hover with
 *  nothing to say does exactly that) — and only one of those is a failure. */
export async function hasServerFor(path: string, root: string): Promise<boolean> {
  return !!(await serverFor(path, root))?.request;
}

/** Every server already running for this project, for the questions that are
 *  about a workspace rather than a file (workspace/symbol). Deliberately does
 *  not start anything: an agent asking for a symbol shouldn't pay a cold
 *  rust-analyzer. */
export function runningServersUnder(root: string): { id: string; serverRoot: string }[] {
  const out: { id: string; serverRoot: string }[] = [];
  for (const [key, server] of running) {
    if (!server.request) continue;
    if (under(server.serverRoot, root)) out.push({ id: key.split("\0")[0], serverRoot: server.serverRoot });
  }
  return out;
}

/** Same question, asked of every running server under `root`. */
export async function workspaceRequest(
  root: string,
  method: string,
  params: unknown,
): Promise<{ id: string; result: unknown }[]> {
  const out: { id: string; result: unknown }[] = [];
  for (const [key, server] of [...running.entries()]) {
    if (!server.request || !under(server.serverRoot, root)) continue;
    try {
      out.push({ id: key.split("\0")[0], result: await server.request(method, params) });
    } catch {
      // One server refusing workspace/symbol shouldn't lose the others' hits.
    }
  }
  return out;
}

/** Why there's no answer for this file, in one line the agent can act on:
 *  the recorded spawn failure when there was one, otherwise which languages
 *  Canopy covers at all. */
export async function describeMissingServer(path: string, root: string): Promise<string> {
  const spec = specForPath(path);
  if (!spec) {
    return `No language server covers ${path} — Canopy runs one for ${SUPPORTED_LANGUAGES}.`;
  }
  const serverRoot = await serverRootFor(spec, path, root);
  const failure = failures.get(keyFor(spec.id, serverRoot));
  if (failure) return `No ${spec.id} answers for ${path}: ${failure}`;
  return `The ${spec.id} language server for ${serverRoot} isn't ready yet — try again in a moment.`;
}

/** Whether this file's server keeps a diagnostics call waiting while it indexes,
 *  and for how long at most. Null = the ordinary first-publish wait is enough. */
export function indexingCeilingMs(path: string): number | null {
  return specForPath(path)?.indexingWaitMs ?? null;
}

export function serverCommandFor(path: string): string | null {
  return specForPath(path)?.command ?? null;
}

/** No work reported for this long counts as done indexing. */
const QUIET_SETTLE_MS = 1_200;
/** A server that has reported nothing by now is warm, or doesn't report at
 *  all. Either way, sitting on the ceiling waiting for work that never starts
 *  would be worse than answering. */
const FIRST_WORK_GRACE_MS = 3_000;
const POLL_MS = 150;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** Wait until the server serving `path` has no work in flight. "busy" means we
 *  hit the ceiling with indexing still running — the caller must say so rather
 *  than report an all-clear the server never gave. */
export async function whenQuiet(
  path: string,
  root: string,
  maxWaitMs: number,
): Promise<"quiet" | "busy"> {
  const server = await serverFor(path, root);
  if (!server) return "quiet";
  const { progress } = server;
  const started = Date.now();
  const deadline = started + maxWaitMs;
  let sawWork = false;
  while (Date.now() < deadline) {
    if (progress.active.size > 0) {
      sawWork = true;
    } else if (sawWork) {
      if (Date.now() - progress.lastEnd >= QUIET_SETTLE_MS) return "quiet";
    } else if (Date.now() - started >= FIRST_WORK_GRACE_MS) {
      return "quiet";
    }
    await sleep(POLL_MS);
  }
  return progress.active.size === 0 ? "quiet" : "busy";
}

export async function stopWorkspaceServers(root: string): Promise<void> {
  for (const [key, server] of [...running.entries()]) {
    if (under(server.serverRoot, root)) {
      running.delete(key);
      failures.delete(key);
      await server.stop();
    }
  }
  for (const key of [...rootCache.keys()]) {
    if (key.split("\0")[1] === root) rootCache.delete(key);
  }
}

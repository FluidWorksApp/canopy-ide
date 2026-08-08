// monaco-languageclient wired to a local LSP subprocess over Tauri IPC.
// The Rust core owns the process and the Content-Length framing; we exchange
// complete JSON-RPC messages through a Channel (reader) and invoke (writer).
// No WebSocket, no Node sidecar for the bridge. Adding a language = one more
// entry in SERVERS (servers.ts).
import {
  AbstractMessageWriter,
  type Message,
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
import { IpcMessageReader } from "./ipcMessageReader";

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

interface DesiredServer {
  spec: ServerSpec;
  serverRoot: string;
}

type StartResult = "ready" | "transient-failure" | "permanent-failure" | "timeout";

// (spec.id, serverRoot) -> running client
const running = new Map<string, RunningServer>();
// A key is either starting or running, never both. Sharing the promise is what
// makes every concurrent editor/tool caller observe the same completed startup
// instead of mistaking a reserved slot for a ready client.
const starting = new Map<string, Promise<void>>();
// Once requested, a server is Canopy's responsibility until its workspace
// closes. `desired` drives bounded recovery independently of editor/tool calls.
const desired = new Map<string, DesiredServer>();
const restartAttempts = new Map<string, number>();
const restartTimers = new Map<string, number>();
/** Why the server for (spec.id, serverRoot) isn't there, in words an agent can
 *  act on. Kept after the failure so a later tool call can say "rust-analyzer
 *  not found" instead of "no language server covers this file". */
const failures = new Map<string, string>();
let unlistenExit: Promise<() => void> | null = null;
const readers = new Map<number, IpcMessageReader>();
const exitedBeforeRegistration = new Set<number>();
const stopping = new Set<number>();

const STARTUP_TIMEOUT_MS = 15_000;
const INLINE_RETRY_DELAY_MS = 250;
const RESTART_DELAYS_MS = [500, 1_500, 5_000] as const;

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
const ROOT_CACHE_MAX = 512;

function serverRootFor(spec: ServerSpec, path: string, root: string): Promise<string> {
  if (!spec.rootMarkers?.length) return Promise.resolve(root);
  const key = `${spec.id}\0${root}\0${path.slice(0, path.lastIndexOf("/"))}`;
  let hit = rootCache.get(key);
  if (!hit) {
    hit = resolveServerRoot(path, root, spec, exists);
    rootCache.set(key, hit);
    if (rootCache.size > ROOT_CACHE_MAX) {
      const oldest = rootCache.keys().next().value as string | undefined;
      if (oldest != null && oldest !== key) rootCache.delete(oldest);
    }
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
function observeProgress(state: ProgressState, message: Message) {
  const m = message as Message & {
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
}

/** Scalar-only protocol/cache diagnostics; no paths, tokens, or payloads. */
export function lspIoSnapshot() {
  let bufferedMessages = 0;
  let bufferedBytes = 0;
  let failedReaders = 0;
  for (const reader of readers.values()) {
    const snapshot = reader.snapshot();
    bufferedMessages += snapshot.bufferedMessages;
    bufferedBytes += snapshot.bufferedBytes;
    if (snapshot.failed) failedReaders++;
  }
  return {
    readers: readers.size,
    bufferedMessages,
    bufferedBytes,
    failedReaders,
    rootCacheEntries: rootCache.size,
    startingServers: starting.size,
    runningServers: running.size,
  };
}

function startWithTimeout(start: Promise<void>, spec: ServerSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error(`${spec.command} did not initialize within ${STARTUP_TIMEOUT_MS}ms`)),
      STARTUP_TIMEOUT_MS,
    );
    start.then(
      () => {
        window.clearTimeout(timer);
        resolve();
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function failureKind(err: unknown): Exclude<StartResult, "ready"> {
  const text = err instanceof Error ? err.message : String(err);
  if (text.includes(`did not initialize within ${STARTUP_TIMEOUT_MS}ms`)) return "timeout";
  // Retrying cannot repair an absent executable or an incompatible local
  // toolchain. Keep the actionable failure without creating a crash loop.
  if (
    /failed to spawn|no such file|not found|enoent|cannot find|could not find a valid typescript installation/i.test(
      text,
    )
  ) {
    return "permanent-failure";
  }
  return "transient-failure";
}

function clearRestartTimer(key: string) {
  const timer = restartTimers.get(key);
  if (timer != null) window.clearTimeout(timer);
  restartTimers.delete(key);
}

function scheduleRestart(key: string) {
  if (!desired.has(key) || running.has(key) || restartTimers.has(key)) return;
  const attempt = (restartAttempts.get(key) ?? 0) + 1;
  if (attempt > RESTART_DELAYS_MS.length) return;
  restartAttempts.set(key, attempt);
  const timer = window.setTimeout(() => {
    restartTimers.delete(key);
    const target = desired.get(key);
    if (target) void ensureManagedServer(key, target);
  }, RESTART_DELAYS_MS[attempt - 1]);
  restartTimers.set(key, timer);
}

async function ensureExitListener(): Promise<void> {
  if (!unlistenExit) {
    unlistenExit = ipc.onLspExit((id) => {
      const expected = stopping.has(id);
      const reader = readers.get(id);
      if (reader) {
        readers.delete(id);
        reader.notifyClosed();
      } else if (!stopping.has(id)) {
        // A tiny process can exit before lspStart's invoke resolves. Preserve
        // that fact so startup cannot proceed with an already-dead process.
        exitedBeforeRegistration.add(id);
      }
      let exitedKey: string | null = null;
      for (const [key, server] of running) {
        if (server.serverId !== id) continue;
        running.delete(key);
        exitedKey = key;
        if (!expected) {
          failures.set(key, `${key.split("\0")[0]} language server exited unexpectedly`);
        }
      }
      stopping.delete(id);
      if (exitedKey && !expected) scheduleRestart(exitedKey);
    });
  }
  await unlistenExit;
}

async function startLanguageServer(
  spec: ServerSpec,
  serverRoot: string,
  key: string,
): Promise<StartResult> {
  const progress: ProgressState = { active: new Set(), lastEnd: 0 };
  const reader = new IpcMessageReader();
  let serverId: number | null = null;

  try {
    await ensureExitListener();
    const launch = await launchFor(spec, serverRoot);
    serverId = await ipc.lspStart(launch.command, launch.args, serverRoot, (msg) => {
      reader.push(msg, (message) => observeProgress(progress, message));
    });
    readers.set(serverId, reader);
    if (exitedBeforeRegistration.delete(serverId)) {
      readers.delete(serverId);
      throw new Error(`${spec.command} exited during startup`);
    }

    const { MonacoLanguageClient } = await import("monaco-languageclient");
    const writer = new IpcMessageWriter(() => serverId);
    const client = new MonacoLanguageClient({
      name: `${spec.id} language client`,
      clientOptions: {
        documentSelector: spec.languages,
        workspaceFolder: {
          uri: monaco.Uri.file(serverRoot) as unknown as import("vscode").Uri,
          name: basename(serverRoot) || serverRoot,
          index: 0,
        },
        initializationOptions: launch.initializationOptions,
      },
      messageTransports: { reader, writer },
    });
    await startWithTimeout(client.start(), spec);
    clearRestartTimer(key);
    restartAttempts.delete(key);
    failures.delete(key);
    console.info(`LSP started: ${spec.id} for ${serverRoot} (server #${serverId})`);
    const { invoke } = await import("@tauri-apps/api/core");
    void invoke("js_log", {
      level: "info",
      message: `LSP started: ${spec.id} for ${serverRoot}`,
    }).catch(() => {});

    const readyServerId = serverId;
    running.set(key, {
      serverId: readyServerId,
      serverRoot,
      progress,
      request: (method, params) => client.sendRequest(method, params as never) as Promise<unknown>,
      stop: async () => {
        stopping.add(readyServerId);
        readers.delete(readyServerId);
        try {
          await client.stop(1000);
        } catch {
          // server may already be gone
        }
        await ipc.lspStop(readyServerId);
      },
    });
    return "ready";
  } catch (err) {
    if (serverId != null) {
      readers.delete(serverId);
      stopping.add(serverId);
      await ipc.lspStop(serverId).catch(() => {});
    }
    const reason = serverUnavailableMessage(spec, err);
    failures.set(key, reason);
    console.warn(`LSP unavailable for ${spec.id} (${serverRoot}):`, err);
    const { invoke } = await import("@tauri-apps/api/core");
    void invoke("js_log", {
      level: "warn",
      message: `LSP unavailable for ${spec.id} (${serverRoot}): ${reason}`,
    }).catch(() => {});
    return failureKind(err);
  }
}

async function runManagedStartup(key: string, target: DesiredServer): Promise<void> {
  let result = await startLanguageServer(target.spec, target.serverRoot, key);
  if (result === "transient-failure" && desired.has(key)) {
    await sleep(INLINE_RETRY_DELAY_MS);
    if (desired.has(key)) result = await startLanguageServer(target.spec, target.serverRoot, key);
  }

  // The workspace may have closed while initialization was in flight. Never
  // resurrect a server after its owner stopped asking Canopy to keep it ready.
  if (result === "ready" && !desired.has(key)) {
    const server = running.get(key);
    running.delete(key);
    if (server) await server.stop();
    return;
  }
  if (result !== "ready" && result !== "permanent-failure" && desired.has(key)) {
    scheduleRestart(key);
  }
}

async function ensureManagedServer(key: string, target: DesiredServer): Promise<void> {
  if (running.has(key)) return;
  const inFlight = starting.get(key);
  if (inFlight) return inFlight;
  const startup = runManagedStartup(key, target);
  starting.set(key, startup);
  try {
    await startup;
  } finally {
    if (starting.get(key) === startup) starting.delete(key);
  }
}

export async function ensureLanguageServer(path: string, root: string): Promise<void> {
  const spec = specForPath(path);
  if (!spec) return;
  const serverRoot = await serverRootFor(spec, path, root);
  const key = keyFor(spec.id, serverRoot);
  if (running.has(key)) return;
  const target = { spec, serverRoot };
  desired.set(key, target);
  // A direct demand after the bounded supervisor gave up starts a fresh
  // recovery window; ordinary calls during recovery share its in-flight work.
  if (!starting.has(key) && !restartTimers.has(key)) restartAttempts.delete(key);
  await ensureManagedServer(key, target);
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
  const key = keyFor(spec.id, serverRoot);
  const failure = failures.get(key);
  if (failure && restartTimers.has(key)) {
    const attempt = restartAttempts.get(key) ?? 1;
    return `No ${spec.id} answers for ${path}: ${failure}. Canopy is restarting it (attempt ${attempt}/${RESTART_DELAYS_MS.length}).`;
  }
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
  for (const [key, target] of [...desired.entries()]) {
    if (!under(target.serverRoot, root)) continue;
    desired.delete(key);
    clearRestartTimer(key);
    restartAttempts.delete(key);
    failures.delete(key);
  }
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

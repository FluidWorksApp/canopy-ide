// Android devices for agents running in a cloud workspace. The devices are
// attached to this computer, so the workspace's Canopy service queues each
// canopy_device_* op an agent makes (crates/canopy-service/src/device.rs) and
// this window — the IDE with the workspace open — long-polls for them, runs
// each with the desktop's own device route (context_device_op, the same code
// that serves desktop agents) and answers in pieces small enough for one
// harness action. Paths an agent names are workspace paths: an APK to run is
// staged here first, a project to describe is read from the VM, and a project
// directory used only to find the SDK is dropped for this computer's own.
import { describeWorkspaceProject, isWorkspacePath, stageWorkspaceApk } from "./androidBridge";
import { invoke, invokeDesktop } from "../host";
import type { NativeWorkspaceHost } from "./NativeWorkspaceHost";

type Call = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
export interface DeviceRelayIo {
  query<T>(store: string, action: string, args?: Record<string, unknown>): Promise<T>;
  action<T>(kind: string, args: Record<string, unknown>): Promise<T>;
  native: Call;
  desktop: Call;
}
export interface DeviceOp {
  id: string;
  op: Record<string, unknown> & { op: string };
  ptyId: number;
}

/** The service's long poll is held this long. */
const POLL_MS = 5000;
/** Characters per answer piece: under the gateway's 256 KiB action body. */
export const ANSWER_CHUNK = 160 * 1024;

/** Run one op here. Resolves with the desktop route's status and body. */
export async function runDeviceOp(io: Pick<DeviceRelayIo, "native" | "desktop">, op: DeviceOp["op"]): Promise<{ status: number; body: string }> {
  try {
    const args: Record<string, unknown> = { ...op };
    const project = typeof args.projectDir === "string" ? args.projectDir : null;
    if (op.op === "describe" && isWorkspacePath(project))
      return { status: 200, body: JSON.stringify({ describe: await describeWorkspaceProject(io.native, project) }) };
    if (op.op === "run" && isWorkspacePath(args.apk)) args.apk = await stageWorkspaceApk(io.native, io.desktop, args.apk);
    // A VM directory means nothing here; the desktop finds its own SDK.
    if (isWorkspacePath(project)) delete args.projectDir;
    const value = await io.desktop<unknown>("context_device_op", { op: args });
    return { status: 200, body: JSON.stringify(value) };
  } catch (error) {
    return { status: 400, body: String(error instanceof Error ? error.message : error).replace(/^Error: /, "") };
  }
}

/** Answer an op, in pieces when the answer is large (a screenshot). */
export async function answerDeviceOp(io: Pick<DeviceRelayIo, "action">, id: string, answer: { status: number; body: string }): Promise<void> {
  const { status, body } = answer;
  const encoder = new TextEncoder();
  let offset = 0;
  // The service counts bytes of what it has joined so far.
  let bytes = 0;
  do {
    let end = Math.min(body.length, offset + ANSWER_CHUNK);
    // Never split a surrogate pair across two pieces.
    if (end < body.length && /[\uD800-\uDBFF]/.test(body[end - 1])) end -= 1;
    const chunk = body.slice(offset, end);
    await io.action("device_answer", { id, status, chunk, offset: bytes, done: end >= body.length });
    bytes += encoder.encode(chunk).length;
    offset = end;
  } while (offset < body.length);
}

/** Poll and serve until stopped. Ops run one at a time, in order. */
export function startDeviceRelay(io: DeviceRelayIo, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): () => void {
  let stopped = false;
  void (async () => {
    let failures = 0;
    while (!stopped) {
      let ops: DeviceOp[];
      try {
        const answer = await io.query<{ items?: DeviceOp[] }>("device", "pending", { wait: POLL_MS });
        ops = Array.isArray(answer?.items) ? answer.items : [];
        failures = 0;
      } catch {
        // An older service, a reconnect: try again, more slowly each time.
        failures = Math.min(failures + 1, 6);
        await sleep(2000 * failures);
        continue;
      }
      for (const op of ops) {
        if (stopped) return;
        const answer = await runDeviceOp(io, op.op);
        await answerDeviceOp(io, op.id, answer).catch(() => {
          // The agent stopped waiting; nothing is left to tell.
        });
      }
    }
  })();
  return () => {
    stopped = true;
  };
}

/** The relay for the workspace this IDE runs against (cloudSync.ts). */
export function workspaceDeviceRelay(ws: NativeWorkspaceHost): () => void {
  const id = ws.connection.workspaceId;
  return startDeviceRelay({
    query: (store, action, args = {}) => ws.client.workspace(id, "/harness/query", { store, action, args }),
    action: (kind, args) => ws.client.workspace(id, "/harness/actions", { ...args, kind }),
    native: (command, args) => invoke(command, args),
    desktop: (command, args) => invokeDesktop(command, args),
  });
}

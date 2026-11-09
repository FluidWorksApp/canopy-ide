// The RPC client against frames recorded from a real T3 Code 0.1.7 server
// (T3_RECORD_FRAMES in t3server.integration.test.ts), replayed through a fake
// socket.
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFrames, encodeFrame, frameJoiner, RpcError, RpcTransportError, T3RpcClient } from "./rpc";
import { listProjects, t3 } from "./methods";

const RECORDED = {
  listEntriesRequest: '{"_tag":"Request","id":3,"tag":"projects.listEntries","payload":{"cwd":"/scratch/canopy-t3-2xrus1/project","directoryPath":""},"headers":[]}',
  listEntriesExit: '{"_tag":"Exit","requestId":3,"exit":{"_tag":"Success","value":{"entries":[{"path":"README.md","kind":"file"},{"path":"src","kind":"directory"}],"truncated":false}}}',
  scopeFailure: '{"_tag":"Exit","requestId":1,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"EnvironmentAuthorizationError","message":"The authenticated token is missing required scope: orchestration:operate.","requiredScope":"orchestration:operate","requiredPermission":"orchestration:operate"}}]}}',
  attachSnapshot: '{"_tag":"Chunk","requestId":10,"values":[{"type":"snapshot","snapshot":{"threadId":"canopy","terminalId":"canopy-it","cwd":"/scratch/canopy-t3-2xrus1/project","worktreePath":null,"status":"running","pid":420435,"history":"","exitCode":null,"exitSignal":null,"label":"canopy-it","updatedAt":"2026-11-09T04:26:33.145Z","sequence":1,"cols":100,"rows":30}}]}',
  attachOutput: '{"_tag":"Chunk","requestId":10,"values":[{"threadId":"canopy","terminalId":"canopy-it","sequence":4,"type":"output","data":"echo CANOPY_T3_OK_$((40+2))\\r\\n\\u001b[?2004l\\rCANOPY_T3_OK_42\\r\\n"}]}',
  attachInterruptedExit: '{"_tag":"Exit","requestId":10,"exit":{"_tag":"Failure","cause":[{"_tag":"Interrupt","fiberId":1460}]}}',
  writeExit: '{"_tag":"Exit","requestId":12,"exit":{"_tag":"Success","value":null}}',
  lookupFailure: '{"_tag":"Exit","requestId":14,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"TerminalSessionLookupError","threadId":"canopy","terminalId":"canopy-it"}}]}}',
  shellSnapshot: '{"_tag":"Chunk","requestId":2,"values":[{"kind":"snapshot","snapshot":{"schemaVersion":2,"snapshotSequence":1,"threads":[],"archivedThreads":[],"projects":[{"id":"a9b4207c-520f-4b6f-b1c0-d1eb5ea39211","title":"project","workspaceRoot":"/scratch/canopy-t3-2xrus1/project","repositoryIdentity":null,"defaultModelSelection":null,"scripts":[],"createdAt":"2026-11-09T04:26:33.000Z","updatedAt":"2026-11-09T04:26:33.000Z"}]}}]}',
  pong: '{"_tag":"Pong"}',
};

class FakeSocket extends EventTarget {
  static last: FakeSocket;
  readyState = 0;
  binaryType = "blob";
  sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.last = this;
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  receive(data: string) { this.dispatchEvent(new MessageEvent("message", { data })); }
  send(data: string) { this.sent.push(data); }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), { code, reason: "" }));
  }
  frames() { return this.sent.map(frame => JSON.parse(frame) as Record<string, unknown>); }
}

async function connected(options: { pingIntervalMs?: number; pingTimeoutMs?: number } = {}) {
  const client = new T3RpcClient("ws://t3.test/ws", { WebSocket: FakeSocket as unknown as typeof WebSocket, ...options });
  const socket = FakeSocket.last;
  socket.open();
  await client.ready();
  return { client, socket };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

afterEach(() => { vi.useRealTimers(); });

describe("Effect RPC frames", () => {
  it("encodes a Request exactly as the server received it", () => {
    expect(encodeFrame({ _tag: "Request", id: 3, tag: "projects.listEntries", payload: { cwd: "/scratch/canopy-t3-2xrus1/project", directoryPath: "" }, headers: [] }))
      .toBe(RECORDED.listEntriesRequest);
    expect(encodeFrame({ _tag: "Ack", requestId: 10 })).toBe('{"_tag":"Ack","requestId":10}');
    expect(encodeFrame({ _tag: "Interrupt", requestId: 10 })).toBe('{"_tag":"Interrupt","requestId":10}');
    expect(encodeFrame({ _tag: "Ping" })).toBe('{"_tag":"Ping"}');
  });

  it("decodes one frame or an array of frames per message (RpcSerialization.json)", () => {
    expect(decodeFrames(RECORDED.pong)).toEqual([{ _tag: "Pong" }]);
    expect(decodeFrames(`[${RECORDED.writeExit},${RECORDED.pong}]`).map(frame => frame._tag)).toEqual(["Exit", "Pong"]);
    expect(() => decodeFrames("42")).toThrow();
  });

  it("joins frames the server split into parts", () => {
    const join = frameJoiner();
    expect(join("\u001e{\"_tag\":")).toBeNull();
    expect(join("\u001e\"Po")).toBeNull();
    expect(join("ng\"}")).toBe('{"_tag":"Pong"}');
    expect(join(RECORDED.pong)).toBe(RECORDED.pong);
  });
});

describe("T3RpcClient", () => {
  it("numbers requests from 0 and resolves a call with its Success value", async () => {
    const { client, socket } = await connected();
    void client.call("server.getConfig", {}).catch(() => {});
    const pending = t3.listEntries(client, { cwd: "/scratch/canopy-t3-2xrus1/project", directoryPath: "" });
    await tick();
    expect(socket.frames().map(frame => frame.id)).toEqual([0, 1]);
    socket.receive(RECORDED.listEntriesExit.replace('"requestId":3', '"requestId":1'));
    await expect(pending).resolves.toEqual({ entries: [{ path: "README.md", kind: "file" }, { path: "src", kind: "directory" }], truncated: false });
  });

  it("rejects a Failure with the server's tagged error", async () => {
    const { client, socket } = await connected();
    void client.call("server.getConfig", {}).catch(() => {});
    const pending = client.call("projects.mutate", {});
    await tick();
    socket.receive(RECORDED.scopeFailure);
    const error = (await pending.catch(error => error)) as RpcError;
    expect(error).toBeInstanceOf(RpcError);
    expect(error.tag).toBe("EnvironmentAuthorizationError");
    expect(error.message).toContain("missing required scope: orchestration:operate");
  });

  it("streams terminal events, acknowledging each Chunk after it is handled, and interrupts on cancel", async () => {
    const { client, socket } = await connected();
    for (let i = 0; i < 10; i++) void client.call("noop", {}).catch(() => {});
    const events: string[] = [];
    let release!: () => void;
    const handled = new Promise<void>(resolve => { release = resolve; });
    const attach = t3.terminalAttach(client, { threadId: "canopy", terminalId: "canopy-it" }, async event => {
      events.push(event.type);
      if (event.type === "output") await handled;
    });
    await tick();
    expect(socket.frames().at(-1)).toMatchObject({ _tag: "Request", id: 10, tag: "terminal.attach" });
    socket.receive(RECORDED.attachSnapshot);
    await tick();
    expect(socket.frames().at(-1)).toEqual({ _tag: "Ack", requestId: 10 });
    const acks = () => socket.frames().filter(frame => frame._tag === "Ack").length;
    socket.receive(RECORDED.attachOutput);
    await tick();
    expect(events).toEqual(["snapshot", "output"]);
    expect(acks()).toBe(1); // still writing the output: no Ack yet
    release();
    await tick(); await tick();
    expect(acks()).toBe(2);
    attach.cancel();
    expect(socket.frames().at(-1)).toEqual({ _tag: "Interrupt", requestId: 10 });
    socket.receive(RECORDED.attachInterruptedExit); // the server's reply to the interrupt is ignored
    await expect(attach.done).resolves.toBeUndefined();
  });

  it("lists projects from the first shell snapshot and ends the subscription", async () => {
    const { client, socket } = await connected();
    void client.call("a", {}).catch(() => {}); void client.call("b", {}).catch(() => {});
    const projects = listProjects(client);
    await tick();
    expect(socket.frames().at(-1)).toMatchObject({ _tag: "Request", id: 2, tag: "orchestration.subscribeShell", payload: {} });
    socket.receive(RECORDED.shellSnapshot);
    await expect(projects).resolves.toMatchObject([{ title: "project", workspaceRoot: "/scratch/canopy-t3-2xrus1/project" }]);
    expect(socket.frames().at(-1)).toEqual({ _tag: "Interrupt", requestId: 2 });
  });

  it("fails every pending request on a Defect", async () => {
    const { client, socket } = await connected();
    const a = client.call("x", {});
    const b = client.call("y", {});
    await tick();
    socket.receive('{"_tag":"Defect","defect":"boom"}');
    await expect(a).rejects.toBeInstanceOf(RpcError);
    await expect(b).rejects.toThrow("defect: boom");
  });

  it("pings every interval and drops a socket that stays silent past the timeout", async () => {
    vi.useFakeTimers();
    const { client, socket } = await connected({ pingIntervalMs: 5_000, pingTimeoutMs: 15_000 });
    const pending = client.call("slow", {}).catch(error => error);
    const closed = vi.fn();
    client.onClose(closed);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.frames().filter(frame => frame._tag === "Ping")).toHaveLength(1);
    socket.receive(RECORDED.pong); // any frame is liveness
    await vi.advanceTimersByTimeAsync(15_000);
    expect(closed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closed).toHaveBeenCalledWith(expect.stringContaining("No frame from the server for 15s"));
    expect(await pending).toBeInstanceOf(RpcTransportError);
    expect(socket.readyState).toBe(3);
  });

  it("fails pending calls when the socket closes, and refuses new ones", async () => {
    const { client, socket } = await connected();
    const pending = client.call("x", {});
    await tick();
    socket.close(1006);
    await expect(pending).rejects.toBeInstanceOf(RpcTransportError);
    await expect(client.call("y", {})).rejects.toBeInstanceOf(RpcTransportError);
    expect(client.closed).toBe(true);
  });
});

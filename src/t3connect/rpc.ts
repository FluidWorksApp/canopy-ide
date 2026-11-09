// A minimal client for the T3 Code server's WebSocket RPC: Effect RPC
// (effect@4.1.2, effect/rpc) with RpcSerialization.layerJson, as T3's
// packages/client-runtime/src/rpc/session.ts sets it up. Written against
// Effect's own source rather than a dependency on it:
//   effect/src/rpc/RpcMessage.ts      the frame shapes
//   effect/src/rpc/RpcSerialization.ts `json`: one JSON value per WebSocket
//                                      message, which may be an array of frames
//   effect/src/rpc/RpcClient.ts       makeProtocolSocket (ping/pong, routing by
//                                      requestId) and make (ids, Ack per Chunk,
//                                      Interrupt on cancel)
//   effect/src/rpc/RpcServer.ts       the server waits for an Ack before it
//                                      sends the next Chunk of a stream
//
// Frames this client sends:
//   {"_tag":"Request","id":7,"tag":"projects.listEntries","payload":{…},"headers":[]}
//   {"_tag":"Ack","requestId":7}          after each Chunk of a stream
//   {"_tag":"Interrupt","requestId":7}    to cancel a call or a stream
//   {"_tag":"Ping"}                       every 5 s
// Frames it handles:
//   {"_tag":"Chunk","requestId":7,"values":[…]}
//   {"_tag":"Exit","requestId":7,"exit":{"_tag":"Success","value":…}}
//   {"_tag":"Exit","requestId":7,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":…}|{"_tag":"Die","defect":…}|{"_tag":"Interrupt","fiberId":…}]}}
//   {"_tag":"Defect","defect":…}          ends every pending request
//   {"_tag":"Pong"}
//
// Nothing here is specific to T3's methods: any Effect RPC group served over
// a socket with layerJson speaks this. contracts.ts holds T3's method shapes.
//
// The client runs over an RpcTransport: one text message per WebSocket
// message, either way. In the app that is tauriTransport (api.ts), whose
// socket Rust opens and owns (src-tauri/src/t3_socket.rs); webSocketTransport
// here is a browser or Node WebSocket, which the tests use.

/** T3 pings every 5 s and drops the socket after 15 s without any frame
 *  (packages/client-runtime/src/rpc/protocol.ts PING_TIMEOUT). */
export const PING_INTERVAL_MS = 5_000;
export const PING_TIMEOUT_MS = 15_000;

/** packages/shared/src/socketFrameParts.ts: a part of a split frame starts
 *  with a record separator; the last part does not. */
const FRAME_PART_PREFIX = "\u001e";

export type RequestId = number;

export interface RequestFrame {
  readonly _tag: "Request";
  readonly id: RequestId;
  readonly tag: string;
  readonly payload: unknown;
  readonly headers: ReadonlyArray<readonly [string, string]>;
}
export type ClientFrame =
  | RequestFrame
  | { readonly _tag: "Ack"; readonly requestId: RequestId }
  | { readonly _tag: "Interrupt"; readonly requestId: RequestId }
  | { readonly _tag: "Ping" };

export type CauseEncoded = ReadonlyArray<
  | { readonly _tag: "Fail"; readonly error: unknown }
  | { readonly _tag: "Die"; readonly defect: unknown }
  | { readonly _tag: "Interrupt"; readonly fiberId?: number | null }
>;
export type ExitEncoded =
  | { readonly _tag: "Success"; readonly value?: unknown }
  | { readonly _tag: "Failure"; readonly cause: CauseEncoded };
export type ServerFrame =
  | { readonly _tag: "Chunk"; readonly requestId: string | number; readonly values: ReadonlyArray<unknown> }
  | { readonly _tag: "Exit"; readonly requestId: string | number; readonly exit: ExitEncoded }
  | { readonly _tag: "Defect"; readonly defect: unknown }
  | { readonly _tag: "Pong" };

export function encodeFrame(frame: ClientFrame): string {
  return JSON.stringify(frame);
}

/** RpcSerialization.json: a message is one frame or an array of them. */
export function decodeFrames(data: string): ServerFrame[] {
  const decoded: unknown = JSON.parse(data);
  const frames = Array.isArray(decoded) ? decoded : [decoded];
  for (const frame of frames) {
    if (!frame || typeof frame !== "object" || typeof (frame as { _tag?: unknown })._tag !== "string") {
      throw new Error("Not an RPC frame");
    }
  }
  return frames as ServerFrame[];
}

/** Joins frames the server split into parts (socketFrameParts.ts
 *  joinSocketFrameParts). Returns null while a frame is still incomplete. */
export function frameJoiner(): (frame: string) => string | null {
  let pending = "";
  return frame => {
    if (frame.startsWith(FRAME_PART_PREFIX)) {
      pending += frame.slice(FRAME_PART_PREFIX.length);
      return null;
    }
    if (pending === "") return frame;
    const whole = pending + frame;
    pending = "";
    return whole;
  };
}

/** A call the server answered with Failure. `error` is the first Fail's
 *  encoded error (a tagged object such as {"_tag":"TerminalNotRunningError",…}). */
export class RpcError extends Error {
  readonly rpcCause: CauseEncoded;
  readonly error: unknown;
  readonly tag: string | undefined;
  constructor(method: string, cause: CauseEncoded) {
    const failure = cause.find(item => item._tag === "Fail") as { error: unknown } | undefined;
    const die = cause.find(item => item._tag === "Die") as { defect: unknown } | undefined;
    const error = failure?.error;
    const tag = error && typeof error === "object" ? (error as { _tag?: unknown })._tag : undefined;
    const text = error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : failure ? String(tag ?? JSON.stringify(error))
        : die ? `defect: ${typeof die.defect === "string" ? die.defect : JSON.stringify(die.defect)}`
          : "interrupted";
    super(`${method}: ${text}`);
    this.rpcCause = cause;
    this.error = error;
    this.tag = typeof tag === "string" ? tag : undefined;
  }
}

/** The socket closed, failed, or went silent before the call finished. */
export class RpcTransportError extends Error {}

export interface StreamHandle {
  /** Settles when the stream ends: resolves on Success, rejects on Failure or a dropped socket. */
  readonly done: Promise<void>;
  /** Sends Interrupt; `done` then resolves. */
  cancel(): void;
}

/** A message channel to the server, already open. */
export interface RpcTransport {
  /** One text message. Dropped once closed. */
  send(text: string): void;
  /** Idempotent; the onClose listener is not called for this. */
  close(): void;
  /** Set once. Messages that arrived before are delivered when it is set. */
  onMessage(listener: (text: string) => void): void;
  /** Set once. Called at most once, when the other side or the link ends it. */
  onClose(listener: (reason: string) => void): void;
}

/** Buffers what a transport receives until the client attaches, so nothing
 *  that arrives while it is being handed over is lost. */
export class TransportInbox {
  private messageListener: ((text: string) => void) | undefined;
  private closeListener: ((reason: string) => void) | undefined;
  private readonly queued: string[] = [];
  private closedWith: string | undefined;
  private ended = false;

  message(text: string): void {
    if (this.ended) return;
    if (this.messageListener) this.messageListener(text);
    else this.queued.push(text);
  }

  closed(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.closeListener && this.messageListener) this.closeListener(reason);
    else this.closedWith = reason;
  }

  onMessage(listener: (text: string) => void): void {
    this.messageListener = listener;
    for (const text of this.queued.splice(0)) listener(text);
    this.flushClose();
  }

  onClose(listener: (reason: string) => void): void {
    this.closeListener = listener;
    this.flushClose();
  }

  private flushClose(): void {
    if (this.closedWith === undefined || !this.closeListener || !this.messageListener) return;
    const reason = this.closedWith;
    this.closedWith = undefined;
    this.closeListener(reason);
  }
}

/** Opens a WebSocket (the global one unless given) and resolves once it is open. */
export function webSocketTransport(url: string, Socket: typeof WebSocket = globalThis.WebSocket): Promise<RpcTransport> {
  const socket = new Socket(url);
  socket.binaryType = "arraybuffer";
  const inbox = new TransportInbox();
  let closedByUs = false;
  socket.addEventListener("message", event => {
    const data: unknown = event.data;
    const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : null;
    if (text !== null) inbox.message(text);
  });
  socket.addEventListener("close", event => {
    if (!closedByUs) inbox.closed(event.reason || `Socket closed (${event.code})`);
  });
  const transport: RpcTransport = {
    send: text => { if (socket.readyState === 1) socket.send(text); },
    close: () => {
      closedByUs = true;
      if (socket.readyState === 0 || socket.readyState === 1) {
        try { socket.close(1000); } catch { /* already closing */ }
      }
    },
    onMessage: listener => inbox.onMessage(listener),
    onClose: listener => inbox.onClose(listener),
  };
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(transport), { once: true });
    const failed = () => reject(new RpcTransportError("Could not open the T3 socket"));
    socket.addEventListener("error", failed, { once: true });
    socket.addEventListener("close", failed, { once: true });
  });
}

type Entry =
  | { readonly kind: "call"; readonly method: string; resolve(value: unknown): void; reject(error: Error): void }
  | {
      readonly kind: "stream";
      readonly method: string;
      onValues(values: ReadonlyArray<unknown>): void | Promise<void>;
      resolve(): void;
      reject(error: Error): void;
    };

export interface T3RpcClientOptions {
  /** For tests: a WebSocket constructor other than the global one. */
  readonly WebSocket?: typeof WebSocket;
  readonly pingIntervalMs?: number;
  readonly pingTimeoutMs?: number;
}

export class T3RpcClient {
  private transport: RpcTransport | undefined;
  private readonly entries = new Map<string, Entry>();
  private readonly join = frameJoiner();
  private readonly opened: Promise<void>;
  private readonly closeListeners = new Set<(reason: string) => void>();
  private nextId = 0;
  private lastFrameAt = Date.now();
  private awaitingPong = false;
  private pinger: ReturnType<typeof setInterval> | undefined;
  private closedReason: string | undefined;

  /** `target` is a socket URL (opened with webSocketTransport) or a transport. */
  constructor(target: string | RpcTransport | Promise<RpcTransport>, options: T3RpcClientOptions = {}) {
    const transport = typeof target === "string" ? webSocketTransport(target, options.WebSocket) : Promise.resolve(target);
    const interval = options.pingIntervalMs ?? PING_INTERVAL_MS;
    const timeout = options.pingTimeoutMs ?? PING_TIMEOUT_MS;
    this.opened = transport.then(opened => {
      if (this.closedReason !== undefined) {
        opened.close();
        throw new RpcTransportError(this.closedReason);
      }
      this.transport = opened;
      this.lastFrameAt = Date.now();
      // RpcClient makePinger: each tick sends a Ping, unless the previous
      // one is still unanswered and no frame came for `timeout`.
      this.pinger = setInterval(() => {
        if (this.awaitingPong && Date.now() - this.lastFrameAt > timeout) {
          this.fail(`No frame from the server for ${Math.round(timeout / 1000)}s`);
          return;
        }
        this.awaitingPong = true;
        this.send({ _tag: "Ping" });
      }, interval);
      opened.onMessage(text => this.onMessage(text));
      opened.onClose(reason => this.fail(reason));
    }, (error: unknown) => {
      const failure = error instanceof RpcTransportError ? error : new RpcTransportError(error instanceof Error ? error.message : String(error));
      this.fail(failure.message);
      throw failure;
    });
    // An unobserved failure to open is reported through the calls instead.
    this.opened.catch(() => {});
  }

  /** Resolves once the socket is open. */
  ready(): Promise<void> {
    return this.opened;
  }

  get closed(): boolean {
    return this.closedReason !== undefined;
  }

  onClose(listener: (reason: string) => void): () => void {
    if (this.closedReason !== undefined) {
      listener(this.closedReason);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** A unary call: one Request, answered by one Exit. */
  async call<A>(method: string, payload: unknown): Promise<A> {
    // Numbered when asked for, as RpcClient does, so ids follow call order.
    const id = this.nextId++;
    await this.opened;
    if (this.closedReason !== undefined) throw new RpcTransportError(this.closedReason);
    return new Promise<A>((resolve, reject) => {
      this.entries.set(String(id), { kind: "call", method, resolve: value => resolve(value as A), reject });
      this.send({ _tag: "Request", id, tag: method, payload, headers: [] });
    });
  }

  /** A streaming call: Chunks until an Exit. Each Chunk is acknowledged after
   *  `onValues` (and the promise it returns) finishes, which is the
   *  backpressure the server waits for. */
  stream<A>(method: string, payload: unknown, onValues: (values: ReadonlyArray<A>) => void | Promise<void>): StreamHandle {
    const id = this.nextId++;
    const key = String(id);
    let cancelled = false;
    let settle: { resolve(): void; reject(error: Error): void } | undefined;
    const done = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
    void this.opened.then(() => {
      if (cancelled) return settle!.resolve();
      if (this.closedReason !== undefined) return settle!.reject(new RpcTransportError(this.closedReason));
      this.entries.set(key, {
        kind: "stream",
        method,
        onValues: values => onValues(values as ReadonlyArray<A>),
        resolve: () => settle!.resolve(),
        reject: error => settle!.reject(error),
      });
      this.send({ _tag: "Request", id, tag: method, payload, headers: [] });
    }, error => settle!.reject(error as Error));
    return {
      done,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        if (this.entries.delete(key)) {
          this.send({ _tag: "Interrupt", requestId: id });
          settle!.resolve();
        }
      },
    };
  }

  close(): void {
    this.fail("Closed by Canopy");
  }

  private send(frame: ClientFrame): void {
    if (this.closedReason !== undefined || !this.transport) return;
    this.transport.send(encodeFrame(frame));
  }

  private onMessage(text: string): void {
    // Any frame counts as liveness, held-back parts included (socketFrameParts.ts).
    this.lastFrameAt = Date.now();
    this.awaitingPong = false;
    const whole = this.join(text);
    if (whole === null) return;
    let frames: ServerFrame[];
    try {
      frames = decodeFrames(whole);
    } catch {
      this.fail("The server sent a frame that is not RPC JSON");
      return;
    }
    for (const frame of frames) this.dispatch(frame);
  }

  private dispatch(frame: ServerFrame): void {
    switch (frame._tag) {
      case "Pong":
        return;
      case "Chunk": {
        const entry = this.entries.get(String(frame.requestId));
        if (!entry || entry.kind !== "stream") return;
        const requestId = frame.requestId as RequestId;
        let result: void | Promise<void>;
        try {
          result = entry.onValues(frame.values);
        } catch (error) {
          this.abortStream(String(frame.requestId), requestId, error);
          return;
        }
        const ack = () => { if (this.entries.has(String(frame.requestId))) this.send({ _tag: "Ack", requestId }); };
        if (result && typeof (result as Promise<void>).then === "function") {
          (result as Promise<void>).then(ack, error => this.abortStream(String(frame.requestId), requestId, error));
        } else ack();
        return;
      }
      case "Exit": {
        const key = String(frame.requestId);
        const entry = this.entries.get(key);
        if (!entry) return;
        this.entries.delete(key);
        if (frame.exit._tag === "Success") {
          if (entry.kind === "call") entry.resolve(frame.exit.value);
          else entry.resolve();
        } else entry.reject(new RpcError(entry.method, frame.exit.cause));
        return;
      }
      case "Defect": {
        const pending = [...this.entries.values()];
        this.entries.clear();
        for (const entry of pending) entry.reject(new RpcError(entry.method, [{ _tag: "Die", defect: frame.defect }]));
        return;
      }
    }
  }

  private abortStream(key: string, requestId: RequestId, error: unknown): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.send({ _tag: "Interrupt", requestId });
    entry.reject(error instanceof Error ? error : new Error(String(error)));
  }

  private fail(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    if (this.pinger !== undefined) clearInterval(this.pinger);
    const pending = [...this.entries.values()];
    this.entries.clear();
    for (const entry of pending) entry.reject(new RpcTransportError(reason));
    for (const listener of this.closeListeners) listener(reason);
    this.closeListeners.clear();
    this.transport?.close();
  }
}

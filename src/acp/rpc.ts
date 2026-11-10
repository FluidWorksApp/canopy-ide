import {
  RPC_INTERNAL_ERROR,
  RPC_METHOD_NOT_FOUND,
  RPC_REQUEST_CANCELLED,
  type JsonRpcError,
  type JsonRpcResponse,
} from "./protocol";

/** A JSON-RPC error reply, or a local failure (timeout, process exit). */
export class AcpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  /** True when Canopy raised it (timeout, exit) rather than the agent. */
  readonly local: boolean;
  constructor(code: number, message: string, data?: unknown, local = false) {
    super(message);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
    this.local = local;
  }
}

export const RPC_TIMEOUT = -32000;
export const RPC_CLOSED = -32001;

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: AcpRpcError): void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface AcpRpcOptions {
  /** Writes one already-framed line (no trailing newline) to the agent. */
  write(line: string): Promise<void>;
  /** Answers an agent->client request. Throw AcpRpcError to send an error.
   *  `signal` aborts when the agent sends `$/cancel_request` for it. */
  onRequest(method: string, params: unknown, signal: AbortSignal): Promise<unknown>;
  onNotification(method: string, params: unknown): void;
  /** Default timeout for requests that do not pass their own. */
  timeoutMs?: number;
}

/** JSON-RPC 2.0 over newline-delimited lines, both directions at once.
 *
 *  Lines that are not JSON (a CLI banner, a log line on stdout) are dropped:
 *  the stream is the agent's, and one stray line must not end the session. */
export class AcpRpc {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private buffer = "";
  private closed: AcpRpcError | null = null;
  /** Agent->client requests still being answered, by id. */
  private inflight = new Map<number | string, AbortController>();
  private opts: AcpRpcOptions;

  constructor(opts: AcpRpcOptions) {
    this.opts = opts;
  }

  /** Feed raw output. Accepts whole lines or arbitrary chunks: a partial line
   *  is held until its newline arrives. */
  handleChunk(chunk: string): void {
    this.buffer += chunk;
    let i: number;
    while ((i = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, i);
      this.buffer = this.buffer.slice(i + 1);
      this.handleLine(line);
    }
  }

  handleLine(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg.id;
    const hasId = typeof id === "number" || typeof id === "string";
    if (typeof msg.method === "string") {
      if (hasId) void this.answer(id, msg.method, msg.params);
      else if (msg.method === "$/cancel_request") this.cancelInflight(msg.params);
      else this.opts.onNotification(msg.method, msg.params);
      return;
    }
    if (!hasId) return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    const error = msg.error as JsonRpcError | undefined;
    if (error) entry.reject(new AcpRpcError(error.code, error.message, error.data));
    else entry.resolve(msg.result);
  }

  /** The agent no longer wants an answer: abort the handler and reply with
   *  "request cancelled" now. Whatever the handler returns later is dropped. */
  private cancelInflight(params: unknown): void {
    const requestId = (params as { requestId?: unknown } | null | undefined)?.requestId;
    if (typeof requestId !== "number" && typeof requestId !== "string") return;
    const controller = this.inflight.get(requestId);
    if (!controller) return;
    this.inflight.delete(requestId);
    controller.abort();
    const reply: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: requestId,
      error: { code: RPC_REQUEST_CANCELLED, message: "Request cancelled" },
    };
    void this.opts.write(JSON.stringify(reply)).catch(() => {});
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    let reply: JsonRpcResponse;
    const controller = new AbortController();
    this.inflight.set(id, controller);
    try {
      reply = {
        jsonrpc: "2.0",
        id,
        result: (await this.opts.onRequest(method, params, controller.signal)) ?? null,
      };
    } catch (e) {
      const err =
        e instanceof AcpRpcError
          ? e
          : new AcpRpcError(RPC_INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
      reply = { jsonrpc: "2.0", id, error: { code: err.code, message: err.message } };
    }
    // Cancelled while running: the cancellation reply already went out.
    if (this.inflight.get(id) !== controller) return;
    this.inflight.delete(id);
    try {
      await this.opts.write(JSON.stringify(reply));
    } catch {
      // The pipe is gone; close() reports it to whoever is waiting.
    }
  }

  /** `timeoutMs: null` waits indefinitely (a prompt turn runs as long as the
   *  agent works). */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number | null): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    const limit = timeoutMs === undefined ? (this.opts.timeoutMs ?? 30_000) : timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer =
        limit === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id);
              reject(new AcpRpcError(RPC_TIMEOUT, `${method} timed out after ${limit}ms`, undefined, true));
            }, limit);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      this.opts
        .write(JSON.stringify({ jsonrpc: "2.0", id, method, params }))
        .catch((e) => {
          const entry = this.pending.get(id);
          if (!entry) return;
          this.pending.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
          reject(new AcpRpcError(RPC_CLOSED, e instanceof Error ? e.message : String(e), undefined, true));
        });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.opts.write(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  /** The agent is gone: reject everything still waiting, and every later call. */
  close(reason = "The agent process exited."): void {
    if (this.closed) return;
    this.closed = new AcpRpcError(RPC_CLOSED, reason, undefined, true);
    for (const controller of this.inflight.values()) controller.abort();
    this.inflight.clear();
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(this.closed);
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

export const methodNotFound = (method: string): AcpRpcError =>
  new AcpRpcError(RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);

import type { StructuredRunnerHost } from "../structuredEvents";
import type { StructuredRunnerAuthority } from "../structuredRunners";
import { AcpEventMapper } from "./events";
import { checkFsAccess } from "./fsGuard";
import { constrainChoice, decidePermission } from "./permissions";
import {
  ACP_PROTOCOL_VERSION,
  RPC_AUTH_REQUIRED,
  RPC_FORBIDDEN,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
  acpClientCapabilities,
  type AcpConfigOption,
  type AcpConfigValue,
  type AcpFsReadParams,
  type AcpFsWriteParams,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPermissionRequest,
  type AcpPromptResult,
  type AcpSessionUpdate,
  type AcpSystemPromptParam,
} from "./protocol";
import { AcpRpc, AcpRpcError, methodNotFound } from "./rpc";

/** `initialize` and `session/new` can wait on a first `npx -y` download. */
const HANDSHAKE_TIMEOUT_MS = 180_000;
/** `session/close` is a courtesy on the way out; never hold a stop for it. */
const CLOSE_TIMEOUT_MS = 2_000;

/** File access Canopy lends the agent. Injected so this module stays free of
 *  Tauri; transport.ts supplies the real implementation. */
export interface AcpFileSystem {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string, roots: string[]): Promise<void>;
}

export interface AcpSessionOptions {
  write(line: string): Promise<void>;
  host: StructuredRunnerHost;
  authority: StructuredRunnerAuthority;
  cwd: string;
  mcpServers?: unknown[];
  /** Mode id to select after the session exists, when the agent offers it. */
  modeId?: string;
  /** Model value to select after the session exists, when the agent offers it
   *  as a `model` config option. */
  modelId?: string;
  /** Sent as `systemPrompt` (mode append) when the agent advertises support.
   *  `briefDelivered` says whether that happened. */
  systemPrompt?: string;
  /** Shown to the person when the agent needs a sign-in Canopy cannot do. */
  authHint?: string;
  /** When present, `fs/read_text_file` and `fs/write_text_file` are served
   *  (and advertised), under the rules in fsGuard.ts. */
  fs?: AcpFileSystem;
  /** Directories `fs` may touch. Defaults to `[cwd]`. */
  roots?: string[];
  /** Lets an interactive surface answer a permission request. Return the
   *  chosen optionId, `null` to cancel, or `undefined` to defer to policy. */
  onPermission?: (request: AcpPermissionRequest) => Promise<string | null | undefined>;
  requestTimeoutMs?: number;
  closeTimeoutMs?: number;
}

const flattenValues = (option: AcpConfigOption): AcpConfigValue[] =>
  (option.options ?? []).flatMap((o) =>
    "value" in o ? [o as AcpConfigValue] : ((o as { options?: AcpConfigValue[] }).options ?? []),
  );

/** One ACP conversation: handshake, prompts, cancel. */
export class AcpSession {
  readonly rpc: AcpRpc;
  sessionId: string | null = null;
  initialized: AcpInitializeResult | null = null;
  /** True when the brief went out as `systemPrompt` at session setup, so the
   *  first turn must not repeat it. */
  briefDelivered = false;
  /** Latest `configOptions`, from session setup, set_config_option or
   *  `config_option_update`. */
  configOptions: AcpConfigOption[] = [];
  currentModeId: string | undefined;
  private mapper: AcpEventMapper;
  private opts: AcpSessionOptions;
  /** `session/load` replays the old conversation as updates; none of it is a
   *  new turn, so it is dropped until the load resolves. */
  private replaying = false;
  private stopped = false;

  constructor(opts: AcpSessionOptions) {
    this.opts = opts;
    this.mapper = new AcpEventMapper(opts.host);
    this.rpc = new AcpRpc({
      write: opts.write,
      timeoutMs: opts.requestTimeoutMs,
      onRequest: (method, params, signal) => this.onRequest(method, params, signal),
      onNotification: (method, params) => this.onNotification(method, params),
    });
  }

  private handshakeMs(): number {
    return this.opts.requestTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  }

  handleLine(raw: string): void {
    this.rpc.handleLine(raw);
  }

  /** initialize, then session/resume, session/load or session/new. */
  async start(resumeId?: string): Promise<void> {
    this.initialized = await this.rpc.request<AcpInitializeResult>("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: acpClientCapabilities(this.opts.fs),
      clientInfo: { name: "canopy", title: "Canopy", version: "1" },
    }, this.handshakeMs());
    const caps = this.initialized.agentCapabilities;
    const brief = this.opts.systemPrompt;
    const systemPrompt: AcpSystemPromptParam | undefined =
      brief && caps?.sessionCapabilities?.systemPrompt
        ? { mode: "append", content: [{ type: "text", text: brief }] }
        : undefined;
    const base = {
      cwd: this.opts.cwd,
      mcpServers: this.opts.mcpServers ?? [],
      ...(systemPrompt ? { systemPrompt } : {}),
    };
    let created: AcpNewSessionResult | null = null;
    // Resume keeps the conversation without replaying it; load replays it as
    // updates (dropped below). Either failing falls through to a fresh session.
    if (resumeId && caps?.sessionCapabilities?.resume) {
      try {
        const result = await this.withAuth(() =>
          this.rpc.request<Partial<AcpNewSessionResult> | null>("session/resume", { sessionId: resumeId, ...base }, this.handshakeMs()),
        );
        created = { ...(result ?? {}), sessionId: resumeId };
      } catch (e) {
        if (this.authFailed(e)) throw e;
      }
    }
    if (!created && resumeId && caps?.loadSession) {
      this.replaying = true;
      try {
        const result = await this.withAuth(() =>
          this.rpc.request<Partial<AcpNewSessionResult> | null>("session/load", { sessionId: resumeId, ...base }, null),
        );
        created = { ...(result ?? {}), sessionId: resumeId };
      } catch (e) {
        if (this.authFailed(e)) throw e;
        // The conversation is gone; a fresh one is the honest fallback.
      } finally {
        this.replaying = false;
      }
    }
    if (!created) {
      created = await this.withAuth(() =>
        this.rpc.request<AcpNewSessionResult>("session/new", base, this.handshakeMs()),
      );
    }
    this.sessionId = created.sessionId;
    this.briefDelivered = Boolean(systemPrompt);
    this.configOptions = created.configOptions ?? [];
    this.currentModeId = created.modes?.currentModeId;
    await this.applyPolicy(created);
  }

  /** Runs `attempt`; when the agent answers "authenticate first", signs in and
   *  runs it once more. */
  private async withAuth<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (e) {
      if (!this.needsAuth(e)) throw e;
      await this.authenticate(e as AcpRpcError);
      return attempt();
    }
  }

  private needsAuth(e: unknown): boolean {
    return e instanceof AcpRpcError && !e.local && e.code === RPC_AUTH_REQUIRED;
  }

  /** Set once `authenticate` has failed, so a resume fallback does not retry. */
  private authError: Error | null = null;
  private authFailed(e: unknown): boolean {
    return e === this.authError;
  }

  private authMessage(detail: string): Error {
    const hint = this.opts.authHint;
    this.authError = new Error(hint ? `${detail} ${hint}` : detail);
    return this.authError;
  }

  /** Calls `authenticate` with the first method the agent can complete by
   *  itself. `terminal` methods need an interactive login, which Canopy does
   *  not offer, so the person is told what to run instead. */
  private async authenticate(cause: AcpRpcError): Promise<void> {
    const method = this.initialized?.authMethods?.find((m) => !m.type || m.type === "agent");
    if (!method) {
      throw this.authMessage(
        `The agent needs you to sign in (${cause.message}).`,
      );
    }
    try {
      await this.rpc.request("authenticate", { methodId: method.id }, this.handshakeMs());
    } catch (e) {
      throw this.authMessage(
        `The agent could not sign in (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
  }

  /** Select the wanted model and mode, preferring config options and falling
   *  back to the legacy `session/set_mode`. Failures are not fatal: the agent
   *  keeps its own default. */
  private async applyPolicy(created: AcpNewSessionResult): Promise<void> {
    const { modelId, modeId } = this.opts;
    if (modelId) await this.setConfig("model", modelId);
    if (!modeId) return;
    const hasModeOption = this.configOptions.some((o) => o.category === "mode");
    if (hasModeOption) {
      await this.setConfig("mode", modeId);
    } else if (created.modes?.availableModes?.some((m) => m.id === modeId)) {
      await this.rpc
        .request("session/set_mode", { sessionId: this.sessionId, modeId })
        .catch(() => {});
    }
  }

  private async setConfig(category: "model" | "mode", value: string): Promise<void> {
    const option = this.configOptions.find((o) => o.category === category);
    if (!option || option.currentValue === value) return;
    if (!flattenValues(option).some((v) => v.value === value)) return;
    try {
      const result = await this.rpc.request<{ configOptions?: AcpConfigOption[] } | null>(
        "session/set_config_option",
        { sessionId: this.sessionId, configId: option.id, value },
      );
      if (result?.configOptions) this.configOptions = result.configOptions;
    } catch {
      // Same as set_mode: the agent keeps its default.
    }
  }

  /** Runs one turn. Resolves after `turnEnd` has been emitted. */
  async prompt(text: string): Promise<void> {
    if (!this.sessionId) throw new Error("The ACP session has not started.");
    this.mapper.beginTurn();
    try {
      const result = await this.rpc.request<AcpPromptResult>(
        "session/prompt",
        { sessionId: this.sessionId, prompt: [{ type: "text", text }] },
        null,
      );
      this.mapper.endTurn(result?.stopReason);
    } catch (e) {
      // A deliberate stop rejects the pending prompt locally; that is not a failure.
      if (this.stopped) {
        this.mapper.endTurn("cancelled");
        return;
      }
      this.mapper.fail(e instanceof Error ? e.message : String(e));
    }
  }

  async cancel(): Promise<void> {
    if (this.sessionId) await this.rpc.notify("session/cancel", { sessionId: this.sessionId });
  }

  /** Closes after a user-initiated stop: the in-flight prompt ends quietly.
   *  Tells the agent to release the session first when it supports that. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sessionId && this.initialized?.agentCapabilities?.sessionCapabilities?.close) {
      // -32002 (already closed) and every other failure mean the same thing here.
      await this.rpc
        .request("session/close", { sessionId: this.sessionId }, this.opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS)
        .catch(() => {});
    }
    this.rpc.close("stopped");
  }

  close(reason?: string): void {
    this.rpc.close(reason);
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update" || this.replaying) return;
    const p = params as { sessionId?: string; update?: AcpSessionUpdate } | undefined;
    if (this.sessionId && p?.sessionId && p.sessionId !== this.sessionId) return;
    const update = p?.update;
    if (update?.sessionUpdate === "config_option_update") {
      const options = (update as { configOptions?: AcpConfigOption[] }).configOptions;
      if (Array.isArray(options)) this.configOptions = options;
      return;
    }
    if (update?.sessionUpdate === "current_mode_update") {
      const id = (update as { currentModeId?: string }).currentModeId;
      if (typeof id === "string") this.currentModeId = id;
      return;
    }
    this.mapper.handleUpdate(update);
  }

  private async onRequest(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    if (method === "fs/read_text_file" && this.opts.fs) return this.readFile(params as AcpFsReadParams);
    if (method === "fs/write_text_file" && this.opts.fs) return this.writeFile(params as AcpFsWriteParams);
    if (method !== "session/request_permission") throw methodNotFound(method);
    const request = params as AcpPermissionRequest;
    let decision = decidePermission(request, this.opts.authority);
    if (this.opts.onPermission) {
      const choice = await this.opts.onPermission(request);
      if (signal.aborted) return decision.response;
      if (choice !== undefined) decision = constrainChoice(request, choice) ?? decision;
    }
    if (decision.denied) {
      this.mapper.blocked(request.toolCall?.title || request.toolCall?.kind || "tool");
    }
    return decision.response;
  }

  private roots(): string[] {
    return this.opts.roots?.length ? this.opts.roots : [this.opts.cwd];
  }

  private guard(op: "read" | "write", path: unknown) {
    const verdict = checkFsAccess(op, String(path ?? ""), {
      roots: this.roots(),
      authority: this.opts.authority,
    });
    if (verdict.ok) return verdict.path;
    if (verdict.blocked && op === "write") this.mapper.blocked(`write ${String(path)}`);
    throw new AcpRpcError(verdict.blocked ? RPC_FORBIDDEN : RPC_INVALID_PARAMS, verdict.message);
  }

  private async readFile(p: AcpFsReadParams): Promise<{ content: string }> {
    const path = this.guard("read", p?.path);
    let content: string;
    try {
      content = await this.opts.fs!.readTextFile(path);
    } catch (e) {
      throw new AcpRpcError(RPC_INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
    }
    const start = Number.isInteger(p.line) && (p.line as number) > 0 ? (p.line as number) : 1;
    const limit = Number.isInteger(p.limit) && (p.limit as number) >= 0 ? (p.limit as number) : undefined;
    if (start === 1 && limit === undefined) return { content };
    const lines = content.split("\n").slice(start - 1);
    return { content: (limit === undefined ? lines : lines.slice(0, limit)).join("\n") };
  }

  private async writeFile(p: AcpFsWriteParams): Promise<Record<string, never>> {
    const path = this.guard("write", p?.path);
    if (typeof p.content !== "string") {
      throw new AcpRpcError(RPC_INVALID_PARAMS, "content must be a string.");
    }
    try {
      await this.opts.fs!.writeTextFile(path, p.content, this.roots());
    } catch (e) {
      throw new AcpRpcError(RPC_INTERNAL_ERROR, e instanceof Error ? e.message : String(e));
    }
    return {};
  }
}

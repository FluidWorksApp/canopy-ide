import type { StructuredRunnerHost } from "../structuredEvents";
import type { StructuredRunnerAuthority } from "../structuredRunners";
import { AcpEventMapper } from "./events";
import { constrainChoice, decidePermission } from "./permissions";
import {
  ACP_PROTOCOL_VERSION,
  CANOPY_ACP_CAPABILITIES,
  type AcpInitializeResult,
  type AcpNewSessionResult,
  type AcpPermissionRequest,
  type AcpPromptResult,
  type AcpSessionUpdate,
} from "./protocol";
import { AcpRpc, methodNotFound } from "./rpc";

export interface AcpSessionOptions {
  write(line: string): Promise<void>;
  host: StructuredRunnerHost;
  authority: StructuredRunnerAuthority;
  cwd: string;
  mcpServers?: unknown[];
  /** Mode id to select after the session exists, when the agent offers it. */
  modeId?: string;
  /** Lets an interactive surface answer a permission request. Return the
   *  chosen optionId, `null` to cancel, or `undefined` to defer to policy. */
  onPermission?: (request: AcpPermissionRequest) => Promise<string | null | undefined>;
  requestTimeoutMs?: number;
}

/** One ACP conversation: handshake, prompts, cancel. */
export class AcpSession {
  readonly rpc: AcpRpc;
  sessionId: string | null = null;
  initialized: AcpInitializeResult | null = null;
  private mapper: AcpEventMapper;
  private opts: AcpSessionOptions;
  /** `session/load` replays the old conversation as updates; none of it is a
   *  new turn, so it is dropped until the load resolves. */
  private replaying = false;

  constructor(opts: AcpSessionOptions) {
    this.opts = opts;
    this.mapper = new AcpEventMapper(opts.host);
    this.rpc = new AcpRpc({
      write: opts.write,
      timeoutMs: opts.requestTimeoutMs,
      onRequest: (method, params) => this.onRequest(method, params),
      onNotification: (method, params) => this.onNotification(method, params),
    });
  }

  handleLine(raw: string): void {
    this.rpc.handleLine(raw);
  }

  /** initialize, then session/load (when asked and supported) or session/new. */
  async start(resumeId?: string): Promise<void> {
    this.initialized = await this.rpc.request<AcpInitializeResult>("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: CANOPY_ACP_CAPABILITIES,
      clientInfo: { name: "canopy", title: "Canopy", version: "1" },
    });
    const base = { cwd: this.opts.cwd, mcpServers: this.opts.mcpServers ?? [] };
    let created: AcpNewSessionResult | null = null;
    if (resumeId && this.initialized.agentCapabilities?.loadSession) {
      this.replaying = true;
      try {
        await this.rpc.request("session/load", { sessionId: resumeId, ...base }, null);
        created = { sessionId: resumeId };
      } catch {
        // The conversation is gone; a fresh one is the honest fallback.
      } finally {
        this.replaying = false;
      }
    }
    if (!created) created = await this.rpc.request<AcpNewSessionResult>("session/new", base);
    this.sessionId = created.sessionId;
    const wanted = this.opts.modeId;
    if (wanted && created.modes?.availableModes?.some((m) => m.id === wanted)) {
      await this.rpc
        .request("session/set_mode", { sessionId: this.sessionId, modeId: wanted })
        .catch(() => {});
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
      this.mapper.fail(e instanceof Error ? e.message : String(e));
    }
  }

  async cancel(): Promise<void> {
    if (this.sessionId) await this.rpc.notify("session/cancel", { sessionId: this.sessionId });
  }

  close(reason?: string): void {
    this.rpc.close(reason);
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== "session/update" || this.replaying) return;
    const p = params as { sessionId?: string; update?: AcpSessionUpdate } | undefined;
    if (this.sessionId && p?.sessionId && p.sessionId !== this.sessionId) return;
    this.mapper.handleUpdate(p?.update);
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== "session/request_permission") throw methodNotFound(method);
    const request = params as AcpPermissionRequest;
    let decision = decidePermission(request, this.opts.authority);
    if (this.opts.onPermission) {
      const choice = await this.opts.onPermission(request);
      if (choice !== undefined) decision = constrainChoice(request, choice) ?? decision;
    }
    if (decision.denied) {
      this.mapper.blocked(request.toolCall?.title || request.toolCall?.kind || "tool");
    }
    return decision.response;
  }
}

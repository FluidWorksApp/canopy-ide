/** Wire shapes for the Agent Client Protocol (https://agentclientprotocol.com),
 *  protocol version 1: JSON-RPC 2.0, one message per line over stdio.
 *
 *  Only what Canopy sends or reads is typed. Everything else on a message is
 *  ignored, so an agent's vendor extensions (`_kiro.dev/...`, `_meta`) degrade
 *  to silence instead of a throw. */

export const ACP_PROTOCOL_VERSION = 1;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/** What Canopy offers the agent. Nothing is advertised that is not
 *  implemented. `fs` is on only when the session was given file handlers
 *  (see `acpClientCapabilities`). `terminal` is never offered: the agent keeps
 *  running its own shell, which the permission policy in permissions.ts gates,
 *  and Canopy has no pty it could lend per tool call. `auth.terminal` is not
 *  advertised either, so agents never ask Canopy to run an interactive login;
 *  the person is told what to run instead (`authHint`). */
export interface AcpClientCapabilities {
  fs: { readTextFile: boolean; writeTextFile: boolean };
  terminal: false;
}

export function acpClientCapabilities(
  fs?: { readTextFile?: unknown; writeTextFile?: unknown },
): AcpClientCapabilities {
  return {
    fs: { readTextFile: Boolean(fs?.readTextFile), writeTextFile: Boolean(fs?.writeTextFile) },
    terminal: false,
  };
}

/** Capabilities of a session without file handlers. */
export const CANOPY_ACP_CAPABILITIES: AcpClientCapabilities = acpClientCapabilities();

export interface AcpSessionCapabilities {
  resume?: Record<string, unknown> | null;
  close?: Record<string, unknown> | null;
  systemPrompt?: { mode?: { override?: unknown } | null } | null;
  additionalDirectories?: Record<string, unknown> | null;
}

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  sessionCapabilities?: AcpSessionCapabilities;
  auth?: { logout?: Record<string, unknown> | null };
}

/** `type` is absent or 'agent' when the agent signs in by itself; 'terminal'
 *  needs an interactive login Canopy does not offer. */
export interface AcpAuthMethod {
  id: string;
  name?: string;
  description?: string;
  type?: "agent" | "terminal" | string;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: AcpAgentCapabilities;
  authMethods?: AcpAuthMethod[];
  agentInfo?: { name?: string; title?: string; version?: string };
}

/** JSON-RPC code agents use for "authenticate first". */
export const RPC_AUTH_REQUIRED = -32000;
/** `session/close` on a session that is already closed. */
export const RPC_SESSION_CLOSED = -32002;
/** The request was cancelled by `$/cancel_request`. */
export const RPC_REQUEST_CANCELLED = -32800;
/** Canopy refused a file request (outside root, read-only, protected path). */
export const RPC_FORBIDDEN = -32003;

export interface AcpConfigValue {
  value: string;
  name?: string;
  description?: string;
}

/** A session config option. Only `select` is read; other types are ignored. */
export interface AcpConfigOption {
  id: string;
  name?: string;
  category?: "mode" | "model" | "thought_level" | string;
  type?: string;
  currentValue?: string;
  /** Flat values, or groups of values. */
  options?: (AcpConfigValue | { group?: string; name?: string; options?: AcpConfigValue[] })[];
}

export interface AcpSystemPromptParam {
  mode: "append";
  content: { type: "text"; text: string }[];
}

export interface AcpFsReadParams {
  sessionId: string;
  path: string;
  /** 1-based. */
  line?: number;
  limit?: number;
}

export interface AcpFsWriteParams {
  sessionId: string;
  path: string;
  content: string;
}

export interface AcpPlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed" | string;
  priority?: "high" | "medium" | "low" | string;
}

export interface AcpSessionMode {
  id: string;
  name?: string;
  description?: string;
}

export interface AcpNewSessionResult {
  sessionId: string;
  configOptions?: AcpConfigOption[];
  modes?: { currentModeId?: string; availableModes?: AcpSessionMode[] };
  models?: { currentModelId?: string; availableModels?: { modelId: string; name?: string }[] };
}

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

export interface AcpPromptResult {
  stopReason?: AcpStopReason | string;
}

export type AcpContentBlock =
  | { type: "text"; text: string }
  | { type: string; [key: string]: unknown };

export type AcpToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface AcpToolCallFields {
  toolCallId: string;
  title?: string;
  kind?: AcpToolKind | string;
  status?: AcpToolStatus | string;
  locations?: { path?: string; line?: number }[];
  rawInput?: unknown;
}

/** The `update` payload of a `session/update` notification. */
export type AcpSessionUpdate =
  | { sessionUpdate: "agent_message_chunk"; content?: AcpContentBlock }
  | { sessionUpdate: "agent_thought_chunk"; content?: AcpContentBlock }
  | { sessionUpdate: "user_message_chunk"; content?: AcpContentBlock }
  | ({ sessionUpdate: "tool_call" } & AcpToolCallFields)
  | ({ sessionUpdate: "tool_call_update" } & Partial<AcpToolCallFields> & { toolCallId: string })
  | { sessionUpdate: "plan"; entries?: AcpPlanEntry[] }
  | { sessionUpdate: "available_commands_update"; availableCommands?: unknown[] }
  | { sessionUpdate: "current_mode_update"; currentModeId?: string }
  | { sessionUpdate: "config_option_update"; configOptions?: AcpConfigOption[] }
  | { sessionUpdate: "session_info_update"; title?: string | null; updatedAt?: string | null }
  | {
      sessionUpdate: "usage_update";
      used?: number;
      size?: number;
      cost?: { amount: number; currency: string } | null;
    }
  | { sessionUpdate: string; [key: string]: unknown };

export interface AcpPermissionOption {
  optionId: string;
  name?: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: AcpToolCallFields;
  options: AcpPermissionOption[];
}

export type AcpPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface AcpPermissionResponse {
  outcome: AcpPermissionOutcome;
}

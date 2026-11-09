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
 *  implemented: the agent keeps using its own file and shell tools, which run
 *  under the permission policy in permissions.ts. */
export interface AcpClientCapabilities {
  fs: { readTextFile: false; writeTextFile: false };
  terminal: false;
}

export const CANOPY_ACP_CAPABILITIES: AcpClientCapabilities = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: AcpAgentCapabilities;
  authMethods?: { id: string; name?: string; description?: string }[];
  agentInfo?: { name?: string; title?: string; version?: string };
}

export interface AcpSessionMode {
  id: string;
  name?: string;
  description?: string;
}

export interface AcpNewSessionResult {
  sessionId: string;
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
  | { sessionUpdate: "plan"; entries?: unknown[] }
  | { sessionUpdate: "available_commands_update"; availableCommands?: unknown[] }
  | { sessionUpdate: "current_mode_update"; currentModeId?: string }
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

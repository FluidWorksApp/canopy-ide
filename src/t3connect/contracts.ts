// Wire shapes of the T3 Code server, copied from T3 Code's schemas (MIT,
// commit d0f1f720). Each type names the schema it mirrors. These are the
// encoded (JSON) forms: what crosses the socket, not Effect's decoded types.
// Fields Canopy never reads are left out of results and typed loosely.

/** packages/contracts/src/environment.ts: ORCHESTRATION_PROTOCOL_VERSION, its query
 *  parameter, and CLIENT_CAPABILITIES_QUERY_PARAM / SETTINGS_SECRET_REFERENCES_CAPABILITY.
 *  The server answers /ws with 426 unless orchestrationProtocol matches. */
export const ORCHESTRATION_PROTOCOL_VERSION = 2;
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";
export const CLIENT_CAPABILITIES_QUERY_PARAM = "clientCapabilities";
export const SETTINGS_SECRET_REFERENCES_CAPABILITY = "settingsSecretReferences";
/** packages/shared/src/socketFrameParts.ts: SOCKET_FRAME_PARTS_QUERY_PARAM. */
export const SOCKET_FRAME_PARTS_QUERY_PARAM = "frameParts";

/** packages/contracts/src/environment.ts: ExecutionEnvironmentDescriptor
 *  (GET /.well-known/t3/environment). */
export interface ExecutionEnvironmentDescriptor {
  readonly environmentId: string;
  readonly label: string;
  readonly platform: { readonly os: string; readonly arch: string; readonly machine?: string };
  readonly serverVersion: string;
  readonly orchestrationProtocolVersion?: number;
  readonly databaseMigration?: number;
  readonly capabilities: Record<string, unknown>;
}

/** packages/contracts/src/auth.ts: the scopes Canopy asks for (AuthEnvironmentScope). */
export const T3_CANOPY_SCOPES = [
  "orchestration:read",
  "filesystem:read",
  "filesystem:write",
  "terminal:read",
  "terminal:operate",
] as const;

/** packages/contracts/src/auth.ts: AuthTokenExchangeGrantType, AuthEnvironmentBootstrapTokenType,
 *  AuthAccessTokenType. */
export const AUTH_TOKEN_EXCHANGE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
export const AUTH_ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE = "urn:t3:params:oauth:token-type:environment-bootstrap";
export const AUTH_ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/** packages/contracts/src/auth.ts: AuthTokenExchangeRequest (form-encoded POST /oauth/token). */
export interface AuthTokenExchangeRequest {
  readonly grant_type: typeof AUTH_TOKEN_EXCHANGE_GRANT_TYPE;
  readonly subject_token: string;
  readonly subject_token_type: typeof AUTH_ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE;
  readonly requested_token_type: typeof AUTH_ACCESS_TOKEN_TYPE;
  readonly scope?: string;
  readonly client_label?: string;
  readonly client_device_type?: "desktop" | "mobile" | "tablet" | "bot" | "unknown";
  readonly client_os?: string;
}

/** packages/contracts/src/auth.ts: AuthAccessTokenResult. */
export interface AuthAccessTokenResult {
  readonly access_token: string;
  readonly issued_token_type: typeof AUTH_ACCESS_TOKEN_TYPE;
  readonly token_type: "Bearer" | "DPoP";
  readonly expires_in: number;
  readonly scope: string;
}

/** packages/contracts/src/auth.ts: AuthWebSocketTicketResult (DateTimeUtc encodes as an ISO string). */
export interface AuthWebSocketTicketResult {
  readonly ticket: string;
  readonly expiresAt: string;
}

/** packages/contracts/src/auth.ts: AuthSessionState (GET /api/auth/session), the fields Canopy reads. */
export interface AuthSessionState {
  readonly authenticated: boolean;
  readonly scopes?: ReadonlyArray<string>;
  readonly permissions?: ReadonlyArray<string>;
  readonly expiresAt?: string;
}

/** packages/contracts/src/rpc.ts: WS_METHODS and ORCHESTRATION_V2_WS_METHODS
 *  (packages/contracts/src/orchestrationV2.ts), the methods Canopy calls. */
export const T3_METHODS = {
  serverGetConfig: "server.getConfig",
  subscribeShell: "orchestration.subscribeShell",
  projectsListEntries: "projects.listEntries",
  projectsReadFile: "projects.readFile",
  projectsWriteFile: "projects.writeFile",
  projectsSearchEntries: "projects.searchEntries",
  terminalOpen: "terminal.open",
  terminalAttach: "terminal.attach",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClose: "terminal.close",
} as const;

/** packages/contracts/src/project.ts: ProjectEntry. */
export interface ProjectEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly ignored?: boolean;
}

/** packages/contracts/src/project.ts: ProjectListEntriesInput. */
export interface ProjectListEntriesInput {
  readonly cwd: string;
  readonly directoryPath?: string;
}
/** packages/contracts/src/project.ts: ProjectListEntriesResult. */
export interface ProjectListEntriesResult {
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly truncated: boolean;
}

/** packages/contracts/src/project.ts: ProjectSearchEntriesInput (limit 1..200, query ≤256). */
export interface ProjectSearchEntriesInput {
  readonly cwd: string;
  readonly query: string;
  readonly limit: number;
  readonly kind?: "file" | "directory";
  readonly imageOnly?: boolean;
}
/** packages/contracts/src/project.ts: ProjectSearchEntriesResult. */
export interface ProjectSearchEntriesResult {
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly truncated: boolean;
}

/** packages/contracts/src/project.ts: ProjectReadFileInput (relativePath ≤512). */
export interface ProjectReadFileInput {
  readonly cwd: string;
  readonly relativePath: string;
  readonly allowMissing?: boolean;
}
/** packages/contracts/src/project.ts: ProjectReadFileResult. */
export interface ProjectReadFileResult {
  readonly relativePath: string;
  readonly contents: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly exists?: boolean;
}

/** packages/contracts/src/project.ts: ProjectWriteFileInput (relativePath ≤512). */
export interface ProjectWriteFileInput {
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
}
/** packages/contracts/src/project.ts: ProjectWriteFileResult. */
export interface ProjectWriteFileResult {
  readonly relativePath: string;
}

/** packages/contracts/src/terminal.ts: TerminalOpenInput (terminal ids are client-chosen,
 *  ≤128 chars; cols 1..1000, rows 1..500). */
export interface TerminalOpenInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath?: string | null;
  readonly cols?: number;
  readonly rows?: number;
  readonly env?: Record<string, string>;
  readonly providerInstanceId?: string;
  readonly stopOnSettle?: boolean;
}
/** packages/contracts/src/terminal.ts: TerminalAttachInput. */
export interface TerminalAttachInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd?: string;
  readonly worktreePath?: string | null;
  readonly cols?: number;
  readonly rows?: number;
  readonly env?: Record<string, string>;
  readonly providerInstanceId?: string;
  readonly stopOnSettle?: boolean;
  readonly restartIfNotRunning?: boolean;
  readonly resume?: boolean;
}
/** packages/contracts/src/terminal.ts: TerminalWriteInput (data 1..65536 chars). */
export interface TerminalWriteInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly data: string;
}
/** packages/contracts/src/terminal.ts: TerminalResizeInput. */
export interface TerminalResizeInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cols: number;
  readonly rows: number;
}
/** packages/contracts/src/terminal.ts: TerminalCloseInput. */
export interface TerminalCloseInput {
  readonly threadId: string;
  readonly terminalId?: string;
  readonly deleteHistory?: boolean;
}
/** packages/contracts/src/terminal.ts: TerminalSessionSnapshot. */
export interface TerminalSessionSnapshot {
  readonly threadId: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly status: "starting" | "running" | "exited" | "error";
  readonly pid: number | null;
  readonly history: string;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly label: string;
  readonly updatedAt: string;
  readonly sequence?: number;
  readonly cols?: number;
  readonly rows?: number;
}
interface TerminalEventBase {
  readonly threadId: string;
  readonly terminalId: string;
  readonly sequence?: number;
}
/** packages/contracts/src/terminal.ts: TerminalAttachStreamEvent. */
export type TerminalAttachStreamEvent =
  | { readonly type: "snapshot"; readonly snapshot: TerminalSessionSnapshot }
  | (TerminalEventBase & { readonly type: "output"; readonly data: string })
  | (TerminalEventBase & { readonly type: "exited"; readonly exitCode: number | null; readonly exitSignal: number | null })
  | (TerminalEventBase & { readonly type: "closed" })
  | (TerminalEventBase & { readonly type: "error"; readonly message: string })
  | (TerminalEventBase & { readonly type: "cleared" })
  | (TerminalEventBase & { readonly type: "restarted"; readonly snapshot: TerminalSessionSnapshot })
  | (TerminalEventBase & {
      readonly type: "activity";
      readonly hasRunningSubprocess: boolean;
      readonly label: string;
      readonly cols?: number;
      readonly rows?: number;
    });

/** packages/contracts/src/orchestrationProject.ts: OrchestrationProjectShell, the fields Canopy reads. */
export interface OrchestrationProjectShell {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly archivedAt?: string | null;
  readonly [field: string]: unknown;
}

/** orchestration thread shell, the fields Canopy reads. Everything is optional
 *  because the snapshot's thread shape is not pinned by a Canopy test against a
 *  live server; unknown shapes are dropped in methods.ts. */
export interface OrchestrationThreadShell {
  readonly id: string;
  readonly projectId?: string;
  readonly title?: string;
  readonly status?: string;
  readonly branch?: string | null;
  readonly archivedAt?: string | null;
  readonly [field: string]: unknown;
}

/** packages/contracts/src/orchestrationV2.ts: OrchestrationV2SubscribeShellInput. */
export interface OrchestrationV2SubscribeShellInput {
  readonly afterSequence?: number;
  readonly httpSnapshotFallback?: true;
  readonly requestCompletionMarker?: boolean;
  readonly omitIdleSubagents?: boolean;
  readonly omitOlderSettled?: boolean;
}
/** packages/contracts/src/orchestrationV2.ts: OrchestrationV2ShellStreamItem, the kinds Canopy reads. */
export type OrchestrationV2ShellStreamItem =
  | { readonly kind: "synchronized" }
  | { readonly kind: "snapshot-required" }
  | { readonly kind: "snapshot"; readonly snapshot: { readonly projects: ReadonlyArray<OrchestrationProjectShell>; readonly threads?: ReadonlyArray<OrchestrationThreadShell>; readonly [field: string]: unknown } }
  | { readonly kind: "project.updated"; readonly sequence: number; readonly project: OrchestrationProjectShell }
  | { readonly kind: "project.removed"; readonly sequence: number; readonly projectId: string }
  | { readonly kind: string; readonly [field: string]: unknown };

/** packages/contracts/src/server.ts: ServerConfig (server.getConfig), the fields Canopy reads. */
export interface ServerConfig {
  readonly environment: ExecutionEnvironmentDescriptor;
  readonly cwd: string;
  readonly [field: string]: unknown;
}

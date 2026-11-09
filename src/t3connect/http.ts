// The HTTP half of connecting to a T3 Code machine, in TypeScript. Canopy's
// app does these from Rust (src-tauri/src/t3_client.rs) so the access token
// never reaches the webview; this copy makes the same requests, in the same
// order, for the integration test and for anything that runs outside the app.
// Sources (T3 Code, MIT, commit d0f1f720):
//   packages/client-runtime/src/environment/descriptor.ts  GET /.well-known/t3/environment
//   packages/client-runtime/src/authorization/remote.ts     POST /oauth/token,
//     GET /api/auth/session, POST /api/auth/websocket-ticket[/rpc], the /ws URL
//   packages/client-runtime/src/connection/compatibility.ts appendOrchestrationProtocol
//   packages/shared/src/oauthScope.ts                       encodeOAuthScope

import {
  AUTH_ACCESS_TOKEN_TYPE,
  AUTH_ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE,
  AUTH_TOKEN_EXCHANGE_GRANT_TYPE,
  CLIENT_CAPABILITIES_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  SETTINGS_SECRET_REFERENCES_CAPABILITY,
  SOCKET_FRAME_PARTS_QUERY_PARAM,
  type AuthAccessTokenResult,
  type AuthSessionState,
  type AuthTokenExchangeRequest,
  type AuthWebSocketTicketResult,
  type ExecutionEnvironmentDescriptor,
} from "./contracts";

const DEFAULT_TIMEOUT_MS = 10_000;
const OAUTH_SCOPE_TOKEN = /^[\u0021\u0023-\u005b\u005d-\u007e]+$/u;

/** packages/shared/src/oauthScope.ts encodeOAuthScope: space-separated,
 *  non-empty, each token valid, no duplicates. */
export function encodeOAuthScope(scopes: ReadonlyArray<string>): string {
  if (scopes.length === 0 || scopes.some(scope => !OAUTH_SCOPE_TOKEN.test(scope)) || new Set(scopes).size !== scopes.length) {
    throw new Error("OAuth scopes must be non-empty, syntactically valid, and unique.");
  }
  return scopes.join(" ");
}

/** packages/client-runtime/src/environment/endpoint.ts environmentEndpointUrl. */
export function environmentEndpointUrl(httpBaseUrl: string, pathname: string): string {
  const url = new URL(httpBaseUrl);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export class T3HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(what: string, status: number, body: string) {
    super(`${what} answered ${status}${body ? `: ${body.slice(0, 300)}` : ""}`);
    this.status = status;
    this.body = body;
  }
}

async function request<A>(what: string, url: string, init: RequestInit, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<A> {
  const response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.text();
  if (!response.ok) throw new T3HttpError(what, response.status, body);
  return JSON.parse(body) as A;
}

export function fetchEnvironmentDescriptor(httpBaseUrl: string): Promise<ExecutionEnvironmentDescriptor> {
  return request("/.well-known/t3/environment", environmentEndpointUrl(httpBaseUrl, "/.well-known/t3/environment"), {
    headers: { accept: "application/json" },
  });
}

/** bootstrapRemoteBearerSession: redeems the one-time pairing code. */
export function exchangePairingCredential(input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly scopes?: ReadonlyArray<string>;
  readonly clientLabel?: string;
  readonly clientOs?: string;
}): Promise<AuthAccessTokenResult> {
  const form: AuthTokenExchangeRequest = {
    grant_type: AUTH_TOKEN_EXCHANGE_GRANT_TYPE,
    subject_token: input.credential,
    subject_token_type: AUTH_ENVIRONMENT_BOOTSTRAP_TOKEN_TYPE,
    requested_token_type: AUTH_ACCESS_TOKEN_TYPE,
    ...(input.scopes ? { scope: encodeOAuthScope(input.scopes) } : {}),
    ...(input.clientLabel ? { client_label: input.clientLabel } : {}),
    client_device_type: "desktop",
    ...(input.clientOs ? { client_os: input.clientOs } : {}),
  };
  return request("/oauth/token", environmentEndpointUrl(input.httpBaseUrl, "/oauth/token"), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(Object.entries(form) as [string, string][]).toString(),
  });
}

export function fetchSessionState(httpBaseUrl: string, accessToken: string): Promise<AuthSessionState> {
  return request("/api/auth/session", environmentEndpointUrl(httpBaseUrl, "/api/auth/session"), {
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
}

/** issueRemoteWebSocketTicket with use "rpc": a server older than ticket
 *  audiences has no /:use route and answers 404, so ask the bare path. */
export async function issueWebSocketTicket(httpBaseUrl: string, accessToken: string): Promise<AuthWebSocketTicketResult> {
  const init = { method: "POST", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } };
  try {
    return await request("/api/auth/websocket-ticket/rpc", environmentEndpointUrl(httpBaseUrl, "/api/auth/websocket-ticket/rpc"), init);
  } catch (error) {
    if (!(error instanceof T3HttpError) || error.status !== 404) throw error;
    return request("/api/auth/websocket-ticket", environmentEndpointUrl(httpBaseUrl, "/api/auth/websocket-ticket"), init);
  }
}

/** resolveRemoteWebSocketConnectionUrl + appendOrchestrationProtocol, plus the
 *  frameParts opt-in session.ts adds. */
export function rpcSocketUrl(httpBaseUrl: string, ticket: string, clientOs?: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("clientDeviceType", "desktop");
  if (clientOs) url.searchParams.set("clientOs", clientOs);
  url.searchParams.set("connectionMethod", "direct");
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  url.searchParams.set(CLIENT_CAPABILITIES_QUERY_PARAM, SETTINGS_SECRET_REFERENCES_CAPABILITY);
  url.searchParams.set(SOCKET_FRAME_PARTS_QUERY_PARAM, "1");
  return url.toString();
}

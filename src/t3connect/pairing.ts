// Pairing links for T3 Code machines, ported from T3 Code's
// packages/shared/src/remote.ts (MIT, commit d0f1f720). The function names and
// error tags match that file so a diff against it stays readable.
//
// Link forms it accepts:
//   https://host/pair#token=CODE         a direct pairing link
//   https://host/pair?token=CODE         the older query-token form
//   https://app.t3.codes/pair?host=URL#token=CODE   a hosted-app link
//   t3code://pair?pairingUrl=<one of the above>      the desktop/mobile app link
// The network (LAN, Tailscale, a tunnel, a T3 Connect hostname) only shows up
// as the host in the URL.

const PAIRING_TOKEN_PARAM = "token";
const HOSTED_PAIRING_HOST_PARAM = "host";
const HOSTED_PAIRING_LABEL_PARAM = "label";
const PAIRING_APP_LINK_PARAM = "pairingUrl";
const APP_LINK_PROTOCOL = /^t3code(?:-[a-z]+)?:$/;
const SUPPORTED_REMOTE_BACKEND_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

export type RemotePairingErrorTag =
  | "RemoteBackendUrlMissingError"
  | "RemotePairingUrlInvalidError"
  | "RemoteBackendUrlInvalidError"
  | "RemotePairingTokenMissingError"
  | "RemotePairingCodeMissingError";

const MESSAGES: Record<RemotePairingErrorTag, string> = {
  RemoteBackendUrlMissingError: "Enter a backend URL.",
  RemotePairingUrlInvalidError: "Pairing URL is invalid.",
  RemoteBackendUrlInvalidError: "Backend URL is invalid.",
  RemotePairingTokenMissingError: "Pairing URL is missing its token.",
  RemotePairingCodeMissingError: "Enter a pairing code.",
};

export class RemotePairingError extends Error {
  readonly _tag: RemotePairingErrorTag;
  readonly protocol?: string;
  readonly host?: string;
  constructor(tag: RemotePairingErrorTag, detail: { protocol?: string; host?: string } = {}) {
    super(MESSAGES[tag]);
    this._tag = tag;
    if (detail.protocol !== undefined) this.protocol = detail.protocol;
    if (detail.host !== undefined) this.host = detail.host;
  }
}

export const readHashParams = (url: URL): URLSearchParams =>
  new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);

const hasSupportedRemoteBackendProtocol = (url: URL): boolean =>
  SUPPORTED_REMOTE_BACKEND_PROTOCOLS.has(url.protocol);

const normalizeRemoteBaseUrl = (rawValue: string): URL => {
  const trimmed = rawValue.trim();
  if (!trimmed) throw new RemotePairingError("RemoteBackendUrlMissingError");
  const withoutLeadingSlashes = trimmed.replace(/^\/+/, "");
  const normalizedInput = /^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(withoutLeadingSlashes)
    ? withoutLeadingSlashes
    : `https://${withoutLeadingSlashes}`;
  let url: URL;
  try {
    url = new URL(normalizedInput);
  } catch {
    throw new RemotePairingError("RemoteBackendUrlInvalidError");
  }
  if (!hasSupportedRemoteBackendProtocol(url)) {
    throw new RemotePairingError("RemoteBackendUrlInvalidError", { protocol: url.protocol });
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
};

const toHttpBaseUrl = (url: URL): string => {
  const next = new URL(url.toString());
  if (next.protocol === "ws:") next.protocol = "http:";
  else if (next.protocol === "wss:") next.protocol = "https:";
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
};

const toWsBaseUrl = (url: URL): string => {
  const next = new URL(url.toString());
  if (next.protocol === "http:") next.protocol = "ws:";
  else if (next.protocol === "https:") next.protocol = "wss:";
  next.pathname = "/";
  next.search = "";
  next.hash = "";
  return next.toString();
};

export interface ResolvedRemotePairingTarget {
  readonly credential: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export const getPairingTokenFromUrl = (url: URL): string | null => {
  const hashToken = readHashParams(url).get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  if (hashToken.length > 0) return hashToken;
  const searchToken = url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  return searchToken.length > 0 ? searchToken : null;
};

export const readHostedPairingRequest = (url: URL): HostedPairingRequest | null => {
  const host = url.searchParams.get(HOSTED_PAIRING_HOST_PARAM)?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get(HOSTED_PAIRING_LABEL_PARAM)?.trim() ?? "";
  if (!host || !token) return null;
  return { host, token, label };
};

/** Wraps a pairing URL in the `t3code://pair` link that desktop opens and mobile scans. */
export const buildPairingAppLink = (pairingUrl: string): string =>
  `t3code://pair?${new URLSearchParams([[PAIRING_APP_LINK_PARAM, pairingUrl]])}`;

/** Reads the pairing URL from a `t3code://pair` link on any app channel scheme. */
export const readPairingAppLink = (value: string): string | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!APP_LINK_PROTOCOL.test(url.protocol) || url.host !== "pair") return null;
  if (url.pathname !== "" && url.pathname !== "/") return null;
  return url.searchParams.get(PAIRING_APP_LINK_PARAM)?.trim() || null;
};

export const resolveRemotePairingTarget = (input: {
  readonly pairingUrl?: string;
  readonly host?: string;
  readonly pairingCode?: string;
}): ResolvedRemotePairingTarget => {
  const pairingUrl = input.pairingUrl?.trim() ?? "";
  if (pairingUrl.length > 0) {
    let url: URL;
    try {
      url = new URL(pairingUrl);
    } catch {
      throw new RemotePairingError("RemotePairingUrlInvalidError");
    }
    if (!hasSupportedRemoteBackendProtocol(url)) {
      throw new RemotePairingError("RemotePairingUrlInvalidError", { protocol: url.protocol });
    }
    const hosted = readHostedPairingRequest(url);
    if (hosted) {
      const hostedBackendUrl = normalizeRemoteBaseUrl(hosted.host);
      return {
        credential: hosted.token,
        httpBaseUrl: toHttpBaseUrl(hostedBackendUrl),
        wsBaseUrl: toWsBaseUrl(hostedBackendUrl),
      };
    }
    const credential = getPairingTokenFromUrl(url) ?? "";
    if (!credential) throw new RemotePairingError("RemotePairingTokenMissingError", { host: url.host });
    return { credential, httpBaseUrl: toHttpBaseUrl(url), wsBaseUrl: toWsBaseUrl(url) };
  }

  const host = input.host?.trim() ?? "";
  const pairingCode = input.pairingCode?.trim() ?? "";
  if (!host) throw new RemotePairingError("RemoteBackendUrlMissingError");
  const normalizedHost = normalizeRemoteBaseUrl(host);
  if (!pairingCode) {
    throw new RemotePairingError("RemotePairingCodeMissingError", { host: normalizedHost.host });
  }
  return {
    credential: pairingCode,
    httpBaseUrl: toHttpBaseUrl(normalizedHost),
    wsBaseUrl: toWsBaseUrl(normalizedHost),
  };
};

/** Canopy's entry point: what someone pastes, an app link unwrapped first.
 *  The Rust side (src-tauri/src/t3_client.rs) parses the same link again
 *  before it contacts anything; this one is for showing the host early. */
export function parseT3PairingLink(pasted: string): ResolvedRemotePairingTarget {
  const trimmed = pasted.trim();
  return resolveRemotePairingTarget({ pairingUrl: readPairingAppLink(trimmed) ?? trimmed });
}

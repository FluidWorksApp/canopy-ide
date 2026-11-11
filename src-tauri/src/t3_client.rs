//! Canopy as a client of T3 Code machines.
//!
//! Someone pastes a T3 pairing link (`https://host/pair#token=CODE`, or
//! `http://` on a LAN or loopback address). Canopy checks the machine's
//! descriptor, redeems the one-time code for a bearer access token, and keeps
//! that token in the OS credential store next to the saved remote workspaces
//! (secure_store.rs, the same helpers client_mode.rs uses). The webview never
//! sees the token, nor the short-lived WebSocket ticket minted from it: the
//! RPC socket is opened and owned in Rust (t3_socket.rs).
//!
//! Ported from T3 Code (MIT, commit d0f1f720):
//! - packages/shared/src/remote.ts: the pairing link parser
//! - packages/client-runtime/src/authorization/remote.ts: token exchange,
//!   session check, WebSocket tickets with the 404 fallback, the /ws URL
//! - packages/client-runtime/src/connection/onboarding.ts: check the
//!   descriptor before spending the code; refuse a different machine
//! - packages/client-runtime/src/connection/compatibility.ts: the
//!   orchestration protocol check and the socket query parameters
//! - packages/shared/src/oauthScope.ts: space-separated scopes

use reqwest::Url;
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::time::Duration;

/// What Canopy asks for (packages/contracts/src/auth.ts scope names). The
/// server grants the overlap with what the pairing link carries
/// (EnvironmentAuth.exchangeBootstrapCredentialForAccessToken) and fails with
/// invalid_scope only when nothing overlaps.
pub const REQUESTED_SCOPES: &[&str] = &[
    "orchestration:read",
    "filesystem:read",
    "filesystem:write",
    "terminal:read",
    "terminal:operate",
    // Thread launch (orchestration.launchThread). Granted only if the pairing
    // link carries it; a machine paired before this lacks it.
    "orchestration:operate",
];
const GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:token-exchange";
const SUBJECT_TOKEN_TYPE: &str = "urn:t3:params:oauth:token-type:environment-bootstrap";
const ACCESS_TOKEN_TYPE: &str = "urn:ietf:params:oauth:token-type:access_token";
/// packages/contracts/src/environment.ts ORCHESTRATION_PROTOCOL_VERSION.
const ORCHESTRATION_PROTOCOL_VERSION: i64 = 2;
const MAX_RESPONSE_BYTES: usize = 1 << 20;

const SAVED_SERVICE: &str = "app.causeconnect.canopy.t3-connections";
const SAVED_ACCOUNT: &str = "saved";
const MAX_SAVED: usize = 64;

/// One saved T3 machine, as it sits in the credential store.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct T3Connection {
    pub environment_id: String,
    pub label: String,
    pub http_base_url: String,
    pub access_token: String,
    pub scope: String,
    /// RFC 3339, from the token's expires_in.
    pub expires_at: String,
}

/// What the webview may see of a saved machine: everything but the token.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct T3ConnectionSummary {
    pub id: String,
    pub environment_id: String,
    pub label: String,
    pub http_base_url: String,
    pub scope: String,
    pub expires_at: String,
}

impl From<&T3Connection> for T3ConnectionSummary {
    fn from(c: &T3Connection) -> Self {
        Self {
            id: c.environment_id.clone(),
            environment_id: c.environment_id.clone(),
            label: c.label.clone(),
            http_base_url: c.http_base_url.clone(),
            scope: c.scope.clone(),
            expires_at: c.expires_at.clone(),
        }
    }
}

/// The parts of ExecutionEnvironmentDescriptor (packages/contracts/src/environment.ts) Canopy reads.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct T3Descriptor {
    pub environment_id: String,
    pub label: String,
    #[serde(default)]
    pub server_version: String,
    #[serde(default)]
    pub orchestration_protocol_version: Option<i64>,
    #[serde(default)]
    pub platform: Option<serde_json::Value>,
}

/// What `t3_describe` shows before anything is redeemed.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct T3Preview {
    pub environment_id: String,
    pub label: String,
    pub http_base_url: String,
    pub server_version: String,
    pub platform: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct T3Ticket {
    pub url: String,
    pub environment_id: String,
    pub label: String,
    pub scope: String,
}

/// resolveRemotePairingTarget's result: the one-time code and the base URL.
#[derive(Clone, Debug, PartialEq)]
pub struct PairingTarget {
    pub credential: String,
    pub http_base_url: String,
}

// ---------------------------------------------------------------------------
// The pairing link (packages/shared/src/remote.ts).
// ---------------------------------------------------------------------------

fn supported_backend_scheme(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "ws" | "wss")
}

/// URLSearchParams over a fragment or query string.
fn form_pairs(raw: &str) -> Vec<(String, String)> {
    let mut parser = Url::parse("http://x/").expect("static URL");
    parser.set_query(Some(raw));
    parser.query_pairs().into_owned().collect()
}

fn param(pairs: &[(String, String)], name: &str) -> Option<String> {
    pairs
        .iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.trim().to_string())
}

/// getPairingTokenFromUrl: the hash token wins over a query token.
fn pairing_token(url: &Url) -> Option<String> {
    let hash = url
        .fragment()
        .map(|fragment| param(&form_pairs(fragment), "token"))
        .unwrap_or_default()
        .unwrap_or_default();
    if !hash.is_empty() {
        return Some(hash);
    }
    let query =
        param(&url.query_pairs().into_owned().collect::<Vec<_>>(), "token").unwrap_or_default();
    (!query.is_empty()).then_some(query)
}

/// toHttpBaseUrl: ws → http, wss → https, path "/", no query or fragment.
fn http_base(url: &Url) -> Result<String, String> {
    let mut next = url.clone();
    let scheme = match url.scheme() {
        "ws" => "http",
        "wss" => "https",
        other => other,
    };
    // All four are special schemes, between which Url allows the change.
    next.set_scheme(scheme)
        .map_err(|_| "Backend URL is invalid.".to_string())?;
    next.set_path("/");
    next.set_query(None);
    next.set_fragment(None);
    Ok(next.to_string())
}

/// normalizeRemoteBaseUrl, for a hosted link's `host` parameter.
fn normalize_remote_base(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Enter a backend URL.".into());
    }
    let without_slashes = trimmed.trim_start_matches('/');
    let has_scheme = without_slashes
        .split_once("://")
        .is_some_and(|(scheme, _)| {
            let mut chars = scheme.chars();
            chars.next().is_some_and(|c| c.is_ascii_alphabetic())
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-')
        });
    let input = if has_scheme {
        without_slashes.to_string()
    } else {
        format!("https://{without_slashes}")
    };
    let url = Url::parse(&input).map_err(|_| "Backend URL is invalid.".to_string())?;
    if !supported_backend_scheme(&url) {
        return Err("Backend URL is invalid.".into());
    }
    Ok(url)
}

/// readPairingAppLink: `t3code://pair?pairingUrl=…` on any channel scheme
/// (`t3code-dev:`, `t3code-nightly:` …).
pub fn read_pairing_app_link(value: &str) -> Option<String> {
    let url = Url::parse(value).ok()?;
    let scheme = url.scheme();
    let channel = scheme.strip_prefix("t3code")?;
    let channel_ok = channel.is_empty()
        || channel
            .strip_prefix('-')
            .is_some_and(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_lowercase()));
    if !channel_ok || url.host_str() != Some("pair") {
        return None;
    }
    if !(url.path().is_empty() || url.path() == "/") {
        return None;
    }
    param(
        &url.query_pairs().into_owned().collect::<Vec<_>>(),
        "pairingUrl",
    )
    .filter(|value| !value.is_empty())
}

/// resolveRemotePairingTarget for a pasted link, an app link unwrapped first.
pub fn parse_pairing_link(pasted: &str) -> Result<PairingTarget, String> {
    let trimmed = pasted.trim();
    let link = read_pairing_app_link(trimmed).unwrap_or_else(|| trimmed.to_string());
    if link.is_empty() {
        return Err("Enter a backend URL.".into());
    }
    let url = Url::parse(&link).map_err(|_| "Pairing URL is invalid.".to_string())?;
    if !supported_backend_scheme(&url) {
        return Err("Pairing URL is invalid.".into());
    }
    let query: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    let hosted_host = param(&query, "host").unwrap_or_default();
    let token = pairing_token(&url);
    if let (false, Some(token)) = (hosted_host.is_empty(), token.clone()) {
        let backend = normalize_remote_base(&hosted_host)?;
        return Ok(PairingTarget {
            credential: token,
            http_base_url: http_base(&backend)?,
        });
    }
    let credential = token.ok_or_else(|| "Pairing URL is missing its token.".to_string())?;
    Ok(PairingTarget {
        credential,
        http_base_url: http_base(&url)?,
    })
}

// ---------------------------------------------------------------------------
// Which base URLs Canopy will talk to.
// ---------------------------------------------------------------------------

fn ipv4_allows_plain_http(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_loopback()            // 127.0.0.0/8
        || a == 10              // RFC 1918
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 169 && b == 254) // link-local
        || (a == 100 && (64..=127).contains(&b)) // 100.64.0.0/10 (CGNAT, Tailscale)
}

fn ipv6_allows_plain_http(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return ipv4_allows_plain_http(v4);
    }
    ip.is_loopback() || (ip.segments()[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
}

/// https anywhere. Plain http only to loopback, RFC 1918, link-local and
/// 100.64.0.0/10 addresses (T3's LAN rule, docs/internals/remote.md), named
/// by IP literal or as `localhost`; anything else is refused. No credentials
/// in the URL either.
pub fn check_base_url(http_base_url: &str) -> Result<Url, String> {
    let url = Url::parse(http_base_url).map_err(|_| "Backend URL is invalid.".to_string())?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("A T3 address must not carry a user name or password.".into());
    }
    match url.scheme() {
        "https" => {}
        "http" => {
            let host = url.host_str().unwrap_or("");
            let literal = host.trim_start_matches('[').trim_end_matches(']');
            let local = match literal.parse::<IpAddr>() {
                Ok(IpAddr::V4(ip)) => ipv4_allows_plain_http(ip),
                Ok(IpAddr::V6(ip)) => ipv6_allows_plain_http(ip),
                Err(_) => host.eq_ignore_ascii_case("localhost"),
            };
            if !local {
                return Err(format!(
                    "{} uses plain http on an address outside your local network. Use an https link for this machine.",
                    if host.is_empty() { "This link" } else { host }
                ));
            }
        }
        _ => return Err("A T3 address must be http or https.".into()),
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err("Backend URL is invalid.".into());
    }
    Ok(url)
}

// ---------------------------------------------------------------------------
// Scopes (packages/shared/src/oauthScope.ts).
// ---------------------------------------------------------------------------

fn scope_token_ok(scope: &str) -> bool {
    !scope.is_empty()
        && scope
            .bytes()
            .all(|b| b == 0x21 || (0x23..=0x5b).contains(&b) || (0x5d..=0x7e).contains(&b))
}

/// encodeOAuthScope: non-empty, each token valid, unique, joined by spaces.
pub fn encode_oauth_scope(scopes: &[&str]) -> Result<String, String> {
    let mut seen = std::collections::HashSet::new();
    if scopes.is_empty() || !scopes.iter().all(|s| scope_token_ok(s) && seen.insert(*s)) {
        return Err("OAuth scopes must be non-empty, syntactically valid, and unique.".into());
    }
    Ok(scopes.join(" "))
}

/// parseOAuthScope: the scopes a token response grants, or None if malformed.
pub fn parse_oauth_scope(value: &str) -> Option<Vec<String>> {
    if value.is_empty() {
        return None;
    }
    let mut out: Vec<String> = Vec::new();
    for scope in value.split(' ') {
        if !scope_token_ok(scope) {
            return None;
        }
        if !out.iter().any(|s| s == scope) {
            out.push(scope.to_string());
        }
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// HTTP.
// ---------------------------------------------------------------------------

pub(crate) fn http_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: std::sync::OnceLock<Result<reqwest::Client, String>> =
        std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(15))
                .build()
                .map_err(|_| "T3 connection unavailable".to_string())
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// environmentEndpointUrl: the base URL with this path, no query or hash.
fn endpoint(base: &Url, path: &str) -> Url {
    let mut url = base.clone();
    url.set_path(path);
    url.set_query(None);
    url.set_fragment(None);
    url
}

struct Answer {
    status: u16,
    body: Vec<u8>,
}

async fn send(request: reqwest::RequestBuilder, host: &str) -> Result<Answer, String> {
    let response = request
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                format!("{host} did not answer in time.")
            } else {
                format!("Cannot reach {host}. Check the address and that T3 Code is running there.")
            }
        })?;
    let status = response.status().as_u16();
    let body = response
        .bytes()
        .await
        .map_err(|_| format!("{host} sent an unreadable response."))?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(format!("{host} sent a response that is too large."));
    }
    Ok(Answer {
        status,
        body: body.to_vec(),
    })
}

/// The server's own error text, when it sent one (EnvironmentRequestInvalidError
/// and friends carry `code` and `reason`). Never echoes a token: only these fields.
fn server_reason(body: &[u8]) -> String {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
        return String::new();
    };
    let field = |name: &str| value.get(name).and_then(|v| v.as_str()).map(str::to_string);
    let parts: Vec<String> = [field("code"), field("reason"), field("message")]
        .into_iter()
        .flatten()
        .filter(|s| s.len() < 200)
        .collect();
    if parts.is_empty() {
        String::new()
    } else {
        format!(" ({})", parts.join(": "))
    }
}

pub async fn fetch_descriptor(
    client: &reqwest::Client,
    base: &Url,
) -> Result<T3Descriptor, String> {
    let host = base.host_str().unwrap_or("The machine").to_string();
    let answer = send(
        client.get(endpoint(base, "/.well-known/t3/environment")),
        &host,
    )
    .await?;
    if answer.status != 200 {
        return Err(format!(
            "{host} did not answer as a T3 Code machine (HTTP {}).",
            answer.status
        ));
    }
    let descriptor: T3Descriptor = serde_json::from_slice(&answer.body)
        .map_err(|_| format!("{host} did not answer as a T3 Code machine."))?;
    if descriptor.environment_id.trim().is_empty() || descriptor.label.trim().is_empty() {
        return Err(format!("{host} sent an incomplete environment descriptor."));
    }
    Ok(descriptor)
}

/// orchestrationProtocolCompatibilityError: an absent version is 1.
pub fn protocol_compatibility(descriptor: &T3Descriptor) -> Result<(), String> {
    let version = descriptor.orchestration_protocol_version.unwrap_or(1);
    match version.cmp(&ORCHESTRATION_PROTOCOL_VERSION) {
        std::cmp::Ordering::Equal => Ok(()),
        std::cmp::Ordering::Greater => Err(format!(
            "{} runs a newer T3 Code than Canopy supports (protocol {version}).",
            descriptor.label
        )),
        std::cmp::Ordering::Less => Err(format!(
            "Update T3 Code on {} to connect (it speaks protocol {version}, Canopy needs {ORCHESTRATION_PROTOCOL_VERSION}).",
            descriptor.label
        )),
    }
}

/// onboarding.ts differentMachineError, and the check T3 makes on every
/// later connect (service.ts verifyDirectEndpoint).
pub fn same_machine(expected_id: &str, descriptor: &T3Descriptor) -> Result<(), String> {
    if descriptor.environment_id == expected_id {
        Ok(())
    } else {
        Err(format!(
            "That address now reaches {}, a different machine (environment {} instead of {expected_id}). Canopy will not send this machine's credential there. Pair the new machine with its own link.",
            descriptor.label, descriptor.environment_id
        ))
    }
}

fn client_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macOS",
        "windows" => "Windows",
        "linux" => "Linux",
        _ => "unknown",
    }
}

#[derive(Deserialize)]
struct AccessTokenResult {
    access_token: String,
    #[serde(default)]
    issued_token_type: String,
    token_type: String,
    expires_in: f64,
    scope: String,
}

fn rfc3339_after(seconds: f64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let at = now.saturating_add(seconds.max(0.0).min(1e10) as i64);
    chrono::DateTime::<chrono::Utc>::from_timestamp(at, 0)
        .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_default()
}

fn expired(expires_at: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(expires_at).is_ok_and(|t| {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;
        t.timestamp() <= now
    })
}

/// bootstrapRemoteBearerSession: POST /oauth/token, form-encoded.
async fn exchange(
    client: &reqwest::Client,
    base: &Url,
    credential: &str,
) -> Result<AccessTokenResult, String> {
    let host = base.host_str().unwrap_or("The machine").to_string();
    let scope = encode_oauth_scope(REQUESTED_SCOPES)?;
    let form = [
        ("grant_type", GRANT_TYPE),
        ("subject_token", credential),
        ("subject_token_type", SUBJECT_TOKEN_TYPE),
        ("requested_token_type", ACCESS_TOKEN_TYPE),
        ("scope", scope.as_str()),
        ("client_label", "Canopy"),
        ("client_device_type", "desktop"),
        ("client_os", client_os()),
    ];
    let answer = send(
        client.post(endpoint(base, "/oauth/token")).form(&form),
        &host,
    )
    .await?;
    match answer.status {
        200 => {}
        400 | 401 | 403 => {
            return Err(format!(
                "{host} refused the pairing code{}. Pairing codes work once and expire after a few minutes; make a new link with `t3 pair`.",
                server_reason(&answer.body)
            ))
        }
        status => {
            return Err(format!(
                "{host} could not redeem the pairing code (HTTP {status}){}.",
                server_reason(&answer.body)
            ))
        }
    }
    let token: AccessTokenResult = serde_json::from_slice(&answer.body)
        .map_err(|_| format!("{host} sent an unreadable token response."))?;
    if token.token_type != "Bearer"
        || (!token.issued_token_type.is_empty() && token.issued_token_type != ACCESS_TOKEN_TYPE)
        || token.access_token.trim().is_empty()
        || token.access_token.len() > 4096
        || parse_oauth_scope(&token.scope).is_none()
    {
        return Err(format!("{host} sent a token Canopy cannot use."));
    }
    Ok(token)
}

/// fetchRemoteSessionState: GET /api/auth/session with the bearer token.
async fn session_authenticated(
    client: &reqwest::Client,
    base: &Url,
    token: &str,
) -> Result<bool, String> {
    let host = base.host_str().unwrap_or("The machine").to_string();
    let answer = send(
        client
            .get(endpoint(base, "/api/auth/session"))
            .bearer_auth(token),
        &host,
    )
    .await?;
    if answer.status != 200 {
        return Ok(false);
    }
    Ok(serde_json::from_slice::<serde_json::Value>(&answer.body)
        .ok()
        .and_then(|v| v.get("authenticated").and_then(|a| a.as_bool()))
        .unwrap_or(false))
}

/// Everything `t3_pair` does short of saving: descriptor first, then the code.
pub async fn redeem(
    client: &reqwest::Client,
    target: &PairingTarget,
    expected_environment_id: Option<&str>,
) -> Result<T3Connection, String> {
    let base = check_base_url(&target.http_base_url)?;
    let descriptor = fetch_descriptor(client, &base).await?;
    // Checked before redeeming the one-time code, so a wrong link is not spent.
    if let Some(expected) = expected_environment_id {
        same_machine(expected, &descriptor)?;
    }
    protocol_compatibility(&descriptor)?;
    let token = exchange(client, &base, &target.credential).await?;
    if !session_authenticated(client, &base, &token.access_token).await? {
        return Err(format!(
            "{} issued a token that its own session check rejects.",
            descriptor.label
        ));
    }
    Ok(T3Connection {
        environment_id: descriptor.environment_id,
        label: descriptor.label,
        http_base_url: base.to_string(),
        access_token: token.access_token,
        scope: token.scope,
        expires_at: rfc3339_after(token.expires_in),
    })
}

/// issueRemoteWebSocketTicket with use "rpc"; the bare path on a 404 from a
/// server older than ticket audiences.
async fn issue_ticket(
    client: &reqwest::Client,
    base: &Url,
    token: &str,
    label: &str,
) -> Result<String, String> {
    let host = base.host_str().unwrap_or("The machine").to_string();
    let mut answer = send(
        client
            .post(endpoint(base, "/api/auth/websocket-ticket/rpc"))
            .bearer_auth(token),
        &host,
    )
    .await?;
    if answer.status == 404 {
        answer = send(
            client
                .post(endpoint(base, "/api/auth/websocket-ticket"))
                .bearer_auth(token),
            &host,
        )
        .await?;
    }
    match answer.status {
        200 => {}
        401 | 403 => {
            return Err(format!(
                "{label} no longer accepts Canopy's access{}. It was revoked or expired; pair again with a new link.",
                server_reason(&answer.body)
            ))
        }
        status => {
            return Err(format!(
                "{label} could not issue a connection ticket (HTTP {status}){}.",
                server_reason(&answer.body)
            ))
        }
    }
    let value: serde_json::Value = serde_json::from_slice(&answer.body)
        .map_err(|_| format!("{label} sent an unreadable ticket."))?;
    value
        .get("ticket")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty() && t.len() <= 4096)
        .map(str::to_string)
        .ok_or_else(|| format!("{label} sent an unreadable ticket."))
}

/// resolveRemoteWebSocketConnectionUrl (rpcSocketUrl, wsTicket, the client
/// parameters), appendOrchestrationProtocol, and the frameParts opt-in from
/// rpc/session.ts.
pub fn socket_url(base: &Url, ticket: &str) -> Result<String, String> {
    let mut url = base.clone();
    let scheme = if base.scheme() == "https" {
        "wss"
    } else {
        "ws"
    };
    url.set_scheme(scheme)
        .map_err(|_| "Backend URL is invalid.".to_string())?;
    url.set_path("/ws");
    url.set_query(None);
    url.set_fragment(None);
    url.query_pairs_mut()
        .append_pair("wsTicket", ticket)
        .append_pair("clientDeviceType", "desktop")
        .append_pair("clientOs", client_os())
        .append_pair("connectionMethod", "direct")
        .append_pair(
            "orchestrationProtocol",
            &ORCHESTRATION_PROTOCOL_VERSION.to_string(),
        )
        .append_pair("clientCapabilities", "settingsSecretReferences")
        .append_pair("frameParts", "1");
    Ok(url.to_string())
}

/// What `t3_socket_open` (t3_socket.rs) does after loading the saved
/// connection, before it dials the URL.
pub async fn mint_socket_url(
    client: &reqwest::Client,
    saved: &T3Connection,
) -> Result<T3Ticket, String> {
    let base = check_base_url(&saved.http_base_url)?;
    if expired(&saved.expires_at) {
        return Err(format!(
            "Canopy's access to {} expired. Pair again with a new link.",
            saved.label
        ));
    }
    let descriptor = fetch_descriptor(client, &base).await?;
    same_machine(&saved.environment_id, &descriptor)?;
    protocol_compatibility(&descriptor)?;
    let ticket = issue_ticket(client, &base, &saved.access_token, &saved.label).await?;
    Ok(T3Ticket {
        url: socket_url(&base, &ticket)?,
        environment_id: saved.environment_id.clone(),
        label: descriptor.label,
        scope: saved.scope.clone(),
    })
}

// ---------------------------------------------------------------------------
// Saved connections, in the OS credential store.
// ---------------------------------------------------------------------------

fn saved_connections() -> Result<Vec<T3Connection>, String> {
    match crate::secure_store::get(SAVED_SERVICE, SAVED_ACCOUNT) {
        Ok(Some(bytes)) => serde_json::from_slice(&bytes)
            .map_err(|_| "Saved T3 credentials are invalid".to_string()),
        Ok(None) => Ok(vec![]),
        Err(_) => Err(format!(
            "Cannot read T3 credentials from {}",
            crate::secure_store::store_name()
        )),
    }
}

fn save_connections(all: &[T3Connection]) -> Result<(), String> {
    let bytes = serde_json::to_vec(all).map_err(|_| "Cannot encode T3 credentials")?;
    crate::secure_store::set(SAVED_SERVICE, SAVED_ACCOUNT, &bytes).map_err(|_| {
        format!(
            "Cannot save T3 credentials to {}",
            crate::secure_store::store_name()
        )
    })
}

/// A new pairing replaces any saved entry for the same machine or address.
fn upsert(all: &mut Vec<T3Connection>, connection: T3Connection) -> Result<(), String> {
    all.retain(|c| {
        c.environment_id != connection.environment_id && c.http_base_url != connection.http_base_url
    });
    if all.len() >= MAX_SAVED {
        return Err("Saved T3 machine limit reached".into());
    }
    all.push(connection);
    Ok(())
}

pub(crate) fn find(id: &str) -> Result<T3Connection, String> {
    saved_connections()?
        .into_iter()
        .find(|c| c.environment_id == id)
        .ok_or_else(|| "That T3 machine is not saved on this computer.".to_string())
}

// ---------------------------------------------------------------------------
// Commands. All async: the credential store can wait on a keyring prompt.
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn t3_list() -> Result<Vec<T3ConnectionSummary>, String> {
    crate::client_mode::blocking_store(|| {
        Ok(saved_connections()?
            .iter()
            .map(T3ConnectionSummary::from)
            .collect())
    })
    .await
}

/// Reads the descriptor a link points at, without spending its code.
#[tauri::command]
pub async fn t3_describe(link: String) -> Result<T3Preview, String> {
    let target = parse_pairing_link(&link)?;
    let base = check_base_url(&target.http_base_url)?;
    let descriptor = fetch_descriptor(http_client()?, &base).await?;
    protocol_compatibility(&descriptor)?;
    Ok(T3Preview {
        environment_id: descriptor.environment_id,
        label: descriptor.label,
        http_base_url: base.to_string(),
        server_version: descriptor.server_version,
        platform: descriptor.platform,
    })
}

/// Redeems the link and saves the machine. `expected_environment_id` is the
/// one `t3_describe` showed; a different machine at that URL is refused
/// before the code is spent.
#[tauri::command]
pub async fn t3_pair(
    link: String,
    expected_environment_id: Option<String>,
) -> Result<T3ConnectionSummary, String> {
    let target = parse_pairing_link(&link)?;
    let connection = redeem(http_client()?, &target, expected_environment_id.as_deref()).await?;
    let summary = T3ConnectionSummary::from(&connection);
    crate::client_mode::blocking_store(move || {
        let mut all = saved_connections()?;
        upsert(&mut all, connection)?;
        save_connections(&all)
    })
    .await?;
    Ok(summary)
}

#[tauri::command]
pub async fn t3_remove(id: String) -> Result<(), String> {
    crate::client_mode::blocking_store(move || {
        let mut all = saved_connections()?;
        all.retain(|c| c.environment_id != id);
        save_connections(&all)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(link: &str) -> PairingTarget {
        parse_pairing_link(link).unwrap()
    }

    // Ported from T3 Code packages/shared/src/remote.test.ts.
    #[test]
    fn t3_client_link_derives_base_and_token_from_a_pairing_url() {
        assert_eq!(
            target("https://remote.example.com/pair#token=pairing-token"),
            PairingTarget {
                credential: "pairing-token".into(),
                http_base_url: "https://remote.example.com/".into()
            }
        );
    }

    #[test]
    fn t3_client_link_accepts_a_query_token() {
        assert_eq!(
            target("https://remote.example.com/pair?token=pairing-token").credential,
            "pairing-token"
        );
    }

    #[test]
    fn t3_client_link_reads_hosted_app_links() {
        assert_eq!(
            target("https://app.t3.codes/pair?host=https%3A%2F%2Fdesktop.tailnet.ts.net%3A44342%2F#token=pairing-token"),
            PairingTarget {
                credential: "pairing-token".into(),
                http_base_url: "https://desktop.tailnet.ts.net:44342/".into()
            }
        );
    }

    #[test]
    fn t3_client_link_maps_ws_schemes_to_http() {
        assert_eq!(
            target("wss://h.example.com:9/pair#token=a").http_base_url,
            "https://h.example.com:9/"
        );
        assert_eq!(
            target("ws://127.0.0.1:3773/pair#token=a").http_base_url,
            "http://127.0.0.1:3773/"
        );
    }

    #[test]
    fn t3_client_link_rejects_bad_protocols_and_missing_tokens() {
        assert!(parse_pairing_link("ftp://remote.example.com/pair#token=x").is_err());
        assert_eq!(
            parse_pairing_link("https://remote.example.com/pair").unwrap_err(),
            "Pairing URL is missing its token."
        );
        assert!(parse_pairing_link("").is_err());
        assert!(parse_pairing_link("not a url").is_err());
    }

    #[test]
    fn t3_client_link_unwraps_app_links_on_every_channel() {
        let pairing = "https://vps.example.com/pair#token=ABC123";
        let mut app = Url::parse("t3code://pair").unwrap();
        app.query_pairs_mut().append_pair("pairingUrl", pairing);
        let app = app.to_string();
        assert_eq!(read_pairing_app_link(&app).as_deref(), Some(pairing));
        assert_eq!(
            read_pairing_app_link(&app.replace("t3code:", "t3code-dev:")).as_deref(),
            Some(pairing)
        );
        assert_eq!(read_pairing_app_link("t3code://pair"), None);
        assert_eq!(
            read_pairing_app_link(&app.replace("//pair?", "//pair/other?")),
            None
        );
        assert_eq!(
            read_pairing_app_link(&format!("t3code://threads?pairingUrl={pairing}")),
            None
        );
        assert_eq!(
            read_pairing_app_link(&format!("https://pair?pairingUrl={pairing}")),
            None
        );
        assert_eq!(target(&app).credential, "ABC123");
    }

    #[test]
    fn t3_client_lan_rule_allows_https_anywhere_and_http_only_locally() {
        for ok in [
            "https://t3.example.com/",
            "https://203.0.113.9:8443/",
            "http://127.0.0.1:3773/",
            "http://localhost:3773/",
            "http://[::1]:3773/",
            "http://10.1.2.3/",
            "http://172.16.0.1/",
            "http://172.31.255.255/",
            "http://192.168.1.20:3773/",
            "http://169.254.10.10/",
            "http://100.64.0.1/",
            "http://100.127.255.254/",
            "http://[fe80::1]/",
            "http://[::ffff:192.168.1.2]/",
        ] {
            assert!(check_base_url(ok).is_ok(), "{ok} should be allowed");
        }
        for bad in [
            "http://t3.example.com/",
            "http://203.0.113.9/",
            "http://172.32.0.1/",
            "http://100.128.0.1/",
            "http://100.63.255.255/",
            "http://8.8.8.8/",
            "http://[2001:db8::1]/",
            "http://my-box.local/",
            "http://desktop.tailnet.ts.net/",
            "ftp://10.0.0.1/",
            "https://user:pw@t3.example.com/",
        ] {
            assert!(check_base_url(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn t3_client_scope_is_space_separated_and_validated() {
        assert_eq!(
            encode_oauth_scope(REQUESTED_SCOPES).unwrap(),
            "orchestration:read filesystem:read filesystem:write terminal:read terminal:operate orchestration:operate"
        );
        assert!(encode_oauth_scope(&[]).is_err());
        assert!(encode_oauth_scope(&["a", "a"]).is_err());
        assert!(encode_oauth_scope(&["has space"]).is_err());
        assert!(encode_oauth_scope(&["quote\"d"]).is_err());
        assert_eq!(
            parse_oauth_scope("terminal:read filesystem:read terminal:read"),
            Some(vec!["terminal:read".into(), "filesystem:read".into()])
        );
        assert_eq!(parse_oauth_scope(""), None);
        assert_eq!(parse_oauth_scope("a  b"), None);
    }

    #[test]
    fn t3_client_socket_url_carries_ticket_and_protocol() {
        let url = socket_url(&Url::parse("https://h.example.com:8443/").unwrap(), "tk+1").unwrap();
        assert!(url.starts_with("wss://h.example.com:8443/ws?wsTicket=tk%2B1&"));
        assert!(url.contains("orchestrationProtocol=2"));
        assert!(url.contains("clientCapabilities=settingsSecretReferences"));
        assert!(url.contains("frameParts=1"));
        assert!(url.contains("connectionMethod=direct"));
        let plain = socket_url(&Url::parse("http://127.0.0.1:3773/").unwrap(), "t").unwrap();
        assert!(plain.starts_with("ws://127.0.0.1:3773/ws?"));
    }

    #[test]
    fn t3_client_refuses_a_different_machine_and_old_protocols() {
        let descriptor = |id: &str, version: Option<i64>| T3Descriptor {
            environment_id: id.into(),
            label: "Studio".into(),
            server_version: "0.1.7".into(),
            orchestration_protocol_version: version,
            platform: None,
        };
        assert!(same_machine("env-a", &descriptor("env-a", Some(2))).is_ok());
        let refused = same_machine("env-a", &descriptor("env-b", Some(2))).unwrap_err();
        assert!(refused.contains("different machine"), "{refused}");
        assert!(protocol_compatibility(&descriptor("e", Some(2))).is_ok());
        assert!(protocol_compatibility(&descriptor("e", None)).is_err());
        assert!(protocol_compatibility(&descriptor("e", Some(3))).is_err());
    }

    #[test]
    fn t3_client_summaries_never_carry_the_token() {
        let connection = T3Connection {
            environment_id: "env".into(),
            label: "Studio".into(),
            http_base_url: "https://h.example.com/".into(),
            access_token: "secret-token-value".into(),
            scope: "filesystem:read".into(),
            expires_at: rfc3339_after(60.0),
        };
        let json = serde_json::to_string(&T3ConnectionSummary::from(&connection)).unwrap();
        assert!(!json.contains("secret-token-value"));
        assert!(!expired(&connection.expires_at));
        assert!(expired("2000-01-01T00:00:00Z"));
        let mut all = vec![connection.clone()];
        let mut moved = connection.clone();
        moved.http_base_url = "https://other.example.com/".into();
        upsert(&mut all, moved).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].http_base_url, "https://other.example.com/");
    }

    // A loopback HTTP server with canned answers, to run redeem and the
    // ticket path end to end without a T3 server.
    async fn mock(
        routes: Vec<(&'static str, u16, String)>,
    ) -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut buffer = vec![0u8; 16384];
                let mut read = 0;
                loop {
                    let n = stream.read(&mut buffer[read..]).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    read += n;
                    let text = String::from_utf8_lossy(&buffer[..read]).to_string();
                    if let Some(head_end) = text.find("\r\n\r\n") {
                        let length = text[..head_end]
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if read >= head_end + 4 + length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8_lossy(&buffer[..read]).to_string();
                let line = request.lines().next().unwrap_or("").to_string();
                log.lock().unwrap().push(request.clone());
                let (status, body) = routes
                    .iter()
                    .find(|(prefix, _, _)| line.starts_with(prefix))
                    .map(|(_, s, b)| (*s, b.clone()))
                    .unwrap_or((404, "{}".into()));
                let response = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (base, seen)
    }

    fn descriptor_json(id: &str) -> String {
        format!(
            r#"{{"environmentId":"{id}","label":"Studio","platform":{{"os":"linux","arch":"x64"}},"serverVersion":"0.1.7","orchestrationProtocolVersion":2,"capabilities":{{}}}}"#
        )
    }

    #[tokio::test]
    async fn t3_client_redeems_after_the_descriptor_and_requests_canopy_scopes() {
        let (base, seen) = mock(vec![
            ("GET /.well-known/t3/environment", 200, descriptor_json("env-1")),
            ("POST /oauth/token", 200, r#"{"access_token":"tok-abc","issued_token_type":"urn:ietf:params:oauth:token-type:access_token","token_type":"Bearer","expires_in":3600,"scope":"orchestration:read filesystem:read"}"#.into()),
            ("GET /api/auth/session", 200, r#"{"authenticated":true}"#.into()),
        ])
        .await;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let target = parse_pairing_link(&format!("{base}pair#token=CODE1")).unwrap();
        let saved = redeem(&client, &target, Some("env-1")).await.unwrap();
        assert_eq!(saved.environment_id, "env-1");
        assert_eq!(saved.access_token, "tok-abc");
        assert_eq!(saved.scope, "orchestration:read filesystem:read");
        let requests = seen.lock().unwrap().clone();
        assert!(requests[0].starts_with("GET /.well-known/t3/environment"));
        let token = &requests[1];
        assert!(token.starts_with("POST /oauth/token"));
        assert!(token.contains("application/x-www-form-urlencoded"));
        assert!(
            token.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange")
        );
        assert!(token.contains("subject_token=CODE1"));
        assert!(token.contains(
            "subject_token_type=urn%3At3%3Aparams%3Aoauth%3Atoken-type%3Aenvironment-bootstrap"
        ));
        assert!(token.contains(
            "requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aaccess_token"
        ));
        assert!(token.contains("scope=orchestration%3Aread+filesystem%3Aread+filesystem%3Awrite+terminal%3Aread+terminal%3Aoperate"));
        assert!(token.contains("client_label=Canopy"));
        assert!(requests[2]
            .to_ascii_lowercase()
            .contains("authorization: bearer tok-abc"));
    }

    #[tokio::test]
    async fn t3_client_does_not_spend_the_code_on_a_different_machine() {
        let (base, seen) = mock(vec![(
            "GET /.well-known/t3/environment",
            200,
            descriptor_json("env-other"),
        )])
        .await;
        let client = reqwest::Client::new();
        let target = parse_pairing_link(&format!("{base}pair#token=CODE1")).unwrap();
        let error = redeem(&client, &target, Some("env-1")).await.unwrap_err();
        assert!(error.contains("different machine"), "{error}");
        assert_eq!(
            seen.lock().unwrap().len(),
            1,
            "only the descriptor was read"
        );
    }

    #[tokio::test]
    async fn t3_client_ticket_checks_the_machine_and_falls_back_on_404() {
        let (base, seen) = mock(vec![
            (
                "GET /.well-known/t3/environment",
                200,
                descriptor_json("env-1"),
            ),
            ("POST /api/auth/websocket-ticket/rpc", 404, "{}".into()),
            (
                "POST /api/auth/websocket-ticket",
                200,
                r#"{"ticket":"tick-1","expiresAt":"2030-01-01T00:00:00.000Z"}"#.into(),
            ),
        ])
        .await;
        let client = reqwest::Client::new();
        let saved = T3Connection {
            environment_id: "env-1".into(),
            label: "Studio".into(),
            http_base_url: base.clone(),
            access_token: "tok-abc".into(),
            scope: "filesystem:read".into(),
            expires_at: rfc3339_after(600.0),
        };
        let ticket = mint_socket_url(&client, &saved).await.unwrap();
        assert!(
            ticket.url.contains("/ws?wsTicket=tick-1&"),
            "{}",
            ticket.url
        );
        assert!(!ticket.url.contains("tok-abc"));
        let requests = seen.lock().unwrap().clone();
        assert_eq!(requests.len(), 3);
        assert!(requests[2].starts_with("POST /api/auth/websocket-ticket HTTP"));

        let mut moved = saved.clone();
        moved.environment_id = "env-2".into();
        let refused = mint_socket_url(&client, &moved).await.unwrap_err();
        assert!(refused.contains("different machine"), "{refused}");
        assert_eq!(
            seen.lock().unwrap().len(),
            4,
            "no ticket asked of the wrong machine"
        );
    }
}

//! The only way into the device hub: an allowlisting, ticket-checking proxy.
//!
//! Ported from T3 Code `apps/server/src/device/DeviceHubProxy.ts`
//! (https://github.com/pingdotgg/t3code, commit d5290e9, MIT License,
//! Copyright (c) 2026 T3 Tools Inc.). The route allowlist, method rules, dropped
//! headers, `Cache-Control: no-transform`, ticket stripping and MJPEG still
//! re-send are T3's. Differences Canopy forces are commented in place:
//!
//! * T3 mounts the proxy on its environment server and authenticates an
//!   environment session (cookie, or a short-lived `wsTicket` minted over
//!   authenticated HTTP). Canopy has no environment server, so the proxy has
//!   its own loopback listener and only the `wsTicket` path exists; tickets are
//!   minted by a Tauri command, which only the app's own webview can call.
//! * T3 grants read or operate scope per session. A desktop app has one user,
//!   so every ticket may operate; there is no 403 path.
//! * The EAS/Simlock `upstream` routing (several hubs, server-side session
//!   tokens, `hostId`) is removed. `hostId` is still stripped from the query so
//!   a T3-shaped client cannot reach the hub with it.
//! * The webview's origin (`tauri://localhost`, `http://tauri.localhost`, or the
//!   dev server) differs from the proxy's, so responses carry
//!   `Access-Control-Allow-Origin: *` and CORS preflights are answered here.
//!   That is safe because no response is readable without a ticket and the
//!   ticket is never a cookie.
//!
//! serve-sim has a shell-exec route whose token is readable from its own
//! unauthenticated `/api`, and serve-emu's action routes have no auth at all.
//! The hub binds loopback and is never exposed; nothing outside the allowlist
//! below reaches it.

use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Router;
use regex::Regex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::devicehub_mjpeg::repeat_still_frame;

/// Kept from T3 so stream URLs have the same shape (`<base>/vendor/...`).
pub const DEVICE_HUB_ROUTE_PREFIX: &str = "/api/device-hub";

/// T3's `DEFAULT_WEBSOCKET_TOKEN_TTL` (SessionStore.ts). Media tickets there are
/// reused across `<img>`, fetch and several sockets until they expire, so these
/// are too; a viewer whose ticket expired gets a 401 (HTTP) or a 1006 close
/// (upgrade), and the stream client asks for a new one.
pub const TICKET_TTL: Duration = Duration::from_secs(5 * 60);
/// Bounds memory if something mints in a loop; the oldest ticket goes first.
const MAX_LIVE_TICKETS: usize = 256;
/// T3: `openTimeout: "10 seconds"` on the upstream socket.
const UPSTREAM_WS_OPEN_TIMEOUT: Duration = Duration::from_secs(10);

const ALLOWED_PATHS: &[&str] = &[
    r"^/api/devices$",
    r"^/vendor/serve-sim/api$",
    r"^/vendor/serve-sim/api/screenshot$",
    r"^/vendor/serve-sim/api/event-log(/events)?$",
    r"^/vendor/serve-sim/helper/[^/]+/(stream\.mjpeg|stream\.avcc|config|health|ax|foreground)$",
    r"^/vendor/serve-sim/helper/[^/]+/panel/(1|3)/stream\.avcc$",
    r"^/vendor/serve-sim/helper/[^/]+/webrtc/(offer|close)$",
    r"^/vendor/serve-sim/appstate$",
    r"^/vendor/serve-emu/api$",
    r"^/vendor/serve-emu/api/(devices|screenshot|stream-mode|stream-settings|accessibility|fold)$",
    r"^/vendor/serve-emu/health$",
];

// Paths that take methods besides GET; one missing from ALLOWED_PATHS takes no GET.
const MUTABLE_PATHS: &[&str] = &[
    r"^/vendor/serve-sim/api/screenshot$",
    // WebRTC signalling: opening and closing a view of the stream.
    r"^/vendor/serve-sim/helper/[^/]+/webrtc/(offer|close)$",
    r"^/vendor/serve-emu/webrtc/(offer|close)$",
    r"^/vendor/serve-emu/api/(screenshot|stream-mode|stream-settings)$",
    r"^/vendor/serve-emu/api/fold$",
];

const ALLOWED_WS_PATHS: &[&str] = &[
    r"^/api/devices/ws$",
    r"^/vendor/serve-sim/helper/ws$",
    r"^/vendor/serve-emu/ws$",
];

const DROPPED_REQUEST_HEADERS: &[&str] = &[
    "host",
    "connection",
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-extensions",
    "sec-websocket-protocol",
    "cookie",
    "authorization",
    "dpop",
    "content-length",
    "accept-encoding",
    // The client's HTTPS hop makes the hub reject a loopback Origin.
    "x-forwarded-proto",
];

struct Patterns {
    allowed: Vec<Regex>,
    mutable: Vec<Regex>,
    ws: Vec<Regex>,
}

fn patterns() -> &'static Patterns {
    static P: OnceLock<Patterns> = OnceLock::new();
    P.get_or_init(|| {
        let compile = |list: &[&str]| {
            list.iter()
                .map(|p| Regex::new(p).expect("static device hub route"))
                .collect::<Vec<_>>()
        };
        Patterns {
            allowed: compile(ALLOWED_PATHS),
            mutable: compile(MUTABLE_PATHS),
            ws: compile(ALLOWED_WS_PATHS),
        }
    })
}

fn matches(list: &[Regex], path: &str) -> bool {
    list.iter().any(|re| re.is_match(path))
}

/// T3's allowlist and method rules: 404 for any route outside the allowlist,
/// 405 for a method the route does not take. Checked before authentication,
/// as in T3, so an unknown route never reveals whether a ticket was valid.
pub(crate) fn route_decision(
    hub_path: &str,
    method: &Method,
    upgrade: bool,
) -> Result<(), StatusCode> {
    let p = patterns();
    let allowed = if upgrade {
        matches(&p.ws, hub_path)
    } else {
        matches(&p.allowed, hub_path) || matches(&p.mutable, hub_path)
    };
    if !allowed {
        return Err(StatusCode::NOT_FOUND);
    }
    let read_only = method == Method::GET || method == Method::HEAD;
    if !upgrade && !matches(if read_only { &p.allowed } else { &p.mutable }, hub_path) {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    Ok(())
}

/// The query the hub sees: the ticket (and T3's `hostId`) consumed here.
pub(crate) fn upstream_search(query: Option<&str>) -> String {
    let Some(query) = query.filter(|q| !q.is_empty()) else {
        return String::new();
    };
    // Pairs are kept as raw text rather than decoded and re-encoded, so the
    // hub receives every other parameter byte-for-byte as the client sent it.
    let kept: Vec<&str> = query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .filter(|pair| {
            let key = pair.split('=').next().unwrap_or("");
            let key = percent_decode(key);
            key != "wsTicket" && key != "hostId"
        })
        .collect();
    if kept.is_empty() {
        String::new()
    } else {
        format!("?{}", kept.join("&"))
    }
}

/// The `wsTicket` value from a query string, decoded.
pub(crate) fn ticket_from_query(query: Option<&str>) -> Option<String> {
    query?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        (percent_decode(key) == "wsTicket").then(|| percent_decode(value))
    })
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let decoded = (bytes[i] == b'%' && i + 2 < bytes.len())
            .then(|| std::str::from_utf8(&bytes[i + 1..i + 3]).ok())
            .flatten()
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match (bytes[i], decoded) {
            (_, Some(b)) => {
                out.push(b);
                i += 3;
            }
            (b'+', None) => {
                out.push(b' ');
                i += 1;
            }
            (b, None) => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Request headers to send upstream: T3's `forwardHeaders`.
pub(crate) fn forward_headers(
    headers: &HeaderMap,
    hub_origin: &str,
) -> Vec<(HeaderName, HeaderValue)> {
    let mut out = Vec::new();
    for (name, value) in headers {
        let lower = name.as_str();
        // `transfer-encoding` is dropped too: reqwest frames the forwarded body
        // itself, and a copied header would describe it twice. (Node's client,
        // which T3 forwards through, rewrites it on its own.)
        if DROPPED_REQUEST_HEADERS.contains(&lower) || lower == "transfer-encoding" {
            continue;
        }
        if lower == "origin" {
            // serve-emu refuses mutations whose Origin differs from the request origin.
            if let Ok(v) = HeaderValue::from_str(hub_origin) {
                out.push((name.clone(), v));
            }
            continue;
        }
        out.push((name.clone(), value.clone()));
    }
    out
}

// ---------- tickets ----------

/// Short-lived stream tickets. `<img>` and `WebSocket` cannot carry headers,
/// so a ticket rides in the `wsTicket` query parameter, as in T3.
#[derive(Default)]
pub struct Tickets {
    live: Mutex<Vec<(String, Instant)>>,
}

impl Tickets {
    pub fn mint(&self) -> String {
        self.mint_at(Instant::now())
    }

    fn mint_at(&self, now: Instant) -> String {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes).expect("the OS random source is unavailable");
        let ticket = hex::encode(bytes);
        let mut live = self.live.lock().unwrap();
        live.retain(|(_, expires)| *expires > now);
        if live.len() >= MAX_LIVE_TICKETS {
            live.remove(0);
        }
        live.push((ticket.clone(), now + TICKET_TTL));
        ticket
    }

    pub fn verify(&self, presented: &str) -> bool {
        self.verify_at(presented, Instant::now())
    }

    fn verify_at(&self, presented: &str, now: Instant) -> bool {
        if presented.trim().is_empty() {
            return false;
        }
        let mut live = self.live.lock().unwrap();
        live.retain(|(_, expires)| *expires > now);
        // Every live ticket is compared, in constant time each, so neither the
        // match position nor a near miss shows in the timing.
        live.iter().fold(false, |hit, (t, _)| {
            crate::context::constant_time_eq(presented, t) | hit
        })
    }
}

// ---------- the proxy ----------

/// Shared with the hub host: where the hub is, while it runs.
#[derive(Default)]
pub struct ProxyState {
    pub tickets: Tickets,
    /// `http://127.0.0.1:<port>` of the running hub; `None` while stopped.
    pub hub_origin: RwLock<Option<String>>,
    client: OnceLock<reqwest::Client>,
}

impl ProxyState {
    fn client(&self) -> &reqwest::Client {
        self.client.get_or_init(|| {
            reqwest::Client::builder()
                // Loopback only: an HTTP(S)_PROXY in the user's environment
                // must not see (or swallow) hub traffic.
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .expect("reqwest client")
        })
    }
}

pub fn router(state: Arc<ProxyState>) -> Router {
    Router::new().fallback(handler).with_state(state)
}

fn text(status: StatusCode, body: &'static str) -> Response {
    let mut response = (status, body).into_response();
    cors(response.headers_mut());
    response
}

fn cors(headers: &mut HeaderMap) {
    headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
}

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

async fn handler(State(state): State<Arc<ProxyState>>, req: Request) -> Response {
    let Some(hub_path) = req.uri().path().strip_prefix(DEVICE_HUB_ROUTE_PREFIX) else {
        return text(StatusCode::NOT_FOUND, "Not Found");
    };
    let hub_path = if hub_path.is_empty() { "/" } else { hub_path }.to_string();
    let upgrade = is_websocket_upgrade(req.headers());

    // Canopy-only: answer CORS preflights for allowlisted routes. A preflight
    // carries no credentials and reaches nothing; the request that follows is
    // checked like any other.
    if req.method() == Method::OPTIONS && !upgrade {
        let p = patterns();
        if !(matches(&p.allowed, &hub_path) || matches(&p.mutable, &hub_path)) {
            return text(StatusCode::NOT_FOUND, "Not Found");
        }
        let mut response = StatusCode::NO_CONTENT.into_response();
        let h = response.headers_mut();
        cors(h);
        h.insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET, HEAD, POST"),
        );
        h.insert(
            "access-control-allow-headers",
            HeaderValue::from_static("content-type"),
        );
        h.insert("access-control-max-age", HeaderValue::from_static("600"));
        return response;
    }

    if let Err(status) = route_decision(&hub_path, req.method(), upgrade) {
        return text(
            status,
            if status == StatusCode::NOT_FOUND {
                "Not Found"
            } else {
                "Method Not Allowed"
            },
        );
    }

    // T3's `authenticateMediaRequest`: a missing or bad credential is 401.
    let query = req.uri().query().map(str::to_string);
    let authorized = ticket_from_query(query.as_deref()).is_some_and(|t| state.tickets.verify(&t));
    if !authorized {
        return text(StatusCode::UNAUTHORIZED, "Unauthorized");
    }

    let Some(origin) = state.hub_origin.read().unwrap().clone() else {
        return text(StatusCode::SERVICE_UNAVAILABLE, "Device hub is not running");
    };
    // Consume the auth ticket here; never forward it to the hub.
    let search = upstream_search(query.as_deref());
    let upstream_url = format!("{origin}{hub_path}{search}");

    let result = if upgrade {
        proxy_websocket(req, &origin, &format!("{hub_path}{search}")).await
    } else {
        proxy_http(&state, req, &origin, &upstream_url).await
    };
    match result {
        Ok(response) => response,
        Err(e) => {
            // T3 surfaces an upstream failure as the server's generic error;
            // a gateway status says the same thing more precisely.
            log::debug!("device hub proxy: {hub_path}: {e}");
            text(StatusCode::BAD_GATEWAY, "Device hub request failed")
        }
    }
}

async fn proxy_http(
    state: &ProxyState,
    req: Request,
    origin: &str,
    upstream_url: &str,
) -> Result<Response, String> {
    let (parts, body) = req.into_parts();
    let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes())
        .map_err(|_| "Method Not Allowed".to_string())?;
    let mut request = state.client().request(method.clone(), upstream_url);
    for (name, value) in forward_headers(&parts.headers, origin) {
        request = request.header(name.as_str(), value.as_bytes());
    }
    if method != reqwest::Method::GET && method != reqwest::Method::HEAD {
        // Streamed through, with the client's content type (copied above):
        // serve-sim refuses WebRTC offers that are not application/json.
        request = request.body(reqwest::Body::wrap_stream(body.into_data_stream()));
    }
    let upstream = request.send().await.map_err(|e| e.to_string())?;

    let status =
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut builder = Response::builder().status(status);
    let mut content_type: Option<String> = None;
    for (name, value) in upstream.headers() {
        let n = name.as_str();
        // A cookie from an upstream would land on the proxy's origin.
        if matches!(
            n,
            "content-encoding" | "transfer-encoding" | "connection" | "set-cookie"
        ) {
            continue;
        }
        // Replaced below.
        if n == "cache-control" || n == "access-control-allow-origin" {
            continue;
        }
        if n == "content-type" {
            content_type = value.to_str().ok().map(str::to_string);
        }
        builder = builder.header(n, value.as_bytes());
    }
    // Long-lived MJPEG and AVCC responses must not be buffered by compression.
    builder = builder
        .header("cache-control", "no-store, no-transform")
        .header("access-control-allow-origin", "*");
    let stream = upstream.bytes_stream();
    let body = if content_type
        .as_deref()
        .is_some_and(|t| t.starts_with("multipart/x-mixed-replace"))
    {
        Body::from_stream(repeat_still_frame(stream))
    } else {
        Body::from_stream(stream)
    };
    builder.body(body).map_err(|e| e.to_string())
}

/// WebSocket upgrades. T3 accepts the client socket and opens a second socket
/// to the hub, pumping whole frames both ways. Here the upgrade request is
/// replayed to the hub (T3's dropped headers removed, Origin rewritten) and,
/// once the hub answers 101, the two TCP streams are spliced as `preview.rs`
/// does. Every frame reaches the other side unchanged either way; extensions
/// and subprotocols are not offered upstream, as in T3, so neither leg
/// negotiates compression.
async fn proxy_websocket(
    mut req: Request,
    origin: &str,
    path_and_query: &str,
) -> Result<Response, String> {
    let on_upgrade = req
        .extensions_mut()
        .remove::<hyper::upgrade::OnUpgrade>()
        .ok_or("no upgrade extension")?;
    let authority = origin
        .strip_prefix("http://")
        .ok_or("the hub origin is not http")?
        .to_string();

    let mut head = format!(
        "GET {path_and_query} HTTP/1.1\r\nHost: {authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n"
    );
    for key in ["sec-websocket-key", "sec-websocket-version"] {
        let value = req
            .headers()
            .get(key)
            .and_then(|v| v.to_str().ok())
            .ok_or_else(|| format!("missing {key}"))?;
        head.push_str(&format!("{key}: {value}\r\n"));
    }
    for (name, value) in forward_headers(req.headers(), origin) {
        if let Ok(v) = value.to_str() {
            head.push_str(&format!("{}: {v}\r\n", name.as_str()));
        }
    }
    head.push_str("\r\n");

    let handshake = async {
        let mut upstream = tokio::net::TcpStream::connect(&authority)
            .await
            .map_err(|e| e.to_string())?;
        upstream
            .write_all(head.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        // Read the response head through the blank line; anything past it is
        // already WebSocket payload and must reach the client first, so read a
        // byte at a time.
        let mut buf: Vec<u8> = Vec::with_capacity(512);
        let mut byte = [0u8; 1];
        while !buf.ends_with(b"\r\n\r\n") {
            let n = upstream.read(&mut byte).await.map_err(|e| e.to_string())?;
            if n == 0 {
                return Err("hub closed during the handshake".to_string());
            }
            buf.push(byte[0]);
            if buf.len() > 64 * 1024 {
                return Err("oversized hub handshake".to_string());
            }
        }
        Ok::<_, String>((upstream, buf))
    };
    let (mut upstream, buf) = tokio::time::timeout(UPSTREAM_WS_OPEN_TIMEOUT, handshake)
        .await
        .map_err(|_| "the hub did not accept the socket in time".to_string())??;

    let head_text = String::from_utf8_lossy(&buf);
    let mut lines = head_text.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("bad hub status line")?;
    if status != 101 {
        return Err(format!("hub refused the upgrade: {status_line}"));
    }
    let mut builder = Response::builder().status(StatusCode::SWITCHING_PROTOCOLS);
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim();
            if name.eq_ignore_ascii_case("set-cookie") {
                continue;
            }
            if let Ok(v) = HeaderValue::from_str(value.trim()) {
                builder = builder.header(name, v);
            }
        }
    }
    tokio::spawn(async move {
        let Ok(upgraded) = on_upgrade.await else {
            return;
        };
        let mut client = hyper_util::rt::TokioIo::new(upgraded);
        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    });
    builder.body(Body::empty()).map_err(|e| e.to_string())
}

/// Bind the proxy's loopback listener and serve it. Returns the port.
pub async fn serve(state: Arc<ProxyState>) -> Result<u16, String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("device hub proxy: cannot bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, router(state)).await;
    });
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::{get, post};
    use futures_util::{SinkExt, StreamExt};

    // ---- tickets ----

    #[test]
    fn devicehub_ticket_mint_verify_and_expiry() {
        let t = Tickets::default();
        let now = Instant::now();
        let ticket = t.mint_at(now);
        assert_eq!(ticket.len(), 64);
        assert!(t.verify_at(&ticket, now));
        // Media tickets are reused within their lifetime, as in T3.
        assert!(t.verify_at(&ticket, now + Duration::from_secs(60)));
        assert!(!t.verify_at("not-a-ticket", now));
        assert!(!t.verify_at("", now));
        assert!(
            !t.verify_at(&ticket[..63], now),
            "a prefix is not the ticket"
        );
        assert!(!t.verify_at(&ticket, now + TICKET_TTL + Duration::from_millis(1)));
        // Expired tickets are pruned, not just refused.
        assert!(t.live.lock().unwrap().is_empty());
    }

    #[test]
    fn devicehub_ticket_store_is_bounded() {
        let t = Tickets::default();
        let now = Instant::now();
        let first = t.mint_at(now);
        for _ in 0..MAX_LIVE_TICKETS {
            t.mint_at(now);
        }
        assert_eq!(t.live.lock().unwrap().len(), MAX_LIVE_TICKETS);
        assert!(!t.verify_at(&first, now), "the oldest ticket was evicted");
    }

    #[test]
    fn devicehub_ticket_is_stripped_before_forwarding() {
        assert_eq!(upstream_search(Some("wsTicket=secret")), "");
        assert_eq!(upstream_search(None), "");
        assert_eq!(
            upstream_search(Some("device=emulator-5554&wsTicket=secret&frame-meta=1")),
            "?device=emulator-5554&frame-meta=1"
        );
        assert_eq!(
            upstream_search(Some("device=udid-1&hostId=eas&wsTicket=x")),
            "?device=udid-1"
        );
        // An encoded key is still the ticket.
        assert_eq!(upstream_search(Some("ws%54icket=secret&a=1")), "?a=1");
        assert_eq!(
            ticket_from_query(Some("a=1&wsTicket=ab%2Bc")).as_deref(),
            Some("ab+c")
        );
        assert_eq!(ticket_from_query(Some("a=1")), None);
    }

    // ---- allowlist and method rules (DeviceHubProxy.test.ts) ----

    fn decide(path: &str, method: Method, upgrade: bool) -> Result<(), StatusCode> {
        route_decision(path, &method, upgrade)
    }

    #[test]
    fn devicehub_route_allowlist_and_methods() {
        // Reads.
        assert_eq!(decide("/api/devices", Method::GET, false), Ok(()));
        assert_eq!(decide("/vendor/serve-emu/api", Method::GET, false), Ok(()));
        assert_eq!(
            decide("/vendor/serve-emu/api/fold", Method::GET, false),
            Ok(())
        );
        assert_eq!(
            decide(
                "/vendor/serve-sim/helper/udid-1/stream.avcc",
                Method::GET,
                false
            ),
            Ok(())
        );
        assert_eq!(
            decide(
                "/vendor/serve-sim/helper/udid-1/stream.mjpeg",
                Method::HEAD,
                false
            ),
            Ok(())
        );
        // Stream tuning, fold changes and screenshots take POST.
        for path in [
            "/vendor/serve-emu/api/stream-settings",
            "/vendor/serve-emu/api/stream-mode",
            "/vendor/serve-emu/api/fold",
            "/vendor/serve-emu/api/screenshot",
            "/vendor/serve-sim/api/screenshot",
        ] {
            assert_eq!(decide(path, Method::POST, false), Ok(()), "{path}");
        }
        // WebRTC signalling is POST only.
        assert_eq!(
            decide(
                "/vendor/serve-sim/helper/udid-1/webrtc/offer",
                Method::POST,
                false
            ),
            Ok(())
        );
        assert_eq!(
            decide("/vendor/serve-emu/webrtc/offer", Method::POST, false),
            Ok(())
        );
        assert_eq!(
            decide("/vendor/serve-emu/webrtc/close", Method::POST, false),
            Ok(())
        );
        assert_eq!(
            decide("/vendor/serve-emu/webrtc/offer", Method::GET, false),
            Err(StatusCode::METHOD_NOT_ALLOWED)
        );
        // Capabilities are GET only.
        assert_eq!(
            decide("/vendor/serve-emu/api", Method::POST, false),
            Err(StatusCode::METHOD_NOT_ALLOWED)
        );
        assert_eq!(
            decide("/api/devices", Method::DELETE, false),
            Err(StatusCode::METHOD_NOT_ALLOWED)
        );
    }

    #[test]
    fn devicehub_route_sockets_only_on_socket_paths() {
        for path in [
            "/api/devices/ws",
            "/vendor/serve-sim/helper/ws",
            "/vendor/serve-emu/ws",
        ] {
            assert_eq!(decide(path, Method::GET, true), Ok(()), "{path}");
            // Without the upgrade they are not HTTP routes at all.
            assert_eq!(
                decide(path, Method::GET, false),
                Err(StatusCode::NOT_FOUND),
                "{path}"
            );
        }
        // An upgrade to an HTTP route is refused.
        assert_eq!(
            decide("/api/devices", Method::GET, true),
            Err(StatusCode::NOT_FOUND)
        );
    }

    #[test]
    fn devicehub_route_never_forwards_the_vendor_shell_or_unknown_routes() {
        for method in [Method::GET, Method::POST] {
            assert_eq!(
                decide("/vendor/serve-sim/exec", method.clone(), false),
                Err(StatusCode::NOT_FOUND)
            );
            assert_eq!(
                decide("/vendor/serve-sim/exec", method.clone(), true),
                Err(StatusCode::NOT_FOUND)
            );
        }
        // Unsupported Duo routes.
        assert_eq!(
            decide(
                "/vendor/serve-sim/helper/duo/panel/1/webrtc/offer",
                Method::GET,
                false
            ),
            Err(StatusCode::NOT_FOUND)
        );
        // serve-emu's unauthenticated action routes.
        for path in [
            "/vendor/serve-emu/api/install",
            "/vendor/serve-emu/api/shell",
            "/api/devices/boot",
            "/vendor/serve-sim/grid/api/start",
            "/",
            "/vendor/serve-emu/api/devices/../exec",
        ] {
            assert_eq!(
                decide(path, Method::POST, false),
                Err(StatusCode::NOT_FOUND),
                "{path}"
            );
        }
    }

    #[test]
    fn devicehub_forward_headers_present_same_origin_requests() {
        let mut h = HeaderMap::new();
        h.insert("origin", HeaderValue::from_static("https://relay.test"));
        h.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        h.insert("cookie", HeaderValue::from_static("a=b"));
        h.insert("authorization", HeaderValue::from_static("Bearer x"));
        h.insert("content-type", HeaderValue::from_static("application/json"));
        h.insert("accept-encoding", HeaderValue::from_static("gzip"));
        let out = forward_headers(&h, "http://127.0.0.1:9");
        let get = |n: &str| {
            out.iter()
                .find(|(k, _)| k.as_str() == n)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(get("origin").unwrap(), "http://127.0.0.1:9");
        assert_eq!(get("content-type").unwrap(), "application/json");
        for gone in [
            "x-forwarded-proto",
            "cookie",
            "authorization",
            "accept-encoding",
        ] {
            assert!(get(gone).is_none(), "{gone} must not reach the hub");
        }
    }

    // ---- end to end, against a fake hub ----

    struct Fixture {
        proxy: String,
        state: Arc<ProxyState>,
        seen: Arc<Mutex<Vec<String>>>,
    }

    async fn fixture() -> Fixture {
        use axum::extract::ws::{Message, WebSocketUpgrade};
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let record = seen.clone();
        let hub = Router::new()
            .route(
                "/api/devices",
                get(|| async {
                    (
                        [
                            ("set-cookie", "upstream=1"),
                            ("content-type", "application/json"),
                        ],
                        r#"{"simulators":[],"emulators":[]}"#,
                    )
                }),
            )
            .route(
                "/vendor/serve-emu/api/stream-settings",
                post(|body: String| async move { body }),
            )
            .route(
                "/vendor/serve-sim/helper/ws",
                get(|ws: WebSocketUpgrade| async move {
                    ws.on_upgrade(|mut socket| async move {
                        let _ = socket.send(Message::Binary(vec![0x83])).await;
                        while let Some(Ok(msg)) = socket.recv().await {
                            if matches!(msg, Message::Binary(_) | Message::Text(_)) {
                                let _ = socket.send(msg).await;
                            }
                        }
                    })
                }),
            )
            .layer(axum::middleware::from_fn(
                move |req: Request, next: axum::middleware::Next| {
                    let record = record.clone();
                    async move {
                        record.lock().unwrap().push(
                            req.uri()
                                .path_and_query()
                                .map(|p| p.to_string())
                                .unwrap_or_default(),
                        );
                        next.run(req).await
                    }
                },
            ));
        let hub_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let hub_port = hub_listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(hub_listener, hub).await;
        });
        let state = Arc::new(ProxyState::default());
        *state.hub_origin.write().unwrap() = Some(format!("http://127.0.0.1:{hub_port}"));
        let port = serve(state.clone()).await.unwrap();
        Fixture {
            proxy: format!("http://127.0.0.1:{port}{DEVICE_HUB_ROUTE_PREFIX}"),
            state,
            seen,
        }
    }

    #[tokio::test]
    async fn devicehub_proxy_strips_tickets_cookies_and_marks_no_transform() {
        let f = fixture().await;
        let ticket = f.state.tickets.mint();
        let response = reqwest::get(format!("{}/api/devices?wsTicket={ticket}", f.proxy))
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert!(response.headers().get("set-cookie").is_none());
        assert_eq!(
            response.headers().get("cache-control").unwrap(),
            "no-store, no-transform"
        );
        assert_eq!(
            response
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            "*"
        );
        assert_eq!(
            response.text().await.unwrap(),
            r#"{"simulators":[],"emulators":[]}"#
        );
        assert_eq!(*f.seen.lock().unwrap(), vec!["/api/devices".to_string()]);
    }

    #[tokio::test]
    async fn devicehub_proxy_requires_a_ticket_before_reaching_the_hub() {
        let f = fixture().await;
        for url in [
            format!("{}/api/devices", f.proxy),
            format!("{}/api/devices?wsTicket=forged", f.proxy),
        ] {
            assert_eq!(reqwest::get(url).await.unwrap().status(), 401);
        }
        assert!(f.seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn devicehub_proxy_refuses_the_exec_route_and_wrong_methods_without_forwarding() {
        let f = fixture().await;
        let ticket = f.state.tickets.mint();
        let client = reqwest::Client::new();
        let exec = client
            .post(format!(
                "{}/vendor/serve-sim/exec?wsTicket={ticket}",
                f.proxy
            ))
            .body("rm -rf /")
            .send()
            .await
            .unwrap();
        assert_eq!(exec.status(), 404);
        let wrong = client
            .post(format!(
                "{}/vendor/serve-emu/api?wsTicket={ticket}",
                f.proxy
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(wrong.status(), 405);
        assert!(f.seen.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn devicehub_proxy_streams_mutation_bodies_and_answers_preflights() {
        let f = fixture().await;
        let ticket = f.state.tickets.mint();
        let client = reqwest::Client::new();
        let url = format!(
            "{}/vendor/serve-emu/api/stream-settings?wsTicket={ticket}",
            f.proxy
        );
        let preflight = client.request(Method::OPTIONS, &url).send().await.unwrap();
        assert_eq!(preflight.status(), 204);
        assert_eq!(
            preflight
                .headers()
                .get("access-control-allow-origin")
                .unwrap(),
            "*"
        );
        let response = client
            .post(&url)
            .header("content-type", "application/json")
            .body(r#"{"maxFps":30}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.text().await.unwrap(), r#"{"maxFps":30}"#);
        assert_eq!(
            *f.seen.lock().unwrap(),
            vec!["/vendor/serve-emu/api/stream-settings".to_string()]
        );
    }

    #[tokio::test]
    async fn devicehub_proxy_reports_a_stopped_hub() {
        let f = fixture().await;
        *f.state.hub_origin.write().unwrap() = None;
        let ticket = f.state.tickets.mint();
        let response = reqwest::get(format!("{}/api/devices?wsTicket={ticket}", f.proxy))
            .await
            .unwrap();
        assert_eq!(response.status(), 503);
    }

    /// DeviceHubProxy.stream.test.ts: binary input and admission frames
    /// survive the real socket proxy.
    #[tokio::test]
    async fn devicehub_proxy_preserves_binary_websocket_frames() {
        use tokio_tungstenite::tungstenite::Message;
        let f = fixture().await;
        let ticket = f.state.tickets.mint();
        let url = format!(
            "{}/vendor/serve-sim/helper/ws?device=test&wsTicket={ticket}",
            f.proxy.replacen("http", "ws", 1)
        );
        let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        let first = socket.next().await.unwrap().unwrap();
        assert_eq!(first, Message::Binary(vec![0x83]));
        socket.send(Message::Binary(vec![0x03, 1])).await.unwrap();
        socket.send(Message::Binary(vec![0x03, 2])).await.unwrap();
        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            Message::Binary(vec![0x03, 1])
        );
        assert_eq!(
            socket.next().await.unwrap().unwrap(),
            Message::Binary(vec![0x03, 2])
        );
        assert_eq!(
            *f.seen.lock().unwrap(),
            vec!["/vendor/serve-sim/helper/ws?device=test".to_string()]
        );
    }

    #[tokio::test]
    async fn devicehub_proxy_refuses_sockets_without_a_ticket() {
        let f = fixture().await;
        let url = format!(
            "{}/vendor/serve-emu/ws?device=emulator-5554",
            f.proxy.replacen("http", "ws", 1)
        );
        assert!(tokio_tungstenite::connect_async(url).await.is_err());
        assert!(f.seen.lock().unwrap().is_empty());
    }
}

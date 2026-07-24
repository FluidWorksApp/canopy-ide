//! Canopy Remote — an embedded HTTP + WebSocket server that lets you drive your
//! own Canopy from a phone or browser on the same network (or over the internet
//! through a TLS-terminating tunnel).
//!
//! It reuses the *local* command surface, not the team relay's wire protocol:
//! - snapshots come straight from `store_load` / `session_digests` /
//!   `agent_usage` (all machine-global, no project scoping);
//! - live status deltas are the app's own `pty:stats` / `agent:event` /
//!   `pty:exit` events, tapped with `listen_any` and forwarded verbatim;
//! - agent output streams from the `PtyManager` scrollback + broadcast fan-out
//!   (see pty.rs), and input / approve / deny / kill go back through
//!   `PtyManager::write` / `::kill`.
//!
//! Off by default. A dedicated numeric PIN (NOT the team join code) gates
//! `POST /remote/auth`, which mints a bearer token; the WebSocket requires that
//! token. The token has no wall-clock expiry — it stays valid for the whole life
//! of this enable session, dying only when the PIN owner disables the server or
//! rotates the PIN. Wrong PINs are constant-time-compared and tarpitted.
//!
//! Transport: plain HTTP on 6680 — fine on a trusted LAN, and a
//! Tailscale/Cloudflare/ngrok tunnel (see tunnel.rs) adds real TLS for remote
//! use. This same server is the single ingress the team relay also rides
//! (see the `/team` route and relay.rs): whichever endpoint is active — the LAN
//! URL or the active tunnel — carries both Remote access and Team sessions,
//! gated by their own separate PINs.

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State as AxumState};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, EventId, Listener, Manager};
use tokio::sync::{broadcast, mpsc};

use crate::pty::{PtyEvent, PtyManager};

/// The built portal SPA, baked into the binary so it ships offline. Populated by
/// the portal's own Vite build (`npm run build:portal`); a placeholder index is
/// committed so this compiles before the SPA is built.
static PORTAL_ASSETS: Dir = include_dir!("$CARGO_MANIFEST_DIR/../portal/dist");

const DEFAULT_PORT: u16 = 6680;
/// Deliberate delay on a wrong PIN, mirroring the relay's identity tarpit — a
/// 6-digit PIN over a throttled endpoint is not brute-forceable in practice.
const AUTH_TARPIT: Duration = Duration::from_secs(2);
/// App events we mirror to every connected portal client.
const FORWARDED_EVENTS: [&str; 3] = ["pty:stats", "agent:event", "pty:exit"];

/// Live bearer tokens for the *current* enable session. The set is created fresh
/// in `remote_enable` and dropped on disable/rotate, so a token is valid for
/// exactly as long as this session lives — no wall-clock expiry. Re-auth is only
/// ever forced by the PIN owner tearing the session down or rotating the PIN.
type Tokens = Arc<Mutex<HashSet<String>>>;

/// Managed state: at most one running server. Enabling twice is a no-op that
/// returns the current status.
#[derive(Default)]
pub struct RemoteManager {
    inner: Mutex<Option<Running>>,
    /// Canopy theme tokens the desktop pushes (var name → color), so the portal
    /// can render in the same skin. Persists across enable/disable.
    theme: Arc<Mutex<Option<Value>>>,
}

struct Running {
    addr: SocketAddr,
    pin: String,
    /// Public IP as revealed by STUN (reusing the relay's discovery), if any.
    /// Combined with the TCP port for a port-forward connect URL.
    public_ip: Option<String>,
    /// Set to `true` to trigger the server's graceful shutdown.
    shutdown: tokio::sync::watch::Sender<bool>,
    /// The `listen_any` registrations to drop on disable.
    listeners: Vec<EventId>,
}

impl RemoteManager {
    /// Best-effort teardown on app exit (called from lib.rs run-loop Exit).
    pub fn shutdown(&self) {
        if let Some(r) = self.inner.lock().unwrap().take() {
            let _ = r.shutdown.send(true);
        }
    }
}

/// Axum handler state — cheap to clone, shared across every request/socket.
#[derive(Clone)]
struct Portal {
    app: AppHandle,
    pin: Arc<String>,
    tokens: Tokens,
    /// Fan-out of forwarded app events (as ready-to-send JSON) to all sockets.
    events: broadcast::Sender<String>,
    /// Shared handle to the desktop-pushed theme tokens (see RemoteManager).
    theme: Arc<Mutex<Option<Value>>>,
}

/// What the desktop UI shows for the Remote-access panel.
#[derive(Serialize, Clone)]
pub struct RemoteStatus {
    pub enabled: bool,
    pub port: u16,
    /// Present only while enabled — the PIN to enter in the portal.
    pub pin: Option<String>,
    /// Same-network `http://<lan-ip>:<port>/remote` addresses.
    pub urls: Vec<String>,
    /// `http://<public-ip>:<port>/remote` — usable only if TCP <port> is
    /// port-forwarded to this machine. None if STUN found no public address.
    pub public_url: Option<String>,
    /// Inline SVG QR of the primary LAN URL, for scan-to-connect.
    pub qr_svg: Option<String>,
}

impl RemoteStatus {
    fn off() -> Self {
        RemoteStatus {
            enabled: false,
            port: DEFAULT_PORT,
            pin: None,
            urls: vec![],
            public_url: None,
            qr_svg: None,
        }
    }
    fn from(r: &Running) -> Self {
        let port = r.addr.port();
        let urls: Vec<String> = local_ips()
            .into_iter()
            .map(|ip| format!("http://{ip}:{port}/remote"))
            .collect();
        // QR the first LAN URL (the same-Wi-Fi path), or localhost as a fallback.
        let primary = urls
            .first()
            .cloned()
            .unwrap_or_else(|| format!("http://localhost:{port}/remote"));
        let public_url = r
            .public_ip
            .as_ref()
            .map(|ip| format!("http://{ip}:{port}/remote"));
        RemoteStatus {
            enabled: true,
            port,
            pin: Some(r.pin.clone()),
            urls,
            public_url,
            qr_svg: qr_svg_of(&primary),
        }
    }
}

// ---- Tauri commands -------------------------------------------------------

#[tauri::command]
pub async fn remote_enable(
    app: AppHandle,
    mgr: tauri::State<'_, RemoteManager>,
) -> Result<RemoteStatus, String> {
    // Fast path: already running. Scoped so the guard never crosses an await.
    {
        let guard = mgr.inner.lock().unwrap();
        if let Some(r) = guard.as_ref() {
            return Ok(RemoteStatus::from(r));
        }
    }

    let pin = gen_pin();
    let tokens: Tokens = Default::default();
    let (events_tx, _keep) = broadcast::channel::<String>(1024);

    // Tap the app event bus and re-broadcast as portal messages. Dropped on
    // disable via the stored EventIds.
    let mut listeners = Vec::new();
    for name in FORWARDED_EVENTS {
        let tx = events_tx.clone();
        let id = app.listen_any(name, move |ev| {
            let payload: Value = serde_json::from_str(ev.payload()).unwrap_or(Value::Null);
            let msg = json!({ "t": "event", "name": name, "payload": payload }).to_string();
            let _ = tx.send(msg);
        });
        listeners.push(id);
    }

    let portal = Portal {
        app: app.clone(),
        pin: Arc::new(pin.clone()),
        tokens,
        events: events_tx,
        theme: mgr.theme.clone(),
    };
    let router = Router::new()
        .route("/remote/auth", post(auth_handler))
        .route("/remote/ws", get(ws_handler))
        .route("/remote/health", get(|| async { "ok" }))
        // Team relay ingress on the same server — the internet path, where the
        // tunnel forwards a joiner's wss:// here. Gated by the team join code
        // (SPAKE2 over the socket), NOT the portal PIN: two separate credentials
        // on one endpoint.
        .route("/team/ws", get(team_ws_handler))
        .fallback(asset_handler)
        .with_state(portal);

    // Bind 6680, falling back to an ephemeral port if it's taken.
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", DEFAULT_PORT)).await {
        Ok(l) => l,
        Err(_) => tokio::net::TcpListener::bind(("0.0.0.0", 0))
            .await
            .map_err(|e| format!("remote: cannot bind: {e}"))?,
    };
    let addr = listener.local_addr().map_err(|e| e.to_string())?;

    // Learn our public IP the same way the relay does (STUN). Blocking with
    // socket timeouts, so run it off the async executor. Best-effort: symmetric
    // NAT or no reply just means no public URL is offered.
    let public_ip = tokio::task::spawn_blocking(|| {
        std::net::UdpSocket::bind("0.0.0.0:0")
            .ok()
            .and_then(|sock| crate::punch::discover(&sock).ok())
            .map(|a| a.ip().to_string())
    })
    .await
    .ok()
    .flatten();

    let (sd_tx, mut sd_rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        let shutdown = async move {
            // Resolve when the flag flips to true.
            while sd_rx.changed().await.is_ok() {
                if *sd_rx.borrow() {
                    break;
                }
            }
        };
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(shutdown)
            .await;
    });

    // Re-check under lock in case two enables raced; if so, keep the first and
    // tear ours down.
    let mut guard = mgr.inner.lock().unwrap();
    if let Some(existing) = guard.as_ref() {
        let _ = sd_tx.send(true);
        for id in listeners {
            app.unlisten(id);
        }
        return Ok(RemoteStatus::from(existing));
    }
    let running = Running {
        addr,
        pin,
        public_ip,
        shutdown: sd_tx,
        listeners,
    };
    let status = RemoteStatus::from(&running);
    *guard = Some(running);
    Ok(status)
}

#[tauri::command]
pub async fn remote_disable(
    app: AppHandle,
    mgr: tauri::State<'_, RemoteManager>,
) -> Result<RemoteStatus, String> {
    let taken = mgr.inner.lock().unwrap().take();
    if let Some(r) = taken {
        let _ = r.shutdown.send(true);
        for id in r.listeners {
            app.unlisten(id);
        }
    }
    Ok(RemoteStatus::off())
}

/// Push the desktop's current theme tokens so the portal renders in the same
/// skin. Called on enable and whenever the theme changes. Cheap and idempotent.
#[tauri::command]
pub async fn remote_set_theme(
    theme: Value,
    mgr: tauri::State<'_, RemoteManager>,
) -> Result<(), String> {
    *mgr.theme.lock().unwrap() = Some(theme);
    Ok(())
}

/// A QR SVG for any URL — so the desktop can point the code at the LAN address
/// or the active tunnel URL depending on the chosen scope.
#[tauri::command]
pub fn remote_qr(text: String) -> Option<String> {
    qr_svg_of(&text)
}

#[tauri::command]
pub async fn remote_status(mgr: tauri::State<'_, RemoteManager>) -> Result<RemoteStatus, String> {
    Ok(mgr
        .inner
        .lock()
        .unwrap()
        .as_ref()
        .map(RemoteStatus::from)
        .unwrap_or_else(RemoteStatus::off))
}

#[tauri::command]
pub async fn remote_rotate_pin(
    app: AppHandle,
    mgr: tauri::State<'_, RemoteManager>,
) -> Result<RemoteStatus, String> {
    // Simplest correct rotation: fully stop (invalidates all tokens + the old
    // PIN) then start fresh with a new PIN and a clean token set.
    remote_disable(app.clone(), mgr.clone()).await?;
    remote_enable(app, mgr).await
}

// ---- HTTP handlers --------------------------------------------------------

#[derive(Deserialize)]
struct AuthReq {
    pin: String,
}

async fn auth_handler(AxumState(p): AxumState<Portal>, Json(body): Json<AuthReq>) -> Response {
    if !ct_eq(body.pin.as_bytes(), p.pin.as_bytes()) {
        tokio::time::sleep(AUTH_TARPIT).await;
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "bad pin" })),
        )
            .into_response();
    }
    let token = gen_token();
    p.tokens.lock().unwrap().insert(token.clone());
    Json(json!({ "token": token })).into_response()
}

#[derive(Deserialize)]
struct WsQuery {
    token: String,
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    AxumState(p): AxumState<Portal>,
) -> Response {
    if !valid_token(&p.tokens, &q.token) {
        return (StatusCode::UNAUTHORIZED, "bad token").into_response();
    }
    ws.on_upgrade(move |socket| ws_conn(socket, p))
}

/// Team relay ingress on the shared server. Unlike `/remote/*`, this carries the
/// team wire protocol, not the local command surface, and is authenticated by
/// the team join code via SPAKE2 over the socket — a separate credential from
/// the portal PIN. We only gate on whether a team is currently being hosted; the
/// relay does the code verification (and tarpits a wrong one) itself.
async fn team_ws_handler(ws: WebSocketUpgrade, AxumState(p): AxumState<Portal>) -> Response {
    if !crate::relay::is_hosting(&p.app) {
        return (StatusCode::FORBIDDEN, "team hosting is off").into_response();
    }
    let app = p.app.clone();
    ws.on_upgrade(move |socket| crate::relay::accept_ws_peer(app, socket))
}

/// Serve the SPA: any path under `/remote` maps to a baked asset, with an
/// index.html fallback so client-side routing works; everything else 404s.
async fn asset_handler(uri: Uri) -> Response {
    let path = uri.path();
    // The portal lives under /remote; send bare-domain hits (e.g. a tunnel URL
    // opened without the path) there instead of 404ing.
    let Some(rest) = path.strip_prefix("/remote") else {
        return Redirect::permanent("/remote/").into_response();
    };
    let rel = rest.trim_start_matches('/');
    if !rel.is_empty() {
        if let Some(file) = PORTAL_ASSETS.get_file(rel) {
            return (
                [
                    (header::CONTENT_TYPE, content_type(rel)),
                    (header::CACHE_CONTROL, cache_control(rel)),
                ],
                file.contents().to_vec(),
            )
                .into_response();
        }
    }
    // Directory or unknown sub-path → SPA entry point.
    match PORTAL_ASSETS.get_file("index.html") {
        Some(f) => (
            [
                (header::CONTENT_TYPE, "text/html; charset=utf-8"),
                (header::CACHE_CONTROL, "no-cache"),
            ],
            f.contents().to_vec(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "portal not built").into_response(),
    }
}

/// Vite emits content-hashed filenames under assets/, so those can be cached
/// forever (a new build changes the hash); everything else must revalidate so a
/// rebuild is always picked up. Lets the browser — and any tunnel/CDN in front —
/// serve repeat loads from cache, which matters most over a higher-latency link.
fn cache_control(rel: &str) -> &'static str {
    if rel.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

// ---- WebSocket session ----------------------------------------------------

async fn ws_conn(mut socket: WebSocket, p: Portal) {
    // Single writer: every outbound message (snapshot, forwarded events, pty
    // chunks) funnels through this mpsc so we never contend on the socket.
    let (out_tx, mut out_rx) = mpsc::channel::<String>(512);

    // Initial snapshot.
    let theme0 = p.theme.lock().unwrap().clone();
    if out_tx
        .send(snapshot_msg(&p.app, theme0).await)
        .await
        .is_err()
    {
        return;
    }

    // Forward global app events to this socket.
    {
        let out = out_tx.clone();
        let mut ev_rx = p.events.subscribe();
        tokio::spawn(async move {
            while let Ok(msg) = ev_rx.recv().await {
                if out.send(msg).await.is_err() {
                    break;
                }
            }
        });
    }

    // Per-PTY output streaming tasks, so we can detach/clean up.
    let mut attaches: HashMap<u32, tokio::task::JoinHandle<()>> = HashMap::new();

    loop {
        tokio::select! {
            inbound = socket.recv() => {
                match inbound {
                    Some(Ok(Message::Text(t))) => {
                        handle_client_msg(&t, &p, &out_tx, &mut attaches);
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
            outbound = out_rx.recv() => {
                match outbound {
                    Some(msg) => {
                        if socket.send(Message::Text(msg)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
        }
    }

    for (_, h) in attaches {
        h.abort();
    }
}

fn handle_client_msg(
    text: &str,
    p: &Portal,
    out: &mpsc::Sender<String>,
    attaches: &mut HashMap<u32, tokio::task::JoinHandle<()>>,
) {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return;
    };
    match v.get("t").and_then(|t| t.as_str()) {
        Some("attach") => {
            if let Some(id) = v.get("pty").and_then(|x| x.as_u64()) {
                let id = id as u32;
                if attaches.contains_key(&id) {
                    return;
                }
                let app = p.app.clone();
                let out = out.clone();
                attaches.insert(id, tokio::spawn(stream_pty(app, id, out)));
            }
        }
        Some("detach") => {
            if let Some(id) = v.get("pty").and_then(|x| x.as_u64()) {
                if let Some(h) = attaches.remove(&(id as u32)) {
                    h.abort();
                }
            }
        }
        Some("input") => {
            if let (Some(id), Some(data)) = (
                v.get("pty").and_then(|x| x.as_u64()),
                v.get("data").and_then(|x| x.as_str()),
            ) {
                let _ = p.app.state::<PtyManager>().write(id as u32, data);
            }
        }
        Some("kill") => {
            if let Some(id) = v.get("pty").and_then(|x| x.as_u64()) {
                let _ = p.app.state::<PtyManager>().kill(id as u32);
            }
        }
        Some("spawn") => {
            // Open a new headless PTY (a fresh terminal / agent) the client can
            // then attach to. `command` (an agent CLI) runs in `cwd` if given.
            let cwd = v.get("cwd").and_then(|x| x.as_str()).map(String::from);
            let command = v.get("command").and_then(|x| x.as_str()).map(String::from);
            let app = p.app.clone();
            let out = out.clone();
            tokio::spawn(async move {
                let msg = match app
                    .state::<PtyManager>()
                    .spawn_headless(app.clone(), cwd, command)
                {
                    Ok(id) => json!({ "t": "spawned", "pty": id }),
                    Err(e) => json!({ "t": "spawn-error", "message": e }),
                };
                let _ = out.send(msg.to_string()).await;
            });
        }
        Some("refresh") => {
            let out = out.clone();
            let app = p.app.clone();
            let theme = p.theme.lock().unwrap().clone();
            tokio::spawn(async move {
                let _ = out.send(snapshot_msg(&app, theme).await).await;
            });
        }
        _ => {}
    }
}

/// Stream one PTY's output to the socket: a catch-up snapshot, then the live
/// tail. On broadcast lag we re-attach for a fresh snapshot rather than let the
/// terminal render torn output.
async fn stream_pty(app: AppHandle, id: u32, out: mpsc::Sender<String>) {
    loop {
        let attached = app.state::<PtyManager>().attach(id);
        let Some((cols, rows, snapshot, mut rx)) = attached else {
            let _ = out
                .send(json!({ "t": "pty-gone", "pty": id }).to_string())
                .await;
            return;
        };
        // Tell the client to clear, size to the PTY's grid, then re-seed.
        if out
            .send(json!({ "t": "pty-reset", "pty": id }).to_string())
            .await
            .is_err()
        {
            return;
        }
        if out
            .send(json!({ "t": "pty-size", "pty": id, "cols": cols, "rows": rows }).to_string())
            .await
            .is_err()
        {
            return;
        }
        if !snapshot.is_empty() && out.send(pty_chunk(id, &snapshot)).await.is_err() {
            return;
        }
        loop {
            match rx.recv().await {
                Ok(PtyEvent::Data(chunk)) => {
                    if out.send(pty_chunk(id, &chunk)).await.is_err() {
                        return;
                    }
                }
                Ok(PtyEvent::Resize(c, r)) => {
                    let msg = json!({ "t": "pty-size", "pty": id, "cols": c, "rows": r });
                    if out.send(msg.to_string()).await.is_err() {
                        return;
                    }
                }
                // Fell behind — break to the outer loop for a fresh snapshot.
                Err(broadcast::error::RecvError::Lagged(_)) => break,
                Err(broadcast::error::RecvError::Closed) => {
                    let _ = out
                        .send(json!({ "t": "pty-gone", "pty": id }).to_string())
                        .await;
                    return;
                }
            }
        }
    }
}

fn pty_chunk(id: u32, bytes: &[u8]) -> String {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    json!({ "t": "pty", "pty": id, "b64": b64 }).to_string()
}

/// Projects + agent sessions + usage + live PTYs + theme, as the desktop reads
/// them. `ptys` is the authoritative live set (from PtyManager) so the client
/// knows which agents are attachable without waiting on the pty:stats event.
async fn snapshot_msg(app: &AppHandle, theme: Option<Value>) -> String {
    let projects = crate::fsx::store_load()
        .await
        .unwrap_or_else(|_| "null".into());
    let projects: Value = serde_json::from_str(&projects).unwrap_or(Value::Null);
    let sessions = crate::agents::session_digests().await.unwrap_or_default();
    let usage = crate::agents::agent_usage().await.unwrap_or_default();
    let ptys = app.state::<PtyManager>().summaries();
    json!({
        "t": "snapshot",
        "projects": projects,
        "sessions": sessions,
        "usage": usage,
        "ptys": ptys,
        "instance": crate::pty::instance_token(),
        "theme": theme,
    })
    .to_string()
}

// ---- helpers --------------------------------------------------------------

fn valid_token(tokens: &Tokens, tok: &str) -> bool {
    tokens.lock().unwrap().contains(tok)
}

fn gen_pin() -> String {
    let mut b = [0u8; 4];
    let _ = getrandom::getrandom(&mut b);
    format!("{:06}", u32::from_le_bytes(b) % 1_000_000)
}

fn gen_token() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::getrandom(&mut b);
    hex::encode(b)
}

/// Constant-time equality — length mismatch short-circuits (a PIN's length is
/// not a secret), equal-length inputs are compared without an early exit.
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut d = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        d |= x ^ y;
    }
    d == 0
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Encode `data` as a QR and hand-build a minimal SVG (one 1×1 rect per dark
/// module, with a 2-module quiet zone). Returns None if encoding fails.
fn qr_svg_of(data: &str) -> Option<String> {
    let code = qrcode::QrCode::new(data.as_bytes()).ok()?;
    let w = code.width();
    let colors = code.to_colors();
    let quiet = 2usize;
    let dim = w + quiet * 2;
    let mut rects = String::new();
    for (i, c) in colors.iter().enumerate() {
        if *c == qrcode::Color::Dark {
            let x = i % w + quiet;
            let y = i / w + quiet;
            rects.push_str(&format!(
                "<rect x=\"{x}\" y=\"{y}\" width=\"1\" height=\"1\"/>"
            ));
        }
    }
    Some(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {dim} {dim}\" \
         shape-rendering=\"crispEdges\"><rect width=\"{dim}\" height=\"{dim}\" fill=\"#fff\"/>\
         <g fill=\"#000\">{rects}</g></svg>"
    ))
}

/// The primary LAN address(es) to show in the connect URL. Uses the standard
/// connected-UDP trick (no packets are sent) to learn the outbound interface IP.
fn local_ips() -> Vec<String> {
    let mut ips = Vec::new();
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                ips.push(addr.ip().to_string());
            }
        }
    }
    ips
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ct_eq_accepts_equal_rejects_different_and_length() {
        assert!(ct_eq(b"481920", b"481920"));
        assert!(!ct_eq(b"481920", b"481921"));
        assert!(!ct_eq(b"481920", b"48192")); // length mismatch
        assert!(ct_eq(b"", b""));
        assert!(!ct_eq(b"", b"x"));
    }

    #[test]
    fn gen_pin_is_six_digits() {
        for _ in 0..100 {
            let pin = gen_pin();
            assert_eq!(pin.len(), 6);
            assert!(pin.chars().all(|c| c.is_ascii_digit()));
        }
    }

    #[test]
    fn gen_token_is_32_hex() {
        let tok = gen_token();
        assert_eq!(tok.len(), 32);
        assert!(tok.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn qr_svg_is_wellformed() {
        let svg = qr_svg_of("http://192.168.1.20:6680/remote").expect("qr encodes");
        assert!(svg.starts_with("<svg"));
        assert!(svg.contains("viewBox=\"0 0"));
        assert!(svg.contains("<rect"));
        assert!(svg.trim_end().ends_with("</svg>"));
    }

    #[test]
    fn content_type_maps_common_extensions() {
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(
            content_type("assets/app.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type("a.css"), "text/css; charset=utf-8");
        assert_eq!(content_type("logo.svg"), "image/svg+xml");
        assert_eq!(content_type("noext"), "application/octet-stream");
    }
}

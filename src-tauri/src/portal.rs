//! Canopy Remote — an embedded HTTP + WebSocket server that lets you drive your
//! own Canopy from a phone or browser on the same network (or over the internet
//! through a TLS-terminating tunnel).
//!
//! It reuses the *local* command surface, not the team relay's wire protocol:
//! - snapshots come straight from `store_load` / `session_digests` /
//!   `agent_usage` (all machine-global, no project scoping);
//! - live status deltas are the app's own `pty:stats` / `agent:events` /
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
use crate::remote::verbs::{Answer, Begin, VerbRouter};
use crate::remote::Scope;

/// The built portal SPA, baked into the binary so it ships offline. Populated by
/// the portal's own Vite build (`npm run build:portal`); a placeholder index is
/// committed so this compiles before the SPA is built.
static PORTAL_ASSETS: Dir = include_dir!("$CARGO_MANIFEST_DIR/../portal/dist");

const DEFAULT_PORT: u16 = 6680;
/// Deliberate delay on a wrong PIN, mirroring the relay's identity tarpit — a
/// 6-digit PIN over a throttled endpoint is not brute-forceable in practice.
const AUTH_TARPIT: Duration = Duration::from_secs(2);
/// App events we mirror to every connected portal client.
const FORWARDED_EVENTS: [&str; 3] = ["pty:stats", "agent:events", "pty:exit"];

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
    /// Browser-safe projection of the desktop's resolved agent CLI registry.
    clis: Arc<Mutex<Value>>,
    /// Companion presence + transcript, pushed by the desktop frontend the same
    /// way the theme is. The Rust core never sees the conversation (the
    /// transcript lives in the frontend, by design — see companion.rs), so a
    /// desktop push is the only honest source. Null until the first push.
    companion: Arc<Mutex<Value>>,
    /// Ids of projects the desktop reports as hibernating. The marker lives in
    /// the desktop webview's localStorage (hibernation.ts is the single source
    /// of truth), so a push is the only honest way to learn it here. A
    /// hibernating project keeps its IDE tab but nothing in it is running —
    /// the portal must not offer it.
    hibernated: Mutex<Vec<String>>,
    /// The desktop's attention channel (src/attention.ts), pushed like the
    /// companion is: questions agents raised in the desktop UI never touch the
    /// hook stream, so without this push the portal cannot know an agent is
    /// waiting on an answer. Null until the first push.
    attention: Mutex<Value>,
    /// The session scope, cached — see `open_scope`.
    roots: RootsCache,
}

#[derive(Clone, Default)]
struct SessionScope {
    /// Components explicitly opened in the IDE.
    roots: Vec<String>,
    /// Other worktrees of those repositories. A nested worktree is still under
    /// its main checkout by path, so these are explicit exclusion boundaries.
    other_worktrees: Vec<String>,
}

/// Cached session scope and when it was computed.
///
/// Recomputing them means asking git for each repo's worktrees, and the
/// snapshot runs every four seconds per connected client. Worktrees appear when
/// someone creates one — minutes apart at best — so this is the difference
/// between a couple of git processes a minute and a couple of git processes a
/// second, for identical output.
type RootsCache = Arc<Mutex<Option<(std::time::Instant, SessionScope)>>>;

/// How long a scope stays good. A worktree created on the desktop is excluded
/// from the phone's current-checkout list within this.
const ROOTS_TTL: Duration = Duration::from_secs(60);

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
    clis: Arc<Mutex<Value>>,
    companion: Arc<Mutex<Value>>,
    /// Shared handle to the cached scoping roots (see RemoteManager).
    roots: RootsCache,
    /// Replay and single-flight bookkeeping for desktop-executed verbs. Shared
    /// across sockets on purpose: a phone that reconnects mid-action gets the
    /// first answer back rather than starting a second run.
    verbs: Arc<VerbRouter>,
}

/// What a PIN-minted token may do. Drive, not admin: it matches the surface
/// this server already had (attach, write, spawn, kill) and grants nothing
/// beyond it. A finer split — a view-only share link — is an auth change, not a
/// dispatch change, and belongs with the token model rather than here.
const TOKEN_SCOPE: Scope = Scope::Drive;

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
        clis: mgr.clis.clone(),
        companion: mgr.companion.clone(),
        roots: mgr.roots.clone(),
        verbs: Arc::new(VerbRouter::default()),
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

#[tauri::command]
pub async fn remote_set_clis(
    clis: Value,
    mgr: tauri::State<'_, RemoteManager>,
) -> Result<(), String> {
    *mgr.clis.lock().unwrap() = clis;
    Ok(())
}

/// Push the companion's presence and transcript, from the one place that has
/// them — the desktop frontend (companionSession.ts). Same contract as the
/// theme: called on every change, cheap, idempotent, snapshot-carried.
#[tauri::command]
pub async fn remote_set_companion(
    companion: Value,
    mgr: tauri::State<'_, RemoteManager>,
) -> Result<(), String> {
    *mgr.companion.lock().unwrap() = companion;
    Ok(())
}

/// Push the ids of hibernating projects. Same contract as the theme: called on
/// every change, cheap, idempotent, snapshot-carried. Also drops the scope
/// cache — the scope folds hibernated projects out, so it is stale the moment
/// the set changes.
#[tauri::command]
pub async fn remote_set_hibernated(
    ids: Vec<String>,
    mgr: tauri::State<'_, RemoteManager>,
) -> Result<(), String> {
    *mgr.hibernated.lock().unwrap() = ids;
    *mgr.roots.lock().unwrap() = None;
    Ok(())
}

/// Push the desktop's attention channel (questions + notifications), from the
/// one place that has it — the frontend's localStorage-backed queue.
#[tauri::command]
pub async fn remote_set_attention(
    items: Value,
    mgr: tauri::State<'_, RemoteManager>,
) -> Result<(), String> {
    *mgr.attention.lock().unwrap() = items;
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
async fn asset_handler(uri: Uri, headers: header::HeaderMap) -> Response {
    let path = uri.path();
    // The portal lives under /remote; send bare-domain hits (e.g. a tunnel URL
    // opened without the path) there instead of 404ing.
    let Some(rest) = path.strip_prefix("/remote") else {
        return Redirect::permanent("/remote/").into_response();
    };
    let rel = rest.trim_start_matches('/');
    if !rel.is_empty() {
        if let Some(file) = PORTAL_ASSETS.get_file(rel) {
            // Revalidation, not immutability: the vite build pins asset names
            // (`assets/index.js`) because dist/index.html is committed, so a
            // rebuild reuses the same URL with new bytes. An `immutable` header
            // here strands every phone that ever loaded the portal on the old
            // bundle for a year; a content ETag makes the repeat load a 304.
            let etag = etag_of(file.contents());
            if headers
                .get(header::IF_NONE_MATCH)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v == etag)
            {
                return StatusCode::NOT_MODIFIED.into_response();
            }
            return (
                [
                    (header::CONTENT_TYPE, content_type(rel).to_string()),
                    (header::CACHE_CONTROL, cache_control(rel).to_string()),
                    (header::ETAG, etag),
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

/// Everything revalidates. The build does NOT hash asset filenames (the vite
/// config pins `assets/index.js` so the committed dist/index.html stays
/// stable), so nothing here may claim `immutable` — that was serving year-old
/// bundles to any phone that had visited before a rebuild. `no-cache` still
/// caches; the ETag turns the revalidation into a 304, which is what actually
/// matters over a higher-latency tunnel link.
fn cache_control(_rel: &str) -> &'static str {
    "no-cache"
}

/// A content ETag for a baked asset: FNV-1a over the bytes, computed per
/// request. The assets are in-memory and small; hashing them is microseconds,
/// and it saves carrying a lazy-static map alongside `include_dir`.
fn etag_of(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("\"{h:016x}\"")
}

// ---- WebSocket session ----------------------------------------------------

async fn ws_conn(mut socket: WebSocket, p: Portal) {
    // Single writer: every outbound message (snapshot, forwarded events, pty
    // chunks) funnels through this mpsc so we never contend on the socket.
    let (out_tx, mut out_rx) = mpsc::channel::<String>(512);

    // Initial snapshot.
    let theme0 = p.theme.lock().unwrap().clone();
    let clis0 = p.clis.lock().unwrap().clone();
    let companion0 = p.companion.lock().unwrap().clone();
    if out_tx
        .send(snapshot_msg(&p.app, theme0, clis0, companion0, &p.roots).await)
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
            let agent = v.get("agent").and_then(|x| x.as_str()).map(String::from);
            let profile = v.get("profile").and_then(|x| x.as_str()).map(String::from);
            let app = p.app.clone();
            let out = out.clone();
            tokio::spawn(async move {
                let account = match (std::env::var("HOME").ok(), agent, profile) {
                    (Some(home), Some(agent), None) => {
                        let profile = crate::profiles::active(&home);
                        Ok(Some(crate::profiles::env_for(&home, &agent, &profile)))
                    }
                    (_, None, None) => Ok(None),
                    (Some(home), Some(agent), Some(profile)) => {
                        let exists = crate::profiles::list(&home).iter().any(|p| p.id == profile);
                        if exists {
                            Ok(Some(crate::profiles::env_for(&home, &agent, &profile)))
                        } else {
                            Err(format!("profile '{profile}' no longer exists"))
                        }
                    }
                    _ => Err("a restored profile requires its agent id".into()),
                };
                let msg = match account.and_then(|account| {
                    app.state::<PtyManager>()
                        .spawn_headless(app.clone(), cwd, command, account)
                }) {
                    Ok(id) => json!({ "t": "spawned", "pty": id }),
                    Err(e) => json!({ "t": "spawn-error", "message": e }),
                };
                let _ = out.send(msg.to_string()).await;
            });
        }
        Some("act") => act(&v, p, out),
        Some("caps") => {
            let out = out.clone();
            let msg = json!({ "t": "caps", "caps": crate::remote::capabilities() }).to_string();
            tokio::spawn(async move {
                let _ = out.send(msg).await;
            });
        }
        Some("refresh") => {
            let out = out.clone();
            let app = p.app.clone();
            let theme = p.theme.lock().unwrap().clone();
            let clis = p.clis.lock().unwrap().clone();
            let companion = p.companion.lock().unwrap().clone();
            let roots = p.roots.clone();
            tokio::spawn(async move {
                let _ = out
                    .send(snapshot_msg(&app, theme, clis, companion, &roots).await)
                    .await;
            });
        }
        _ => {}
    }
}

/// The one action entry point, and the reason a new remote module needs no new
/// message: the client sends `act` and does not know whether the work is a Rust
/// command or something only the desktop can do.
///
/// Every action goes through the router first, commands included. A phone
/// retries on reconnect, and `pty_spawn_detached` replayed is a second agent
/// nobody asked for.
fn act(v: &Value, p: &Portal, out: &mpsc::Sender<String>) {
    let (Some(id), Some(action)) = (
        v.get("id").and_then(|x| x.as_str()),
        v.get("action").and_then(|x| x.as_str()),
    ) else {
        return;
    };
    let (id, action) = (id.to_string(), action.to_string());
    let args = v.get("args").cloned().unwrap_or(Value::Null);
    let app = p.app.clone();
    let router = p.verbs.clone();
    let out = out.clone();

    tokio::spawn(async move {
        // A dotted name is a desktop-executed verb. None are registered yet —
        // every module shipped so far is backed by state Rust already holds —
        // so today this can only be an unknown action, and the hop to the
        // desktop lands with the first verb that needs it.
        let guard = if action.contains('.') {
            match crate::remote::verbs::lookup(&action) {
                Some(verb) => verb.guard,
                None => {
                    let _ = out
                        .send(ack_err(&id, format!("no such action: {action}")))
                        .await;
                    return;
                }
            }
        } else {
            crate::remote::guard_of(&action)
        };

        match router.begin(&action, guard, &id) {
            Begin::Replay(Answer::Ok) => {
                let _ = out.send(ack_ok(&id)).await;
                return;
            }
            Begin::Replay(Answer::Err(why)) | Begin::Refused(why) => {
                let _ = out.send(ack_err(&id, why)).await;
                return;
            }
            Begin::Run => {}
        }

        let result = crate::remote::dispatch(&app, &action, &args, TOKEN_SCOPE).await;
        let msg = match &result {
            Ok(value) => {
                router.finish(&id, Answer::Ok);
                json!({ "t": "act-ack", "id": id, "ok": true, "result": value }).to_string()
            }
            Err(why) => {
                router.finish(&id, Answer::Err(why.clone()));
                ack_err(&id, why.clone())
            }
        };
        let _ = out.send(msg).await;
    });
}

fn ack_ok(id: &str) -> String {
    json!({ "t": "act-ack", "id": id, "ok": true }).to_string()
}

fn ack_err(id: &str, error: String) -> String {
    json!({ "t": "act-ack", "id": id, "ok": false, "error": error }).to_string()
}

/// Stream one PTY's output to the socket: a catch-up snapshot, then the live
/// tail. On broadcast lag we re-attach for a fresh snapshot rather than let the
/// terminal render torn output.
async fn stream_pty(app: AppHandle, id: u32, out: mpsc::Sender<String>) {
    loop {
        // Through the stream registry rather than PtyManager directly, so `pty`
        // is one provider among the kinds a future module can add rather than a
        // special case the socket knows about.
        let Ok(attached) = crate::remote::streams::attach(&app, "pty", &id.to_string()) else {
            let _ = out
                .send(json!({ "t": "pty-gone", "pty": id }).to_string())
                .await;
            return;
        };
        let crate::remote::streams::Attached {
            cols,
            rows,
            snapshot,
            mut rx,
        } = attached;
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

/// How long an agent session that is no longer running stays interesting.
///
/// The same 30 minutes the Agents panel uses for shared context — past it a
/// digest is history, and history belongs behind a deliberate tap, not in the
/// list that reloads every four seconds.
fn recent_secs() -> i64 {
    crate::agent_life::policy().peer_max_age_secs as i64
}

/// Prompts kept per offline session. The history view wants the thread, not the
/// transcript, and this is the difference between a 230KB snapshot and a 20KB
/// one.
const MAX_PROMPTS: usize = 12;
/// Files kept per offline session, for the "files touched" list.
const MAX_FILES: usize = 40;

/// Projects + agent sessions + usage + live PTYs + theme. `ptys` is the scoped
/// subset of PtyManager's authoritative live set, so the client knows which of
/// this checkout's agents are attachable without waiting on the pty:stats event.
///
/// Scoped, deliberately. `session_digests(None)` walks every hook record on the
/// machine *and* every conversation in every CLI's own store — on a working
/// machine that is hundreds of sessions from dozens of checkouts, and it was
/// being re-sent whole every four seconds to a phone. The remote deliberately
/// differs from ProjectView here: the desktop relates agents to every worktree,
/// while this list is about the checkouts explicitly open in the IDE. Other
/// worktrees are boundaries, not roots, so their sessions do not swamp Recent.
async fn snapshot_msg(
    app: &AppHandle,
    theme: Option<Value>,
    clis: Value,
    companion: Value,
    roots_cache: &RootsCache,
) -> String {
    let projects = crate::fsx::store_load()
        .await
        .unwrap_or_else(|_| "null".into());
    let projects: Value = serde_json::from_str(&projects).unwrap_or(Value::Null);
    let scope = cached_scope(app, &projects, roots_cache).await;
    let sessions = crate::agents::session_digests(Some(scope.roots.clone()))
        .await
        .unwrap_or_default();
    let usage = crate::agents::agent_usage().await.unwrap_or_default();
    let ptys = app
        .state::<PtyManager>()
        .summaries()
        .into_iter()
        .filter(|pty| in_scope(Some(&pty.cwd), &scope.roots, &scope.other_worktrees))
        .collect::<Vec<_>>();
    let live_ids: std::collections::HashSet<u32> = ptys.iter().map(|p| p.id).collect();
    let sessions = scope_sessions(
        sessions,
        &scope.roots,
        &scope.other_worktrees,
        now_secs(),
        &live_ids,
        crate::pty::instance_token(),
    );
    let (hibernated, attention) = {
        let mgr = app.state::<RemoteManager>();
        let h = mgr.hibernated.lock().unwrap().clone();
        let a = mgr.attention.lock().unwrap().clone();
        (h, a)
    };
    json!({
        "t": "snapshot",
        "projects": projects,
        "sessions": sessions,
        "usage": usage,
        "ptys": ptys,
        "roots": scope.roots,
        "instance": crate::pty::instance_token(),
        "theme": theme,
        "clis": clis,
        "companion": companion,
        "hibernated": hibernated,
        "attention": attention,
    })
    .to_string()
}

/// Full resumable history for roots the browser selected, scoped on the host
/// before prompts, paths or profile metadata cross the socket.
pub async fn remote_session_digests(
    app: &AppHandle,
    requested: Vec<String>,
) -> Result<Vec<Value>, String> {
    let projects = crate::fsx::store_load().await?;
    let projects: Value = serde_json::from_str(&projects).unwrap_or(Value::Null);
    let scope = open_scope(app, &projects).await;
    let roots = scope
        .roots
        .iter()
        .filter(|root| requested.iter().any(|wanted| wanted == *root))
        .cloned()
        .collect::<Vec<_>>();
    if roots.is_empty() && !requested.is_empty() {
        return Err("requested session roots are not open in Canopy".into());
    }
    let sessions = crate::agents::session_digests(Some(roots.clone())).await?;
    let exclusions = worktree_exclusions(app, &roots);
    Ok(sessions
        .into_iter()
        .filter(|digest| digest_in_scope(digest, &roots, &exclusions))
        .map(trim_digest)
        .collect())
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The directories the IDE currently has open, cached for `ROOTS_TTL`.
///
/// The uncached version costs a git process per worktree, and the snapshot that
/// wants it runs every four seconds per client. On a checkout with 66 worktrees
/// that measured 3.4 seconds of git per refresh — which does not merely waste
/// CPU, it starves every panel request queued behind it, so opening a file read
/// as "the network is slow" when the network was idle.
async fn cached_scope(app: &AppHandle, store: &Value, cache: &RootsCache) -> SessionScope {
    {
        let guard = cache.lock().unwrap();
        if let Some((at, scope)) = guard.as_ref() {
            if at.elapsed() < ROOTS_TTL {
                return scope.clone();
            }
        }
    }
    let scope = open_scope(app, store).await;
    *cache.lock().unwrap() = Some((std::time::Instant::now(), scope.clone()));
    scope
}

/// The directories the IDE currently has open, plus the other worktrees that
/// must be excluded even when they are nested below one of those directories.
///
/// `openIds` is the IDE's own tab list. When the store predates it (or nothing
/// is open) we fall back to every registered project rather than sending an
/// empty list, because an empty scope reads to the phone as "you have nothing",
/// which is a worse lie than a slightly wide one.
async fn open_scope(app: &AppHandle, store: &Value) -> SessionScope {
    let projects = store.get("projects").and_then(|p| p.as_array());
    let Some(projects) = projects else {
        return SessionScope::default();
    };
    let open: Option<HashSet<&str>> = store
        .get("openIds")
        .and_then(|v| v.as_array())
        .map(|ids| ids.iter().filter_map(|v| v.as_str()).collect())
        .filter(|s: &HashSet<&str>| !s.is_empty());
    // A hibernating project keeps its IDE tab (so it stays in `openIds`) but
    // nothing in it is running; its roots must not widen the portal's scope.
    let asleep: HashSet<String> = app
        .state::<RemoteManager>()
        .hibernated
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .collect();

    let mut roots: Vec<String> = Vec::new();
    for p in projects {
        if let Some(id) = p.get("id").and_then(|v| v.as_str()) {
            if asleep.contains(id) {
                continue;
            }
        }
        if let (Some(open), Some(id)) = (&open, p.get("id").and_then(|v| v.as_str())) {
            if !open.contains(id) {
                continue;
            }
        }
        for c in p
            .get("components")
            .and_then(|c| c.as_array())
            .into_iter()
            .flatten()
        {
            if let Some(path) = c.get("path").and_then(|v| v.as_str()) {
                roots.push(path.to_string());
            }
        }
    }

    roots.sort();
    roots.dedup();

    // Discover worktrees as exclusion boundaries. A worktree explicitly opened
    // as a component remains in scope; every sibling or nested worktree belongs
    // to a different checkout and must not lengthen this project's Recent list.
    //
    // `scan_worktrees`, NOT `git_worktrees`: the latter also counts uncommitted
    // files, which is a `git status` per worktree. Scoping needs the paths and
    // nothing else, and git.rs says so at the top of `list_worktrees` — "anything
    // that only needs to know *which* worktree holds a branch calls
    // scan_worktrees instead". This is one of those callers.
    let other_worktrees = worktree_exclusions(app, &roots);
    SessionScope {
        roots,
        other_worktrees,
    }
}

fn worktree_exclusions(app: &AppHandle, roots: &[String]) -> Vec<String> {
    let mut other_worktrees: Vec<String> = Vec::new();
    let state = app.state::<crate::fsx::WorkspaceManager>();
    for root in roots {
        let Ok(top) = crate::fsx::check_scope(&state, std::path::Path::new(root)) else {
            continue;
        };
        if let Ok(trees) = crate::git::scan_worktrees(&top) {
            other_worktrees.extend(
                trees
                    .into_iter()
                    .map(|t| t.path)
                    .filter(|tree| is_other_worktree(tree, &roots)),
            );
        }
    }
    other_worktrees.sort();
    other_worktrees.dedup();
    other_worktrees
}

/// Keep the sessions that belong to `roots`, drop the ones that stopped being
/// interesting, and trim what survives to the fields a list row and a history
/// view actually read.
fn scope_sessions(
    sessions: Vec<Value>,
    roots: &[String],
    other_worktrees: &[String],
    now: i64,
    live_ptys: &std::collections::HashSet<u32>,
    instance: &str,
) -> Vec<Value> {
    sessions
        .into_iter()
        .filter(|d| digest_in_scope(d, roots, other_worktrees))
        .filter(|d| {
            // The desktop's rule, applied at the source: a session is *running*
            // iff this app instance's terminal for it is still alive, and only
            // running sessions escape the recency clock. Everything else —
            // finished turns, rows rebuilt from a CLI's own store (which record
            // no lifecycle at all and used to sit in Recent forever), digests
            // whose terminal died without a Stop — is history after 30 minutes,
            // and history belongs behind the deliberate history tap, not in a
            // list resent every four seconds.
            let updated = d.get("updated").and_then(|v| v.as_i64()).unwrap_or(0);
            attached_to_live_pty(d, live_ptys, instance) || now - updated <= recent_secs()
        })
        .map(trim_digest)
        .collect()
}

/// Whether a digest's recorded terminal is one of this instance's live PTYs —
/// the same surface-id-within-this-instance identity the desktop's
/// `digestBySurface` uses. A digest from a previous app run may reuse a
/// current pty id, so the instance token must match too; store-read rows carry
/// neither field and are never "live".
fn attached_to_live_pty(
    d: &Value,
    live_ptys: &std::collections::HashSet<u32>,
    instance: &str,
) -> bool {
    if d.get("instance").and_then(|v| v.as_str()) != Some(instance) {
        return false;
    }
    let surface = match d.get("surface") {
        Some(Value::String(s)) => s.parse::<u32>().ok(),
        Some(Value::Number(n)) => n.as_u64().map(|n| n as u32),
        _ => None,
    };
    surface.is_some_and(|id| live_ptys.contains(&id))
}

/// Path containment with a separator boundary, not a plain string prefix.
fn path_within(path: &str, root: &str) -> bool {
    let path = path.trim_end_matches('/');
    let root = root.trim_end_matches('/');
    path == root || path.starts_with(&format!("{root}/"))
}

fn within(cwd: Option<&str>, roots: &[String]) -> bool {
    let Some(cwd) = cwd else {
        return false;
    };
    roots.iter().any(|root| path_within(cwd, root))
}

fn in_scope(cwd: Option<&str>, roots: &[String], other_worktrees: &[String]) -> bool {
    within(cwd, roots) && !within(cwd, other_worktrees)
}

fn digest_in_scope(digest: &Value, roots: &[String], other_worktrees: &[String]) -> bool {
    ["resume_cwd", "launch_cwd", "cwd"].iter().any(|key| {
        in_scope(
            digest.get(key).and_then(|v| v.as_str()),
            roots,
            other_worktrees,
        )
    })
}

fn is_other_worktree(tree: &str, roots: &[String]) -> bool {
    !roots.iter().any(|root| path_within(root, tree))
}

fn trim_digest(mut d: Value) -> Value {
    if let Some(map) = d.as_object_mut() {
        // Keep the *last* N: a conversation's tail is what identifies it, and
        // the history view reads it newest-last.
        for (key, max) in [("prompts", MAX_PROMPTS), ("files", MAX_FILES)] {
            if let Some(arr) = map.get_mut(key).and_then(|v| v.as_array_mut()) {
                if arr.len() > max {
                    let drop = arr.len() - max;
                    arr.drain(0..drop);
                }
            }
        }
    }
    d
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

    fn digest(cwd: &str, state: &str, updated: i64) -> Value {
        json!({ "cwd": cwd, "state": state, "updated": updated, "agent": "claude" })
    }

    #[test]
    fn within_matches_a_root_and_anything_under_it() {
        let roots = vec!["/w/canopy".to_string()];
        assert!(within(Some("/w/canopy"), &roots));
        assert!(within(Some("/w/canopy/"), &roots));
        assert!(within(Some("/w/canopy/src-tauri"), &roots));
        // A sibling whose name merely starts the same is NOT inside it.
        assert!(!within(Some("/w/canopy-website"), &roots));
        assert!(!within(Some("/w/other"), &roots));
        assert!(!within(None, &roots));
    }

    #[test]
    fn checkout_scope_subtracts_nested_worktrees() {
        let roots = vec!["/w/canopy".to_string()];
        let others = vec!["/w/canopy/.claude/worktrees/x".to_string()];
        assert!(in_scope(Some("/w/canopy/src"), &roots, &others));
        assert!(!in_scope(
            Some("/w/canopy/.claude/worktrees/x/src"),
            &roots,
            &others,
        ));
    }

    #[test]
    fn worktree_boundaries_keep_only_explicitly_open_checkouts() {
        let main = vec!["/w/canopy".to_string()];
        let nested = vec!["/w/canopy/.claude/worktrees/x".to_string()];
        // A nested worktree is a boundary below the open main checkout.
        assert!(is_other_worktree("/w/canopy/.claude/worktrees/x", &main,));
        // The same worktree is not a boundary when it is the open checkout.
        assert!(!is_other_worktree("/w/canopy/.claude/worktrees/x", &nested,));
        // An ancestor cannot pass the narrower inclusion root, so needs no boundary.
        assert!(!is_other_worktree("/w/canopy", &nested));
    }

    fn no_live() -> std::collections::HashSet<u32> {
        Default::default()
    }

    #[test]
    fn scope_keeps_only_the_open_checkout() {
        let roots = vec!["/w/canopy".into()];
        let other_worktrees = vec![
            "/w/canopy/.claude/worktrees/x".into(),
            "/w/canopy-feature".into(),
        ];
        let now = 1_000_000;
        let out = scope_sessions(
            vec![
                digest("/w/canopy", "working", now),
                digest("/w/canopy/.claude/worktrees/x", "idle", now),
                digest("/w/canopy-feature", "working", now),
                digest("/w/some-other-repo", "working", now),
            ],
            &roots,
            &other_worktrees,
            now,
            &no_live(),
            "inst",
        );
        assert_eq!(out.len(), 1, "other worktrees must not travel");
        assert_eq!(out[0]["cwd"], "/w/canopy");
    }

    #[test]
    fn scope_keeps_a_worktree_when_it_is_the_open_component() {
        let roots = vec!["/w/canopy/.claude/worktrees/x".into()];
        let other_worktrees = vec!["/w/canopy/.claude/worktrees/y".into()];
        let now = 1_000_000;
        let out = scope_sessions(
            vec![
                digest("/w/canopy/.claude/worktrees/x", "working", now),
                digest("/w/canopy/.claude/worktrees/y", "working", now),
            ],
            &roots,
            &other_worktrees,
            now,
            &no_live(),
            "inst",
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["cwd"], roots[0]);
    }

    #[test]
    fn scope_checks_every_directory_a_session_names() {
        let roots = vec!["/w/canopy".into()];
        let other_worktrees = vec!["/w/canopy/.claude/worktrees/x".into()];
        let now = 1_000_000;
        for key in ["resume_cwd", "launch_cwd", "cwd"] {
            let mut moved = json!({
                "cwd": "/w/canopy/.claude/worktrees/x",
                "state": "working",
                "updated": now,
                "agent": "claude",
            });
            moved[key] = json!("/w/canopy");
            let out = scope_sessions(
                vec![moved],
                &roots,
                &other_worktrees,
                now,
                &no_live(),
                "inst",
            );
            assert_eq!(out.len(), 1, "{key} should retain the session");
        }
    }

    #[test]
    fn scope_ages_out_everything_but_sessions_in_a_live_terminal() {
        let roots = vec!["/w/canopy".into()];
        let now = 1_000_000;
        let stale = now - recent_secs() - 1;
        let live: std::collections::HashSet<u32> = [7u32].into_iter().collect();
        // A stale digest whose terminal is one of this instance's live PTYs is
        // running — it must survive however old its last hook event is.
        let mut attached = digest("/w/canopy", "working", stale);
        attached["surface"] = json!("7");
        attached["instance"] = json!("inst");
        // Same surface id, previous app run: the id collides, the session is
        // not attachable, and it must age out like any other history.
        let mut prior_run = digest("/w/canopy", "working", stale);
        prior_run["surface"] = json!("7");
        prior_run["instance"] = json!("older-inst");
        let out = scope_sessions(
            vec![
                digest("/w/canopy", "ended", stale),
                digest("/w/canopy", "ended", now - 60),
                // A digest whose terminal died without a Stop stays "working"
                // on disk forever — and a row rebuilt from a CLI's own store
                // records no lifecycle at all. Neither is running; both are
                // history once the recency window passes. This is what kept
                // every session ever run in the Recent list.
                digest("/w/canopy", "working", stale),
                attached,
                prior_run,
            ],
            &roots,
            &[],
            now,
            &live,
            "inst",
        );
        assert_eq!(out.len(), 2);
        assert!(out.iter().any(|d| d["instance"] == "inst"));
        assert!(out
            .iter()
            .any(|d| d["state"] == "ended" && d["updated"].as_i64().unwrap() == now - 60));
    }

    /// The snapshot runs every four seconds per connected client, so nothing in
    /// its path may cost a process per worktree.
    ///
    /// `git_worktrees` does exactly that — it counts uncommitted files, one
    /// `git status` each — and using it here measured 3.4s of git per refresh on
    /// a 66-worktree checkout. The symptom was not "the server is busy", it was
    /// every panel request queuing behind the churn, which reads as a slow
    /// network. Scoping needs paths only: `scan_worktrees` is one git process
    /// for the whole repo.
    #[test]
    fn the_snapshot_path_never_counts_dirty_worktrees() {
        let src = include_str!("portal.rs");
        let body = src.split("#[cfg(test)]").next().unwrap();
        // The call, not the word — the comment above the call site names it on
        // purpose, to say why it is the wrong one.
        assert!(
            !body.contains("git::git_worktrees("),
            "portal.rs must call scan_worktrees, not git_worktrees — the dirty \
             count is a git process per worktree on a 4-second poll"
        );
        assert!(body.contains("git::scan_worktrees("));
    }

    #[test]
    fn trim_keeps_the_tail_of_a_long_conversation() {
        let prompts: Vec<Value> = (0..40).map(|i| json!(format!("p{i}"))).collect();
        let trimmed = trim_digest(json!({ "prompts": prompts, "files": [] }));
        let out = trimmed["prompts"].as_array().unwrap();
        assert_eq!(out.len(), MAX_PROMPTS);
        assert_eq!(out.last().unwrap(), "p39", "the newest prompt must survive");
    }
}

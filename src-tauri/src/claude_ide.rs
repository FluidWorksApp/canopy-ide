//! Claude Code's own IDE protocol, served by Canopy.
//!
//! `claude` running in a VS Code or JetBrains terminal finds its editor through
//! a lock file and talks to it over a loopback WebSocket: the editor shows each
//! proposed edit as a diff the user can accept, tweak or reject; it feeds the
//! CLI the user's selection; it answers "what errors does this file have" from
//! the language server it keeps warm. This module is that editor end, so a
//! Claude agent tab in Canopy behaves like one in an IDE — without Canopy
//! pretending to be VS Code.
//!
//! The wire contract is the one verified against Claude Code 2.1.310 by capture
//! (research_notes/Harness capability parity matrix/claude_ide_protocol_capture.md,
//! §10). The points that are easy to get wrong, and why:
//!
//!   - One server per agent PTY, its port handed to the PTY as
//!     `CLAUDE_CODE_SSE_PORT`. That variable alone turns auto-connect on, pins
//!     the CLI to *this* server even when several Canopy locks match its cwd,
//!     and skips the VS Code ancestor-pid rule — so `TERM_PROGRAM` is never
//!     spoofed.
//!   - The lock goes into the `CLAUDE_CONFIG_DIR` the PTY actually gets, which
//!     Canopy sets per CLI profile. A lock in the wrong directory is a server
//!     nobody finds.
//!   - The upgrade must echo `Sec-WebSocket-Protocol: mcp`, or the CLI drops
//!     the socket before `initialize`.
//!   - `openDiff` blocks with no timeout and `close_tab` arrives on the same
//!     socket while it is pending (the user answered in the terminal), so tool
//!     calls run as their own tasks and never block the read loop.
//!   - A rejected diff is `DIFF_REJECTED`. `TAB_CLOSED` as an openDiff reply
//!     means "accept as proposed" to the CLI, so it is never sent for one.
//!   - The token and port live as long as the PTY. After a drop the CLI
//!     reconnects only with the token it cached, within about fifteen seconds,
//!     so the listener outlives any one socket.
//!
//! The core is independent of Tauri: everything the running UI has to do —
//! show a diff, read diagnostics off Monaco — goes out through [`IdeUi`], and
//! the answers come back through [`ClaudeIde::resolve_diff`] and
//! [`ClaudeIde::reply`]. That keeps the protocol testable against a real
//! WebSocket client (and the real `claude`) without a window.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, watch};

/// The env marker a launch uses to ask for a server. Set by the frontend only
/// for an interactive Claude Code tab with the setting on (see claudeIde.ts);
/// its value is the component root that goes into the lock's
/// `workspaceFolders`. Consumed by `pty::spawn_bound` and never reaches the
/// child, like the omp overlay marker beside it.
pub const LAUNCH_MARKER: &str = "CANOPY_CLAUDE_IDE";

const AUTH_HEADER: &str = "x-claude-code-ide-authorization";
/// What `/ide`, the selection echo and "Opened changes in …" call us.
const IDE_NAME: &str = "Canopy";
/// Anything but "Claude Code JetBrains Plugin", which makes the CLI skip the
/// diagnostics baseline.
const SERVER_NAME: &str = "canopy";
/// The CLI gives a `{uri}` baseline 500 ms and a `{}` fetch 2 s, and turns
/// baselines off for the session after three timeouts. Answering `[]` a little
/// early is better than answering correctly too late.
const URI_DIAGNOSTICS_DEADLINE: Duration = Duration::from_millis(400);
const ALL_DIAGNOSTICS_DEADLINE: Duration = Duration::from_millis(1600);

/// Something the running UI has to act on. Emitted as one `claude-ide` event
/// whose `kind` names the variant.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UiEvent {
    /// Show a proposed edit with Accept / Reject. Answered by `resolve_diff`.
    #[serde(rename_all = "camelCase")]
    Diff {
        pty_id: u32,
        tab_name: String,
        path: String,
        contents: String,
    },
    /// The CLI is done with this diff (answered in the terminal, or already
    /// resolved here). Close its view without answering.
    #[serde(rename_all = "camelCase")]
    DiffClosed { pty_id: u32, tab_name: String },
    /// Every diff this session had open is gone: closeAllDiffTabs, the socket
    /// dropping, or the terminal ending.
    #[serde(rename_all = "camelCase")]
    DiffsCleared { pty_id: u32 },
    /// Read the language server's diagnostics. Answered by `reply(request_id)`
    /// with `[{uri, diagnostics}]`; `uri` absent means every open file.
    #[serde(rename_all = "camelCase")]
    Diagnostics {
        request_id: u64,
        pty_id: u32,
        root: String,
        uri: Option<String>,
    },
    /// Whether a CLI is attached to this terminal's server, for the tab badge
    /// and for knowing where a selection is worth sending.
    #[serde(rename_all = "camelCase")]
    Connection {
        pty_id: u32,
        root: String,
        connected: bool,
    },
}

/// The UI end of the protocol: the Tauri event bus in the app, a recorder in
/// tests, a scripted responder in the live harness.
pub trait IdeUi: Send + Sync + 'static {
    fn emit(&self, event: UiEvent);
    /// Every frame on the wire, for the live harness's log. Off in the app.
    fn frame(&self, _pty_id: u32, _inbound: bool, _text: &str) {}
}

/// Production [`IdeUi`]: one `claude-ide` event the App-level listener routes.
pub struct TauriUi<R: tauri::Runtime>(pub tauri::AppHandle<R>);

impl<R: tauri::Runtime> IdeUi for TauriUi<R> {
    fn emit(&self, event: UiEvent) {
        use tauri::Emitter;
        let _ = self.0.emit("claude-ide", event);
    }
}

/// The user's answer to a diff.
#[derive(Debug, Clone, PartialEq)]
pub enum DiffVerdict {
    /// Write these contents — the proposal, or the user's edit of it.
    Accept(String),
    Reject,
}

/// What a launch needs to put in the PTY's environment.
#[derive(Debug, Clone)]
pub struct Launch {
    pub port: u16,
    /// The lock's token. The CLI reads it from the lock, so only the tests
    /// (playing the CLI) need it handed back.
    #[cfg_attr(not(test), allow(dead_code))]
    pub token: String,
}

impl Launch {
    /// The variables that point the CLI at this server. `SSE_PORT` is a
    /// misleading name kept from the old transport: it only selects which lock
    /// to use, and the lock says "ws". Auto-install is skipped because there is
    /// no extension to install: Canopy is the IDE.
    pub fn env(&self) -> [(&'static str, String); 2] {
        [
            ("CLAUDE_CODE_SSE_PORT", self.port.to_string()),
            ("CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL", "1".to_string()),
        ]
    }
}

struct Session {
    pty_id: u32,
    token: String,
    /// The component root written into the lock, and the scope a selection is
    /// routed by.
    root: String,
    lock_path: PathBuf,
    shutdown: watch::Sender<bool>,
    /// Outbound frame queues of the sockets currently attached. Normally one;
    /// briefly two while a reconnect overlaps the old socket's teardown.
    clients: Mutex<HashMap<u64, mpsc::UnboundedSender<String>>>,
    /// Pending openDiff calls by tab_name, which is how the CLI names them in
    /// close_tab.
    diffs: Mutex<HashMap<String, oneshot::Sender<DiffVerdict>>>,
}

impl Session {
    fn connected(&self) -> bool {
        !self.clients.lock().unwrap().is_empty()
    }

    fn send(&self, frame: &Value) {
        let text = frame.to_string();
        for tx in self.clients.lock().unwrap().values() {
            let _ = tx.send(text.clone());
        }
    }

    /// Forget every pending diff. Their openDiff calls are never answered: the
    /// CLI that asked has either moved on (close_tab) or gone (socket closed).
    fn drop_diffs(&self) -> usize {
        let mut diffs = self.diffs.lock().unwrap();
        let n = diffs.len();
        diffs.clear();
        n
    }
}

struct Hub {
    ui: Arc<dyn IdeUi>,
    sessions: Mutex<HashMap<u32, Arc<Session>>>,
    /// UI round trips in flight (diagnostics), by request id.
    requests: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
}

/// Every Claude Code IDE server this app is running, one per agent PTY.
#[derive(Clone)]
pub struct ClaudeIde {
    hub: Arc<Hub>,
}

impl ClaudeIde {
    pub fn new(ui: Arc<dyn IdeUi>) -> Self {
        Self {
            hub: Arc::new(Hub {
                ui,
                sessions: Mutex::new(HashMap::new()),
                requests: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(1),
            }),
        }
    }

    /// Bind a server for one PTY and write its lock.
    ///
    /// Synchronous on purpose: the port has to be in the child's environment
    /// before it starts, and `spawn_bound` is not async. The returned future
    /// is the server; the caller spawns it on whichever runtime it has. `pid`
    /// goes into the lock and must stay alive as long as the server — any
    /// `claude` deletes a lock whose pid is dead — so the app passes its own.
    pub fn open(
        &self,
        pty_id: u32,
        root: &str,
        lock_dir: &Path,
        pid: u32,
    ) -> Result<(Launch, impl Future<Output = ()> + Send + 'static), String> {
        // A PTY id is never reused within a run, but a stale server under it
        // would leave a lock pointing at a port nobody answers.
        self.close(pty_id);
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("claude ide: cannot bind: {e}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|e| format!("claude ide: {e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("claude ide: {e}"))?
            .port();
        let token = random_token()?;
        let lock = LockFile {
            pid,
            workspace_folders: vec![root.to_string()],
            ide_name: IDE_NAME,
            transport: "ws",
            auth_token: token.clone(),
        };
        let lock_path = write_lock(lock_dir, port, &lock).map_err(|e| {
            format!(
                "claude ide: cannot write lock in {}: {e}",
                lock_dir.display()
            )
        })?;
        let (shutdown, mut stopped) = watch::channel(false);
        let session = Arc::new(Session {
            pty_id,
            token: token.clone(),
            root: root.to_string(),
            lock_path,
            shutdown,
            clients: Mutex::new(HashMap::new()),
            diffs: Mutex::new(HashMap::new()),
        });
        self.hub
            .sessions
            .lock()
            .unwrap()
            .insert(pty_id, session.clone());
        let hub = self.hub.clone();
        let serve = async move {
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(l) => l,
                Err(e) => {
                    log::warn!("claude ide: listener for pty {pty_id}: {e}");
                    return;
                }
            };
            let router = Router::new()
                .route("/", get(upgrade))
                .with_state((hub, session));
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = stopped.wait_for(|stop| *stop).await;
                })
                .await;
        };
        Ok((Launch { port, token }, serve))
    }

    /// Stop one PTY's server: close its sockets, delete its lock, and tell the
    /// UI its diffs are gone. Idempotent — the reaper and app exit can both
    /// get here.
    pub fn close(&self, pty_id: u32) {
        let Some(session) = self.hub.sessions.lock().unwrap().remove(&pty_id) else {
            return;
        };
        let _ = session.shutdown.send(true);
        let _ = std::fs::remove_file(&session.lock_path);
        if session.drop_diffs() > 0 {
            self.hub.ui.emit(UiEvent::DiffsCleared { pty_id });
        }
        if session.connected() {
            self.hub.ui.emit(UiEvent::Connection {
                pty_id,
                root: session.root.clone(),
                connected: false,
            });
        }
    }

    /// App exit: no lock may outlive the process whose pid it names.
    pub fn close_all(&self) {
        let ids: Vec<u32> = self.hub.sessions.lock().unwrap().keys().copied().collect();
        for id in ids {
            self.close(id);
        }
    }

    /// The user answered a diff in Canopy. `Err` when it is no longer pending —
    /// answered in the terminal first, which is the race this protocol has by
    /// design, so the caller just closes its view.
    pub fn resolve_diff(
        &self,
        pty_id: u32,
        tab_name: &str,
        verdict: DiffVerdict,
    ) -> Result<(), String> {
        let session = self
            .session(pty_id)
            .ok_or("this terminal has no Claude Code connection")?;
        let pending = session.diffs.lock().unwrap().remove(tab_name);
        let Some(tx) = pending else {
            return Err("Claude Code is no longer waiting on this change".into());
        };
        tx.send(verdict)
            .map_err(|_| "Claude Code is no longer waiting on this change".to_string())
    }

    /// The UI's answer to a round trip (diagnostics). A late answer, after the
    /// deadline, finds nothing and is dropped.
    pub fn reply(&self, request_id: u64, data: Value) {
        if let Some(tx) = self.hub.requests.lock().unwrap().remove(&request_id) {
            let _ = tx.send(data);
        }
    }

    /// Fan a selection out to the Claude sessions working on the file.
    ///
    /// Every connected session whose component contains the file gets it, and
    /// when components nest only the innermost one counts. All of them rather
    /// than the focused one: the CLI only shows the selection in its footer
    /// and attaches it to whatever the user submits next in *that* terminal,
    /// so a session the user is not typing into is untouched by it — while
    /// guessing one would leave the terminal the user then switches to with a
    /// stale selection. Returns how many sessions it reached.
    pub fn notify_selection(&self, path: &str, params: Value) -> usize {
        let targets = self.sessions_for(path);
        let frame = json!({"jsonrpc": "2.0", "method": "selection_changed", "params": params});
        for session in &targets {
            session.send(&frame);
        }
        targets.len()
    }

    /// Put `@file#Lx-y` into one Claude prompt.
    ///
    /// Exactly one session, unlike a selection: this types into the prompt box,
    /// and the same mention landing in three prompts is three things to clean
    /// up. `prefer` (the terminal the user has in front of them) wins when it
    /// is a connected session on this file; otherwise the session the user most
    /// recently typed into, by `last_input_ms`. Returns the PTY it went to so
    /// the UI can bring that terminal forward.
    pub fn at_mention(
        &self,
        path: &str,
        line_start: Option<u32>,
        line_end: Option<u32>,
        prefer: Option<u32>,
        last_input_ms: impl Fn(u32) -> u64,
    ) -> Result<u32, String> {
        let targets = self.sessions_for(path);
        let session = targets
            .iter()
            .find(|s| Some(s.pty_id) == prefer)
            .or_else(|| targets.iter().max_by_key(|s| last_input_ms(s.pty_id)))
            .ok_or("No Claude Code session in this component is connected to Canopy")?;
        let mut params = json!({"filePath": path});
        if let (Some(start), Some(end)) = (line_start, line_end) {
            params["lineStart"] = start.into();
            params["lineEnd"] = end.into();
        }
        session.send(&json!({"jsonrpc": "2.0", "method": "at_mentioned", "params": params}));
        Ok(session.pty_id)
    }

    /// The terminals with a CLI attached right now, and the folder each
    /// serves. The UI learns this from `Connection` events; a reloaded window
    /// missed them, and asks.
    pub fn connections(&self) -> Vec<(u32, String)> {
        self.hub
            .sessions
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.connected())
            .map(|s| (s.pty_id, s.root.clone()))
            .collect()
    }

    fn session(&self, pty_id: u32) -> Option<Arc<Session>> {
        self.hub.sessions.lock().unwrap().get(&pty_id).cloned()
    }

    /// Connected sessions whose root is the innermost component containing
    /// `path`.
    fn sessions_for(&self, path: &str) -> Vec<Arc<Session>> {
        let sessions = self.hub.sessions.lock().unwrap();
        let containing: Vec<Arc<Session>> = sessions
            .values()
            .filter(|s| s.connected() && path_within(path, &s.root))
            .cloned()
            .collect();
        let deepest = containing
            .iter()
            .map(|s| s.root.trim_end_matches('/').len())
            .max();
        containing
            .into_iter()
            .filter(|s| Some(s.root.trim_end_matches('/').len()) == deepest)
            .collect()
    }
}

/// `path` is `root` or inside it, by whole path segments.
fn path_within(path: &str, root: &str) -> bool {
    let root = root.trim_end_matches(['/', '\\']);
    if root.is_empty() {
        return false;
    }
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/') || rest.starts_with('\\'))
}

// ---- lock file ---------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LockFile {
    pid: u32,
    workspace_folders: Vec<String>,
    ide_name: &'static str,
    transport: &'static str,
    auth_token: String,
}

/// Where the CLI in this PTY will look for locks: `$CLAUDE_CONFIG_DIR/ide`,
/// with the PTY's effective `CLAUDE_CONFIG_DIR` — the launch's own if it set
/// one (a named profile), else the inherited one unless the spawn is about to
/// clear it as another profile's, else `~/.claude`.
pub fn lock_dir(
    explicit: Option<&str>,
    inherited: Option<String>,
    inherited_cleared: bool,
    home: Option<&str>,
) -> Option<PathBuf> {
    let config = explicit
        .map(str::to_string)
        .or(if inherited_cleared { None } else { inherited })
        .filter(|dir| !dir.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| home.map(|h| Path::new(h).join(".claude")))?;
    Some(config.join("ide"))
}

/// Write `<dir>/<port>.lock` atomically: a private temp file renamed into
/// place, so a CLI scanning the directory never parses half a lock (it would
/// read it as the legacy newline format, or delete it as unreadable). The
/// directory is created 0700 and the file is 0600 — the token in it is the
/// only thing between any local process and the user's editor. An existing
/// directory is left as it is: other IDEs share it.
fn write_lock(dir: &Path, port: u16, lock: &LockFile) -> std::io::Result<PathBuf> {
    use std::io::Write;
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir)?;
    let path = dir.join(format!("{port}.lock"));
    let tmp = dir.join(format!(".{port}.lock.{}.tmp", std::process::id()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&tmp)?;
        file.write_all(&serde_json::to_vec(lock)?)?;
        file.sync_all()?;
        std::fs::rename(&tmp, &path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map(|()| path)
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("claude ide: no randomness: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

// ---- transport ---------------------------------------------------------------

type ServerState = (Arc<Hub>, Arc<Session>);

/// The one route. The token is checked before the upgrade, so a wrong one is a
/// plain 401 and never a socket; `mcp` is the subprotocol the CLI insists on.
async fn upgrade(
    State((hub, session)): State<ServerState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let presented = headers
        .get(AUTH_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !crate::context::constant_time_eq(presented, &session.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    ws.protocols(["mcp"])
        .on_upgrade(move |socket| connection(hub, session, socket))
}

async fn connection(hub: Arc<Hub>, session: Arc<Session>, socket: WebSocket) {
    let conn = hub.next_id.fetch_add(1, Ordering::Relaxed);
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    session.clients.lock().unwrap().insert(conn, tx.clone());
    let pty_id = session.pty_id;
    let writer_hub = hub.clone();
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            writer_hub.ui.frame(pty_id, false, &text);
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let mut stopped = session.shutdown.subscribe();
    loop {
        let message = tokio::select! {
            _ = stopped.wait_for(|stop| *stop) => break,
            message = stream.next() => message,
        };
        let text = match message {
            Some(Ok(Message::Text(text))) => text,
            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
            // Pings are answered by the socket itself; nothing else is used.
            Some(Ok(_)) => continue,
        };
        hub.ui.frame(pty_id, true, &text);
        let Ok(message) = serde_json::from_str::<Value>(&text) else {
            let _ = tx.send(error_response(Value::Null, -32700, "Parse error").to_string());
            continue;
        };
        let blocking = message.get("method").and_then(Value::as_str) == Some("tools/call");
        let reply = dispatch(hub.clone(), session.clone(), message);
        if blocking {
            let tx = tx.clone();
            tokio::spawn(async move {
                if let Some(frame) = reply.await {
                    let _ = tx.send(frame.to_string());
                }
            });
        } else if let Some(frame) = reply.await {
            let _ = tx.send(frame.to_string());
        }
    }
    session.clients.lock().unwrap().remove(&conn);
    // Spawned tool calls hold queue senders, so the writer would otherwise wait
    // on a diff nobody can answer any more.
    writer.abort();
    if !session.connected() {
        if session.drop_diffs() > 0 {
            hub.ui.emit(UiEvent::DiffsCleared { pty_id });
        }
        // Only for a live session: after `close` the UI has already been told.
        if hub.sessions.lock().unwrap().contains_key(&pty_id) {
            hub.ui.emit(UiEvent::Connection {
                pty_id,
                root: session.root.clone(),
                connected: false,
            });
        }
    }
}

// ---- JSON-RPC ----------------------------------------------------------------

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn result_response(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn text_content(texts: &[&str]) -> Value {
    json!({"content": texts.iter().map(|t| json!({"type": "text", "text": t})).collect::<Vec<_>>()})
}

/// One inbound message to its reply, if it gets one. Notifications and
/// responses to our own requests get none; an openDiff the CLI has abandoned
/// gets none ever.
async fn dispatch(hub: Arc<Hub>, session: Arc<Session>, message: Value) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str)?.to_string();
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    // `id` 0 is a real id — initialize uses it.
    let Some(id) = message.get("id").cloned().filter(|id| !id.is_null()) else {
        notification(&hub, &session, &method);
        return None;
    };
    let result = match method.as_str() {
        "initialize" => {
            let version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2024-11-05");
            json!({
                "protocolVersion": version,
                "capabilities": {
                    "tools": {"listChanged": true},
                    "prompts": {"listChanged": true},
                    "logging": {},
                },
                "serverInfo": {"name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION")},
            })
        }
        "ping" => json!({}),
        "prompts/list" => json!({"prompts": []}),
        "tools/list" => json!({"tools": tools()}),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            return match tool_call(&hub, &session, name, &args).await {
                ToolReply::Result(result) => Some(result_response(id, result)),
                ToolReply::Error(code, message) => Some(error_response(id, code, &message)),
                ToolReply::Abandoned => None,
            };
        }
        _ => return Some(error_response(id, -32601, "Method not found")),
    };
    Some(result_response(id, result))
}

fn notification(hub: &Hub, session: &Session, method: &str) {
    // The CLI's own pid comes with it; the socket is already bound to this PTY
    // by being this PTY's server, so the connection itself is the news.
    if method == "ide_connected" {
        hub.ui.emit(UiEvent::Connection {
            pty_id: session.pty_id,
            root: session.root.clone(),
            connected: true,
        });
    }
}

enum ToolReply {
    Result(Value),
    Error(i64, String),
    /// The CLI stopped waiting (close_tab, socket gone): send nothing.
    Abandoned,
}

fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolReply> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ToolReply::Error(-32602, format!("missing string argument `{key}`")))
}

async fn tool_call(hub: &Arc<Hub>, session: &Arc<Session>, name: &str, args: &Value) -> ToolReply {
    let pty_id = session.pty_id;
    match name {
        "openDiff" => {
            let (path, contents, tab_name) = match (
                string_arg(args, "new_file_path"),
                string_arg(args, "new_file_contents"),
                string_arg(args, "tab_name"),
            ) {
                (Ok(p), Ok(c), Ok(t)) => (p.to_string(), c.to_string(), t.to_string()),
                (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => return e,
            };
            let (tx, rx) = oneshot::channel();
            // A second openDiff under the same name replaces the first, whose
            // call is then abandoned like one closed by close_tab.
            session.diffs.lock().unwrap().insert(tab_name.clone(), tx);
            hub.ui.emit(UiEvent::Diff {
                pty_id,
                tab_name,
                path,
                contents,
            });
            // No timeout: the CLI holds this open for as long as the user
            // takes, and so do we.
            match rx.await {
                Ok(DiffVerdict::Accept(text)) => {
                    ToolReply::Result(text_content(&["FILE_SAVED", &text]))
                }
                Ok(DiffVerdict::Reject) => ToolReply::Result(text_content(&["DIFF_REJECTED"])),
                Err(_) => ToolReply::Abandoned,
            }
        }
        "close_tab" => {
            let tab_name = args.get("tab_name").and_then(Value::as_str).unwrap_or("");
            // Arrives twice after every diff, and while a diff is still pending
            // when the user answered in the terminal: dropping the sender is
            // what abandons that openDiff.
            session.diffs.lock().unwrap().remove(tab_name);
            hub.ui.emit(UiEvent::DiffClosed {
                pty_id,
                tab_name: tab_name.to_string(),
            });
            ToolReply::Result(text_content(&["TAB_CLOSED"]))
        }
        "closeAllDiffTabs" => {
            // Sent on every prompt submit; the result is ignored.
            let n = session.drop_diffs();
            if n > 0 {
                hub.ui.emit(UiEvent::DiffsCleared { pty_id });
            }
            ToolReply::Result(text_content(&[&format!("CLOSED_{n}_DIFF_TABS")]))
        }
        "getDiagnostics" => {
            let uri = args
                .get("uri")
                .and_then(Value::as_str)
                .filter(|u| !u.is_empty())
                .map(str::to_string);
            let deadline = if uri.is_some() {
                URI_DIAGNOSTICS_DEADLINE
            } else {
                ALL_DIAGNOSTICS_DEADLINE
            };
            let answer = ask_ui(hub, deadline, |request_id| UiEvent::Diagnostics {
                request_id,
                pty_id,
                root: session.root.clone(),
                uri: uri.clone(),
            })
            .await;
            let shaped = shape_diagnostics(uri.as_deref(), answer.unwrap_or(Value::Null));
            ToolReply::Result(text_content(&[&shaped.to_string()]))
        }
        "executeCode" => ToolReply::Result(json!({
            "content": [{"type": "text", "text": "executeCode is not supported: Canopy has no Jupyter kernel to run code in."}],
            "isError": true,
        })),
        other => ToolReply::Error(-32602, format!("Unknown tool: {other}")),
    }
}

/// One UI round trip with a deadline. `None` when the UI did not answer in
/// time; the pending entry is removed so a late answer goes nowhere.
async fn ask_ui(
    hub: &Arc<Hub>,
    deadline: Duration,
    event: impl FnOnce(u64) -> UiEvent,
) -> Option<Value> {
    let request_id = hub.next_id.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    hub.requests.lock().unwrap().insert(request_id, tx);
    hub.ui.emit(event(request_id));
    let answer = tokio::time::timeout(deadline, rx)
        .await
        .ok()
        .and_then(Result::ok);
    hub.requests.lock().unwrap().remove(&request_id);
    answer
}

/// Hold the UI's diagnostics to exactly what the CLI parses: `file://` URIs,
/// 0-based ranges, string severities. For the `{uri}` form the single entry
/// carries the requested URI verbatim — the CLI discards a baseline whose
/// `result[0].uri` does not match — and nothing known is `[]`, never an error.
pub fn shape_diagnostics(uri: Option<&str>, answer: Value) -> Value {
    let entries: Vec<Value> = answer
        .as_array()
        .map(|a| a.iter().filter_map(shape_file).collect())
        .unwrap_or_default();
    match uri {
        None => Value::Array(entries),
        Some(uri) => {
            let wanted = uri_path(uri);
            match entries.into_iter().find(|e| {
                e.get("uri").and_then(Value::as_str).map(uri_path) == Some(wanted.clone())
            }) {
                Some(mut entry) => {
                    entry["uri"] = uri.into();
                    json!([entry])
                }
                None => json!([]),
            }
        }
    }
}

fn uri_path(uri: &str) -> String {
    let path = uri.strip_prefix("file://").unwrap_or(uri);
    percent_decode(path)
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn shape_file(entry: &Value) -> Option<Value> {
    let uri = entry.get("uri")?.as_str()?;
    if !uri.starts_with("file://") {
        return None;
    }
    let diagnostics: Vec<Value> = entry
        .get("diagnostics")
        .and_then(Value::as_array)
        .map(|d| d.iter().filter_map(shape_diagnostic).collect())
        .unwrap_or_default();
    Some(json!({"uri": uri, "diagnostics": diagnostics}))
}

fn shape_diagnostic(d: &Value) -> Option<Value> {
    let message = d.get("message")?.as_str()?;
    let severity = match d.get("severity") {
        Some(Value::String(s)) => match s.to_ascii_lowercase().as_str() {
            "error" => "Error",
            "warning" => "Warning",
            "info" | "information" => "Info",
            _ => "Hint",
        },
        // LSP's numeric scale, in case a caller passes it through untouched.
        Some(Value::Number(n)) => match n.as_u64() {
            Some(1) => "Error",
            Some(2) => "Warning",
            Some(3) => "Info",
            _ => "Hint",
        },
        _ => "Hint",
    };
    let position = |p: Option<&Value>| {
        let line = p
            .and_then(|p| p.get("line"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let character = p
            .and_then(|p| p.get("character"))
            .and_then(Value::as_u64)
            .unwrap_or(0);
        json!({"line": line, "character": character})
    };
    let range = d.get("range");
    let mut out = json!({
        "message": message,
        "severity": severity,
        "range": {
            "start": position(range.and_then(|r| r.get("start"))),
            "end": position(range.and_then(|r| r.get("end"))),
        },
    });
    if let Some(source) = d.get("source").and_then(Value::as_str) {
        out["source"] = source.into();
    }
    match d.get("code") {
        Some(Value::String(code)) => out["code"] = code.as_str().into(),
        Some(Value::Number(code)) => out["code"] = code.to_string().into(),
        _ => {}
    }
    Some(out)
}

/// What we advertise: only the tools the CLI calls. Every other `mcp__ide__*`
/// tool is dropped by the CLI's allow-list, and only getDiagnostics and
/// executeCode are shown to the model, so only their descriptions matter.
fn tools() -> Value {
    json!([
        {
            "name": "getDiagnostics",
            "description": "Get language diagnostics (errors, warnings) from the editor",
            "inputSchema": {
                "type": "object",
                "properties": {"uri": {"type": "string", "description": "Optional file URI to get diagnostics for. If not provided, gets diagnostics for all open files."}},
                "additionalProperties": false,
                "$schema": "http://json-schema.org/draft-07/schema#",
            },
        },
        {
            "name": "openDiff",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "old_file_path": {"type": "string"},
                    "new_file_path": {"type": "string"},
                    "new_file_contents": {"type": "string"},
                    "tab_name": {"type": "string"},
                },
                "required": ["old_file_path", "new_file_path", "new_file_contents", "tab_name"],
                "additionalProperties": false,
            },
        },
        {
            "name": "close_tab",
            "inputSchema": {
                "type": "object",
                "properties": {"tab_name": {"type": "string"}},
                "required": ["tab_name"],
            },
        },
        {
            "name": "closeAllDiffTabs",
            "inputSchema": {"type": "object", "properties": {}},
        },
        {
            "name": "executeCode",
            "inputSchema": {
                "type": "object",
                "properties": {"code": {"type": "string"}},
                "required": ["code"],
            },
        },
    ])
}

// ---- Tauri commands ----------------------------------------------------------

/// Accept (with the final contents) or reject a diff shown in Canopy.
#[tauri::command]
pub fn claude_ide_resolve_diff(
    state: tauri::State<'_, ClaudeIde>,
    pty_id: u32,
    tab_name: String,
    accept: bool,
    contents: Option<String>,
) -> Result<(), String> {
    let verdict = match (accept, contents) {
        (true, Some(contents)) => DiffVerdict::Accept(contents),
        (true, None) => return Err("accepting a change needs its contents".into()),
        (false, _) => DiffVerdict::Reject,
    };
    state.resolve_diff(pty_id, &tab_name, verdict)
}

/// Which terminals have a CLI attached, for a window that has just loaded.
#[tauri::command]
pub fn claude_ide_connections(state: tauri::State<'_, ClaudeIde>) -> Vec<Value> {
    state
        .connections()
        .into_iter()
        .map(|(pty_id, root)| json!({"ptyId": pty_id, "root": root}))
        .collect()
}

/// The UI's answer to a `claude-ide` diagnostics request.
#[tauri::command]
pub fn claude_ide_reply(state: tauri::State<'_, ClaudeIde>, request_id: u64, data: Value) {
    state.reply(request_id, data);
}

/// The editor selection changed. `params` is the CLI's `selection_changed`
/// shape, built by the frontend; this only routes it.
#[tauri::command]
pub fn claude_ide_selection(
    state: tauri::State<'_, ClaudeIde>,
    path: String,
    params: Value,
) -> usize {
    state.notify_selection(&path, params)
}

/// "Add to Claude": mention the file (and lines, 0-based) in one session's
/// prompt. Returns the terminal it went to.
#[tauri::command]
pub fn claude_ide_at_mention(
    state: tauri::State<'_, ClaudeIde>,
    ptys: tauri::State<'_, crate::pty::PtyManager>,
    path: String,
    line_start: Option<u32>,
    line_end: Option<u32>,
    prefer: Option<u32>,
) -> Result<u32, String> {
    let now = crate::pty::now_ms();
    state.at_mention(&path, line_start, line_end, prefer, |pty| {
        ptys.get(pty)
            .and_then(|s| s.since_input_ms(now))
            .map(|since| now.saturating_sub(since))
            .unwrap_or(0)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};

    /// Records what the UI was asked to do, and lets a test answer it.
    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<UiEvent>>,
        notify: tokio::sync::Notify,
    }

    impl IdeUi for Recorder {
        fn emit(&self, event: UiEvent) {
            self.events.lock().unwrap().push(event);
            self.notify.notify_waiters();
        }
    }

    impl Recorder {
        async fn wait_for(&self, pred: impl Fn(&UiEvent) -> bool) -> UiEvent {
            for _ in 0..200 {
                if let Some(e) = self
                    .events
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|e| pred(e))
                    .cloned()
                {
                    return e;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            panic!("no matching UI event in {:?}", self.events.lock().unwrap());
        }
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "canopy-claude-ide-{tag}-{}-{}",
            std::process::id(),
            random_token().unwrap()[..8].to_string()
        ));
        dir
    }

    fn open(ide: &ClaudeIde, pty: u32, root: &str, dir: &Path) -> Launch {
        let (launch, serve) = ide.open(pty, root, dir, std::process::id()).unwrap();
        tokio::spawn(serve);
        launch
    }

    type Ws = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    async fn connect(
        launch: &Launch,
        token: &str,
    ) -> Result<(Ws, tungstenite::handshake::client::Response), tungstenite::Error> {
        let mut request = format!("ws://127.0.0.1:{}/", launch.port)
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("sec-websocket-protocol", "mcp".parse().unwrap());
        request
            .headers_mut()
            .insert(AUTH_HEADER, token.parse().unwrap());
        tokio_tungstenite::connect_async(request).await
    }

    async fn send(ws: &mut Ws, frame: Value) {
        ws.send(tungstenite::Message::Text(frame.to_string().into()))
            .await
            .unwrap();
    }

    async fn recv(ws: &mut Ws) -> Value {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(5), ws.next())
                .await
                .expect("a frame within 5s")
                .unwrap()
                .unwrap();
            if let tungstenite::Message::Text(text) = message {
                return serde_json::from_str(text.as_ref()).unwrap();
            }
        }
    }

    fn call(id: u64, name: &str, arguments: Value) -> Value {
        json!({"jsonrpc": "2.0", "id": id, "method": "tools/call", "params": {"name": name, "arguments": arguments, "_meta": {"progressToken": id}}})
    }

    fn texts(response: &Value) -> Vec<String> {
        response["result"]["content"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["text"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn lock_is_written_atomically_private_and_removed_on_close() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let _guard = rt.enter();
        let dir = temp_dir("lock").join("ide");
        let ide = ClaudeIde::new(Arc::new(Recorder::default()));
        let (launch, _serve) = ide.open(3, "/w/app", &dir, 4242).unwrap();
        let path = dir.join(format!("{}.lock", launch.port));
        let lock: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            lock,
            json!({"pid": 4242, "workspaceFolders": ["/w/app"], "ideName": "Canopy", "transport": "ws", "authToken": launch.token})
        );
        assert_eq!(launch.token.len(), 64);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&path), 0o600);
            assert_eq!(mode(&dir), 0o700);
        }
        // No temp file left beside it.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        assert_eq!(
            launch.env(),
            [
                ("CLAUDE_CODE_SSE_PORT", launch.port.to_string()),
                ("CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL", "1".to_string()),
            ]
        );
        ide.close(3);
        assert!(!path.exists());
        ide.close(3); // idempotent
        let (second, _) = ide.open(4, "/w/app", &dir, 4242).unwrap();
        ide.close_all();
        assert!(!dir.join(format!("{}.lock", second.port)).exists());
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn lock_dir_follows_the_ptys_effective_config_dir() {
        let inherited = || Some("/home/u/.canopy/profiles/vj/.claude".to_string());
        // The launch's own profile wins.
        assert_eq!(
            lock_dir(Some("/p/.claude"), inherited(), false, Some("/home/u")),
            Some(PathBuf::from("/p/.claude/ide"))
        );
        // An inherited one the PTY keeps.
        assert_eq!(
            lock_dir(None, inherited(), false, Some("/home/u")),
            Some(PathBuf::from("/home/u/.canopy/profiles/vj/.claude/ide"))
        );
        // One the spawn clears is not where the child will look.
        assert_eq!(
            lock_dir(None, inherited(), true, Some("/home/u")),
            Some(PathBuf::from("/home/u/.claude/ide"))
        );
        assert_eq!(lock_dir(None, None, false, None), None);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn wrong_token_is_401_and_the_upgrade_echoes_mcp() {
        let dir = temp_dir("auth");
        let ide = ClaudeIde::new(Arc::new(Recorder::default()));
        let launch = open(&ide, 1, "/w", &dir);
        match connect(&launch, "not-the-token").await {
            Err(tungstenite::Error::Http(response)) => assert_eq!(response.status(), 401),
            other => panic!("expected 401, got {:?}", other.map(|(_, r)| r.status())),
        }
        let (_ws, response) = connect(&launch, &launch.token).await.unwrap();
        assert_eq!(
            response
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|v| v.to_str().ok()),
            Some("mcp")
        );
        ide.close_all();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn constant_time_compare_rejects_near_misses() {
        use crate::context::constant_time_eq;
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(!constant_time_eq("", "abc"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn handshake_lists_tools_and_answers_the_small_methods() {
        let dir = temp_dir("handshake");
        let recorder = Arc::new(Recorder::default());
        let ide = ClaudeIde::new(recorder.clone());
        let launch = open(&ide, 9, "/w/app", &dir);
        let (mut ws, _) = connect(&launch, &launch.token).await.unwrap();
        send(&mut ws, json!({"jsonrpc": "2.0", "id": 0, "method": "initialize", "params": {"protocolVersion": "2025-11-25", "capabilities": {}}})).await;
        let init = recv(&mut ws).await;
        assert_eq!(init["id"], 0);
        assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(
            init["result"]["capabilities"],
            json!({"tools": {"listChanged": true}, "prompts": {"listChanged": true}, "logging": {}})
        );
        assert_eq!(init["result"]["serverInfo"]["name"], "canopy");
        send(
            &mut ws,
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
        )
        .await;
        send(
            &mut ws,
            json!({"jsonrpc": "2.0", "method": "ide_connected", "params": {"pid": 77}}),
        )
        .await;
        assert_eq!(
            recorder
                .wait_for(|e| matches!(e, UiEvent::Connection { .. }))
                .await,
            UiEvent::Connection {
                pty_id: 9,
                root: "/w/app".into(),
                connected: true
            }
        );
        send(
            &mut ws,
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
        )
        .await;
        let list = recv(&mut ws).await;
        let names: Vec<&str> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "getDiagnostics",
                "openDiff",
                "close_tab",
                "closeAllDiffTabs",
                "executeCode"
            ]
        );
        send(
            &mut ws,
            json!({"jsonrpc": "2.0", "id": 2, "method": "prompts/list"}),
        )
        .await;
        assert_eq!(recv(&mut ws).await["result"], json!({"prompts": []}));
        send(
            &mut ws,
            json!({"jsonrpc": "2.0", "id": 3, "method": "ping"}),
        )
        .await;
        assert_eq!(recv(&mut ws).await["result"], json!({}));
        send(
            &mut ws,
            json!({"jsonrpc": "2.0", "id": 4, "method": "openFile", "params": {}}),
        )
        .await;
        assert_eq!(recv(&mut ws).await["error"]["code"], -32601);
        send(&mut ws, call(5, "executeCode", json!({"code": "1"}))).await;
        let exec = recv(&mut ws).await;
        assert_eq!(exec["result"]["isError"], true);
        assert!(texts(&exec)[0].contains("not supported"));
        send(&mut ws, call(6, "closeAllDiffTabs", json!({}))).await;
        assert_eq!(texts(&recv(&mut ws).await), ["CLOSED_0_DIFF_TABS"]);
        ide.close_all();
        let _ = std::fs::remove_dir_all(dir);
    }

    async fn pending_diff(recorder: &Recorder, ws: &mut Ws, id: u64, tab: &str) {
        send(
            ws,
            call(
                id,
                "openDiff",
                json!({
                    "old_file_path": "/w/app/hello.py",
                    "new_file_path": "/w/app/hello.py",
                    "new_file_contents": "proposed\n",
                    "tab_name": tab,
                }),
            ),
        )
        .await;
        let tab = tab.to_string();
        recorder
            .wait_for(|e| matches!(e, UiEvent::Diff { tab_name, .. } if *tab_name == tab))
            .await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn open_diff_accept_reject_and_close_tab_while_pending() {
        let dir = temp_dir("diff");
        let recorder = Arc::new(Recorder::default());
        let ide = ClaudeIde::new(recorder.clone());
        let launch = open(&ide, 5, "/w/app", &dir);
        let (mut ws, _) = connect(&launch, &launch.token).await.unwrap();

        // Accept with the user's edit: FILE_SAVED plus the final contents.
        pending_diff(
            &recorder,
            &mut ws,
            10,
            "✻ [Claude Code] hello.py (aaaaaa) ⧉",
        )
        .await;
        assert_eq!(
            recorder.events.lock().unwrap().last().unwrap(),
            &UiEvent::Diff {
                pty_id: 5,
                tab_name: "✻ [Claude Code] hello.py (aaaaaa) ⧉".into(),
                path: "/w/app/hello.py".into(),
                contents: "proposed\n".into(),
            }
        );
        ide.resolve_diff(
            5,
            "✻ [Claude Code] hello.py (aaaaaa) ⧉",
            DiffVerdict::Accept("edited\n".into()),
        )
        .unwrap();
        let accepted = recv(&mut ws).await;
        assert_eq!(accepted["id"], 10);
        assert_eq!(texts(&accepted), ["FILE_SAVED", "edited\n"]);

        // Reject.
        pending_diff(&recorder, &mut ws, 11, "tab-b").await;
        ide.resolve_diff(5, "tab-b", DiffVerdict::Reject).unwrap();
        let rejected = recv(&mut ws).await;
        assert_eq!(rejected["id"], 11);
        assert_eq!(texts(&rejected), ["DIFF_REJECTED"]);

        // Answered in the terminal: close_tab arrives while openDiff is still
        // pending, twice. The openDiff gets no reply at all, never TAB_CLOSED.
        pending_diff(&recorder, &mut ws, 12, "tab-c").await;
        send(&mut ws, call(13, "close_tab", json!({"tab_name": "tab-c"}))).await;
        let closed = recv(&mut ws).await;
        assert_eq!(closed["id"], 13);
        assert_eq!(texts(&closed), ["TAB_CLOSED"]);
        send(&mut ws, call(14, "close_tab", json!({"tab_name": "tab-c"}))).await;
        assert_eq!(recv(&mut ws).await["id"], 14);
        recorder
            .wait_for(|e| matches!(e, UiEvent::DiffClosed { tab_name, .. } if tab_name == "tab-c"))
            .await;
        // Too late from the UI side: refused, and still nothing on the wire.
        assert!(ide
            .resolve_diff(5, "tab-c", DiffVerdict::Accept("x".into()))
            .is_err());
        send(
            &mut ws,
            json!({"jsonrpc": "2.0", "id": 15, "method": "ping"}),
        )
        .await;
        assert_eq!(
            recv(&mut ws).await["id"],
            15,
            "openDiff 12 must never be answered"
        );

        // closeAllDiffTabs drops whatever is pending and says how many.
        pending_diff(&recorder, &mut ws, 16, "tab-d").await;
        send(&mut ws, call(17, "closeAllDiffTabs", json!({}))).await;
        let all = recv(&mut ws).await;
        assert_eq!(all["id"], 17);
        assert_eq!(texts(&all), ["CLOSED_1_DIFF_TABS"]);
        recorder
            .wait_for(|e| matches!(e, UiEvent::DiffsCleared { pty_id: 5 }))
            .await;

        ide.close_all();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn get_diagnostics_round_trips_through_the_ui_and_times_out_to_empty() {
        let dir = temp_dir("diag");
        let recorder = Arc::new(Recorder::default());
        let ide = ClaudeIde::new(recorder.clone());
        let launch = open(&ide, 6, "/w/app", &dir);
        let (mut ws, _) = connect(&launch, &launch.token).await.unwrap();

        send(
            &mut ws,
            call(
                20,
                "getDiagnostics",
                json!({"uri": "file:///w/app/a%20b.ts"}),
            ),
        )
        .await;
        let UiEvent::Diagnostics {
            request_id,
            uri,
            root,
            ..
        } = recorder
            .wait_for(|e| matches!(e, UiEvent::Diagnostics { .. }))
            .await
        else {
            unreachable!()
        };
        assert_eq!(uri.as_deref(), Some("file:///w/app/a%20b.ts"));
        assert_eq!(root, "/w/app");
        ide.reply(
            request_id,
            json!([{"uri": "file:///w/app/a b.ts", "diagnostics": [
                {"message": "boom", "severity": "Error", "source": "ts", "code": 2304,
                 "range": {"start": {"line": 1, "character": 0}, "end": {"line": 1, "character": 4}}}
            ]}]),
        );
        let response = recv(&mut ws).await;
        let parsed: Value = serde_json::from_str(&texts(&response)[0]).unwrap();
        assert_eq!(
            parsed,
            json!([{"uri": "file:///w/app/a%20b.ts", "diagnostics": [
                {"message": "boom", "severity": "Error", "source": "ts", "code": "2304",
                 "range": {"start": {"line": 1, "character": 0}, "end": {"line": 1, "character": 4}}}
            ]}])
        );

        // Nobody answers: `[]` inside the CLI's 500 ms, not an error.
        let started = std::time::Instant::now();
        send(
            &mut ws,
            call(21, "getDiagnostics", json!({"uri": "file:///w/app/x.ts"})),
        )
        .await;
        let response = recv(&mut ws).await;
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(texts(&response), ["[]"]);
        ide.close_all();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn diagnostics_are_shaped_to_what_the_cli_parses() {
        let answer = json!([
            {"uri": "file:///w/a.ts", "diagnostics": [
                {"message": "m", "severity": "warning", "range": {"start": {"line": 0, "character": 2}, "end": {"line": 0, "character": 3}}},
                {"message": "n", "severity": 4},
                {"severity": "Error"}
            ]},
            {"uri": "untitled:1", "diagnostics": []},
            {"uri": "file:///w/b.ts", "diagnostics": []}
        ]);
        let all = shape_diagnostics(None, answer.clone());
        assert_eq!(all.as_array().unwrap().len(), 2, "only file:// entries");
        assert_eq!(all[0]["diagnostics"][0]["severity"], "Warning");
        assert_eq!(all[0]["diagnostics"][1]["severity"], "Hint");
        assert_eq!(
            all[0]["diagnostics"][1]["range"]["start"],
            json!({"line": 0, "character": 0})
        );
        assert_eq!(
            all[0]["diagnostics"].as_array().unwrap().len(),
            2,
            "a diagnostic needs a message"
        );
        assert_eq!(
            shape_diagnostics(Some("file:///w/b.ts"), answer.clone()),
            json!([{"uri": "file:///w/b.ts", "diagnostics": []}])
        );
        assert_eq!(
            shape_diagnostics(Some("file:///w/zzz.ts"), answer),
            json!([])
        );
        assert_eq!(
            shape_diagnostics(Some("file:///w/a.ts"), Value::Null),
            json!([])
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn selection_goes_to_the_innermost_component_and_mentions_to_one_session() {
        let dir = temp_dir("route");
        let ide = ClaudeIde::new(Arc::new(Recorder::default()));
        let outer = open(&ide, 1, "/w/repo", &dir);
        let inner_a = open(&ide, 2, "/w/repo/pkg", &dir);
        let inner_b = open(&ide, 3, "/w/repo/pkg/", &dir);
        let idle = open(&ide, 4, "/w/repo/pkg", &dir); // never connects
        let _ = idle;
        let (mut ws_outer, _) = connect(&outer, &outer.token).await.unwrap();
        let (mut ws_a, _) = connect(&inner_a, &inner_a.token).await.unwrap();
        let (mut ws_b, _) = connect(&inner_b, &inner_b.token).await.unwrap();
        // Let the server register all three sockets.
        for ws in [&mut ws_outer, &mut ws_a, &mut ws_b] {
            send(ws, json!({"jsonrpc": "2.0", "id": 1, "method": "ping"})).await;
            recv(ws).await;
        }
        let params = json!({"text": "", "filePath": "/w/repo/pkg/x.ts", "selection": {"start": {"line": 0, "character": 0}, "end": {"line": 0, "character": 0}}});
        assert_eq!(ide.notify_selection("/w/repo/pkg/x.ts", params.clone()), 2);
        for ws in [&mut ws_a, &mut ws_b] {
            let frame = recv(ws).await;
            assert_eq!(frame["method"], "selection_changed");
            assert_eq!(frame["params"], params);
        }
        assert_eq!(ide.notify_selection("/w/repo/README.md", json!({})), 1);
        assert_eq!(recv(&mut ws_outer).await["method"], "selection_changed");
        assert_eq!(
            ide.notify_selection("/w/repository/x", json!({})),
            0,
            "segment-wise"
        );
        let mut connected = ide.connections();
        connected.sort();
        assert_eq!(
            connected,
            [
                (1, "/w/repo".to_string()),
                (2, "/w/repo/pkg".to_string()),
                (3, "/w/repo/pkg/".to_string())
            ],
            "pty 4 never connected"
        );

        // Mention: the preferred terminal when eligible, else the latest typed in.
        let pty = ide
            .at_mention("/w/repo/pkg/x.ts", Some(0), Some(1), None, |p| {
                if p == 3 {
                    50
                } else {
                    10
                }
            })
            .unwrap();
        assert_eq!(pty, 3);
        let frame = recv(&mut ws_b).await;
        assert_eq!(
            frame,
            json!({"jsonrpc": "2.0", "method": "at_mentioned", "params": {"filePath": "/w/repo/pkg/x.ts", "lineStart": 0, "lineEnd": 1}})
        );
        assert_eq!(
            ide.at_mention("/w/repo/pkg/x.ts", None, None, Some(2), |_| 0)
                .unwrap(),
            2
        );
        assert_eq!(
            recv(&mut ws_a).await["params"],
            json!({"filePath": "/w/repo/pkg/x.ts"})
        );
        assert!(ide
            .at_mention("/elsewhere/x", None, None, None, |_| 0)
            .is_err());
        ide.close_all();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_dropped_socket_clears_diffs_and_the_listener_takes_the_reconnect() {
        let dir = temp_dir("reconnect");
        let recorder = Arc::new(Recorder::default());
        let ide = ClaudeIde::new(recorder.clone());
        let launch = open(&ide, 8, "/w", &dir);
        let (mut ws, _) = connect(&launch, &launch.token).await.unwrap();
        pending_diff(&recorder, &mut ws, 1, "t").await;
        drop(ws);
        recorder
            .wait_for(|e| matches!(e, UiEvent::DiffsCleared { pty_id: 8 }))
            .await;
        recorder
            .wait_for(|e| {
                matches!(
                    e,
                    UiEvent::Connection {
                        connected: false,
                        ..
                    }
                )
            })
            .await;
        // Same port, same token: the CLI's cached credentials still work.
        let (mut ws, _) = connect(&launch, &launch.token).await.unwrap();
        send(
            &mut ws,
            json!({"jsonrpc": "2.0", "id": 2, "method": "ping"}),
        )
        .await;
        assert_eq!(recv(&mut ws).await["result"], json!({}));
        // Ending the session closes the socket.
        ide.close(8);
        let end = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match ws.next().await {
                    Some(Ok(tungstenite::Message::Close(_))) | None | Some(Err(_)) => break,
                    _ => {}
                }
            }
        })
        .await;
        assert!(end.is_ok(), "closing the session must close its sockets");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The live harness: this module's server, with a scripted UI, for driving
    /// the real `claude` against. Not a unit test — it runs until told to stop.
    ///
    ///   CLAUDE_IDE_HARNESS_DIR   out dir: `port`, `frames.jsonl`, `events.jsonl`,
    ///                            `ide.fifo` (control lines), `diff-mode`, `stop`
    ///   CLAUDE_IDE_HARNESS_ROOT  the workspace folder for the lock
    ///   CLAUDE_CONFIG_DIR        where the lock goes, as for a profile launch
    ///
    /// `diff-mode` holds accept | edit | reject | pending, read when a diff
    /// arrives. Control lines are JSON: `{"select": {"path", "params"}}`,
    /// `{"mention": {"path", "lineStart", "lineEnd"}}`, `{"diff": "accept"|"reject"}`.
    /// Diagnostics answer like the capture's `baseline-empty` mode: the `{uri}`
    /// baseline is clean and the `{}` fetch reports one canary error in it.
    #[test]
    #[ignore = "drives a real claude; run by hand"]
    fn live_harness() {
        use std::io::{BufRead, Write};
        let out =
            PathBuf::from(std::env::var("CLAUDE_IDE_HARNESS_DIR").expect("CLAUDE_IDE_HARNESS_DIR"));
        let root = std::env::var("CLAUDE_IDE_HARNESS_ROOT").expect("CLAUDE_IDE_HARNESS_ROOT");
        let lock_dir = lock_dir(
            None,
            std::env::var("CLAUDE_CONFIG_DIR").ok(),
            false,
            std::env::var("HOME").ok().as_deref(),
        )
        .unwrap();
        std::fs::create_dir_all(&out).unwrap();

        struct Scripted {
            tx: mpsc::UnboundedSender<UiEvent>,
            log: Mutex<std::fs::File>,
            frames: Mutex<std::fs::File>,
        }
        impl IdeUi for Scripted {
            fn emit(&self, event: UiEvent) {
                let _ = writeln!(
                    self.log.lock().unwrap(),
                    "{}",
                    serde_json::to_string(&event).unwrap()
                );
                let _ = self.tx.send(event);
            }
            fn frame(&self, _pty: u32, inbound: bool, text: &str) {
                let _ = writeln!(
                    self.frames.lock().unwrap(),
                    "{}",
                    json!({"t": crate::pty::now_ms(), "dir": if inbound { "in" } else { "out" }, "frame": serde_json::from_str::<Value>(text).unwrap_or(Value::Null)})
                );
            }
        }
        let append = |name: &str| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(out.join(name))
                .unwrap()
        };
        let (tx, mut rx) = mpsc::unbounded_channel();
        let ide = ClaudeIde::new(Arc::new(Scripted {
            tx,
            log: Mutex::new(append("events.jsonl")),
            frames: Mutex::new(append("frames.jsonl")),
        }));
        let rt = tokio::runtime::Runtime::new().unwrap();
        let (launch, serve) = {
            let _guard = rt.enter();
            ide.open(1, &root, &lock_dir, std::process::id()).unwrap()
        };
        rt.spawn(serve);
        std::fs::write(out.join("port"), launch.port.to_string()).unwrap();
        eprintln!(
            "claude ide harness on port {} (lock in {})",
            launch.port,
            lock_dir.display()
        );

        let pending = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let responder = {
            let ide = ide.clone();
            let out = out.clone();
            let pending = pending.clone();
            rt.spawn(async move {
                let mut baseline: Option<String> = None;
                while let Some(event) = rx.recv().await {
                    match event {
                        UiEvent::Diagnostics { request_id, uri: Some(uri), .. } => {
                            baseline = Some(uri.clone());
                            ide.reply(request_id, json!([{"uri": uri, "diagnostics": []}]));
                        }
                        UiEvent::Diagnostics { request_id, uri: None, .. } => {
                            let answer = baseline.as_ref().map(|uri| json!([{"uri": uri, "diagnostics": [{
                                "message": "CANOPY_CANARY: undefined name \"frobnicate\"", "severity": "Error", "source": "canopy-harness",
                                "range": {"start": {"line": 1, "character": 0}, "end": {"line": 1, "character": 4}}}]}]));
                            ide.reply(request_id, answer.unwrap_or_else(|| json!([])));
                        }
                        UiEvent::Diff { tab_name, contents, .. } => {
                            let mode = std::fs::read_to_string(out.join("diff-mode")).unwrap_or_default();
                            let verdict = match mode.trim() {
                                "accept" => Some(DiffVerdict::Accept(contents.clone())),
                                "edit" => Some(DiffVerdict::Accept(format!("{contents}# EDITED_IN_CANOPY\n"))),
                                "reject" => Some(DiffVerdict::Reject),
                                _ => None,
                            };
                            match verdict {
                                Some(v) => {
                                    tokio::time::sleep(Duration::from_millis(1500)).await;
                                    let _ = ide.resolve_diff(1, &tab_name, v);
                                }
                                None => pending.lock().unwrap().push((tab_name, contents)),
                            }
                        }
                        _ => {}
                    }
                }
            })
        };

        let fifo = out.join("ide.fifo");
        let deadline = std::time::Instant::now() + Duration::from_secs(20 * 60);
        while !out.join("stop").exists() && std::time::Instant::now() < deadline {
            let Ok(file) = std::fs::File::open(&fifo) else {
                std::thread::sleep(Duration::from_millis(200));
                continue;
            };
            for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
                let Ok(cmd) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(sel) = cmd.get("select") {
                    let n = ide.notify_selection(
                        sel["path"].as_str().unwrap_or(""),
                        sel["params"].clone(),
                    );
                    eprintln!("selection_changed -> {n} session(s)");
                } else if let Some(m) = cmd.get("mention") {
                    let r = ide.at_mention(
                        m["path"].as_str().unwrap_or(""),
                        m["lineStart"].as_u64().map(|v| v as u32),
                        m["lineEnd"].as_u64().map(|v| v as u32),
                        None,
                        |_| 0,
                    );
                    eprintln!("at_mentioned -> {r:?}");
                } else if let Some(verdict) = cmd.get("diff").and_then(Value::as_str) {
                    for (tab, contents) in pending.lock().unwrap().drain(..) {
                        let v = if verdict == "reject" {
                            DiffVerdict::Reject
                        } else {
                            DiffVerdict::Accept(contents)
                        };
                        eprintln!("diff {tab} -> {:?}", ide.resolve_diff(1, &tab, v));
                    }
                }
            }
        }
        ide.close_all();
        assert!(!lock_dir.join(format!("{}.lock", launch.port)).exists());
        responder.abort();
    }
}

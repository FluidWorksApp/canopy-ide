//! Context bridge: the app-side answer to "what does the IDE know that my
//! agent doesn't?".
//!
//! Agents run in Canopy's PTYs, but as plain CLI processes they can't see the
//! IDE around them — which components the project has, which dev servers are
//! running, what those servers are printing. This module serves that context
//! over a loopback-only, token-gated HTTP endpoint, and `canopy-hook --mcp`
//! (see bin/canopy_hook.rs) exposes it to the agent as MCP tools. The port and
//! token travel to agents via PTY env (`CANOPY_CTX_PORT` / `CANOPY_CTX_TOKEN`,
//! set in pty.rs), so only processes inside Canopy's own terminals can ask.
//!
//! The workspace model (projects, components, run commands) lives in the
//! frontend, so the frontend pushes per-project snapshots down via
//! `context_publish`; PTY scrollback is already Rust-side and is read live.

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};

/// Directories never worth an agent's attention (or token budget) when listing
/// a component's files.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".venv",
    "__pycache__",
    "coverage",
];
const MAX_FILES_DEFAULT: usize = 500;
const MAX_OUTPUT_BYTES: usize = 512 * 1024;

pub struct ContextBridge {
    /// Per-project snapshots the frontend publishes, keyed by project id.
    snapshots: Mutex<HashMap<String, serde_json::Value>>,
    port: OnceLock<u16>,
    token: String,
    /// Browser-control and UI ops in flight: the HTTP handler parks a sender
    /// here and waits; the frontend answers through the `browser_result`
    /// command (one ticket space for every request/response op, browser or not).
    pending: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<(bool, serde_json::Value)>>>,
    next_op: AtomicU64,
    /// Advisory file claims, newest last. Several agents routinely share one
    /// checkout; a claim is how one says "I'm editing these" loudly enough for
    /// the others (and the Agents panel) to see it. Advisory on purpose —
    /// nothing here blocks a write, it just stops the collision being invisible.
    claims: Mutex<Vec<Claim>>,
    /// Tools the user switched off in Settings → Agents. `None` until the
    /// frontend publishes, which is the same as "everything is on".
    disabled_tools: Mutex<Option<Vec<String>>>,
}

/// One agent's advisory claim over a set of paths.
#[derive(Clone, serde::Serialize)]
pub struct Claim {
    pub paths: Vec<String>,
    /// Who holds it — the agent's cwd plus whatever name it gave itself.
    pub owner: String,
    pub note: Option<String>,
    pub at_ms: u64,
}

impl Default for ContextBridge {
    fn default() -> Self {
        let mut bytes = [0u8; 16];
        let _ = getrandom::getrandom(&mut bytes);
        Self {
            snapshots: Mutex::new(HashMap::new()),
            port: OnceLock::new(),
            token: hex::encode(bytes),
            pending: Mutex::new(HashMap::new()),
            next_op: AtomicU64::new(1),
            claims: Mutex::new(Vec::new()),
            disabled_tools: Mutex::new(None),
        }
    }
}

impl ContextBridge {
    /// What a spawning PTY should export, once the listener is up.
    pub fn env(&self) -> Option<(u16, String)> {
        self.port.get().map(|p| (*p, self.token.clone()))
    }
}

/// Bind the loopback listener and serve until app exit. Called once from
/// setup; failures are logged, not fatal — the IDE works without the bridge,
/// agents just lose the context tools.
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(l) => l,
            Err(e) => {
                log::warn!("context bridge: cannot bind: {e}");
                return;
            }
        };
        let port = match listener.local_addr() {
            Ok(a) => a.port(),
            Err(e) => {
                log::warn!("context bridge: no local addr: {e}");
                return;
            }
        };
        let _ = app.state::<ContextBridge>().port.set(port);
        let router = Router::new()
            .route("/ctx/snapshot", get(snapshot))
            .route("/ctx/server-output/:id", get(server_output))
            .route("/ctx/files", get(files))
            .route("/ctx/annotations", get(annotations))
            .route("/ctx/resources", get(resources))
            .route("/ctx/action", post(action))
            .route("/ctx/browser", post(browser))
            .route("/ctx/network", get(network))
            .route("/ctx/editor", get(editor))
            .route("/ctx/ui", post(ui_op))
            .route("/ctx/wait", get(wait))
            .route("/ctx/claims", get(claims_list).post(claims_post))
            .route("/ctx/tools", get(tools))
            .with_state(app.clone());
        let _ = axum::serve(listener, router).await;
    });
}

// ---- commands the frontend feeds the bridge with --------------------------

#[tauri::command]
pub fn context_publish(
    state: tauri::State<'_, ContextBridge>,
    project_id: String,
    data: String,
) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_str(&data).map_err(|e| format!("bad snapshot: {e}"))?;
    state.snapshots.lock().unwrap().insert(project_id, value);
    Ok(())
}

#[tauri::command]
pub fn context_remove(state: tauri::State<'_, ContextBridge>, project_id: String) {
    state.snapshots.lock().unwrap().remove(&project_id);
}

/// Which canopy_* tools the user switched off (Settings → Agents). Published on
/// change and at startup; the sidecar filters its `tools/list` against this, so
/// a disabled tool never even reaches the agent's context window.
#[tauri::command]
pub fn context_tools(state: tauri::State<'_, ContextBridge>, disabled: Vec<String>) {
    *state.disabled_tools.lock().unwrap() = Some(disabled);
}

/// Every advisory claim currently held, for the Agents panel.
#[tauri::command]
pub fn context_claims(state: tauri::State<'_, ContextBridge>) -> Vec<Claim> {
    state.claims.lock().unwrap().clone()
}

/// Drop a claim from the UI — the escape hatch for an agent that died holding
/// one, so a stale claim is never permanent.
#[tauri::command]
pub fn context_release_claim(app: tauri::AppHandle, owner: String) {
    let bridge = app.state::<ContextBridge>();
    bridge.claims.lock().unwrap().retain(|c| c.owner != owner);
    let _ = app.emit("agent:claims", ());
}

/// The frontend's answer to a browser-control op: `data` is a JSON document
/// (or plain text) that becomes the waiting HTTP response's body. An id nobody
/// is waiting on (op timed out, duplicate answer) is dropped silently.
#[tauri::command]
pub fn browser_result(state: tauri::State<'_, ContextBridge>, id: u64, ok: bool, data: String) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let value = serde_json::from_str(&data).unwrap_or(serde_json::Value::String(data));
        let _ = tx.send((ok, value));
    }
}

// ---- HTTP handlers --------------------------------------------------------

fn authorized(app: &tauri::AppHandle, headers: &HeaderMap) -> bool {
    let want = &app.state::<ContextBridge>().token;
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .is_some_and(|t| t == want)
}

async fn snapshot(State(app): State<tauri::AppHandle>, headers: HeaderMap) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let projects: Vec<serde_json::Value> = app
        .state::<ContextBridge>()
        .snapshots
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect();
    (
        StatusCode::OK,
        serde_json::json!({ "projects": projects }).to_string(),
    )
}

/// The annotations the user has marked on preview pages, across open projects
/// — read-only, so an agent can pull the current visual feedback (element +
/// comment + which component serves it) without waiting for it to be typed in.
async fn annotations(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let list: Vec<serde_json::Value> = app
        .state::<ContextBridge>()
        .snapshots
        .lock()
        .unwrap()
        .values()
        .filter_map(|p| p.get("annotations").and_then(|a| a.as_array()).cloned())
        .flatten()
        .collect();
    (
        StatusCode::OK,
        serde_json::json!({ "annotations": list }).to_string(),
    )
}

/// What the user is looking at right now: the focused project, its open tabs,
/// the file in front of them, and where the caret sits. The context an agent is
/// otherwise missing when the ask is "fix this" or "make it match the other
/// one" — the IDE is the only thing that knows what "this" is.
async fn editor(State(app): State<tauri::AppHandle>, headers: HeaderMap) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let states: Vec<serde_json::Value> = app
        .state::<ContextBridge>()
        .snapshots
        .lock()
        .unwrap()
        .values()
        .filter_map(|p| {
            let e = p.get("editor")?.clone();
            let mut obj = e.as_object()?.clone();
            obj.insert("project".into(), p.get("name").cloned().unwrap_or_default());
            Some(serde_json::Value::Object(obj))
        })
        .collect();
    (
        StatusCode::OK,
        serde_json::json!({ "projects": states }).to_string(),
    )
}

/// The tool switches from Settings → Agents. Answered even when nothing has
/// been published (nothing disabled), so the sidecar can treat any error as
/// "everything is on" rather than hiding tools on a hiccup.
async fn tools(State(app): State<tauri::AppHandle>, headers: HeaderMap) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let disabled = app
        .state::<ContextBridge>()
        .disabled_tools
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_default();
    (
        StatusCode::OK,
        serde_json::json!({ "disabled": disabled }).to_string(),
    )
}

async fn claims_list(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let claims = app.state::<ContextBridge>().claims.lock().unwrap().clone();
    (
        StatusCode::OK,
        serde_json::json!({ "claims": claims }).to_string(),
    )
}

#[derive(serde::Deserialize)]
struct ClaimReq {
    /// claim | release
    action: String,
    #[serde(default)]
    paths: Vec<String>,
    owner: String,
    note: Option<String>,
}

/// Take or drop an advisory claim. A claim that overlaps someone else's is
/// refused with the holder's name: the point is to surface the collision at the
/// moment it would happen, while the agent can still pick different work.
async fn claims_post(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Json(req): Json<ClaimReq>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let bridge = app.state::<ContextBridge>();
    let msg = {
        let mut claims = bridge.claims.lock().unwrap();
        match req.action.as_str() {
            "release" => {
                let before = claims.len();
                claims.retain(|c| c.owner != req.owner);
                format!("Released {} claim(s).", before - claims.len())
            }
            "claim" => {
                if req.paths.is_empty() {
                    return (StatusCode::BAD_REQUEST, "claim needs paths".into());
                }
                let conflict = claims.iter().find(|c| {
                    c.owner != req.owner
                        && c.paths
                            .iter()
                            .any(|held| req.paths.iter().any(|want| paths_overlap(held, want)))
                });
                if let Some(c) = conflict {
                    return (
                        StatusCode::CONFLICT,
                        format!(
                            "{} already claimed {} ({}). Pick different files, or ask that agent \
                             to release them.",
                            c.owner,
                            c.paths.join(", "),
                            c.note.clone().unwrap_or_else(|| "no note".into())
                        ),
                    );
                }
                claims.retain(|c| c.owner != req.owner);
                claims.push(Claim {
                    paths: req.paths.clone(),
                    owner: req.owner.clone(),
                    note: req.note.clone(),
                    at_ms: now_ms(),
                });
                format!("Claimed {} path(s).", req.paths.len())
            }
            other => {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("unknown claim action: {other}"),
                )
            }
        }
    };
    let _ = app.emit("agent:claims", ());
    (StatusCode::OK, msg)
}

/// Same file, or one inside the other's directory — a claim on a directory
/// covers what's under it.
fn paths_overlap(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim_end_matches('/'), b.trim_end_matches('/'));
    a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Live CPU/memory for every Canopy terminal, with a per-process breakdown —
/// the same reading the status tray shows, served so an agent can see what a
/// build or dev server is costing (and which child process is the hog) without
/// a shell. Read straight from the monitor's latest tick.
async fn resources(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let stats = app
        .state::<crate::agents::StatsCache>()
        .0
        .lock()
        .unwrap()
        .clone();
    let terminals: Vec<serde_json::Value> = stats
        .iter()
        .map(|s| {
            serde_json::json!({
                "id": s.id,
                "title": s.title,
                "cwd": s.cwd,
                "cpuPercent": (s.total_cpu * 10.0).round() / 10.0,
                "memBytes": s.total_mem_bytes,
                "memHuman": human_bytes(s.total_mem_bytes),
                "ports": s.ports,
                "processes": s.procs.iter().map(|p| serde_json::json!({
                    "pid": p.pid,
                    "name": p.name,
                    "cmd": p.cmd,
                    "cpuPercent": (p.cpu * 10.0).round() / 10.0,
                    "memBytes": p.mem_bytes,
                    "memHuman": human_bytes(p.mem_bytes),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    (
        StatusCode::OK,
        serde_json::json!({ "terminals": terminals }).to_string(),
    )
}

fn human_bytes(n: u64) -> String {
    const U: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", U[i])
    }
}

/// A write the frontend has to perform (start a run command, open a preview
/// tab, restart a server): validated here against the published snapshots, then
/// handed to the UI over the app event bus. Kept an event (not a direct call)
/// because the target project's ProjectView owns the tab/PTY state — the same
/// path a phone-spawned PTY takes. Stopping is the exception: it's a pure
/// backend kill, done here directly. Best-effort by nature: the tool acks the
/// request, and the agent confirms with the read tools (canopy_project /
/// server output / resources).
#[derive(serde::Deserialize)]
struct Action {
    kind: String,
    /// The agent's cwd (the sidecar's), for routing to a project when no more
    /// specific target is given.
    cwd: Option<String>,
    /// start_server: the component directory + the run command's name.
    dir: Option<String>,
    command: Option<String>,
    /// open_preview: the localhost URL to open in the embedded browser.
    url: Option<String>,
    /// stop_server / restart_server / message_agent / job_done: the terminal
    /// id to act on.
    #[serde(rename = "ptyId")]
    pty_id: Option<u32>,
    /// open_file / show_diff: the file to put in front of the user, and where
    /// in it to land.
    path: Option<String>,
    line: Option<u32>,
    /// notify / message_agent: what to say.
    text: Option<String>,
    /// notify: info | success | warn | error.
    level: Option<String>,
    /// job_done: how the micro-task ended (done | blocked) and its one-line
    /// summary. The artifact URL, if any, rides in `url` above.
    status: Option<String>,
    summary: Option<String>,
    /// job_done: the launching app instance (env CANOPY_INSTANCE), so a pty id
    /// recycled across an app restart can't close an unrelated tab.
    instance: Option<String>,
}

async fn action(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Json(act): Json<Action>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let snaps = app.state::<ContextBridge>();
    let msg = match act.kind.as_str() {
        "start_server" => {
            let (Some(dir), Some(command)) = (act.dir.as_deref(), act.command.as_deref()) else {
                return (
                    StatusCode::BAD_REQUEST,
                    "start_server needs dir and command".into(),
                );
            };
            // Resolve the run command by name against the component's published
            // commands, so the agent can pass the friendly name and the UI gets
            // the exact command string to run — and an unknown one is rejected
            // now, with the valid list, instead of silently doing nothing.
            match resolve_command(&snaps, dir, command) {
                Ok(cmdline) => {
                    let _ = app.emit(
                        "agent:action",
                        serde_json::json!({
                            "kind": "start_server",
                            "route": dir,
                            "dir": dir,
                            "name": command,
                            "command": cmdline,
                        }),
                    );
                    format!("Starting \"{command}\" in {dir}. Give it a few seconds, then call canopy_project to see it listening and canopy_server_output for its logs.")
                }
                Err(e) => return (StatusCode::BAD_REQUEST, e),
            }
        }
        "open_preview" => {
            let Some(url) = act.url.as_deref() else {
                return (StatusCode::BAD_REQUEST, "open_preview needs a url".into());
            };
            if !is_local_http(url) {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("{url} isn't a local http:// URL — the preview only opens servers running on this machine"),
                );
            }
            let route = act.cwd.clone().unwrap_or_default();
            let _ = app.emit(
                "agent:action",
                serde_json::json!({ "kind": "open_preview", "route": route, "url": url }),
            );
            format!("Opened a preview of {url} in Canopy.")
        }
        "stop_server" => {
            let Some(id) = act.pty_id else {
                return (StatusCode::BAD_REQUEST, "stop_server needs ptyId".into());
            };
            // A pure backend kill — no UI state to thread, and the pty:exit it
            // triggers updates the tab on its own. Scoped to real Canopy ptys:
            // an id that isn't one is refused, not silently ignored.
            match app.state::<crate::pty::PtyManager>().kill(id) {
                Ok(()) => format!("Stopped terminal {id}."),
                Err(_) => {
                    return (
                        StatusCode::NOT_FOUND,
                        format!("No running Canopy terminal with id {id} (see canopy_project)"),
                    )
                }
            }
        }
        "restart_server" => {
            let Some(id) = act.pty_id else {
                return (StatusCode::BAD_REQUEST, "restart_server needs ptyId".into());
            };
            if app.state::<crate::pty::PtyManager>().get(id).is_none() {
                return (
                    StatusCode::NOT_FOUND,
                    format!("No running Canopy terminal with id {id} (see canopy_project)"),
                );
            }
            // Restart reuses the tab (and its command), which only the owning
            // ProjectView can do — route it there. `route` isn't a path here, so
            // App falls back to the single open project / broadcast by ptyId.
            let _ = app.emit(
                "agent:action",
                serde_json::json!({ "kind": "restart_server", "route": "", "ptyId": id }),
            );
            format!("Restarting terminal {id}. Call canopy_server_output shortly to watch it come back up.")
        }
        "job_done" => {
            let status = match act.status.as_deref() {
                Some(s @ ("done" | "blocked")) => s,
                _ => {
                    return (
                        StatusCode::BAD_REQUEST,
                        "job_done needs status: \"done\" (job complete) or \"blocked\" (you need the user)".into(),
                    )
                }
            };
            let Some(summary) = act.summary.as_deref().filter(|s| !s.trim().is_empty()) else {
                return (
                    StatusCode::BAD_REQUEST,
                    "job_done needs a summary — one sentence on what happened or what you need"
                        .into(),
                );
            };
            // A sidecar left over from a previous app launch can hold a pty id
            // that now names someone else's terminal: ack it, act on nothing.
            let stale = act
                .instance
                .as_deref()
                .is_some_and(|i| i != crate::pty::instance_token());
            if !stale {
                // Keyed by terminal like restart_server: route is empty, App
                // broadcasts, and the ProjectView owning the pty acts.
                let _ = app.emit(
                    "agent:action",
                    serde_json::json!({
                        "kind": "job_done",
                        "route": "",
                        "ptyId": act.pty_id,
                        "status": status,
                        "summary": summary,
                        "url": act.url,
                        "cwd": act.cwd,
                    }),
                );
            }
            match status {
                "done" => "Acknowledged — the user has been told. If this terminal is a Canopy micro-task it now closes: say goodbye in one sentence and start nothing new.".to_string(),
                _ => "Noted — Canopy told the user what you need. This session stays open; wait for their reply here.".to_string(),
            }
        }
        "open_file" | "show_diff" => {
            let Some(path) = act.path.as_deref() else {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("{} needs a path", act.kind),
                );
            };
            if !std::path::Path::new(path).is_file() {
                return (
                    StatusCode::NOT_FOUND,
                    format!("{path} isn't a file on this machine"),
                );
            }
            // The file's own directory routes it: an agent naming a path in a
            // project other than its cwd's still lands in the right window.
            let route = std::path::Path::new(path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| act.cwd.clone().unwrap_or_default());
            let _ = app.emit(
                "agent:action",
                serde_json::json!({
                    "kind": act.kind,
                    "route": route,
                    "path": path,
                    "line": act.line,
                }),
            );
            match (act.kind.as_str(), act.line) {
                ("show_diff", _) => format!("Showing {path} as a diff against git HEAD in Canopy."),
                (_, Some(l)) => format!("Opened {path} at line {l} in Canopy."),
                _ => format!("Opened {path} in Canopy."),
            }
        }
        "notify" => {
            let Some(text) = act.text.as_deref() else {
                return (StatusCode::BAD_REQUEST, "notify needs text".into());
            };
            let _ = app.emit(
                "agent:action",
                serde_json::json!({
                    "kind": "notify",
                    "route": act.cwd.clone().unwrap_or_default(),
                    "text": text,
                    "level": act.level.as_deref().unwrap_or("info"),
                }),
            );
            "Told the user.".to_string()
        }
        "message_agent" => {
            let (Some(id), Some(text)) = (act.pty_id, act.text.as_deref()) else {
                return (
                    StatusCode::BAD_REQUEST,
                    "message_agent needs ptyId and text".into(),
                );
            };
            // Straight into the other agent's stdin, exactly as if the user had
            // typed it — that IS the interface every agent CLI exposes. Newline
            // separate from the text so a multi-line message submits once.
            let manager = app.state::<crate::pty::PtyManager>();
            if manager.get(id).is_none() {
                return (
                    StatusCode::NOT_FOUND,
                    format!("No running Canopy terminal with id {id} (see canopy_agents)"),
                );
            }
            let body = text.replace(['\r', '\n'], " ");
            match manager.write(id, &format!("{body}\r")) {
                Ok(()) => format!(
                    "Sent to terminal {id}. It answers in its own session — read its reply with \
                     canopy_server_output({id})."
                ),
                Err(e) => return (StatusCode::BAD_REQUEST, e),
            }
        }
        other => return (StatusCode::BAD_REQUEST, format!("unknown action: {other}")),
    };
    (StatusCode::OK, msg)
}

/// A browser-control op (canopy_browser_* tools): drive the embedded preview —
/// navigate, snapshot the DOM, click, type, eval, read the console. Unlike
/// /ctx/action these are request/response: the op is handed to the UI with a
/// ticket id, the handler parks on a oneshot, and the frontend (ultimately the
/// script injected into the previewed page) answers through `browser_result`.
/// The network op short-circuits: the preview proxy already logs every request
/// it forwards, so it's answered here without a page round-trip.
#[derive(serde::Deserialize)]
struct BrowserOp {
    op: String,
    cwd: Option<String>,
    url: Option<String>,
    /// navigate: back | forward | reload (when no url is given).
    action: Option<String>,
    /// click / type: element address — a snapshot ref or a CSS selector.
    r#ref: Option<u64>,
    selector: Option<String>,
    /// type
    text: Option<String>,
    submit: Option<bool>,
    append: Option<bool>,
    /// point: what to call the thing being pointed at, shown on the cursor.
    label: Option<String>,
    /// eval
    code: Option<String>,
    /// console
    lines: Option<u64>,
    clear: Option<bool>,
    /// snapshot
    max: Option<u64>,
}

/// How long the app + page get to answer a browser op. Covers a preview tab
/// mounting and its page loading; the sidecar's own read timeout is longer.
const BROWSER_OP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

async fn browser(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Json(op): Json<BrowserOp>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    // Everything checkable without the page is checked here, so the agent gets
    // an immediate 4xx to correct against instead of a UI round-trip.
    match op.op.as_str() {
        "navigate" => match (&op.url, op.action.as_deref()) {
            (Some(u), _) if !is_local_http(u) => {
                return (
                        StatusCode::BAD_REQUEST,
                        format!("{u} isn't a local http:// URL — the preview only opens servers running on this machine"),
                    );
            }
            (Some(_), _) | (None, Some("back" | "forward" | "reload")) => {}
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    "navigate needs a url, or action = back | forward | reload".into(),
                )
            }
        },
        "click" | "type" | "point" => {
            if op.r#ref.is_none() && op.selector.is_none() {
                return (
                    StatusCode::BAD_REQUEST,
                    format!(
                        "{} needs a ref (from canopy_browser_snapshot) or a selector",
                        op.op
                    ),
                );
            }
            if op.op == "type" && op.text.is_none() {
                return (StatusCode::BAD_REQUEST, "type needs text".into());
            }
        }
        "eval" => {
            if op.code.as_deref().map_or(true, |c| c.trim().is_empty()) {
                return (StatusCode::BAD_REQUEST, "eval needs code".into());
            }
        }
        "snapshot" | "console" | "screenshot" => {}
        "network" => return network_response(&app, op.url.as_deref()),
        other => {
            return (
                StatusCode::BAD_REQUEST,
                format!("unknown browser op: {other}"),
            )
        }
    }

    let bridge = app.state::<ContextBridge>();
    let id = bridge.next_op.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    bridge.pending.lock().unwrap().insert(id, tx);

    let _ = app.emit(
        "agent:browser",
        serde_json::json!({
            "id": id,
            "op": op.op,
            "route": op.cwd.clone().unwrap_or_default(),
            "url": op.url,
            "action": op.action,
            "ref": op.r#ref,
            "selector": op.selector,
            "text": op.text,
            "label": op.label,
            "submit": op.submit,
            "append": op.append,
            "code": op.code,
            "lines": op.lines,
            "clear": op.clear,
            "max": op.max,
        }),
    );

    match tokio::time::timeout(BROWSER_OP_TIMEOUT, rx).await {
        Ok(Ok((true, data))) => (StatusCode::OK, body_text(data)),
        Ok(Ok((false, data))) => (StatusCode::BAD_REQUEST, body_text(data)),
        // Sender dropped without answering — shouldn't happen, but don't hang.
        Ok(Err(_)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "the preview dropped this request".into(),
        ),
        Err(_) => {
            app.state::<ContextBridge>()
                .pending
                .lock()
                .unwrap()
                .remove(&id);
            (
                StatusCode::GATEWAY_TIMEOUT,
                "The preview didn't answer in time. The page may still be loading, or the \
                 Canopy window may be busy — try again, or call canopy_project to check the \
                 server is running."
                    .into(),
            )
        }
    }
}

/// The request/response ops that need something only the running UI can answer:
/// the language server it keeps warm (diagnostics, references, definition), the
/// trackers it holds keys for (tickets, reviews), a question put to the user, a
/// picture of the previewed page. Same ticket/oneshot machinery as the browser
/// ops — the frontend answers through `browser_result` — but with a per-op
/// deadline, because "ask the user" and "read a marker" are not the same wait.
#[derive(serde::Deserialize)]
struct UiOp {
    op: String,
    cwd: Option<String>,
    /// diagnostics / references / definition: where to look.
    path: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
    symbol: Option<String>,
    /// ask: the question, its options, and how long the agent will hold.
    question: Option<String>,
    #[serde(default)]
    options: Vec<String>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
}

const UI_OP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// A question waits on a human, so it gets minutes — bounded so a forgotten
/// dialog can't pin an agent forever.
const MAX_ASK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

async fn ui_op(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Json(op): Json<UiOp>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let deadline = match op.op.as_str() {
        "diagnostics" | "tickets" | "reviews" => UI_OP_TIMEOUT,
        "references" | "definition" => {
            if op.path.is_none() {
                return (StatusCode::BAD_REQUEST, format!("{} needs a path", op.op));
            }
            if op.symbol.is_none() && op.line.is_none() {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("{} needs a symbol, or a line and column", op.op),
                );
            }
            UI_OP_TIMEOUT
        }
        "ask" => {
            if op.question.as_deref().map_or(true, |q| q.trim().is_empty()) {
                return (StatusCode::BAD_REQUEST, "ask needs a question".into());
            }
            op.timeout_ms
                .map(std::time::Duration::from_millis)
                .unwrap_or(std::time::Duration::from_secs(120))
                .min(MAX_ASK_TIMEOUT)
        }
        other => return (StatusCode::BAD_REQUEST, format!("unknown ui op: {other}")),
    };

    let bridge = app.state::<ContextBridge>();
    let id = bridge.next_op.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    bridge.pending.lock().unwrap().insert(id, tx);

    let _ = app.emit(
        "agent:ui",
        serde_json::json!({
            "id": id,
            "op": op.op,
            "route": op.cwd.clone().unwrap_or_default(),
            "path": op.path,
            "line": op.line,
            "column": op.column,
            "symbol": op.symbol,
            "question": op.question,
            "options": op.options,
        }),
    );

    match tokio::time::timeout(deadline, rx).await {
        Ok(Ok((true, data))) => (StatusCode::OK, body_text(data)),
        Ok(Ok((false, data))) => (StatusCode::BAD_REQUEST, body_text(data)),
        Ok(Err(_)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Canopy dropped this request".into(),
        ),
        Err(_) => {
            app.state::<ContextBridge>()
                .pending
                .lock()
                .unwrap()
                .remove(&id);
            let why = if op.op == "ask" {
                "The user didn't answer in time — carry on without them, or ask again."
            } else {
                "Canopy didn't answer in time. The window may be busy, or the language server \
                 may still be warming up — try again."
            };
            (StatusCode::GATEWAY_TIMEOUT, why.into())
        }
    }
}

/// Block until a terminal does something worth waking up for: prints a matching
/// line, starts listening on a port, or goes quiet. The alternative is the agent
/// polling canopy_server_output in a loop, which costs a turn and a few hundred
/// tokens per look — the supervisor can just wait.
#[derive(serde::Deserialize)]
struct WaitParams {
    server: u32,
    /// Substring to wait for in new output (case-insensitive).
    pattern: Option<String>,
    /// listening | idle | output (default: pattern when given, else listening).
    until: Option<String>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    /// idle: how long the output must stay quiet to count.
    #[serde(rename = "idleMs")]
    idle_ms: Option<u64>,
}

const WAIT_POLL: std::time::Duration = std::time::Duration::from_millis(250);

async fn wait(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Query(p): Query<WaitParams>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let ptys = app.state::<crate::pty::PtyManager>();
    let read = |id: u32| {
        ptys.scrollback_tail(id, MAX_OUTPUT_BYTES)
            .map(|b| strip_ansi(&b))
    };
    let Some(initial) = read(p.server) else {
        return (
            StatusCode::NOT_FOUND,
            format!(
                "no running terminal with id {} — it may have exited",
                p.server
            ),
        );
    };
    let until = p.until.clone().unwrap_or_else(|| {
        if p.pattern.is_some() {
            "output".into()
        } else {
            "listening".into()
        }
    });
    let timeout =
        std::time::Duration::from_millis(p.timeout_ms.unwrap_or(60_000).clamp(1_000, 600_000));
    let idle_for = std::time::Duration::from_millis(p.idle_ms.unwrap_or(2_000).clamp(200, 60_000));
    let needle = p.pattern.as_deref().map(str::to_lowercase);

    // Everything is measured against what was already on screen when the call
    // arrived, so a pattern that matched an hour ago doesn't return instantly.
    let mut base = initial.chars().count();
    let mut last_len = base;
    let mut last_change = std::time::Instant::now();
    let started = std::time::Instant::now();

    loop {
        let Some(text) = read(p.server) else {
            return (
                StatusCode::OK,
                format!("Terminal {} exited while waiting.", p.server),
            );
        };
        let len = text.chars().count();
        // Scrollback rolls; when it does, the old offset points past the start.
        if len < base {
            base = 0;
        }
        if len != last_len {
            last_len = len;
            last_change = std::time::Instant::now();
        }
        let fresh: String = text.chars().skip(base).collect();

        match until.as_str() {
            "output" => {
                if let Some(n) = &needle {
                    if let Some(line) = fresh
                        .lines()
                        .find(|l| l.to_lowercase().contains(n.as_str()))
                    {
                        return (
                            StatusCode::OK,
                            format!(
                                "Matched after {:.1}s:\n{line}\n\n--- new output ---\n{}",
                                started.elapsed().as_secs_f32(),
                                tail_lines(&fresh, 40)
                            ),
                        );
                    }
                } else if !fresh.trim().is_empty() {
                    return (
                        StatusCode::OK,
                        format!(
                            "New output after {:.1}s:\n{}",
                            started.elapsed().as_secs_f32(),
                            tail_lines(&fresh, 40)
                        ),
                    );
                }
            }
            "listening" => {
                let ports: Vec<u16> = app
                    .state::<crate::agents::StatsCache>()
                    .0
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|s| s.id == p.server)
                    .map(|s| s.ports.clone())
                    .unwrap_or_default();
                if !ports.is_empty() {
                    return (
                        StatusCode::OK,
                        format!(
                            "Terminal {} is listening on {} after {:.1}s. Open it with \
                             canopy_browser_navigate (http://localhost:{}).",
                            p.server,
                            ports
                                .iter()
                                .map(|x| x.to_string())
                                .collect::<Vec<_>>()
                                .join(", "),
                            started.elapsed().as_secs_f32(),
                            ports[0]
                        ),
                    );
                }
            }
            "idle" => {
                if last_change.elapsed() >= idle_for {
                    return (
                        StatusCode::OK,
                        format!(
                            "Quiet for {:.1}s (waited {:.1}s). Last output:\n{}",
                            last_change.elapsed().as_secs_f32(),
                            started.elapsed().as_secs_f32(),
                            tail_lines(&text, 40)
                        ),
                    );
                }
            }
            other => {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("unknown wait target: {other} (use output | listening | idle)"),
                )
            }
        }

        if started.elapsed() >= timeout {
            return (
                StatusCode::OK,
                format!(
                    "Gave up after {:.0}s waiting for {until}{}. Last output:\n{}",
                    timeout.as_secs_f32(),
                    needle
                        .as_ref()
                        .map(|n| format!(" matching \"{n}\""))
                        .unwrap_or_default(),
                    tail_lines(&text, 40)
                ),
            );
        }
        tokio::time::sleep(WAIT_POLL).await;
    }
}

fn tail_lines(text: &str, n: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(n)..].join("\n")
}

/// A result payload as an HTTP body: strings verbatim, JSON otherwise.
fn body_text(data: serde_json::Value) -> String {
    match data {
        serde_json::Value::String(s) => s,
        other => other.to_string(),
    }
}

/// The preview proxy's request log — served straight from PreviewManager.
fn network_response(app: &tauri::AppHandle, url: Option<&str>) -> (StatusCode, String) {
    let previews = app.state::<crate::preview::PreviewManager>();
    let origin = match url {
        Some(u) => match origin_of(u) {
            Some(o) => Some(o),
            None => return (StatusCode::BAD_REQUEST, format!("not an http:// URL: {u}")),
        },
        None => None,
    };
    match previews.network_log(origin.as_deref(), 100) {
        Some(log) => (StatusCode::OK, log.to_string()),
        None => {
            let running = previews.origins();
            let hint = if running.is_empty() {
                "no preview is open — open one with canopy_browser_navigate first".to_string()
            } else {
                format!("previews are open for: {}", running.join(", "))
            };
            (
                StatusCode::NOT_FOUND,
                format!(
                    "no preview proxy for {} ({hint})",
                    origin.unwrap_or_default()
                ),
            )
        }
    }
}

#[derive(serde::Deserialize)]
struct NetworkParams {
    url: Option<String>,
}

async fn network(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Query(params): Query<NetworkParams>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    network_response(&app, params.url.as_deref())
}

/// `http://host:port/...` → `http://host:port` (the proxy map's key shape).
fn origin_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("http://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    Some(format!("http://{authority}"))
}

/// Look up a component's run command by name in the published snapshots,
/// returning its command line. Errs (with the available names) when the
/// directory isn't a known component or the name isn't one of its commands.
fn resolve_command(bridge: &ContextBridge, dir: &str, name: &str) -> Result<String, String> {
    let snaps = bridge.snapshots.lock().unwrap();
    for project in snaps.values() {
        let Some(components) = project.get("components").and_then(|c| c.as_array()) else {
            continue;
        };
        for comp in components {
            if comp.get("path").and_then(|p| p.as_str()) != Some(dir) {
                continue;
            }
            let commands = comp.get("commands").and_then(|c| c.as_array());
            let names: Vec<&str> = commands
                .into_iter()
                .flatten()
                .filter_map(|c| c.get("name").and_then(|n| n.as_str()))
                .collect();
            let found = comp
                .get("commands")
                .and_then(|c| c.as_array())
                .into_iter()
                .flatten()
                .find(|c| c.get("name").and_then(|n| n.as_str()) == Some(name))
                .and_then(|c| c.get("command").and_then(|v| v.as_str()));
            return match found {
                Some(cmd) => Ok(cmd.to_string()),
                None => Err(format!(
                    "\"{name}\" isn't a run command of {dir}. Configured commands: {}",
                    if names.is_empty() {
                        "(none)".into()
                    } else {
                        names.join(", ")
                    }
                )),
            };
        }
    }
    Err(format!(
        "{dir} isn't a component of any open Canopy project (call canopy_project for the list)"
    ))
}

/// A URL the embedded preview will accept: http(s) on a loopback host.
fn is_local_http(url: &str) -> bool {
    let rest = match url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
    {
        Some(r) => r,
        None => return false,
    };
    let host = rest.split(['/', ':', '?', '#']).next().unwrap_or("");
    matches!(
        host,
        "localhost" | "127.0.0.1" | "0.0.0.0" | "[::1]" | "::1"
    )
}

#[derive(serde::Deserialize)]
struct OutputParams {
    lines: Option<usize>,
}

async fn server_output(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<u32>,
    Query(params): Query<OutputParams>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let Some(raw) = app
        .state::<crate::pty::PtyManager>()
        .scrollback_tail(id, MAX_OUTPUT_BYTES)
    else {
        return (
            StatusCode::NOT_FOUND,
            format!("no running terminal with id {id} — it may have exited"),
        );
    };
    let text = strip_ansi(&raw);
    let lines = params.lines.unwrap_or(200).clamp(1, 5000);
    let tail: Vec<&str> = {
        let all: Vec<&str> = text.lines().collect();
        all[all.len().saturating_sub(lines)..].to_vec()
    };
    (StatusCode::OK, tail.join("\n"))
}

#[derive(serde::Deserialize)]
struct FilesParams {
    dir: String,
    max: Option<usize>,
}

async fn files(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Query(params): Query<FilesParams>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    // Only directories the workspace actually contains: the bridge must not be
    // a token-gated read of arbitrary paths. A published component (or a
    // subdirectory of one) is in scope; anything else is refused.
    let dir = std::path::PathBuf::from(&params.dir);
    let allowed = {
        let bridge = app.state::<ContextBridge>();
        let snaps = bridge.snapshots.lock().unwrap();
        snaps.values().any(|p| {
            p.get("components")
                .and_then(|c| c.as_array())
                .is_some_and(|comps| {
                    comps.iter().any(|c| {
                        c.get("path")
                            .and_then(|p| p.as_str())
                            .is_some_and(|root| dir.starts_with(root))
                    })
                })
        })
    };
    if !allowed {
        return (
            StatusCode::FORBIDDEN,
            format!(
                "{} is not inside any component of an open Canopy project",
                params.dir
            ),
        );
    }
    let max = params.max.unwrap_or(MAX_FILES_DEFAULT).clamp(1, 5000);
    let (list, truncated) = walk(&dir, max);
    (
        StatusCode::OK,
        serde_json::json!({ "files": list, "truncated": truncated }).to_string(),
    )
}

/// Breadth-first file walk, relative paths, ignore-list applied. BFS so a cap
/// hit still yields the shallow (orienting) layers rather than one deep corner.
fn walk(root: &std::path::Path, max: usize) -> (Vec<String>, bool) {
    let mut out = Vec::new();
    let mut queue = std::collections::VecDeque::from([root.to_path_buf()]);
    while let Some(dir) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    queue.push_back(path);
                }
                continue;
            }
            if out.len() >= max {
                return (out, true);
            }
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().to_string());
            }
        }
    }
    (out, false)
}

/// Terminal output minus the terminal: CSI/OSC escape sequences and carriage
/// returns dropped, so agents read text, not control codes.
fn strip_ansi(bytes: &[u8]) -> String {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            i += 1;
            match bytes.get(i) {
                // CSI: parameters then one final byte in 0x40..=0x7e.
                Some(b'[') => {
                    i += 1;
                    while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                        i += 1;
                    }
                    i += 1;
                }
                // OSC: until BEL or ST (ESC \).
                Some(b']') => {
                    i += 1;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                // Two-byte escapes (charset selection etc.).
                Some(_) => i += 1,
                None => {}
            }
            continue;
        }
        if b != b'\r' {
            out.push(b);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_drops_csi_osc_and_cr() {
        let input = b"\x1b[31mred\x1b[0m plain\r\n\x1b]0;title\x07next\n\x1b[2K\x1b[1Gprompt";
        assert_eq!(strip_ansi(input), "red plain\nnext\nprompt");
    }

    #[test]
    fn strip_ansi_passes_utf8_through() {
        assert_eq!(strip_ansi("héllo → wörld".as_bytes()), "héllo → wörld");
    }

    #[test]
    fn walk_caps_and_skips_dependency_dirs() {
        let root = std::env::temp_dir().join(format!("canopy-ctx-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/dep")).unwrap();
        std::fs::write(root.join("a.txt"), "x").unwrap();
        std::fs::write(root.join("src/b.txt"), "x").unwrap();
        std::fs::write(root.join("node_modules/dep/c.txt"), "x").unwrap();

        let (files, truncated) = walk(&root, 10);
        assert!(!truncated);
        assert_eq!(files, vec!["a.txt".to_string(), "src/b.txt".into()]);

        let (files, truncated) = walk(&root, 1);
        assert!(truncated);
        assert_eq!(files.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn claims_collide_on_containment_not_just_equality() {
        assert!(paths_overlap("/w/src/auth.ts", "/w/src/auth.ts"));
        // A directory claim covers what's under it, in both directions —
        // otherwise claiming a folder would silently permit claiming its files.
        assert!(paths_overlap("/w/src", "/w/src/auth.ts"));
        assert!(paths_overlap("/w/src/auth.ts", "/w/src"));
        assert!(paths_overlap("/w/src/", "/w/src"));
        // Neighbours with a shared prefix are not the same directory.
        assert!(!paths_overlap("/w/src", "/w/srcs/a.ts"));
        assert!(!paths_overlap("/w/src/a.ts", "/w/src/b.ts"));
    }

    #[test]
    fn tail_lines_returns_the_end_and_survives_short_input() {
        let text = (1..=10)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(tail_lines(&text, 3), "8\n9\n10");
        assert_eq!(tail_lines("only", 5), "only");
        assert_eq!(tail_lines("", 5), "");
    }
}

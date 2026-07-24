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
use axum::routing::get;
use axum::Router;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

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
}

impl Default for ContextBridge {
    fn default() -> Self {
        let mut bytes = [0u8; 16];
        let _ = getrandom::getrandom(&mut bytes);
        Self {
            snapshots: Mutex::new(HashMap::new()),
            port: OnceLock::new(),
            token: hex::encode(bytes),
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
}

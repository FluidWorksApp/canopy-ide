//! LSP subprocess bridge: spawn a language server over stdio, parse LSP
//! Content-Length framing in Rust, and shuttle complete JSON messages to/from the
//! WebView over a Channel. monaco-languageclient in the WebView talks to this via
//! a custom MessageTransports (no WebSocket, no Node sidecar for the bridge).
//!
//! Adding a language = one more `lsp_start` call with a different command.

use crate::winproc::NoConsoleWindow;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

pub struct LspServer {
    stdin: Mutex<std::process::ChildStdin>,
    child: Mutex<Child>,
}

#[derive(Default)]
pub struct LspManager {
    servers: Arc<Mutex<HashMap<u32, Arc<LspServer>>>>,
    next_id: AtomicU32,
}

impl LspManager {
    pub fn kill_all(&self) {
        for (_, server) in self.servers.lock().unwrap().drain() {
            let mut child = server.child.lock().unwrap();
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// GUI apps on macOS don't inherit the user's shell PATH; resolve commands the
/// way a login shell would when a bare name isn't directly spawnable.
fn resolve_command(cmd: &str) -> String {
    if cmd.contains('/') || which_in_path(cmd) {
        return cmd.to_string();
    }
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        if let Ok(out) = Command::new(shell)
            .args(["-lc", &format!("command -v {cmd}")])
            .output()
        {
            if out.status.success() {
                let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !path.is_empty() {
                    return path;
                }
            }
        }
    }
    cmd.to_string()
}

fn which_in_path(cmd: &str) -> bool {
    std::env::var("PATH")
        .map(|path| {
            std::env::split_paths(&path).any(|dir| dir.join(cmd).is_file())
        })
        .unwrap_or(false)
}

#[tauri::command]
pub fn lsp_start(
    app: AppHandle,
    state: State<'_, LspManager>,
    command: String,
    args: Vec<String>,
    root: String,
    on_message: Channel<String>,
) -> Result<u32, String> {
    let resolved = resolve_command(&command);
    let mut child = Command::new(&resolved)
        .no_console_window()
        .args(&args)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn {resolved}: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    let server = Arc::new(LspServer {
        stdin: Mutex::new(stdin),
        child: Mutex::new(child),
    });
    state.servers.lock().unwrap().insert(id, server);

    // Reader thread: parse Content-Length framing, forward complete JSON bodies.
    let servers = state.servers.clone();
    thread::Builder::new()
        .name(format!("lsp-reader-{id}"))
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut content_length: Option<usize> = None;
                // Headers
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => {
                            cleanup(&servers, id);
                            let _ = app.emit("lsp:exit", id);
                            return;
                        }
                        Ok(_) => {}
                    }
                    let line = line.trim_end();
                    if line.is_empty() {
                        break;
                    }
                    if let Some(v) = line.strip_prefix("Content-Length:") {
                        content_length = v.trim().parse().ok();
                    }
                }
                let Some(len) = content_length else { continue };
                let mut body = vec![0u8; len];
                if reader.read_exact(&mut body).is_err() {
                    cleanup(&servers, id);
                    let _ = app.emit("lsp:exit", id);
                    return;
                }
                if let Ok(text) = String::from_utf8(body) {
                    if on_message.send(text).is_err() {
                        cleanup(&servers, id);
                        return;
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(id)
}

fn cleanup(servers: &Arc<Mutex<HashMap<u32, Arc<LspServer>>>>, id: u32) {
    if let Some(server) = servers.lock().unwrap().remove(&id) {
        let mut child = server.child.lock().unwrap();
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tauri::command]
pub fn lsp_send(state: State<'_, LspManager>, id: u32, message: String) -> Result<(), String> {
    let server = state
        .servers
        .lock()
        .unwrap()
        .get(&id)
        .cloned()
        .ok_or_else(|| format!("no lsp server {id}"))?;
    let mut stdin = server.stdin.lock().unwrap();
    let framed = format!("Content-Length: {}\r\n\r\n{}", message.len(), message);
    stdin.write_all(framed.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn lsp_stop(state: State<'_, LspManager>, id: u32) -> Result<(), String> {
    cleanup(&state.servers, id);
    Ok(())
}

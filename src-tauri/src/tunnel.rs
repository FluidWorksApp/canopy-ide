//! Public-link tunnels for Canopy Remote. Exposes the local portal port to the
//! internet via a user-chosen provider so the portal loads from any browser with
//! no router config:
//!   - Cloudflare (`cloudflared`) — no account, instant https://…trycloudflare.com
//!   - ngrok — https://…ngrok-free.app (needs an authtoken)
//!   - Tailscale Funnel (`tailscale funnel`) — https://…ts.net (needs Funnel on)
//!
//! Modeled on lsp.rs: spawn the provider CLI, scan its stdout+stderr line by line
//! for the public URL, publish state, and kill it on demand and on app exit.

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct TunnelManager {
    child: Arc<Mutex<Option<Child>>>,
    /// The current reported state, so `tunnel_status` can answer after a reload.
    last: Arc<Mutex<TunnelState>>,
}

#[derive(Serialize, Clone, Default)]
pub struct TunnelState {
    pub running: bool,
    pub provider: Option<String>,
    /// The public URL, once discovered.
    pub url: Option<String>,
    /// Progress or an error explanation.
    pub message: Option<String>,
}

impl TunnelManager {
    /// Kill the tunnel process (called on stop and on app exit).
    pub fn kill_all(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// (binary, args, extra env) for a provider pointed at `port`.
fn spec(
    provider: &str,
    port: u16,
    token: Option<&str>,
) -> Option<(&'static str, Vec<String>, Vec<(String, String)>)> {
    match provider {
        "cloudflare" => Some((
            "cloudflared",
            vec![
                "tunnel".into(),
                "--url".into(),
                format!("http://localhost:{port}"),
            ],
            vec![],
        )),
        "ngrok" => {
            let mut env = vec![];
            if let Some(t) = token {
                if !t.is_empty() {
                    env.push(("NGROK_AUTHTOKEN".into(), t.to_string()));
                }
            }
            Some((
                "ngrok",
                vec![
                    "http".into(),
                    port.to_string(),
                    "--log".into(),
                    "stdout".into(),
                ],
                env,
            ))
        }
        "tailscale" => Some(("tailscale", vec!["funnel".into(), port.to_string()], vec![])),
        _ => None,
    }
}

/// The public URL each provider prints. We scan for an https token containing
/// the provider's host so a single matcher handles cloudflared's boxed output,
/// ngrok's JSON log lines, and tailscale's "Available on the internet" line.
fn extract_url(provider: &str, line: &str) -> Option<String> {
    let host = match provider {
        "cloudflare" => "trycloudflare.com",
        "ngrok" => "ngrok",
        "tailscale" => "ts.net",
        _ => return None,
    };
    line.split(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '\\')
        .find(|tok| tok.starts_with("https://") && tok.contains(host))
        .map(|tok| tok.trim_end_matches(['.', ',', ')']).to_string())
}

/// Resolve a bare command via the login shell (GUI apps don't inherit PATH).
fn resolve_command(cmd: &str) -> String {
    #[cfg(unix)]
    {
        let in_path = std::env::var("PATH")
            .map(|p| std::env::split_paths(&p).any(|d| d.join(cmd).is_file()))
            .unwrap_or(false);
        if !in_path {
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
    }
    cmd.to_string()
}

fn set_and_emit(app: &AppHandle, last: &Arc<Mutex<TunnelState>>, state: TunnelState) {
    *last.lock().unwrap() = state.clone();
    let _ = app.emit("tunnel:state", state);
}

#[tauri::command]
pub fn tunnel_start(
    app: AppHandle,
    state: State<'_, TunnelManager>,
    provider: String,
    port: u16,
    token: Option<String>,
) -> Result<TunnelState, String> {
    state.kill_all();

    let Some((bin, args, envs)) = spec(&provider, port, token.as_deref()) else {
        return Err(format!("unknown provider {provider}"));
    };
    let resolved = resolve_command(bin);
    let mut cmd = Command::new(&resolved);
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in &envs {
        cmd.env(k, v);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Couldn't start {bin}: {e}. Is it installed?"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *state.child.lock().unwrap() = Some(child);

    let starting = TunnelState {
        running: true,
        provider: Some(provider.clone()),
        url: None,
        message: Some("Starting…".into()),
    };
    set_and_emit(&app, &state.last, starting.clone());

    // Shared across both stream readers.
    let found = Arc::new(AtomicBool::new(false));
    let open = Arc::new(AtomicUsize::new(2));
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));

    let mut spawn_reader = |stream: Option<Box<dyn Read + Send>>| {
        let Some(stream) = stream else {
            open.fetch_sub(1, Ordering::SeqCst);
            return;
        };
        let app = app.clone();
        let provider = provider.clone();
        let last = state.last.clone();
        let child_slot = state.child.clone();
        let found = found.clone();
        let open = open.clone();
        let tail = tail.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                {
                    let mut t = tail.lock().unwrap();
                    t.push(line.clone());
                    let overflow = t.len().saturating_sub(12);
                    if overflow > 0 {
                        t.drain(0..overflow);
                    }
                }
                if let Some(url) = extract_url(&provider, &line) {
                    if !found.swap(true, Ordering::SeqCst) {
                        set_and_emit(
                            &app,
                            &last,
                            TunnelState {
                                running: true,
                                provider: Some(provider.clone()),
                                url: Some(url),
                                message: None,
                            },
                        );
                    }
                }
            }
            // This stream closed (usually the process exiting).
            if open.fetch_sub(1, Ordering::SeqCst) == 1 && !found.load(Ordering::SeqCst) {
                // Both streams done and no URL — the provider failed to start.
                let msg = {
                    let t = tail.lock().unwrap();
                    let joined = t.join("\n");
                    if joined.trim().is_empty() {
                        format!("{provider} exited before publishing a URL.")
                    } else {
                        joined
                    }
                };
                // Reap the dead child.
                if let Some(mut c) = child_slot.lock().unwrap().take() {
                    let _ = c.wait();
                }
                set_and_emit(
                    &app,
                    &last,
                    TunnelState {
                        running: false,
                        provider: Some(provider.clone()),
                        url: None,
                        message: Some(msg),
                    },
                );
            }
        });
    };
    spawn_reader(stdout.map(|s| Box::new(s) as Box<dyn Read + Send>));
    spawn_reader(stderr.map(|s| Box::new(s) as Box<dyn Read + Send>));

    Ok(starting)
}

#[tauri::command]
pub fn tunnel_stop(app: AppHandle, state: State<'_, TunnelManager>) -> Result<TunnelState, String> {
    state.kill_all();
    let off = TunnelState::default();
    *state.last.lock().unwrap() = off.clone();
    let _ = app.emit("tunnel:state", off.clone());
    Ok(off)
}

#[tauri::command]
pub fn tunnel_status(state: State<'_, TunnelManager>) -> TunnelState {
    state.last.lock().unwrap().clone()
}

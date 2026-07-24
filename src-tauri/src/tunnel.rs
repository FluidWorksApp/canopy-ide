//! Public-link tunnels for Canopy Remote. Exposes the local portal port to the
//! internet via a user-chosen provider so the portal loads from any browser with
//! no router config:
//!   - Cloudflare (`cloudflared`) — no account, instant https://…trycloudflare.com
//!   - ngrok — https://…ngrok-free.app (needs an authtoken)
//!   - Tailscale Funnel (`tailscale funnel`) — https://…ts.net (needs Funnel on)
//!
//! Modeled on lsp.rs: spawn the provider CLI, scan its stdout+stderr line by line
//! for the public URL, publish state, and kill it on demand and on app exit.

use crate::winproc::NoConsoleWindow;
use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
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
    let starting = TunnelState {
        running: true,
        provider: Some(provider.clone()),
        url: None,
        message: Some("Starting…".into()),
    };
    set_and_emit(&app, &state.last, starting.clone());
    launch(
        app,
        state.child.clone(),
        state.last.clone(),
        provider,
        resolved,
        args,
        envs,
        true,
    );
    Ok(starting)
}

/// Spawn the provider process and scan its output for the public URL and, for
/// cloudflare, the edge-registration line. Recurses once (with http2) as the
/// QUIC fallback. Takes cloned `Arc`s rather than `State` so it can move them
/// into the reader/watchdog threads and call itself.
#[allow(clippy::too_many_arguments)]
fn launch(
    app: AppHandle,
    child_slot: Arc<Mutex<Option<Child>>>,
    last: Arc<Mutex<TunnelState>>,
    provider: String,
    resolved_bin: String,
    args: Vec<String>,
    envs: Vec<(String, String)>,
    allow_http2_retry: bool,
) {
    let mut cmd = Command::new(&resolved_bin);
    cmd.no_console_window();
    cmd.args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (k, v) in &envs {
        cmd.env(k, v);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            set_and_emit(
                &app,
                &last,
                TunnelState {
                    running: false,
                    provider: Some(provider.clone()),
                    url: None,
                    message: Some(format!(
                        "Couldn't start {resolved_bin}: {e}. Is it installed?"
                    )),
                },
            );
            return;
        }
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    *child_slot.lock().unwrap() = Some(child);

    let is_cf = provider == "cloudflare";
    // The URL, once seen; the edge-registration, once confirmed. For cloudflare
    // these are distinct events (the URL prints ~1s before the tunnel registers,
    // and cloudflared itself warns the link "may take some time to be
    // reachable") — so we only hand over a *ready* URL after registration, never
    // the premature one that NXDOMAINs when clicked. Other providers print their
    // URL only once it's live, so URL == registered for them.
    let url_slot = Arc::new(Mutex::new(Option::<String>::None));
    let registered = Arc::new(AtomicBool::new(false));
    let open = Arc::new(AtomicUsize::new(2));
    let tail = Arc::new(Mutex::new(Vec::<String>::new()));

    let mut spawn_reader = |stream: Option<Box<dyn Read + Send>>| {
        let Some(stream) = stream else {
            open.fetch_sub(1, Ordering::SeqCst);
            return;
        };
        let app = app.clone();
        let provider = provider.clone();
        let last = last.clone();
        let child_slot = child_slot.clone();
        let url_slot = url_slot.clone();
        let registered = registered.clone();
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
                if url_slot.lock().unwrap().is_none() {
                    if let Some(url) = extract_url(&provider, &line) {
                        *url_slot.lock().unwrap() = Some(url.clone());
                        if is_cf {
                            // Hold it as "connecting" until the edge registers.
                            set_and_emit(
                                &app,
                                &last,
                                TunnelState {
                                    running: true,
                                    provider: Some(provider.clone()),
                                    url: None,
                                    message: Some(format!(
                                        "Link created — connecting to Cloudflare's edge (a few seconds)…\n{url}"
                                    )),
                                },
                            );
                        } else {
                            registered.store(true, Ordering::SeqCst);
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
                // The tunnel is actually up now — publish the URL as ready.
                if is_cf
                    && line.contains("Registered tunnel connection")
                    && !registered.swap(true, Ordering::SeqCst)
                {
                    if let Some(url) = url_slot.lock().unwrap().clone() {
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
            // This stream closed (usually the process exiting). No URL ever ⇒ it
            // failed to start; surface the tail so the reason is visible.
            if open.fetch_sub(1, Ordering::SeqCst) == 1 && url_slot.lock().unwrap().is_none() {
                let msg = {
                    let t = tail.lock().unwrap();
                    let joined = t.join("\n");
                    if joined.trim().is_empty() {
                        format!("{provider} exited before publishing a URL.")
                    } else {
                        joined
                    }
                };
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

    // QUIC watchdog. Quick tunnels default to QUIC (UDP :7844); a network that
    // blocks it prints a URL that never registers and NXDOMAINs forever. If
    // nothing registers within the window, retry once over http2 (TCP :443),
    // which those networks allow. Only the first attempt gets a watchdog.
    if is_cf && allow_http2_retry {
        let app = app.clone();
        let last = last.clone();
        let child_slot = child_slot.clone();
        let registered = registered.clone();
        let provider = provider.clone();
        let resolved_bin = resolved_bin.clone();
        let mut retry_args = args.clone();
        let retry_envs = envs.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_secs(12));
            if registered.load(Ordering::SeqCst) {
                return;
            }
            if let Some(mut c) = child_slot.lock().unwrap().take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            retry_args.push("--protocol".into());
            retry_args.push("http2".into());
            set_and_emit(
                &app,
                &last,
                TunnelState {
                    running: true,
                    provider: Some(provider.clone()),
                    url: None,
                    message: Some(
                        "Cloudflare's edge didn't answer over QUIC (UDP may be blocked) — retrying over http2…".into(),
                    ),
                },
            );
            launch(
                app,
                child_slot,
                last,
                provider,
                resolved_bin,
                retry_args,
                retry_envs,
                false,
            );
        });
    }
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

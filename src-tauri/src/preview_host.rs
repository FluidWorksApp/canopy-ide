//! The preview browser: a real headless Chromium on this computer, owned by a
//! Node process (`packages/remote-host/preview-host.mjs`, T3 Code's server
//! browser on the pieces Canopy already ported), streamed into preview tabs.
//! Cookies are first-party and the profile persists, so logins hold.
//!
//! This module only starts and stops that process. It is started once, on the
//! first preview that asks, and lives until the app exits, because cookies
//! without an expiry die when Chromium exits. The process prints one JSON line,
//! `{port, token}` or `{code, error}`, listens on loopback only, and shuts
//! down when its stdin closes. The token reaches the webview through this
//! command and nowhere else: never argv, never a log.
use crate::winproc::NoConsoleWindow;
use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

/// The app's own origins, the only browser origins the host answers. A dev
/// build's page is Vite's.
const APP_ORIGINS: &str = if cfg!(debug_assertions) {
    "http://localhost:5173"
} else {
    "tauri://localhost,http://tauri.localhost,https://tauri.localhost"
};
const START_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Clone, Serialize)]
pub struct PreviewHostInfo {
    pub port: u16,
    pub token: String,
    /// The Chrome-family browser the host found.
    pub executable: String,
}

struct Running {
    child: Child,
    info: PreviewHostInfo,
}

#[derive(Default)]
pub struct PreviewHost(Mutex<Option<Running>>);

fn stop(mut child: Child) {
    // EOF lets the host close its pages (running beforeunload) and Chromium.
    drop(child.stdin.take());
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if child.try_wait().ok().flatten().is_some() {
                return;
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    });
}

impl PreviewHost {
    pub fn shutdown(&self) {
        if let Some(running) = self.0.lock().unwrap().take() {
            stop(running.child);
        }
    }
}

/// The host script and the picker it injects. A dev build runs them from the
/// repository; a bundle runs the copies `scripts/prepare-preview-host.mjs`
/// staged under `preview-host/`.
fn script_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    if cfg!(debug_assertions) {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        return Ok((
            root.join("../packages/remote-host/preview-host.mjs"),
            root.join("src/preview_picker.js"),
        ));
    }
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?.join("preview-host");
    Ok((dir.join("preview-host.mjs"), dir.join("preview_picker.js")))
}

/// What the host printed first: its address, or why it could not start.
#[derive(Debug, PartialEq)]
enum Started {
    Ready(PreviewHostInfo),
    Failed(String),
}

fn parse_first_line(line: &str) -> Started {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
        return Started::Failed("The preview browser did not start. Check that Node.js 22 or newer is installed.".into());
    };
    if let (Some(port), Some(token)) = (value["port"].as_u64(), value["token"].as_str()) {
        if let Ok(port) = u16::try_from(port) {
            return Started::Ready(PreviewHostInfo {
                port,
                token: token.to_owned(),
                executable: value["executable"].as_str().unwrap_or_default().to_owned(),
            });
        }
    }
    Started::Failed(
        value["error"]
            .as_str()
            .unwrap_or("The preview browser did not start.")
            .chars()
            .take(500)
            .collect(),
    )
}

impl PartialEq for PreviewHostInfo {
    fn eq(&self, other: &Self) -> bool {
        self.port == other.port && self.token == other.token && self.executable == other.executable
    }
}
impl std::fmt::Debug for PreviewHostInfo {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never print the token.
        f.debug_struct("PreviewHostInfo").field("port", &self.port).field("executable", &self.executable).finish()
    }
}

/// Starts the preview browser host if it is not running, and returns how to
/// reach it. A failure (no Node, no Chrome) is an error the preview shows
/// while it falls back to the embedded proxy.
#[tauri::command]
pub async fn preview_host_start(app: tauri::AppHandle) -> Result<PreviewHostInfo, String> {
    {
        let state = app.state::<PreviewHost>();
        let mut guard = state.0.lock().unwrap();
        if let Some(running) = guard.as_mut() {
            if running.child.try_wait().ok().flatten().is_none() {
                return Ok(running.info.clone());
            }
            *guard = None;
        }
    }
    let (script, picker) = script_paths(&app)?;
    if !script.is_file() {
        return Err("The preview browser's files are missing from this build.".into());
    }
    // A dev build shares the release app's identifier, so it keeps its own
    // profiles: two apps on one profile would fight over Chromium's lock.
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(if cfg!(debug_assertions) { "preview-browser-dev" } else { "preview-browser" });
    let profiles = base.join("profiles");
    // The host's own warnings (a page that would not open, a crash), kept for diagnosis.
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    let log = std::fs::File::create(base.join("host.log")).map_err(|e| e.to_string())?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(crate::procenv::resolve_command("node"));
        command
            .arg(&script)
            .env("CANOPY_PREVIEW_PROFILES", &profiles)
            .env("CANOPY_PREVIEW_PICKER", &picker)
            .env("CANOPY_PREVIEW_ORIGINS", APP_ORIGINS)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log))
            .no_console_window();
        if let Some(path) = crate::procenv::child_path() {
            command.env("PATH", path);
        }
        let mut child = command
            .spawn()
            .map_err(|e| format!("The preview browser needs Node.js 22 or newer: {e}"))?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let result = reader.read_line(&mut line).map(|_| line);
            let _ = tx.send(result);
            // Keep draining so a stray write can never fill the pipe and stall the host.
            let mut sink = [0u8; 4096];
            while matches!(reader.read(&mut sink), Ok(n) if n > 0) {}
        });
        let started = rx
            .recv_timeout(START_TIMEOUT)
            .map_err(|_| "The preview browser did not start within 20 seconds.".to_string())
            .and_then(|r| r.map_err(|e| e.to_string()))
            .map(|line| parse_first_line(&line));
        match started {
            Ok(Started::Ready(info)) => {
                let state = handle.state::<PreviewHost>();
                let mut guard = state.0.lock().unwrap();
                // Two previews asked at once: keep the first host, stop this one.
                if let Some(running) = guard.as_mut() {
                    if running.child.try_wait().ok().flatten().is_none() {
                        stop(child);
                        return Ok(running.info.clone());
                    }
                }
                *guard = Some(Running { child, info: info.clone() });
                Ok(info)
            }
            Ok(Started::Failed(error)) | Err(error) => {
                stop(child);
                Err(error)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_address_line() {
        assert_eq!(
            parse_first_line("{\"port\":4312,\"token\":\"t\",\"executable\":\"/x/chrome\"}\n"),
            Started::Ready(PreviewHostInfo { port: 4312, token: "t".into(), executable: "/x/chrome".into() })
        );
    }

    #[test]
    fn reports_the_hosts_own_reason() {
        assert_eq!(
            parse_first_line("{\"code\":\"no-chrome\",\"error\":\"No Chrome was found.\"}"),
            Started::Failed("No Chrome was found.".into())
        );
    }

    #[test]
    fn garbage_is_a_start_failure() {
        assert!(matches!(parse_first_line("Error: Cannot find module"), Started::Failed(_)));
        assert!(matches!(parse_first_line("{\"port\":99999,\"token\":\"t\"}"), Started::Failed(_)));
    }

    #[test]
    fn the_token_is_never_in_debug_output() {
        let info = PreviewHostInfo { port: 1, token: "secret-token".into(), executable: String::new() };
        assert!(!format!("{info:?}").contains("secret-token"));
    }
}

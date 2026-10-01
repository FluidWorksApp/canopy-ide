//! Chrome runs the website; an ordinary iframe displays the local stream.
//! The child owns only its project tabs. Dropping stdin asks it to close those
//! tabs and detach. No child webview, native bounds or occlusion state exists.
use crate::winproc::NoConsoleWindow;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

#[derive(Default)]
pub struct ChromeStreams(Mutex<HashMap<String, Child>>);

fn stop(mut child: Child) {
    // EOF permits orderly detachment without shutting down Chrome itself.
    drop(child.stdin.take());
    std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
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

impl ChromeStreams {
    pub fn shutdown_all(&self) {
        for (_, child) in self.0.lock().unwrap().drain() {
            stop(child);
        }
    }
}

#[tauri::command]
pub async fn chrome_stream_open(
    app: tauri::AppHandle,
    session_id: String,
    url: String,
) -> Result<String, String> {
    let parsed = reqwest::Url::parse(&url).map_err(|_| "Enter an HTTP or HTTPS URL.")?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Enter an HTTP or HTTPS URL.".into());
    }
    let mut script = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("chrome-stream/server.mjs");
    if cfg!(debug_assertions) {
        script = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("chrome-stream/server.mjs");
    }
    if !script.is_file() {
        return Err(
            "Chrome streaming files are missing. Rebuild Canopy with the Chrome bridge.".into(),
        );
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new(crate::procenv::resolve_command("node"));
        command.arg(script).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).no_console_window();
        if let Some(path) = crate::procenv::child_path() { command.env("PATH", path); }
        let mut child = command.spawn().map_err(|e| format!("Chrome streaming needs Node.js 20 or newer: {e}"))?;
        let config = serde_json::json!({ "url": url }).to_string() + "\n";
        if let Err(e) = child.stdin.as_mut().unwrap().write_all(config.as_bytes()) { stop(child); return Err(e.to_string()); }
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
            let _ = tx.send(result);
        });
        let result = rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "Chrome bridge did not start within 10 seconds.".to_string())
            .and_then(|r| r.map_err(|e| e.to_string()))
            .and_then(|line| serde_json::from_str::<serde_json::Value>(&line).map_err(|_| "Chrome bridge failed to start. Check Node.js is version 20 or newer and rebuild the bridge.".to_string()))
            .and_then(|v| v["url"].as_str().map(str::to_owned).ok_or("Chrome bridge returned no viewer URL.".into()));
        match result {
            Ok(viewer_url) => {
                if let Some(previous) = app.state::<ChromeStreams>().0.lock().unwrap().insert(session_id, child) { stop(previous); }
                Ok(viewer_url)
            }
            Err(error) => { stop(child); Err(error) }
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn chrome_stream_close(state: tauri::State<'_, ChromeStreams>, session_id: String) {
    if let Some(child) = state.0.lock().unwrap().remove(&session_id) {
        stop(child);
    }
}

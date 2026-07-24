//! Opt-in crash reporting. Two crash sources funnel into one payload: the
//! renderer (a React error boundary catching a JS throw) and native (a Rust
//! panic). A renderer crash POSTs immediately when the user chooses to report
//! it; a native panic can't be trusted to do network I/O mid-unwind, so it's
//! written to `~/.canopy/pending-crash.json` and offered on the next launch.
//!
//! Nothing here runs unless the user has turned crash reporting on — the opt-in
//! lives in the frontend (a Settings toggle, default off) and gates every call
//! into this module. The payload is deliberately minimal: message + stack, app
//! version, OS/arch and a timestamp. No file contents, paths of the user's
//! choosing, repo names or account data.

use serde::{Deserialize, Serialize};

/// Collector URL the app ships with — baked in at build time. Reports POST here
/// (see the canopyide.dev `POST /api/crash` route, which emails them internally
/// via Resend). Empty would make reporting a no-op; to change where reports go,
/// edit this and rebuild.
pub const CRASH_ENDPOINT: &str = "https://canopyide.dev/api/crash";

/// The minimal crash payload. Built entirely in the backend so the version,
/// OS and arch are the ones that actually shipped, not whatever the webview
/// believes.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CrashReport {
    /// "renderer" (React error boundary) or "native" (Rust panic).
    pub source: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    pub app_version: String,
    pub os: String,
    pub arch: String,
    /// Unix epoch milliseconds — when the report was assembled.
    pub timestamp_ms: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn build_report(source: &str, message: String, stack: Option<String>) -> CrashReport {
    CrashReport {
        source: source.to_string(),
        message,
        stack,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        timestamp_ms: now_ms(),
    }
}

async fn post_report(report: &CrashReport) -> Result<(), String> {
    let url = CRASH_ENDPOINT.trim();
    if url.is_empty() {
        return Err("No crash-report endpoint is configured in this build.".to_string());
    }
    let body = serde_json::to_string(report).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .post(url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(format!("collector returned HTTP {}", resp.status().as_u16()))
    }
}

/// `~/.canopy/pending-crash.json` — where a native panic parks its report so
/// the next launch can offer to send it. Shares the `~/.canopy` dir the rest
/// of the backend already writes to.
fn pending_path() -> Option<std::path::PathBuf> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()?;
    let dir = std::path::PathBuf::from(home).join(".canopy");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("pending-crash.json"))
}

/// Catch native panics and persist them for next-launch reporting, keeping the
/// process's prior behaviour (default hook: message to stderr / the dev log)
/// intact. Persisting is all we do here — a panicking thread is the wrong place
/// to open a socket.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // `info`'s type differs across Rust versions (PanicInfo vs
        // PanicHookInfo); leaving it inferred keeps this compiling on our MSRV.
        let payload = info.payload();
        let message = if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            "panic with a non-string payload".to_string()
        };
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        let stack = match info.location() {
            Some(l) => format!("at {}:{}:{}\n{backtrace}", l.file(), l.line(), l.column()),
            None => backtrace,
        };
        let report = build_report("native", message, Some(stack));
        if let (Some(path), Ok(json)) = (pending_path(), serde_json::to_string(&report)) {
            let _ = std::fs::write(&path, json);
        }
        previous(info);
    }));
}

/// Report a renderer (React) crash. The frontend passes the raw error; the
/// collector is the one baked into this build (CRASH_ENDPOINT).
#[tauri::command]
pub async fn report_crash(
    source: String,
    message: String,
    stack: Option<String>,
) -> Result<(), String> {
    let report = build_report(&source, message, stack);
    post_report(&report).await
}

/// POST a report that's already assembled — used to flush the pending native
/// crash the frontend picked up via `take_pending_crash`.
#[tauri::command]
pub async fn send_crash(report: CrashReport) -> Result<(), String> {
    post_report(&report).await
}

/// Read and clear the parked native-crash report, if any. Clearing on read is
/// deliberate: a report is offered exactly once, so a crash loop can't nag on
/// every launch.
#[tauri::command]
pub async fn take_pending_crash() -> Option<CrashReport> {
    let path = pending_path()?;
    let data = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    serde_json::from_str(&data).ok()
}

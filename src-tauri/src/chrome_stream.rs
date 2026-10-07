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
        // A saved token skips the extension's approval dialog. Read per spawn so
        // a token saved or cleared in Settings applies to the next preview tab.
        apply_extension_token(&mut command, extension_token().ok().flatten().as_deref());
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

// ---------- the Playwright extension token ----------
//
// The Playwright extension asks Chrome's user to approve every new connection
// unless the connecting process presents the token shown on the extension's
// status page, in PLAYWRIGHT_MCP_EXTENSION_TOKEN. The token is a credential for
// the user's whole Chrome profile, so it lives in the OS credential store (the
// same Keychain items the account and workspace credentials use), is never
// returned to the webview after saving, and never appears in a log or error.

const EXTENSION_TOKEN_ENV: &str = "PLAYWRIGHT_MCP_EXTENSION_TOKEN";
#[cfg(target_os = "macos")]
const TOKEN_SERVICE: &str = "app.causeconnect.canopy.playwright-extension";
#[cfg(target_os = "macos")]
const TOKEN_ACCOUNT: &str = "token";
/// The extension's status page, which displays the token.
const EXTENSION_STATUS_URL: &str =
    "chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/status.html";

/// Accepts what a paste of the status page's token looks like: one word of URL-
/// safe or base64 characters. Surrounding whitespace from the copy is trimmed.
/// Anything else is refused without echoing it, since it may be a secret.
fn normalize_token(raw: &str) -> Result<String, String> {
    let token = raw.trim();
    if token.is_empty() {
        return Err("Paste the token from the Playwright extension.".into());
    }
    let token = token
        .strip_prefix(EXTENSION_TOKEN_ENV)
        .and_then(|rest| rest.strip_prefix('='))
        .unwrap_or(token);
    if token.len() < 8
        || token.len() > 512
        || !token.bytes().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'+' | b'/' | b'=' | b'.')
        })
    {
        return Err("That does not look like a Playwright extension token.".into());
    }
    Ok(token.to_owned())
}

/// Sets the token on a bridge spawn. Without a saved token any inherited value
/// is left alone, so a token the user exported in their shell still works.
fn apply_extension_token(command: &mut Command, token: Option<&str>) {
    if let Some(token) = token {
        command.env(EXTENSION_TOKEN_ENV, token);
    }
}

#[cfg(target_os = "macos")]
fn extension_token() -> Result<Option<String>, String> {
    match security_framework::passwords::get_generic_password(TOKEN_SERVICE, TOKEN_ACCOUNT) {
        Ok(bytes) => Ok(String::from_utf8(bytes).ok()),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(_) => Err("Cannot read the Playwright token from Keychain".into()),
    }
}
#[cfg(not(target_os = "macos"))]
fn extension_token() -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(target_os = "macos")]
fn store_extension_token(token: &str) -> Result<(), String> {
    security_framework::passwords::set_generic_password(
        TOKEN_SERVICE,
        TOKEN_ACCOUNT,
        token.as_bytes(),
    )
    .map_err(|_| "Cannot save the Playwright token to Keychain".into())
}
#[cfg(not(target_os = "macos"))]
fn store_extension_token(_: &str) -> Result<(), String> {
    Err("Secure token storage is unavailable on this platform".into())
}

#[cfg(target_os = "macos")]
fn delete_extension_token() -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(TOKEN_SERVICE, TOKEN_ACCOUNT) {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()),
        Err(_) => Err("Cannot remove the Playwright token from Keychain".into()),
    }
}
#[cfg(not(target_os = "macos"))]
fn delete_extension_token() -> Result<(), String> {
    Ok(())
}

/// Whether a token is saved. The token itself never crosses back to the webview.
#[tauri::command]
pub fn chrome_extension_token_status() -> Result<bool, String> {
    Ok(extension_token()?.is_some())
}

#[tauri::command]
pub fn chrome_extension_token_set(token: String) -> Result<(), String> {
    store_extension_token(&normalize_token(&token)?)
}

#[tauri::command]
pub fn chrome_extension_token_clear() -> Result<(), String> {
    delete_extension_token()
}

/// Where Google Chrome's executable usually is. Launching it with a URL hands
/// that URL to the running instance, which is how Playwright itself opens the
/// extension's connect page; a chrome-extension:// URL cannot go through the
/// OS's URL handler because no app claims that scheme.
fn chrome_candidates() -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if cfg!(target_os = "macos") {
        out.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into());
        if let Some(home) = std::env::var_os("HOME") {
            out.push(
                std::path::Path::new(&home)
                    .join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            );
        }
    } else if cfg!(windows) {
        for var in ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"] {
            if let Some(base) = std::env::var_os(var) {
                out.push(
                    std::path::Path::new(&base).join("Google\\Chrome\\Application\\chrome.exe"),
                );
            }
        }
    } else {
        out.push("/opt/google/chrome/chrome".into());
        out.push("/usr/bin/google-chrome".into());
        out.push("/usr/bin/google-chrome-stable".into());
    }
    out
}

#[tauri::command]
pub fn chrome_extension_open_status() -> Result<(), String> {
    let chrome = chrome_candidates()
        .into_iter()
        .find(|p| p.is_file())
        .ok_or("Google Chrome was not found.")?;
    let mut child = Command::new(chrome)
        .arg(EXTENSION_STATUS_URL)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .no_console_window()
        .spawn()
        .map_err(|_| "Could not open Google Chrome.".to_string())?;
    // Reap the launcher; when Chrome was already running it exits at once.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[tauri::command]
pub fn chrome_stream_close(state: tauri::State<'_, ChromeStreams>, session_id: String) {
    if let Some(child) = state.0.lock().unwrap().remove(&session_id) {
        stop(child);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pasted_token_is_trimmed_and_an_env_assignment_is_unwrapped() {
        assert_eq!(normalize_token("  aaaa-bbbb\n").unwrap(), "aaaa-bbbb");
        assert_eq!(
            normalize_token("PLAYWRIGHT_MCP_EXTENSION_TOKEN=aaaa-bbbb").unwrap(),
            "aaaa-bbbb"
        );
    }

    #[test]
    fn malformed_tokens_are_refused_without_echoing_them() {
        for bad in [
            "",
            "   ",
            "short",
            "has space inside",
            "semi;colon-token",
            &"x".repeat(513),
        ] {
            let error = normalize_token(bad).unwrap_err();
            assert!(
                bad.trim().is_empty() || !error.contains(bad.trim()),
                "{error}"
            );
        }
    }

    fn env_of(command: &Command) -> Option<Option<String>> {
        command
            .get_envs()
            .find(|(k, _)| *k == EXTENSION_TOKEN_ENV)
            .map(|(_, v)| v.map(|v| v.to_string_lossy().into_owned()))
    }

    #[test]
    fn a_saved_token_reaches_the_bridge_environment() {
        let mut command = Command::new("/bin/sh");
        apply_extension_token(&mut command, Some("aaaa-bbbb"));
        assert_eq!(env_of(&command), Some(Some("aaaa-bbbb".into())));
    }

    #[test]
    fn without_a_saved_token_the_environment_is_untouched() {
        let mut command = Command::new("/bin/sh");
        apply_extension_token(&mut command, None);
        assert_eq!(env_of(&command), None);
    }

    #[test]
    fn the_status_page_belongs_to_the_playwright_extension() {
        assert!(EXTENSION_STATUS_URL
            .starts_with("chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/"));
        assert!(!chrome_candidates().is_empty());
    }
}

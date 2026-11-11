//! The local "System One" model: Laya, served by llama.cpp's `llama-server`.
//!
//! Nothing here is in the app package. After install, one background task
//! downloads two things into `~/.canopy/system-one/` (checksum-verified against
//! pins below, so a swapped file is refused, not run):
//!   * llama.cpp's official prebuilt `llama-server` for this platform, and
//!   * the Laya decision model (GGUF, Q8_0, ~450 MB).
//!
//! A failed or interrupted download leaves nothing half-installed and is retried
//! on the next launch. Where there is no prebuilt (Windows) or the download
//! cannot happen (offline), System One is simply absent and every caller falls
//! back to the CLI brain.
//!
//! The server only ever listens on 127.0.0.1, on a free port, behind a random
//! per-launch API key. The webview never talks to it: `system_one_decide`
//! proxies the one request shape the frontend needs, so the key stays in Rust
//! and no page in the app, or any other local web page, can reach the model.
//! It starts on first use, stops after ten idle minutes, and is killed when
//! the app exits.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

const LLAMA_TAG: &str = "b12262";
// Pinned revision of ggml-org/Laya-GGUF (Apache-2.0) and its Q8_0 file's SHA-256.
const MODEL_URL: &str = "https://huggingface.co/ggml-org/Laya-GGUF/resolve/845f314dd047fc2444a5289a4d50c1e1d59e27e1/Laya-Q8_0.gguf";
const MODEL_SHA256: &str = "c06528c5746d3bb8baa72a27938be95abbfd0b226f8471e8a9e365ed0bb066d2";
const MODEL_FILE: &str = "Laya-Q8_0.gguf";
const MODEL_BYTES: u64 = 449_397_600;
const IDLE_STOP: Duration = Duration::from_secs(10 * 60);
const START_TIMEOUT: Duration = Duration::from_secs(60);

struct Server {
    url: &'static str,
    sha256: &'static str,
}

/// llama.cpp's own release for this platform. `None` where there is none we
/// can unpack (Windows ships a .zip; not supported yet).
fn server_asset() -> Option<Server> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some(Server {
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b12262/llama-b12262-bin-macos-arm64.tar.gz",
            sha256: "c52efb2ff664010329d00a6b88aa253ecb50096999201a69838ae28211161f0a",
        })
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        Some(Server {
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b12262/llama-b12262-bin-macos-x64.tar.gz",
            sha256: "9e9caf083b2fb520ad96631e5f786fce2a344c07d5b81d20fe034aeccf782528",
        })
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some(Server {
            url: "https://github.com/ggml-org/llama.cpp/releases/download/b12262/llama-b12262-bin-ubuntu-x64.tar.gz",
            sha256: "5085f946e912b1e6362c0092e348ad6e2d0b3b85306a798212ecfccc3800c62b",
        })
    } else {
        None
    }
}

fn root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home dir".to_string())?;
    Ok(PathBuf::from(home).join(".canopy").join("system-one"))
}

fn runtime_dir() -> Result<PathBuf, String> {
    Ok(root()?.join(format!("llama-{LLAMA_TAG}")))
}

fn model_path() -> Result<PathBuf, String> {
    Ok(root()?.join(MODEL_FILE))
}

/// The `llama-server` binary inside the unpacked release, if installed.
fn server_binary() -> Option<PathBuf> {
    let dir = runtime_dir().ok()?;
    if !dir.join(".complete").exists() {
        return None;
    }
    let found = std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .map(|p| p.join("llama-server"))
        .find(|p| p.exists());
    found.or_else(|| Some(dir.join("llama-server")).filter(|p| p.exists()))
}

fn installed() -> bool {
    server_binary().is_some() && model_path().map(|p| p.exists()).unwrap_or(false)
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Unsupported,
    Missing,
    Downloading,
    Ready,
    Failed,
}

struct Running {
    child: Child,
    port: u16,
    key: String,
    last_used: Instant,
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct SystemOne {
    /// The `systemOne` setting. False until the frontend says otherwise, so
    /// nothing is downloaded or started before the person's choice is known.
    enabled: AtomicBool,
    /// Serialises starting the server: two callers must not each spawn one.
    starting: tokio::sync::Mutex<()>,
    running: Mutex<Option<Running>>,
    installing: Mutex<bool>,
    failure: Mutex<Option<String>>,
}

impl SystemOne {
    /// Stop the server (app exit, idle).
    pub fn stop(&self) {
        *self.running.lock().unwrap() = None;
    }
}

#[derive(Serialize)]
pub struct Status {
    phase: Phase,
    detail: Option<String>,
}

fn emit(app: &tauri::AppHandle, phase: &str, pct: f64) {
    let _ = app.emit("system-one:progress", serde_json::json!({ "phase": phase, "pct": pct }));
}

/// Stream a URL to `dest`, verifying the SHA-256 before it is moved into place.
async fn fetch_verified(
    app: &tauri::AppHandle,
    url: &str,
    sha256: &str,
    dest: &Path,
    expected_bytes: u64,
    label: &str,
) -> Result<(), String> {
    let part = dest.with_extension("part");
    let mut resp = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|e| format!("download {label}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download {label}: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(expected_bytes).max(1);
    let mut file = std::fs::File::create(&part).map_err(|e| format!("create {label}: {e}"))?;
    let mut hasher = Sha256::new();
    let (mut got, mut last) = (0u64, -1i64);
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("download {label}: {e}"))? {
        hasher.update(&chunk);
        file.write_all(&chunk).map_err(|e| format!("write {label}: {e}"))?;
        got += chunk.len() as u64;
        let pct = (got as f64 / total as f64 * 100.0).min(100.0);
        if pct as i64 > last {
            last = pct as i64;
            emit(app, label, pct);
        }
    }
    file.flush().map_err(|e| format!("flush {label}: {e}"))?;
    drop(file);
    let digest = hex::encode(hasher.finalize());
    if digest != sha256 {
        let _ = std::fs::remove_file(&part);
        return Err(format!("{label}: checksum mismatch, refusing to install it"));
    }
    std::fs::rename(&part, dest).map_err(|e| format!("install {label}: {e}"))
}

fn is_enabled(app: &tauri::AppHandle) -> bool {
    app.state::<SystemOne>().enabled.load(Ordering::SeqCst)
}

async fn install(app: &tauri::AppHandle) -> Result<(), String> {
    let server = server_asset().ok_or("no llama.cpp build for this platform")?;
    let root = root()?;
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;

    if server_binary().is_none() {
        let dir = runtime_dir()?;
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let archive = root.join("llama.tar.gz");
        fetch_verified(app, server.url, server.sha256, &archive, 20_000_000, "runtime").await?;
        if !is_enabled(app) {
            return Err("turned off".into());
        }
        let (a, d) = (archive.clone(), dir.clone());
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let gz = flate2::read::GzDecoder::new(std::fs::File::open(&a).map_err(|e| e.to_string())?);
            tar::Archive::new(gz).unpack(&d).map_err(|e| format!("unpack runtime: {e}"))
        })
        .await
        .map_err(|e| e.to_string())??;
        let _ = std::fs::remove_file(&archive);
        std::fs::File::create(dir.join(".complete")).map_err(|e| e.to_string())?;
        // Keep only the current release: older unpacked copies are dead weight.
        if let Ok(rd) = std::fs::read_dir(&root) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with("llama-") && name != format!("llama-{LLAMA_TAG}") && e.path().is_dir() {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
    }
    if server_binary().is_none() {
        return Err("runtime unpacked without a llama-server".into());
    }
    let model = model_path()?;
    if !model.exists() {
        fetch_verified(app, MODEL_URL, MODEL_SHA256, &model, MODEL_BYTES, "model").await?;
    }
    if !is_enabled(app) {
        return Err("turned off".into());
    }
    Ok(())
}

/// Stop the server and delete everything System One put on disk.
fn remove_all() {
    if let Ok(dir) = root() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// The `systemOne` setting changed (or was read at startup). On: fetch the
/// runtime and model in the background. Off: stop the server and delete the
/// files, and download nothing.
#[tauri::command]
pub fn system_one_enable(app: tauri::AppHandle, state: tauri::State<'_, SystemOne>, enabled: bool) {
    state.enabled.store(enabled, Ordering::SeqCst);
    if enabled {
        install_in_background(app);
    } else {
        state.stop();
        remove_all();
        *state.failure.lock().unwrap() = None;
    }
}

/// Post-install step: fetch the runtime and model in the background if they are
/// not there. Called once at startup; a no-op when installed, already running,
/// or unsupported. Failure is recorded and retried at the next launch.
pub fn install_in_background(app: tauri::AppHandle) {
    // A selftest runs in a throwaway home and must not pull half a gigabyte.
    let isolated = root().map(|r| r.to_string_lossy().contains("canopy-selftest")).unwrap_or(true);
    if isolated || std::env::var_os("CANOPY_NO_SYSTEM_ONE").is_some() || server_asset().is_none() || installed() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let state = app.state::<SystemOne>();
        {
            let mut busy = state.installing.lock().unwrap();
            if *busy {
                return;
            }
            *busy = true;
        }
        let result = install(&app).await;
        *state.installing.lock().unwrap() = false;
        match result {
            // Turned off mid-download: the switch already deleted what it could;
            // delete again in case a file landed after.
            Err(_) if !is_enabled(&app) => remove_all(),
            Ok(()) => {
                *state.failure.lock().unwrap() = None;
                emit(&app, "ready", 100.0);
            }
            Err(e) => {
                log::warn!("system one: install failed: {e}");
                *state.failure.lock().unwrap() = Some(e);
                emit(&app, "failed", 0.0);
            }
        }
    });
}

fn free_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    l.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

fn random_key() -> Result<String, String> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).map_err(|e| e.to_string())?;
    Ok(hex::encode(b))
}

fn spawn_server() -> Result<Running, String> {
    let bin = server_binary().ok_or("System One is not installed yet")?;
    let (port, key) = (free_port()?, random_key()?);
    let mut cmd = Command::new(&bin);
    cmd.current_dir(bin.parent().unwrap_or(Path::new(".")))
        .arg("-m")
        .arg(model_path()?)
        .args(["--host", "127.0.0.1", "--port", &port.to_string()])
        // One slot, a small context: the model is ~0.5 GB resident this way
        // (an unset context defaults to 262144 and balloons memory). The
        // physical batch must hold a whole input: the model reads it all at
        // once, so a longer reply than the batch is an error, not a truncation.
        .args(["-np", "1", "-c", "8192", "-b", "4096", "-ub", "4096"])
        .args(["--api-key", &key, "--no-webui", "--cors-origins", "null"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = cmd.spawn().map_err(|e| format!("start System One: {e}"))?;
    Ok(Running { child, port, key, last_used: Instant::now() })
}

async fn healthy(port: u16, key: &str) -> bool {
    reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/health"))
        .bearer_auth(key)
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// (port, key) of a running, healthy server, starting it if needed.
async fn endpoint(state: &SystemOne) -> Result<(u16, String), String> {
    let _starting = state.starting.lock().await;
    let existing = {
        let mut g = state.running.lock().unwrap();
        let alive = match g.as_mut() {
            Some(r) => r.child.try_wait().ok().flatten().is_none(),
            None => false,
        };
        if alive {
            let r = g.as_mut().unwrap();
            r.last_used = Instant::now();
            Some((r.port, r.key.clone()))
        } else {
            *g = None;
            None
        }
    };
    if let Some(e) = existing {
        return Ok(e);
    }
    let fresh = spawn_server()?;
    let (port, key) = (fresh.port, fresh.key.clone());
    *state.running.lock().unwrap() = Some(fresh);
    let started = Instant::now();
    while started.elapsed() < START_TIMEOUT {
        if healthy(port, &key).await {
            return Ok((port, key));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    state.stop();
    Err("System One did not start in time".into())
}

fn watch_idle(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let state = app.state::<SystemOne>();
            let mut g = state.running.lock().unwrap();
            if let Some(r) = g.as_ref() {
                if r.last_used.elapsed() >= IDLE_STOP {
                    *g = None;
                }
            }
        }
    });
}

pub fn start_idle_watch(app: tauri::AppHandle) {
    watch_idle(app);
}

#[tauri::command]
pub fn system_one_status(state: tauri::State<'_, SystemOne>) -> Status {
    if server_asset().is_none() {
        return Status { phase: Phase::Unsupported, detail: None };
    }
    if !state.enabled.load(Ordering::SeqCst) {
        return Status { phase: Phase::Missing, detail: None };
    }
    if installed() {
        return Status { phase: Phase::Ready, detail: None };
    }
    if *state.installing.lock().unwrap() {
        return Status { phase: Phase::Downloading, detail: None };
    }
    match state.failure.lock().unwrap().clone() {
        Some(e) => Status { phase: Phase::Failed, detail: Some(e) },
        None => Status { phase: Phase::Missing, detail: None },
    }
}

/// One `/v1/systemone` call, made from Rust. Errors are plain strings: the
/// frontend treats any error as "no answer" and falls back.
#[tauri::command]
pub async fn system_one_decide(
    state: tauri::State<'_, SystemOne>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !state.enabled.load(Ordering::SeqCst) || !installed() {
        return Err("not installed".into());
    }
    let (port, key) = endpoint(&state).await?;
    let resp = reqwest::Client::new()
        .post(format!("http://127.0.0.1:{port}/v1/systemone"))
        .bearer_auth(key)
        .header("content-type", "application/json")
        .body(serde_json::to_vec(&request).map_err(|e| e.to_string())?)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    let text = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pins_are_well_formed() {
        assert_eq!(MODEL_SHA256.len(), 64);
        assert!(MODEL_URL.contains("/resolve/") && !MODEL_URL.contains("/main/"));
        if let Some(s) = server_asset() {
            assert_eq!(s.sha256.len(), 64);
            assert!(s.url.contains(LLAMA_TAG));
        }
    }

    #[test]
    fn nothing_is_installed_in_an_empty_home() {
        let dir = std::env::temp_dir().join(format!("s1-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // SAFETY of env use: this module's other tests do not read HOME.
        let old = std::env::var_os("HOME");
        std::env::set_var("HOME", &dir);
        assert!(!installed());
        assert!(server_binary().is_none());
        if let Some(h) = old {
            std::env::set_var("HOME", h);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_new_key_every_time() {
        assert_ne!(random_key().unwrap(), random_key().unwrap());
    }
}

//! `canopy --selftest=browser` — the app testing itself, because nothing else
//! can test it.
//!
//! The embedded browser is a native child webview composited above the window.
//! Every rule about it is a rule about pixels and timing: hide before an overlay
//! paints, have a frame in hand before you hide, be exactly where the
//! placeholder is. None of that is reachable from `vitest` (no compositor) or
//! from `cargo test` (no window), and WebDriver — the usual answer — has no
//! macOS driver at all. tauri-driver supports Linux and Windows only.
//!
//! So the app runs the scenario itself. Launched with this flag it opens a
//! throwaway project, points a preview at a page it serves from inside its own
//! process (no network, no dev server, identical bytes every run), drives every
//! overlay surface in the registry across it, and reports what happened as JSON
//! before exiting 0 or 1.
//!
//! Two things are deliberate:
//!
//!   * the page is served here rather than fetched. A regression suite that can
//!     fail because a CDN was slow teaches people to ignore it.
//!   * there is a deadline. A frontend that hangs — which is exactly what a
//!     browser-layer bug looks like — must fail the run, not wait forever
//!     holding a CI runner.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

use axum::http::header;
use axum::response::IntoResponse;
use axum::Router;
use tauri::Manager;

/// The whole run may take this long. Generous: a debug build on a cold CI
/// runner is slow, and the scenario's own per-step deadlines are what actually
/// judge the app.
const DEADLINE: std::time::Duration = std::time::Duration::from_secs(300);
const NO_EXIT_CODE: i32 = -1;
static EXIT_CODE: AtomicI32 = AtomicI32::new(NO_EXIT_CODE);
static REGISTER_FAILURES_REMAINING: std::sync::OnceLock<AtomicU32> = std::sync::OnceLock::new();
static ATTACH_FAILURES_REMAINING: std::sync::OnceLock<AtomicU32> = std::sync::OnceLock::new();

/// What the frontend needs to run a scenario.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub scenario: String,
    pub url: String,
    pub project_dir: String,
    pub project_dirs: Vec<String>,
    pub report_path: String,
    pub iterations: u32,
    pub registration_failures: u32,
    pub listener_failures: u32,
    pub attach_failures: u32,
}

#[derive(Default)]
pub struct SelftestState {
    config: Mutex<Option<Config>>,
    checkpoint: Mutex<Option<serde_json::Value>>,
    finished: Arc<AtomicBool>,
}

/// Which scenario was asked for, if any. Both spellings exist because both
/// launchers exist: a person types the flag, CI sets the variable.
pub fn requested<I: IntoIterator<Item = String>>(args: I, env: Option<String>) -> Option<String> {
    for a in args {
        if let Some(name) = a.strip_prefix("--selftest=") {
            if !name.is_empty() {
                return Some(name.to_string());
            }
        }
    }
    env.filter(|v| !v.trim().is_empty())
        .map(|v| v.trim().to_string())
}

/// Where the report goes when nobody says. Under the temp dir rather than the
/// repo: a selftest must not write into the tree it is testing.
fn default_report_path() -> PathBuf {
    std::env::temp_dir().join("canopy-selftest-report.json")
}

/// Everything this run is allowed to write to.
fn scratch_root() -> PathBuf {
    std::env::temp_dir().join(format!("canopy-selftest-{}", std::process::id()))
}

/// Put the entire process behind a disposable home before startup writers run.
///
/// Selftests used to isolate only Canopy's workspace store, and did so late in
/// `setup()`. Integration bootstrap had already installed the helper and healed
/// CLI configs by then. A harness that supplied a throwaway helper home could
/// consequently leave that throwaway path in the user's real Claude/Codex
/// config. HOME is process-wide, so set it once, before Tauri starts threads or
/// any subsystem has a chance to cache it.
pub fn prepare() -> Result<(), String> {
    if requested(std::env::args(), std::env::var("CANOPY_SELFTEST").ok()).is_none() {
        return Ok(());
    }
    let home = scratch_root().join("home");
    std::fs::create_dir_all(&home).map_err(|e| {
        format!(
            "selftest: cannot create isolated home {}: {e}",
            home.display()
        )
    })?;
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    Ok(())
}

fn requested_registration_failures() -> u32 {
    std::env::var("CANOPY_SELFTEST_REGISTER_FAILURES")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value <= 100)
        .unwrap_or(0)
}

fn requested_listener_failures() -> u32 {
    std::env::var("CANOPY_SELFTEST_LISTENER_FAILURES")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value <= 100)
        .unwrap_or(0)
}

fn requested_attach_failures() -> u32 {
    std::env::var("CANOPY_SELFTEST_ATTACH_FAILURES")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value <= 100)
        .unwrap_or(0)
}

/// Deterministic bootstrap fault injection. Ordinary launches always return
/// None; an isolated selftest can force the critical native registration to
/// fail before succeeding, proving React never mounts generation-less.
pub fn renderer_registration_failure() -> Option<String> {
    if requested(std::env::args(), std::env::var("CANOPY_SELFTEST").ok()).is_none() {
        return None;
    }
    let remaining = REGISTER_FAILURES_REMAINING
        .get_or_init(|| AtomicU32::new(requested_registration_failures()));
    decrement_if_positive(remaining)
        .ok()
        .map(|before| format!("selftest injected renderer registration failure {before}"))
}

/// Fail the first few recovered-viewer attach attempts in an isolated
/// selftest. This is after React has committed the terminal tab, which is a
/// distinct durability boundary from renderer registration and tab delivery.
pub fn renderer_attachment_failure() -> Option<String> {
    if requested(std::env::args(), std::env::var("CANOPY_SELFTEST").ok()).is_none() {
        return None;
    }
    let remaining =
        ATTACH_FAILURES_REMAINING.get_or_init(|| AtomicU32::new(requested_attach_failures()));
    decrement_if_positive(remaining)
        .ok()
        .map(|before| format!("selftest injected desktop attachment failure {before}"))
}

fn decrement_if_positive(counter: &AtomicU32) -> Result<u32, u32> {
    counter.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
        if value > 0 {
            Some(value - 1)
        } else {
            None
        }
    })
}

/// A throwaway directory to open as a project. It is deliberately a tiny real
/// npm app: the vibe-exit scenario must exercise zero-setup target inference,
/// a check command and an automatically started server without the network.
fn scratch_project(name: &str) -> std::io::Result<PathBuf> {
    let dir = scratch_root().join(name);
    std::fs::create_dir_all(&dir)?;
    std::fs::write(
        dir.join("README.md"),
        "Scratch project for `canopy --selftest`. Safe to delete.\n",
    )?;
    std::fs::write(
        dir.join("package.json"),
        format!(
            r#"{{"name":"canopy-selftest-{name}","private":true,"scripts":{{"dev":"node server.js","check":"node check.js"}}}}"#,
        ),
    )?;
    std::fs::write(
        dir.join("server.js"),
        r#"const http=require('http'),fs=require('fs');const port=Number(process.env.PORT||4173);http.createServer((_,r)=>{r.setHeader('content-type','text/html');r.end(fs.readFileSync('index.html'))}).listen(port,'127.0.0.1',()=>console.log('selftest server listening '+port));"#,
    )?;
    std::fs::write(
        dir.join("check.js"),
        "require('fs').accessSync('index.html')\n",
    )?;
    std::fs::write(
        dir.join("index.html"),
        "<!doctype html><button id=primary>Primary</button>\n",
    )?;
    // macOS exposes /var as a symlink to /private/var. The native snapshot
    // returns canonical paths, so hand the frontend that same root; otherwise
    // the production containment gate correctly rejects `/private/var/...`
    // evidence as outside a project registered as `/var/...`.
    std::fs::canonicalize(dir)
}

/// Where the workspace lives during a selftest — never `~/.canopy`.
///
/// A test run must not be able to change the machine it runs on. Loading the
/// real workspace would also open every project the user has open, spawning
/// their terminals and their servers to run a scenario about a preview pane;
/// saving it would leave a scratch project behind afterwards. So the store is
/// pointed somewhere disposable for the life of the process, and the run starts
/// from an empty workspace every time — which is also what makes it repeatable.
static STORE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

pub fn store_dir() -> Option<&'static PathBuf> {
    STORE.get()
}

async fn page() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        include_str!("selftest_page.html"),
    )
}

/// Serve the fixed page on loopback and return the address it landed on.
async fn serve() -> Result<String, String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("selftest: cannot bind: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let router = Router::new().fallback(axum::routing::get(page));
    tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok(format!("http://127.0.0.1:{port}/"))
}

/// Prepare the run, if this launch asked for one. Called from setup(), before
/// the frontend has booted — it collects the config with `selftest_config` as
/// soon as it has.
pub fn start(app: &tauri::AppHandle) {
    let Some(scenario) = requested(std::env::args(), std::env::var("CANOPY_SELFTEST").ok()) else {
        return;
    };
    let state = app.state::<SelftestState>();
    let store = scratch_root().join("state");
    if std::fs::create_dir_all(&store).is_ok() {
        let _ = STORE.set(store);
    }
    let url = match tauri::async_runtime::block_on(serve()) {
        Ok(u) => u,
        Err(e) => {
            finish_now(app, 1, serde_json::json!({ "ok": false, "error": e }));
            return;
        }
    };
    let project_dir = match scratch_project("project") {
        Ok(d) => d.to_string_lossy().into_owned(),
        Err(e) => {
            finish_now(
                app,
                1,
                serde_json::json!({ "ok": false, "error": format!("scratch project: {e}") }),
            );
            return;
        }
    };
    let mut project_dirs = vec![project_dir.clone()];
    if scenario == "terminal-recovery" {
        match scratch_project("project-b") {
            Ok(dir) => project_dirs.push(dir.to_string_lossy().into_owned()),
            Err(e) => {
                finish_now(
                    app,
                    1,
                    serde_json::json!({ "ok": false, "error": format!("second scratch project: {e}") }),
                );
                return;
            }
        }
    }
    let report_path = std::env::var("CANOPY_SELFTEST_REPORT")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_report_path());
    let iterations = std::env::var("CANOPY_SELFTEST_ITERATIONS")
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| (1..=1_000).contains(value))
        .unwrap_or(if scenario == "terminal-recovery" {
            25
        } else {
            1
        });
    let registration_failures = requested_registration_failures();
    let listener_failures = requested_listener_failures();
    let attach_failures = requested_attach_failures();
    log::info!(
        "selftest: scenario={scenario} iterations={iterations} page={url} report={}",
        report_path.display(),
    );
    *state.config.lock().unwrap() = Some(Config {
        scenario,
        url,
        project_dir,
        project_dirs,
        report_path: report_path.to_string_lossy().into_owned(),
        iterations,
        registration_failures,
        listener_failures,
        attach_failures,
    });

    // A window nothing can cover. WebKit throttles timers hard in an occluded
    // window — a terminal in front of it is enough — and a scenario built out
    // of "wait 25ms and look again" then runs tens of times slower than it
    // reads, which looks exactly like the app being broken. The run is short
    // and it ends by exiting, so being briefly rude about focus is the cheaper
    // of the two costs.
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
    }

    // The deadline. A browser-layer failure often looks like nothing happening
    // at all, and "nothing happening" must be a red run rather than a wedged
    // one. Its own thread so a blocked event loop cannot delay it.
    let finished = state.finished.clone();
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(DEADLINE);
        if finished.load(Ordering::SeqCst) {
            return;
        }
        finish_now(
            &app,
            1,
            serde_json::json!({
                "ok": false,
                "error": format!("the scenario did not report within {}s", DEADLINE.as_secs()),
            }),
        );
    });
}

/// Write the report where anything reading it will look, and say it on stdout
/// too — a CI log is the one place everybody sees.
fn write_report(path: &std::path::Path, report: &serde_json::Value) {
    let text = serde_json::to_string_pretty(report).unwrap_or_else(|_| "{}".into());
    if let Err(e) = std::fs::write(path, format!("{text}\n")) {
        log::warn!("selftest: cannot write {}: {e}", path.display());
    }
    println!("--- canopy selftest report ---\n{text}\n--- end selftest report ---");
}

fn finish_now(app: &tauri::AppHandle, code: i32, report: serde_json::Value) {
    let path = app
        .try_state::<SelftestState>()
        .and_then(|s| {
            s.config
                .lock()
                .unwrap()
                .as_ref()
                .map(|c| PathBuf::from(&c.report_path))
        })
        .unwrap_or_else(default_report_path);
    write_report(&path, &report);
    EXIT_CODE.store(code, Ordering::SeqCst);
    app.exit(code);
}

/// Tauri's macOS event loop returns normally after `AppHandle::exit`; propagate
/// the scenario result from the library boundary so CI receives the report's
/// failure instead of an unconditional process status 0.
pub fn exit_code() -> Option<i32> {
    match EXIT_CODE.load(Ordering::SeqCst) {
        NO_EXIT_CODE => None,
        code => Some(code),
    }
}

#[tauri::command]
pub fn selftest_config(state: tauri::State<'_, SelftestState>) -> Option<Config> {
    state.config.lock().unwrap().clone()
}

/// Control state for a scenario that intentionally destroys its own page. It
/// lives in Rust so the test does not depend on browser storage — renderer state
/// is the thing the scenario is trying to prove can disappear safely.
#[tauri::command]
pub fn selftest_checkpoint(
    state: tauri::State<'_, SelftestState>,
) -> Result<Option<serde_json::Value>, String> {
    if state.config.lock().unwrap().is_none() {
        return Err("selftest is not active".into());
    }
    Ok(state.checkpoint.lock().unwrap().clone())
}

#[tauri::command]
pub fn selftest_checkpoint_save(
    state: tauri::State<'_, SelftestState>,
    checkpoint: serde_json::Value,
) -> Result<(), String> {
    if state.config.lock().unwrap().is_none() {
        return Err("selftest is not active".into());
    }
    *state.checkpoint.lock().unwrap() = Some(checkpoint);
    Ok(())
}

/// Exercise the exact native primitive used by watchdog recovery. Restricted
/// to an isolated selftest launch: ordinary renderer code cannot ask the app to
/// reload through this command.
#[tauri::command]
pub fn selftest_reload_renderer(
    app: tauri::AppHandle,
    state: tauri::State<'_, SelftestState>,
) -> Result<(), String> {
    if state.config.lock().unwrap().is_none() {
        return Err("selftest is not active".into());
    }
    let main = app
        .get_webview_window("main")
        .ok_or_else(|| "selftest main window is missing".to_string())?;
    // Do not destroy the page from inside the invoke that asked to destroy it.
    // WebKit can tear down the command's reply channel before Tauri unwinds the
    // handler, leaving the reload call and its JavaScript promise wedged
    // together. Dispatching the same native primitive after this synchronous
    // command returns gives the reply a chance to leave the old renderer; the
    // replacement page resumes from the native checkpoint either way. The
    // short async boundary guarantees the invoke response has left this page;
    // the second dispatch keeps the actual WebKit operation on the UI thread.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        if let Err(error) = app.run_on_main_thread(move || {
            if let Err(error) = main.reload() {
                log::error!("selftest renderer reload failed: {error}");
            }
        }) {
            log::error!("selftest renderer reload dispatch failed: {error}");
        }
    });
    Ok(())
}

/// A phone-equivalent PTY: native-owned, announced through `pty:spawned`, and
/// attached by the desktop as a viewer. The cwd must be inside this selftest's
/// disposable projects so the command cannot become a production spawn path.
#[tauri::command]
pub fn selftest_spawn_remote(
    app: tauri::AppHandle,
    state: tauri::State<'_, SelftestState>,
    ptys: tauri::State<'_, crate::pty::PtyManager>,
    cwd: String,
) -> Result<crate::pty::PtySummary, String> {
    let config = state
        .config
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "selftest is not active".to_string())?;
    let cwd_path = std::path::Path::new(&cwd);
    if !config
        .project_dirs
        .iter()
        .any(|root| cwd_path.starts_with(root))
    {
        return Err("selftest remote cwd is outside the disposable projects".into());
    }
    let id = ptys.spawn_headless(app, Some(cwd), None, None)?;
    ptys.summaries()
        .into_iter()
        .find(|session| session.id == id)
        .ok_or_else(|| format!("selftest remote PTY {id} disappeared during spawn"))
}

/// The scenario is over. `report.ok` decides the exit code, which is the only
/// thing CI reads.
#[tauri::command]
pub fn selftest_finish(app: tauri::AppHandle, report: serde_json::Value) {
    let state = app.state::<SelftestState>();
    if state.finished.swap(true, Ordering::SeqCst) {
        return;
    }
    let ok = report.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
    let path = state
        .config
        .lock()
        .unwrap()
        .as_ref()
        .map(|c| PathBuf::from(&c.report_path))
        .unwrap_or_else(default_report_path);
    write_report(&path, &report);
    let code = if ok { 0 } else { 1 };
    EXIT_CODE.store(code, Ordering::SeqCst);
    app.exit(code);
}

/// Whether the disposable Canopy store contains a byte sequence. Available
/// only during a selftest: scanning the user's real store would cross the
/// isolation boundary this harness exists to protect.
#[tauri::command]
pub fn selftest_store_contains(needle: String) -> Result<bool, String> {
    let root = store_dir().ok_or_else(|| "selftest store is not active".to_string())?;
    if needle.is_empty() {
        return Err("needle must not be empty".into());
    }
    store_contains(root, needle.as_bytes()).map_err(|e| format!("scan selftest store: {e}"))
}

fn store_contains(dir: &std::path::Path, needle: &[u8]) -> std::io::Result<bool> {
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            if store_contains(&path, needle)? {
                return Ok(true);
            }
        } else if let Ok(bytes) = std::fs::read(&path) {
            if bytes.windows(needle.len()).any(|window| window == needle) {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_scenario_off_the_command_line() {
        let args = vec!["canopy".to_string(), "--selftest=browser".to_string()];
        assert_eq!(requested(args, None), Some("browser".into()));
    }

    #[test]
    fn falls_back_to_the_environment() {
        assert_eq!(
            requested(vec!["canopy".to_string()], Some("browser".into())),
            Some("browser".into())
        );
        assert_eq!(
            requested(vec!["canopy".to_string()], Some("  ".into())),
            None
        );
    }

    #[test]
    fn an_ordinary_launch_asks_for_nothing() {
        assert_eq!(
            requested(vec!["canopy".to_string(), "/some/dir".to_string()], None),
            None
        );
        assert_eq!(
            requested(vec!["canopy".to_string(), "--selftest=".to_string()], None),
            None
        );
    }

    #[test]
    fn store_scan_finds_only_the_raw_value_it_was_given() {
        let root =
            std::env::temp_dir().join(format!("canopy-selftest-scan-{}", std::process::id()));
        let nested = root.join("tasks");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(
            nested.join("artifact"),
            b"before [REDACTED:aws-access-key] after",
        )
        .unwrap();
        assert!(store_contains(&root, b"[REDACTED:aws-access-key]").unwrap());
        assert!(!store_contains(&root, b"raw-secret-value").unwrap());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn selftest_home_is_a_child_of_its_scratch_root() {
        let home = scratch_root().join("home");
        assert!(home.starts_with(scratch_root()));
        assert_ne!(home, scratch_root());
    }

    #[test]
    fn registration_failure_counter_stops_at_zero_without_underflow() {
        let counter = AtomicU32::new(1);
        assert_eq!(decrement_if_positive(&counter), Ok(1));
        assert_eq!(decrement_if_positive(&counter), Err(0));
        assert_eq!(counter.load(Ordering::SeqCst), 0);
    }
}

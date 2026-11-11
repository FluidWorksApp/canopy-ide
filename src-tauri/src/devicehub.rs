//! Streamed simulators and emulators through expo-device-hub.
//!
//! A port of T3 Code's local device host (https://github.com/pingdotgg/t3code,
//! commit d5290e9, MIT License, Copyright (c) 2026 T3 Tools Inc.):
//!
//! * `apps/server/src/device/DeviceToolchain.ts` → [`install_hub`],
//!   [`is_installed`], [`tool_paths`]: a pinned `npm install` into the app
//!   home, only after the user consents (the Device tab's setup card calls
//!   `device_hub_install`), run with an explicit Node and never `npx`.
//! * `apps/server/src/device/LocalDeviceHost.ts` → [`android_sdk`],
//!   [`device_host_environment`], [`hub_environment`], [`hub_args`],
//!   `spawn_hub`, `supervise`, `reap_stale_hub`: SDK detection, the hub's
//!   environment and arguments, `/readyz` readiness, restart with backoff, and
//!   cleanup of a hub a crashed run left behind.
//! * `apps/server/src/device/DeviceHubOperations.ts` → `list`, `boot`,
//!   `shutdown`: device operations through the hub's own routes.
//!
//! The hub is expo-device-hub 0.19.1 (MIT), which vendors serve-emu (Android:
//! adb + scrcpy-server v4.0, Apache-2.0) and serve-sim (iOS Simulator,
//! Apache-2.0). Nothing here speaks scrcpy or H.264: the hub does, and the
//! viewer in `src/devices/stream.ts` decodes what it sends.
//!
//! Where Canopy forces a difference the code says so. The main ones: T3 is a
//! Node server and runs the hub with its own Node; Canopy is a Rust app, so it
//! finds `node` the way T3's packaged build does (on the user's PATH). T3's
//! Effect scopes become a task per hub that owns the child and kills it when
//! its record is dropped. The agent-device daemon, EAS, Simlock and SSH hosts
//! are not ported: Canopy's agents keep their own adb tools
//! (`canopy_device_*` in context.rs), and only the local host exists.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{oneshot, watch};

use crate::devicehub_proxy::{ProxyState, DEVICE_HUB_ROUTE_PREFIX};
use crate::winproc::NoConsoleWindow;

// ---------- DeviceToolchain.ts ----------

pub const DEVICE_HUB_PACKAGE: &str = "expo-device-hub";
/// T3's `deviceToolVersions.json` pin.
pub const DEVICE_HUB_VERSION: &str = "0.19.1";
/// The package's `bin.expo-device-hub`, which T3 runs directly.
const HUB_ENTRY: [&str; 3] = ["dist", "server", "cli.mjs"];
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Where one pinned tool lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolPaths {
    pub install_dir: PathBuf,
    pub entry_path: PathBuf,
    pub sentinel_path: PathBuf,
}

/// `~/.canopy/device-tools`. T3 uses `<baseDir>/tools`; the layout below it is
/// the same: `<name>/<version>/node_modules/<name>/<entry>`.
pub fn default_base_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    home.join(".canopy").join("device-tools")
}

pub fn tool_paths(base_dir: &Path) -> ToolPaths {
    let install_dir = base_dir.join(DEVICE_HUB_PACKAGE).join(DEVICE_HUB_VERSION);
    let mut entry_path = install_dir.join("node_modules").join(DEVICE_HUB_PACKAGE);
    for part in HUB_ENTRY {
        entry_path.push(part);
    }
    ToolPaths {
        sentinel_path: install_dir.join(".install-complete"),
        entry_path,
        install_dir,
    }
}

/// npm exposes entry files before extraction completes; their presence does
/// not prove a usable tree, so the sentinel written after a verified install
/// has to name this version too.
pub fn is_installed(paths: &ToolPaths) -> bool {
    paths.entry_path.is_file()
        && std::fs::read_to_string(&paths.sentinel_path)
            .map(|s| s.trim() == DEVICE_HUB_VERSION)
            .unwrap_or(false)
}

fn install_error(step: &str, exit_code: Option<i32>, detail: Option<&str>) -> String {
    let suffix = exit_code
        .map(|c| format!(" (exit code {c})"))
        .unwrap_or_default();
    let mut msg = format!("Installing {DEVICE_HUB_PACKAGE} failed while {step}{suffix}.");
    if let Some(detail) = detail.map(str::trim).filter(|d| !d.is_empty()) {
        msg.push(' ');
        msg.push_str(&tail_lines(detail, 12));
    }
    msg
}

fn tail_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// T3's `installLock` (a one-permit semaphore): installs never overlap.
fn install_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Install the pinned hub into a staging directory, verify it, mark it
/// complete and publish it with one rename. Idempotent.
pub async fn install_hub(
    base_dir: &Path,
    env: &HashMap<String, String>,
) -> Result<ToolPaths, String> {
    let _permit = install_lock().lock().await;
    let paths = tool_paths(base_dir);
    if is_installed(&paths) {
        return Ok(paths);
    }
    let parent = paths
        .install_dir
        .parent()
        .ok_or_else(|| install_error("preparing the install directory", None, None))?
        .to_path_buf();
    if paths.install_dir.exists() {
        tokio::fs::remove_dir_all(&paths.install_dir)
            .await
            .map_err(|e| {
                install_error("removing an incomplete install", None, Some(&e.to_string()))
            })?;
    }
    tokio::fs::create_dir_all(&parent).await.map_err(|e| {
        install_error(
            "preparing the install directory",
            None,
            Some(&e.to_string()),
        )
    })?;
    let staging = parent.join(format!(".staging-{}", random_suffix()));
    tokio::fs::create_dir(&staging).await.map_err(|e| {
        install_error(
            "preparing the install directory",
            None,
            Some(&e.to_string()),
        )
    })?;

    let result = install_into(&staging, &paths, env).await;
    // T3: `Effect.ensuring(fs.remove(stagingDir))`.
    let _ = tokio::fs::remove_dir_all(&staging).await;
    result
}

async fn install_into(
    staging: &Path,
    paths: &ToolPaths,
    env: &HashMap<String, String>,
) -> Result<ToolPaths, String> {
    let spec = format!("{DEVICE_HUB_PACKAGE}@{DEVICE_HUB_VERSION}");
    let install_args: Vec<String> = vec![
        "install".into(),
        "--prefix".into(),
        staging.to_string_lossy().into_owned(),
        "--no-fund".into(),
        "--no-audit".into(),
        spec,
    ];
    let host = HostPlatform::current();
    let path_var = env_path(env);
    // T3 runs `npm`, and falls back to `pnpm --package=npm@11 dlx npm` only
    // when npm is not found.
    let (program, args) = match find_on_path(if host.windows() { "npm.cmd" } else { "npm" }, &path_var, host) {
        Some(npm) => (npm, install_args),
        None => match find_on_path(if host.windows() { "pnpm.cmd" } else { "pnpm" }, &path_var, host) {
            Some(pnpm) => {
                let mut args: Vec<String> =
                    vec!["--package=npm@11".into(), "dlx".into(), "npm".into()];
                args.extend(install_args);
                (pnpm, args)
            }
            None => {
                return Err(format!(
                    "{} npm was not found. Install Node.js (it includes npm) and make sure npm is on PATH, then retry.",
                    install_error("running npm install", None, None)
                ))
            }
        },
    };
    let mut cmd = std::process::Command::new(&program);
    cmd.args(&args).env_clear().envs(env).no_console_window();
    let output =
        match tokio::task::spawn_blocking(move || run_with_timeout(cmd, INSTALL_TIMEOUT)).await {
            Ok(Ok(output)) => output,
            Ok(Err(RunFailure::TimedOut)) => {
                return Err(install_error(
                    "running npm install",
                    None,
                    Some("npm did not finish within 10 minutes."),
                ))
            }
            Ok(Err(RunFailure::Spawn(e))) => {
                return Err(install_error("running npm install", None, Some(&e)))
            }
            Err(e) => {
                return Err(install_error(
                    "running npm install",
                    None,
                    Some(&e.to_string()),
                ))
            }
        };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(install_error(
            "running npm install",
            output.status.code(),
            Some(if stderr.trim().is_empty() {
                &stdout
            } else {
                &stderr
            }),
        ));
    }
    let mut staged_entry = staging.join("node_modules").join(DEVICE_HUB_PACKAGE);
    for part in HUB_ENTRY {
        staged_entry.push(part);
    }
    if !staged_entry.is_file() {
        return Err(install_error(
            "verifying the installed entry point",
            None,
            None,
        ));
    }
    // Android streaming downloads scrcpy's server on first use, which made the
    // first stream wait on the network. Fetch it now, as part of the install.
    // Best effort: offline, the hub still fetches it when a stream starts.
    if let Ok(node) = resolve_node(env, host) {
        let pkg = staging.join("node_modules").join(DEVICE_HUB_PACKAGE);
        let script = pkg.join("vendor/serve-emu/dist/scrcpy-server.js");
        if script.is_file() {
            let mut prefetch = std::process::Command::new(node);
            prefetch
                .arg("--input-type=module")
                .arg("-e")
                .arg("import('node:url').then(u => import(u.pathToFileURL(process.argv[1]).href)).then(m => m.ensureScrcpyServer())")
                .arg(script.to_string_lossy().into_owned())
                .env_clear()
                .envs(env)
                .no_console_window();
            let _ = tokio::task::spawn_blocking(move || {
                run_with_timeout(prefetch, std::time::Duration::from_secs(90))
            })
            .await;
        }
    }
    tokio::fs::write(
        staging.join(".install-complete"),
        format!("{DEVICE_HUB_VERSION}\n"),
    )
    .await
    .map_err(|e| {
        install_error(
            "recording the completed install",
            None,
            Some(&e.to_string()),
        )
    })?;
    if let Err(e) = tokio::fs::rename(staging, &paths.install_dir).await {
        // Another install may have published the same version first.
        if !is_installed(paths) {
            return Err(install_error(
                "publishing the install",
                None,
                Some(&e.to_string()),
            ));
        }
    }
    Ok(paths.clone())
}

fn random_suffix() -> String {
    let mut b = [0u8; 6];
    let _ = getrandom::getrandom(&mut b);
    hex::encode(b)
}

// ---------- host environment (LocalDeviceHost.ts) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostPlatform {
    Darwin,
    Linux,
    Windows,
}

impl HostPlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::Darwin
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
    fn windows(self) -> bool {
        self == Self::Windows
    }
    fn path_separator(self) -> &'static str {
        if self.windows() {
            ";"
        } else {
            ":"
        }
    }
}

/// The environment a device child inherits. T3 starts from the server's own
/// environment; a GUI-launched Canopy has launchd's PATH, so PATH is the
/// user's login PATH (`procenv::child_path`), which is what a server started
/// from a terminal would have had.
pub fn process_environment() -> HashMap<String, String> {
    let mut env: HashMap<String, String> = std::env::vars().collect();
    if let Some(path) = crate::procenv::child_path() {
        set_path(&mut env, path);
    }
    env
}

fn env_path(env: &HashMap<String, String>) -> String {
    env.get("PATH")
        .or_else(|| env.get("Path"))
        .cloned()
        .unwrap_or_default()
}

/// Windows variables are case-insensitive, so a `Path` beside a new `PATH`
/// would leave the child two answers; T3's Node child has the same rule, so
/// one key is kept.
fn set_path(env: &mut HashMap<String, String>, value: String) {
    env.retain(|k, _| !k.eq_ignore_ascii_case("PATH"));
    env.insert("PATH".into(), value);
}

/// The first `dir/name` on `path_var` that is a file, resolved through
/// symlinks. `resolveCommandPath` in T3's nodeRuntime.
pub fn find_on_path(name: &str, path_var: &str, host: HostPlatform) -> Option<PathBuf> {
    path_var
        .split(host.path_separator())
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(d).join(name))
        .find(|p| p.is_file())
}

pub const NODE_UNAVAILABLE: &str =
    "Local device support requires Node.js. Install Node.js and make sure node is on PATH, then retry.";

/// T3's `resolveNodeExecutable` for a packaged build: `node` (`node.exe` on
/// Windows, PATHEXT `.EXE` only) from the host PATH, made absolute and real.
/// T3 also refuses a `node` that is its own executable; Canopy is not Node,
/// so that check has nothing to compare against.
pub fn resolve_node(env: &HashMap<String, String>, host: HostPlatform) -> Result<PathBuf, String> {
    let name = if host.windows() { "node.exe" } else { "node" };
    let found =
        find_on_path(name, &env_path(env), host).ok_or_else(|| NODE_UNAVAILABLE.to_string())?;
    std::fs::canonicalize(&found).map_err(|_| NODE_UNAVAILABLE.to_string())
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AndroidSdk {
    pub root: Option<PathBuf>,
    pub adb: bool,
    pub emulator: bool,
    pub avdmanager: bool,
    pub legacy_avdmanager: bool,
}

/// T3's `androidSdk`: ANDROID_HOME / ANDROID_SDK_ROOT, then the standard
/// locations, then an `adb` on PATH. This is the machine's SDK, which the hub
/// uses; Canopy's `android.rs` additionally honours a project's
/// `local.properties` for its own adb tools.
pub fn android_sdk(env: &HashMap<String, String>, host: HostPlatform) -> AndroidSdk {
    let windows = host.windows();
    let home = env
        .get("HOME")
        .or_else(|| env.get("USERPROFILE"))
        .cloned()
        .unwrap_or_default();
    let explicit = env
        .get("ANDROID_HOME")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            env.get("ANDROID_SDK_ROOT")
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        });
    let adb_binary = if windows { "adb.exe" } else { "adb" };
    let avdmanager_binary = if windows {
        "avdmanager.bat"
    } else {
        "avdmanager"
    };
    let inspect = |root: &Path| -> Option<AndroidSdk> {
        let adb = root.join("platform-tools").join(adb_binary).exists();
        let emulator = root
            .join("emulator")
            .join(if windows { "emulator.exe" } else { "emulator" })
            .exists();
        if explicit.is_none() && !adb && !emulator {
            return None;
        }
        let avdmanager = root
            .join("cmdline-tools")
            .join("latest")
            .join("bin")
            .join(avdmanager_binary)
            .exists();
        let legacy_avdmanager = !avdmanager
            && root
                .join("tools")
                .join("bin")
                .join(avdmanager_binary)
                .exists();
        Some(AndroidSdk {
            root: Some(root.to_path_buf()),
            adb,
            emulator,
            avdmanager,
            legacy_avdmanager,
        })
    };
    let home = PathBuf::from(home);
    let candidates: Vec<PathBuf> = match &explicit {
        Some(root) => vec![PathBuf::from(root)],
        None => vec![
            home.join("Library").join("Android").join("sdk"),
            home.join("Android").join("Sdk"),
            env.get("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join("AppData").join("Local"))
                .join("Android")
                .join("Sdk"),
        ],
    };
    for root in &candidates {
        if let Some(sdk) = inspect(root) {
            return sdk;
        }
    }
    // PATH entries can be slow to stat (network shares), so only consult them
    // after the standard locations miss.
    if explicit.is_none() {
        for dir in env_path(env)
            .split(host.path_separator())
            .filter(|d| !d.is_empty())
        {
            let adb = Path::new(dir).join(adb_binary);
            if !adb.exists() {
                continue;
            }
            let resolved = std::fs::canonicalize(&adb).unwrap_or(adb);
            if let Some(root) = resolved.parent().and_then(Path::parent) {
                if let Some(sdk) = inspect(root) {
                    return sdk;
                }
            }
        }
    }
    AndroidSdk::default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DevicePlatform {
    Ios,
    Android,
}

/// Why a platform cannot run here, in T3's words; `None` when it can.
pub fn platform_reason(
    platform: DevicePlatform,
    host: HostPlatform,
    sdk: &AndroidSdk,
    xcrun_available: bool,
) -> Option<String> {
    if platform == DevicePlatform::Ios {
        if host != HostPlatform::Darwin {
            return Some("iOS Simulators need macOS with Xcode.".into());
        }
        if !xcrun_available {
            return Some("Xcode command line tools were not found.".into());
        }
        return None;
    }
    let Some(root) = &sdk.root else {
        return Some(
            "Android SDK was not found. Install it with Android Studio or set ANDROID_HOME to your SDK directory."
                .into(),
        );
    };
    let root = root.display();
    if !sdk.adb {
        return Some(format!(
            "Android SDK Platform-Tools are missing from {root}. Install them in Android Studio's SDK Manager."
        ));
    }
    if !sdk.emulator {
        return Some(format!(
            "Android Emulator is missing from {root}. Install it in Android Studio's SDK Manager."
        ));
    }
    if !sdk.avdmanager {
        if sdk.legacy_avdmanager {
            return Some(format!("The Android SDK command-line tools in {root} appear to be an older, unsupported version. Install Android SDK Command-line Tools (latest) in Android Studio's SDK Manager under SDK Tools."));
        }
        return Some(format!(
            "Android SDK Command-line Tools (latest) are missing from {root}. Install them in Android Studio's SDK Manager."
        ));
    }
    None
}

/// T3's `deviceHostEnvironment`: ANDROID_HOME and the SDK's tools on PATH.
pub fn device_host_environment(
    env: &HashMap<String, String>,
    sdk_root: Option<&Path>,
    host: HostPlatform,
) -> HashMap<String, String> {
    let mut out = env.clone();
    if let Some(root) = sdk_root {
        out.insert("ANDROID_HOME".into(), root.to_string_lossy().into_owned());
        let path = [
            root.join("platform-tools").to_string_lossy().into_owned(),
            root.join("emulator").to_string_lossy().into_owned(),
            env_path(env),
        ]
        .join(host.path_separator());
        set_path(&mut out, path);
    }
    out
}

/// What `emulator -help-camera-<facing>` printed, when it exited 0.
pub type CameraHelp<'a> = &'a dyn Fn(&Path, &str, &HashMap<String, String>) -> Option<String>;

/// T3's `hubEnvironment`: no colour, emulated cameras where the SDK's
/// emulator cannot take the hub's imagefile cameras, and a runtime directory
/// for the emulator's gRPC token when an SSH session left it unset.
pub fn hub_environment(
    env: &HashMap<String, String>,
    host: HostPlatform,
    uid: Option<u32>,
    camera_help: CameraHelp<'_>,
    runtime_dir_owned_by: &dyn Fn(&Path, u32) -> bool,
) -> HashMap<String, String> {
    let mut out = env.clone();
    out.insert("FORCE_COLOR".into(), "0".into());
    out.insert("NO_COLOR".into(), "1".into());
    if let Some(android_home) = out.get("ANDROID_HOME").cloned() {
        let emulator = Path::new(&android_home)
            .join("emulator")
            .join(if host.windows() {
                "emulator.exe"
            } else {
                "emulator"
            });
        let emulated = regex::Regex::new(r"\bemulated\b").expect("static regex");
        let imagefile = regex::Regex::new(r"\bimagefile\b").expect("static regex");
        let overrides: Vec<String> = ["front", "back"]
            .iter()
            .filter_map(|facing| {
                let help = camera_help(&emulator, facing, &out)?;
                // The hub wires imagefile cameras unconditionally; older SDK
                // emulators reject that mode.
                (emulated.is_match(&help) && !imagefile.is_match(&help))
                    .then(|| format!("-camera-{facing} emulated"))
            })
            .collect();
        let overrides = overrides.join(" ");
        if !overrides.is_empty() {
            let existing = out
                .get("EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS")
                .cloned()
                .unwrap_or_default();
            let joined = [overrides, existing]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            out.insert("EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS".into(), joined);
        }
    }
    if host == HostPlatform::Linux && !out.contains_key("XDG_RUNTIME_DIR") {
        if let Some(uid) = uid {
            // SSH sessions may omit the directory where the emulator publishes
            // its gRPC token.
            let runtime_dir = PathBuf::from(format!("/run/user/{uid}"));
            if runtime_dir_owned_by(&runtime_dir, uid) {
                out.insert(
                    "XDG_RUNTIME_DIR".into(),
                    runtime_dir.to_string_lossy().into_owned(),
                );
            }
        }
    }
    out
}

/// The hub's command line after `node`. Only a Mac can list Apple simulators;
/// elsewhere the hub's attempt surfaces as an error, so it is told Android.
pub fn hub_args(entry_path: &Path, port: u16, host: HostPlatform) -> Vec<String> {
    let mut args = vec![
        entry_path.to_string_lossy().into_owned(),
        "--port".into(),
        port.to_string(),
        "--host".into(),
        "127.0.0.1".into(),
        "--hide-sidebar".into(),
        "--hide-boot-device".into(),
    ];
    if host != HostPlatform::Darwin {
        args.push("--platform".into());
        args.push("android".into());
    }
    args
}

fn real_camera_help(
    emulator: &Path,
    facing: &str,
    env: &HashMap<String, String>,
) -> Option<String> {
    let mut cmd = std::process::Command::new(emulator);
    cmd.arg(format!("-help-camera-{facing}"))
        .env_clear()
        .envs(env)
        .stdin(std::process::Stdio::null())
        .no_console_window();
    // T3: a 5 second timeout, anything else counts as "no override".
    let out = run_with_timeout(cmd, Duration::from_secs(5)).ok()?;
    out.status.success().then(|| {
        format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        )
    })
}

#[derive(Debug)]
enum RunFailure {
    Spawn(String),
    TimedOut,
}

/// What a bounded, deadline-limited run produced.
struct RunOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Each stream is cut at this many bytes: npm and `emulator -help` stay far
/// below it, and an unbounded read is what process_capture.rs forbids.
const RUN_STREAM_MAX: usize = 1024 * 1024;

/// Run `cmd`, reading both streams through the bounded drain the rest of the
/// app uses, and kill it when `timeout` passes.
fn run_with_timeout(
    mut cmd: std::process::Command,
    timeout: Duration,
) -> Result<RunOutput, RunFailure> {
    use std::process::Stdio;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| RunFailure::Spawn(e.to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or(RunFailure::Spawn("stdout was not piped".into()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or(RunFailure::Spawn("stderr was not piped".into()))?;
    let out =
        std::thread::spawn(move || crate::process_capture::drain_capped(stdout, RUN_STREAM_MAX));
    let err =
        std::thread::spawn(move || crate::process_capture::drain_capped(stderr, RUN_STREAM_MAX));
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return Ok(RunOutput {
                    status,
                    stdout: out.join().map(|(b, _)| b).unwrap_or_default(),
                    stderr: err.join().map(|(b, _)| b).unwrap_or_default(),
                })
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RunFailure::TimedOut);
            }
        }
    }
}

#[cfg(unix)]
fn real_runtime_dir_owned_by(dir: &Path, uid: u32) -> bool {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(dir)
        .map(|m| m.is_dir() && m.uid() == uid)
        .unwrap_or(false)
}
#[cfg(not(unix))]
fn real_runtime_dir_owned_by(_dir: &Path, _uid: u32) -> bool {
    false
}

fn current_uid() -> Option<u32> {
    #[cfg(unix)]
    {
        // SAFETY: getuid has no preconditions and cannot fail.
        Some(unsafe { libc::getuid() })
    }
    #[cfg(not(unix))]
    {
        None
    }
}

// ---------- the running hub ----------

const HUB_READY_TIMEOUT: Duration = Duration::from_secs(30);
const HUB_READY_INTERVAL: Duration = Duration::from_millis(100);
const HUB_READY_PROBE_TIMEOUT: Duration = Duration::from_secs(1);
const HUB_RESTART_STABLE_UPTIME: Duration = Duration::from_secs(60);
const HUB_RESTART_MAX_DELAY_MS: u64 = 30_000;
/// How long a stop waits for SIGTERM before SIGKILL.
const HUB_STOP_GRACE: Duration = Duration::from_secs(3);
const OUTPUT_TAIL_LINES: usize = 40;

/// T3's restart policy: a hub that ran for a minute restarts at once and resets
/// the backoff; one that died sooner waits the current delay, and the next
/// delay doubles from one second to at most thirty. Returns `(delay, next)`.
pub fn restart_delay(current_ms: u64, uptime: Duration) -> (u64, u64) {
    if uptime >= HUB_RESTART_STABLE_UPTIME {
        return (0, 0);
    }
    let next = if current_ms == 0 {
        1_000
    } else {
        (current_ms * 2).min(HUB_RESTART_MAX_DELAY_MS)
    };
    (current_ms, next)
}

/// T3's `HubStateFile`, persisted so a run that ended without finalizers can
/// clean up the loopback listener it left.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubStateFile {
    pub pid: u32,
    pub port: u16,
    pub entry_path: String,
}

struct HubProcess {
    pid: u32,
    origin: String,
    started: Instant,
    /// Dropping this (with the record) stops the hub; see `own_child`.
    _kill: oneshot::Sender<()>,
    exited: watch::Receiver<bool>,
    output: Arc<Mutex<VecDeque<String>>>,
}

impl HubProcess {
    fn alive(&self) -> bool {
        !*self.exited.borrow()
    }
}

struct Inner {
    base_dir: PathBuf,
    proxy: Arc<ProxyState>,
    proxy_port: tokio::sync::Mutex<Option<u16>>,
    running: Mutex<Option<HubProcess>>,
    /// T3's `startLock`: starts, restarts and stops never interleave.
    start_lock: tokio::sync::Mutex<()>,
    restart_delay_ms: Mutex<u64>,
    installing: AtomicBool,
    starting: AtomicBool,
    last_error: Mutex<Option<String>>,
    http: reqwest::Client,
}

/// Tauri managed state for the device hub and its proxy.
pub struct DeviceHubManager {
    inner: Arc<Inner>,
}

impl Default for DeviceHubManager {
    fn default() -> Self {
        Self::with_base_dir(default_base_dir())
    }
}

fn hub_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .expect("reqwest client")
}

impl DeviceHubManager {
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(Inner {
                base_dir,
                proxy: Arc::new(ProxyState::default()),
                proxy_port: tokio::sync::Mutex::new(None),
                running: Mutex::new(None),
                start_lock: tokio::sync::Mutex::new(()),
                restart_delay_ms: Mutex::new(0),
                installing: AtomicBool::new(false),
                starting: AtomicBool::new(false),
                last_error: Mutex::new(None),
                http: hub_http_client(),
            }),
        }
    }

    /// Stop the hub without waiting; for `RunEvent::Exit`, where the runtime
    /// may not get to run the hub's task again. SIGTERM goes out now, and the
    /// child's `kill_on_drop` is the backstop.
    pub fn shutdown(&self) {
        let running = self.inner.set_running(None);
        if let Some(hub) = running {
            terminate_now(hub.pid);
        }
        let _ = std::fs::remove_file(hub_state_path(&self.inner.base_dir));
    }
}

fn hub_state_path(base_dir: &Path) -> PathBuf {
    base_dir.join("hub.json")
}

#[cfg(unix)]
fn terminate_now(pid: u32) {
    // SAFETY: plain signal send to a pid this process spawned.
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
}
#[cfg(windows)]
fn terminate_now(pid: u32) {
    // Absolute, from SystemRoot: never whatever `taskkill` PATH finds first.
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let taskkill = Path::new(&root).join("System32").join("taskkill.exe");
    let mut cmd = std::process::Command::new(taskkill);
    cmd.args(["/PID", &pid.to_string(), "/F"])
        .no_console_window();
    let _ = run_with_timeout(cmd, Duration::from_secs(5));
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // T3: `process.kill(pid, 0)` succeeding.
    // SAFETY: signal 0 only checks for existence.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

impl Inner {
    fn set_running(&self, hub: Option<HubProcess>) -> Option<HubProcess> {
        let origin = hub.as_ref().map(|h| h.origin.clone());
        let previous = std::mem::replace(&mut *self.running.lock().unwrap(), hub);
        *self.proxy.hub_origin.write().unwrap() = origin;
        previous
    }

    fn current_pid(&self) -> Option<u32> {
        self.running.lock().unwrap().as_ref().map(|h| h.pid)
    }

    fn running_origin(&self) -> Option<String> {
        self.running
            .lock()
            .unwrap()
            .as_ref()
            .filter(|h| h.alive())
            .map(|h| h.origin.clone())
    }

    fn host_environment(&self) -> (HashMap<String, String>, AndroidSdk) {
        let env = process_environment();
        let host = HostPlatform::current();
        let sdk = android_sdk(&env, host);
        let env = device_host_environment(&env, sdk.root.as_deref(), host);
        (env, sdk)
    }
}

/// Check PID and entry path before reaping; the PID may have been recycled.
async fn reap_stale_hub(state_path: &Path) {
    let Ok(text) = tokio::fs::read_to_string(state_path).await else {
        return;
    };
    if let Ok(previous) = serde_json::from_str::<HubStateFile>(&text) {
        reap_if_ours(&previous).await;
    }
    let _ = tokio::fs::remove_file(state_path).await;
}

#[cfg(unix)]
async fn reap_if_ours(previous: &HubStateFile) {
    if !process_alive(previous.pid) {
        return;
    }
    // `/bin/ps` on macOS and Linux alike; a GUI app's PATH is not trusted here.
    let mut ps = std::process::Command::new("/bin/ps");
    ps.args(["-o", "command=", "-p", &previous.pid.to_string()]);
    let command_line =
        match tokio::task::spawn_blocking(move || run_with_timeout(ps, Duration::from_secs(5)))
            .await
        {
            Ok(Ok(out)) => String::from_utf8_lossy(&out.stdout).into_owned(),
            _ => String::new(),
        };
    if command_line.contains(&previous.entry_path) {
        log::warn!(
            "Stopping a device hub left behind by a previous run (pid {}, port {})",
            previous.pid,
            previous.port
        );
        terminate_now(previous.pid);
    }
}
/// T3 asks `ps` for the command line, which Windows does not have, so there
/// the record is only removed; the same happens here.
#[cfg(not(unix))]
async fn reap_if_ours(_previous: &HubStateFile) {}

async fn record_hub(state_path: &Path, record: &HubStateFile) {
    let Ok(contents) = serde_json::to_string(record) else {
        return;
    };
    let tmp = state_path.with_extension(format!("json.{}", random_suffix()));
    if tokio::fs::write(&tmp, contents).await.is_ok()
        && tokio::fs::rename(&tmp, state_path).await.is_err()
    {
        let _ = tokio::fs::remove_file(&tmp).await;
    }
}

fn reserve_loopback_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Device hub failed while reserving a port for the device hub: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    Ok(port)
}

/// The child's lifetime: wait for it, or stop it when its record is dropped.
async fn own_child(
    mut child: tokio::process::Child,
    kill: oneshot::Receiver<()>,
    exited: watch::Sender<bool>,
) {
    tokio::select! {
        _ = child.wait() => {}
        _ = kill => {
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                terminate_now(pid);
                if tokio::time::timeout(HUB_STOP_GRACE, child.wait()).await.is_err() {
                    let _ = child.kill().await;
                }
            }
            #[cfg(not(unix))]
            {
                let _ = child.kill().await;
            }
        }
    }
    let _ = exited.send(true);
}

fn pipe_output<R>(reader: R, pid: u32, tail: Arc<Mutex<VecDeque<String>>>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            log::debug!("Device hub output (pid {pid}): {line}");
            let mut tail = tail.lock().unwrap();
            if tail.len() >= OUTPUT_TAIL_LINES {
                tail.pop_front();
            }
            tail.push_back(line);
        }
    });
}

fn hub_error(
    step: &str,
    cause: impl std::fmt::Display,
    output: Option<&Mutex<VecDeque<String>>>,
) -> String {
    let mut msg = format!("The device hub failed while {step}: {cause}");
    if let Some(output) = output {
        let tail: Vec<String> = output
            .lock()
            .unwrap()
            .iter()
            .rev()
            .take(8)
            .rev()
            .cloned()
            .collect();
        if !tail.is_empty() {
            msg.push_str("\n");
            msg.push_str(&tail.join("\n"));
        }
    }
    msg
}

/// T3's `waitForHttpReady({ path: "/readyz" })`: probe every 100 ms with a
/// one second probe timeout, for up to thirty seconds. Canopy also stops early
/// when the hub has already exited, so a crash reports its output at once
/// rather than after the full timeout.
async fn wait_for_ready(
    http: &reqwest::Client,
    origin: &str,
    exited: &watch::Receiver<bool>,
) -> Result<(), String> {
    let url = format!("{origin}/readyz");
    let deadline = Instant::now() + HUB_READY_TIMEOUT;
    let mut last: String;
    loop {
        match tokio::time::timeout(HUB_READY_PROBE_TIMEOUT, http.get(&url).send()).await {
            Ok(Ok(response)) if response.status().is_success() => {
                let _ = response.bytes().await;
                return Ok(());
            }
            Ok(Ok(response)) => last = format!("status {}", response.status()),
            Ok(Err(e)) => last = e.to_string(),
            Err(_) => last = "probe timed out".into(),
        }
        if *exited.borrow() {
            return Err("the hub exited before it answered".into());
        }
        if Instant::now() >= deadline {
            return Err(format!("no answer within 30 seconds ({last})"));
        }
        tokio::time::sleep(HUB_READY_INTERVAL).await;
    }
}

async fn spawn_hub(
    inner: &Arc<Inner>,
    tool: &ToolPaths,
    node: &Path,
) -> Result<HubProcess, String> {
    let state_path = hub_state_path(&inner.base_dir);
    reap_stale_hub(&state_path).await;
    let _ = tokio::fs::create_dir_all(&inner.base_dir).await;
    let port = reserve_loopback_port()?;
    let origin = format!("http://127.0.0.1:{port}");
    let host = HostPlatform::current();
    let (host_env, _) = inner.host_environment();
    let env = tokio::task::spawn_blocking(move || {
        hub_environment(
            &host_env,
            host,
            current_uid(),
            &real_camera_help,
            &real_runtime_dir_owned_by,
        )
    })
    .await
    .map_err(|e| e.to_string())?;

    let mut cmd = tokio::process::Command::new(node);
    cmd.args(hub_args(&tool.entry_path, port, host))
        // T3 runs the hub in the server's working directory. A GUI app's is
        // `/`, so Canopy uses the home directory instead.
        .current_dir(
            env.get("HOME")
                .or_else(|| env.get("USERPROFILE"))
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir),
        )
        .env_clear()
        .envs(&env)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .no_console_window();
    let mut child = cmd
        .spawn()
        .map_err(|e| hub_error("starting the device hub", e, None))?;
    let pid = child.id().unwrap_or(0);
    let output = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(stdout) = child.stdout.take() {
        pipe_output(stdout, pid, output.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        pipe_output(stderr, pid, output.clone());
    }
    let (kill_tx, kill_rx) = oneshot::channel();
    let (exit_tx, exit_rx) = watch::channel(false);
    tokio::spawn(own_child(child, kill_rx, exit_tx));
    // From here the record owns the child: returning an error drops it, which
    // stops the hub, as T3's `Effect.onError(Scope.close)` does.
    let hub = HubProcess {
        pid,
        origin: origin.clone(),
        started: Instant::now(),
        _kill: kill_tx,
        exited: exit_rx,
        output,
    };
    wait_for_ready(&inner.http, &origin, &hub.exited)
        .await
        .map_err(|e| hub_error("waiting for the device hub to answer", e, Some(&hub.output)))?;
    record_hub(
        &state_path,
        &HubStateFile {
            pid,
            port,
            entry_path: tool.entry_path.to_string_lossy().into_owned(),
        },
    )
    .await;
    log::info!("Device hub started (pid {pid}, port {port})");
    Ok(hub)
}

/// Waits for the hub's lifetime and restarts it, as T3's `superviseHub`.
async fn supervise(
    inner: Arc<Inner>,
    first: (u32, watch::Receiver<bool>, Instant),
    tool: ToolPaths,
    node: PathBuf,
) {
    let (mut pid, mut exited, mut started) = first;
    loop {
        let _ = exited.wait_for(|e| *e).await;
        if inner.current_pid() != Some(pid) {
            return;
        }
        let delay = {
            let mut current = inner.restart_delay_ms.lock().unwrap();
            let (delay, next) = restart_delay(*current, started.elapsed());
            *current = next;
            delay
        };
        log::warn!("Device hub exited; restarting (pid {pid}, delay {delay} ms)");
        tokio::time::sleep(Duration::from_millis(delay)).await;
        let _guard = inner.start_lock.lock().await;
        if inner.current_pid() != Some(pid) {
            return;
        }
        match spawn_hub(&inner, &tool, &node).await {
            Ok(replacement) => {
                pid = replacement.pid;
                exited = replacement.exited.clone();
                started = replacement.started;
                inner.set_running(Some(replacement));
            }
            Err(e) => {
                // T3 logs and leaves the dead record; the next ensure_ready
                // finds it not running and starts a fresh hub.
                log::warn!("Device hub supervisor failed: {e}");
                *inner.last_error.lock().unwrap() = Some(e);
                return;
            }
        }
    }
}

pub const NOT_INSTALLED: &str =
    "Device streaming tools are not installed. Install them from the Device tab to stream devices.";

impl DeviceHubManager {
    /// T3's `ensureHubReady`, without the install: Canopy installs only from
    /// the consent step (`device_hub_install`).
    pub async fn ensure_ready(&self) -> Result<String, String> {
        let inner = &self.inner;
        let _guard = inner.start_lock.lock().await;
        if let Some(origin) = inner.running_origin() {
            return Ok(origin);
        }
        let (env, _) = inner.host_environment();
        let node = resolve_node(&env, HostPlatform::current())?;
        let tool = tool_paths(&inner.base_dir);
        if !is_installed(&tool) {
            return Err(NOT_INSTALLED.into());
        }
        inner.starting.store(true, Ordering::SeqCst);
        let spawned = spawn_hub(inner, &tool, &node).await;
        inner.starting.store(false, Ordering::SeqCst);
        let hub = match spawned {
            Ok(hub) => hub,
            Err(e) => {
                *inner.last_error.lock().unwrap() = Some(e.clone());
                return Err(e);
            }
        };
        let first = (hub.pid, hub.exited.clone(), hub.started);
        let origin = hub.origin.clone();
        // A dead hub's record stays until a replacement is published.
        inner.set_running(Some(hub));
        *inner.restart_delay_ms.lock().unwrap() = 0;
        *inner.last_error.lock().unwrap() = None;
        tokio::spawn(supervise(inner.clone(), first, tool, node));
        Ok(origin)
    }

    pub async fn stop(&self) {
        let inner = &self.inner;
        let _guard = inner.start_lock.lock().await;
        if let Some(hub) = inner.set_running(None) {
            let mut exited = hub.exited.clone();
            drop(hub);
            let _ = tokio::time::timeout(
                HUB_STOP_GRACE + Duration::from_secs(1),
                exited.wait_for(|e| *e),
            )
            .await;
        }
        let _ = tokio::fs::remove_file(hub_state_path(&inner.base_dir)).await;
    }

    pub async fn install(&self) -> Result<(), String> {
        let inner = &self.inner;
        let (env, _) = inner.host_environment();
        // Checked first: an installed hub that cannot run helps nobody.
        resolve_node(&env, HostPlatform::current())?;
        inner.installing.store(true, Ordering::SeqCst);
        let result = install_hub(&inner.base_dir, &env).await;
        inner.installing.store(false, Ordering::SeqCst);
        match result {
            Ok(_) => Ok(()),
            Err(e) => {
                *inner.last_error.lock().unwrap() = Some(e.clone());
                Err(e)
            }
        }
    }

    /// The proxy's base URLs and a fresh ticket (T3's `resolveDeviceHubAccess`
    /// for a bearer connection: query `wsTicket`, no credentials).
    pub async fn access(&self) -> Result<DeviceHubAccess, String> {
        let port = {
            let mut port = self.inner.proxy_port.lock().await;
            match *port {
                Some(p) => p,
                None => {
                    let p = crate::devicehub_proxy::serve(self.inner.proxy.clone()).await?;
                    *port = Some(p);
                    p
                }
            }
        };
        let http_base = format!("http://127.0.0.1:{port}{DEVICE_HUB_ROUTE_PREFIX}");
        Ok(DeviceHubAccess {
            ws_base: http_base.replacen("http", "ws", 1),
            http_base,
            query: HashMap::from([("wsTicket".to_string(), self.inner.proxy.tickets.mint())]),
            credentials: false,
        })
    }

    pub fn status(&self) -> DeviceHubStatus {
        let inner = &self.inner;
        let host = HostPlatform::current();
        let (env, sdk) = inner.host_environment();
        let node = resolve_node(&env, host);
        let path_var = env_path(&env);
        let npm = find_on_path(
            if host.windows() { "npm.cmd" } else { "npm" },
            &path_var,
            host,
        )
        .or_else(|| {
            find_on_path(
                if host.windows() { "pnpm.cmd" } else { "pnpm" },
                &path_var,
                host,
            )
        });
        let xcrun =
            host == HostPlatform::Darwin && find_on_path("xcrun", &path_var, host).is_some();
        let tool = tool_paths(&inner.base_dir);
        let platforms = [DevicePlatform::Ios, DevicePlatform::Android]
            .into_iter()
            .map(|platform| {
                let reason = platform_reason(platform, host, &sdk, xcrun);
                PlatformAvailability {
                    platform,
                    available: reason.is_none(),
                    reason,
                }
            })
            .collect();
        DeviceHubStatus {
            installed: is_installed(&tool),
            running: inner.running_origin().is_some(),
            installing: inner.installing.load(Ordering::SeqCst),
            starting: inner.starting.load(Ordering::SeqCst),
            version: DEVICE_HUB_VERSION,
            install_dir: tool.install_dir.to_string_lossy().into_owned(),
            node_error: node.err(),
            npm_available: npm.is_some(),
            platforms,
            error: inner.last_error.lock().unwrap().clone(),
        }
    }

    fn origin(&self) -> Result<String, String> {
        self.inner
            .running_origin()
            .ok_or_else(|| "The device hub is not running.".to_string())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceHubAccess {
    pub http_base: String,
    pub ws_base: String,
    pub query: HashMap<String, String>,
    pub credentials: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformAvailability {
    pub platform: DevicePlatform,
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceHubStatus {
    pub installed: bool,
    pub running: bool,
    pub installing: bool,
    pub starting: bool,
    pub version: &'static str,
    pub install_dir: String,
    pub node_error: Option<String>,
    pub npm_available: bool,
    pub platforms: Vec<PlatformAvailability>,
    pub error: Option<String>,
}

// ---------- DeviceHubOperations.ts ----------

const BOOT_TIMEOUT: Duration = Duration::from_secs(3 * 60);
const OPERATION_TIMEOUT: Duration = Duration::from_secs(15);
// Let the hub's 30 s simctl timeout report its cause first.
const LIST_TIMEOUT: Duration = Duration::from_secs(40);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDevice {
    pub id: String,
    pub name: String,
    pub version: String,
    pub platform: DevicePlatform,
    pub booted: bool,
    pub physical: bool,
}

#[derive(Debug, Clone, Deserialize)]
struct HubError {
    message: String,
    error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct HubDeviceList {
    simulators: Vec<HostDevice>,
    emulators: Vec<HostDevice>,
    errors: Option<Vec<HubError>>,
}

#[derive(Debug, Clone, Deserialize)]
struct HubActionResult {
    ok: bool,
    id: Option<String>,
    serial: Option<String>,
    error: Option<String>,
    errors: Option<Vec<HubError>>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeviceListing {
    pub devices: Vec<HostDevice>,
    pub detail: Option<String>,
    pub android_discovery_incomplete: bool,
    pub incomplete_platforms: Vec<DevicePlatform>,
}

// Hub diagnostics can carry a whole stderr dump.
fn bound_diagnostics(text: &str) -> String {
    if text.chars().count() > 2_000 {
        format!("{}…", text.chars().take(1_999).collect::<String>())
    } else {
        text.to_string()
    }
}

// The hub's `error` is a util.inspect of Node's exec error; the stack and the
// inspected fields follow the first frame, so keep the lines before it.
fn error_head(error: &str) -> String {
    let frame = regex::Regex::new(r"^\s+at ").expect("static regex");
    error
        .lines()
        .take_while(|l| !frame.is_match(l))
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn vendor_prefix(platform: DevicePlatform) -> &'static str {
    match platform {
        DevicePlatform::Ios => "/vendor/serve-sim",
        DevicePlatform::Android => "/vendor/serve-emu",
    }
}

/// Merge the hub's listing with AVDs it does not report until they boot.
/// `avds` is `emulator -list-avds`'s (exit code, stdout) when Android is
/// available here.
fn merge_listing(
    hub: HubDeviceList,
    android_available: bool,
    avds: Option<(i32, String)>,
) -> DeviceListing {
    let mut devices: Vec<HostDevice> = hub
        .simulators
        .iter()
        .chain(hub.emulators.iter())
        .cloned()
        .collect();
    let plist =
        regex::Regex::new(r"/CoreSimulator/Devices/[^/]+/device\.plist:$").expect("static regex");
    let enoent = regex::Regex::new(r#"(?:^Error:\s*ENOENT:|\bcode:\s*['"]ENOENT['"])"#)
        .expect("static regex");
    let mut details: Vec<String> = hub
        .errors
        .iter()
        .flatten()
        .filter(|e| {
            // The host summary already explains a missing Android SDK; the
            // hub's failed probes are noise.
            !(!android_available && e.message.starts_with("[android-utils] "))
                // CoreSimulator can retain deleted devices.
                && !(e.message.starts_with("[apple-utils] Failed to read CoreSimulator plist at ")
                    && plist.is_match(&e.message)
                    && enoent.is_match(e.error.as_deref().unwrap_or("")))
        })
        .map(|e| {
            let head = error_head(e.error.as_deref().unwrap_or(""));
            bound_diagnostics(&if head.is_empty() {
                e.message.clone()
            } else {
                format!("{} {head}", e.message)
            })
        })
        .collect();
    let mut android_discovery_incomplete = false;
    if let Some((code, stdout)) = avds {
        if code != 0 {
            android_discovery_incomplete = true;
            details.push(format!("Could not list Android virtual devices (emulator -list-avds, exit code {code}). Discovered devices remain available."));
        }
        let names = if code == 0 { stdout } else { String::new() };
        for name in names.lines().map(str::trim).filter(|l| !l.is_empty()) {
            if !devices
                .iter()
                .any(|d| d.platform == DevicePlatform::Android && d.name == name)
            {
                devices.push(HostDevice {
                    id: name.into(),
                    name: name.into(),
                    platform: DevicePlatform::Android,
                    version: "Android".into(),
                    booted: false,
                    physical: false,
                });
            }
        }
    }
    // expo-device-hub 0.19.1 reports a failed simulator listing only as text.
    let simulator_list_failed = regex::Regex::new(r"^\[apple-utils\] (?:Failed to (?:run `xcrun simctl list devices|parse JSON output:|list devices:)|`xcrun simctl list devices --json` did not respond within )").expect("static regex");
    let simulators_unlisted = hub.simulators.is_empty()
        && hub
            .errors
            .iter()
            .flatten()
            .any(|e| simulator_list_failed.is_match(&e.message));
    DeviceListing {
        devices,
        detail: (!details.is_empty()).then(|| details.join("\n")),
        android_discovery_incomplete,
        incomplete_platforms: if simulators_unlisted {
            vec![DevicePlatform::Ios]
        } else {
            vec![]
        },
    }
}

impl DeviceHubManager {
    pub async fn list(&self) -> Result<DeviceListing, String> {
        let origin = self.origin()?;
        let host = HostPlatform::current();
        let (env, sdk) = self.inner.host_environment();
        let android_available =
            platform_reason(DevicePlatform::Android, host, &sdk, false).is_none();
        let listed = tokio::time::timeout(LIST_TIMEOUT, async {
            let response = self
                .inner
                .http
                .get(format!("{origin}/api/devices"))
                .send()
                .await
                .and_then(|r| r.error_for_status())
                .map_err(|e| e.to_string())?;
            let body = response.bytes().await.map_err(|e| e.to_string())?;
            serde_json::from_slice::<HubDeviceList>(&body).map_err(|e| e.to_string())
        })
        .await;
        let hub = match listed {
            Err(_) => {
                return Ok(DeviceListing {
                    detail: Some(format!(
                        "The device hub did not answer within {} seconds.",
                        LIST_TIMEOUT.as_secs()
                    )),
                    incomplete_platforms: if android_available {
                        vec![DevicePlatform::Android]
                    } else {
                        vec![]
                    },
                    ..Default::default()
                })
            }
            Ok(Err(e)) => return Err(format!("Listing devices failed: {e}")),
            Ok(Ok(hub)) => hub,
        };
        let avds = if android_available {
            let emulator = sdk.root.as_ref().map(|r| {
                r.join("emulator").join(if host.windows() {
                    "emulator.exe"
                } else {
                    "emulator"
                })
            });
            let env = env.clone();
            tokio::task::spawn_blocking(move || {
                let emulator = emulator?;
                let mut cmd = std::process::Command::new(emulator);
                cmd.arg("-list-avds")
                    .env_clear()
                    .envs(&env)
                    .stdin(std::process::Stdio::null())
                    .no_console_window();
                Some(match run_with_timeout(cmd, Duration::from_secs(20)) {
                    Ok(out) => (
                        out.status.code().unwrap_or(127),
                        String::from_utf8_lossy(&out.stdout).into_owned(),
                    ),
                    Err(_) => (124, String::new()),
                })
            })
            .await
            .ok()
            .flatten()
        } else {
            None
        };
        Ok(merge_listing(hub, android_available, avds))
    }

    async fn post_action(
        &self,
        path: &str,
        body: serde_json::Value,
        timeout: Duration,
    ) -> Result<HubActionResult, String> {
        let origin = self.origin()?;
        let request = self
            .inner
            .http
            .post(format!("{origin}{path}"))
            .header("content-type", "application/json")
            .body(body.to_string())
            .send();
        let response = tokio::time::timeout(timeout, request)
            .await
            .map_err(|_| "The device hub did not answer in time.".to_string())?
            .and_then(|r| r.error_for_status())
            .map_err(|e| e.to_string())?;
        let body = tokio::time::timeout(timeout, response.bytes())
            .await
            .map_err(|_| "The device hub did not answer in time.".to_string())?
            .map_err(|e| e.to_string())?;
        serde_json::from_slice::<HubActionResult>(&body).map_err(|e| e.to_string())
    }

    pub async fn boot(&self, device: HostDevice) -> Result<String, String> {
        let result = self
            .post_action(
                "/api/devices/boot",
                serde_json::json!({ "platform": device.platform, "id": device.id, "name": device.name }),
                BOOT_TIMEOUT,
            )
            .await?;
        if !result.ok {
            // Keep the hub's launch command and nested failure for recovery.
            let diagnostics: Vec<String> = std::iter::once(result.error.clone())
                .chain(
                    result
                        .errors
                        .iter()
                        .flatten()
                        .flat_map(|e| [Some(e.message.clone()), e.error.clone()]),
                )
                .flatten()
                .filter(|t| !t.trim().is_empty())
                .collect();
            let diagnostics = bound_diagnostics(&diagnostics.join("\n\n"));
            return Err(if diagnostics.is_empty() {
                format!("Could not boot {}.", device.name)
            } else {
                format!("Could not boot {}: {diagnostics}", device.name)
            });
        }
        if device.platform == DevicePlatform::Ios {
            // Booting alone does not attach a serve-sim helper; the grid start
            // does both and is idempotent for a booted simulator.
            self.post_action(
                "/vendor/serve-sim/grid/api/start",
                serde_json::json!({ "udid": device.id }),
                BOOT_TIMEOUT,
            )
            .await?;
        }
        Ok(result.serial.or(result.id).unwrap_or(device.id))
    }

    /// DeviceHubOperations `attach`: iOS needs the serve-sim helper attached
    /// before its stream exists; Android needs nothing.
    pub async fn attach(&self, device: &HostDevice) -> Result<(), String> {
        if device.platform == DevicePlatform::Ios {
            self.post_action(
                "/vendor/serve-sim/grid/api/start",
                serde_json::json!({ "udid": device.id }),
                BOOT_TIMEOUT,
            )
            .await?;
        }
        Ok(())
    }

    pub async fn shutdown_device(&self, device: HostDevice) -> Result<(), String> {
        let rejected = |r: HubActionResult| {
            if r.ok {
                Ok(())
            } else {
                Err(r
                    .error
                    .unwrap_or_else(|| "The device hub refused to shut the device down.".into()))
            }
        };
        if device.platform == DevicePlatform::Ios {
            // serve-sim's shutdown closes its capture session before `simctl
            // shutdown`; serve-sim runs simctl bare, so a simulator that is
            // already off fails there.
            let attempt = self
                .post_action(
                    &format!("{}/grid/api/shutdown", vendor_prefix(DevicePlatform::Ios)),
                    serde_json::json!({ "udid": device.id }),
                    OPERATION_TIMEOUT,
                )
                .await
                .and_then(rejected);
            if let Err(e) = attempt {
                let off = self
                    .list()
                    .await
                    .ok()
                    .and_then(|l| l.devices.into_iter().find(|d| d.id == device.id))
                    .is_some_and(|d| !d.booted);
                if !off {
                    return Err(e);
                }
            }
            return Ok(());
        }
        self.post_action(
            "/api/devices/shutdown",
            serde_json::json!({ "platform": device.platform, "id": device.id }),
            OPERATION_TIMEOUT,
        )
        .await
        .and_then(rejected)
    }
}

// ---------- Tauri commands ----------

type Hub<'a> = tauri::State<'a, DeviceHubManager>;

#[tauri::command]
pub async fn device_hub_status(hub: Hub<'_>) -> Result<DeviceHubStatus, String> {
    Ok(hub.status())
}

/// The consent step: install the pinned hub. Only the setup card calls this.
#[tauri::command]
pub async fn device_hub_install(hub: Hub<'_>) -> Result<DeviceHubStatus, String> {
    hub.install().await?;
    Ok(hub.status())
}

#[tauri::command]
pub async fn device_hub_start(hub: Hub<'_>) -> Result<DeviceHubStatus, String> {
    hub.ensure_ready().await?;
    Ok(hub.status())
}

#[tauri::command]
pub async fn device_hub_stop(hub: Hub<'_>) -> Result<(), String> {
    hub.stop().await;
    Ok(())
}

#[tauri::command]
pub async fn device_hub_access(hub: Hub<'_>) -> Result<DeviceHubAccess, String> {
    hub.access().await
}

#[tauri::command]
pub async fn device_hub_devices(hub: Hub<'_>) -> Result<DeviceListing, String> {
    hub.list().await
}

#[tauri::command]
pub async fn device_hub_boot(hub: Hub<'_>, device: HostDevice) -> Result<String, String> {
    hub.boot(device).await
}

#[tauri::command]
pub async fn device_hub_attach(hub: Hub<'_>, device: HostDevice) -> Result<(), String> {
    hub.attach(&device).await
}

#[tauri::command]
pub async fn device_hub_shutdown(hub: Hub<'_>, device: HostDevice) -> Result<(), String> {
    hub.shutdown_device(device).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("canopy-devicehub-{name}-{}", random_suffix()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn devicehub_hub_args_match_t3() {
        let entry = Path::new(
            "/tools/expo-device-hub/0.19.1/node_modules/expo-device-hub/dist/server/cli.mjs",
        );
        assert_eq!(
            hub_args(entry, 41234, HostPlatform::Linux),
            vec![
                entry.to_string_lossy().into_owned(),
                "--port".into(),
                "41234".into(),
                "--host".into(),
                "127.0.0.1".into(),
                "--hide-sidebar".into(),
                "--hide-boot-device".into(),
                "--platform".into(),
                "android".into(),
            ]
        );
        let mac = hub_args(entry, 1, HostPlatform::Darwin);
        assert!(
            !mac.contains(&"--platform".to_string()),
            "a Mac lists both platforms"
        );
        assert!(hub_args(entry, 1, HostPlatform::Windows)
            .ends_with(&["--platform".into(), "android".into()]));
    }

    #[test]
    fn devicehub_tool_paths_and_sentinel() {
        let base = temp_dir("paths");
        let paths = tool_paths(&base);
        assert_eq!(
            paths.install_dir,
            base.join("expo-device-hub").join("0.19.1")
        );
        assert!(paths
            .entry_path
            .ends_with("node_modules/expo-device-hub/dist/server/cli.mjs"));
        assert!(!is_installed(&paths));
        std::fs::create_dir_all(paths.entry_path.parent().unwrap()).unwrap();
        std::fs::write(&paths.entry_path, "").unwrap();
        assert!(
            !is_installed(&paths),
            "an entry without the sentinel is a partial install"
        );
        std::fs::write(&paths.sentinel_path, "0.18.0\n").unwrap();
        assert!(!is_installed(&paths), "the sentinel must name this version");
        std::fs::write(&paths.sentinel_path, "0.19.1\n").unwrap();
        assert!(is_installed(&paths));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn devicehub_host_environment_puts_sdk_tools_first() {
        let base = env(&[("PATH", "/usr/bin:/bin"), ("HOME", "/home/u")]);
        let out = device_host_environment(&base, Some(Path::new("/sdk")), HostPlatform::Linux);
        assert_eq!(out["ANDROID_HOME"], "/sdk");
        assert_eq!(
            out["PATH"],
            "/sdk/platform-tools:/sdk/emulator:/usr/bin:/bin"
        );
        let untouched = device_host_environment(&base, None, HostPlatform::Linux);
        assert_eq!(untouched, base);
        // Windows: one PATH key, `;`-joined.
        let win = env(&[("Path", "C:\\Windows")]);
        let out = device_host_environment(&win, Some(Path::new("C:\\sdk")), HostPlatform::Windows);
        assert!(!out.contains_key("Path"));
        assert!(out["PATH"].ends_with(";C:\\Windows"));
    }

    #[test]
    fn devicehub_hub_environment_matches_t3() {
        let base = env(&[("PATH", "/usr/bin"), ("ANDROID_HOME", "/sdk")]);
        let no_help: CameraHelp = &|_, _, _| None;
        let owned = |_: &Path, _: u32| true;
        let out = hub_environment(&base, HostPlatform::Linux, Some(1000), no_help, &owned);
        assert_eq!(out["FORCE_COLOR"], "0");
        assert_eq!(out["NO_COLOR"], "1");
        assert_eq!(out["XDG_RUNTIME_DIR"], "/run/user/1000");
        assert!(!out.contains_key("EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS"));

        // An emulator that offers `emulated` but not `imagefile` gets overrides,
        // ahead of anything the user set.
        let old_sdk: CameraHelp = &|emulator, facing, _| {
            assert_eq!(emulator, Path::new("/sdk/emulator/emulator"));
            Some(format!("-camera-{facing} <mode>: none, emulated, webcam0"))
        };
        let mut with_user = base.clone();
        with_user.insert(
            "EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS".into(),
            "-no-snapshot".into(),
        );
        let out = hub_environment(&with_user, HostPlatform::Linux, Some(1000), old_sdk, &owned);
        assert_eq!(
            out["EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS"],
            "-camera-front emulated -camera-back emulated -no-snapshot"
        );
        // A current emulator supports imagefile: no override.
        let current: CameraHelp = &|_, _, _| Some("none, emulated, imagefile, webcam0".into());
        let out = hub_environment(&base, HostPlatform::Linux, Some(1000), current, &owned);
        assert!(!out.contains_key("EXPO_DEVICE_HUB_EMULATOR_EXTRA_ARGS"));

        // XDG_RUNTIME_DIR: only on Linux, only when unset, only when owned.
        let not_owned = |_: &Path, _: u32| false;
        assert!(
            !hub_environment(&base, HostPlatform::Linux, Some(1000), no_help, &not_owned)
                .contains_key("XDG_RUNTIME_DIR")
        );
        assert!(
            !hub_environment(&base, HostPlatform::Darwin, Some(501), no_help, &owned)
                .contains_key("XDG_RUNTIME_DIR")
        );
        let mut set = base.clone();
        set.insert("XDG_RUNTIME_DIR".into(), "/custom".into());
        assert_eq!(
            hub_environment(&set, HostPlatform::Linux, Some(1000), no_help, &owned)
                ["XDG_RUNTIME_DIR"],
            "/custom"
        );
        // No SDK: no camera probing at all.
        let probed: CameraHelp = &|_, _, _| panic!("no ANDROID_HOME, no probe");
        hub_environment(
            &env(&[("PATH", "/bin")]),
            HostPlatform::Linux,
            None,
            probed,
            &owned,
        );
    }

    #[test]
    fn devicehub_android_sdk_detection() {
        let home = temp_dir("sdk");
        let root = home.join("Android").join("Sdk");
        std::fs::create_dir_all(root.join("platform-tools")).unwrap();
        std::fs::write(root.join("platform-tools").join("adb"), "").unwrap();
        let e = env(&[("HOME", home.to_str().unwrap()), ("PATH", "")]);
        let sdk = android_sdk(&e, HostPlatform::Linux);
        assert_eq!(sdk.root.as_deref(), Some(root.as_path()));
        assert!(sdk.adb && !sdk.emulator);
        assert_eq!(
            platform_reason(DevicePlatform::Android, HostPlatform::Linux, &sdk, false),
            Some(format!(
                "Android Emulator is missing from {}. Install it in Android Studio's SDK Manager.",
                root.display()
            ))
        );
        std::fs::create_dir_all(root.join("emulator")).unwrap();
        std::fs::write(root.join("emulator").join("emulator"), "").unwrap();
        std::fs::create_dir_all(root.join("tools/bin")).unwrap();
        std::fs::write(root.join("tools/bin/avdmanager"), "").unwrap();
        let sdk = android_sdk(&e, HostPlatform::Linux);
        assert!(sdk.legacy_avdmanager);
        assert!(
            platform_reason(DevicePlatform::Android, HostPlatform::Linux, &sdk, false)
                .unwrap()
                .contains("older, unsupported version")
        );
        std::fs::create_dir_all(root.join("cmdline-tools/latest/bin")).unwrap();
        std::fs::write(root.join("cmdline-tools/latest/bin/avdmanager"), "").unwrap();
        let sdk = android_sdk(&e, HostPlatform::Linux);
        assert_eq!(
            platform_reason(DevicePlatform::Android, HostPlatform::Linux, &sdk, false),
            None
        );
        // An explicit ANDROID_HOME wins and is reported even when empty.
        let explicit = env(&[
            ("HOME", home.to_str().unwrap()),
            ("ANDROID_HOME", "/nowhere"),
        ]);
        let sdk = android_sdk(&explicit, HostPlatform::Linux);
        assert_eq!(sdk.root.as_deref(), Some(Path::new("/nowhere")));
        assert!(!sdk.adb);
        // Nothing found.
        let empty = env(&[("HOME", "/definitely/not/a/home"), ("PATH", "")]);
        assert_eq!(
            android_sdk(&empty, HostPlatform::Linux),
            AndroidSdk::default()
        );
        assert!(platform_reason(
            DevicePlatform::Android,
            HostPlatform::Linux,
            &AndroidSdk::default(),
            false
        )
        .unwrap()
        .starts_with("Android SDK was not found."));
        assert_eq!(
            platform_reason(
                DevicePlatform::Ios,
                HostPlatform::Linux,
                &AndroidSdk::default(),
                true
            )
            .as_deref(),
            Some("iOS Simulators need macOS with Xcode.")
        );
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn devicehub_android_sdk_from_an_adb_on_path() {
        let home = temp_dir("sdkpath");
        // Canonical: on macOS the temp dir is a symlink (/var → /private/var) and
        // the SDK root comes back resolved.
        let root = std::fs::canonicalize(&home).unwrap().join("custom-sdk");
        std::fs::create_dir_all(root.join("platform-tools")).unwrap();
        std::fs::write(root.join("platform-tools").join("adb"), "").unwrap();
        let e = env(&[
            ("HOME", "/definitely/not/a/home"),
            ("PATH", root.join("platform-tools").to_str().unwrap()),
        ]);
        assert_eq!(android_sdk(&e, HostPlatform::Linux).root, Some(root));
        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn devicehub_node_resolution() {
        let dir = temp_dir("node");
        let e = env(&[("PATH", dir.to_str().unwrap())]);
        assert_eq!(
            resolve_node(&e, HostPlatform::Linux).unwrap_err(),
            NODE_UNAVAILABLE
        );
        std::fs::write(dir.join("node"), "").unwrap();
        assert_eq!(
            resolve_node(&e, HostPlatform::Linux).unwrap(),
            std::fs::canonicalize(dir.join("node")).unwrap()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn devicehub_restart_backoff() {
        let quick = Duration::from_secs(1);
        assert_eq!(restart_delay(0, quick), (0, 1_000));
        assert_eq!(restart_delay(1_000, quick), (1_000, 2_000));
        assert_eq!(restart_delay(16_000, quick), (16_000, 30_000));
        assert_eq!(restart_delay(30_000, quick), (30_000, 30_000));
        assert_eq!(restart_delay(30_000, Duration::from_secs(60)), (0, 0));
    }

    #[test]
    fn devicehub_state_file_is_t3s_shape() {
        let record = HubStateFile {
            pid: 42,
            port: 5555,
            entry_path: "/x/cli.mjs".into(),
        };
        let json = serde_json::to_string(&record).unwrap();
        assert_eq!(json, r#"{"pid":42,"port":5555,"entryPath":"/x/cli.mjs"}"#);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn devicehub_reaps_only_its_own_stale_hub() {
        let dir = temp_dir("reap");
        let state = dir.join("hub.json");
        let write = |pid: u32, entry: &str| {
            let record = HubStateFile {
                pid,
                port: 1,
                entry_path: entry.into(),
            };
            std::fs::write(&state, serde_json::to_string(&record).unwrap()).unwrap();
        };
        // `; true` keeps the shell from exec'ing sleep, so its own argv (which
        // carries the entry path as $0) is what `ps` reports.
        let spawn = |argv0: &str| {
            std::process::Command::new("sh")
                .args(["-c", "sleep 30; true", argv0])
                .spawn()
                .unwrap()
        };
        // A live process that is not the hub (a recycled pid): left alone.
        let mut bystander = spawn("/somewhere/else.mjs");
        write(bystander.id(), "/not/the/hub/cli.mjs");
        reap_stale_hub(&state).await;
        assert!(!state.exists(), "the record is removed either way");
        assert!(
            bystander.try_wait().unwrap().is_none(),
            "a recycled pid is not killed"
        );
        // The previous run's hub: its command line names the entry.
        let entry = dir.join("cli.mjs").to_string_lossy().into_owned();
        let mut stale = spawn(&entry);
        write(stale.id(), &entry);
        reap_stale_hub(&state).await;
        let deadline = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = stale.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "the stale hub was not stopped");
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert!(!status.success());
        let _ = bystander.kill();
        let _ = bystander.wait();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn devicehub_listing_merges_avds_and_filters_noise() {
        let hub: HubDeviceList = serde_json::from_value(serde_json::json!({
            "simulators": [],
            "emulators": [{ "id": "emulator-5554", "name": "Pixel_8", "version": "35", "platform": "android", "booted": true, "physical": false }],
            "errors": [
                { "message": "[android-utils] probe failed" },
                { "message": "[apple-utils] Failed to list devices: boom", "error": "Error: boom\n    at x (y.js:1)\n    at z" }
            ]
        }))
        .unwrap();
        let listing = merge_listing(hub, true, Some((0, "Pixel_8\nTablet\n".into())));
        let names: Vec<&str> = listing.devices.iter().map(|d| d.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["Pixel_8", "Tablet"],
            "a booted AVD is not listed twice"
        );
        assert!(!listing.devices[1].booted);
        assert_eq!(listing.incomplete_platforms, vec![DevicePlatform::Ios]);
        let detail = listing.detail.unwrap();
        assert!(detail.contains("[apple-utils] Failed to list devices: boom Error: boom"));
        assert!(!detail.contains("at x"), "stack frames are dropped");
        assert!(detail.contains("[android-utils] probe failed"));

        let hub: HubDeviceList = serde_json::from_value(serde_json::json!({
            "simulators": [], "emulators": [],
            "errors": [{ "message": "[android-utils] probe failed" }]
        }))
        .unwrap();
        let listing = merge_listing(hub, false, None);
        assert!(
            listing.detail.is_none(),
            "a missing SDK's probe noise is hidden"
        );

        let hub: HubDeviceList =
            serde_json::from_value(serde_json::json!({ "simulators": [], "emulators": [] }))
                .unwrap();
        let listing = merge_listing(hub, true, Some((1, String::new())));
        assert!(listing.android_discovery_incomplete);
    }

    /// Real integration: install the pinned hub into a temp home, start it,
    /// and reach it through the proxy. With a booted Android device or
    /// emulator, also open its stream socket and read SEMU-framed video.
    ///
    /// `cargo test --lib -- devicehub --ignored --nocapture`
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs network for npm, node, and optionally adb with a device"]
    async fn devicehub_integration_hub_through_the_proxy() {
        use futures_util::StreamExt;
        let base = std::env::var_os("CANOPY_DEVICEHUB_TEST_BASE")
            .map(PathBuf::from)
            .unwrap_or_else(|| temp_dir("integration"));
        let hub = DeviceHubManager::with_base_dir(base.clone());
        let status = hub.status();
        eprintln!("status before install: {status:?}");
        if !status.installed {
            hub.install().await.expect("install");
        }
        assert!(hub.status().installed);
        let origin = hub.ensure_ready().await.expect("start");
        eprintln!("hub at {origin}");
        let state: HubStateFile =
            serde_json::from_str(&std::fs::read_to_string(base.join("hub.json")).unwrap()).unwrap();
        eprintln!("recorded {state:?}");
        let access = hub.access().await.unwrap();
        let ticket = &access.query["wsTicket"];
        let client = reqwest::Client::builder().no_proxy().build().unwrap();

        let devices = client
            .get(format!(
                "{}/api/devices?wsTicket={ticket}",
                access.http_base
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(devices.status(), 200);
        assert_eq!(devices.headers()["cache-control"], "no-store, no-transform");
        let body: serde_json::Value =
            serde_json::from_slice(&devices.bytes().await.unwrap()).unwrap();
        eprintln!("proxied /api/devices: {body}");
        assert!(body.get("emulators").is_some());

        let exec = client
            .post(format!(
                "{}/vendor/serve-sim/exec?wsTicket={ticket}",
                access.http_base
            ))
            .body("{\"command\":\"id\"}")
            .send()
            .await
            .unwrap();
        assert_eq!(exec.status(), 404, "the exec route is refused");
        let no_ticket = client
            .get(format!("{}/api/devices", access.http_base))
            .send()
            .await
            .unwrap();
        assert_eq!(no_ticket.status(), 401);

        let listing = hub.list().await.unwrap();
        eprintln!("listing: {listing:?}");

        let booted = listing
            .devices
            .iter()
            .find(|d| d.platform == DevicePlatform::Android && d.booted)
            .cloned();
        if let Some(device) = booted {
            // T3's viewer asks serve-emu's /api first (its WebRTC probe), which
            // also starts serve-emu's session for the device.
            let api = client
                .get(format!(
                    "{}/vendor/serve-emu/api?device={}&wsTicket={ticket}",
                    access.http_base, device.id
                ))
                .send()
                .await
                .unwrap();
            let api_status = api.status();
            let api_body = String::from_utf8_lossy(&api.bytes().await.unwrap()).into_owned();
            eprintln!(
                "proxied serve-emu /api: {api_status} {}",
                &api_body[..api_body.len().min(400)]
            );
            let url = format!(
                "{}/vendor/serve-emu/ws?device={}&frame-meta=1&wsTicket={ticket}",
                access.ws_base, device.id
            );
            let (mut socket, response) = tokio_tungstenite::connect_async(url)
                .await
                .expect("stream socket upgrade through the proxy");
            eprintln!("socket upgraded through the proxy: {}", response.status());
            let mut semu = 0;
            let mut bytes = 0usize;
            let deadline = Instant::now() + Duration::from_secs(180);
            while semu < 3 && Instant::now() < deadline {
                let Ok(Some(Ok(message))) =
                    tokio::time::timeout(Duration::from_secs(60), socket.next()).await
                else {
                    eprintln!("socket ended");
                    break;
                };
                match message {
                    tokio_tungstenite::tungstenite::Message::Binary(data) => {
                        bytes += data.len();
                        if data.len() > 16 && data[..4] == [0x53, 0x45, 0x4d, 0x55] {
                            semu += 1;
                            eprintln!(
                                "SEMU packet: {} bytes, version {}, key {}, first NAL bytes {:02x?}",
                                data.len(),
                                data[4],
                                data[5] & 1,
                                &data[16..data.len().min(24)]
                            );
                        }
                    }
                    tokio_tungstenite::tungstenite::Message::Text(text) => {
                        eprintln!("text: {text}")
                    }
                    other => eprintln!("frame: {other:?}"),
                }
            }
            if api_status.is_success() {
                assert!(
                    semu > 0,
                    "no SEMU video arrived through the proxy ({bytes} bytes)"
                );
            } else {
                eprintln!("serve-emu refused the device ({api_status}); video not exercised");
            }
        } else {
            eprintln!("no booted Android device; stream socket not exercised");
        }
        hub.stop().await;
        assert!(!base.join("hub.json").exists());
    }
}

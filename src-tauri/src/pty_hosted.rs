//! Hosted terminals: a new terminal's child lives in the detached
//! `canopy-pty-host` process instead of this one, so it survives Quit and an
//! app update. On by default on macOS and Linux, switchable in Settings →
//! Terminal ("Keep terminals running after quit"); the Windows host is a stub,
//! so it is never on there by default. Any failure to reach or start the host
//! falls back to an ordinary in-process terminal, so enabling it can never stop
//! a terminal opening.
//!
//! Whether it is on is decided once per launch, in this order:
//!   1. env `CANOPY_PTY_HOST`: `0` forces off, `1` forces on (debugging; any
//!      other value is ignored),
//!   2. the saved setting `terminal.keepRunningAfterQuit` (see `setting_path`),
//!   3. the platform default: on for Unix, off elsewhere.
//! A change in Settings is saved at once but only read at the next launch, so
//! Quit, Stop All and the spawn path always agree with what is actually running.
//!
//! Hosted sessions are monitor-only for containment: the host, not the app, owns
//! the child, so the app's cgroup / job-object leases do not apply to them.

use portable_pty::{Child, CommandBuilder, MasterPty};
use std::path::{Path, PathBuf};

/// Key of the saved setting, as the file stores it.
pub const SETTING_KEY: &str = "terminal.keepRunningAfterQuit";

/// What the platform does with no env override and no saved setting.
pub const fn platform_default() -> bool {
    cfg!(unix)
}

/// The resolution order: env override, then saved setting, then default.
pub(crate) fn resolve(env: Option<&str>, setting: Option<bool>, default: bool) -> bool {
    match env {
        Some("1") => true,
        Some("0") => false,
        _ => setting.unwrap_or(default),
    }
}

/// The env override alone: `Some(true)` for `1`, `Some(false)` for `0`.
pub(crate) fn env_override(env: Option<&str>) -> Option<bool> {
    match env {
        Some("1") => Some(true),
        Some("0") => Some(false),
        _ => None,
    }
}

fn env_value() -> Option<String> {
    std::env::var("CANOPY_PTY_HOST").ok()
}

/// `~/.canopy/terminal-settings.json`, a flat JSON object of settings the
/// backend needs before any renderer exists (the webview's own settings live in
/// localStorage, which Rust cannot read at startup).
pub fn setting_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|home| {
            PathBuf::from(home)
                .join(".canopy")
                .join("terminal-settings.json")
        })
}

pub(crate) fn read_setting(path: &Path) -> Option<bool> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<serde_json::Value>(&raw)
        .ok()?
        .get(SETTING_KEY)?
        .as_bool()
}

pub(crate) fn write_setting(path: &Path, on: bool) -> Result<(), String> {
    let mut value = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    value[SETTING_KEY] = serde_json::Value::Bool(on);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Whether terminals are hosted in this launch. Resolved once and then fixed,
/// so a Settings change applies after restart and every caller agrees. Test
/// runs and the in-app self-test default to off so they never start a host.
pub fn enabled() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        let selftest =
            crate::selftest::requested(std::env::args(), std::env::var("CANOPY_SELFTEST").ok())
                .is_some();
        let default = platform_default() && !cfg!(test) && !selftest;
        let setting = setting_path().and_then(|p| read_setting(&p));
        resolve(env_value().as_deref(), setting, default)
    })
}

/// What Settings shows: the saved choice (or default), whether this platform
/// can host at all, and an env override that makes the switch moot.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct HostSetting {
    pub supported: bool,
    pub on: bool,
    pub forced: Option<bool>,
}

pub fn host_setting() -> HostSetting {
    HostSetting {
        supported: cfg!(unix),
        on: setting_path()
            .and_then(|p| read_setting(&p))
            .unwrap_or(platform_default()),
        forced: env_override(env_value().as_deref()),
    }
}

/// A hosted session "Quit and Stop All" would stop that this app does not hold
/// in a tab. `command` is what its metadata says it runs (None when the
/// metadata is unreadable: it is then a Canopy session of this instance only by
/// its spawn key, and could be an agent).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StopTarget {
    pub command: Option<String>,
    pub unreadable: bool,
}

/// A hosted session this launch saw and did not take over.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LeftBehind {
    pub terminal: Option<u32>,
    pub reason: String,
}

/// What the UI shows once per launch about the terminal host.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct HostNotice {
    /// The host switch is on but this launch's terminals run in-process (the
    /// host answered unusably, or could not be started), so Quit ends them.
    pub fell_back: bool,
    pub left_behind: Vec<LeftBehind>,
    /// How long a hosted terminal outlives a plain Quit; 0 where nothing is
    /// hosted.
    pub linger_secs: u64,
}

static LEFT_BEHIND: std::sync::Mutex<Vec<LeftBehind>> = std::sync::Mutex::new(Vec::new());
static FELL_BACK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// What the launch probe saw in the host: sessions listed and, of those,
/// running ones no app is attached to (-1: not asked or no answer).
static PROBE_LISTED: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(-1);
static PROBE_FREE: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(-1);

/// One content-free line about this launch's terminal host, for the
/// resilience log: whether hosting is on, what the launch decided (reuse a
/// previous launch's terminals, start fresh, or host unusable), what the
/// probe saw, how many terminals were adopted and how many were left behind
/// (reason words only). Written after the log plugin is up; adoption runs
/// before it.
pub fn launch_report(adopted: usize) -> String {
    use std::sync::atomic::Ordering;
    #[cfg(unix)]
    let decision = if !enabled() {
        "hosting-off"
    } else {
        match unix::resolution() {
            unix::Resolution::Fresh => "fresh",
            unix::Resolution::Reuse(_) => "reuse",
            unix::Resolution::HostUnusable => "host-unusable",
        }
    };
    #[cfg(not(unix))]
    let decision = "hosting-unsupported";
    let left = LEFT_BEHIND.lock().unwrap_or_else(|e| e.into_inner());
    let mut reasons: Vec<&str> = left
        .iter()
        .map(|l| {
            if l.reason.contains("too long") {
                "timeout"
            } else if l.reason.contains("could not adopt") {
                "adopt-failed"
            } else {
                "other"
            }
        })
        .collect();
    reasons.sort_unstable();
    reasons.dedup();
    format!(
        "pty-host launch: decision={decision} listed={} free={} adopted={adopted} left_behind={} reasons={reasons:?} fell_back={}",
        PROBE_LISTED.load(Ordering::SeqCst),
        PROBE_FREE.load(Ordering::SeqCst),
        left.len(),
        FELL_BACK.load(Ordering::SeqCst)
    )
}

/// Records, for the UI as well as the log, a hosted session that was not
/// adopted. It stays in the host (and Stop All can stop it); the user would
/// otherwise never learn it is there.
pub fn note_left_behind(terminal: Option<u32>, reason: impl Into<String>) {
    let reason = reason.into();
    eprintln!("canopy: hosted terminal {terminal:?} left in the host: {reason}");
    let mut all = LEFT_BEHIND.lock().unwrap();
    if all.len() < 50 {
        all.push(LeftBehind { terminal, reason });
    }
}

/// Said by `unix::client` when it gives up on the host.
#[cfg(unix)]
fn note_fell_back() {
    FELL_BACK.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Known at launch for an unusable host (decided before any terminal opens);
/// a host that fails to start is added once the first terminal has tried it.
pub fn host_notice() -> HostNotice {
    #[cfg(unix)]
    let unusable =
        enabled() && matches!(adoption::resolution(), adoption::Resolution::HostUnusable);
    #[cfg(not(unix))]
    let unusable = false;
    HostNotice {
        fell_back: unusable || FELL_BACK.load(std::sync::atomic::Ordering::SeqCst),
        left_behind: LEFT_BEHIND.lock().unwrap().clone(),
        #[cfg(unix)]
        linger_secs: unix::LINGER_SECS,
        #[cfg(not(unix))]
        linger_secs: 0,
    }
}

#[cfg(unix)]
mod install;

#[cfg(unix)]
pub use adoption::{
    adopt, adopt_with, adoptable, identity_floor, native_key, native_windows, note_identity,
    reused_instance, seal_new_window, stop_left_running, stop_preview, Adoptable, Adopted,
};
#[cfg(unix)]
pub use sealed::{forget_sealed, remember_sealed, reseal_lineage};
#[cfg(unix)]
pub use unix::{client, host_dir, host_share, probe_client, spawn, Client};

#[cfg(not(unix))]
pub struct Client;

/// The host the native terminal window should share: none here.
#[cfg(not(unix))]
pub fn host_share() -> Option<(PathBuf, Option<PathBuf>)> {
    None
}

#[cfg(not(unix))]
pub fn client() -> Option<Client> {
    None
}

/// The instance token of a previous launch whose hosted sessions are still
/// running, so adopted agents keep pairing with this launch. None here.
#[cfg(not(unix))]
pub fn reused_instance() -> Option<String> {
    None
}

/// Nothing outlives the app here, so there is no sealed metadata to keep.
#[cfg(not(unix))]
pub fn remember_sealed(_pty_id: u32, _master: &dyn MasterPty, _meta: HostedMeta) {}
#[cfg(not(unix))]
pub fn reseal_lineage(_pty_id: u32, _depth: u8, _parent: Option<u32>) {}
#[cfg(not(unix))]
pub fn forget_sealed(_pty_id: u32) {}

#[cfg(not(unix))]
pub fn spawn(
    _client: &Client,
    _cmd: &CommandBuilder,
    _cols: u16,
    _rows: u16,
    _meta: Option<String>,
) -> Result<(Box<dyn Child + Send + Sync>, Box<dyn MasterPty + Send>), String> {
    Err("hosted terminals are not supported on this platform".into())
}

#[cfg(unix)]
mod unix {
    use super::*;
    use canopy_pty_host::client::{HostChild, HostClient, HostMaster, LaunchCheck};
    use canopy_pty_host::protocol::SpawnSpec;
    use std::path::{Path, PathBuf};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    pub type Client = HostClient;

    /// An idle host exits after this long, so quitting the app does not leave a
    /// helper behind for an hour.
    const HOST_IDLE_SECS: u64 = 60;
    /// A hosted session is killed this long after its app connection drops, so
    /// an agent whose app never comes back does not run unseen forever. Long
    /// enough to quit, update and relaunch; the app that returns adopts it. How
    /// long is the user's Quit decision (default here: two hours).
    pub(super) const LINGER_SECS: u64 = 2 * 60 * 60;

    /// A dedicated directory: the host and the context bridge both create it
    /// 0700 if missing and refuse an existing one that is not already ours and
    /// 0700 (neither ever chmods an existing directory), so a shared one such
    /// as `$HOME` is refused, not tightened. Debug builds use their own so a dev app never
    /// attaches to an installed app's host.
    pub(super) fn socket_path() -> Option<PathBuf> {
        if let Ok(dir) = std::env::var("CANOPY_PTY_HOST_DIR") {
            return Some(PathBuf::from(dir).join("host.sock"));
        }
        let home = std::env::var("HOME").ok()?;
        let leaf = if cfg!(debug_assertions) {
            "pty-host-dev"
        } else {
            "pty-host"
        };
        Some(
            PathBuf::from(home)
                .join(".canopy")
                .join(leaf)
                .join("host.sock"),
        )
    }

    /// The host's directory, which also holds the context bridge's stable
    /// socket (`ctx_socket.rs`), so both share the debug/release split and the
    /// `CANOPY_PTY_HOST_DIR` override.
    pub fn host_dir() -> Option<PathBuf> {
        socket_path()?.parent().map(PathBuf::from)
    }

    /// The binary to start a host from: `CANOPY_PTY_HOST_EXE` as given (a
    /// developer override, `false` = not installed), else the bundled host
    /// installed under the socket directory (`true`). Never the bundled path
    /// itself: an update replaces the bundle, and a translocated or AppImage
    /// bundle disappears when the app quits (see `install`).
    fn host_exe(socket: &Path) -> Result<(PathBuf, Option<LaunchCheck>), String> {
        if let Ok(path) = std::env::var("CANOPY_PTY_HOST_EXE") {
            return Ok((PathBuf::from(path), None));
        }
        let bundled = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("the app has no directory")?
            .join(super::install::HOST_BIN);
        let bin = super::install::bin_dir(socket).ok_or("the socket has no directory")?;
        let installed = super::install::install(&bundled, &bin, env!("CARGO_PKG_VERSION"))?;
        let digest = installed.digest.clone();
        // The shared lock on the install directory is held for as long as the
        // app runs, so no other app's prune deletes the copy this one may start.
        static HOLD: OnceLock<std::fs::File> = OnceLock::new();
        let _ = HOLD.set(installed.hold);
        // Hashed again right before every start, restarts included.
        let check = LaunchCheck(std::sync::Arc::new(move |exe: &Path| {
            super::install::verify(exe, &digest)
        }));
        Ok((installed.exe, Some(check)))
    }

    /// Said once with a start failure: a copy under the home directory that
    /// cannot be executed usually means a `noexec` mount.
    fn start_hint(error: &std::io::Error, installed: bool) -> &'static str {
        if installed && error.kind() == std::io::ErrorKind::PermissionDenied {
            " (permission denied starting the installed host: is the home directory \
             mounted noexec? Set CANOPY_PTY_HOST_EXE to a host binary on an executable \
             filesystem)"
        } else {
            ""
        }
    }

    /// With a host running, remove install directories that neither this app
    /// nor the live host uses. In the background: housekeeping only.
    fn prune_installs_later(socket: PathBuf, installed: &Path) {
        let Some(dir) = installed.parent() else {
            return;
        };
        let (Some(bin), Some(current)) = (dir.parent(), dir.file_name().and_then(|n| n.to_str()))
        else {
            return;
        };
        let (bin, current) = (bin.to_path_buf(), current.to_owned());
        std::thread::spawn(move || {
            let live = super::install::liveness(&HostClient::new(socket).hello());
            super::install::prune(&bin, &current, &live);
        });
    }

    /// The host client, started on first use. None when the switch is off or the
    /// host cannot be reached; callers then use an in-process terminal.
    pub fn client() -> Option<Client> {
        if !super::enabled() {
            return None;
        }
        // A host that exists but could not be read: hosting this run would
        // create sessions no later launch could adopt, so stay in-process.
        if matches!(resolution(), Resolution::HostUnusable) {
            super::note_fell_back();
            return None;
        }
        // A failure is not final: a host that was busy for incompatible
        // terminals, or not yet startable, is tried again after RETRY_AFTER.
        static CLIENT: Mutex<RetryCell<Client>> = Mutex::new(RetryCell::new());
        let mut cell = CLIENT.lock().unwrap_or_else(|e| e.into_inner());
        cell.get(RETRY_AFTER, || {
                // Said once, so a missing host is not mistaken for a working one.
                let Some(socket) = socket_path() else {
                    eprintln!("canopy: the terminal host is on but there is no socket directory; using in-process terminals");
                    super::note_fell_back();
                    return None;
                };
                let (exe, check) = match host_exe(&socket) {
                    Ok(found) => found,
                    Err(error) => {
                        eprintln!("canopy: the terminal host is on but the PTY host could not be installed ({error}); using in-process terminals");
                        super::note_fell_back();
                        return None;
                    }
                };
                let installed = check.is_some();
                let _ = HOST_EXE.set(exe.clone());
                match HostClient::ensure_running_checked(
                    &exe,
                    &socket,
                    HOST_IDLE_SECS,
                    &[],
                    check,
                ) {
                    Ok(client) => {
                        if installed {
                            prune_installs_later(socket.clone(), &exe);
                        }
                        Some(client)
                    }
                    Err(error) => {
                        eprintln!(
                            "canopy: PTY host unavailable, using in-process terminals: {error}{}",
                            start_hint(&error, installed)
                        );
                        super::note_fell_back();
                        None
                    }
                }
        })
    }

    /// The binary the running host was started from (the installed copy, or the
    /// developer override), remembered by `client`.
    static HOST_EXE: OnceLock<PathBuf> = OnceLock::new();

    /// The host the native terminal window should use: this app's socket and
    /// host binary, started if needed. None when hosted terminals are off or
    /// the host cannot be reached; the window then starts its own.
    pub fn host_share() -> Option<(PathBuf, Option<PathBuf>)> {
        let client = client()?;
        Some((client.socket().to_path_buf(), HOST_EXE.get().cloned()))
    }

    /// A client for this app's host that never starts one: for asking whether a
    /// terminal is still there, which must not bring a host back to answer. None
    /// when there is no socket directory.
    pub fn probe_client() -> Option<Client> {
        if !super::enabled() {
            return None;
        }
        Some(HostClient::new(socket_path()?))
    }

    /// How long after a failed start the next terminal waits before trying again.
    pub(super) const RETRY_AFTER: Duration = Duration::from_secs(30);

    /// A value made on first use. A failure is remembered only for `retry_after`,
    /// so one bad moment does not cost the app its host for its whole lifetime,
    /// and a down host is not retried (a start can take seconds) on every spawn.
    pub(super) struct RetryCell<T> {
        value: Option<T>,
        failed_at: Option<Instant>,
    }

    impl<T: Clone> RetryCell<T> {
        pub(super) const fn new() -> Self {
            RetryCell {
                value: None,
                failed_at: None,
            }
        }

        pub(super) fn get(
            &mut self,
            retry_after: Duration,
            init: impl FnOnce() -> Option<T>,
        ) -> Option<T> {
            if let Some(value) = &self.value {
                return Some(value.clone());
            }
            if self.failed_at.is_some_and(|at| at.elapsed() < retry_after) {
                return None;
            }
            match init() {
                Some(value) => {
                    self.failed_at = None;
                    self.value = Some(value.clone());
                    Some(value)
                }
                None => {
                    self.failed_at = Some(Instant::now());
                    None
                }
            }
        }
    }

    /// A session's child handle (wait, kill) on a client that can never start a
    /// host: only spawn may launch one, and stopping a terminal must not bring
    /// a host back just to answer.
    pub(super) fn child_handle(client: &Client, id: u32, pid: u32) -> HostChild {
        HostChild::new(HostClient::new(client.socket()), id, pid)
    }

    /// Starts `cmd` in the host and attaches to it from offset 0. The host gets
    /// exactly the command's argv, cwd and environment, never its own. A
    /// non-UTF-8 argv or cwd is refused (the caller falls back in-process), and
    /// non-UTF-8 environment entries are skipped by `iter_full_env_as_str`.
    pub fn spawn(
        client: &Client,
        cmd: &CommandBuilder,
        cols: u16,
        rows: u16,
        meta: Option<String>,
    ) -> Result<(Box<dyn Child + Send + Sync>, Box<dyn MasterPty + Send>), String> {
        let argv = cmd
            .get_argv()
            .iter()
            .map(|a| a.to_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .ok_or("argv is not valid UTF-8")?;
        let cwd = match cmd.get_cwd() {
            Some(cwd) => Some(cwd.to_str().ok_or("cwd is not valid UTF-8")?.to_owned()),
            None => None,
        };
        let env = cmd
            .iter_full_env_as_str()
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect();
        let (id, pid) = client
            .spawn(SpawnSpec {
                argv,
                cwd,
                env,
                cols,
                rows,
                meta: meta.clone(),
                linger_secs: Some(LINGER_SECS),
                key: meta.as_deref().and_then(super::adoption::spawn_key),
            })
            .map_err(|e| e.to_string())?;
        match HostMaster::attach(client.clone(), id, 0) {
            Ok((master, _attached)) => {
                Ok((Box::new(child_handle(client, id, pid)), Box::new(master)))
            }
            Err(error) => {
                let _ = client.kill(id);
                Err(error.to_string())
            }
        }
    }
}

/// Everything adoption needs, read from a session's metadata. Versioned, and
/// identity only: no environment and no secrets. `bridge` is the SHA-256 of the
/// terminal's bridge credential, never the credential itself, so an adopting
/// launch can recognise the token the agent already holds (see
/// `ContextBridge::readopt_agent`) without the host ever storing it.
///
/// Any process of this user can write a session's metadata through the host,
/// so `bridge`, `depth` and `parent` are trusted only under a valid `seal`
/// (`adoption_seal.rs`). `depth: None` means the spawn-tree position was not
/// known when it was sealed, which adoption treats as the delegation cap.
#[derive(Debug, Clone, Default, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct HostedMeta {
    pub v: u32,
    pub id: u32,
    pub generation: u64,
    pub kind: String,
    pub cwd: String,
    pub run: bool,
    pub command: Option<String>,
    pub run_command_id: Option<String>,
    pub execution_context: Option<crate::execution::ExecutionContext>,
    pub run_id: Option<String>,
    pub attempt_id: Option<String>,
    pub instance: String,
    pub bridge: Option<String>,
    pub depth: Option<u8>,
    pub parent: Option<u32>,
    /// The host's own id for this session, bound under the seal so metadata
    /// copied from another session's listing does not verify on the copy. None
    /// until the app has spawned the session and learned the id.
    pub host: Option<u32>,
    pub seal: Option<String>,
}

/// What the app records about a session a native window started (the bundled
/// `canopy-term-app`, launched from Canopy), so the listing can say it is "in a
/// native window" and whose it is. The window starts the session with a spawn
/// key that names this launch (`native_key`); the app, which alone holds the
/// sealing key, then writes this under a seal bound to the host's id for the
/// session (`adoption_seal::seal_native`). No seal material ever goes to the
/// window: it carries no secret, and a session whose seal is missing or wrong
/// is still listed, only as unverified.
///
/// It does not parse as `HostedMeta` (`v` is absent, so 0), so no launch, old
/// or new, can adopt it as a terminal tab by mistake.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(default)]
pub struct NativeMeta {
    /// 1 for a native window's session. 0 is any other metadata.
    pub native: u32,
    pub instance: String,
    /// The per-window nonce the key carries, so a seal is for one window.
    pub nonce: String,
    pub host: Option<u32>,
    pub cwd: String,
    pub seal: Option<String>,
}

/// A session of this launch's native windows, as the listing shows it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NativeWindowSession {
    /// The host's id for the session (what `canopy-term-app --attach` takes).
    pub host_id: u32,
    /// A window holds it right now; false means the window was closed and the
    /// session is still running in the host for its linger time.
    pub in_window: bool,
    /// The seal checks out for this session: the app recorded it for this
    /// launch's window, not some other process claiming the key.
    pub verified: bool,
    /// Only from a verified record.
    pub cwd: Option<String>,
}

/// A spawn-tree position: depth, and the parent's pty id.
pub type Lineage = (u8, Option<u32>);

/// What adoption may believe about a session's bridge credential: its verifier
/// and, when it was known at sealing, its spawn-tree position (`None` inside
/// means unknown). Nothing at all without a valid seal under `key`, and none
/// unless the seal is bound to `host_id`, the session it was listed on: a
/// same-user process can copy sealed metadata onto a decoy session, but not
/// make the decoy carry the victim's host id.
#[cfg_attr(not(unix), allow(dead_code))]
pub fn trusted_credential(
    meta: &HostedMeta,
    key: Option<&[u8; 32]>,
    host_id: u32,
) -> Option<(String, Option<Lineage>)> {
    let verifier = meta.bridge.clone()?;
    if meta.host != Some(host_id) || !crate::adoption_seal::verify(key?, meta) {
        return None;
    }
    Some((verifier, meta.depth.map(|depth| (depth, meta.parent))))
}

/// Seal `meta` for the host. A spawn-time seal must not claim the root while an
/// agent spawn is pending: that blob could be replayed after the child is bound
/// deeper, so its position is sealed as unknown until `reseal_lineage`.
pub fn seal_for_spawn(meta: &mut HostedMeta, key: &[u8; 32], spawn_pending: bool) {
    meta.depth = (!spawn_pending).then_some(0);
    meta.parent = None;
    meta.seal = Some(crate::adoption_seal::seal(key, meta));
}

/// Sealed metadata of this launch's hosted terminals, kept in the app so a
/// reseal never signs anything read back from the host.
#[cfg(unix)]
mod sealed {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    type Table = Mutex<HashMap<u32, (u32, HostedMeta)>>;

    fn table() -> &'static Table {
        static TABLE: std::sync::OnceLock<Table> = std::sync::OnceLock::new();
        TABLE.get_or_init(Default::default)
    }

    /// Remember a freshly spawned hosted terminal's sealed metadata under its
    /// pty id, with the host's own id for the session, and bind the seal to
    /// that id: the spawn-time blob could not carry it (the host assigns it),
    /// and until this write lands the session's seal verifies for no session,
    /// so it adopts as a terminal with no credential (the safe side).
    pub fn remember_sealed(pty_id: u32, master: &dyn MasterPty, mut meta: HostedMeta) {
        if meta.seal.is_none() {
            return;
        }
        let Some(hosted) = master.downcast_ref::<canopy_pty_host::client::HostMaster>() else {
            return;
        };
        let Some(key) = crate::adoption_seal::key() else {
            return;
        };
        let host_id = hosted.id();
        meta.host = Some(host_id);
        meta.seal = Some(crate::adoption_seal::seal(&key, &meta));
        table()
            .lock()
            .unwrap()
            .insert(pty_id, (host_id, meta.clone()));
        write_meta(pty_id, host_id, &meta);
    }

    /// Write sealed metadata to the host, bounded to a second so neither the
    /// spawn path nor a Tauri command can hang on it.
    fn write_meta(pty_id: u32, host_id: u32, meta: &HostedMeta) {
        let Some(client) = super::client() else {
            return;
        };
        let Ok(json) = serde_json::to_string(meta) else {
            return;
        };
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(client.set_meta(host_id, Some(json)));
        });
        if !matches!(
            rx.recv_timeout(std::time::Duration::from_secs(1)),
            Ok(Ok(()))
        ) {
            eprintln!("canopy: could not record terminal {pty_id}'s sealed metadata in the host; it would come back with no bridge credential or at the delegation cap");
        }
    }

    pub fn forget_sealed(pty_id: u32) {
        table().lock().unwrap().remove(&pty_id);
    }

    /// The new metadata for a terminal whose spawn-tree position was just
    /// assigned, resealed from what the app holds. None if it is not hosted
    /// and sealed.
    pub(crate) fn resealed(
        pty_id: u32,
        depth: u8,
        parent: Option<u32>,
        key: &[u8; 32],
    ) -> Option<(u32, HostedMeta)> {
        let mut table = table().lock().unwrap();
        let (host_id, meta) = table.get_mut(&pty_id)?;
        meta.depth = Some(depth);
        meta.parent = parent;
        meta.host = Some(*host_id);
        meta.seal = Some(crate::adoption_seal::seal(key, meta));
        Some((*host_id, meta.clone()))
    }

    /// Write a delegated child's spawn-tree position into its sealed metadata,
    /// before its brief is submitted. Bounded to a second so the Tauri command
    /// cannot hang on the host; a write that does not land leaves the position
    /// unknown, which adoption treats as the cap (the safe side).
    pub fn reseal_lineage(pty_id: u32, depth: u8, parent: Option<u32>) {
        if !super::enabled() {
            return;
        }
        let Some(key) = crate::adoption_seal::key() else {
            return;
        };
        let Some((host_id, meta)) = resealed(pty_id, depth, parent, &key) else {
            return;
        };
        write_meta(pty_id, host_id, &meta);
    }
}

#[cfg(unix)]
mod adoption {
    use super::unix::{socket_path, Client};
    use super::*;
    use canopy_pty_host::client::{HostClient, HostMaster};
    use canopy_pty_host::protocol::{SessionInfo, EXCLUSIVE_ATTACH_VERSION};
    use std::io::Read;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::OnceLock;
    use std::time::Duration;

    pub(super) fn parse(info: &SessionInfo) -> Option<HostedMeta> {
        // A native window's session is never a terminal's, whatever its
        // metadata says: its spawn key is fixed at spawn and says what it is.
        if info
            .key
            .as_deref()
            .is_some_and(|k| native_claim(k).is_some())
        {
            return None;
        }
        let meta: HostedMeta = serde_json::from_str(info.meta.as_deref()?).ok()?;
        (meta.v == 1 && meta.id != 0).then_some(meta)
    }

    /// A session this launch may take over.
    pub struct Adoptable {
        pub info: SessionInfo,
        pub meta: HostedMeta,
    }

    /// The longest the launch path waits on the host for any one answer.
    const LAUNCH_WAIT: Duration = Duration::from_secs(1);

    /// Prefix of the key every Canopy-spawned session carries: instance, pty id,
    /// generation, and a nonce so a retried spawn never aliases another.
    /// Unlike the metadata (which any same-user process can overwrite with
    /// `set_meta`), the key is fixed at spawn, so it still says whose session
    /// this is after its metadata has been replaced with garbage.
    const KEY_PREFIX: &str = "canopy-pty:";

    pub(super) fn spawn_key(meta: &str) -> Option<String> {
        static NONCE: AtomicU64 = AtomicU64::new(0);
        let meta: HostedMeta = serde_json::from_str(meta).ok()?;
        if meta.v != 1 || meta.id == 0 || meta.instance.is_empty() || meta.instance.contains(':') {
            return None;
        }
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        Some(format!(
            "{KEY_PREFIX}{}:{}:{}:{ms}-{}",
            meta.instance,
            meta.id,
            meta.generation,
            NONCE.fetch_add(1, Ordering::Relaxed)
        ))
    }

    /// Prefix of the key a native window (the bundled `canopy-term-app`) starts
    /// its session with when Canopy launches it: instance and a per-window
    /// nonce. Not `KEY_PREFIX`, so adoption never reads such a session as one of
    /// its own terminals; and not a secret, like every spawn key.
    const NATIVE_KEY_PREFIX: &str = "canopy-native:";

    /// The spawn key for window `nonce` of `instance`. None when either part is
    /// empty or would not survive the `:` separated form, or the command line.
    pub fn native_key(instance: &str, nonce: &str) -> Option<String> {
        let part =
            |s: &str| !s.is_empty() && !s.contains(':') && s.chars().all(|c| c.is_ascii_graphic());
        (part(instance) && part(nonce)).then(|| format!("{NATIVE_KEY_PREFIX}{instance}:{nonce}"))
    }

    /// (instance, nonce) a native window's spawn key names.
    fn native_claim(key: &str) -> Option<(String, String)> {
        let (instance, nonce) = key.strip_prefix(NATIVE_KEY_PREFIX)?.split_once(':')?;
        (!instance.is_empty() && !nonce.is_empty() && !nonce.contains(':'))
            .then(|| (instance.to_string(), nonce.to_string()))
    }

    /// (instance, pty id) a spawn key names.
    fn key_claim(key: &str) -> Option<(String, u32)> {
        let rest = key.strip_prefix(KEY_PREFIX)?;
        let mut parts = rest.splitn(4, ':');
        let instance = parts.next().filter(|i| !i.is_empty())?;
        let id: u32 = parts.next()?.parse().ok()?;
        (id != 0 && parts.next().is_some()).then(|| (instance.to_string(), id))
    }

    /// Whose session this is and which terminal, from its spawn key when it has
    /// one (a key is not rewritable) and otherwise from its metadata.
    struct Identity {
        id: u32,
        instance: String,
        meta: Option<HostedMeta>,
    }

    fn identity(s: &SessionInfo) -> Option<Identity> {
        let meta = parse(s);
        match (s.key.as_deref().and_then(key_claim), meta) {
            (Some((instance, id)), meta) => Some(Identity { id, instance, meta }),
            (None, Some(meta)) => Some(Identity {
                id: meta.id,
                instance: meta.instance.clone(),
                meta: Some(meta),
            }),
            (None, None) => None,
        }
    }

    /// Sessions that are running, not attached to anyone (a host that predates
    /// the `attached` field reports unknown, which is never taken), whose
    /// metadata is ours and not a micro-task's, and that belong to `instance`.
    /// Ones that look ours and cannot be taken are recorded for the UI.
    pub fn adoptable(client: &Client, instance: &str) -> Vec<Adoptable> {
        match client.list_within(LAUNCH_WAIT) {
            Ok(sessions) => {
                let (found, left) =
                    classify(sessions, instance, crate::adoption_seal::key().as_ref());
                for l in left {
                    super::note_left_behind(l.terminal, l.reason);
                }
                found
            }
            Err(_) => Vec::new(),
        }
    }

    pub(super) fn adoptable_from(
        sessions: Vec<SessionInfo>,
        instance: &str,
        key: Option<&[u8; 32]>,
    ) -> Vec<Adoptable> {
        classify(sessions, instance, key).0
    }

    /// One session per terminal id. Several eligible sessions claiming one id
    /// (a decoy carrying copied metadata, say) cannot be told apart by what
    /// they say about themselves, with one exception: a claimant whose seal
    /// verifies for its own host id was made by this app, and a copy cannot
    /// have that, so it wins over unsealed claimants. Several sealed claimants,
    /// or none, and none is adopted: the terminal stays in the host rather than
    /// going to whichever listed first. Every session that looks like this
    /// instance's and is not taken is returned with why.
    pub(super) fn classify(
        sessions: Vec<SessionInfo>,
        instance: &str,
        key: Option<&[u8; 32]>,
    ) -> (Vec<Adoptable>, Vec<LeftBehind>) {
        let mut left: Vec<LeftBehind> = Vec::new();
        let mut found: Vec<Adoptable> = Vec::new();
        for info in sessions {
            if info.exited.is_some() || info.attached != Some(false) || info.pid.is_none() {
                continue;
            }
            let Some(who) = identity(&info) else { continue };
            if who.instance != instance {
                continue;
            }
            let Some(meta) = who.meta.filter(|m| m.instance == instance) else {
                left.push(LeftBehind {
                    terminal: Some(who.id),
                    reason: "its saved terminal details are unreadable".into(),
                });
                continue;
            };
            if meta.kind != "detached" && meta.run_id.is_none() {
                found.push(Adoptable { info, meta });
            }
        }
        let sealed = |a: &Adoptable| {
            a.meta.host == Some(a.info.id)
                && key.is_some_and(|key| crate::adoption_seal::verify(key, &a.meta))
        };
        let mut by_id: std::collections::BTreeMap<u32, Vec<Adoptable>> = Default::default();
        for a in found {
            by_id.entry(a.meta.id).or_default().push(a);
        }
        let mut adopt = Vec::new();
        for (id, mut group) in by_id {
            if group.len() == 1 {
                adopt.extend(group);
                continue;
            }
            let winners = group.iter().filter(|a| sealed(a)).count();
            if winners == 1 {
                let at = group.iter().position(sealed).unwrap();
                adopt.push(group.swap_remove(at));
                left.extend(group.into_iter().map(|_| LeftBehind {
                    terminal: Some(id),
                    reason: "another session claims the same terminal and is not sealed".into(),
                }));
            } else {
                left.extend(group.into_iter().map(|_| LeftBehind {
                    terminal: Some(id),
                    reason:
                        "several sessions claim this terminal and none could be told apart".into(),
                }));
            }
        }
        (adopt, left)
    }

    /// This launch's native windows' sessions among `sessions`, running or
    /// not, held by a window or free. They are named by their spawn key, which
    /// is fixed at spawn; the metadata only adds the seal, bound to the host's
    /// id, that makes a session `verified`. None of them is ever adopted into a
    /// tab (`classify` does not see them: their key is not `KEY_PREFIX`'s and
    /// their metadata is not `HostedMeta`), and a session that merely claims
    /// the key is listed as unverified, with nothing trusted from it.
    pub(super) fn classify_native(
        sessions: &[SessionInfo],
        instance: &str,
        key: Option<&[u8; 32]>,
    ) -> Vec<NativeWindowSession> {
        let mut out: Vec<NativeWindowSession> = sessions
            .iter()
            .filter(|s| s.exited.is_none())
            .filter_map(|s| {
                let (claimed, nonce) = s.key.as_deref().and_then(native_claim)?;
                if claimed != instance {
                    return None;
                }
                let sealed = s
                    .meta
                    .as_deref()
                    .and_then(|m| serde_json::from_str::<NativeMeta>(m).ok())
                    .filter(|m| {
                        m.native == 1
                            && m.instance == claimed
                            && m.nonce == nonce
                            && m.host == Some(s.id)
                            && key.is_some_and(|key| crate::adoption_seal::verify_native(key, m))
                    });
                Some(NativeWindowSession {
                    host_id: s.id,
                    in_window: s.attached == Some(true),
                    verified: sealed.is_some(),
                    cwd: sealed.map(|m| m.cwd),
                })
            })
            .collect();
        out.sort_by_key(|w| w.host_id);
        out
    }

    /// The native windows' sessions in the host right now.
    pub fn native_windows(client: &Client, instance: &str) -> Vec<NativeWindowSession> {
        match client.list_within(LAUNCH_WAIT) {
            Ok(sessions) => {
                classify_native(&sessions, instance, crate::adoption_seal::key().as_ref())
            }
            Err(_) => Vec::new(),
        }
    }

    /// Records, under `key`'s seal, the session that native window `nonce` of
    /// `instance` starts. The window starts it a moment after it launches, so the
    /// host is asked up to `tries` times, `pause` apart, until a session with the
    /// window's key is there. The seal binds the host's id for that session.
    /// Returns whether it was recorded.
    pub fn seal_new_window(
        client: &Client,
        (instance, nonce, cwd): (&str, &str, &str),
        key: &[u8; 32],
        tries: u32,
        pause: Duration,
    ) -> bool {
        let Some(spawn_key) = native_key(instance, nonce) else {
            return false;
        };
        for attempt in 0..tries {
            if attempt > 0 {
                std::thread::sleep(pause);
            }
            let Ok(sessions) = client.list_within(LAUNCH_WAIT) else {
                continue;
            };
            let Some(found) = sessions
                .iter()
                .find(|s| s.key.as_deref() == Some(spawn_key.as_str()))
            else {
                continue;
            };
            let mut meta = NativeMeta {
                native: 1,
                instance: instance.to_string(),
                nonce: nonce.to_string(),
                host: Some(found.id),
                cwd: cwd.to_string(),
                seal: None,
            };
            meta.seal = Some(crate::adoption_seal::seal_native(key, &meta));
            return match serde_json::to_string(&meta) {
                Ok(json) => client.set_meta(found.id, Some(json)).is_ok(),
                Err(_) => false,
            };
        }
        false
    }

    #[derive(Debug, PartialEq)]
    pub(super) enum Resolution {
        /// No host, or nothing in it to adopt: a fresh launch.
        Fresh,
        /// A previous launch's sessions are waiting under this token.
        Reuse(String),
        /// A host answers but could not be read; do not host this run.
        HostUnusable,
    }

    /// Decided once, before the first `instance_token()`, with a non-launching
    /// client so starting the app never starts a host just to ask it.
    pub(super) fn resolution() -> &'static Resolution {
        static RESOLUTION: OnceLock<Resolution> = OnceLock::new();
        RESOLUTION.get_or_init(|| {
            if !super::enabled() {
                return Resolution::Fresh;
            }
            let Some(socket) = socket_path() else {
                return Resolution::Fresh;
            };
            if !socket.exists() {
                return Resolution::Fresh;
            }
            let probe = HostClient::new(socket);
            let key = crate::adoption_seal::key_nowait();
            resolve_from(
                || {
                    let answer = probe.list_within(LAUNCH_WAIT);
                    if let Ok(sessions) = &answer {
                        use std::sync::atomic::Ordering;
                        let free = sessions
                            .iter()
                            .filter(|s| s.exited.is_none() && s.attached == Some(false))
                            .count();
                        super::PROBE_LISTED.store(sessions.len() as i64, Ordering::SeqCst);
                        super::PROBE_FREE.store(free as i64, Ordering::SeqCst);
                    }
                    answer
                },
                std::thread::sleep,
                key.as_ref(),
            )
        })
    }

    /// How long the launch probe waits before asking a second time.
    pub(super) const PROBE_RETRY_AFTER: Duration = Duration::from_millis(250);

    /// The launch decision from `list` answers. Right after a quit the host can
    /// briefly fail to answer (a timeout, or a connection dropped unanswered),
    /// so anything but "no socket" or "nobody listening" is asked once more
    /// after a short pause before it counts.
    pub(super) fn resolve_from(
        mut probe: impl FnMut() -> std::io::Result<Vec<SessionInfo>>,
        sleep: impl FnOnce(Duration),
        key: Option<&[u8; 32]>,
    ) -> Resolution {
        let answer = match probe() {
            Err(e)
                if !matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                ) =>
            {
                sleep(PROBE_RETRY_AFTER);
                probe()
            }
            first => first,
        };
        match answer {
            Ok(sessions) => match choose_token(&sessions, key) {
                Some(token) => Resolution::Reuse(token),
                None => Resolution::Fresh,
            },
            // A socket file left by a host that is gone, or one that is not
            // listening, is "no host": the next spawn cleans it up and
            // starts a fresh one. Only a host that connects and then fails
            // to answer sensibly is unusable.
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound
                        | std::io::ErrorKind::ConnectionRefused
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::BrokenPipe
                ) =>
            {
                Resolution::Fresh
            }
            Err(_) => Resolution::HostUnusable,
        }
    }

    /// The token most waiting sessions agree on: running, free (an old host with
    /// no `attached` field is never counted), ours, not a micro-task's. When any
    /// of them carries a valid seal, only sealed sessions vote, so sessions any
    /// process can spawn through the host cannot outvote this app's own.
    pub(super) fn choose_token(sessions: &[SessionInfo], key: Option<&[u8; 32]>) -> Option<String> {
        let mut counts: std::collections::HashMap<String, usize> = Default::default();
        let mut sealed: std::collections::HashMap<String, usize> = Default::default();
        for info in sessions {
            if info.exited.is_some() || info.attached != Some(false) {
                continue;
            }
            if let Some(meta) = parse(info) {
                if meta.kind != "detached" && meta.run_id.is_none() && !meta.instance.is_empty() {
                    if meta.host == Some(info.id)
                        && key.is_some_and(|key| crate::adoption_seal::verify(key, &meta))
                    {
                        *sealed.entry(meta.instance.clone()).or_default() += 1;
                    }
                    *counts.entry(meta.instance).or_default() += 1;
                }
            }
        }
        let counts = if sealed.is_empty() { counts } else { sealed };
        // Ties broken by the token itself so the choice never depends on map order.
        counts
            .into_iter()
            .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
            .map(|(token, _)| token)
    }

    /// The least id and generation a new terminal may use under `instance`: past
    /// every session that carries the token (running or not, attached or not,
    /// adoptable or not), and past the host's stored high-water mark. Asked with
    /// a non-launching client, so it works even when hosting is unavailable.
    pub fn identity_floor(instance: &str) -> Option<(u32, u64)> {
        let probe = HostClient::new(socket_path()?);
        let sessions = probe.list_within(LAUNCH_WAIT).ok()?;
        let mut floor: Option<(u32, u64)> = stored_identity(&probe);
        for info in &sessions {
            if let Some(meta) = parse(info) {
                if meta.instance == instance {
                    let (id, generation) = floor.unwrap_or((0, 0));
                    floor = Some((id.max(meta.id), generation.max(meta.generation)));
                }
            }
        }
        floor
    }

    pub fn reused_instance() -> Option<String> {
        match resolution() {
            Resolution::Reuse(token) => Some(token.clone()),
            _ => None,
        }
    }

    /// A session taken over: its child and master are host handles, and
    /// `history` is what it printed before this app attached.
    pub struct Adopted {
        pub meta: HostedMeta,
        pub pid: u32,
        pub child: Box<dyn Child + Send + Sync>,
        pub master: Box<dyn MasterPty + Send>,
        pub history: Vec<u8>,
        pub history_start: u64,
        pub cols: u16,
        pub rows: u16,
    }

    /// Attach from the start of the host's ring and read exactly the history the
    /// attach reply describes (its own `start`/`end`, not the listing's: the ring
    /// can move between the two calls). Live bytes then continue on the same
    /// stream. On any failure the connection drops, which only detaches.
    pub fn adopt(client: &Client, found: &Adoptable) -> Result<Adopted, String> {
        adopt_with(client, found, false)
    }

    /// `adopt`, and with `replace` it takes the session from whoever holds it
    /// (a plain attach, which the host answers by disconnecting the other
    /// client). That is for a session the caller gave away on purpose and now
    /// takes back, never for launch-time adoption, which must not disconnect a
    /// client that attached after the listing.
    pub fn adopt_with(
        client: &Client,
        found: &Adoptable,
        replace: bool,
    ) -> Result<Adopted, String> {
        let id = found.info.id;
        let pid = found.info.pid.ok_or("session has no pid")?;
        // `list` said nobody was attached, but a CLI client may attach before we
        // do; an exclusive attach (protocol 3) checks and takes it in one step
        // instead of silently disconnecting that client. An older host has no
        // such flag, and the list check is all there is.
        let exclusive = !replace
            && client
                .hello()
                .ok()
                .and_then(|h| h.version)
                .is_some_and(|v| v >= EXCLUSIVE_ATTACH_VERSION);
        let (master, attached) = if exclusive {
            HostMaster::attach_exclusive(client.clone(), id, 0)
        } else {
            HostMaster::attach(client.clone(), id, 0)
        }
        .map_err(|e| e.to_string())?;
        let want = attached.end.saturating_sub(attached.start) as usize;
        let mut history = vec![0u8; want];
        let mut stream = attached.stream.try_clone().map_err(|e| e.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| e.to_string())?;
        stream
            .read_exact(&mut history)
            .map_err(|e| format!("reading history: {e}"))?;
        let _ = stream.set_read_timeout(None);
        Ok(Adopted {
            meta: found.meta.clone(),
            pid,
            child: Box::new(super::unix::child_handle(client, id, pid)),
            master: Box::new(master),
            history,
            history_start: attached.start,
            cols: attached.cols,
            rows: attached.rows,
        })
    }

    static HIGH_WATER_ID: AtomicU64 = AtomicU64::new(0);
    const HIGH_WATER_BLOCK: u64 = 64;

    /// Remember, in the host, how far ids and generations have gone, written
    /// ahead in blocks so a crash cannot make a later launch reuse a pair that
    /// an adopted terminal's sidecars already name. Best effort: an older host
    /// refuses the op and nothing is lost but the guarantee.
    pub fn note_identity(client: &Client, id: u32, generation: u64) {
        if (id as u64) < HIGH_WATER_ID.load(Ordering::Relaxed) {
            return;
        }
        let ahead = id as u64 + HIGH_WATER_BLOCK;
        HIGH_WATER_ID.store(ahead, Ordering::Relaxed);
        let _ = client.set_state(
            "identity_high_water",
            &format!("{ahead}:{}", generation + HIGH_WATER_BLOCK),
            false,
        );
    }

    /// Host sessions "Quit and Stop All" stops: running Canopy sessions that no
    /// live app is attached to, or that belong to this launch (`instance`).
    /// This launch's terminals still in its map (`skip`, by pty id) are left to
    /// app exit, which stops them itself. A session another live app is
    /// attached to is that app's, and an old host that cannot say whether one
    /// is attached never offers a foreign one.
    ///
    /// "Canopy session of `instance`" is read from the spawn key first, so a
    /// session whose metadata was overwritten with garbage is still stopped
    /// (and counted, as unreadable); with no key, from readable metadata. A
    /// session with neither is not ours to stop. The key is not a secret: a
    /// same-user process can spawn with ours, and all that buys it is being
    /// stopped by an explicit user action.
    pub(super) fn stop_candidates(
        sessions: &[SessionInfo],
        instance: &str,
        skip: &[u32],
    ) -> Vec<(u32, StopTarget)> {
        sessions
            .iter()
            .filter(|s| s.exited.is_none())
            .filter_map(|s| {
                let who = identity(s)?;
                let mine = who.instance == instance;
                if mine && skip.contains(&who.id) {
                    return None;
                }
                (mine || s.attached == Some(false)).then(|| {
                    (
                        s.id,
                        StopTarget {
                            unreadable: who.meta.is_none(),
                            command: who.meta.and_then(|m| m.command),
                        },
                    )
                })
            })
            .collect()
    }

    pub(super) fn stop_targets(sessions: &[SessionInfo], instance: &str, skip: &[u32]) -> Vec<u32> {
        stop_candidates(sessions, instance, skip)
            .into_iter()
            .map(|(id, _)| id)
            .collect()
    }

    /// What `stop_left_running_with` would stop. No host is nothing to stop.
    pub fn stop_preview_with(
        client: &Client,
        instance: &str,
        skip: &[u32],
        wait: Duration,
    ) -> Result<Vec<StopTarget>, String> {
        Ok(
            stop_candidates(&list_for_stop(client, wait)?, instance, skip)
                .into_iter()
                .map(|(_, t)| t)
                .collect(),
        )
    }

    pub fn stop_preview(
        instance: &str,
        skip: &[u32],
        wait: Duration,
    ) -> Result<Vec<StopTarget>, String> {
        match socket_path() {
            Some(socket) if socket.exists() => {
                stop_preview_with(&HostClient::new(socket), instance, skip, wait)
            }
            _ => Ok(Vec::new()),
        }
    }

    fn list_for_stop(client: &Client, wait: Duration) -> Result<Vec<SessionInfo>, String> {
        match client.list_within(wait) {
            Ok(sessions) => Ok(sessions),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
                ) =>
            {
                Ok(Vec::new())
            }
            Err(e) => Err(format!("Could not reach the terminal host: {e}")),
        }
    }

    /// Ask the host to stop every `stop_targets` session (it sends SIGTERM,
    /// then SIGKILL after its own grace, so this returns at once). Nothing
    /// listening is no host and nothing to stop; any other failure is an error
    /// for the caller to show, never a silent zero.
    pub fn stop_left_running_with(
        client: &Client,
        instance: &str,
        skip: &[u32],
        wait: Duration,
    ) -> Result<usize, String> {
        let sessions = list_for_stop(client, wait)?;
        let targets = stop_targets(&sessions, instance, skip);
        let failed: Vec<String> = targets
            .iter()
            .filter_map(|id| client.kill(*id).err().map(|e| e.to_string()))
            .collect();
        match failed.first() {
            None => Ok(targets.len()),
            Some(first) => Err(format!(
                "The terminal host did not stop {} of {} terminals: {first}",
                failed.len(),
                targets.len()
            )),
        }
    }

    /// `stop_left_running_with` on this app's host, through a non-launching
    /// client: with no host running there is nothing to stop, so none starts.
    pub fn stop_left_running(
        instance: &str,
        skip: &[u32],
        wait: Duration,
    ) -> Result<usize, String> {
        match socket_path() {
            Some(socket) if socket.exists() => {
                stop_left_running_with(&HostClient::new(socket), instance, skip, wait)
            }
            _ => Ok(0),
        }
    }

    pub fn stored_identity(client: &Client) -> Option<(u32, u64)> {
        let value = client.get_state("identity_high_water").ok()??;
        let (id, generation) = value.split_once(':')?;
        Some((id.parse().ok()?, generation.parse().ok()?))
    }
}

#[cfg(unix)]
use adoption::resolution;
#[cfg(unix)]
use adoption::Resolution;

#[cfg(all(test, unix))]
pub(crate) mod tests {
    use super::adoption::{
        adoptable_from as adoption_adoptable, choose_token as adoption_choose, classify,
        resolve_from, spawn_key, stop_candidates, stop_left_running_with, stop_preview_with,
        stop_targets, Resolution as Resolved, PROBE_RETRY_AFTER,
    };
    use super::*;
    use canopy_pty_host::client::HostClient;
    use canopy_pty_host::protocol::SessionInfo;
    use canopy_pty_host::server::{serve, ServerConfig, EXITED_TTL};
    use std::io::{Read, Write};
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    /// A host on a thread, so these tests need no separate binary.
    pub(crate) struct InProcessHost {
        pub(crate) client: HostClient,
        stop: Arc<AtomicBool>,
        dir: std::path::PathBuf,
    }

    impl InProcessHost {
        pub(crate) fn start(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("cph{}{}", std::process::id(), name));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let socket = dir.join("h.sock");
            let listener = UnixListener::bind(&socket).unwrap();
            let stop = Arc::new(AtomicBool::new(false));
            let config = ServerConfig {
                socket: socket.clone(),
                min_client: canopy_pty_host::protocol::MIN_CLIENT_VERSION,
                idle_exit: Duration::from_secs(3600),
                exited_ttl: EXITED_TTL,
            };
            let thread_stop = Arc::clone(&stop);
            std::thread::spawn(move || {
                let _ = serve(listener, &config, thread_stop);
            });
            InProcessHost {
                client: HostClient::new(socket),
                stop,
                dir,
            }
        }
    }

    impl Drop for InProcessHost {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(300));
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// Reads on a thread so a missed needle fails the test instead of hanging
    /// the job on a blocking read.
    struct Pump {
        rx: std::sync::mpsc::Receiver<Vec<u8>>,
        seen: Vec<u8>,
    }

    impl Pump {
        fn new(mut reader: Box<dyn Read + Send>) -> Pump {
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut buf = [0u8; 1024];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            });
            Pump {
                rx,
                seen: Vec::new(),
            }
        }

        fn until(&mut self, needle: &str) -> String {
            let deadline = std::time::Instant::now() + Duration::from_secs(10);
            while !String::from_utf8_lossy(&self.seen).contains(needle) {
                let left = deadline.saturating_duration_since(std::time::Instant::now());
                match self.rx.recv_timeout(left) {
                    Ok(chunk) => self.seen.extend_from_slice(&chunk),
                    Err(_) => break,
                }
            }
            String::from_utf8_lossy(&self.seen).into_owned()
        }
    }

    pub(crate) fn command(script: &str) -> CommandBuilder {
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg("-c");
        cmd.arg(script);
        cmd.env_clear();
        cmd.env("PATH", "/usr/bin:/bin");
        cmd.env("CANOPY_HOSTED_PROBE", "from-the-app");
        cmd
    }

    #[test]
    fn the_child_gets_the_apps_environment_not_the_hosts() {
        let host = InProcessHost::start("env");
        // The in-process host shares this process's environment. cargo sets
        // CARGO_MANIFEST_DIR for a test run and no shell invents it, while the
        // command cleared its own environment: seeing it in the child would mean
        // the host used its environment instead of the one it was sent.
        assert!(std::env::var("CARGO_MANIFEST_DIR").is_ok());
        let (mut child, master) = spawn(
            &host.client,
            &command("echo probe=$CANOPY_HOSTED_PROBE leak=[$CARGO_MANIFEST_DIR]"),
            80,
            24,
            None,
        )
        .unwrap();
        let mut pump = Pump::new(master.try_clone_reader().unwrap());
        let out = pump.until("leak=[");
        assert!(out.contains("probe=from-the-app"), "got {out:?}");
        assert!(
            out.contains("leak=[]"),
            "the host leaked its environment: {out:?}"
        );
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn input_resize_and_exit_status_work_through_the_portable_pty_traits() {
        let host = InProcessHost::start("io");
        let script = "stty size; read line; echo got=$line; exit 3";
        let (mut child, master) = spawn(&host.client, &command(script), 100, 30, None).unwrap();
        let mut pump = Pump::new(master.try_clone_reader().unwrap());
        let mut writer = master.take_writer().unwrap();
        assert!(pump.until("30 100").contains("30 100"));
        writer.write_all(b"hello\n").unwrap();
        assert!(pump.until("got=hello").contains("got=hello"));
        assert_eq!(child.wait().unwrap().exit_code(), 3);
        let size = master.get_size().unwrap();
        assert_eq!((size.cols, size.rows), (100, 30));
    }

    #[test]
    fn resize_reaches_a_running_hosted_child() {
        let host = InProcessHost::start("rs");
        let script =
            "trap 'echo size=$(stty size)' WINCH; echo ready; while :; do sleep 0.05; done";
        let (mut child, master) = spawn(&host.client, &command(script), 80, 24, None).unwrap();
        let mut pump = Pump::new(master.try_clone_reader().unwrap());
        pump.until("ready");
        master
            .resize(portable_pty::PtySize {
                rows: 40,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        assert!(pump.until("size=40 120").contains("size=40 120"));
        child.kill().unwrap();
    }

    #[test]
    fn a_non_utf8_argv_is_refused_so_the_caller_falls_back() {
        use std::os::unix::ffi::OsStringExt;
        let host = InProcessHost::start("utf8");
        let mut cmd = CommandBuilder::new("sh");
        cmd.arg(std::ffi::OsString::from_vec(vec![0xff, 0xfe]));
        let error = spawn(&host.client, &cmd, 80, 24, None).err().unwrap();
        assert!(error.contains("UTF-8"), "{error}");
    }

    #[test]
    fn killing_through_the_child_handle_stops_a_hosted_session() {
        let host = InProcessHost::start("kill");
        let (mut child, _master) =
            spawn(&host.client, &command("sleep 300"), 80, 24, None).unwrap();
        assert!(child.try_wait().unwrap().is_none());
        child.kill().unwrap();
        child.wait().unwrap(); // must return, not hang
        assert!(child.try_wait().unwrap().is_some());
    }

    fn wait_for(mut f: impl FnMut() -> bool) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if f() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    pub(crate) fn meta_for(id: u32, generation: u64, kind: &str, instance: &str) -> String {
        serde_json::json!({
            "v": 1, "id": id, "generation": generation, "kind": kind,
            "cwd": "/tmp", "run": false, "instance": instance,
        })
        .to_string()
    }

    #[test]
    fn a_relaunch_adopts_the_session_with_its_history_and_then_live_output() {
        let host = InProcessHost::start("adopt");
        let (child, master) = spawn(
            &host.client,
            &command("echo before-quit; read x; echo got-$x; sleep 300"),
            80,
            24,
            Some(meta_for(7, 3, "desktop", "inst-a")),
        )
        .unwrap();
        assert!(wait_for(|| host.client.list().unwrap()[0].end > 0));
        // The app quits: its connection drops, which only detaches.
        drop(master);
        drop(child);
        assert!(wait_for(|| {
            host.client.list().unwrap()[0].attached == Some(false)
        }));

        assert!(adoptable(&host.client, "someone-else").is_empty());
        let found = adoptable(&host.client, "inst-a");
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].meta.id, found[0].meta.generation), (7, 3));

        let taken = adopt(&host.client, &found[0]).unwrap();
        assert_eq!(taken.history_start, 0);
        assert!(
            String::from_utf8_lossy(&taken.history).contains("before-quit"),
            "history was {:?}",
            String::from_utf8_lossy(&taken.history)
        );
        assert_eq!(
            Some(taken.pid),
            found[0].info.pid,
            "same child, not a new one"
        );
        // Taken: a second launch-time pass must not see it as free.
        assert!(adoptable(&host.client, "inst-a").is_empty());

        // Input and live output continue, with no history repeated.
        let mut writer = taken.master.take_writer().unwrap();
        let mut pump = Pump::new(taken.master.try_clone_reader().unwrap());
        writer.write_all(b"hi\n").unwrap();
        let seen = pump.until("got-hi");
        assert!(seen.contains("got-hi"), "{seen:?}");
        assert!(
            !seen.contains("before-quit"),
            "history leaked into live: {seen:?}"
        );
        let mut child = taken.child;
        child.kill().unwrap();
    }

    fn info(
        id: u32,
        meta: Option<String>,
        attached: Option<bool>,
        exited: Option<i32>,
    ) -> canopy_pty_host::protocol::SessionInfo {
        canopy_pty_host::protocol::SessionInfo {
            id,
            pid: Some(1000 + id),
            meta,
            attached,
            exited,
            ..Default::default()
        }
    }

    #[test]
    fn the_token_is_the_one_most_free_sessions_carry() {
        let a = |i| Some(meta_for(i, i as u64, "desktop", "inst-a"));
        let b = |i| Some(meta_for(i, i as u64, "desktop", "inst-b"));
        let sessions = vec![
            info(1, a(1), Some(false), None),
            info(2, a(2), Some(false), None),
            info(3, b(3), Some(false), None),
        ];
        assert_eq!(adoption_choose(&sessions, None).as_deref(), Some("inst-a"));
    }

    #[test]
    fn an_old_host_exited_attached_and_micro_task_sessions_never_count() {
        let m = |kind: &str| Some(meta_for(1, 1, kind, "inst-a"));
        let sessions = vec![
            info(1, m("desktop"), None, None),       // host without the field
            info(2, m("desktop"), Some(true), None), // someone is attached
            info(3, m("desktop"), Some(false), Some(0)), // exited
            info(4, m("detached"), Some(false), None), // micro-task
            info(5, None, Some(false), None),        // no metadata
            info(6, Some("{not json".into()), Some(false), None),
        ];
        assert_eq!(adoption_choose(&sessions, None), None);
        assert!(adoption_adoptable(sessions, "inst-a", None).is_empty());
    }

    #[test]
    fn a_run_bound_session_is_a_micro_task_tab_and_is_never_adopted() {
        // Micro-task tabs are ephemeral and never restored; the stale sweep
        // settles their run, so adopting the terminal would contradict it.
        let bound = serde_json::json!({
            "v": 1, "id": 5, "generation": 5, "kind": "desktop", "cwd": "/tmp",
            "run": false, "instance": "inst-a", "run_id": "run-1", "attempt_id": "att-1",
        })
        .to_string();
        let sessions = vec![info(5, Some(bound), Some(false), None)];
        assert_eq!(adoption_choose(&sessions, None), None);
        assert!(adoption_adoptable(sessions, "inst-a", None).is_empty());
    }

    #[test]
    fn micro_tasks_exited_and_attached_sessions_are_not_adopted() {
        let host = InProcessHost::start("noadopt");
        let (_c1, _m1) = spawn(
            &host.client,
            &command("sleep 300"),
            80,
            24,
            Some(meta_for(1, 1, "detached", "inst-a")),
        )
        .unwrap();
        // Still attached through _m1, and detached kind anyway.
        assert!(adoptable(&host.client, "inst-a").is_empty());
        // A session with no metadata at all is not ours to adopt.
        let (c2, m2) = spawn(&host.client, &command("sleep 300"), 80, 24, None).unwrap();
        drop((c2, m2));
        assert!(wait_for(|| host
            .client
            .list()
            .unwrap()
            .iter()
            .any(|s| s.meta.is_none() && s.attached == Some(false))));
        assert!(adoptable(&host.client, "inst-a").is_empty());
    }

    type Listing = std::io::Result<Vec<canopy_pty_host::protocol::SessionInfo>>;

    /// A probe that gives the scripted answers in order and counts its calls.
    fn scripted(
        answers: Vec<Listing>,
    ) -> (impl FnMut() -> Listing, std::rc::Rc<std::cell::Cell<usize>>) {
        let calls = std::rc::Rc::new(std::cell::Cell::new(0));
        let seen = std::rc::Rc::clone(&calls);
        let mut answers = answers.into_iter();
        let probe = move || {
            seen.set(seen.get() + 1);
            answers.next().expect("probed more often than scripted")
        };
        (probe, calls)
    }

    fn waiting() -> Vec<canopy_pty_host::protocol::SessionInfo> {
        vec![info(
            1,
            Some(meta_for(1, 1, "desktop", "inst-a")),
            Some(false),
            None,
        )]
    }

    #[test]
    fn the_launch_probe_asks_once_more_when_a_host_just_after_quit_does_not_answer() {
        use std::io::{Error, ErrorKind};
        for first in [
            ErrorKind::TimedOut,
            ErrorKind::WouldBlock,
            ErrorKind::ConnectionReset,
            ErrorKind::BrokenPipe,
        ] {
            let (probe, calls) = scripted(vec![Err(Error::from(first)), Ok(waiting())]);
            let mut slept = None;
            let resolved = resolve_from(probe, |d| slept = Some(d), None);
            assert_eq!(resolved, Resolved::Reuse("inst-a".into()), "{first:?}");
            assert_eq!(calls.get(), 2);
            assert_eq!(slept, Some(PROBE_RETRY_AFTER));
        }
    }

    #[test]
    fn the_launch_probe_retries_only_once_and_then_maps_the_error_as_before() {
        use std::io::{Error, ErrorKind};
        let (probe, calls) = scripted(vec![
            Err(Error::from(ErrorKind::TimedOut)),
            Err(Error::from(ErrorKind::TimedOut)),
        ]);
        assert_eq!(resolve_from(probe, |_| {}, None), Resolved::HostUnusable);
        assert_eq!(calls.get(), 2);
        // A connection dropped twice is a host on its way out: fresh, as before.
        let (probe, calls) = scripted(vec![
            Err(Error::from(ErrorKind::ConnectionReset)),
            Err(Error::from(ErrorKind::BrokenPipe)),
        ]);
        assert_eq!(resolve_from(probe, |_| {}, None), Resolved::Fresh);
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn no_host_at_all_is_fresh_at_once_with_no_retry_or_pause() {
        use std::io::{Error, ErrorKind};
        for kind in [ErrorKind::NotFound, ErrorKind::ConnectionRefused] {
            let (probe, calls) = scripted(vec![Err(Error::from(kind))]);
            let resolved = resolve_from(probe, |_| panic!("no pause for a missing host"), None);
            assert_eq!(resolved, Resolved::Fresh, "{kind:?}");
            assert_eq!(calls.get(), 1);
        }
        // A first answer is used as is.
        let (probe, calls) = scripted(vec![Ok(Vec::new())]);
        assert_eq!(
            resolve_from(probe, |_| panic!("no pause"), None),
            Resolved::Fresh
        );
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn stop_all_targets_unattached_canopy_sessions_and_this_launchs_strays() {
        let a = |i, kind| Some(meta_for(i, i as u64, kind, "inst-a"));
        let b = |i| Some(meta_for(i, i as u64, "desktop", "inst-b"));
        let sessions = vec![
            info(1, a(1, "desktop"), Some(false), None), // ours, waiting
            info(2, a(2, "desktop"), Some(true), None),  // ours, in the map
            info(3, a(3, "desktop"), Some(true), None),  // ours, held elsewhere
            info(4, a(4, "detached"), Some(false), None), // ours, micro-task
            info(5, a(5, "desktop"), Some(false), Some(0)), // exited
            info(6, b(6), Some(false), None),            // earlier launch, waiting
            info(7, b(7), Some(true), None),             // another live app's
            info(8, b(8), None, None),                   // old host: unknown
            info(9, None, Some(false), None),            // not Canopy's
        ];
        assert_eq!(stop_targets(&sessions, "inst-a", &[2]), vec![1, 3, 4, 6]);
    }

    fn keyed(id: u32, instance: &str, meta: Option<String>, attached: Option<bool>) -> SessionInfo {
        let key = spawn_key(&meta_for(id, id as u64, "desktop", instance));
        SessionInfo {
            key,
            ..info(id, meta, attached, None)
        }
    }

    #[test]
    fn a_session_whose_metadata_was_garbled_is_stopped_by_its_spawn_key() {
        let a = |i| Some(meta_for(i, i as u64, "desktop", "inst-a"));
        let sessions = vec![
            // Victim: metadata replaced with garbage after spawn.
            keyed(1, "inst-a", Some("not json".into()), Some(false)),
            // Metadata removed, or rewritten to another launch's.
            keyed(2, "inst-a", None, Some(false)),
            keyed(3, "inst-a", a(3), Some(true)), // in the map: left to exit
            // Garbage and no key: not provably Canopy's, never stopped.
            info(4, Some("not json".into()), Some(false), None),
            // Another launch's, garbled: not this instance's, not stopped.
            keyed(5, "inst-b", Some("not json".into()), Some(true)),
            keyed(6, "inst-b", Some("not json".into()), Some(false)),
        ];
        let got = stop_candidates(&sessions, "inst-a", &[3]);
        let ids: Vec<u32> = got.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, vec![1, 2, 6]);
        assert!(got.iter().all(|(_, t)| t.unreadable));
        // Adoption cannot take them, and says so.
        let (found, left) = classify(sessions, "inst-a", None);
        assert!(found.is_empty());
        assert_eq!(
            left.iter().filter_map(|l| l.terminal).collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn sessions_left_behind_reach_the_ui_notice_with_the_linger() {
        note_left_behind(Some(77), "test reason");
        let notice = host_notice();
        assert!(notice
            .left_behind
            .iter()
            .any(|l| l.terminal == Some(77) && l.reason == "test reason"));
        assert_eq!(notice.linger_secs, 2 * 60 * 60);
    }

    #[test]
    fn a_spawn_key_names_the_instance_and_terminal_and_never_repeats() {
        let meta = meta_for(7, 3, "desktop", "inst-a");
        let (k1, k2) = (spawn_key(&meta).unwrap(), spawn_key(&meta).unwrap());
        assert_ne!(k1, k2);
        let s = SessionInfo {
            key: Some(k1),
            ..info(50, None, Some(false), None)
        };
        let got = stop_candidates(&[s], "inst-a", &[]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, 50);
        assert_eq!(spawn_key("junk"), None);
        assert_eq!(spawn_key(&meta_for(0, 1, "desktop", "inst-a")), None);
    }

    #[test]
    fn the_stop_preview_lists_what_stop_all_would_kill_with_what_they_run() {
        let host = InProcessHost::start("preview");
        let (c1, m1) = spawn(
            &host.client,
            &command("sleep 300"),
            80,
            24,
            Some(meta_for(21, 21, "desktop", "inst-old")),
        )
        .unwrap();
        // Nobody holds it: a previous launch's, left behind.
        drop((c1, m1));
        assert!(wait_for(|| host
            .client
            .list()
            .unwrap()
            .iter()
            .any(|s| s.attached == Some(false))));
        let wait = Duration::from_secs(5);
        let targets = stop_preview_with(&host.client, "inst-a", &[], wait).unwrap();
        assert_eq!(targets.len(), 1);
        assert!(!targets[0].unreadable);
        // Exactly what stop_left_running_with then stops.
        assert_eq!(
            stop_left_running_with(&host.client, "inst-a", &[], wait),
            Ok(1)
        );
    }

    #[test]
    fn stop_all_stops_a_foreign_unattached_session_and_leaves_attached_ones() {
        let host = InProcessHost::start("stopall");
        let spawn_as = |id: u32, instance: &str| {
            spawn(
                &host.client,
                &command("sleep 300"),
                80,
                24,
                Some(meta_for(id, id as u64, "desktop", instance)),
            )
            .unwrap()
        };
        // This launch: one terminal still in its map (attached), one stray the
        // app detached from. An earlier launch that was never adopted: one
        // left waiting. Another live app: one it is attached to.
        let (_in_map_child, _in_map_master) = spawn_as(1, "inst-a");
        let stray = spawn_as(2, "inst-a");
        let earlier = spawn_as(3, "inst-b");
        let (_live_child, _live_master) = spawn_as(4, "inst-b");
        drop((stray, earlier));
        assert!(wait_for(|| host
            .client
            .list()
            .unwrap()
            .iter()
            .filter(|s| s.attached == Some(false))
            .count()
            == 2));

        let wait = Duration::from_secs(5);
        assert_eq!(
            stop_left_running_with(&host.client, "inst-a", &[1], wait),
            Ok(2)
        );
        let running = |meta_id: u32| {
            host.client.list().unwrap().iter().any(|s| {
                s.exited.is_none() && super::adoption::parse(s).is_some_and(|m| m.id == meta_id)
            })
        };
        assert!(wait_for(|| !running(2) && !running(3)));
        // The map's terminal is app exit's to stop; the other app's is its own.
        assert!(running(1) && running(4));
        // Nothing left to stop the second time.
        assert_eq!(
            stop_left_running_with(&host.client, "inst-a", &[1], wait),
            Ok(0)
        );
    }

    #[test]
    fn stop_all_reports_a_host_it_cannot_read_and_treats_no_host_as_nothing_to_stop() {
        let dir = std::env::temp_dir().join(format!("cph{}stopfail", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let wait = Duration::from_secs(2);

        // No socket at all, and a socket file nobody listens on: no host.
        let missing = HostClient::new(dir.join("missing.sock"));
        assert_eq!(stop_left_running_with(&missing, "inst-a", &[], wait), Ok(0));
        let stale = dir.join("stale.sock");
        drop(UnixListener::bind(&stale).unwrap());
        assert_eq!(
            stop_left_running_with(&HostClient::new(&stale), "inst-a", &[], wait),
            Ok(0)
        );

        // A host that answers with garbage: an error to show, not a silent 0.
        let broken = dir.join("broken.sock");
        let listener = UnixListener::bind(&broken).unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut line = String::new();
                let _ =
                    std::io::BufRead::read_line(&mut std::io::BufReader::new(&stream), &mut line);
                let _ = stream.write_all(b"not json\n");
            }
        });
        let error = stop_left_running_with(&HostClient::new(&broken), "inst-a", &[], wait)
            .expect_err("a garbled host must not read as nothing to stop");
        assert!(error.contains("terminal host"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn spawn_writes_the_identity_metadata_with_the_session() {
        let host = InProcessHost::start("meta");
        let meta = r#"{"v":1,"id":7,"generation":3}"#.to_string();
        let (mut child, _master) = spawn(
            &host.client,
            &command("sleep 300"),
            80,
            24,
            Some(meta.clone()),
        )
        .unwrap();
        let listed = host.client.list().unwrap();
        assert_eq!(listed[0].meta.as_deref(), Some(meta.as_str()));
        let _ = child.kill();
    }

    #[test]
    fn raw_mode_is_answered_by_the_host_not_assumed_false() {
        let host = InProcessHost::start("raw");
        // `stty raw` takes the tty out of canonical mode, like a full-screen TUI.
        let script = "stty raw -echo; echo raw-set; sleep 300";
        let (mut child, master) = spawn(&host.client, &command(script), 80, 24, None).unwrap();
        let mut pump = Pump::new(master.try_clone_reader().unwrap());
        pump.until("raw-set");
        let plain: &dyn MasterPty = &*master;
        let hosted = plain
            .downcast_ref::<canopy_pty_host::client::HostMaster>()
            .expect("a hosted master downcasts to HostMaster");
        assert!(hosted.raw_mode());
        child.kill().unwrap();
    }

    #[test]
    fn a_failed_host_start_is_retried_not_final() {
        use super::unix::RetryCell;
        let mut cell: RetryCell<u32> = RetryCell::new();
        let mut calls = 0;
        // Failing, with a long back-off: asked once, then not again.
        assert_eq!(
            cell.get(Duration::from_secs(3600), || {
                calls += 1;
                None
            }),
            None
        );
        assert_eq!(
            cell.get(Duration::from_secs(3600), || {
                calls += 1;
                Some(1)
            }),
            None
        );
        assert_eq!(calls, 1, "a down host must not be retried on every spawn");
        // Once the back-off has passed, the next ask tries again and can succeed.
        assert_eq!(cell.get(Duration::ZERO, || Some(7)), Some(7));
        // A success is kept for good and never re-made.
        assert_eq!(
            cell.get(Duration::ZERO, || panic!("must not run again")),
            Some(7)
        );
    }

    #[test]
    fn the_bridge_verifier_rides_in_the_metadata_and_old_metadata_has_none() {
        let with = serde_json::json!({
            "v": 1, "id": 4, "generation": 4, "kind": "desktop", "cwd": "/tmp",
            "run": false, "instance": "inst-a", "bridge": "ab".repeat(32),
        })
        .to_string();
        let sessions = vec![
            info(4, Some(with), Some(false), None),
            info(
                5,
                Some(meta_for(5, 5, "desktop", "inst-a")),
                Some(false),
                None,
            ),
        ];
        let found = adoption_adoptable(sessions, "inst-a", None);
        assert_eq!(found.len(), 2);
        assert_eq!(
            found[0].meta.bridge.as_deref(),
            Some("ab".repeat(32).as_str())
        );
        // A session spawned before this change: adopted, credential skipped.
        assert_eq!(found[1].meta.bridge, None);
    }

    fn sealed_meta(id: u32, instance: &str, verifier: &str, pending: bool) -> HostedMeta {
        let mut meta = HostedMeta {
            v: 1,
            id,
            generation: id as u64,
            kind: "desktop".into(),
            cwd: "/tmp".into(),
            instance: instance.into(),
            bridge: Some(verifier.into()),
            ..Default::default()
        };
        // Bound to the host id the test sessions list under (`info(id, ..)`).
        meta.host = Some(id);
        seal_for_spawn(&mut meta, &crate::adoption_seal::key().unwrap(), pending);
        meta
    }

    #[test]
    fn only_a_valid_seal_hands_back_a_credential() {
        let key = crate::adoption_seal::key().unwrap();
        let v = "ab".repeat(32);
        let root = sealed_meta(4, "inst-a", &v, false);
        assert_eq!(
            trusted_credential(&root, Some(&key), 4),
            Some((v.clone(), Some((0, None))))
        );
        // Spawned while an agent spawn was pending: position unknown.
        let pending = sealed_meta(5, "inst-a", &v, true);
        assert_eq!(
            trusted_credential(&pending, Some(&key), 5),
            Some((v.clone(), None))
        );
        // No key, no seal, a forged seal, or a field changed under the seal.
        assert_eq!(trusted_credential(&root, None, 4), None);
        let mut unsealed = root.clone();
        unsealed.seal = None;
        assert_eq!(trusted_credential(&unsealed, Some(&key), 4), None);
        let mut forged = root.clone();
        forged.seal = Some("00".repeat(32));
        assert_eq!(trusted_credential(&forged, Some(&key), 4), None);
        let mut swapped = root.clone();
        swapped.bridge = Some("cd".repeat(32));
        assert_eq!(trusted_credential(&swapped, Some(&key), 4), None);
        // Sealed for host session 4, offered by any other session: no credential.
        assert_eq!(trusted_credential(&root, Some(&key), 5), None);
    }

    /// Review finding 1: a same-user process copies a victim's sealed metadata
    /// from `list` onto a decoy session. The copy carries the victim's host id
    /// under a valid seal, so it must verify for neither vote nor credential
    /// on the decoy's own id, and two sessions claiming one terminal id are
    /// adopted as neither.
    #[test]
    fn metadata_copied_onto_a_decoy_session_is_neither_trusted_nor_adopted() {
        let key = crate::adoption_seal::key().unwrap();
        let v = "ab".repeat(32);
        let victim = serde_json::to_string(&sealed_meta(4, "inst-a", &v, false)).unwrap();
        let sessions = vec![
            info(4, Some(victim.clone()), Some(false), None),
            info(40, Some(victim.clone()), Some(false), None),
        ];
        // Only the session the seal was made for gets a sealed vote: the decoy
        // counts as unsealed, so two plain inst-b sessions outvote it.
        let b = |i| Some(meta_for(i, i as u64, "desktop", "inst-b"));
        let mut decoy_vs = vec![sessions[1].clone()];
        decoy_vs.push(info(2, b(2), Some(false), None));
        decoy_vs.push(info(3, b(3), Some(false), None));
        assert_eq!(
            adoption_choose(&decoy_vs, Some(&key)).as_deref(),
            Some("inst-b")
        );
        assert_eq!(
            adoption_choose(&sessions[..1], Some(&key)).as_deref(),
            Some("inst-a")
        );
        let decoy: HostedMeta = serde_json::from_str(&victim).unwrap();
        assert_eq!(trusted_credential(&decoy, Some(&key), 40), None);
        assert!(trusted_credential(&decoy, Some(&key), 4).is_some());
        // Listed first or last, the claimant whose seal is bound to its own
        // host id is adopted and the copy is not.
        for order in [sessions.clone(), sessions.iter().cloned().rev().collect()] {
            let (found, left) = classify(order, "inst-a", Some(&key));
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].info.id, 4);
            assert_eq!(left.len(), 1, "the decoy is surfaced, not just logged");
        }
        // Unable to verify anything, neither claimant is adopted.
        assert!(adoption_adoptable(sessions, "inst-a", None).is_empty());
    }

    /// The review's attack: any process of this user can spawn a session through
    /// the host carrying the current instance and a verifier for a token it
    /// chose. It may be adopted as a terminal, but its credential never is.
    #[test]
    fn a_session_forged_through_the_host_gets_no_credential() {
        let forged = serde_json::json!({
            "v": 1, "id": 9, "generation": 9, "kind": "desktop", "cwd": "/tmp",
            "run": false, "instance": "inst-a", "bridge": "ef".repeat(32), "depth": 0,
        })
        .to_string();
        let found = adoption_adoptable(
            vec![info(9, Some(forged), Some(false), None)],
            "inst-a",
            None,
        );
        assert_eq!(found.len(), 1, "adopted as a terminal");
        let key = crate::adoption_seal::key().unwrap();
        assert_eq!(trusted_credential(&found[0].meta, Some(&key), 9), None);
    }

    #[test]
    fn sealed_sessions_outvote_unsealed_ones_for_the_token() {
        let key = crate::adoption_seal::key().unwrap();
        let ours =
            serde_json::to_string(&sealed_meta(1, "inst-a", &"ab".repeat(32), false)).unwrap();
        let b = |i| Some(meta_for(i, i as u64, "desktop", "inst-b"));
        let sessions = vec![
            info(1, Some(ours), Some(false), None),
            info(2, b(2), Some(false), None),
            info(3, b(3), Some(false), None),
        ];
        assert_eq!(adoption_choose(&sessions, None).as_deref(), Some("inst-b"));
        assert_eq!(
            adoption_choose(&sessions, Some(&key)).as_deref(),
            Some("inst-a")
        );
    }

    /// A delegated child's position is resealed from the app's own copy and
    /// written to the host, and adoption then trusts exactly that position.
    #[test]
    fn a_resealed_lineage_round_trips_through_the_host() {
        let host = InProcessHost::start("reseal");
        let key = crate::adoption_seal::key().unwrap();
        let v = "ab".repeat(32);
        let meta = sealed_meta(61, "inst-r", &v, true);
        let (mut child, master) = spawn(
            &host.client,
            &command("sleep 300"),
            80,
            24,
            Some(serde_json::to_string(&meta).unwrap()),
        )
        .unwrap();
        remember_sealed(61, &*master, meta);
        let (host_id, resealed) = super::sealed::resealed(61, 2, Some(17), &key).unwrap();
        assert_eq!(host_id, host.client.list().unwrap()[0].id);
        host.client
            .set_meta(host_id, Some(serde_json::to_string(&resealed).unwrap()))
            .unwrap();
        let listed = host.client.list().unwrap();
        let parsed: HostedMeta = serde_json::from_str(listed[0].meta.as_deref().unwrap()).unwrap();
        assert_eq!(
            trusted_credential(&parsed, Some(&key), host_id),
            Some((v, Some((2, Some(17)))))
        );
        forget_sealed(61);
        assert!(super::sealed::resealed(61, 2, Some(17), &key).is_none());
        let _ = child.kill();
    }
}

/// A native window's sessions: named by a spawn key, recorded under the app's
/// seal, listed and never adopted.
#[cfg(all(test, unix))]
mod native_window_tests {
    use super::adoption::{classify, classify_native, native_key};
    use super::tests::{command, meta_for, InProcessHost};
    use super::*;
    use canopy_pty_host::protocol::{SessionInfo, SpawnSpec};
    use std::time::Duration;

    const INSTANCE: &str = "inst-a";

    fn key() -> [u8; 32] {
        crate::adoption_seal::key().unwrap()
    }

    fn sealed(host: u32, instance: &str, nonce: &str, cwd: &str) -> String {
        let mut meta = NativeMeta {
            native: 1,
            instance: instance.into(),
            nonce: nonce.into(),
            host: Some(host),
            cwd: cwd.into(),
            seal: None,
        };
        meta.seal = Some(crate::adoption_seal::seal_native(&key(), &meta));
        serde_json::to_string(&meta).unwrap()
    }

    fn window(
        id: u32,
        spawn_key: Option<String>,
        meta: Option<String>,
        attached: Option<bool>,
    ) -> SessionInfo {
        SessionInfo {
            id,
            pid: Some(1000 + id),
            key: spawn_key,
            meta,
            attached,
            ..Default::default()
        }
    }

    fn named(nonce: &str) -> Option<String> {
        native_key(INSTANCE, nonce)
    }

    /// A record for `host` that is right in every field but carries a seal the
    /// app did not make.
    fn forged(host: u32, nonce: &str) -> String {
        let mut meta: NativeMeta =
            serde_json::from_str(&sealed(host, INSTANCE, nonce, "/x")).unwrap();
        meta.seal = Some("00".repeat(32));
        serde_json::to_string(&meta).unwrap()
    }

    #[test]
    fn a_native_key_names_the_instance_and_the_window_and_is_never_a_terminal_key() {
        assert_eq!(named("n0").as_deref(), Some("canopy-native:inst-a:n0"));
        for bad in [
            ("", "n"),
            ("i", ""),
            ("a:b", "n"),
            ("i", "n:1"),
            ("i j", "n"),
            ("i", "n\n"),
            ("é", "n"),
        ] {
            assert_eq!(native_key(bad.0, bad.1), None, "{bad:?}");
        }
        // The prefix adoption reads as its own is a different one.
        assert!(!named("n0").unwrap().starts_with("canopy-pty:"));
    }

    #[test]
    fn a_sealed_window_is_listed_as_verified_and_held_or_free() {
        let sessions = vec![
            window(
                5,
                named("n5"),
                Some(sealed(5, INSTANCE, "n5", "/work/a")),
                Some(true),
            ),
            window(
                6,
                named("n6"),
                Some(sealed(6, INSTANCE, "n6", "/work/b")),
                Some(false),
            ),
        ];
        let listed = classify_native(&sessions, INSTANCE, Some(&key()));
        assert_eq!(
            listed,
            vec![
                NativeWindowSession {
                    host_id: 5,
                    in_window: true,
                    verified: true,
                    cwd: Some("/work/a".into())
                },
                NativeWindowSession {
                    host_id: 6,
                    in_window: false,
                    verified: true,
                    cwd: Some("/work/b".into())
                },
            ]
        );
    }

    #[test]
    fn a_session_that_only_claims_the_key_is_listed_with_nothing_trusted() {
        let key = key();
        let good = sealed(5, INSTANCE, "n5", "/work");
        let sessions = vec![
            // Key and nothing else (the app has not recorded it yet).
            window(1, named("n1"), None, Some(true)),
            // Unreadable metadata.
            window(2, named("n2"), Some("not json".into()), Some(true)),
            // Another session's record copied onto this one: bound to host 5.
            window(3, named("n5"), Some(good.clone()), Some(true)),
            // A record for another window (nonce) or another launch.
            window(
                4,
                named("n4"),
                Some(sealed(4, INSTANCE, "other", "/x")),
                Some(true),
            ),
            window(
                7,
                named("n7"),
                Some(sealed(7, "inst-b", "n7", "/x")),
                Some(true),
            ),
            // Valid for its session, but a forged seal.
            window(8, named("n8"), Some(forged(8, "n8")), Some(true)),
        ];
        let listed = classify_native(&sessions, INSTANCE, Some(&key));
        assert_eq!(listed.len(), 6);
        for w in &listed {
            assert!(!w.verified && w.cwd.is_none(), "{w:?}");
            assert!(w.in_window);
        }
        // With no sealing key at all nothing can be verified, even a good seal.
        let one = vec![window(5, named("n5"), Some(good), Some(false))];
        assert!(!classify_native(&one, INSTANCE, None)[0].verified);
        assert!(classify_native(&one, INSTANCE, Some(&key))[0].verified);
    }

    #[test]
    fn other_launches_other_keys_and_ended_sessions_are_not_listed() {
        let mut exited = window(3, named("n3"), None, Some(false));
        exited.exited = Some(0);
        let sessions = vec![
            window(1, native_key("inst-b", "n1"), None, Some(true)),
            window(
                2,
                Some("canopy-pty:inst-a:2:1:x".into()),
                Some(meta_for(2, 1, "desktop", INSTANCE)),
                Some(false),
            ),
            window(4, Some("canopy-native:inst-a".into()), None, Some(false)),
            window(5, None, None, Some(false)),
            exited,
        ];
        assert!(classify_native(&sessions, INSTANCE, Some(&key())).is_empty());
    }

    /// The reverse of the plan's "ignoring or mistaking": adoption neither takes
    /// a window's session as a terminal tab, nor counts it as a left-behind one,
    /// nor lets it vote for an instance or be a Stop All target.
    #[test]
    fn adoption_never_takes_or_counts_a_native_window_s_session() {
        let key = key();
        let free = window(
            6,
            named("n6"),
            Some(sealed(6, INSTANCE, "n6", "/w")),
            Some(false),
        );
        let bare = window(7, named("n7"), None, Some(false));
        // Even metadata that says everything a terminal's does, in a window's key.
        let lookalike = window(
            8,
            named("n8"),
            Some(meta_for(8, 8, "desktop", INSTANCE)),
            Some(false),
        );
        let sessions = vec![free, bare, lookalike];
        let (found, left) = classify(sessions.clone(), INSTANCE, Some(&key));
        assert!(found.is_empty(), "adopted a window's session");
        assert!(
            left.is_empty(),
            "reported a window's session as left behind"
        );
        assert_eq!(adoption_choose_for(&sessions, &key), None);
        assert!(stop_targets_for(&sessions).is_empty());
        // A window's record does not parse as a terminal's.
        let record: HostedMeta = serde_json::from_str(&sealed(6, INSTANCE, "n6", "/w")).unwrap();
        assert_eq!(record.v, 0);
        assert!(super::adoption::parse(&sessions[0]).is_none());
    }

    fn adoption_choose_for(sessions: &[SessionInfo], key: &[u8; 32]) -> Option<String> {
        super::adoption::choose_token(sessions, Some(key))
    }

    fn stop_targets_for(sessions: &[SessionInfo]) -> Vec<u32> {
        super::adoption::stop_targets(sessions, INSTANCE, &[])
    }

    fn start_window_session(host: &InProcessHost, nonce: &str) -> u32 {
        host.client
            .spawn(SpawnSpec {
                argv: vec!["sh".into(), "-c".into(), "sleep 300".into()],
                env: vec![("PATH".into(), "/usr/bin:/bin".into())],
                cols: 80,
                rows: 24,
                key: named(nonce),
                ..Default::default()
            })
            .unwrap()
            .0
    }

    #[test]
    fn the_app_records_a_new_window_s_session_under_its_seal_once_it_exists() {
        let host = InProcessHost::start("nwseal");
        // A decoy with another window's key, and a plain terminal.
        let other = start_window_session(&host, "other");
        let (child, master) = spawn(
            &host.client,
            &command("sleep 300"),
            80,
            24,
            Some(meta_for(3, 3, "desktop", INSTANCE)),
        )
        .unwrap();
        // The window has not started its session yet: nothing to record, and
        // nothing else is touched.
        assert!(!seal_new_window_for(&host, "n1", 2));
        // It starts a moment later; the app is already asking.
        let id = std::thread::scope(|scope| {
            let recorder = scope.spawn(|| seal_new_window_for(&host, "n1", 100));
            std::thread::sleep(Duration::from_millis(150));
            let id = start_window_session(&host, "n1");
            assert!(recorder.join().unwrap(), "never recorded");
            id
        });
        let listed = host.client.list().unwrap();
        let record = |sid: u32| listed.iter().find(|s| s.id == sid).unwrap().meta.clone();
        assert_eq!(record(other), None, "another window's session was touched");
        let terminal = listed
            .iter()
            .find(|s| {
                s.key
                    .as_deref()
                    .is_some_and(|k| k.starts_with("canopy-pty:"))
            })
            .unwrap();
        assert_eq!(
            terminal.meta.as_deref(),
            Some(meta_for(3, 3, "desktop", INSTANCE).as_str()),
            "a terminal's record was touched"
        );
        assert_eq!(
            classify_native(&listed, INSTANCE, Some(&key()))
                .into_iter()
                .filter(|w| w.verified)
                .map(|w| (w.host_id, w.cwd))
                .collect::<Vec<_>>(),
            vec![(id, Some("/work".to_string()))]
        );
        // A window of another launch's key is never recorded for this one.
        assert!(!super::adoption::seal_new_window(
            &host.client,
            ("inst-b", "n1", "/work"),
            &key(),
            1,
            Duration::ZERO
        ));
        for s in host.client.list().unwrap() {
            let _ = host.client.kill(s.id);
        }
        drop((child, master));
    }

    fn seal_new_window_for(host: &InProcessHost, nonce: &str, tries: u32) -> bool {
        super::adoption::seal_new_window(
            &host.client,
            (INSTANCE, nonce, "/work"),
            &key(),
            tries,
            Duration::from_millis(50),
        )
    }
}

#[cfg(test)]
mod setting_tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("canopy-host-setting-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("terminal-settings.json")
    }

    #[test]
    fn env_beats_setting_beats_default() {
        // Nothing set: the platform default.
        assert!(resolve(None, None, true));
        assert!(!resolve(None, None, false));
        // The saved setting beats the default, both ways.
        assert!(!resolve(None, Some(false), true));
        assert!(resolve(None, Some(true), false));
        // The env beats the saved setting, both ways.
        assert!(!resolve(Some("0"), Some(true), true));
        assert!(resolve(Some("1"), Some(false), false));
        // Anything but 0 or 1 is ignored.
        assert!(!resolve(Some(""), Some(false), true));
        assert!(resolve(Some("true"), None, true));
        assert!(!resolve(Some("yes"), None, false));
    }

    #[test]
    fn env_override_only_for_zero_and_one() {
        assert_eq!(env_override(Some("1")), Some(true));
        assert_eq!(env_override(Some("0")), Some(false));
        assert_eq!(env_override(Some("2")), None);
        assert_eq!(env_override(None), None);
    }

    #[test]
    fn platform_default_is_on_only_for_unix() {
        assert_eq!(platform_default(), cfg!(unix));
    }

    #[test]
    fn setting_round_trips_and_keeps_other_keys() {
        let path = temp("roundtrip");
        assert_eq!(read_setting(&path), None);
        write_setting(&path, false).unwrap();
        assert_eq!(read_setting(&path), Some(false));
        std::fs::write(
            &path,
            r#"{"other":1,"terminal.keepRunningAfterQuit":false}"#,
        )
        .unwrap();
        write_setting(&path, true).unwrap();
        assert_eq!(read_setting(&path), Some(true));
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"other\""));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn unreadable_setting_falls_to_default() {
        let path = temp("corrupt");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(read_setting(&path), None);
        std::fs::write(&path, r#"{"terminal.keepRunningAfterQuit":"yes"}"#).unwrap();
        assert_eq!(read_setting(&path), None);
        // A corrupt file is replaced, not an error, on the next save.
        write_setting(&path, true).unwrap();
        assert_eq!(read_setting(&path), Some(true));
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}

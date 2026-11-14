//! Launching the native terminal window (beta): the bundled `canopy-term-app`,
//! started as a process of its own that outlives Canopy.
//!
//! The binary ships beside the app executable on macOS (`Contents/MacOS`, put
//! there by `tauri.release-macos.conf.json`) and Linux (`externalBin`). Dev
//! builds and Windows have none, so the menu entries are not drawn and
//! `native_term_open` says why.
//!
//! The window is a client of the PTY host. When Canopy's persistent terminals
//! are on, it is handed Canopy's own host (socket and installed binary), so
//! there is one host and one version. Otherwise it starts its own.
//!
//! Everything here that decides what is run is a pure function, tested below:
//! the argv is a list (no shell, nothing concatenated), the project folder is
//! the value of `--cwd`, and the environment is a whitelist.
//!
//! Two more things go through here, both about the one host session a window
//! shows. A terminal of the IDE can be **handed over**: the window attaches to
//! it (`--attach N --force`) and the IDE tab lets go (`pty/handover.rs` keeps
//! the order). And a window the IDE opens fresh starts its session under a spawn
//! key that names this launch (`--key canopy-native:<instance>:<nonce>`), which
//! the IDE then records under its seal so the session can be listed as a native
//! window's. The window is given no seal material at all: the key and the nonce
//! are not secrets (like every spawn key), and the sealing key never leaves the
//! IDE, so there is nothing to put on a command line, in the environment or in
//! a file. The tests below spawn a real process and read back what it got.

use std::path::{Path, PathBuf};
#[cfg(unix)]
use tauri::Manager;

/// The program, as the bundler names it beside the app executable.
pub const BIN: &str = "canopy-term-app";

/// Said when there is no binary: dev builds and Windows.
pub const MISSING: &str = "The native terminal is not part of this build of Canopy. \
It ships with the macOS and Linux release builds.";

/// The binary in `dir` (the app executable's directory), if it is there.
pub(crate) fn resolve_in(dir: &Path) -> Option<PathBuf> {
    if !cfg!(unix) {
        return None;
    }
    let bin = dir.join(BIN);
    bin.is_file().then_some(bin)
}

fn bundled() -> Option<PathBuf> {
    resolve_in(std::env::current_exe().ok()?.parent()?)
}

/// The IDE's PTY host, so the window and the IDE meet at one host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HostShare {
    pub socket: PathBuf,
    /// The installed host binary the IDE runs, so a host the window has to
    /// restart is the same copy and version.
    pub exe: Option<PathBuf>,
}

/// What to run: no shell is involved, `args` go to the program as given.
#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Launch {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<PathBuf>,
}

/// Variables the window needs to open, find a shell and draw, and nothing
/// else: Canopy's own tokens, sockets and API keys are not here. The shell in
/// the window is the user's login shell and builds the rest itself.
const KEEP: &[&str] = &[
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "TMPDIR",
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
    "SSH_AUTH_SOCK",
];
/// Whole families: locale and the XDG directories.
const KEEP_PREFIX: &[&str] = &["LC_", "XDG_"];

pub(crate) fn child_env(
    parent: impl IntoIterator<Item = (String, String)>,
    path: Option<String>,
    share: Option<&HostShare>,
) -> Vec<(String, String)> {
    let mut parent: Vec<(String, String)> = parent.into_iter().collect();
    parent.sort();
    let mut out: Vec<(String, String)> = parent
        .iter()
        .filter(|(k, _)| {
            k != "PATH"
                && (KEEP.contains(&k.as_str()) || KEEP_PREFIX.iter().any(|p| k.starts_with(p)))
        })
        .cloned()
        .collect();
    if let Some(path) = path.or_else(|| {
        parent
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.clone())
    }) {
        out.push(("PATH".into(), path));
    }
    if let Some(exe) = share.and_then(|s| s.exe.as_ref()) {
        out.push((
            "CANOPY_PTY_HOST_EXE".into(),
            exe.to_string_lossy().into_owned(),
        ));
    }
    out
}

/// The whole launch. `project` must be an absolute folder.
pub(crate) fn plan(
    program: PathBuf,
    project: Option<&Path>,
    share: Option<&HostShare>,
    parent_env: impl IntoIterator<Item = (String, String)>,
    path: Option<String>,
) -> Result<Launch, String> {
    let mut args = Vec::new();
    if let Some(dir) = project {
        if !dir.is_absolute() {
            return Err(format!(
                "the project folder {dir:?} is not an absolute path"
            ));
        }
        let dir = dir
            .to_str()
            .ok_or("the project folder is not valid UTF-8")?;
        args.push("--cwd".to_string());
        args.push(dir.to_string());
    }
    if let Some(share) = share {
        let socket = share
            .socket
            .to_str()
            .ok_or("the terminal host's socket path is not valid UTF-8")?;
        args.push("--socket".to_string());
        args.push(socket.to_string());
    }
    Ok(Launch {
        program,
        args,
        env: child_env(parent_env, path, share),
        cwd: project.map(Path::to_path_buf),
    })
}

impl Launch {
    /// A new window's session is started under `key` (`--key`): the spawn key
    /// that names this launch and this window. Not a secret.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) fn keyed(mut self, key: &str) -> Self {
        self.args.push("--key".to_string());
        self.args.push(key.to_string());
        self
    }
}

/// A window that attaches to host session `host_id` and takes it over
/// (`--force`): the IDE's hand-over. There is no `--cwd` (an attach starts
/// nothing); the window process just runs in the terminal's folder.
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) fn plan_attach(
    program: PathBuf,
    host_id: u32,
    cwd: Option<&Path>,
    share: &HostShare,
    parent_env: impl IntoIterator<Item = (String, String)>,
    path: Option<String>,
) -> Result<Launch, String> {
    let socket = share
        .socket
        .to_str()
        .ok_or("the terminal host's socket path is not valid UTF-8")?;
    Ok(Launch {
        program,
        args: vec![
            "--attach".to_string(),
            host_id.to_string(),
            "--force".to_string(),
            "--socket".to_string(),
            socket.to_string(),
        ],
        env: child_env(parent_env, path, Some(share)),
        cwd: cwd.filter(|d| d.is_absolute()).map(Path::to_path_buf),
    })
}

/// The process to start for `launch`: its environment is exactly `launch.env`
/// (nothing is inherited), and nothing else reaches it.
#[cfg(unix)]
fn command(launch: &Launch) -> std::process::Command {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(&launch.program);
    cmd.args(&launch.args)
        .env_clear()
        .envs(launch.env.iter().map(|(k, v)| (k, v)))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // Its own process group: Canopy quitting, or a Ctrl+C in the terminal
        // Canopy was started from, does not reach the window.
        .process_group(0);
    if let Some(dir) = &launch.cwd {
        cmd.current_dir(dir);
    }
    cmd
}

#[cfg(unix)]
fn spawn(launch: &Launch) -> Result<(), String> {
    let mut child = command(launch)
        .spawn()
        .map_err(|e| format!("could not start the native terminal: {e}"))?;
    // Reaped when it exits so it does not linger as a zombie while Canopy
    // runs. If Canopy quits first the window carries on.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(not(unix))]
fn spawn(_launch: &Launch) -> Result<(), String> {
    Err(MISSING.into())
}

/// Whether this build has the native terminal. The menu and the launcher draw
/// their entries only when it does.
#[tauri::command]
pub fn native_term_available() -> bool {
    bundled().is_some()
}

/// Opens a native terminal window in `cwd` (the active project's folder).
#[tauri::command]
pub async fn native_term_open(cwd: Option<String>) -> Result<(), String> {
    // Starting the IDE's host can take seconds: not on the async runtime.
    tauri::async_runtime::spawn_blocking(move || open(cwd.map(PathBuf::from)))
        .await
        .map_err(|e| e.to_string())?
}

fn open(cwd: Option<PathBuf>) -> Result<(), String> {
    let program = bundled().ok_or(MISSING)?;
    if let Some(dir) = &cwd {
        if !dir.is_dir() {
            return Err(format!("the project folder {dir:?} does not exist"));
        }
    }
    let share = crate::pty_hosted::host_share().map(|(socket, exe)| HostShare { socket, exe });
    let launch = plan(
        program,
        cwd.as_deref(),
        share.as_ref(),
        std::env::vars(),
        crate::procenv::child_path(),
    )?;
    #[cfg(unix)]
    let (launch, nonce) = named_for_this_launch(launch, share.as_ref());
    spawn(&launch)?;
    #[cfg(unix)]
    if let Some(nonce) = nonce {
        record_new_window(nonce, cwd.as_deref().and_then(Path::to_str).unwrap_or(""));
    }
    Ok(())
}

/// A window on this launch's own host starts its session under a key that
/// names this launch and this window, so the IDE can tell it is a native
/// window's and record it. Returns the window's nonce. A window on a host of
/// its own (persistent terminals off) has nothing to be listed in, so it gets
/// no key.
#[cfg(unix)]
fn named_for_this_launch(launch: Launch, share: Option<&HostShare>) -> (Launch, Option<String>) {
    let named = share.and_then(|_| {
        let nonce = new_nonce()?;
        let key = crate::pty_hosted::native_key(crate::pty::instance_token(), &nonce)?;
        Some((nonce, key))
    });
    match named {
        Some((nonce, key)) => (launch.keyed(&key), Some(nonce)),
        None => (launch, None),
    }
}

#[cfg_attr(not(unix), allow(dead_code))]
fn new_nonce() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).ok()?;
    Some(hex::encode(bytes))
}

/// Records the new window's session under the app's seal, off this thread: the
/// window starts its session a moment after it launches, so the host is asked
/// for up to ten seconds. Best effort: a session that is not recorded is still
/// listed, as unverified.
#[cfg(unix)]
fn record_new_window(nonce: String, cwd: &str) {
    let cwd = cwd.to_string();
    std::thread::spawn(move || {
        let (Some(client), Some(key)) = (
            crate::pty_hosted::probe_client(),
            crate::adoption_seal::key(),
        ) else {
            return;
        };
        let instance = crate::pty::instance_token();
        if !crate::pty_hosted::seal_new_window(
            &client,
            (instance, nonce.as_str(), cwd.as_str()),
            &key,
            40,
            std::time::Duration::from_millis(250),
        ) {
            eprintln!(
                "canopy: could not record the new native window's session; it is listed as unverified"
            );
        }
    });
}

/// Hands terminal `pty_id` (a hosted terminal tab of this app) to a native
/// window. See `pty/handover.rs` for the order and what each step owns.
#[tauri::command]
pub async fn native_term_hand_over(app: tauri::AppHandle, pty_id: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || hand_over(&app, pty_id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(unix)]
fn hand_over(app: &tauri::AppHandle, pty_id: u32) -> Result<(), String> {
    use crate::pty::handover::NOT_HOSTED;
    let program = bundled().ok_or(MISSING)?;
    let (socket, exe) = crate::pty_hosted::host_share().ok_or(NOT_HOSTED)?;
    let share = HostShare { socket, exe };
    let client = crate::pty_hosted::probe_client().ok_or(NOT_HOSTED)?;
    app.state::<crate::pty::PtyManager>()
        .hand_over_with(app.clone(), &client, pty_id, |handed| {
            let folder = Path::new(handed.cwd());
            let launch = plan_attach(
                program,
                handed.host_id,
                folder.is_dir().then_some(folder),
                &share,
                std::env::vars(),
                crate::procenv::child_path(),
            )?;
            spawn(&launch)
        })
}

#[cfg(not(unix))]
fn hand_over(_app: &tauri::AppHandle, _pty_id: u32) -> Result<(), String> {
    Err(MISSING.into())
}

/// The IDE tab's "Take back": attach to the terminal again, replacing the
/// window, which then closes.
#[tauri::command]
pub async fn native_term_take_back(app: tauri::AppHandle, pty_id: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || take_back(&app, pty_id))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(unix)]
fn take_back(app: &tauri::AppHandle, pty_id: u32) -> Result<(), String> {
    // A client that never starts a host: a host that is gone has nothing to
    // take back, and asking must not bring one up.
    let client = crate::pty_hosted::probe_client().ok_or(crate::pty::handover::NOT_HOSTED)?;
    app.state::<crate::pty::PtyManager>()
        .take_back_with(app.clone(), &client, pty_id)
}

#[cfg(not(unix))]
fn take_back(_app: &tauri::AppHandle, _pty_id: u32) -> Result<(), String> {
    Err(MISSING.into())
}

/// The tab that showed terminal `pty_id` is closed while a window holds it:
/// let go of it without stopping it. Whether it was held.
#[tauri::command]
pub fn native_term_forget(state: tauri::State<'_, crate::pty::PtyManager>, pty_id: u32) -> bool {
    state.forget_handed(pty_id)
}

/// Which terminals can be handed over right now and where the handed-over ones
/// are, for the tab strip.
#[tauri::command]
pub async fn native_term_handover_status(
    app: tauri::AppHandle,
) -> crate::pty::handover::HandoverStatus {
    tauri::async_runtime::spawn_blocking(move || handover_status(&app))
        .await
        .unwrap_or(crate::pty::handover::HandoverStatus {
            candidates: Vec::new(),
            handed: Vec::new(),
        })
}

#[cfg(unix)]
fn handover_status(app: &tauri::AppHandle) -> crate::pty::handover::HandoverStatus {
    let pty = app.state::<crate::pty::PtyManager>();
    crate::pty::handover::HandoverStatus {
        candidates: pty.handover_candidates(),
        handed: pty.handover_status(crate::pty_hosted::probe_client().as_ref()),
    }
}

#[cfg(not(unix))]
fn handover_status(_app: &tauri::AppHandle) -> crate::pty::handover::HandoverStatus {
    crate::pty::handover::HandoverStatus {
        candidates: Vec::new(),
        handed: Vec::new(),
    }
}

/// The sessions of this launch's native windows in the host: held by a window
/// right now or left running after it closed, and whether each is recorded
/// under this app's seal. Never a terminal tab of its own.
#[tauri::command]
pub async fn native_term_windows() -> Vec<crate::pty_hosted::NativeWindowSession> {
    tauri::async_runtime::spawn_blocking(window_sessions)
        .await
        .unwrap_or_default()
}

#[cfg(unix)]
fn window_sessions() -> Vec<crate::pty_hosted::NativeWindowSession> {
    crate::pty_hosted::probe_client()
        .map(|client| crate::pty_hosted::native_windows(&client, crate::pty::instance_token()))
        .unwrap_or_default()
}

#[cfg(not(unix))]
fn window_sessions() -> Vec<crate::pty_hosted::NativeWindowSession> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("canopy-native-term-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[cfg(unix)]
    #[test]
    fn resolves_the_binary_beside_the_executable() {
        let dir = scratch("resolve");
        assert_eq!(resolve_in(&dir), None);
        std::fs::write(dir.join(BIN), b"").unwrap();
        assert_eq!(resolve_in(&dir), Some(dir.join(BIN)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_directory_of_that_name_is_not_the_binary() {
        let dir = scratch("isdir");
        std::fs::create_dir(dir.join(BIN)).unwrap();
        assert_eq!(resolve_in(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_project_folder_is_the_value_of_cwd_even_if_it_looks_like_a_flag() {
        let launch = plan(
            PathBuf::from("/app/canopy-term-app"),
            Some(Path::new("/work/--force; rm -rf $HOME")),
            None,
            vec![],
            None,
        )
        .unwrap();
        assert_eq!(
            launch.args,
            vec![
                "--cwd".to_string(),
                "/work/--force; rm -rf $HOME".to_string()
            ]
        );
        assert_eq!(
            launch.cwd,
            Some(PathBuf::from("/work/--force; rm -rf $HOME"))
        );
    }

    #[test]
    fn no_project_and_no_host_means_no_arguments() {
        let launch = plan(PathBuf::from("/x"), None, None, vec![], None).unwrap();
        assert!(launch.args.is_empty());
        assert_eq!(launch.cwd, None);
    }

    #[test]
    fn a_relative_project_folder_is_refused() {
        assert!(plan(
            PathBuf::from("/x"),
            Some(Path::new("proj")),
            None,
            vec![],
            None
        )
        .is_err());
    }

    #[test]
    fn the_ide_host_is_passed_by_socket_and_binary() {
        let share = HostShare {
            socket: PathBuf::from("/home/u/.canopy/pty-host/host.sock"),
            exe: Some(PathBuf::from(
                "/home/u/.canopy/pty-host/bin/0.5.15-ab/canopy-pty-host",
            )),
        };
        let launch = plan(
            PathBuf::from("/x"),
            Some(Path::new("/p")),
            Some(&share),
            vec![],
            None,
        )
        .unwrap();
        assert_eq!(
            launch.args,
            vec![
                "--cwd",
                "/p",
                "--socket",
                "/home/u/.canopy/pty-host/host.sock"
            ]
        );
        assert!(launch.env.contains(&(
            "CANOPY_PTY_HOST_EXE".to_string(),
            "/home/u/.canopy/pty-host/bin/0.5.15-ab/canopy-pty-host".to_string()
        )));
    }

    #[test]
    fn without_the_ide_host_the_window_gets_no_socket_and_no_host_override() {
        let launch = plan(
            PathBuf::from("/x"),
            Some(Path::new("/p")),
            None,
            env(&[
                ("CANOPY_PTY_HOST_EXE", "/other"),
                ("CANOPY_PTY_HOST_SOCKET", "/s"),
            ]),
            None,
        )
        .unwrap();
        assert!(!launch.args.iter().any(|a| a == "--socket"));
        assert!(launch.env.iter().all(|(k, _)| !k.starts_with("CANOPY_")));
    }

    #[test]
    fn the_environment_is_a_whitelist() {
        let out = child_env(
            env(&[
                ("HOME", "/h"),
                ("LC_ALL", "C"),
                ("XDG_RUNTIME_DIR", "/run/user/1"),
                ("DISPLAY", ":0"),
                ("PATH", "/usr/bin"),
                ("ANTHROPIC_API_KEY", "secret"),
                ("GITHUB_TOKEN", "secret"),
                ("CANOPY_CTX_SOCKET", "/s"),
                ("CANOPY_TOKEN", "secret"),
                ("AWS_SECRET_ACCESS_KEY", "secret"),
            ]),
            None,
            None,
        );
        let keys: Vec<&str> = out.iter().map(|(k, _)| k.as_str()).collect();
        for kept in ["HOME", "LC_ALL", "XDG_RUNTIME_DIR", "DISPLAY", "PATH"] {
            assert!(keys.contains(&kept), "{kept} should be kept: {keys:?}");
        }
        for dropped in [
            "ANTHROPIC_API_KEY",
            "GITHUB_TOKEN",
            "CANOPY_CTX_SOCKET",
            "CANOPY_TOKEN",
            "AWS_SECRET_ACCESS_KEY",
        ] {
            assert!(
                !keys.contains(&dropped),
                "{dropped} must not leak: {keys:?}"
            );
        }
    }

    #[test]
    fn the_login_path_replaces_the_apps_poor_one() {
        let out = child_env(
            env(&[("PATH", "/usr/bin")]),
            Some("/opt/homebrew/bin:/usr/bin".into()),
            None,
        );
        assert_eq!(
            out.iter().filter(|(k, _)| k == "PATH").collect::<Vec<_>>(),
            vec![&("PATH".to_string(), "/opt/homebrew/bin:/usr/bin".to_string())]
        );
    }

    fn share() -> HostShare {
        HostShare {
            socket: PathBuf::from("/home/u/.canopy/pty-host/host.sock"),
            exe: Some(PathBuf::from(
                "/home/u/.canopy/pty-host/bin/0.5.15-ab/canopy-pty-host",
            )),
        }
    }

    #[test]
    fn a_hand_over_attaches_to_the_session_and_takes_it_over() {
        let launch = plan_attach(
            PathBuf::from("/app/canopy-term-app"),
            7,
            Some(Path::new("/work/site")),
            &share(),
            vec![],
            None,
        )
        .unwrap();
        assert_eq!(
            launch.args,
            vec![
                "--attach",
                "7",
                "--force",
                "--socket",
                "/home/u/.canopy/pty-host/host.sock"
            ]
        );
        // An attach starts nothing, so it has no --cwd or --key (the app would
        // refuse both); the process just runs in the terminal's folder.
        assert!(!launch.args.iter().any(|a| a == "--cwd" || a == "--key"));
        assert_eq!(launch.cwd, Some(PathBuf::from("/work/site")));
        // The same host, binary and version as the app's own.
        assert!(launch.env.contains(&(
            "CANOPY_PTY_HOST_EXE".to_string(),
            "/home/u/.canopy/pty-host/bin/0.5.15-ab/canopy-pty-host".to_string()
        )));
        // A relative folder is not made the process's directory.
        let relative = plan_attach(
            PathBuf::from("/x"),
            1,
            Some(Path::new("rel")),
            &share(),
            vec![],
            None,
        )
        .unwrap();
        assert_eq!(relative.cwd, None);
    }

    /// The window and the app agree on what a hand-over argv means: what we
    /// send must parse as an attach with force, and nothing else.
    #[test]
    fn the_window_s_own_parser_reads_the_hand_over_as_a_forced_attach() {
        let launch = plan_attach(PathBuf::from("/x"), 12, None, &share(), vec![], None).unwrap();
        assert_eq!(launch.args[0], "--attach");
        assert_eq!(launch.args[1].parse::<u32>(), Ok(12));
        assert_eq!(launch.args[2], "--force");
    }

    #[test]
    fn a_new_window_carries_the_key_after_the_rest_and_a_fixed_form() {
        let launch = plan(
            PathBuf::from("/x"),
            Some(Path::new("/p")),
            Some(&share()),
            vec![],
            None,
        )
        .unwrap()
        .keyed("canopy-native:inst-a:0011");
        assert_eq!(
            launch.args,
            vec![
                "--cwd",
                "/p",
                "--socket",
                "/home/u/.canopy/pty-host/host.sock",
                "--key",
                "canopy-native:inst-a:0011"
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn only_a_window_on_the_apps_own_host_is_named_for_this_launch() {
        let bare = plan(
            PathBuf::from("/x"),
            Some(Path::new("/p")),
            None,
            vec![],
            None,
        )
        .unwrap();
        let (unnamed, nonce) = named_for_this_launch(bare.clone(), None);
        assert_eq!((unnamed, nonce), (bare, None));

        let hosted = plan(
            PathBuf::from("/x"),
            Some(Path::new("/p")),
            Some(&share()),
            vec![],
            None,
        )
        .unwrap();
        let (named, nonce) = named_for_this_launch(hosted.clone(), Some(&share()));
        let nonce = nonce.expect("a window on the app's host is named");
        assert_eq!(nonce.len(), 32);
        assert!(nonce.chars().all(|c| c.is_ascii_hexdigit()));
        let key = format!("canopy-native:{}:{nonce}", crate::pty::instance_token());
        assert_eq!(named.args[..hosted.args.len()], hosted.args[..]);
        assert_eq!(named.args[hosted.args.len()..], ["--key".to_string(), key]);
        // Another window, another nonce.
        assert_ne!(new_nonce(), new_nonce());
    }

    /// Spawns a real process with exactly what the window would get and reads
    /// back what it saw: the secrets the app holds are in neither its argv nor
    /// its environment, whether it is a new window or a hand-over.
    #[cfg(unix)]
    #[test]
    fn no_secret_reaches_the_window_in_its_argv_or_its_environment() {
        use std::process::Stdio;
        let seal_key = crate::adoption_seal::key().expect("the test seal key");
        let secrets = [
            hex::encode(seal_key),
            "sk-ant-the-parents-api-key".to_string(),
            "bridge-token-of-the-parent".to_string(),
            "seal-material-the-parent-holds".to_string(),
        ];
        // The app's own environment, secrets and all, as `open` would read it.
        let parent = env(&[
            ("HOME", "/home/u"),
            ("PATH", "/usr/bin:/bin"),
            ("ANTHROPIC_API_KEY", secrets[1].as_str()),
            ("CANOPY_CTX_TOKEN", secrets[2].as_str()),
            ("CANOPY_SEAL_KEY", secrets[0].as_str()),
            ("CANOPY_ADOPTION_SEAL", secrets[3].as_str()),
            ("CANOPY_PTY_HOST_SOCKET", "/somewhere/else.sock"),
        ]);
        let path = Some("/usr/bin:/bin".to_string());
        let new = plan(
            PathBuf::from("/bin/sh"),
            Some(Path::new("/tmp")),
            Some(&share()),
            parent.clone(),
            path.clone(),
        )
        .unwrap();
        let (new, nonce) = named_for_this_launch(new, Some(&share()));
        assert!(nonce.is_some());
        let attach = plan_attach(
            PathBuf::from("/bin/sh"),
            7,
            Some(Path::new("/tmp")),
            &share(),
            parent,
            path,
        )
        .unwrap();
        for (what, launch) in [("new window", new), ("hand-over", attach)] {
            // `sh -c SCRIPT spy ARGS...`: the real argv after the script, the
            // real environment, run through the same `command` the app uses.
            let script = "env; for a in \"$@\"; do echo \"arg=$a\"; done";
            let spy = Launch {
                program: PathBuf::from("/bin/sh"),
                args: ["-c", script, "spy"]
                    .into_iter()
                    .map(String::from)
                    .chain(launch.args.clone())
                    .collect(),
                env: launch.env.clone(),
                cwd: launch.cwd.clone(),
            };
            let out = command(&spy)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .output()
                .expect("run the stand-in window");
            let seen = String::from_utf8_lossy(&out.stdout).into_owned();
            assert!(out.status.success(), "{what}: {seen}");
            assert!(
                seen.contains("arg=--"),
                "{what} ran with its arguments: {seen}"
            );
            for secret in &secrets {
                assert!(
                    !seen.contains(secret.as_str()),
                    "{what} leaked {secret}: {seen}"
                );
            }
            // The environment is the whitelist and the host binary, nothing
            // of the app's: no CANOPY_ variable but the host's binary.
            let names: Vec<&str> = seen
                .lines()
                .take_while(|l| !l.starts_with("arg="))
                .filter_map(|l| l.split_once('=').map(|(k, _)| k))
                .collect();
            for name in &names {
                assert!(
                    !name.starts_with("CANOPY_") || *name == "CANOPY_PTY_HOST_EXE",
                    "{what} got {name}: {names:?}"
                );
                assert!(!name.contains("TOKEN") && !name.contains("KEY") && !name.contains("SEAL"));
            }
            assert!(names.contains(&"CANOPY_PTY_HOST_EXE"), "{what}: {names:?}");
            // What the window is told about its session is not secret: a key
            // that names this launch and a nonce, and the host's id.
            if what == "new window" {
                assert!(seen.contains("arg=canopy-native:"), "{seen}");
            } else {
                assert!(seen.contains("arg=--attach\narg=7\narg=--force"), "{seen}");
            }
        }
    }
}

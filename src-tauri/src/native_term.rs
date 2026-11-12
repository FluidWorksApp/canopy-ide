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

use std::path::{Path, PathBuf};

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

#[cfg(unix)]
fn spawn(launch: &Launch) -> Result<(), String> {
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
    let mut child = cmd
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
    spawn(&launch)
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
}

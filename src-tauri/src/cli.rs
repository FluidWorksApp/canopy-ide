//! `canopy <dir>` — open a directory as a project from the command line.
//!
//! Two paths deliver the argument, because launch order dictates it:
//!
//! - First launch: the arg is parsed before the webview exists, so it waits in
//!   [`PendingOpen`] until the frontend asks (`cli_take_pending_open`). An
//!   event fired during boot would race the listener's registration and lose.
//! - Already running: the single-instance plugin hands the second invocation's
//!   argv (and its cwd — relative paths must resolve against the *caller's*
//!   directory, not ours) to [`open_forwarded`], which raises the window and
//!   emits `cli-open`. A second app instance is never allowed to start: it
//!   would fight this one over the hook bridge and PTY ownership.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Directory from the first launch's argv, held until the frontend is ready.
pub struct PendingOpen(pub Mutex<Option<String>>);

/// First non-flag argument that resolves to an existing directory.
/// Flags are skipped rather than rejected: macOS LaunchServices appends
/// `-psn_…`, and future flags shouldn't break path detection.
pub fn dir_from_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Option<String> {
    for a in args.into_iter().skip(1) {
        if a.starts_with('-') {
            continue;
        }
        let p = PathBuf::from(&a);
        let p = if p.is_absolute() { p } else { cwd.join(p) };
        match p.canonicalize() {
            Ok(canon) if canon.is_dir() => return Some(canon.to_string_lossy().into_owned()),
            _ => log::warn!("cli: not a directory, ignoring: {a}"),
        }
    }
    None
}

pub fn pending_from_env() -> PendingOpen {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    PendingOpen(Mutex::new(dir_from_args(std::env::args(), &cwd)))
}

/// Second-instance argv, forwarded by the single-instance plugin.
pub fn open_forwarded(app: &AppHandle, argv: Vec<String>, cwd: String) {
    if let Some(dir) = dir_from_args(argv, Path::new(&cwd)) {
        let _ = app.emit("cli-open", dir);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub fn cli_take_pending_open(state: tauri::State<'_, PendingOpen>) -> Option<String> {
    state.0.lock().unwrap().take()
}

/// Put a `canopy` command on PATH.
///
/// macOS: a shim script in /usr/local/bin exec'ing the real binary. Not a
/// symlink — the executable resolves its resources relative to argv[0], and a
/// symlinked path breaks that lookup. /usr/local/bin is root-owned on most
/// Macs, so a failed plain write escalates once through osascript's admin
/// prompt instead of telling people to go run sudo by hand.
///
/// Linux: .deb/.rpm already install /usr/bin/canopy — nothing to do. An
/// AppImage gets a shim in ~/.local/bin (no root needed), pointing at the
/// mounted image's $APPIMAGE path.
#[tauri::command]
pub fn cli_install_shim() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let shim = format!("#!/bin/sh\nexec \"{}\" \"$@\"\n", exe.display());
        let dest = Path::new("/usr/local/bin/canopy");
        if write_shim(dest, &shim).is_ok() {
            return Ok("Installed `canopy` — run `canopy <dir>` from any terminal.".into());
        }
        // Stage in a temp file and copy with admin rights; embedding the shim
        // text itself in the AppleScript would be a quoting minefield.
        let tmp = std::env::temp_dir().join("canopy-shim");
        write_shim(&tmp, &shim).map_err(|e| e.to_string())?;
        let sh = format!(
            "mkdir -p /usr/local/bin && cp '{}' /usr/local/bin/canopy && chmod 755 /usr/local/bin/canopy",
            tmp.display()
        );
        let script = format!(
            "do shell script \"{}\" with administrator privileges",
            sh.replace('\\', "\\\\").replace('"', "\\\"")
        );
        let out = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&tmp);
        if out.status.success() {
            Ok("Installed `canopy` — run `canopy <dir>` from any terminal.".into())
        } else {
            Err(format!(
                "Couldn't install (admin prompt declined?). Manual: sudo sh -c 'printf \"#!/bin/sh\\nexec \\\"{}\\\" \\\"$@\\\"\\n\" > /usr/local/bin/canopy && chmod 755 /usr/local/bin/canopy'",
                exe.display()
            ))
        }
    }
    #[cfg(target_os = "linux")]
    {
        let Some(appimage) = std::env::var_os("APPIMAGE") else {
            return Ok(
                "`canopy` is already on your PATH (installed by your package manager).".into(),
            );
        };
        let home = std::env::var_os("HOME").ok_or("HOME not set")?;
        let bin = Path::new(&home).join(".local/bin");
        std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
        let dest = bin.join("canopy");
        let shim = format!(
            "#!/bin/sh\nexec \"{}\" \"$@\"\n",
            Path::new(&appimage).display()
        );
        write_shim(&dest, &shim).map_err(|e| e.to_string())?;
        Ok(format!(
            "Installed {} — make sure ~/.local/bin is on your PATH.",
            dest.display()
        ))
    }
    #[cfg(target_os = "windows")]
    {
        Err("Not supported on Windows yet — the installer will handle PATH when it ships.".into())
    }
}

#[cfg(unix)]
fn write_shim(dest: &Path, contents: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(dest, contents)?;
    std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_first_existing_dir_and_skips_flags() {
        let tmp = std::env::temp_dir();
        let args = vec![
            "canopy".into(),
            "-psn_0_12345".into(),
            "definitely-missing-dir-xyz".into(),
            tmp.to_string_lossy().into_owned(),
        ];
        let got = dir_from_args(args, Path::new("/"));
        assert_eq!(
            got,
            Some(tmp.canonicalize().unwrap().to_string_lossy().into_owned())
        );
    }

    #[test]
    fn resolves_relative_against_given_cwd() {
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let child = tmp.join("canopy-cli-test-dir");
        std::fs::create_dir_all(&child).unwrap();
        let got = dir_from_args(vec!["canopy".into(), "canopy-cli-test-dir".into()], &tmp);
        assert_eq!(
            got,
            Some(child.canonicalize().unwrap().to_string_lossy().into_owned())
        );
        let _ = std::fs::remove_dir(&child);
    }

    #[test]
    fn none_when_no_path_args() {
        assert_eq!(dir_from_args(vec!["canopy".into()], Path::new("/")), None);
    }
}

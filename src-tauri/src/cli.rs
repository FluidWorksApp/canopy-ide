//! `canopy <dir>` — open a directory as a project from the command line.
//! `canopy <file>[:line[:col]]` — open a file in the editor, inside a project
//! or not. Files the OS hands over (Finder, Explorer, a Linux file manager)
//! take the same route: see [`OpenTarget`] and [`deliver_targets`].
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

/// `canopy://…` from the first launch's argv, held the same way and for the
/// same reason.
///
/// This is the cold-start half of a deep link, and until reminders there was
/// nothing that needed it: every link came from a notification this process had
/// posted, so this process was by definition running. A note reminder is the
/// opposite case — launchd posts the banner precisely when Canopy is closed,
/// and the click launches us with the link in argv. Without this the app would
/// come up on whatever was last open, which is the exact failure notify.rs was
/// written to end.
pub struct PendingLink(pub Mutex<Option<String>>);

/// Set once the frontend has collected the cold-start link: from then on a
/// link is delivered as an event instead of waiting in [`PendingLink`].
pub struct LinkListenerReady(pub std::sync::atomic::AtomicBool);

/// First `canopy://…` argument. The same targets a notification click carries
/// (see `src/deepLinks.ts`), reachable from a terminal: `canopy
/// 'canopy://panel?name=tasks'` raises the running app and lands there. The
/// scheme is also registered with the OS ([`install_deep_links`]), so a
/// browser's "Open in Canopy" arrives here too: in argv on Windows and Linux,
/// as an Apple event on macOS.
///
/// A readable Canopy link (`https://canopyide.dev/<team>/<workspace>`, see
/// docs/seamless-sharing.md) counts too: `canopy https://canopyide.dev/acme/api`
/// arrives as `canopy://link?url=…`, and the app resolves it against the
/// signed-in account before opening anything.
pub fn link_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().skip(1).find_map(|a| {
        if a.starts_with("canopy://") {
            Some(a)
        } else if is_readable_link(&a) {
            Some(format!("canopy://link?url={}", percent_encode(&a)))
        } else {
            None
        }
    })
}

/// The canonical host only. The app re-validates the path shape and the server
/// re-checks access, so this just decides that the argument is a link and not
/// a directory.
pub fn is_readable_link(arg: &str) -> bool {
    arg.strip_prefix("https://canopyide.dev/")
        .is_some_and(|rest| rest.contains('/') && rest.len() <= 300)
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// First non-flag argument that resolves to an existing directory.
/// Flags are skipped rather than rejected: macOS LaunchServices appends
/// `-psn_…`, and future flags shouldn't break path detection.
pub fn dir_from_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Option<String> {
    targets_from_args(args, cwd)
        .into_iter()
        .find_map(|t| match t {
            OpenTarget::Dir { path } => Some(path),
            OpenTarget::File { .. } => None,
        })
}

/// Something the OS or a terminal asked Canopy to open: a folder becomes a
/// project, a file opens in the editor (at a line when one was given).
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpenTarget {
    Dir {
        path: String,
    },
    File {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        line: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        column: Option<u32>,
    },
}

/// Every non-flag argument that names an existing file or directory.
///
/// A file may carry a position the way compilers print one, `src/a.rs:12` or
/// `src/a.rs:12:5`, which is also what editor launchers pass. The name is tried
/// as given first, so a file whose real name ends in `:3` still opens. A
/// `file://` URL counts too: a Linux file manager hands one to `Exec=… %U`.
pub fn targets_from_args<I: IntoIterator<Item = String>>(args: I, cwd: &Path) -> Vec<OpenTarget> {
    let mut out = Vec::new();
    for a in args.into_iter().skip(1) {
        if a.starts_with('-') || a.starts_with("canopy://") || is_readable_link(&a) {
            continue;
        }
        match target_from_arg(&a, cwd) {
            Some(t) => out.push(t),
            None => log::warn!("cli: not a file or directory, ignoring: {a}"),
        }
    }
    out
}

fn target_from_arg(arg: &str, cwd: &Path) -> Option<OpenTarget> {
    if arg.starts_with("file://") {
        let path = tauri::Url::parse(arg).ok()?.to_file_path().ok()?;
        return target_at(&path, None, None);
    }
    let resolve = |s: &str| {
        let p = PathBuf::from(s);
        if p.is_absolute() {
            p
        } else {
            cwd.join(p)
        }
    };
    if let Some(t) = target_at(&resolve(arg), None, None) {
        return Some(t);
    }
    let (name, line, column) = split_position(arg)?;
    match target_at(&resolve(name), Some(line), column)? {
        // A position means nothing to a folder.
        OpenTarget::Dir { .. } => None,
        file => Some(file),
    }
}

/// `name:line` or `name:line:column`, with both numbers at least 1.
fn split_position(arg: &str) -> Option<(&str, u32, Option<u32>)> {
    let number = |s: &str| {
        (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
            .then(|| s.parse::<u32>().ok())
            .flatten()
            .filter(|n| *n > 0)
    };
    let (head, last) = arg.rsplit_once(':')?;
    let last = number(last)?;
    if let Some((name, line)) = head.rsplit_once(':') {
        if let Some(line) = number(line) {
            if !name.is_empty() {
                return Some((name, line, Some(last)));
            }
        }
    }
    (!head.is_empty()).then_some((head, last, None))
}

fn target_at(path: &Path, line: Option<u32>, column: Option<u32>) -> Option<OpenTarget> {
    let canon = path.canonicalize().ok()?;
    let path = frontend_path(&canon);
    if canon.is_dir() {
        Some(OpenTarget::Dir { path })
    } else if canon.is_file() {
        Some(OpenTarget::File { path, line, column })
    } else {
        None
    }
}

/// The form of a canonical path the frontend gets. On Windows `canonicalize`
/// returns verbatim paths (`\\?\C:\x`), which match neither project roots nor
/// the editor's `Uri`, so the prefix is dropped there. The scope checks in
/// `fsx` canonicalize again on their side, so grants still compare equal.
fn frontend_path(canon: &Path) -> String {
    let s = canon.to_string_lossy();
    if cfg!(windows) {
        strip_verbatim(&s)
    } else {
        s.into_owned()
    }
}

/// `\\?\C:\x` → `C:\x` and `\\?\UNC\server\share` → `\\server\share`. Other
/// verbatim forms (`\\?\Volume{…}`, `\\?\GLOBALROOT…`) have no plain spelling
/// and stay as they are, as does anything that is not verbatim.
fn strip_verbatim(path: &str) -> String {
    let Some(rest) = path.strip_prefix(r"\\?\") else {
        return path.to_string();
    };
    if let Some(unc) = rest.strip_prefix(r"UNC\") {
        return format!(r"\\{unc}");
    }
    let b = rest.as_bytes();
    let is_drive = b.len() >= 2
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b.len() == 2 || b[2] == b'\\');
    if is_drive {
        rest.to_string()
    } else {
        path.to_string()
    }
}

/// Targets that arrived before the frontend was listening, held the same way
/// and for the same reason as [`PendingLink`]: an event fired during boot would
/// race the listener's registration and be lost.
#[derive(Default)]
pub struct PendingTargets(Mutex<(bool, Vec<OpenTarget>)>);

/// A burst bigger than this (selecting a whole folder in Finder and pressing
/// Return) is cut off rather than opening hundreds of tabs.
const MAX_PENDING_TARGETS: usize = 64;

impl PendingTargets {
    /// Keep `targets` for the frontend to collect, or give them back to be
    /// emitted now that it listens.
    fn hold_or_route(&self, targets: Vec<OpenTarget>) -> Vec<OpenTarget> {
        let mut slot = self.0.lock().unwrap();
        if slot.0 {
            return targets;
        }
        let room = MAX_PENDING_TARGETS.saturating_sub(slot.1.len());
        slot.1.extend(targets.into_iter().take(room));
        Vec::new()
    }

    /// Hand over what is waiting and mark the frontend as listening.
    fn take(&self) -> Vec<OpenTarget> {
        let mut slot = self.0.lock().unwrap();
        slot.0 = true;
        std::mem::take(&mut slot.1)
    }
}

/// Open `targets` in the app: a file becomes readable and writable by the
/// editor (the user asked for this exact file, which is the grant), then
/// everything is queued or emitted as `cli-open-target`.
pub fn deliver_targets(app: &AppHandle, targets: Vec<OpenTarget>) {
    if targets.is_empty() {
        return;
    }
    let workspace = app.state::<crate::fsx::WorkspaceManager>();
    for t in &targets {
        if let OpenTarget::File { path, .. } = t {
            workspace.grant_file(Path::new(path));
        }
    }
    for t in app.state::<PendingTargets>().hold_or_route(targets) {
        let _ = app.emit("cli-open-target", t);
    }
}

/// Files named on the first launch's command line. Directories are left to
/// [`PendingOpen`], which the frontend already collects first.
pub fn queue_startup_files(app: &AppHandle) {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let files = targets_from_args(std::env::args(), &cwd)
        .into_iter()
        .filter(|t| matches!(t, OpenTarget::File { .. }))
        .collect();
    deliver_targets(app, files);
}

#[tauri::command]
pub fn cli_take_pending_targets(state: tauri::State<'_, PendingTargets>) -> Vec<OpenTarget> {
    state.take()
}

pub fn pending_from_env() -> PendingOpen {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    PendingOpen(Mutex::new(dir_from_args(std::env::args(), &cwd)))
}

pub fn pending_link_from_env() -> PendingLink {
    PendingLink(Mutex::new(link_from_args(std::env::args())))
}

/// Second-instance argv, forwarded by the single-instance plugin.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn open_forwarded(app: &AppHandle, argv: Vec<String>, cwd: String) {
    if let Some(link) = link_from_args(argv.clone()) {
        // Raises the window itself, so return before the focus block below
        // does it a second time.
        crate::notify::open_link(app, &link);
        return;
    }
    let targets = targets_from_args(argv, Path::new(&cwd));
    // As on a cold start: the first folder becomes a project, every file opens.
    if let Some(OpenTarget::Dir { path }) =
        targets.iter().find(|t| matches!(t, OpenTarget::Dir { .. }))
    {
        let _ = app.emit("cli-open", path.clone());
    }
    deliver_targets(
        app,
        targets
            .into_iter()
            .filter(|t| matches!(t, OpenTarget::File { .. }))
            .collect(),
    );
    // The window, not the webview window: once a preview tab adds a child
    // webview the latter stops resolving, and `canopy .` would silently fail to
    // raise the app.
    if let Some(w) = app.get_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[tauri::command]
pub fn cli_take_pending_open(state: tauri::State<'_, PendingOpen>) -> Option<String> {
    state.0.lock().unwrap().take()
}

#[tauri::command]
pub fn cli_take_pending_link(
    state: tauri::State<'_, PendingLink>,
    ready: tauri::State<'_, LinkListenerReady>,
) -> Option<String> {
    take_link(&state, &ready)
}

/// Hand over the cold-start link and mark the frontend as listening.
fn take_link(pending: &PendingLink, ready: &LinkListenerReady) -> Option<String> {
    let mut slot = pending.0.lock().unwrap();
    ready.0.store(true, std::sync::atomic::Ordering::SeqCst);
    slot.take()
}

/// Keep `link` for the frontend to collect, or give it back to be routed now
/// that the frontend listens. The lock orders this against [`take_link`], so a
/// link arriving during that handover is never lost or routed twice.
fn hold_or_route(pending: &PendingLink, ready: &LinkListenerReady, link: String) -> Option<String> {
    let mut slot = pending.0.lock().unwrap();
    if ready.0.load(std::sync::atomic::Ordering::SeqCst) {
        return Some(link);
    }
    *slot = Some(link);
    None
}

/// A `canopy://` URL the OS handed us. Before the frontend has collected the
/// cold-start link it waits in [`PendingLink`] (an event then would race the
/// listener and be lost); after, it is routed like a notification click.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn deliver_link(app: &AppHandle, link: String) {
    let routed = hold_or_route(
        &app.state::<PendingLink>(),
        &app.state::<LinkListenerReady>(),
        link,
    );
    if let Some(link) = routed {
        crate::notify::open_link(app, &link);
    }
}

/// The URL-scheme half of deep links. Registration itself is static
/// (`plugins.deep-link.desktop.schemes` in tauri.conf.json): the macOS bundle's
/// CFBundleURLTypes, the Windows installer's registry keys, and
/// `MimeType=x-scheme-handler/canopy` in the Linux .desktop file.
///
/// - macOS delivers a click as an Apple event, cold start included; that is
///   what `on_open_url` carries.
/// - Windows and Linux start a process with the URL in argv: on a cold start
///   [`pending_link_from_env`] already holds it, and with Canopy running the
///   single-instance plugin forwards it to [`open_forwarded`]. Routing
///   `on_open_url` as well would open the link twice, so it is macOS only.
/// - An AppImage (or a Windows/Linux dev build) has no installer to register
///   it, so it registers itself at runtime.
pub fn install_deep_links(app: &mut tauri::App) {
    app.manage(LinkListenerReady(std::sync::atomic::AtomicBool::new(false)));
    app.manage(PendingTargets::default());
    queue_startup_files(app.handle());
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        let handle = app.handle().clone();
        // Finder's double-click, "Open With" and a drop on the Dock icon arrive
        // the same way as a link: an Apple event carrying file:// URLs, which
        // the deep-link plugin forwards along with everything else it hears.
        app.deep_link().on_open_url(move |event| {
            let mut targets = Vec::new();
            for url in event.urls() {
                match url.scheme() {
                    "canopy" => deliver_link(&handle, url.to_string()),
                    "file" => {
                        if let Some(t) = url
                            .to_file_path()
                            .ok()
                            .and_then(|p| target_at(&p, None, None))
                        {
                            targets.push(t);
                        }
                    }
                    _ => {}
                }
            }
            deliver_targets(&handle, targets);
        });
    }
    #[cfg(any(windows, target_os = "linux"))]
    {
        use tauri_plugin_deep_link::DeepLinkExt;
        let self_registered = cfg!(debug_assertions)
            || (cfg!(target_os = "linux") && std::env::var_os("APPIMAGE").is_some());
        if self_registered {
            if let Err(error) = app.deep_link().register_all() {
                log::warn!("deep links: could not register canopy:// ({error})");
            }
        }
    }
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
        let mut command = std::process::Command::new("osascript");
        command.args(["-e", &script]);
        let out = crate::process_capture::output(
            &mut command,
            crate::process_capture::DEFAULT_STREAM_MAX,
        )?;
        crate::process_capture::reject_truncated(&out, "osascript")?;
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
    fn verbatim_windows_paths_become_plain() {
        assert_eq!(strip_verbatim(r"\\?\C:\Users\me\a.rs"), r"C:\Users\me\a.rs");
        assert_eq!(strip_verbatim(r"\\?\d:\"), r"d:\");
        assert_eq!(strip_verbatim(r"\\?\C:"), r"C:");
        assert_eq!(
            strip_verbatim(r"\\?\UNC\server\share\x.txt"),
            r"\\server\share\x.txt"
        );
        // No plain spelling exists for these, so they are left alone.
        for kept in [
            r"\\?\Volume{1234}\x",
            r"\\?\GLOBALROOT\Device\x",
            r"\\?\CC:\x",
            r"C:\already\plain",
            r"\\server\share",
            "/home/me/a.rs",
        ] {
            assert_eq!(strip_verbatim(kept), kept);
        }
    }

    #[test]
    fn os_links_wait_for_the_frontend_then_route_directly() {
        let pending = PendingLink(Mutex::new(None));
        let ready = LinkListenerReady(std::sync::atomic::AtomicBool::new(false));
        // A cold-start Apple event lands before the webview listens: it waits.
        assert_eq!(hold_or_route(&pending, &ready, "canopy://a".into()), None);
        // The latest one wins, as a second click before boot finishes means.
        assert_eq!(hold_or_route(&pending, &ready, "canopy://b".into()), None);
        assert_eq!(take_link(&pending, &ready).as_deref(), Some("canopy://b"));
        assert_eq!(take_link(&pending, &ready), None);
        // Once collected, later links are routed at once, never parked.
        assert_eq!(
            hold_or_route(&pending, &ready, "canopy://c".into()).as_deref(),
            Some("canopy://c")
        );
        assert_eq!(take_link(&pending, &ready), None);
    }

    #[test]
    fn scheme_links_from_the_os_are_read_from_argv() {
        // Windows and Linux launch `canopy <url>` for a registered scheme.
        let args = vec!["canopy".into(), "canopy://link?url=x".into()];
        assert_eq!(link_from_args(args).as_deref(), Some("canopy://link?url=x"));
    }

    #[test]
    fn readable_links_become_deep_links() {
        let args = vec![
            "canopy".into(),
            "https://canopyide.dev/acme/api/s/fix-login-27".into(),
        ];
        assert_eq!(
            link_from_args(args).as_deref(),
            Some("canopy://link?url=https%3A%2F%2Fcanopyide.dev%2Facme%2Fapi%2Fs%2Ffix-login-27")
        );
        for other in [
            "https://canopyide.dev/downloads",
            "https://evil.dev/acme/api",
            "http://canopyide.dev/acme/api",
        ] {
            assert_eq!(link_from_args(vec!["canopy".into(), other.into()]), None);
        }
        assert_eq!(
            link_from_args(vec!["canopy".into(), "canopy://app".into()]).as_deref(),
            Some("canopy://app")
        );
    }

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
    fn files_open_with_an_optional_position() {
        let tmp = std::env::temp_dir().canonicalize().unwrap();
        let dir = tmp.join("canopy-cli-test-files");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("main.rs");
        std::fs::write(&file, "fn main() {}\n").unwrap();
        // A real name that happens to end like a position wins over parsing it.
        let odd = dir.join("notes:3");
        let odd_ok = std::fs::write(&odd, "x").is_ok();
        let canon = |p: &Path| p.canonicalize().unwrap().to_string_lossy().into_owned();
        let args = vec![
            "canopy".to_string(),
            "-psn_0_1".into(),
            "main.rs".into(),
            "main.rs:12".into(),
            "main.rs:12:5".into(),
            "missing.rs:3".into(),
            "main.rs:0".into(),
            ".:4".into(),
            ".".into(),
        ];
        let got = targets_from_args(args, &dir);
        let file_at = |line, column| OpenTarget::File {
            path: canon(&file),
            line,
            column,
        };
        assert_eq!(
            got,
            vec![
                file_at(None, None),
                file_at(Some(12), None),
                file_at(Some(12), Some(5)),
                OpenTarget::Dir { path: canon(&dir) },
            ]
        );
        if odd_ok {
            assert_eq!(
                targets_from_args(vec!["canopy".into(), "notes:3".into()], &dir),
                vec![OpenTarget::File {
                    path: canon(&odd),
                    line: None,
                    column: None
                }]
            );
        }
        // A file:// URL, as a Linux file manager passes to %U.
        let url = tauri::Url::from_file_path(&file).unwrap().to_string();
        assert_eq!(
            targets_from_args(vec!["canopy".into(), url], Path::new("/")),
            vec![file_at(None, None)]
        );
        // Files never count as the project folder.
        assert_eq!(
            dir_from_args(vec!["canopy".into(), "main.rs".into()], &dir),
            None
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn split_position_needs_positive_numbers() {
        assert_eq!(split_position("a.rs:3"), Some(("a.rs", 3, None)));
        assert_eq!(split_position("a.rs:3:9"), Some(("a.rs", 3, Some(9))));
        assert_eq!(split_position("C:\\x\\a.rs:3"), Some(("C:\\x\\a.rs", 3, None)));
        assert_eq!(split_position("a.rs"), None);
        assert_eq!(split_position("a.rs:"), None);
        assert_eq!(split_position("a.rs:x"), None);
        assert_eq!(split_position("a.rs:0"), None);
        assert_eq!(split_position(":3"), None);
    }

    #[test]
    fn targets_wait_for_the_frontend_then_route_directly() {
        let pending = PendingTargets::default();
        let t = |p: &str| OpenTarget::Dir { path: p.into() };
        assert!(pending.hold_or_route(vec![t("a"), t("b")]).is_empty());
        assert_eq!(pending.take(), vec![t("a"), t("b")]);
        assert_eq!(pending.hold_or_route(vec![t("c")]), vec![t("c")]);
        assert!(pending.take().is_empty());
    }

    #[test]
    fn a_burst_before_boot_is_capped() {
        let pending = PendingTargets::default();
        let many = (0..MAX_PENDING_TARGETS + 10)
            .map(|i| OpenTarget::Dir { path: i.to_string() })
            .collect();
        assert!(pending.hold_or_route(many).is_empty());
        assert_eq!(pending.take().len(), MAX_PENDING_TARGETS);
    }

    #[test]
    fn none_when_no_path_args() {
        assert_eq!(dir_from_args(vec!["canopy".into()], Path::new("/")), None);
    }

    #[test]
    fn picks_deep_link_and_keeps_it_out_of_dir_detection() {
        let args = vec![
            "canopy".to_string(),
            "canopy://panel?name=tasks".to_string(),
        ];
        assert_eq!(
            link_from_args(args.clone()),
            Some("canopy://panel?name=tasks".to_string())
        );
        // A link is not a relative directory name — it must never be joined to
        // the caller's cwd and probed as one.
        assert_eq!(dir_from_args(args, Path::new("/")), None);
    }
}

//! The environment a process needs when Canopy did not come from a terminal.
//!
//! A GUI app on macOS is launched by `launchd`, not by a shell, so it inherits
//! `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else — no `/opt/homebrew/bin`, no
//! `~/.local/bin`, none of the version-manager shims a developer's PATH is
//! mostly made of. Every child it spawns inherits that same poverty.
//!
//! This is invisible in development and total in production, which is exactly
//! how it presents: the dev build works because `pnpm tauri dev` was started
//! from a terminal and inherits a real PATH, and the installed build fails on
//! the same machine, same binary, same config. "Works locally, broken in the
//! app" is the signature.
//!
//! `pty.rs` never suffers from it because it spawns `zsh -l` and everything
//! below a login shell has the user's real PATH. Anything that execs a binary
//! *directly* has to reconstruct that for itself, and needs both halves:
//!
//!   * `resolve_command` — find the binary at all.
//!   * `login_path` — and then give the child an environment in which the
//!     things IT spawns can be found too. Resolving only the first is a fix
//!     that gets an agent CLI started and leaves it unable to run `git`.

use std::sync::OnceLock;

use crate::winproc::NoConsoleWindow;

/// The user's real PATH, as their login shell would build it.
///
/// Cached: this costs a shell startup (tens of milliseconds, and the user's
/// profile may do real work), and it cannot change while the app is running
/// without them editing a dotfile and re-logging in.
///
/// `None` when there is no shell to ask or it produced nothing — in which case
/// the caller should leave PATH alone rather than replace it with a guess.
pub(crate) fn login_path() -> Option<&'static str> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            #[cfg(unix)]
            {
                let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
                // `-l` so the profile that sets PATH is read. `printf` rather
                // than `echo` because a PATH is printed verbatim by one and not
                // reliably by the other.
                let out = std::process::Command::new(shell)
                    .args(["-lc", "printf %s \"$PATH\""])
                    .no_console_window()
                    .output()
                    .ok()?;
                if !out.status.success() {
                    return None;
                }
                let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if path.is_empty() {
                    return None;
                }
                Some(path)
            }
            #[cfg(not(unix))]
            {
                // Windows processes inherit the user's PATH from the registry
                // whatever launched them, so there is nothing to reconstruct.
                None
            }
        })
        .as_deref()
}

/// The PATH to hand a child: the user's login PATH first, then anything the
/// app's own environment has that it lacks.
///
/// Merged rather than replaced because the two are not the same set and both
/// matter. The login PATH has the developer's tools; the app's PATH, when it
/// came from a dev server, has things like `node_modules/.bin` that the login
/// shell has never heard of. Taking either alone loses something that worked
/// before.
///
/// Login entries lead, so a tool present in both resolves to the one the user's
/// terminal would run — which is the one they tested with.
pub(crate) fn child_path() -> Option<String> {
    let login = login_path()?;
    let current = std::env::var("PATH").unwrap_or_default();
    if current.is_empty() {
        return Some(login.to_string());
    }
    // Deduped across both, not just when merging the second in: a real profile
    // builds PATH by prepending, so the login PATH alone routinely repeats an
    // entry. Left alone those duplicates survive into every child, and a nested
    // spawn compounds them.
    let mut out: Vec<&str> = Vec::new();
    for dir in login
        .split(':')
        .chain(current.split(':'))
        .filter(|s| !s.is_empty())
    {
        if !out.contains(&dir) {
            out.push(dir);
        }
    }
    Some(out.join(":"))
}

/// Find a bare command the way a login shell would.
///
/// An absolute path is returned untouched, and a name already on the current
/// PATH is left for `exec` to find. Only a name that cannot be found is worth
/// paying a shell for — which, in a GUI-launched app, is most of them.
pub(crate) fn resolve_command(cmd: &str) -> String {
    if cmd.contains('/') {
        return cmd.to_string();
    }
    if std::env::var("PATH")
        .map(|path| std::env::split_paths(&path).any(|dir| dir.join(cmd).is_file()))
        .unwrap_or(false)
    {
        return cmd.to_string();
    }
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        if let Ok(out) = std::process::Command::new(shell)
            .args(["-lc", &format!("command -v {cmd}")])
            .no_console_window()
            .output()
        {
            if out.status.success() {
                let found = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !found.is_empty() {
                    return found;
                }
            }
        }
    }
    cmd.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absolute_path_is_left_alone() {
        assert_eq!(resolve_command("/bin/sh"), "/bin/sh");
        assert_eq!(resolve_command("./local"), "./local");
    }

    #[test]
    fn a_bare_name_resolves_to_something_runnable() {
        let found = resolve_command("sh");
        assert!(
            found == "sh" || std::path::Path::new(&found).is_file(),
            "sh resolved to {found:?}, which is neither on PATH nor a real file"
        );
    }

    #[test]
    fn an_unknown_name_comes_back_unchanged() {
        // So the caller's own "could not start" error names what it was asked
        // for, rather than an empty string.
        assert_eq!(
            resolve_command("definitely-not-a-real-binary-xyzzy"),
            "definitely-not-a-real-binary-xyzzy"
        );
    }

    #[test]
    fn the_child_path_keeps_both_halves() {
        // The failure this guards: replacing the app's PATH with the login one
        // drops `node_modules/.bin` in a dev build; keeping only the app's
        // drops /opt/homebrew/bin in production. Both have to survive.
        let Some(merged) = child_path() else {
            return; // no shell to ask — nothing to assert
        };
        let dirs: Vec<&str> = merged.split(':').collect();
        for dir in std::env::var("PATH").unwrap_or_default().split(':') {
            if !dir.is_empty() {
                assert!(dirs.contains(&dir), "{dir} was dropped from the child PATH");
            }
        }
        // And no duplicates — a real profile prepends, so the login PATH
        // itself arrives with repeats, and every child would inherit them.
        let mut seen = std::collections::HashSet::new();
        for dir in &dirs {
            assert!(seen.insert(*dir), "{dir} appears twice");
        }
    }
}

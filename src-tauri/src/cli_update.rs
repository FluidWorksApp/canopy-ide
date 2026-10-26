//! Keeping the agent CLIs current — the native half of Settings → Agents →
//! "Keep agent CLIs up to date" (`autoUpdateClis`, src/cliAutoUpdate.ts).
//!
//! Two jobs, both desktop-local. Remote workspaces never reach either: their
//! CLIs are pinned by packages/remote-host/agents.lock.json and change only
//! with an image release, and NativeWorkspaceHost answers the publish below
//! itself instead of forwarding it to the workspace.
//!
//!   1. **Run one CLI's updater, unattended** (`cli_run_update`). Which command
//!      is the registry's business (projects.ts `autoUpdateCommand`); this side
//!      decides only *whether it is safe right now* — never while a process of
//!      that CLI is running anywhere on the machine, because an in-place
//!      `npm install -g` deletes the files a live session is still executing
//!      (Claude Code's own setup docs warn about exactly this) — and runs it
//!      with no stdin and a deadline, so a prompt fails fast instead of hanging.
//!
//!   2. **Switch native updaters off when the user switched the setting off**
//!      (`cli_set_native_update_env`). Claude Code, Grok and Antigravity update
//!      themselves; Canopy leaves them alone while the setting is on, and while
//!      it is off puts each one's documented "don't" variable into every agent
//!      process it starts. The frontend publishes the list (it owns the
//!      registry); every spawn path reads it here.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{OnceLock, RwLock};
use std::time::Duration;

fn native_env_slot() -> &'static RwLock<Vec<(String, String)>> {
    static ENV: OnceLock<RwLock<Vec<(String, String)>>> = OnceLock::new();
    // Empty until the frontend publishes: the default setting is on, and "on"
    // means leave every native updater exactly as the user configured it.
    ENV.get_or_init(|| RwLock::new(Vec::new()))
}

/// The variables every agent process should carry so the CLIs' own updaters
/// stay off. Empty while auto-update is on.
pub(crate) fn native_update_env() -> Vec<(String, String)> {
    native_env_slot()
        .read()
        .map(|env| env.clone())
        .unwrap_or_default()
}

fn env_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// Publish the native-updater "off" variables (see module docs, job 2). An
/// empty list restores the CLIs' own behaviour. Names are restricted to
/// upper-case env identifiers: this list lands in every terminal's
/// environment, so it must never be able to smuggle `PATH` lookalikes with
/// odd characters or arbitrary-length values.
#[tauri::command]
pub fn cli_set_native_update_env(env: Vec<(String, String)>) -> Result<(), String> {
    if env.len() > 32 {
        return Err("too many native update variables".into());
    }
    for (name, value) in &env {
        if !env_name_ok(name) || value.len() > 256 || value.chars().any(char::is_control) {
            return Err(format!("refusing native update variable {name:?}"));
        }
    }
    *native_env_slot()
        .write()
        .map_err(|_| "native update env lock poisoned")? = env;
    Ok(())
}

/// What one unattended update attempt came to.
#[derive(Serialize, Debug, PartialEq)]
pub struct CliUpdateOutcome {
    /// `updated` (the updater exited 0), `deferred` (not attempted — the CLI
    /// is running, or another update is), or `failed`.
    pub status: &'static str,
    /// Tail of the updater's output, or why it was deferred.
    pub detail: String,
}

impl CliUpdateOutcome {
    fn new(status: &'static str, detail: impl Into<String>) -> Self {
        Self {
            status,
            detail: detail.into(),
        }
    }
}

/// Language runtimes and shells a CLI is commonly launched *through*: for
/// these the program's identity is the next argument (`node …/bin/codex`).
#[cfg_attr(not(unix), allow(dead_code))]
fn is_runtime(name: &str) -> bool {
    matches!(
        name,
        "node" | "nodejs" | "bun" | "deno" | "sh" | "bash" | "zsh" | "dash"
    ) || name.starts_with("python")
}

#[cfg_attr(not(unix), allow(dead_code))]
fn base_name(token: &str) -> &str {
    let name = token.rsplit(['/', '\\']).next().unwrap_or(token);
    name.strip_suffix(".exe").unwrap_or(name)
}

/// The directory that holds everything an update would replace, when that is
/// narrower than "the binary itself": an npm package root, or a versioned
/// install directory (cursor-agent's `versions/<v>/`). A binary that sits
/// directly in a `bin/` directory has no such root — `/usr/local/bin` would
/// match every tool on the machine.
#[cfg_attr(not(unix), allow(dead_code))]
fn install_root(canonical: &str) -> Option<String> {
    let path = canonical.replace('\\', "/");
    if let Some(at) = path.find("/node_modules/") {
        let rest = &path[at + "/node_modules/".len()..];
        let mut parts = rest.split('/');
        let first = parts.next()?;
        let name = if first.starts_with('@') {
            format!("{first}/{}", parts.next()?)
        } else {
            first.to_string()
        };
        return Some(format!("{}/node_modules/{name}", &path[..at]));
    }
    let parent = path.rsplit_once('/')?.0;
    let parent_name = parent.rsplit('/').next().unwrap_or("");
    (parent_name != "bin" && !parent.is_empty()).then(|| parent.to_string())
}

/// Is any process in `ps_args` (one command line per row) an instance of this
/// CLI? Matched by what was run — the binary's own name as argv[0], or as the
/// script a runtime was handed — and by anything executing from inside its
/// install root (the native binary a node shim spawns, a versioned build).
/// Never by substring: `ampere` is not `amp`.
#[cfg_attr(not(unix), allow(dead_code))]
pub(crate) fn cli_in_use(ps_args: &str, bin: &str, canonical: Option<&str>) -> bool {
    let name = base_name(bin);
    if name.is_empty() {
        return false;
    }
    let root = canonical.and_then(install_root);
    ps_args.lines().any(|line| {
        let tokens: Vec<&str> = line.split_whitespace().collect();
        let Some(first) = tokens.first() else {
            return false;
        };
        let first_name = base_name(first.trim_start_matches('-'));
        if first_name == name {
            return true;
        }
        if is_runtime(first_name) {
            if let Some(script) = tokens.get(1) {
                if base_name(script) == name {
                    return true;
                }
            }
        }
        tokens.iter().any(|t| {
            canonical == Some(*t)
                || root
                    .as_deref()
                    .is_some_and(|r| *t == r || t.starts_with(&format!("{r}/")))
        })
    })
}

/// Last `max` characters of `text`, on a char boundary.
#[cfg_attr(not(unix), allow(dead_code))]
fn tail(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &text[start..])
}

/// One update at a time, machine-wide for this app. Two windows can both run
/// the scheduler; two package managers writing one prefix at once is how a
/// global install gets corrupted.
static UPDATE_RUNNING: AtomicBool = AtomicBool::new(false);

struct RunningGuard;
impl Drop for RunningGuard {
    fn drop(&mut self) {
        UPDATE_RUNNING.store(false, Ordering::SeqCst);
    }
}

/// Run `command` (a CLI's install-matched updater) unless `bin` is in use.
///
/// The command runs in the user's login shell (the PATH that owns npm, brew,
/// pipx…), with stdin closed and `NO_UPDATE_NOTIFIER=1`, under `timeout_secs`
/// (clamped to 30 s – 30 min). It is `exec`ed so the deadline kills the
/// updater itself rather than only the shell around it.
#[tauri::command]
pub async fn cli_run_update(
    bin: String,
    command: String,
    timeout_secs: Option<u64>,
) -> CliUpdateOutcome {
    if command.trim().is_empty() || command.chars().any(|c| c == '\n' || c == '\r') {
        return CliUpdateOutcome::new("failed", "refusing an empty or multi-line update command");
    }
    if UPDATE_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return CliUpdateOutcome::new("deferred", "another CLI update is running");
    }
    let _guard = RunningGuard;
    run_update(&bin, &command, timeout_secs.unwrap_or(600).clamp(30, 1800)).await
}

#[cfg(unix)]
async fn run_update(bin: &str, command: &str, timeout_secs: u64) -> CliUpdateOutcome {
    let Some(target) = crate::agents::probe_target(bin) else {
        return CliUpdateOutcome::new("failed", format!("not a CLI name: {bin}"));
    };
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());

    // Where the PATH winner really lives, so a node shim's native child and a
    // versioned build both count as "this CLI is running".
    let mut which = tokio::process::Command::new(&shell);
    which
        .args([
            "-lc",
            &format!(
                "command -v {} 2>/dev/null",
                crate::agents::sh_quote(&target)
            ),
        ])
        .kill_on_drop(true);
    let resolved = tokio::time::timeout(
        Duration::from_secs(10),
        crate::process_capture::tokio_output(&mut which, 64 * 1024),
    )
    .await;
    let canonical = match resolved {
        Ok(Ok(out)) => std::fs::canonicalize(String::from_utf8_lossy(&out.stdout).trim())
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
        _ => None,
    };
    let Some(canonical) = canonical else {
        return CliUpdateOutcome::new("failed", format!("{bin} is not on the login PATH"));
    };

    // `-ww`: unlimited width, or long node command lines lose the very path
    // that identifies them. `-ax`: every process of every terminal, not only
    // Canopy's — a session in another terminal app breaks just the same.
    let mut ps = tokio::process::Command::new(crate::procenv::resolve_command("ps"));
    ps.args(["-axww", "-o", "args="]).kill_on_drop(true);
    let listing = tokio::time::timeout(
        Duration::from_secs(10),
        crate::process_capture::tokio_output(&mut ps, 4 * 1024 * 1024),
    )
    .await;
    let Ok(Ok(listing)) = listing else {
        // Unknown is not idle: without a process list there is no way to
        // promise the update cannot pull files out from under a session.
        return CliUpdateOutcome::new("deferred", "could not list running processes");
    };
    if cli_in_use(
        &String::from_utf8_lossy(&listing.stdout),
        bin,
        Some(&canonical),
    ) {
        return CliUpdateOutcome::new("deferred", format!("{bin} is running"));
    }

    let mut run = tokio::process::Command::new(&shell);
    run.args(["-lc", &format!("exec {command}")])
        .env("NO_UPDATE_NOTIFIER", "1")
        .env("npm_config_fund", "false")
        .env("npm_config_audit", "false")
        .kill_on_drop(true);
    let started = std::time::Instant::now();
    let result = tokio::time::timeout(
        Duration::from_secs(timeout_secs),
        crate::process_capture::tokio_output(&mut run, 1024 * 1024),
    )
    .await;
    let outcome = match result {
        Err(_) => CliUpdateOutcome::new(
            "failed",
            format!("`{command}` did not finish within {timeout_secs}s"),
        ),
        Ok(Err(error)) => CliUpdateOutcome::new("failed", format!("`{command}`: {error}")),
        Ok(Ok(out)) => {
            let text = format!(
                "{}\n{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            if out.status.success() {
                CliUpdateOutcome::new("updated", tail(&text, 600))
            } else {
                CliUpdateOutcome::new(
                    "failed",
                    format!(
                        "`{command}` exited with {}: {}",
                        out.status,
                        tail(&text, 600)
                    ),
                )
            }
        }
    };
    let secs = started.elapsed().as_secs();
    match outcome.status {
        "updated" => log::info!("cli auto-update {bin}: `{command}` ok in {secs}s"),
        _ => log::warn!("cli auto-update {bin}: {}", outcome.detail),
    }
    outcome
}

#[cfg(not(unix))]
async fn run_update(_bin: &str, _command: &str, _timeout_secs: u64) -> CliUpdateOutcome {
    // The version probe (cli_versions) is unix-only too, so nothing schedules
    // this on Windows yet; answer rather than pretend.
    CliUpdateOutcome::new(
        "deferred",
        "automatic CLI updates are not supported on this platform",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::python_update_command;

    const PS: &str = "\
/sbin/init
-zsh
node /home/u/.local/bin/codex resume 0199
/home/u/.local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
claude --resume abc
/opt/cursor/versions/2026.10.01/node /opt/cursor/versions/2026.10.01/index.js
vim notes/amp.md
ampere --serve
";

    #[test]
    fn a_running_cli_is_found_by_its_own_name() {
        assert!(cli_in_use("claude --resume abc\n", "claude", None));
        assert!(cli_in_use("/home/u/.local/bin/claude\n", "claude", None));
        // A login shell's leading dash is not part of the name.
        assert!(cli_in_use("-grok\n", "grok", None));
    }

    #[test]
    fn a_runtime_launched_cli_is_found_by_its_script() {
        assert!(cli_in_use("node /home/u/.local/bin/codex\n", "codex", None));
        assert!(cli_in_use(
            "python3 /opt/aider/bin/aider --yes-always\n",
            "aider",
            None
        ));
    }

    #[test]
    fn a_native_child_is_found_by_its_install_root() {
        let only_child = "/home/u/.local/lib/node_modules/@openai/codex/node_modules/x/bin/codex-native --flag\n";
        let canonical = "/home/u/.local/lib/node_modules/@openai/codex/bin/codex.js";
        assert!(cli_in_use(only_child, "codex", Some(canonical)));
        let cursor =
            "/opt/cursor/versions/2026.10.01/node /opt/cursor/versions/2026.10.01/index.js\n";
        assert!(cli_in_use(
            cursor,
            "cursor-agent",
            Some("/opt/cursor/versions/2026.10.01/cursor-agent"),
        ));
    }

    #[test]
    fn near_misses_are_not_the_cli() {
        // `amp` appears only as a substring and as an editor's argument.
        assert!(!cli_in_use(
            PS,
            "amp",
            Some("/usr/local/lib/node_modules/@ampcode/cli/bin/amp")
        ));
        assert!(!cli_in_use(PS, "opencode", None));
        // A bare binary in a bin/ directory must not make every tool there "in use".
        assert!(!cli_in_use(
            "/usr/local/bin/omp-other\n",
            "agy",
            Some("/usr/local/bin/agy")
        ));
        assert!(cli_in_use(
            "/usr/local/bin/agy\n",
            "agy",
            Some("/usr/local/bin/agy")
        ));
    }

    #[test]
    fn install_roots_are_package_or_version_directories() {
        assert_eq!(
            install_root("/p/lib/node_modules/@openai/codex/bin/codex.js").as_deref(),
            Some("/p/lib/node_modules/@openai/codex")
        );
        assert_eq!(
            install_root("/p/lib/node_modules/opencode-ai/bin/opencode.exe").as_deref(),
            Some("/p/lib/node_modules/opencode-ai")
        );
        assert_eq!(
            install_root("/v/versions/2026.10.01/cursor-agent").as_deref(),
            Some("/v/versions/2026.10.01")
        );
        assert_eq!(install_root("/usr/local/bin/agy"), None);
    }

    #[test]
    fn python_clis_upgrade_through_the_environment_that_owns_them() {
        assert_eq!(
            python_update_command(
                "/home/u/.local/share/pipx/venvs/aider-chat/bin/aider",
                Some("#!/home/u/.local/share/pipx/venvs/aider-chat/bin/python"),
                "aider-chat",
            ),
            Some(("pipx", "pipx upgrade aider-chat".to_string()))
        );
        assert_eq!(
            python_update_command(
                "/home/u/.local/share/uv/tools/aider-chat/bin/aider",
                Some("#!/home/u/.local/share/uv/tools/aider-chat/bin/python3"),
                "aider-chat",
            ),
            Some(("uv", "uv tool upgrade aider-chat".to_string()))
        );
        assert_eq!(
            python_update_command(
                "/opt/canopy/tools/aider/bin/aider",
                Some("#!/opt/canopy/tools/aider/bin/python3"),
                "aider-chat",
            ),
            Some((
                "pip",
                "'/opt/canopy/tools/aider/bin/python3' -m pip install --upgrade \
                 --upgrade-strategy only-if-needed aider-chat"
                    .to_string()
            ))
        );
    }

    #[test]
    fn python_detection_refuses_to_guess() {
        // `env python3` names no particular environment.
        assert_eq!(
            python_update_command(
                "/usr/local/bin/aider",
                Some("#!/usr/bin/env python3"),
                "aider-chat"
            ),
            None
        );
        // A native binary has no shebang.
        assert_eq!(
            python_update_command("/usr/local/bin/aider", None, "aider-chat"),
            None
        );
        // A package name that could carry shell syntax never reaches a command.
        assert_eq!(
            python_update_command("/x/pipx/venvs/a/bin/a", None, "aider;rm -rf ~"),
            None
        );
    }

    #[test]
    fn native_update_env_is_validated_and_replaceable() {
        assert!(cli_set_native_update_env(vec![("PATH;x".into(), "1".into())]).is_err());
        assert!(
            cli_set_native_update_env(vec![("DISABLE_AUTOUPDATER".into(), "1\n".into())]).is_err()
        );
        cli_set_native_update_env(vec![("DISABLE_AUTOUPDATER".into(), "1".into())]).unwrap();
        assert_eq!(
            native_update_env(),
            vec![("DISABLE_AUTOUPDATER".to_string(), "1".to_string())]
        );
        cli_set_native_update_env(vec![]).unwrap();
        assert!(native_update_env().is_empty());
    }

    #[test]
    fn output_tails_keep_the_end() {
        assert_eq!(tail("short", 10), "short");
        assert_eq!(tail("0123456789abc", 3), "…abc");
    }
}

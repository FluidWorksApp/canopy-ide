//! Headless brain calls: one read-only, one-shot run of the person's agent CLI.
//!
//! Every intelligent feature (receipts, plan review, awareness, …) asks the
//! connected CLI a question and reads a judgment back. That is a different
//! process shape from the two runners Canopy already has, and reusing either
//! would be wrong rather than merely untidy:
//!
//!  * `structured_runner_spawn` is a *task attempt*: it requires an attempt the
//!    task store authorized, and it mints a context-bridge token so the agent
//!    can claim files and call canopy_* tools. A judgment call owns no task and
//!    must not be able to act on the workspace through the bridge either.
//!  * `companion_spawn` is a singleton. A background feature spawning there
//!    would kill the person's open chat.
//!
//! So this is the smallest runner that fits: argv in (built by the TS side
//! from the CLI's verified runner manifest, so no vendor flag lives here),
//! stdout lines out on a channel, stdin closed at spawn, a hard ceiling, and a
//! kill by call id. The protocol stays owned by structuredEvents.ts.

use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;

use tauri::ipc::Channel;
use tauri::Manager;
use tokio::io::BufReader;
use tokio::process::Child;
use tokio::sync::Mutex;

use crate::structured_runner::{capped_line, StructuredRunnerOut};
use crate::winproc::NoConsoleWindow;

const STDERR_KEEP: usize = 8 * 1024;
const STDOUT_LINE_MAX: usize = 1024 * 1024;
/// Upper bound on any one call, whatever the caller asked for. The TS side
/// times out first; this exists so a renderer that reloaded mid-call cannot
/// leave a CLI running for the rest of the session.
const CEILING_MS: u64 = 15 * 60 * 1000;

struct Running {
    child: Child,
    process_group: Option<u32>,
}

impl Drop for Running {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.process_group {
            // Own process group (below), so MCP servers and hooks the CLI
            // started go with it.
            unsafe {
                libc::killpg(pid as libc::pid_t, libc::SIGKILL);
            }
        }
        let _ = self.child.start_kill();
    }
}

#[derive(Default)]
pub struct BrainCalls {
    running: Mutex<HashMap<String, Running>>,
}

fn valid_call_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// Environment keys a brain call must not inherit.
///
/// Anything starting `CANOPY` marks a process as one of Canopy's agent
/// sessions: `CANOPY=1` arms canopy-hook (which would snapshot a "turn" and
/// publish turn-end events for a judgment call nobody sees), `CANOPY_PTY`
/// binds it to a terminal, and `CANOPY_CTX_*` would hand it the context
/// bridge. The app only carries these when it was itself started from a
/// Canopy terminal (development), but that is exactly when a leak would be
/// most confusing.
fn scrubbed(key: &str) -> bool {
    key.starts_with("CANOPY")
}

/// Start one brain call. Returns once the process is running; output arrives
/// on `on_data` and ends with an `exit` message, exactly like the structured
/// runner, so the TS side can reuse its line handling.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn brain_call(
    app: tauri::AppHandle,
    state: tauri::State<'_, BrainCalls>,
    call_id: String,
    command: String,
    args: Vec<String>,
    cwd: String,
    env: Option<Vec<(String, String)>>,
    timeout_ms: Option<u64>,
    on_data: Channel<StructuredRunnerOut>,
) -> Result<(), String> {
    if !valid_call_id(&call_id) {
        return Err("a brain call requires a valid call id".into());
    }
    // An empty cwd means "nowhere in particular" — the connection probe asks
    // before any project is open. Home, so the CLI loads no project's config.
    let dir = if cwd.trim().is_empty() {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(std::path::PathBuf::from)
            .ok_or("a brain call without a cwd needs a home directory")?
    } else {
        std::path::PathBuf::from(&cwd)
    };
    if !dir.is_dir() {
        return Err(format!("brain call cwd does not exist: {cwd}"));
    }
    let dir = dir.as_path();
    let mut held = state.running.lock().await;
    if held.contains_key(&call_id) {
        return Err(format!("brain call is already active: {call_id}"));
    }

    let resolved = crate::procenv::resolve_command(&command);
    let mut cmd = tokio::process::Command::new(&resolved);
    cmd.args(&args)
        .current_dir(dir)
        // Closed, not piped: a one-shot CLI reads a piped stdin to EOF even
        // when the prompt is on argv (see structured_runner_spawn), and a
        // brain call never writes a second message.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd.no_console_window();
    #[cfg(unix)]
    cmd.process_group(0);
    for (key, _) in std::env::vars_os() {
        if scrubbed(&key.to_string_lossy()) {
            cmd.env_remove(&key);
        }
    }
    if let Some(path) = crate::procenv::child_path() {
        cmd.env("PATH", path);
    }
    cmd.envs(crate::cli_update::native_update_env());
    for (key, value) in env.unwrap_or_default() {
        if !scrubbed(&key) {
            cmd.env(key, value);
        }
    }

    let mut child = cmd.spawn().map_err(|error| {
        format!(
            "could not start `{command}`: {error}{}",
            if resolved == command {
                " — Canopy could not find it on this machine's PATH"
            } else {
                ""
            }
        )
    })?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.start_kill();
        return Err("the brain call has no stdout".into());
    };
    let stderr = child.stderr.take();
    let process_group = child.id();

    {
        let sink = on_data.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some((bytes, truncated))) = capped_line(&mut reader, STDOUT_LINE_MAX).await
            {
                let mut text = String::from_utf8_lossy(&bytes).trim_end().to_string();
                if truncated {
                    text.push_str("\n[Canopy: brain line truncated after 1 MiB]");
                }
                if !text.trim().is_empty() && sink.send(StructuredRunnerOut::Line { text }).is_err()
                {
                    return;
                }
            }
        });
    }
    if let Some(stderr) = stderr {
        let sink = on_data.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut kept = 0usize;
            while let Ok(Some((bytes, _))) = capped_line(&mut reader, STDERR_KEEP).await {
                let text = String::from_utf8_lossy(&bytes).trim_end().to_string();
                kept = kept.saturating_add(text.len());
                if kept <= STDERR_KEEP && sink.send(StructuredRunnerOut::Stderr { text }).is_err() {
                    return;
                }
            }
        });
    }

    held.insert(
        call_id.clone(),
        Running {
            child,
            process_group,
        },
    );
    drop(held);

    // Reap the exit (or enforce the ceiling) and retire the slot.
    let ceiling = Duration::from_millis(timeout_ms.unwrap_or(CEILING_MS).min(CEILING_MS));
    let started = std::time::Instant::now();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let calls = app.state::<BrainCalls>();
            let mut held = calls.running.lock().await;
            let exit = {
                let Some(running) = held.get_mut(&call_id) else {
                    // brain_kill already took it.
                    return;
                };
                match running.child.try_wait() {
                    Ok(None) if started.elapsed() >= ceiling => Some(None),
                    Ok(None) => None,
                    Ok(Some(status)) => Some(status.code()),
                    Err(_) => Some(None),
                }
            };
            let Some(code) = exit else { continue };
            // Dropping kills the group when the ceiling (not the CLI) ended it.
            let running = held.remove(&call_id);
            drop(held);
            drop(running);
            let _ = on_data.send(StructuredRunnerOut::Exit { code });
            return;
        }
    });
    Ok(())
}

/// Stop a brain call: an aborted feature, a TS-side timeout, or an answer that
/// arrived before the CLI got round to exiting. Idempotent — killing a call
/// that already finished is not an error, because the caller cannot know
/// which of the two happened first.
#[tauri::command]
pub async fn brain_kill(
    state: tauri::State<'_, BrainCalls>,
    call_id: String,
) -> Result<(), String> {
    let running = state.running.lock().await.remove(&call_id);
    if let Some(mut running) = running {
        let _ = running.child.start_kill();
        let _ = tokio::time::timeout(Duration::from_secs(3), running.child.wait()).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_ids_are_bounded_and_pathless() {
        assert!(valid_call_id("brain-1730000000000-ab12"));
        assert!(!valid_call_id(""));
        assert!(!valid_call_id("../etc"));
        assert!(!valid_call_id(&"a".repeat(129)));
    }

    #[test]
    fn every_canopy_session_marker_is_scrubbed() {
        for key in [
            "CANOPY",
            "CANOPY_PTY",
            "CANOPY_CTX_PORT",
            "CANOPY_CTX_TOKEN",
            "CANOPY_CTX_SOCKET",
            "CANOPY_INSTANCE",
        ] {
            assert!(scrubbed(key), "{key}");
        }
        assert!(!scrubbed("PATH"));
        assert!(!scrubbed("HOME"));
    }
}

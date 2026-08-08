//! Attempt-keyed plain-pipe processes for managed structured sessions.

use std::collections::HashMap;
use std::process::Stdio;

use tauri::ipc::Channel;
use tauri::Manager;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;

use crate::winproc::NoConsoleWindow;

const STDERR_KEEP: usize = 8 * 1024;
const STDOUT_LINE_MAX: usize = 1024 * 1024;

/// Drain one line completely while retaining at most `max` bytes. Stopping at
/// the cap would leave the pipe full and deadlock the child, so oversize input
/// is consumed and represented by an explicit marker.
async fn capped_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    max: usize,
) -> std::io::Result<Option<(Vec<u8>, bool)>> {
    let mut out = Vec::with_capacity(max.min(8 * 1024));
    let mut truncated = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return if out.is_empty() && !truncated {
                Ok(None)
            } else {
                Ok(Some((out, truncated)))
            };
        }
        let take = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(available.len());
        if !truncated {
            let keep = take.min(max.saturating_sub(out.len()));
            out.extend_from_slice(&available[..keep]);
            truncated = keep < take;
        }
        let done = available.get(take.saturating_sub(1)) == Some(&b'\n');
        reader.consume(take);
        if done {
            return Ok(Some((out, truncated)));
        }
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StructuredRunnerOut {
    Line { text: String },
    Stderr { text: String },
    Exit { code: Option<i32> },
}

struct Running {
    /// None for a one-shot CLI, whose stdin was closed at spawn — see
    /// `keep_stdin` on the spawn command.
    stdin: Option<ChildStdin>,
    child: Child,
    process_group: Option<u32>,
    control_token: String,
    terminate_on_drop: bool,
}

impl Drop for Running {
    fn drop(&mut self) {
        if !self.terminate_on_drop {
            return;
        }
        #[cfg(unix)]
        if let Some(pid) = self.process_group {
            // The child starts its own process group below. Killing the group
            // keeps hooks and MCP descendants from surviving Canopy's exit.
            unsafe {
                libc::killpg(pid as libc::pid_t, libc::SIGKILL);
            }
        }
        let _ = self.child.start_kill();
    }
}

#[derive(Default)]
pub struct StructuredRunnerManager {
    running: Mutex<HashMap<String, Running>>,
}

fn valid_attempt_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// Start one attempt's CLI on plain pipes.
///
/// `keep_stdin` is whether the child keeps a writable stdin for the whole
/// session. True for a streaming CLI, whose next message is a line written to
/// it. False for a one-shot CLI, and that is not a tidiness preference — it is
/// the difference between the turn running and the turn hanging forever.
/// `codex exec` reads stdin whenever stdin is a pipe, *even when the prompt was
/// given as an argument* ("Reading additional input from stdin..."), and blocks
/// until EOF. Held open it never gets one: verified against codex-cli 0.146.1,
/// which produced no output at all and was still running after two minutes on a
/// prompt that answers in under ten seconds.
#[tauri::command]
pub async fn structured_runner_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, StructuredRunnerManager>,
    tasks: tauri::State<'_, crate::tasks::TaskStore>,
    attempt_id: String,
    control_token: String,
    command: String,
    args: Vec<String>,
    cwd: String,
    env: Option<Vec<(String, String)>>,
    keep_stdin: Option<bool>,
    on_data: Channel<StructuredRunnerOut>,
) -> Result<(), String> {
    if !valid_attempt_id(&attempt_id) {
        return Err("a structured runner requires a valid attempt id".into());
    }
    if !valid_attempt_id(&control_token) {
        return Err("a structured runner requires a valid control token".into());
    }
    let dir = std::path::Path::new(&cwd);
    if !dir.is_dir() {
        return Err(format!("structured runner cwd does not exist: {cwd}"));
    }
    let binding = tasks.authorize_structured_attempt(&attempt_id, dir)?;

    let mut held = state.running.lock().await;
    if held.contains_key(&attempt_id) {
        return Err(format!(
            "structured runner attempt is already active: {attempt_id}"
        ));
    }

    let resolved = crate::procenv::resolve_command(&command);
    let mut cmd = tokio::process::Command::new(&resolved);
    cmd.args(&args)
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd.no_console_window();
    #[cfg(unix)]
    cmd.process_group(0);

    if let Some(path) = crate::procenv::child_path() {
        cmd.env("PATH", path);
    }
    cmd.env("CANOPY", "1");
    if let Some(ctx) = app.try_state::<crate::context::ContextBridge>() {
        let mut bridge = ctx.mint_attempt(&cwd, &binding);
        let mut waited = std::time::Duration::ZERO;
        const STEP: std::time::Duration = std::time::Duration::from_millis(50);
        const CEILING: std::time::Duration = std::time::Duration::from_secs(5);
        while bridge.is_none() && waited < CEILING {
            tokio::time::sleep(STEP).await;
            waited += STEP;
            bridge = ctx.mint_attempt(&cwd, &binding);
        }
        if let Some((port, token)) = bridge {
            cmd.env("CANOPY_CTX_PORT", port.to_string());
            cmd.env("CANOPY_CTX_TOKEN", token);
        }
    }
    for (key, value) in env.unwrap_or_default() {
        cmd.env(key, value);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = crate::context::release_claims_for_attempt(&app, &attempt_id, "launch-failed");
            return Err(format!(
                "could not start `{command}`: {error}{}",
                if resolved == command {
                    " — Canopy could not find it on this machine's PATH"
                } else {
                    ""
                }
            ));
        }
    };
    let Some(stdin) = child.stdin.take() else {
        let _ = child.start_kill();
        let _ = crate::context::release_claims_for_attempt(&app, &attempt_id, "launch-failed");
        return Err("the structured runner has no stdin".into());
    };
    // Dropping the handle is what sends EOF. Closing it here rather than
    // spawning with Stdio::null() keeps one spawn path for both tiers.
    let stdin = if keep_stdin.unwrap_or(true) {
        Some(stdin)
    } else {
        drop(stdin);
        None
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.start_kill();
        let _ = crate::context::release_claims_for_attempt(&app, &attempt_id, "launch-failed");
        return Err("the structured runner has no stdout".into());
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
                    text.push_str("\n[Canopy: runner line truncated after 1 MiB]");
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
            while let Ok(Some((bytes, truncated))) = capped_line(&mut reader, STDERR_KEEP).await {
                let mut text = String::from_utf8_lossy(&bytes).trim_end().to_string();
                if truncated {
                    text.push_str("\n[Canopy: stderr line truncated]");
                }
                kept = kept.saturating_add(text.len());
                if kept <= STDERR_KEEP && sink.send(StructuredRunnerOut::Stderr { text }).is_err() {
                    return;
                }
            }
        });
    }

    held.insert(
        attempt_id.clone(),
        Running {
            stdin,
            child,
            process_group,
            control_token,
            terminate_on_drop: true,
        },
    );
    drop(held);

    // Reap natural exits and retire the attempt slot. The stdout reader cannot
    // own Child because writes and explicit kill still need the same handle.
    let watch_app = app.clone();
    let watch_attempt = attempt_id.clone();
    let sink = on_data.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let manager = watch_app.state::<StructuredRunnerManager>();
            let mut held = manager.running.lock().await;
            let exit = {
                let Some(running) = held.get_mut(&watch_attempt) else {
                    return;
                };
                match running.child.try_wait() {
                    Ok(None) => None,
                    Ok(Some(status)) => Some(status.code()),
                    Err(_) => Some(None),
                }
            };
            let Some(code) = exit else { continue };
            let running = held.remove(&watch_attempt);
            drop(held);
            drop(running);
            let _ = sink.send(StructuredRunnerOut::Exit { code });
            let _ = crate::context::release_claims_for_attempt(&watch_app, &watch_attempt, "death");
            return;
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn structured_runner_write(
    state: tauri::State<'_, StructuredRunnerManager>,
    attempt_id: String,
    control_token: String,
    line: String,
) -> Result<(), String> {
    let mut held = state.running.lock().await;
    let running = held
        .get_mut(&attempt_id)
        .ok_or_else(|| format!("structured runner attempt is not running: {attempt_id}"))?;
    if running.control_token != control_token {
        return Err("structured runner control token does not match the attempt".into());
    }
    let mut body = line;
    body.push('\n');
    // A one-shot runner has no stdin to write to: its next message is a new
    // process, not a line. Said plainly, because the alternative is a write that
    // silently goes nowhere and a turn that waits for a reply to a question the
    // CLI was never asked.
    let stdin = running.stdin.as_mut().ok_or_else(|| {
        format!("structured runner {attempt_id} takes its prompt at launch, not on stdin")
    })?;
    stdin
        .write_all(body.as_bytes())
        .await
        .map_err(|error| format!("could not reach structured runner {attempt_id}: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("could not reach structured runner {attempt_id}: {error}"))
}

#[tauri::command]
pub async fn structured_runner_kill(
    app: tauri::AppHandle,
    state: tauri::State<'_, StructuredRunnerManager>,
    attempt_id: String,
    control_token: String,
) -> Result<(), String> {
    let mut held = state.running.lock().await;
    let running = held
        .get(&attempt_id)
        .ok_or_else(|| format!("structured runner attempt is not running: {attempt_id}"))?;
    if running.control_token != control_token {
        return Err("structured runner control token does not match the attempt".into());
    }
    let mut running = held
        .remove(&attempt_id)
        .expect("structured runner was checked above");
    drop(held);
    let _ = running.child.start_kill();
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), running.child.wait()).await;
    drop(running);
    let _ = crate::context::release_claims_for_attempt(&app, &attempt_id, "death");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attempt_ids_are_bounded_and_pathless() {
        assert!(valid_attempt_id("attempt_01abc-XYZ"));
        for invalid in ["", "../attempt", "attempt/one", "attempt one"] {
            assert!(!valid_attempt_id(invalid), "{invalid:?} should be refused");
        }
    }

    #[tokio::test]
    async fn attempts_live_in_independent_slots() {
        let manager = StructuredRunnerManager::default();
        let held = manager.running.lock().await;
        assert!(held.is_empty());
    }
}

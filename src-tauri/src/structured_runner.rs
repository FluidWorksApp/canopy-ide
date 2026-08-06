//! Attempt-keyed plain-pipe processes for managed structured sessions.

use std::collections::HashMap;
use std::process::Stdio;

use tauri::ipc::Channel;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;

use crate::winproc::NoConsoleWindow;

const STDERR_KEEP: usize = 8 * 1024;

#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StructuredRunnerOut {
    Line { text: String },
    Stderr { text: String },
    Exit { code: Option<i32> },
}

struct Running {
    stdin: ChildStdin,
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
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(text)) = lines.next_line().await {
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
            let mut lines = BufReader::new(stderr).lines();
            let mut kept = 0usize;
            while let Ok(Some(text)) = lines.next_line().await {
                kept += text.len();
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
    running
        .stdin
        .write_all(body.as_bytes())
        .await
        .map_err(|error| format!("could not reach structured runner {attempt_id}: {error}"))?;
    running
        .stdin
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

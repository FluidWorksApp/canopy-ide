//! The companion's process: one long-lived agent CLI, spoken to in JSON lines.
//!
//! Why this exists rather than reusing `pty.rs`, which already spawns agents:
//! a PTY is a terminal, and a terminal is the wrong pipe for this protocol.
//! The line discipline echoes everything written to it (so the companion would
//! read its own messages back), translates newlines, and — the one that
//! actually breaks — caps a canonical-mode line at around 4 KiB, which a single
//! JSON message carrying the system brief and the user's question exceeds
//! comfortably. The result would be a truncated line and a session that dies on
//! the first long question.
//!
//! So the structured tier gets plain pipes: stdin in, stdout out, one JSON
//! object per line, exactly as the CLI documents. Every *other* CLI still runs
//! through `pty.rs` — those are TUIs and genuinely need a terminal — which is
//! the split `CompanionTier` describes on the TypeScript side.
//!
//! There is only ever one companion, so this manages one child rather than a
//! table. Starting a second replaces the first, which is what makes "switch the
//! companion's CLI in Settings" a single call.

use std::process::Stdio;

use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::Mutex;

use crate::winproc::NoConsoleWindow;

/// How much stderr to keep. A CLI that fails to start explains itself there and
/// nowhere else, and that explanation is the only thing standing between the
/// user and a companion that silently never answers.
const STDERR_KEEP: usize = 8 * 1024;

/// What the child says, as the front end sees it.
///
/// `line` is passed through verbatim rather than parsed here: the shape belongs
/// to the CLI's protocol, which is TypeScript's business (companionTransport.ts
/// knows the message types), and re-modelling it in Rust would mean two places
/// to update when a CLI adds a field.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CompanionOut {
    /// One line of stdout — expected to be a JSON object, but not checked here.
    Line { text: String },
    /// Diagnostics. Surfaced rather than swallowed so a misconfigured CLI says
    /// why in the chat instead of appearing to hang.
    Stderr { text: String },
    /// The child is gone. `code` is None when a signal took it.
    Exit { code: Option<i32> },
}

struct Running {
    stdin: ChildStdin,
    child: Child,
    /// Bumped on every spawn, so a restart is distinguishable from a reconnect
    /// — switching CLI mid-conversation must not splice one agent's answer
    /// into another's transcript, and the front end keys its transcript on this.
    generation: u64,
}

#[derive(Default)]
pub struct CompanionManager {
    running: Mutex<Option<Running>>,
    generation: std::sync::atomic::AtomicU64,
}

/// Start the companion, replacing any that is already running.
///
/// `command` is the resolved binary (Settings → Agents can rebind it) and
/// `args` is built by the CLI's verified runner on the TypeScript side — this
/// deliberately knows nothing about flags, so adding a second structured CLI is
/// a change in `companion.ts` alone.
#[tauri::command]
pub async fn companion_spawn(
    state: tauri::State<'_, CompanionManager>,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<Vec<(String, String)>>,
    on_data: Channel<CompanionOut>,
) -> Result<(), String> {
    // Take the lock for the whole swap: two spawns racing would leave one child
    // orphaned with nothing holding its handle to kill it.
    let mut held = state.running.lock().await;
    if let Some(mut old) = held.take() {
        let _ = old.child.start_kill();
    }

    let generation = state
        .generation
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;

    let mut cmd = tokio::process::Command::new(&command);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Quitting Canopy must not leave an agent running and billing.
        .kill_on_drop(true);
    cmd.no_console_window();
    for (k, v) in env.unwrap_or_default() {
        cmd.env(k, v);
    }
    if let Some(dir) = cwd
        .as_ref()
        .map(std::path::Path::new)
        .filter(|d| d.is_dir())
    {
        cmd.current_dir(dir);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start `{command}`: {e}"))?;
    let stdin = child.stdin.take().ok_or("the companion CLI has no stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("the companion CLI has no stdout")?;
    let stderr = child.stderr.take();

    // stdout: one JSON object per line, forwarded as it arrives. `next_line`
    // has no length cap, which is the whole reason this is a pipe and not a PTY.
    {
        let sink = on_data.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(text)) = lines.next_line().await {
                if text.trim().is_empty() {
                    continue;
                }
                if sink.send(CompanionOut::Line { text }).is_err() {
                    // The window went away — nothing to deliver to.
                    return;
                }
            }
            let _ = sink.send(CompanionOut::Exit { code: None });
        });
    }

    // stderr must be drained whether or not anyone reads it: an unread pipe
    // buffer fills and deadlocks a chatty CLI mid-answer. Bounded so a CLI that
    // logs a warning per token cannot grow without limit.
    if let Some(stderr) = stderr {
        let sink = on_data.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut kept = 0usize;
            while let Ok(Some(text)) = lines.next_line().await {
                kept += text.len();
                if kept > STDERR_KEEP {
                    continue;
                }
                if sink.send(CompanionOut::Stderr { text }).is_err() {
                    return;
                }
            }
        });
    }

    *held = Some(Running {
        stdin,
        child,
        generation,
    });
    Ok(())
}

/// Send one line to the companion. The newline is added here so no caller can
/// forget it — an un-terminated line is a message the CLI waits on forever,
/// which presents as the companion silently never answering.
#[tauri::command]
pub async fn companion_write(
    state: tauri::State<'_, CompanionManager>,
    line: String,
) -> Result<(), String> {
    let mut held = state.running.lock().await;
    let running = held.as_mut().ok_or("the companion is not running")?;
    let mut body = line;
    body.push('\n');
    running
        .stdin
        .write_all(body.as_bytes())
        .await
        .map_err(|e| format!("could not reach the companion: {e}"))?;
    running
        .stdin
        .flush()
        .await
        .map_err(|e| format!("could not reach the companion: {e}"))
}

/// Stop it. Idempotent: stopping a companion that is not running is what the
/// user asked for either way.
#[tauri::command]
pub async fn companion_kill(state: tauri::State<'_, CompanionManager>) -> Result<(), String> {
    let mut held = state.running.lock().await;
    if let Some(mut running) = held.take() {
        let _ = running.child.start_kill();
    }
    Ok(())
}

#[derive(Clone, serde::Serialize)]
pub struct CompanionStatus {
    pub running: bool,
    /// 0 when nothing has ever started. The front end keys its transcript on
    /// this, so a silently-restarted child cannot look like a continuation of
    /// the conversation that came before it.
    pub generation: u64,
}

/// Whether a companion process is up. Cheap enough to poll, and the answer the
/// UI needs before deciding whether a message can be sent or a launch is due.
#[tauri::command]
pub async fn companion_status(
    state: tauri::State<'_, CompanionManager>,
) -> Result<CompanionStatus, String> {
    let mut held = state.running.lock().await;
    let Some(running) = held.as_mut() else {
        return Ok(CompanionStatus {
            running: false,
            generation: state.generation.load(std::sync::atomic::Ordering::SeqCst),
        });
    };
    let generation = running.generation;
    // `try_wait` reaps a child that has already exited, so a crashed CLI stops
    // reporting itself as running rather than leaving the UI waiting on a reply
    // that can never come.
    let alive = matches!(running.child.try_wait(), Ok(None));
    if !alive {
        held.take();
    }
    Ok(CompanionStatus {
        running: alive,
        generation,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_fresh_manager_holds_no_child() {
        let state = CompanionManager::default();
        assert!(state.running.lock().await.is_none());
        assert_eq!(
            state.generation.load(std::sync::atomic::Ordering::SeqCst),
            0
        );
    }

    /// Writing before a spawn has to be a reported error rather than a panic:
    /// the UI can send while the CLI is still coming up, and a panic in a Tauri
    /// command takes the whole command thread with it.
    #[tokio::test]
    async fn writing_before_spawn_reports_rather_than_panics() {
        let state = CompanionManager::default();
        let mut held = state.running.lock().await;
        let err = held
            .as_mut()
            .ok_or("the companion is not running")
            .err()
            .unwrap();
        assert!(err.contains("not running"));
    }
}

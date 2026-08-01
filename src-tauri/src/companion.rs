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

use tauri::Manager;

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
    app: tauri::AppHandle,
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

    // A bare `claude` is not findable from a GUI process: macOS gives an app
    // launched from Finder (or from a dev server that was) a minimal PATH with
    // no /opt/homebrew/bin, so exec fails with "No such file or directory" for
    // a binary that is plainly installed. pty.rs never hits this because it
    // spawns through a login shell; this execs the binary directly, so it has
    // to resolve the name the way a login shell would.
    let resolved = crate::procenv::resolve_command(&command);
    let mut cmd = tokio::process::Command::new(&resolved);
    cmd.args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Quitting Canopy must not leave an agent running and billing.
        .kill_on_drop(true);
    cmd.no_console_window();

    // Point the companion at THIS app's context bridge, exactly as pty.rs does
    // for every terminal it spawns.
    //
    // Without it the child merely inherits whatever CANOPY_CTX_PORT happened to
    // be in the app's own environment — and a dev build launched from a Canopy
    // terminal inherits the *installed* app's port. The companion then held a
    // perfectly good MCP connection to a different, older Canopy: its tools
    // answered, its new ops came back "unknown ui op", and every project it
    // asked about belonged to the other instance. Silent, and invisible from
    // inside the session, because nothing about it looks like a wrong address.
    // Give the child the PATH a terminal would have. Resolving the binary is
    // only half of it: the CLI we start goes on to run git, node and its own
    // MCP servers, and in a GUI-launched app none of those are findable either.
    // This is the whole of "works in dev, broken in the installed build".
    if let Some(path) = crate::procenv::child_path() {
        cmd.env("PATH", path);
    }
    cmd.env("CANOPY", "1");
    if let Some(ctx) = app.try_state::<crate::context::ContextBridge>() {
        // The bridge binds its port asynchronously at startup, and the
        // companion launches from the frontend's first mount — a race the
        // companion sometimes lost. Losing it meant spawning with no
        // CANOPY_CTX_PORT at all, so every canopy_* call answered "this
        // session isn't running inside a Canopy terminal" until the app was
        // restarted (a running companion is never respawned). Wait for the
        // port instead: it arrives within milliseconds of setup, and a bounded
        // wait keeps a bridge that genuinely failed to bind from wedging the
        // spawn forever.
        let mut bridge = ctx.env();
        let mut waited = std::time::Duration::ZERO;
        const STEP: std::time::Duration = std::time::Duration::from_millis(50);
        const CEILING: std::time::Duration = std::time::Duration::from_secs(5);
        while bridge.is_none() && waited < CEILING {
            tokio::time::sleep(STEP).await;
            waited += STEP;
            bridge = ctx.env();
        }
        if let Some((port, token)) = bridge {
            cmd.env("CANOPY_CTX_PORT", port.to_string());
            cmd.env("CANOPY_CTX_TOKEN", token);
        }
    }

    // Caller-supplied env last, so it always wins.
    for (k, v) in env.unwrap_or_default() {
        cmd.env(k, v);
    }
    // The companion runs in a directory of its own, never inside a project.
    //
    // A CLI started inside a repo auto-loads that repo's CLAUDE.md — rules
    // written for a coding agent working in that one checkout ("don't start
    // servers", "the API is at :6001", a task-queue discipline). The companion
    // is not that agent, and inheriting one project's house rules while
    // answering about eight of them is worse than having none: it followed
    // them, and refused to start a server it had been asked for.
    //
    // Every project still reaches it through --add-dir, which grants access
    // without importing instructions.
    let home = companion_home();
    let _ = std::fs::create_dir_all(&home);
    match cwd
        .as_ref()
        .map(std::path::Path::new)
        .filter(|d| d.is_dir())
    {
        Some(dir) => {
            cmd.current_dir(dir);
        }
        None if home.is_dir() => {
            cmd.current_dir(&home);
        }
        None => {}
    }

    let mut child = cmd.spawn().map_err(|e| {
        format!(
            "could not start `{command}`: {e}{}",
            if resolved == command {
                " — Canopy could not find it on this machine's PATH. Install it, or set its \
                     path in Settings → Agents."
            } else {
                ""
            }
        )
    })?;
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

/// The companion's own corner of `~/.canopy`, for what it has learned about
/// the user (companionMemory.ts).
///
/// Deliberately NOT a general read/write-a-file pair. A generic one would hand
/// the webview an arbitrary-file-write primitive, and the companion needs
/// exactly one directory — so the name is validated to a bare filename and
/// joined under a fixed root. A caller that wants to escape it has nothing to
/// work with: no separators, no `..`, no absolute paths.
/// `~/.canopy/companion` — the companion's own directory, and the cwd it runs
/// in so that no project's CLAUDE.md is auto-discovered.
fn companion_home() -> std::path::PathBuf {
    let home = std::env::var("CANOPY_COMPANION_HOME")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    std::path::Path::new(&home)
        .join(".canopy")
        .join("companion")
}

fn companion_store_path(name: &str) -> Result<std::path::PathBuf, String> {
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
        || name.starts_with('.')
        || name.contains("..")
    {
        return Err(format!("{name:?} is not a companion store file"));
    }
    Ok(companion_home().join(name))
}

#[tauri::command]
pub fn companion_store_read(name: String) -> Result<Option<String>, String> {
    let path = companion_store_path(&name)?;
    match std::fs::read_to_string(&path) {
        Ok(body) => Ok(Some(body)),
        // Nothing written yet is not a failure — it is a companion that has
        // not learned anything about you so far.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{} could not be read: {e}", path.display())),
    }
}

/// Written whole, through a temp file and a rename. `~/.canopy` holds the one
/// store Canopy cannot rebuild, and a crash between truncate and write would
/// lose everything the companion knows rather than one fact.
#[tauri::command]
pub fn companion_store_write(name: String, body: String) -> Result<(), String> {
    let path = companion_store_path(&name)?;
    let parent = path.parent().ok_or("bad store path")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = parent.join(format!(".{name}.canopy-{}", std::process::id()));
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("{} could not be written: {e}", path.display())
    })
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

    #[test]
    fn the_store_refuses_anything_that_is_not_a_bare_filename() {
        // This is the whole security story of the pair: the companion needs one
        // directory, so nothing that could name a file outside it is accepted.
        for bad in [
            "",
            "../evil",
            "a/b",
            "/etc/passwd",
            ".hidden",
            "memory.json/../../x",
            "..",
        ] {
            assert!(
                companion_store_path(bad).is_err(),
                "{bad:?} should be refused"
            );
        }
        assert!(companion_store_path("memory.json").is_ok());
        assert!(companion_store_path("notes-2.json").is_ok());
    }

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

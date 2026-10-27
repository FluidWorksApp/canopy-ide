//! Proof receipts: the workspace re-runs a project's checks itself.
//!
//! An agent's "all tests pass" is a claim about work it produced; the receipt
//! engine (src/receipts/) wants evidence the agent could not have produced.
//! So the check runs here — a separate process the agent's terminal does not
//! own, with Canopy's env scrubbed so no hook fires and no context bridge is
//! reachable — and the raw exit code and output tail go back to the renderer.
//!
//! Neither existing runner fits. `process_capture::output` keeps the *head* of
//! the output and has no timeout; a test runner prints its verdict last and a
//! hung suite must end as "timed out", never as a failure (a killed run is not
//! evidence the code is wrong). `brain_call` streams lines to a channel for a
//! judgment; a check is one result. The Linux workspace implements the same
//! command in packages/remote-host/native.mjs.

use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::Semaphore;

use crate::winproc::NoConsoleWindow;

/// Default and ceiling for one check. A full suite can legitimately take
/// minutes; past the ceiling it is reported as timed out.
const DEFAULT_TIMEOUT_MS: u64 = 5 * 60 * 1000;
const CEILING_MS: u64 = 20 * 60 * 1000;
/// What each stream keeps. Checks keep the tail (the summary line is last);
/// a `git diff` asks for the head.
const DEFAULT_KEEP: usize = 64 * 1024;
const MAX_KEEP: usize = 1024 * 1024;
/// Two checks at once: two `cargo test`s in one checkout fight over the
/// target lock, and verification must never compete with the person's own
/// builds for the whole machine.
const CONCURRENCY: usize = 2;

fn slots() -> &'static Semaphore {
    static SLOTS: OnceLock<Semaphore> = OnceLock::new();
    SLOTS.get_or_init(|| Semaphore::new(CONCURRENCY))
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckRun {
    /// None when the process was killed (timeout) or died on a signal.
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub timed_out: bool,
    pub duration_ms: u64,
    /// The program could not be started at all (not installed, bad cwd).
    pub spawn_error: Option<String>,
}

/// Keep the first or the last `max` bytes of a stream while draining all of
/// it, so the child never blocks on a full pipe.
async fn drain<R: AsyncRead + Unpin>(mut reader: R, max: usize, tail: bool) -> (Vec<u8>, bool) {
    let mut kept: Vec<u8> = Vec::with_capacity(max.min(16 * 1024));
    let mut buf = [0_u8; 16 * 1024];
    let mut truncated = false;
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                if tail {
                    kept.extend_from_slice(&buf[..read]);
                    // Trim in batches, not per read, so a chatty suite costs
                    // amortised O(n) rather than a memmove per chunk.
                    if kept.len() > max * 2 {
                        let cut = kept.len() - max;
                        kept.drain(..cut);
                        truncated = true;
                    }
                } else {
                    let take = read.min(max.saturating_sub(kept.len()));
                    kept.extend_from_slice(&buf[..take]);
                    truncated |= take < read;
                }
            }
        }
    }
    if tail && kept.len() > max {
        let cut = kept.len() - max;
        kept.drain(..cut);
        truncated = true;
    }
    (kept, truncated)
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Run one check to completion (or its timeout) and report what happened.
/// A non-zero exit is a result, never an `Err`: the caller needs the output
/// of a failing suite more than of a passing one.
pub async fn run_check(
    cwd: &str,
    argv: &[String],
    timeout_ms: Option<u64>,
    keep: Option<usize>,
    head: bool,
) -> Result<CheckRun, String> {
    let Some(program) = argv.first().filter(|p| !p.trim().is_empty()) else {
        return Err("a check needs a command".into());
    };
    if argv.len() > 256 || argv.iter().any(|a| a.len() > 16 * 1024 || a.contains('\0')) {
        return Err("check command is too long".into());
    }
    let dir = std::path::Path::new(cwd);
    if !dir.is_dir() {
        return Err(format!("check directory does not exist: {cwd}"));
    }
    let keep = keep.unwrap_or(DEFAULT_KEEP).clamp(1024, MAX_KEEP);
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(CEILING_MS));
    let _slot = slots()
        .acquire()
        .await
        .map_err(|_| "check runner closed".to_string())?;

    let resolved = crate::procenv::resolve_command(program);
    // Windows: `npm`, `pnpm`, `yarn` are .cmd shims CreateProcess will not
    // find by bare name, so go through cmd the way a terminal would.
    #[cfg(windows)]
    let mut cmd = {
        // %ComSpec% names cmd.exe wherever Windows put it.
        let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        let mut c = tokio::process::Command::new(shell);
        c.arg("/C").arg(&resolved).args(&argv[1..]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = tokio::process::Command::new(&resolved);
        c.args(&argv[1..]);
        c
    };
    cmd.current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd.no_console_window();
    // Own process group, so a timeout takes the whole tree (npm → vitest →
    // workers) rather than orphaning the runners under the IDE.
    #[cfg(unix)]
    cmd.process_group(0);
    // Same rule as brain.rs: anything CANOPY* would make the check look like
    // one of Canopy's agent sessions (hooks, turn snapshots, the bridge).
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("CANOPY") {
            cmd.env_remove(&key);
        }
    }
    if let Some(path) = crate::procenv::child_path() {
        cmd.env("PATH", path);
    }
    // Non-interactive, uncoloured, never watching: CI=1 is what every runner
    // we parse keys "run once and exit" (and plain output) on.
    cmd.env("CI", "1")
        .env("NO_COLOR", "1")
        .env("FORCE_COLOR", "0")
        .env("GIT_TERMINAL_PROMPT", "0");

    let started = Instant::now();
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            return Ok(CheckRun {
                code: None,
                stdout: String::new(),
                stderr: String::new(),
                stdout_truncated: false,
                stderr_truncated: false,
                timed_out: false,
                duration_ms: 0,
                spawn_error: Some(format!("could not start `{program}`: {error}")),
            })
        }
    };
    let group = child.id();
    let stdout = child.stdout.take().ok_or("check stdout was not piped")?;
    let stderr = child.stderr.take().ok_or("check stderr was not piped")?;
    let tail = !head;
    let out_task = tokio::spawn(drain(stdout, keep, tail));
    let err_task = tokio::spawn(drain(stderr, keep, tail));

    let (code, timed_out) = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => (status.code(), false),
        Ok(Err(_)) => (None, false),
        Err(_) => {
            #[cfg(unix)]
            if let Some(pid) = group {
                unsafe {
                    libc::killpg(pid as libc::pid_t, libc::SIGKILL);
                }
            }
            #[cfg(not(unix))]
            let _ = group;
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(3), child.wait()).await;
            (None, true)
        }
    };
    // A grandchild that kept the pipe open (a watcher, a dev server a test
    // started) would hold the drains forever. The check is over once its
    // leader exits, so whatever is left in its group goes too; the grace is
    // for a helper that escaped the group.
    #[cfg(unix)]
    if !timed_out {
        if let Some(pid) = group {
            unsafe {
                libc::killpg(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
    let grace = Duration::from_secs(5);
    let (stdout, stdout_truncated) = tokio::time::timeout(grace, out_task)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    let (stderr, stderr_truncated) = tokio::time::timeout(grace, err_task)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    Ok(CheckRun {
        code,
        stdout: text(&stdout),
        stderr: text(&stderr),
        stdout_truncated,
        stderr_truncated,
        timed_out,
        duration_ms: started.elapsed().as_millis() as u64,
        spawn_error: None,
    })
}

/// Run one verification command outside every agent's terminal.
#[tauri::command]
pub async fn receipt_run_check(
    cwd: String,
    argv: Vec<String>,
    timeout_ms: Option<u64>,
    keep_bytes: Option<usize>,
    head: Option<bool>,
) -> Result<CheckRun, String> {
    run_check(&cwd, &argv, timeout_ms, keep_bytes, head.unwrap_or(false)).await
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn reports_exit_code_and_output_of_a_failing_check() {
        let run = rt()
            .block_on(run_check(
                "/",
                &argv(&["/bin/sh", "-c", "echo out; echo err >&2; exit 3"]),
                Some(10_000),
                None,
                false,
            ))
            .unwrap();
        assert_eq!(run.code, Some(3));
        assert_eq!(run.stdout.trim(), "out");
        assert_eq!(run.stderr.trim(), "err");
        assert!(!run.timed_out);
        assert!(run.spawn_error.is_none());
    }

    #[test]
    fn a_hung_check_is_timed_out_not_failed() {
        let run = rt()
            .block_on(run_check(
                "/",
                &argv(&["/bin/sh", "-c", "sleep 30 & wait"]),
                Some(300),
                None,
                false,
            ))
            .unwrap();
        assert!(run.timed_out);
        assert_eq!(run.code, None);
        assert!(run.duration_ms < 10_000);
    }

    #[test]
    fn keeps_the_tail_by_default_and_the_head_on_request() {
        let script = "i=0; while [ $i -lt 5000 ]; do echo line$i; i=$((i+1)); done";
        let tail = rt()
            .block_on(run_check(
                "/",
                &argv(&["/bin/sh", "-c", script]),
                Some(10_000),
                Some(1024),
                false,
            ))
            .unwrap();
        assert!(tail.stdout_truncated);
        assert!(tail.stdout.trim_end().ends_with("line4999"));
        assert!(tail.stdout.len() <= 1024);
        let head = rt()
            .block_on(run_check(
                "/",
                &argv(&["/bin/sh", "-c", script]),
                Some(10_000),
                Some(1024),
                true,
            ))
            .unwrap();
        assert!(head.stdout.starts_with("line0"));
        assert!(head.stdout_truncated);
    }

    #[test]
    fn a_missing_program_is_a_spawn_error_not_a_failure() {
        let run = rt()
            .block_on(run_check(
                "/",
                &argv(&["/definitely/not/a/program"]),
                Some(1000),
                None,
                false,
            ))
            .unwrap();
        assert!(run.spawn_error.is_some());
        assert_eq!(run.code, None);
    }

    #[test]
    fn rejects_a_missing_directory_and_empty_argv() {
        assert!(rt()
            .block_on(run_check(
                "/no/such/dir",
                &argv(&["true"]),
                None,
                None,
                false
            ))
            .is_err());
        assert!(rt()
            .block_on(run_check("/", &[], None, None, false))
            .is_err());
    }
}

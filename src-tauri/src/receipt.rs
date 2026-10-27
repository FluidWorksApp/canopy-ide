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
    env: &[(String, String)],
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
    // What the isolated copy asks for (a build cache shared with the live
    // checkout). Never a CANOPY* key: the scrub above is the point.
    for (key, value) in env {
        if !key.is_empty()
            && !key.starts_with("CANOPY")
            && !key.contains('=')
            && !key.contains('\0')
        {
            cmd.env(key, value);
        }
    }

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
    env: Option<Vec<(String, String)>>,
) -> Result<CheckRun, String> {
    run_check(
        &cwd,
        &argv,
        timeout_ms,
        keep_bytes,
        head.unwrap_or(false),
        &env.unwrap_or_default(),
    )
    .await
}

// ------------------------------------------------------------- isolation
//
// Checks never run in the live checkout. The next turn of an agent sharing
// that checkout would edit files under a running test suite (or the suite
// would read half of the next turn), so a receipt runs against a throwaway
// export of exactly the tree it is about: the turn's end snapshot when there
// is one, else the working tree written through a temporary index (tracked
// plus untracked, ignored files left out — the same picture turn rollback
// takes). The copy lives under the checkout's own git directory
// (`<git-dir>/canopy-receipts/<id>`), which no snapshot, `git status` or
// file watcher looks into, and which a Linux workspace's path scope allows.
//
// It is an export (`read-tree` + `checkout-index`), not `git worktree add`:
// a registered worktree would show up in every worktree list Canopy draws.
// Ignored dependency folders (node_modules, a virtualenv) are linked in from
// the live checkout — reinstalling them per receipt would take longer than
// the checks — and a Cargo project shares the live target directory, where
// the copy's crates build under their own hashed names.

/// Ignored folders worth linking into a copy: installed dependencies.
const LINK_NAMES: &[&str] = &["node_modules", ".venv", "venv", "bower_components"];
const MAX_LINKS: usize = 400;
/// A copy older than this is an orphan (the app quit mid-check): swept the
/// next time a copy is made in that repository.
const ORPHAN_SECS: u64 = 6 * 60 * 60;
const COPIES_DIR: &str = "canopy-receipts";

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IsolatedTree {
    /// The throwaway copy the checks run in (its top level).
    pub dir: String,
    /// The tree it holds: the snapshot commit asked for, or the tree id of
    /// the working tree as it was read.
    pub tree: String,
    /// Dependency folders linked in from the live checkout (repo-relative).
    pub linked: Vec<String>,
    /// Environment every check in the copy should get.
    pub env: Vec<(String, String)>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A snapshot id from the renderer: hex only, so it can never be read as an
/// option or a revision expression.
fn valid_rev(rev: &str) -> bool {
    (7..=64).contains(&rev.len()) && rev.chars().all(|c| c.is_ascii_hexdigit())
}

#[cfg(unix)]
fn link_dir(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

/// A junction: unlike a directory symlink it needs no privilege.
#[cfg(windows)]
fn link_dir(target: &std::path::Path, link: &std::path::Path) -> std::io::Result<()> {
    let shell = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
    let status = std::process::Command::new(shell)
        .arg("/C")
        .arg("mklink")
        .arg("/J")
        .arg(link)
        .arg(target)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .no_console_window()
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(std::io::Error::other("mklink /J failed"))
    }
}

/// Remove a link without following it.
fn unlink(path: &std::path::Path) {
    if std::fs::remove_file(path).is_err() {
        // A Windows junction is a directory entry.
        let _ = std::fs::remove_dir(path);
    }
}

fn links_manifest(copy: &std::path::Path) -> std::path::PathBuf {
    let mut name = copy.as_os_str().to_owned();
    name.push(".links");
    std::path::PathBuf::from(name)
}

/// Delete one copy: its links first (so nothing can follow them into the
/// live checkout), then the files.
fn remove_copy(copy: &std::path::Path) {
    let manifest = links_manifest(copy);
    if let Ok(list) = std::fs::read_to_string(&manifest) {
        for rel in list.lines().filter(|l| !l.is_empty()) {
            unlink(&copy.join(rel));
        }
    }
    let _ = std::fs::remove_dir_all(copy);
    let _ = std::fs::remove_file(&manifest);
    let mut index = copy.as_os_str().to_owned();
    index.push(".index");
    let _ = std::fs::remove_file(std::path::PathBuf::from(&index));
    index.push(".lock");
    let _ = std::fs::remove_file(std::path::PathBuf::from(index));
}

fn sweep_orphans(base: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if !meta.is_dir() {
            continue;
        }
        let old = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .is_some_and(|age| age.as_secs() > ORPHAN_SECS);
        if old {
            remove_copy(&path);
        }
    }
}

pub fn isolate(cwd: &str, rev: Option<&str>) -> Result<IsolatedTree, String> {
    use crate::turn_rollback::{git, run};
    use std::path::{Path, PathBuf};
    let top = crate::turn_rollback::toplevel(Path::new(cwd))
        .ok_or_else(|| format!("{cwd} is not in a git checkout"))?;
    let git_dir = PathBuf::from(run(git(&top).args(["rev-parse", "--absolute-git-dir"]))?);
    let base = git_dir.join(COPIES_DIR);
    std::fs::create_dir_all(&base).map_err(|e| format!("could not make a copy folder: {e}"))?;
    sweep_orphans(&base);
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let copy = base.join(format!("{}-{}-{n}", std::process::id(), now_secs()));
    let tree = match rev {
        Some(r) if valid_rev(r) => r.to_string(),
        Some(_) => return Err("not a snapshot id".into()),
        None => crate::turn_rollback::write_worktree_tree(&top)?,
    };
    let mut index = copy.as_os_str().to_owned();
    index.push(".index");
    let index = PathBuf::from(index);
    let exported = (|| -> Result<(), String> {
        std::fs::create_dir_all(&copy).map_err(|e| e.to_string())?;
        run(git(&top)
            .env("GIT_INDEX_FILE", &index)
            .args(["read-tree", &tree]))?;
        // Forward slashes: git takes them on every platform, and the prefix
        // must end in a separator to mean "into this folder".
        let prefix = format!("{}/", copy.to_string_lossy().replace('\\', "/"));
        run(git(&top)
            .env("GIT_INDEX_FILE", &index)
            .args(["checkout-index", "-a", "-f", "--prefix"])
            .arg(&prefix))?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&index);
    if let Err(e) = exported {
        remove_copy(&copy);
        return Err(format!("could not copy the checkout: {e}"));
    }

    let ignored = run(git(&top).args([
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
    ]))
    .unwrap_or_default();
    let mut linked = Vec::new();
    for line in ignored.lines() {
        if linked.len() >= MAX_LINKS {
            break;
        }
        let rel = line.trim().trim_end_matches('/');
        let name = rel.rsplit('/').next().unwrap_or(rel);
        if rel.is_empty() || !LINK_NAMES.contains(&name) || rel.split('/').any(|c| c == "..") {
            continue;
        }
        let source = top.join(rel);
        let target = copy.join(rel);
        // Only beside something the copy has: a dependency folder of a
        // package that is not in the tree has nothing to serve.
        if !source.is_dir() || !target.parent().is_some_and(|p| p.is_dir()) || target.exists() {
            continue;
        }
        if link_dir(&source, &target).is_ok() {
            linked.push(rel.to_string());
        }
    }
    let _ = std::fs::write(links_manifest(&copy), linked.join("\n"));

    let mut env = Vec::new();
    let live_target = top.join("target");
    if top.join("Cargo.toml").is_file()
        && live_target.is_dir()
        && std::env::var_os("CARGO_TARGET_DIR").is_none()
    {
        env.push((
            "CARGO_TARGET_DIR".to_string(),
            live_target.to_string_lossy().into_owned(),
        ));
    }
    Ok(IsolatedTree {
        dir: copy.to_string_lossy().into_owned(),
        tree,
        linked,
        env,
    })
}

/// Delete a copy `isolate` made. Refuses anything that is not one.
pub fn release(dir: &str) -> Result<(), String> {
    let path = std::path::Path::new(dir);
    let in_copies = path
        .parent()
        .and_then(|p| p.file_name())
        .is_some_and(|n| n == COPIES_DIR);
    if !in_copies || !path.is_absolute() || dir.contains("..") {
        return Err("not a receipt copy".into());
    }
    remove_copy(path);
    Ok(())
}

/// Make a throwaway copy of the checkout at `rev` (a turn snapshot) or of the
/// working tree as it is now, for a receipt's checks to run in.
#[tauri::command]
pub async fn receipt_isolate(cwd: String, rev: Option<String>) -> Result<IsolatedTree, String> {
    tokio::task::spawn_blocking(move || isolate(&cwd, rev.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// Delete a copy once its checks are done.
#[tauri::command]
pub async fn receipt_release(dir: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || release(&dir))
        .await
        .map_err(|e| e.to_string())?
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
                &[],
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
                &[],
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
                &[],
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
                &[],
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
                &[],
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
                false,
                &[]
            ))
            .is_err());
        assert!(rt()
            .block_on(run_check("/", &[], None, None, false, &[]))
            .is_err());
    }

    fn git_in(dir: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgSign=false",
            ])
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn scratch_repo(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "canopy-receipt-{tag}-{}-{}",
            std::process::id(),
            now_secs()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        git_in(&dir, &["init", "-q"]);
        std::fs::write(dir.join(".gitignore"), "node_modules/\n").unwrap();
        std::fs::write(dir.join("a.txt"), "committed\n").unwrap();
        git_in(&dir, &["add", "-A"]);
        git_in(&dir, &["commit", "-q", "-m", "init"]);
        dir
    }

    #[test]
    fn isolates_the_working_tree_with_untracked_files_and_linked_dependencies() {
        let repo = scratch_repo("tree");
        std::fs::write(repo.join("a.txt"), "edited\n").unwrap();
        std::fs::write(repo.join("new.txt"), "untracked\n").unwrap();
        std::fs::create_dir_all(repo.join("node_modules/dep")).unwrap();
        std::fs::write(repo.join("node_modules/dep/index.js"), "x").unwrap();
        let copy = isolate(repo.to_str().unwrap(), None).unwrap();
        let dir = std::path::PathBuf::from(&copy.dir);
        assert!(dir.starts_with(repo.join(".git/canopy-receipts")));
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "edited\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("new.txt")).unwrap(),
            "untracked\n"
        );
        assert_eq!(copy.linked, vec!["node_modules".to_string()]);
        assert_eq!(
            std::fs::read_to_string(dir.join("node_modules/dep/index.js")).unwrap(),
            "x"
        );
        // The live checkout is not touched: same status as before.
        let status = git_in(&repo, &["status", "--porcelain"]);
        assert!(status.contains("a.txt") && status.contains("new.txt"));
        assert!(!status.contains("canopy-receipts"));
        // Editing the live tree after the copy leaves the copy as it was.
        std::fs::write(repo.join("a.txt"), "next turn\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("a.txt")).unwrap(),
            "edited\n"
        );
        release(&copy.dir).unwrap();
        assert!(!dir.exists());
        // Releasing never follows the link into the live dependencies.
        assert!(repo.join("node_modules/dep/index.js").is_file());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn isolates_a_snapshot_commit_and_refuses_other_paths() {
        let repo = scratch_repo("rev");
        let head = git_in(&repo, &["rev-parse", "HEAD"]);
        std::fs::write(repo.join("a.txt"), "later\n").unwrap();
        let copy = isolate(repo.to_str().unwrap(), Some(&head)).unwrap();
        assert_eq!(copy.tree, head);
        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&copy.dir).join("a.txt")).unwrap(),
            "committed\n"
        );
        assert!(isolate(repo.to_str().unwrap(), Some("--output=x")).is_err());
        assert!(release(repo.to_str().unwrap()).is_err());
        assert!(repo.join("a.txt").is_file());
        release(&copy.dir).unwrap();
        let _ = std::fs::remove_dir_all(&repo);
    }
}

//! Workspace registry + scoped filesystem access + file watching.
//!
//! Multi-project: any number of workspace roots can be registered in one window.
//! Every fs command validates its path against the registered roots (scoped
//! allowlist). Each root gets a notify watcher; external changes are emitted as
//! `fs:change` events which drive the tree refresh and the diff-first workflow.

use crate::winproc::NoConsoleWindow;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct WorkspaceManager {
    roots: Mutex<Vec<PathBuf>>,
    watchers: Mutex<HashMap<PathBuf, RecommendedWatcher>>,
}

#[derive(Serialize, Clone)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize, Clone)]
pub struct FsStatEntry {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Serialize, Clone)]
pub struct FsChange {
    pub root: String,
    pub paths: Vec<String>,
    pub kind: String,
    pub overflow: bool,
}

/// "Whatever git would say about this root just changed." One event, one
/// debounce, one place — rather than a `setInterval` per panel.
#[derive(Serialize, Clone)]
pub struct GitChange {
    pub root: String,
}

// ---------- git state: watched, not polled ----------

/// One quiet-period timer serves both filesystem and git state. A package
/// install can produce tens of thousands of notify callbacks; retaining one
/// task and one bounded, deduplicated path set per root keeps that burst from
/// becoming renderer IPC and timer pressure.
const WATCH_SETTLE_MS: u64 = 150;
const MAX_PENDING_WATCH_PATHS: usize = 2_048;
const MAX_PENDING_WATCH_BYTES: usize = 512 * 1024;

struct PendingWatch {
    paths: HashSet<String>,
    path_bytes: usize,
    kind: Option<String>,
    overflow: bool,
    git_dirty: bool,
    last_change: Instant,
}

impl PendingWatch {
    fn new() -> Self {
        Self {
            paths: HashSet::new(),
            path_bytes: 0,
            kind: None,
            overflow: false,
            git_dirty: false,
            last_change: Instant::now(),
        }
    }

    fn push(&mut self, path: String, kind: &str) {
        self.kind = Some(match self.kind.take() {
            None => kind.to_string(),
            Some(current) if current == kind => current,
            Some(_) => "other".to_string(),
        });
        if self.paths.contains(&path) || self.overflow {
            return;
        }
        if self.paths.len() >= MAX_PENDING_WATCH_PATHS
            || self.path_bytes.saturating_add(path.len()) > MAX_PENDING_WATCH_BYTES
        {
            self.overflow = true;
            return;
        }
        self.path_bytes += path.len();
        self.paths.insert(path);
    }
}

fn watch_pending() -> &'static Mutex<HashMap<String, PendingWatch>> {
    static PENDING: OnceLock<Mutex<HashMap<String, PendingWatch>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Does this path mean git's own state moved?
///
/// A commit, a stage, a branch switch or a fetch lands as writes inside `.git`
/// — which is exactly what the file-change feed filters out, so this is the
/// only place they can be noticed. Three kinds of churn are skipped: object
/// writes (an agent's blob is not a state change any panel can see), reflogs
/// (they follow the ref that already fired), and `.lock` files — git writes
/// `index.lock` before `index`, and reacting to the lock means asking a repo
/// that is mid-write, and racing the very write we are watching.
pub(crate) fn touches_git_state(path: &str) -> bool {
    // notify yields native separators. Normalize only for matching so Windows
    // `.git` and `node_modules` churn gets the same filtering as Unix.
    let normalized = path.replace('\\', "/");
    let Some((_, rest)) = normalized.rsplit_once("/.git/") else {
        return false;
    };
    // A linked worktree's HEAD and index live at
    // `<main>/.git/worktrees/<name>/HEAD`; strip that middle so the same match
    // covers worktrees, which is most of Canopy's usage.
    let rest = rest
        .strip_prefix("worktrees/")
        .and_then(|r| r.split_once('/'))
        .map(|(_, r)| r)
        .unwrap_or(rest);
    if rest.ends_with(".lock") || rest.starts_with("objects/") || rest.starts_with("logs/") {
        return false;
    }
    rest.starts_with("refs/")
        || rest.starts_with("rebase-merge/")
        || rest.starts_with("rebase-apply/")
        || matches!(
            rest,
            "HEAD"
                | "index"
                | "packed-refs"
                | "FETCH_HEAD"
                | "ORIG_HEAD"
                | "MERGE_HEAD"
                | "REBASE_HEAD"
                | "CHERRY_PICK_HEAD"
                | "REVERT_HEAD"
                | "BISECT_LOG"
        )
}

fn ignored_watch_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    normalized
        .split('/')
        .any(|component| component == "node_modules" || component == ".git")
}

/// Merge a native callback into the root's single bounded pending batch. Only
/// the caller that creates the entry creates a timer; later callbacks merely
/// move its quiet-period boundary and add deduplicated paths.
fn queue_watch_event<R: tauri::Runtime>(
    app: &AppHandle<R>,
    root: &str,
    paths: Vec<String>,
    kind: &str,
    git_dirty: bool,
) {
    let start_timer = {
        let mut pending = watch_pending().lock().unwrap();
        let start = !pending.contains_key(root);
        let batch = pending
            .entry(root.to_string())
            .or_insert_with(PendingWatch::new);
        batch.last_change = Instant::now();
        batch.git_dirty |= git_dirty;
        for path in paths {
            batch.push(path, kind);
        }
        start
    };
    if !start_timer {
        return;
    }

    let app = app.clone();
    let root = root.to_string();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(WATCH_SETTLE_MS)).await;
            let batch = {
                let mut pending = watch_pending().lock().unwrap();
                let Some(batch) = pending.get(&root) else {
                    return;
                };
                if batch.last_change.elapsed() < Duration::from_millis(WATCH_SETTLE_MS) {
                    None
                } else {
                    pending.remove(&root)
                }
            };
            let Some(batch) = batch else {
                continue;
            };

            if batch.git_dirty {
                let _ = app.emit("git:change", GitChange { root: root.clone() });
            }
            if !batch.paths.is_empty() || batch.overflow {
                let mut paths: Vec<String> = batch.paths.into_iter().collect();
                paths.sort_unstable();
                let _ = app.emit(
                    "fs:change",
                    FsChange {
                        root: root.clone(),
                        paths,
                        kind: batch.kind.unwrap_or_else(|| "other".into()),
                        overflow: batch.overflow,
                    },
                );
            }
            return;
        }
    });
}

/// Test and call-site shorthand for git-only changes.
fn pulse_git<R: tauri::Runtime>(app: &AppHandle<R>, root: &str) {
    queue_watch_event(app, root, Vec::new(), "other", true);
}

pub(crate) fn check_scope(
    state: &State<'_, WorkspaceManager>,
    path: &Path,
) -> Result<PathBuf, String> {
    // Canonicalize the deepest existing ancestor so new files still validate.
    let mut existing = path.to_path_buf();
    let mut suffix = PathBuf::new();
    while !existing.exists() {
        let Some(name) = existing.file_name().map(|n| n.to_owned()) else {
            return Err("invalid path".into());
        };
        // Prepend the component WITHOUT join("") on the first pass: joining an
        // empty PathBuf appends a trailing separator, so a single new file came
        // out as "name/" and every create/rename wrote to a directory path,
        // failing with ENOENT. Build the suffix slash-free instead.
        suffix = if suffix.as_os_str().is_empty() {
            PathBuf::from(&name)
        } else {
            Path::new(&name).join(&suffix)
        };
        existing = existing
            .parent()
            .ok_or_else(|| "invalid path".to_string())?
            .to_path_buf();
    }
    let mut canonical = existing.canonicalize().map_err(|e| e.to_string())?;
    // join("") would append a trailing slash and break file reads with ENOTDIR
    if !suffix.as_os_str().is_empty() {
        canonical = canonical.join(suffix);
    }
    let roots = state.roots.lock().unwrap();
    if roots.iter().any(|root| canonical.starts_with(root)) {
        Ok(canonical)
    } else {
        Err(format!(
            "path outside workspace scope: {}",
            canonical.display()
        ))
    }
}

#[tauri::command]
pub async fn workspace_add(
    app: AppHandle,
    state: State<'_, WorkspaceManager>,
    path: String,
) -> Result<String, String> {
    let canonical = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !canonical.is_dir() {
        return Err("not a directory".into());
    }
    {
        let mut roots = state.roots.lock().unwrap();
        if !roots.contains(&canonical) {
            roots.push(canonical.clone());
        }
    }
    // Watch the root; emit fs:change for external edits (diff-first workflow).
    let root_str = canonical.to_string_lossy().to_string();
    let emit_root = root_str.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            let kind = match event.kind {
                notify::EventKind::Create(_) => "create",
                notify::EventKind::Modify(_) => "modify",
                notify::EventKind::Remove(_) => "remove",
                _ => "other",
            };
            let touched: Vec<String> = event
                .paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                .collect();
            let paths: Vec<String> = touched
                .iter()
                // node_modules / .git churn would flood the UI
                .filter(|p| !ignored_watch_path(p))
                .cloned()
                .collect();
            // The panels that used to poll git want both halves: a write to a
            // tracked file changes what `status` says, and a write inside .git
            // is a commit, a stage or a branch switch. Both now share one
            // bounded per-root coalescer and one quiet-period task.
            let git_dirty = !paths.is_empty() || touched.iter().any(|p| touches_git_state(p));
            if !paths.is_empty() || git_dirty {
                queue_watch_event(&app, &emit_root, paths, kind, git_dirty);
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&canonical, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    // A linked worktree keeps no state of its own: its `.git` is a file, and
    // HEAD, the index and every ref live in the main checkout's `.git`, outside
    // this root. Without a second watch there, a branch switch or a commit made
    // in a worktree — which is how Canopy is normally used — would be invisible
    // to the watcher, and the panels would be back to polling for it.
    if let Some(git_dir) = crate::git::common_dir(&canonical) {
        if !git_dir.starts_with(&canonical) {
            // Best-effort: a repo we can't watch just means git state settles a
            // beat later, when a worktree file next changes.
            let _ = watcher.watch(&git_dir, RecursiveMode::Recursive);
        }
    }
    state.watchers.lock().unwrap().insert(canonical, watcher);
    Ok(root_str)
}

#[tauri::command]
pub async fn workspace_remove(
    state: State<'_, WorkspaceManager>,
    path: String,
) -> Result<(), String> {
    let canonical = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    state.roots.lock().unwrap().retain(|r| r != &canonical);
    // Dropping the watcher stops it.
    state.watchers.lock().unwrap().remove(&canonical);
    watch_pending()
        .lock()
        .unwrap()
        .remove(&canonical.to_string_lossy().to_string());
    Ok(())
}

// Stays sync: an in-memory Vec read with no IO, so it never blocks. (Async
// commands that borrow State must return a Result; this returns a bare Vec, and
// there is no reason to wrap it just to move a lock-and-clone off the main thread.)
#[tauri::command]
pub fn workspace_list(state: State<'_, WorkspaceManager>) -> Vec<String> {
    state
        .roots
        .lock()
        .unwrap()
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

/// The registered roots as paths, for the callers that need to re-check a path
/// against them away from `State` (cleanup.rs validates on a worker thread).
pub(crate) fn roots_of(state: &State<'_, WorkspaceManager>) -> Vec<PathBuf> {
    state.roots.lock().unwrap().clone()
}

const READ_DIR_MAX_ENTRIES: usize = 4096;
const READ_DIR_MAX_BYTES: usize = 2 * 1024 * 1024;

fn read_dir_bounded(
    dir: &Path,
    max_entries: usize,
    max_bytes: usize,
) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    let mut retained = 0usize;
    for result in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let Ok(entry) = result else { continue };
        let is_dir = entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false);
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path().to_string_lossy().to_string();
        let charge = name.len().saturating_add(path.len()).saturating_add(32);
        if entries.len() >= max_entries || retained.saturating_add(charge) > max_bytes {
            return Err(format!(
                "directory listing exceeds its {max_entries}-entry/{max_bytes}-byte limit"
            ));
        }
        retained += charge;
        entries.push(DirEntry { name, path, is_dir });
    }
    Ok(entries)
}

#[tauri::command]
pub async fn fs_read_dir(
    state: State<'_, WorkspaceManager>,
    path: String,
) -> Result<Vec<DirEntry>, String> {
    let dir = check_scope(&state, Path::new(&path))?;
    let mut entries =
        crate::blocking::io(|| read_dir_bounded(&dir, READ_DIR_MAX_ENTRIES, READ_DIR_MAX_BYTES))?;
    entries.sort_by(|a, b| {
        (b.is_dir, a.name.to_lowercase())
            .partial_cmp(&(a.is_dir, b.name.to_lowercase()))
            .unwrap()
            .then(std::cmp::Ordering::Equal)
    });
    Ok(entries)
}

/// Nothing the WebView can do with a file this size is worth the copy: the
/// bytes are serialized across IPC and then held in the renderer's heap. The
/// frontend applies far tighter, per-viewer limits before it ever asks (see
/// fileOpen.ts); this is the backstop that keeps *any* caller — the LSP file
/// provider, an agent tool — from moving a DVD image into the WebView.
const MAX_READ_BYTES: u64 = 512 * 1024 * 1024;

fn read_file_capped(source: std::fs::File, requested_max: Option<u64>) -> Result<Vec<u8>, String> {
    let max = requested_max.unwrap_or(MAX_READ_BYTES).min(MAX_READ_BYTES);
    let initial_len = source.metadata().map_err(|e| e.to_string())?.len();
    if initial_len > max {
        return Err(format!(
            "file is too large to load ({initial_len} bytes; limit {max})"
        ));
    }

    // Read through the already-open handle and stop after max+1 bytes. A path
    // replacement cannot switch this handle underneath us, and concurrent file
    // growth can allocate at most one byte past the caller's limit before it is
    // rejected. This closes the old metadata(path) -> read(path) race that could
    // allocate the generic 512 MiB backstop for an 8 MiB frontend request.
    let mut bytes = Vec::new();
    source
        .take(max.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > max {
        return Err(format!(
            "file grew past the read limit ({} bytes; limit {max})",
            bytes.len()
        ));
    }
    Ok(bytes)
}

/// Returns raw file bytes (no base64) via tauri::ipc::Response.
#[tauri::command]
pub async fn fs_read_file(
    state: State<'_, WorkspaceManager>,
    path: String,
    max_bytes: Option<u64>,
) -> Result<tauri::ipc::Response, String> {
    let file = check_scope(&state, Path::new(&path))?;
    let source = std::fs::File::open(&file).map_err(|e| e.to_string())?;
    let opened_identity =
        same_file::Handle::from_file(source.try_clone().map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    // Re-authorize after open and compare the live path with the stable handle.
    // If an agent replaces a scoped path with a symlink (or swaps it back) in
    // the check-to-open window, either scope validation or identity comparison
    // fails. The bytes always come from the already-validated handle.
    let current = check_scope(&state, Path::new(&path))?;
    let current_identity = same_file::Handle::from_path(&current).map_err(|e| e.to_string())?;
    if opened_identity != current_identity {
        return Err("file changed while opening; retry the read".into());
    }
    let bytes = read_file_capped(source, max_bytes)?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn fs_write_file(
    state: State<'_, WorkspaceManager>,
    path: String,
    content: String,
) -> Result<(), String> {
    let file = check_scope(&state, Path::new(&path))?;
    std::fs::write(&file, content).map_err(|e| e.to_string())
}

#[derive(Serialize, Clone)]
pub struct GitEntry {
    pub status: String,
    pub path: String,
}

#[derive(Serialize, Clone, Default)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub entries: Vec<GitEntry>,
}

/// Git status for a workspace root (ignored + untracked + modified), absolute
/// paths. Uses the git CLI — no libgit2 dependency, works with any git setup.
/// A `git` invocation that never takes optional locks.
///
/// `git status` refreshes the index as a side effect, which takes index.lock.
/// This is polled per repo every few seconds, so without this it intermittently
/// breaks any *other* git write happening at that moment — the user's own
/// commit in a terminal, or an agent's — with "Unable to create index.lock".
/// Read-only callers have no business taking that lock.
fn git_ro(dir: &Path) -> std::process::Command {
    let mut cmd = std::process::Command::new("git");
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd.arg("-C").arg(dir);
    cmd.no_console_window();
    cmd
}

#[tauri::command]
pub async fn git_status(
    state: State<'_, WorkspaceManager>,
    path: String,
) -> Result<GitStatus, String> {
    let dir = check_scope(&state, Path::new(&path))?;
    // Three subprocesses. Without this they park a tokio worker each for the
    // whole life of the child -- ahead of PTY writes and MCP stdio pumps -- and
    // this is the most-called git path in the app: FileTree and StatusBar both
    // run it on every `git:change`. `blocking::io` is what git.rs already uses
    // ~15 times for exactly this; fsx.rs had none.
    crate::blocking::io(move || {
        let top = match crate::process_capture::output(
            git_ro(&dir).args(["rev-parse", "--show-toplevel"]),
            crate::process_capture::DEFAULT_STREAM_MAX,
        ) {
            Ok(out) if out.status.success() => {
                PathBuf::from(String::from_utf8_lossy(&out.stdout).trim().to_string())
            }
            _ => return Ok(GitStatus::default()),
        };
        let mut branch_command = git_ro(&dir);
        branch_command.args(["rev-parse", "--abbrev-ref", "HEAD"]);
        let branch = crate::process_capture::output(
            &mut branch_command,
            crate::process_capture::DEFAULT_STREAM_MAX,
        )
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
        let out = crate::process_capture::output(
            git_ro(&dir).args(["status", "--porcelain", "-z", "--ignored"]),
            crate::process_capture::DEFAULT_STREAM_MAX,
        )?;
        crate::process_capture::reject_truncated(&out, "workspace git status")?;
        let raw = String::from_utf8_lossy(&out.stdout);
        let mut entries = Vec::new();
        let mut parts = raw.split('\0').peekable();
        while let Some(part) = parts.next() {
            if part.len() < 4 {
                continue;
            }
            let status = part[..2].to_string();
            let rel = &part[3..];
            // rename/copy entries carry a second NUL-separated origin path
            if status.starts_with('R') || status.starts_with('C') {
                parts.next();
            }
            entries.push(GitEntry {
                status,
                path: top.join(rel).to_string_lossy().to_string(),
            });
        }
        Ok(GitStatus {
            is_repo: true,
            branch,
            entries,
        })
    })
}

/// Content of a file at git HEAD — the baseline for proper diffs of modified
/// files. None when the file is untracked or the dir isn't a repo.
#[tauri::command]
pub async fn git_head_content(
    state: State<'_, WorkspaceManager>,
    path: String,
) -> Result<Option<String>, String> {
    let file = check_scope(&state, Path::new(&path))?;
    let parent = file.parent().ok_or("no parent dir")?;
    let top = match crate::process_capture::output(
        git_ro(parent).args(["rev-parse", "--show-toplevel"]),
        crate::process_capture::DEFAULT_STREAM_MAX,
    ) {
        Ok(out) if out.status.success() => {
            PathBuf::from(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
        _ => return Ok(None),
    };
    let rel = match file.strip_prefix(&top) {
        Ok(r) => r.to_string_lossy().to_string(),
        Err(_) => return Ok(None),
    };
    let out = crate::process_capture::output(
        git_ro(&top).arg("show").arg(format!("HEAD:{rel}")),
        crate::process_capture::DEFAULT_STREAM_MAX,
    )?;
    crate::process_capture::reject_truncated(&out, "git HEAD content")?;
    if out.status.success() {
        Ok(Some(String::from_utf8_lossy(&out.stdout).to_string()))
    } else {
        Ok(None) // untracked / new file
    }
}

fn store_path() -> Result<std::path::PathBuf, String> {
    // A selftest run gets a disposable workspace: it must not open the user's
    // projects to test itself, nor leave its scratch one behind. See selftest.rs.
    if let Some(dir) = crate::selftest::store_dir() {
        return Ok(dir.join("projects.json"));
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "no home dir".to_string())?;
    let dir = std::path::PathBuf::from(home).join(".canopy");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("projects.json"))
}

/// Persisted workspace state: projects, their labeled component dirs, and
/// which projects are open. Schema is owned by the frontend.
#[tauri::command]
pub async fn store_load() -> Result<String, String> {
    let path = store_path()?;
    if !path.exists() {
        return Ok("null".into());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn store_save(data: String) -> Result<(), String> {
    let path = store_path()?;
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

// Workspace/project export + import. These deliberately sit outside the
// workspace scope check: the path comes from a native save/open dialog the user
// just drove, which is the consent. They're kept narrow (JSON text only, no
// directory traversal helpers) rather than exposing general unscoped file IO.

#[tauri::command]
pub async fn workspace_export(path: String, data: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
        return Err("workspace files must be .json".into());
    }
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn workspace_import(path: String) -> Result<String, String> {
    let path = PathBuf::from(&path);
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
        return Err("workspace files must be .json".into());
    }
    // Bounded: a workspace file is a small config, not a payload.
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 4_000_000 {
        return Err("not a workspace file (too large)".into());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

// ---------- search (quick open + find in files) ----------

/// Directories never worth walking. Keeping this in Rust means the walk stops
/// at the boundary instead of the frontend filtering a huge result set.
const SKIP_DIRS: &[&str] = &[
    ".git",
    // Dot-directories that are caches or vendored trees. Named explicitly
    // rather than caught by a leading-dot rule, which also swallowed .github,
    // .vscode and every agent config directory.
    ".svn",
    ".hg",
    ".direnv",
    ".gradle",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".terraform",
    ".yarn",
    ".pnpm-store",
    ".parcel-cache",
    ".sass-cache",
    ".nuxt",
    ".output",
    ".svelte-kit",
    ".astro",
    ".vercel",
    ".serverless",
    ".tox",
    // More generated trees that the old blanket dot-skip excluded for free.
    ".dart_tool",
    ".gradle-cache",
    ".stack-work",
    ".history",
    ".rustup",
    ".nx",
    ".angular",
    ".docusaurus",
    ".expo",
    ".metro",
    ".dvc",
    ".ipynb_checkpoints",
    ".ccls-cache",
    ".clangd",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".venv",
    "venv",
    "__pycache__",
    ".turbo",
    ".cache",
    "vendor",
    "Pods",
    ".idea",
];

/// Canopy's own directory inside a project — screenshots a micro-task was
/// briefed with, the briefs themselves. Projects gitignore it, and they are
/// right to: it is generated. But it is generated *by the user's own actions in
/// this app*, so it is the one ignored tree that has to stay findable, and it
/// is walked separately below for exactly that reason.
const CANOPY_DIR: &str = ".canopy";

/// Deepest directory worth descending into. Not a correctness bound — the
/// ignore rules do that work — but a floor under pathological trees.
const MAX_DEPTH: usize = 12;

/// Files under `dir`, honouring .gitignore.
///
/// Ignored means ignored: a build output, a vendored dependency, a downloaded
/// model, another checkout parked under .claude/worktrees. Quick-open and
/// find-in-files used to walk all of it, filtered only by a hardcoded list of
/// directory names, which caught node_modules and target and nothing a project
/// ignored for its own reasons. The list stays as the fallback for a tree with
/// no ignore file at all.
///
/// The cost, stated plainly: a gitignored file is now unfindable here even when
/// it is the one you want — `.env` being the case that comes up. That is the
/// same trade every editor's quick-open makes, and the escape hatch is the same
/// one: open it by path.
fn walk(dir: &Path, out: &mut Vec<PathBuf>, limit: usize) {
    if out.len() >= limit {
        return;
    }
    let mut builder = ignore::WalkBuilder::new(dir);
    builder
        // Dotfiles are files. Skipping every name starting with '.' meant
        // .env, .gitignore, .prettierrc and every CI config were invisible to
        // quick-open AND to find-in-files — searchable content the editor
        // could open perfectly well once you got to it another way.
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        // A component can be a subdirectory of the repo that ignores it, so the
        // ignore files above the walk root count too.
        .parents(true)
        // ...and a directory with a .gitignore but no .git yet — a fresh
        // project, a template — means it just as much as a repo does.
        .require_git(false)
        .follow_links(false)
        .max_depth(Some(MAX_DEPTH))
        .filter_entry(|e| {
            if !e.file_type().is_some_and(|t| t.is_dir()) {
                return true;
            }
            let name = e.file_name().to_string_lossy().to_string();
            // .canopy is dropped here and walked whole afterwards, so that it
            // arrives exactly once whether or not the project ignores it.
            name != CANOPY_DIR && !SKIP_DIRS.contains(&name.as_str())
        });
    for entry in builder.build().flatten() {
        if out.len() >= limit {
            return;
        }
        if entry.file_type().is_some_and(|t| t.is_file()) {
            out.push(entry.into_path());
        }
    }
    walk_plain(&dir.join(CANOPY_DIR), out, limit, 0);
}

/// Everything under `dir`, ignore files disregarded. Only Canopy's own
/// directory is walked this way.
fn walk_plain(dir: &Path, out: &mut Vec<PathBuf>, limit: usize, depth: usize) {
    if out.len() >= limit || depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if out.len() >= limit {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            walk_plain(&path, out, limit, depth + 1);
        } else {
            out.push(path);
        }
    }
}

/// Flat file list under the given roots — the corpus for quick-open (Cmd+P).
/// Bounded so a huge tree can't balloon the heap or the IPC payload.
#[tauri::command]
pub async fn fs_list_files(
    state: State<'_, WorkspaceManager>,
    roots: Vec<String>,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let limit = limit.unwrap_or(20_000);
    let mut out: Vec<PathBuf> = Vec::new();
    for root in roots {
        let dir = check_scope(&state, Path::new(&root))?;
        walk(&dir, &mut out, limit);
    }
    Ok(out
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect())
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct FileSnapshot {
    pub path: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

fn snapshot_files(paths: Vec<PathBuf>) -> Vec<FileSnapshot> {
    paths
        .into_iter()
        .filter_map(|path| {
            let meta = std::fs::metadata(&path).ok()?;
            Some(FileSnapshot {
                path: path.to_string_lossy().to_string(),
                size: meta.len(),
                modified_ms: meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64),
            })
        })
        .collect()
}

/// One bounded native walk with the metadata needed for a repository
/// fingerprint. Project setup used to issue one renderer -> Rust round trip
/// per directory and then another per file; a normal multi-repository project
/// could still be in that preflight when the webview watchdog reloaded it.
#[tauri::command]
pub async fn fs_snapshot_files(
    state: State<'_, WorkspaceManager>,
    roots: Vec<String>,
    limit: Option<usize>,
) -> Result<Vec<FileSnapshot>, String> {
    let limit = limit.unwrap_or(20_000).min(20_000);
    let mut paths = Vec::new();
    for root in roots {
        let dir = check_scope(&state, Path::new(&root))?;
        walk(&dir, &mut paths, limit);
        if paths.len() >= limit {
            break;
        }
    }
    Ok(snapshot_files(paths))
}

#[derive(Serialize, Clone)]
pub struct SearchHit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

/// Literal, case-insensitive content search across the roots (Cmd+Shift+F).
/// Binary files are skipped; results are capped.
#[tauri::command]
pub async fn fs_search(
    state: State<'_, WorkspaceManager>,
    roots: Vec<String>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let limit = limit.unwrap_or(300);
    let needle = query.to_lowercase();
    let mut files: Vec<PathBuf> = Vec::new();
    for root in roots {
        let dir = check_scope(&state, Path::new(&root))?;
        walk(&dir, &mut files, 20_000);
    }

    let mut hits = Vec::new();
    for file in files {
        if hits.len() >= limit {
            break;
        }
        // Skip anything too big to be worth scanning inline.
        if std::fs::metadata(&file)
            .map(|m| m.len() > 2_000_000)
            .unwrap_or(true)
        {
            continue;
        }
        let Ok(content) = std::fs::read(&file) else {
            continue;
        };
        if content.contains(&0) {
            continue; // binary
        }
        let Ok(text) = String::from_utf8(content) else {
            continue;
        };
        for (i, line) in text.lines().enumerate() {
            if hits.len() >= limit {
                break;
            }
            if line.to_lowercase().contains(&needle) {
                hits.push(SearchHit {
                    path: file.to_string_lossy().to_string(),
                    line: i as u32 + 1,
                    text: line.chars().take(200).collect(),
                });
            }
        }
    }
    Ok(hits)
}

#[tauri::command]
pub async fn fs_stat(
    state: State<'_, WorkspaceManager>,
    path: String,
) -> Result<serde_json::Value, String> {
    let file = check_scope(&state, Path::new(&path))?;
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "is_dir": meta.is_dir(),
        "size": meta.len(),
        "modified_ms": meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64),
    }))
}

const STAT_BATCH_MAX_PATHS: usize = 256;
const STAT_BATCH_MAX_PATH_BYTES: usize = 256 * 1024;

/// Resolve and stat a set of journal/diff paths in one IPC operation. Scope is
/// checked for every input before any metadata is returned; files that vanish
/// between scope resolution and metadata lookup are omitted so one editor
/// save cannot invalidate the rest of the batch.
#[tauri::command]
pub async fn fs_stat_many(
    state: State<'_, WorkspaceManager>,
    paths: Vec<String>,
) -> Result<Vec<FsStatEntry>, String> {
    if paths.len() > STAT_BATCH_MAX_PATHS {
        return Err(format!(
            "metadata batch exceeds its {STAT_BATCH_MAX_PATHS}-path limit"
        ));
    }
    let path_bytes = paths
        .iter()
        .try_fold(0usize, |total, path| total.checked_add(path.len()))
        .ok_or_else(|| "metadata batch path bytes overflowed".to_string())?;
    if path_bytes > STAT_BATCH_MAX_PATH_BYTES {
        return Err(format!(
            "metadata batch exceeds its {STAT_BATCH_MAX_PATH_BYTES}-byte path limit"
        ));
    }

    let mut seen = HashSet::new();
    let mut scoped = Vec::with_capacity(paths.len());
    for path in paths {
        if !seen.insert(path.clone()) {
            continue;
        }
        let file = check_scope(&state, Path::new(&path))?;
        scoped.push((path, file));
    }

    Ok(crate::blocking::io(move || {
        scoped
            .into_iter()
            .filter_map(|(path, file)| {
                let meta = std::fs::metadata(file).ok()?;
                Some(FsStatEntry {
                    path,
                    is_dir: meta.is_dir(),
                    size: meta.len(),
                    modified_ms: meta
                        .modified()
                        .ok()
                        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|duration| duration.as_millis() as u64),
                })
            })
            .collect()
    }))
}

// ---------- file management (context menu) ----------

/// Create an empty file. Fails if it already exists rather than truncating —
/// "New File" must never silently destroy an existing one.
#[tauri::command]
pub async fn fs_create_file(
    state: State<'_, WorkspaceManager>,
    path: String,
) -> Result<String, String> {
    let target = check_scope(&state, Path::new(&path))?;
    if target.exists() {
        return Err(format!("{} already exists", target.display()));
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&target, "").map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn fs_create_dir(
    state: State<'_, WorkspaceManager>,
    path: String,
) -> Result<String, String> {
    let target = check_scope(&state, Path::new(&path))?;
    if target.exists() {
        return Err(format!("{} already exists", target.display()));
    }
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

/// Rename/move within the workspace. Both ends are scope-checked, so a rename
/// can't be used to write outside the opened project.
#[tauri::command]
pub async fn fs_rename(
    state: State<'_, WorkspaceManager>,
    from: String,
    to: String,
) -> Result<String, String> {
    let src = check_scope(&state, Path::new(&from))?;
    let dst = check_scope(&state, Path::new(&to))?;
    if dst.exists() {
        return Err(format!("{} already exists", dst.display()));
    }
    std::fs::rename(&src, &dst).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

/// Move to the OS trash rather than unlinking. A file tree delete button is one
/// misclick away from losing work that may not be committed; the trash makes it
/// recoverable, which `std::fs::remove_*` never is.
#[tauri::command]
pub async fn fs_trash(state: State<'_, WorkspaceManager>, path: String) -> Result<(), String> {
    let target = check_scope(&state, Path::new(&path))?;
    trash::delete(&target).map_err(|e| e.to_string())
}

/// Show the file in the OS file manager.
#[tauri::command]
pub async fn fs_reveal(state: State<'_, WorkspaceManager>, path: String) -> Result<(), String> {
    let target = check_scope(&state, Path::new(&path))?;
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg("-R").arg(&target);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = std::process::Command::new("explorer");
        c.arg(format!("/select,{}", target.display()));
        c
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(target.parent().unwrap_or(&target));
        c
    };
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Duplicate a file or directory next to itself.
#[tauri::command]
pub async fn fs_duplicate(
    state: State<'_, WorkspaceManager>,
    path: String,
) -> Result<String, String> {
    let src = check_scope(&state, Path::new(&path))?;
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = src
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let parent = src.parent().ok_or("no parent dir")?;
    // copy, copy 2, copy 3 … so repeated duplication doesn't collide
    let mut candidate = parent.join(format!("{stem} copy{ext}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = parent.join(format!("{stem} copy {n}{ext}"));
        n += 1;
    }
    if src.is_dir() {
        copy_dir(&src, &candidate)?;
    } else {
        std::fs::copy(&src, &candidate).map_err(|e| e.to_string())?;
    }
    Ok(candidate.to_string_lossy().to_string())
}

fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
        let to = dst.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    /// The other half of replacing the polls: a burst has to arrive as one
    /// event. A commit writes five files inside `.git` in a few milliseconds,
    /// and one refresh per write would be worse than the 5s poll it replaced —
    /// several `git status` runs against a repo that is still mid-commit.
    #[test]
    fn a_burst_of_writes_is_one_event_once_it_settles() {
        use tauri::Listener;
        let app = tauri::test::mock_app();
        let seen = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = seen.clone();
        app.handle().listen("git:change", move |_| {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        });

        let root = "/w/repo";
        for _ in 0..5 {
            pulse_git(app.handle(), root);
        }
        // Long enough for every one of the five to have fired had they not
        // superseded each other.
        std::thread::sleep(std::time::Duration::from_millis(WATCH_SETTLE_MS * 5));
        assert_eq!(seen.load(std::sync::atomic::Ordering::SeqCst), 1);

        // And the next burst is still heard: the generation supersedes, it
        // doesn't latch.
        pulse_git(app.handle(), root);
        std::thread::sleep(std::time::Duration::from_millis(WATCH_SETTLE_MS * 5));
        assert_eq!(seen.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn watcher_batch_deduplicates_and_has_item_and_byte_backstops() {
        let mut batch = PendingWatch::new();
        batch.push("/w/repo/src/main.rs".into(), "modify");
        batch.push("/w/repo/src/main.rs".into(), "modify");
        assert_eq!(batch.paths.len(), 1);
        assert_eq!(batch.kind.as_deref(), Some("modify"));

        batch.push("/w/repo/src/new.rs".into(), "create");
        assert_eq!(batch.kind.as_deref(), Some("other"));
        for i in 0..=MAX_PENDING_WATCH_PATHS {
            batch.push(format!("/w/repo/generated/{i}.js"), "modify");
        }
        assert!(batch.overflow);
        assert!(batch.paths.len() <= MAX_PENDING_WATCH_PATHS);
        assert!(batch.path_bytes <= MAX_PENDING_WATCH_BYTES);
    }

    /// What the panels stopped polling for. Everything a commit, a stage, a
    /// switch or a fetch writes has to be in the first list, or the git panel
    /// goes stale until someone touches a file; everything git writes *in
    /// passing* has to be in the second, or a single `git gc` re-runs status a
    /// thousand times.
    #[test]
    fn git_state_is_noticed_and_gits_own_churn_is_not() {
        for p in [
            "/w/repo/.git/HEAD",
            "/w/repo/.git/index",
            "/w/repo/.git/refs/heads/main",
            "/w/repo/.git/packed-refs",
            "/w/repo/.git/MERGE_HEAD",
            "/w/repo/.git/FETCH_HEAD",
            "/w/repo/.git/rebase-merge/done",
            // A linked worktree's own HEAD, in the main checkout's .git.
            "/w/repo/.git/worktrees/feature/HEAD",
            "/w/repo/.git/worktrees/feature/index",
            r"C:\w\repo\.git\HEAD",
            r"C:\w\repo\.git\worktrees\feature\index",
        ] {
            assert!(touches_git_state(p), "should have noticed {p}");
        }
        assert!(ignored_watch_path(r"C:\w\repo\node_modules\pkg\index.js"));
        assert!(ignored_watch_path(r"C:\w\repo\node_modules"));
        assert!(ignored_watch_path(r"C:\w\repo\.git\objects\ab\cd"));
        assert!(ignored_watch_path(r"C:\w\repo\.git"));
        assert!(!ignored_watch_path(r"C:\w\repo\src\main.rs"));

        for p in [
            // The lock is written *before* the file it guards: reacting to it
            // means asking a repo that is still mid-write.
            "/w/repo/.git/index.lock",
            "/w/repo/.git/refs/heads/main.lock",
            "/w/repo/.git/objects/ab/cdef0123",
            "/w/repo/.git/objects/pack/pack-1.idx",
            "/w/repo/.git/logs/HEAD",
            "/w/repo/.git/worktrees/feature/index.lock",
            // Ordinary files are the *other* signal (fs:change), not this one.
            "/w/repo/src/main.rs",
            "/w/repo/.gitignore",
        ] {
            assert!(!touches_git_state(p), "should have ignored {p}");
        }
    }

    /// The corpus behind quick-open, find-in-files and SpotSearch's file and
    /// content sources. What it holds is what those three can find.
    #[test]
    fn the_corpus_is_what_git_tracks_plus_canopys_own_directory() {
        let root = std::env::temp_dir().join(format!("canopy-walk-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        write(
            &root.join(".gitignore"),
            "dist/\nsecret.txt\n.canopy/\nnode_modules/\n",
        );
        write(&root.join("src/main.rs"), "fn main() {}");
        write(&root.join(".env"), "KEY=1");
        write(&root.join("dist/app.js"), "built");
        write(&root.join("secret.txt"), "shhh");
        write(&root.join("node_modules/pkg/index.js"), "dep");
        write(&root.join(".git/config"), "[core]");
        // Canopy's own: a screenshot a micro-task was briefed with. Ignored by
        // the project, and findable anyway — the user made it from in here.
        write(&root.join(".canopy/spot/brief-1700.md"), "the brief");

        let mut out = Vec::new();
        walk(&root, &mut out, 1000);
        let names: Vec<String> = out
            .iter()
            .map(|p| {
                p.strip_prefix(&root)
                    .unwrap_or(p)
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        let has = |s: &str| names.iter().any(|n| n == s);

        assert!(has("src/main.rs"));
        // Dotfiles are files: a tracked .env, .gitignore, CI config stay
        // findable. Only *ignored* content goes.
        assert!(has(".env"));
        assert!(has(".gitignore"));
        assert!(has(".canopy/spot/brief-1700.md"));

        assert!(!has("dist/app.js"), "gitignored build output");
        assert!(!has("secret.txt"), "gitignored file");
        assert!(!has("node_modules/pkg/index.js"), "gitignored dependency");
        assert!(!has(".git/config"), "git's own directory");
        // And exactly once, whether or not .canopy is ignored.
        assert_eq!(
            names.iter().filter(|n| n.starts_with(".canopy/")).count(),
            1
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_tree_with_no_ignore_file_still_stops_at_the_generated_directories() {
        let root = std::env::temp_dir().join(format!("canopy-walk-plain-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        write(&root.join("index.js"), "app");
        write(&root.join("node_modules/pkg/index.js"), "dep");
        write(&root.join("target/debug/thing"), "built");

        let mut out = Vec::new();
        walk(&root, &mut out, 1000);
        let names: Vec<String> = out
            .iter()
            .map(|p| p.strip_prefix(&root).unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(names, vec!["index.js".to_string()]);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn file_snapshots_carry_fingerprint_metadata_without_reading_contents() {
        let root = std::env::temp_dir().join(format!("canopy-snapshot-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let file = root.join("src/main.ts");
        write(&file, "export {};");

        let snapshots = snapshot_files(vec![file.clone(), root.join("missing")]);
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].path, file.to_string_lossy());
        assert_eq!(snapshots[0].size, 10);
        assert!(snapshots[0].modified_ms.is_some());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn directory_enumeration_refuses_to_retain_past_its_item_budget() {
        let root = std::env::temp_dir().join(format!("canopy-capped-dir-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        for name in ["a", "b", "c"] {
            write(&root.join(name), name);
        }
        let error = match read_dir_bounded(&root, 2, usize::MAX) {
            Ok(_) => panic!("directory enumeration should have exceeded the entry limit"),
            Err(error) => error,
        };
        assert!(error.contains("2-entry"));
        assert_eq!(read_dir_bounded(&root, 3, usize::MAX).unwrap().len(), 3);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn native_file_reader_obeys_the_caller_limit_before_full_allocation() {
        let root = std::env::temp_dir().join(format!("canopy-capped-read-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let file = root.join("payload.bin");
        write(&file, "0123456789");

        let open = || std::fs::File::open(&file).unwrap();
        assert_eq!(read_file_capped(open(), Some(10)).unwrap(), b"0123456789");
        let error = read_file_capped(open(), Some(8)).unwrap_err();
        assert!(error.contains("limit 8"));
        assert_eq!(read_file_capped(open(), Some(u64::MAX)).unwrap().len(), 10);

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn open_file_identity_detects_path_replacement() {
        let root =
            std::env::temp_dir().join(format!("canopy-file-identity-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let path = root.join("payload.bin");
        let old = root.join("opened.bin");
        write(&path, "authorized");
        let opened = std::fs::File::open(&path).unwrap();
        std::fs::rename(&path, &old).unwrap();
        write(&path, "replacement");

        let opened = same_file::Handle::from_file(opened).unwrap();
        let current = same_file::Handle::from_path(&path).unwrap();
        assert_ne!(opened, current);

        std::fs::remove_dir_all(&root).ok();
    }
}

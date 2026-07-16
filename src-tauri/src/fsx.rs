//! Workspace registry + scoped filesystem access + file watching.
//!
//! Multi-project: any number of workspace roots can be registered in one window.
//! Every fs command validates its path against the registered roots (scoped
//! allowlist). Each root gets a notify watcher; external changes are emitted as
//! `fs:change` events which drive the tree refresh and the diff-first workflow.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
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
pub struct FsChange {
    pub root: String,
    pub paths: Vec<String>,
    pub kind: String,
}

pub(crate) fn check_scope(state: &State<'_, WorkspaceManager>, path: &Path) -> Result<PathBuf, String> {
    // Canonicalize the deepest existing ancestor so new files still validate.
    let mut existing = path.to_path_buf();
    let mut suffix = PathBuf::new();
    while !existing.exists() {
        let Some(name) = existing.file_name().map(|n| n.to_owned()) else {
            return Err("invalid path".into());
        };
        suffix = PathBuf::from(&name).join(suffix);
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
        Err(format!("path outside workspace scope: {}", canonical.display()))
    }
}

#[tauri::command]
pub fn workspace_add(
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
            let paths: Vec<String> = event
                .paths
                .iter()
                .map(|p| p.to_string_lossy().to_string())
                // node_modules / .git churn would flood the UI
                .filter(|p| !p.contains("/node_modules/") && !p.contains("/.git/"))
                .collect();
            if !paths.is_empty() {
                let _ = app.emit("fs:change", FsChange {
                    root: emit_root.clone(),
                    paths,
                    kind: kind.into(),
                });
            }
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(&canonical, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    state.watchers.lock().unwrap().insert(canonical, watcher);
    Ok(root_str)
}

#[tauri::command]
pub fn workspace_remove(state: State<'_, WorkspaceManager>, path: String) -> Result<(), String> {
    let canonical = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    state.roots.lock().unwrap().retain(|r| r != &canonical);
    // Dropping the watcher stops it.
    state.watchers.lock().unwrap().remove(&canonical);
    Ok(())
}

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

#[tauri::command]
pub fn fs_read_dir(
    state: State<'_, WorkspaceManager>,
    path: String,
) -> Result<Vec<DirEntry>, String> {
    let dir = check_scope(&state, Path::new(&path))?;
    let mut entries: Vec<DirEntry> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| {
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            DirEntry {
                name: e.file_name().to_string_lossy().to_string(),
                path: e.path().to_string_lossy().to_string(),
                is_dir,
            }
        })
        .collect();
    entries.sort_by(|a, b| (b.is_dir, a.name.to_lowercase()).partial_cmp(&(a.is_dir, b.name.to_lowercase())).unwrap().then(std::cmp::Ordering::Equal));
    Ok(entries)
}

/// Returns raw file bytes (no base64) via tauri::ipc::Response.
#[tauri::command]
pub fn fs_read_file(
    state: State<'_, WorkspaceManager>,
    path: String,
) -> Result<tauri::ipc::Response, String> {
    let file = check_scope(&state, Path::new(&path))?;
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn fs_write_file(
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
    cmd
}

#[tauri::command]
pub fn git_status(state: State<'_, WorkspaceManager>, path: String) -> Result<GitStatus, String> {
    let dir = check_scope(&state, Path::new(&path))?;
    let top = match git_ro(&dir)
        .args(["rev-parse", "--show-toplevel"])
        .output()
    {
        Ok(out) if out.status.success() => {
            PathBuf::from(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
        _ => return Ok(GitStatus::default()),
    };
    let branch = git_ro(&dir)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let out = git_ro(&dir)
        .args(["status", "--porcelain", "-z", "--ignored"])
        .output()
        .map_err(|e| e.to_string())?;
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
}

/// Content of a file at git HEAD — the baseline for proper diffs of modified
/// files. None when the file is untracked or the dir isn't a repo.
#[tauri::command]
pub fn git_head_content(
    state: State<'_, WorkspaceManager>,
    path: String,
) -> Result<Option<String>, String> {
    let file = check_scope(&state, Path::new(&path))?;
    let parent = file.parent().ok_or("no parent dir")?;
    let top = match git_ro(parent)
        .args(["rev-parse", "--show-toplevel"])
        .output()
    {
        Ok(out) if out.status.success() => {
            PathBuf::from(String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
        _ => return Ok(None),
    };
    let rel = match file.strip_prefix(&top) {
        Ok(r) => r.to_string_lossy().to_string(),
        Err(_) => return Ok(None),
    };
    let out = git_ro(&top)
        .arg("show")
        .arg(format!("HEAD:{rel}"))
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(Some(String::from_utf8_lossy(&out.stdout).to_string()))
    } else {
        Ok(None) // untracked / new file
    }
}

fn store_path() -> Result<std::path::PathBuf, String> {
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
pub fn store_load() -> Result<String, String> {
    let path = store_path()?;
    if !path.exists() {
        return Ok("null".into());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_save(data: String) -> Result<(), String> {
    let path = store_path()?;
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

// Workspace/project export + import. These deliberately sit outside the
// workspace scope check: the path comes from a native save/open dialog the user
// just drove, which is the consent. They're kept narrow (JSON text only, no
// directory traversal helpers) rather than exposing general unscoped file IO.

#[tauri::command]
pub fn workspace_export(path: String, data: String) -> Result<(), String> {
    let path = PathBuf::from(&path);
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
        return Err("workspace files must be .json".into());
    }
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn workspace_import(path: String) -> Result<String, String> {
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

fn walk(dir: &Path, out: &mut Vec<PathBuf>, limit: usize, depth: usize) {
    if out.len() >= limit || depth > 12 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= limit {
            return;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') && name != ".claude" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            if SKIP_DIRS.contains(&name.as_ref()) {
                continue;
            }
            walk(&path, out, limit, depth + 1);
        } else {
            out.push(path);
        }
    }
}

/// Flat file list under the given roots — the corpus for quick-open (Cmd+P).
/// Bounded so a huge tree can't balloon the heap or the IPC payload.
#[tauri::command]
pub fn fs_list_files(
    state: State<'_, WorkspaceManager>,
    roots: Vec<String>,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    let limit = limit.unwrap_or(20_000);
    let mut out: Vec<PathBuf> = Vec::new();
    for root in roots {
        let dir = check_scope(&state, Path::new(&root))?;
        walk(&dir, &mut out, limit, 0);
    }
    Ok(out.iter().map(|p| p.to_string_lossy().to_string()).collect())
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
pub fn fs_search(
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
        walk(&dir, &mut files, 20_000, 0);
    }

    let mut hits = Vec::new();
    for file in files {
        if hits.len() >= limit {
            break;
        }
        // Skip anything too big to be worth scanning inline.
        if std::fs::metadata(&file).map(|m| m.len() > 2_000_000).unwrap_or(true) {
            continue;
        }
        let Ok(content) = std::fs::read(&file) else { continue };
        if content.contains(&0) {
            continue; // binary
        }
        let Ok(text) = String::from_utf8(content) else { continue };
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
pub fn fs_stat(
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

// ---------- file management (context menu) ----------

/// Create an empty file. Fails if it already exists rather than truncating —
/// "New File" must never silently destroy an existing one.
#[tauri::command]
pub fn fs_create_file(state: State<'_, WorkspaceManager>, path: String) -> Result<String, String> {
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
pub fn fs_create_dir(state: State<'_, WorkspaceManager>, path: String) -> Result<String, String> {
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
pub fn fs_rename(
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
pub fn fs_trash(state: State<'_, WorkspaceManager>, path: String) -> Result<(), String> {
    let target = check_scope(&state, Path::new(&path))?;
    trash::delete(&target).map_err(|e| e.to_string())
}

/// Show the file in the OS file manager.
#[tauri::command]
pub fn fs_reveal(state: State<'_, WorkspaceManager>, path: String) -> Result<(), String> {
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
pub fn fs_duplicate(state: State<'_, WorkspaceManager>, path: String) -> Result<String, String> {
    let src = check_scope(&state, Path::new(&path))?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = src.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
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

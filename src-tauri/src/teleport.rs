//! Moving a Claude conversation between machines (src/teleport/sessionMove.ts).
//!
//! The conversation lives in the CLI's own store, outside any project folder, so
//! the file commands (scoped to project roots and capped at 1 MB) cannot carry
//! it. These three do exactly that and nothing else: name the home directory,
//! read one session's transcript, write one. The workspace host implements the
//! same commands (packages/remote-host/teleport-transcript.mjs); the contract
//! is the same on both machines.

use std::path::{Path, PathBuf};

/// Largest transcript moved. Larger ones are refused rather than half sent.
const MAX_BYTES: u64 = 64 * 1024 * 1024;

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .ok_or_else(|| "this machine has no absolute home directory".to_string())
}

/// Claude's folder name for a working directory: every non-alphanumeric is `-`.
fn project_dir_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

fn safe_session_id(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && id.len() <= 128
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn transcript_path(home: &Path, cwd: &str, session_id: &str) -> Result<PathBuf, String> {
    if !cwd.starts_with('/') || cwd.chars().any(|c| c.is_control()) {
        return Err("cwd must be an absolute path".into());
    }
    if !safe_session_id(session_id) {
        return Err("not a safe session id".into());
    }
    Ok(home
        .join(".claude")
        .join("projects")
        .join(project_dir_name(cwd))
        .join(format!("{session_id}.jsonl")))
}

#[tauri::command]
pub fn teleport_home() -> Result<String, String> {
    home().map(|p| p.to_string_lossy().into_owned())
}

/// The session's transcript text, or None when this machine has none.
#[tauri::command]
pub fn teleport_transcript_read(cwd: String, session_id: String) -> Result<Option<String>, String> {
    let path = transcript_path(&home()?, &cwd, &session_id)?;
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return Err("the conversation is not a regular file within the size limit".into());
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

/// Write the transcript. An identical file is left; a different existing one is
/// never overwritten (its history would be lost). Returns the path written.
#[tauri::command]
pub fn teleport_transcript_write(cwd: String, session_id: String, text: String) -> Result<String, String> {
    if text.len() as u64 > MAX_BYTES {
        return Err("the conversation is too large to move".into());
    }
    let path = transcript_path(&home()?, &cwd, &session_id)?;
    if let Ok(existing) = std::fs::read_to_string(&path) {
        return if existing == text {
            Ok(path.to_string_lossy().into_owned())
        } else {
            Err("this machine already has a different version of this conversation; it was kept".into())
        };
    }
    let dir = path.parent().ok_or("no parent directory")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let staging = dir.join(format!("{session_id}.{}.teleport", std::process::id()));
    std::fs::write(&staging, text).map_err(|e| e.to_string())?;
    std::fs::rename(&staging, &path).map_err(|e| {
        let _ = std::fs::remove_file(&staging);
        e.to_string()
    })?;
    Ok(path.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Carrying commits and uncommitted changes to a repository that already exists
// on the destination. The project mirror sets a project up, but its incremental
// path never touches commits or changes there, so a teleport to a copy at a
// different commit used to stop with "push and pull". These five commands do the
// carrying with git's own bundle and patch formats. Each works only on a git
// top-level directory, takes commit ids as hex only, and never rewrites history:
// the bundle is applied fast-forward only and on a clean tree.

use base64::Engine as _;
use std::process::Command;

/// Largest bundle or patch carried (before base64).
const MAX_GIT_BYTES: usize = 48 * 1024 * 1024;

/// A temp path no other call shares: concurrent teleports and tests must not
/// write the same file.
fn temp_file(kind: &str) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    std::env::temp_dir().join(format!("canopy-teleport-{}-{}.{kind}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)))
}

fn is_sha(s: &str) -> bool {
    (7..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit())
}

fn run_git(path: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    // Bounded like every other subprocess capture; a diff past the cap is
    // refused rather than silently cut, because a truncated patch would apply
    // as a different change.
    let mut command = Command::new("git");
    command.arg("-C").arg(path).args(args);
    let capped = crate::process_capture::output(&mut command, GIT_OUTPUT_MAX)
        .map_err(|e| format!("could not run git: {e}"))?;
    if capped.stdout_truncated || capped.stderr_truncated {
        return Err("git output was too large to carry".into());
    }
    Ok(std::process::Output { status: capped.status, stdout: capped.stdout.clone(), stderr: capped.stderr.clone() })
}

const GIT_OUTPUT_MAX: usize = 8 * 1024 * 1024;

fn git_ok(path: &Path, args: &[&str]) -> Result<String, String> {
    let out = run_git(path, args)?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// `path` as a git working-tree top level, or an error.
fn top_level(path: &str) -> Result<PathBuf, String> {
    if !path.starts_with('/') || path.chars().any(|c| c.is_control()) {
        return Err("path must be absolute".into());
    }
    let given = std::fs::canonicalize(path).map_err(|e| e.to_string())?;
    let top = git_ok(&given, &["rev-parse", "--show-toplevel"])?;
    let top = std::fs::canonicalize(top).map_err(|e| e.to_string())?;
    if top != given {
        return Err("path is not the top of a git working tree".into());
    }
    Ok(given)
}

fn exists_commit(path: &Path, sha: &str) -> bool {
    run_git(path, &["cat-file", "-e", &format!("{sha}^{{commit}}")])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn is_ancestor(path: &Path, a: &str, b: &str) -> bool {
    run_git(path, &["merge-base", "--is-ancestor", a, b])
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// How `other` relates to this working tree's HEAD: "same", "behind" (other is
/// an ancestor of HEAD, so HEAD has commits to carry), "ahead" (HEAD is an
/// ancestor of other), "diverged", or "unknown" (other is not a commit here).
#[tauri::command]
pub fn teleport_git_relation(path: String, other: String) -> Result<String, String> {
    if !is_sha(&other) {
        return Err("not a commit id".into());
    }
    let top = top_level(&path)?;
    let head = git_ok(&top, &["rev-parse", "HEAD"])?;
    if !exists_commit(&top, &other) {
        return Ok("unknown".into());
    }
    let other_full = git_ok(&top, &["rev-parse", &format!("{other}^{{commit}}")])?;
    Ok(if other_full == head {
        "same"
    } else if is_ancestor(&top, &other_full, &head) {
        "behind"
    } else if is_ancestor(&top, &head, &other_full) {
        "ahead"
    } else {
        "diverged"
    }
    .into())
}

/// The commits after `since` up to HEAD, as a git bundle in base64. Refused
/// unless `since` is an ancestor of HEAD, so what is carried is always a
/// fast-forward.
#[tauri::command]
pub fn teleport_bundle_create(path: String, since: String) -> Result<String, String> {
    if !is_sha(&since) {
        return Err("not a commit id".into());
    }
    let top = top_level(&path)?;
    if !exists_commit(&top, &since) || !is_ancestor(&top, &since, "HEAD") {
        return Err("the destination's commit is not part of this history".into());
    }
    let file = temp_file("bundle");
    let _ = std::fs::remove_file(&file);
    let made = run_git(&top, &["bundle", "create", &file.to_string_lossy(), "HEAD", &format!("^{since}")]);
    let result = (|| {
        let out = made?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
        if bytes.len() > MAX_GIT_BYTES {
            return Err("the commits are too large to move this way".into());
        }
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })();
    let _ = std::fs::remove_file(&file);
    result
}

/// Apply a bundle to a clean working tree, fast-forward only. Returns the new HEAD.
#[tauri::command]
pub fn teleport_bundle_apply(path: String, data: String) -> Result<String, String> {
    let top = top_level(&path)?;
    if !git_ok(&top, &["status", "--porcelain"])?.is_empty() {
        return Err("the destination has uncommitted changes; nothing was applied".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "the commits were damaged in transit".to_string())?;
    if bytes.len() > MAX_GIT_BYTES {
        return Err("the commits are too large to move this way".into());
    }
    let file = temp_file("bundle");
    std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
    let result = (|| {
        let f = file.to_string_lossy().into_owned();
        git_ok(&top, &["bundle", "verify", &f]).map_err(|e| format!("the commits do not fit this repository: {e}"))?;
        git_ok(&top, &["fetch", "--no-tags", &f, "+HEAD:refs/canopy/teleport"])?;
        git_ok(&top, &["merge", "--ff-only", "refs/canopy/teleport"])
            .map_err(|e| format!("the destination has diverged, so nothing was applied: {e}"))?;
        git_ok(&top, &["rev-parse", "HEAD"])
    })();
    let _ = std::fs::remove_file(&file);
    let _ = run_git(&top, &["update-ref", "-d", "refs/canopy/teleport"]);
    result
}

/// Tracked changes in the working tree, as a binary patch in base64; empty when
/// there are none. Untracked files are not part of it.
#[tauri::command]
pub fn teleport_patch_create(path: String) -> Result<String, String> {
    let top = top_level(&path)?;
    let out = run_git(&top, &["diff", "--binary", "HEAD"])?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    if out.stdout.len() > MAX_GIT_BYTES {
        return Err("the changes are too large to move this way".into());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(out.stdout))
}

/// Apply a patch from `teleport_patch_create` to a clean working tree.
#[tauri::command]
pub fn teleport_patch_apply(path: String, data: String) -> Result<(), String> {
    let top = top_level(&path)?;
    if !git_ok(&top, &["status", "--porcelain"])?.is_empty() {
        return Err("the destination has uncommitted changes; nothing was applied".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "the changes were damaged in transit".to_string())?;
    let file = temp_file("patch");
    std::fs::write(&file, bytes).map_err(|e| e.to_string())?;
    let f = file.to_string_lossy().into_owned();
    let result = git_ok(&top, &["apply", "--binary", "--whitespace=nowarn", &f]).map(|_| ());
    let _ = std::fs::remove_file(&file);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_follows_claudes_encoding() {
        let p = transcript_path(Path::new("/home/u"), "/work/my app/x", "abc-1").unwrap();
        assert_eq!(p, Path::new("/home/u/.claude/projects/-work-my-app-x/abc-1.jsonl"));
    }

    #[test]
    fn unsafe_ids_and_relative_cwds_are_refused() {
        let h = Path::new("/h");
        assert!(transcript_path(h, "/w", "../x").is_err());
        assert!(transcript_path(h, "/w", "").is_err());
        assert!(transcript_path(h, "w", "ok").is_err());
        assert!(transcript_path(h, "/w\n", "ok").is_err());
    }

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git").arg("-C").arg(dir).args(args).output().unwrap();
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn repo(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let dir = std::fs::canonicalize(&dir).unwrap();
        sh(&dir, &["init", "-q", "-b", "main"]);
        sh(&dir, &["config", "user.email", "t@t"]);
        sh(&dir, &["config", "user.name", "t"]);
        dir
    }

    fn commit(dir: &Path, file: &str, text: &str) -> String {
        std::fs::write(dir.join(file), text).unwrap();
        sh(dir, &["add", "-A"]);
        sh(dir, &["commit", "-q", "-m", text]);
        sh(dir, &["rev-parse", "HEAD"])
    }

    #[test]
    fn commits_and_changes_carry_fast_forward_only() {
        let src = repo("src");
        let base = commit(&src, "a.txt", "one");
        let dst = repo("dst");
        sh(&dst, &["fetch", "-q", src.to_str().unwrap(), "main"]);
        sh(&dst, &["reset", "-q", "--hard", "FETCH_HEAD"]);
        assert_eq!(sh(&dst, &["rev-parse", "HEAD"]), base);

        let head = commit(&src, "b.txt", "two");
        std::fs::write(src.join("a.txt"), "edited").unwrap();

        let path = src.to_string_lossy().into_owned();
        assert_eq!(teleport_git_relation(path.clone(), base.clone()).unwrap(), "behind");
        let bundle = teleport_bundle_create(path.clone(), base.clone()).unwrap();
        let dpath = dst.to_string_lossy().into_owned();
        assert_eq!(teleport_git_relation(dpath.clone(), head.clone()).unwrap(), "unknown");
        assert_eq!(teleport_bundle_apply(dpath.clone(), bundle).unwrap(), head);
        assert_eq!(teleport_git_relation(dpath.clone(), head.clone()).unwrap(), "same");

        let patch = teleport_patch_create(path).unwrap();
        assert!(!patch.is_empty());
        teleport_patch_apply(dpath.clone(), patch.clone()).unwrap();
        assert_eq!(std::fs::read_to_string(dst.join("a.txt")).unwrap(), "edited");
        // A dirty destination is never written to.
        assert!(teleport_patch_apply(dpath, patch).is_err());
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst);
    }

    #[test]
    fn a_diverged_destination_is_refused() {
        let src = repo("dsrc");
        let base = commit(&src, "a.txt", "one");
        let dst = repo("ddst");
        sh(&dst, &["fetch", "-q", src.to_str().unwrap(), "main"]);
        sh(&dst, &["reset", "-q", "--hard", "FETCH_HEAD"]);
        commit(&dst, "c.txt", "theirs");
        commit(&src, "b.txt", "mine");
        let bundle = teleport_bundle_create(src.to_string_lossy().into_owned(), base).unwrap();
        let err = teleport_bundle_apply(dst.to_string_lossy().into_owned(), bundle).unwrap_err();
        assert!(err.contains("diverged"), "{err}");
        assert_eq!(teleport_git_relation(dst.to_string_lossy().into_owned(), "zzz".into()).is_err(), true);
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dst);
    }
}

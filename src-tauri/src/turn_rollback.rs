//! Turn snapshots: the Canopy-owned half of "instant rollback".
//!
//! At each agent turn boundary (Claude's `UserPromptSubmit` = turn start,
//! `Stop` = turn end) the whole working tree — tracked files plus untracked,
//! non-ignored ones — is written into a git tree through a TEMPORARY index
//! (`GIT_INDEX_FILE`) and committed under a hidden ref:
//!
//! ```text
//! refs/canopy/turns/<session>/<n>        turn n, as it started
//! refs/canopy/turn-ends/<session>/<n>    turn n, as it ended
//! refs/canopy/restores/<session>/<ms>    the tree just before a restore (redo)
//! ```
//!
//! The user's index, working tree, HEAD and branches are never touched by a
//! snapshot: the temp index is seeded from a *copy* of the user's index (for
//! its stat cache) or from HEAD's tree, `git add -A` runs against the copy,
//! `write-tree` + `commit-tree` produce the commit and `update-ref` names it
//! under `refs/canopy/`. Nothing else is written outside `.git/objects` and
//! those refs. The tests below check that byte-for-byte.
//!
//! **Where it runs, and the race it lives with.** `UserPromptSubmit` is a
//! blocking hook, so the snapshot is NOT taken inside `canopy-hook` — that would
//! hold the turn hostage to `git add -A` on a large tree. The hook already
//! appends the event to `~/.canopy/agent-events.jsonl`; the app's hook bridge
//! (agents.rs `start_hook_bridge`, 500 ms poll) emits it as `agent:events`, and
//! the frontend (turnRollback.ts) asks for a snapshot here. That means the
//! turn-start snapshot can land *after* Claude's first edit. Two defences:
//!
//!  1. The previous turn's END snapshot is an exact picture of the tree when
//!     the agent stopped, and is preferred as "before turn n" whenever the
//!     start snapshot is marked `late`.
//!  2. `late` is decided here: if this session's edit journal recorded an edit
//!     at or after the moment the prompt was observed and before the snapshot
//!     finished, the start snapshot may already contain some of the turn.
//!
//! Bash-only edits never reach the journal, so (2) cannot see them; that and
//! the between-turns human edits that (1) would miss are named in the PR.
//!
//! **Restore** diffs the target snapshot against a fresh snapshot of the
//! current tree (tree-to-tree, so files created since are seen as deletions),
//! scoped to the paths this session's edit journal attributes to it whenever
//! another live agent shares the checkout. The pre-restore snapshot is kept as
//! a restore point, so a restore is itself undoable. Blob content is read back
//! through `cat-file --filters`, so smudge filters (LFS, autocrlf) run in the
//! same direction checkout would run them.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::winproc::NoConsoleWindow;

/// Retention: the newest this many turns per session survive…
pub const MAX_TURNS: usize = 200;
/// …and nothing older than this survives at all (any session, any kind).
pub const MAX_AGE_SECS: u64 = 30 * 24 * 60 * 60;
/// Restore points (redo) per session.
pub const MAX_RESTORES: usize = 50;

const TURNS: &str = "refs/canopy/turns";
const ENDS: &str = "refs/canopy/turn-ends";
const RESTORES: &str = "refs/canopy/restores";

/// A session whose digest moved within this window counts as "active" when
/// deciding whether a checkout is shared.
const PEER_ACTIVE_SECS: u64 = 2 * 60 * 60;
/// Preview patch cap; past it the file list is still exact.
const PATCH_MAX: usize = 1024 * 1024;

/// One snapshot or restore at a time, process-wide. Snapshots of two repos
/// could run in parallel, but turn boundaries are seconds apart and the
/// serialisation is what keeps "start" and "end" of one session in order.
static LOCK: Mutex<()> = Mutex::new(());
/// Last time each (session, kind) was snapshotted — collapses the same hook
/// line delivered to two windows into one snapshot.
static RECENT: Mutex<Option<HashMap<(PathBuf, String, String), Instant>>> = Mutex::new(None);

// ------------------------------------------------------------------ plumbing

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// git, pinned to `root` and scrubbed of anything the parent environment could
/// use to redirect it at a different index or repository.
fn git(root: &Path) -> Command {
    let mut c = Command::new("git");
    for k in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
        "GIT_COMMON_DIR",
        "GIT_PREFIX",
    ] {
        c.env_remove(k);
    }
    c.env("GIT_TERMINAL_PROMPT", "0");
    c.arg("-C").arg(root);
    // Identity so commit-tree never fails on an unconfigured machine; no
    // signing (a pinentry prompt per turn is not acceptable); no fsmonitor or
    // split index, so the temp index cannot spill state into `.git`.
    c.args([
        "-c",
        "user.name=Canopy",
        "-c",
        "user.email=canopy@localhost",
        "-c",
        "commit.gpgSign=false",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.splitIndex=false",
    ]);
    c.no_console_window();
    c
}

/// Per-stream capture cap for git's answers (ref lists, raw diffs, patches).
/// Blob contents never come through here — they stream straight to disk.
const STREAM_MAX: usize = 8 * 1024 * 1024;

/// Run git through the process-wide bounded capture owner (process_capture).
/// `Ok((stdout, truncated))`; a failed exit returns stderr as the error.
fn run_capped(cmd: &mut Command, stdin: Option<&[u8]>) -> Result<(Vec<u8>, bool), String> {
    let permit = crate::process_capture::acquire(STREAM_MAX)?;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let mut child = cmd.spawn().map_err(|e| format!("could not run git: {e}"))?;
    if let (Some(data), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // Small (a commit message, a ref-delete script); dropping the pipe
        // after writing is what sends EOF.
        pipe.write_all(data).map_err(|e| e.to_string())?;
    }
    let mut out = crate::process_capture::wait_with_capped_output(child, STREAM_MAX, permit)?;
    if out.status.success() {
        let truncated = out.stdout_truncated;
        Ok((out.take_stdout(), truncated))
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Like [`run_capped`], refusing a truncated answer.
fn run_bytes(cmd: &mut Command, stdin: Option<&[u8]>) -> Result<Vec<u8>, String> {
    match run_capped(cmd, stdin)? {
        (_, true) => Err(format!(
            "git output exceeded {} MiB",
            STREAM_MAX / 1024 / 1024
        )),
        (bytes, false) => Ok(bytes),
    }
}

fn run(cmd: &mut Command) -> Result<String, String> {
    run_bytes(cmd, None).map(|b| String::from_utf8_lossy(&b).trim().to_string())
}

/// The work-tree root containing `dir`, or None when it is not in a git
/// work tree — the "rollback needs git" state.
pub fn toplevel(dir: &Path) -> Option<PathBuf> {
    run(git(dir).args(["rev-parse", "--show-toplevel"]))
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
}

fn head_commit(root: &Path) -> Option<String> {
    run(git(root).args(["rev-parse", "--verify", "-q", "HEAD^{commit}"]))
        .ok()
        .filter(|s| !s.is_empty())
}

/// Session ids become ref components and file names: allow exactly what
/// Claude (a UUID) and the other CLIs produce, nothing git would reinterpret.
pub fn valid_session(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

fn valid_uuid(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// A uniquely named temp index outside the repository, removed on drop
/// (together with any `.lock` a killed git left behind).
struct TempIndex(PathBuf);

impl TempIndex {
    fn new() -> Self {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        TempIndex(std::env::temp_dir().join(format!(
            "canopy-turn-index-{}-{}-{n}",
            std::process::id(),
            now_ms()
        )))
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let mut lock = self.0.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(PathBuf::from(lock));
    }
}

/// Write the current working tree (tracked + untracked non-ignored) into a
/// tree object without touching the user's index. Returns the tree id.
pub fn write_worktree_tree(root: &Path) -> Result<String, String> {
    let tmp = TempIndex::new();
    // Seed from a copy of the user's index: same entries, and its stat cache
    // means `add -A` hashes only what changed instead of every file. Reading
    // it is not modifying it — git replaces the index by rename, so a copy is
    // always some complete version of it.
    let user_index = run(git(root).args(["rev-parse", "--git-path", "index"]))?;
    let user_index = {
        let p = PathBuf::from(&user_index);
        if p.is_absolute() {
            p
        } else {
            root.join(p)
        }
    };
    let seeded = user_index.is_file() && std::fs::copy(&user_index, &tmp.0).is_ok();
    if !seeded {
        if let Some(head) = head_commit(root) {
            run(git(root)
                .env("GIT_INDEX_FILE", &tmp.0)
                .args(["read-tree", &head]))?;
        }
    }
    run(git(root)
        .env("GIT_INDEX_FILE", &tmp.0)
        .args(["add", "-A", "--", ":/"]))?;
    run(git(root).env("GIT_INDEX_FILE", &tmp.0).arg("write-tree"))
}

fn commit_tree(root: &Path, tree: &str, message: &str) -> Result<String, String> {
    let mut cmd = git(root);
    cmd.args(["commit-tree", tree, "--no-gpg-sign"]);
    // HEAD as parent keeps the commit the snapshot was taken on reachable for
    // as long as the snapshot is, and makes `git log <ref>` read naturally.
    if let Some(head) = head_commit(root) {
        cmd.args(["-p", &head]);
    }
    cmd.args(["-F", "-"]);
    let out = run_bytes(&mut cmd, Some(message.as_bytes()))?;
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// Create `name` only if it does not already exist (an empty old value is
/// git's "must not exist"), so two racing writers cannot overwrite each other.
fn create_ref(root: &Path, name: &str, commit: &str) -> Result<(), String> {
    run(git(root).args(["update-ref", "--no-deref", name, commit, ""])).map(|_| ())
}

// ------------------------------------------------------------------ metadata

/// What each snapshot commit carries in its body, as one JSON line, so the
/// whole timeline can be rebuilt from refs alone.
#[derive(Serialize, serde::Deserialize, Clone, Debug, Default, PartialEq)]
pub struct SnapMeta {
    #[serde(default)]
    pub v: u32,
    /// "start" | "end" | "restore-point"
    pub kind: String,
    pub session: String,
    #[serde(default)]
    pub n: Option<u64>,
    /// When the snapshot finished.
    pub ts_ms: u64,
    /// When the boundary event was observed (start/end only).
    #[serde(default)]
    pub observed_ms: Option<u64>,
    #[serde(default)]
    pub prompt: Option<String>,
    /// A start snapshot that may already contain some of the turn's edits.
    #[serde(default)]
    pub late: bool,
    /// Work-tree root the snapshot was taken in.
    #[serde(default)]
    pub root: String,
    /// For a restore point: the ref that was being restored to.
    #[serde(default)]
    pub target: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SnapRef {
    #[serde(rename = "ref")]
    pub refname: String,
    pub commit: String,
    pub tree: String,
    pub ts_ms: u64,
}

struct RawRef {
    refname: String,
    commit: String,
    tree: String,
    time: u64,
    meta: Option<SnapMeta>,
}

fn list_refs(root: &Path, prefixes: &[String]) -> Result<Vec<RawRef>, String> {
    let mut cmd = git(root);
    cmd.args([
        "for-each-ref",
        "--format=%(refname)%1f%(objectname)%1f%(tree)%1f%(committerdate:unix)%1f%(contents:body)%1e",
    ]);
    for p in prefixes {
        cmd.arg(p);
    }
    let out = run_bytes(&mut cmd, None)?;
    let text = String::from_utf8_lossy(&out);
    let mut refs = Vec::new();
    for rec in text.split('\x1e') {
        let rec = rec.trim_start_matches('\n');
        if rec.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = rec.splitn(5, '\x1f').collect();
        if f.len() < 5 {
            continue;
        }
        let meta = f[4]
            .lines()
            .find(|l| l.trim_start().starts_with('{'))
            .and_then(|l| serde_json::from_str::<SnapMeta>(l.trim()).ok());
        refs.push(RawRef {
            refname: f[0].to_string(),
            commit: f[1].to_string(),
            tree: f[2].to_string(),
            time: f[3].trim().parse().unwrap_or(0),
            meta,
        });
    }
    Ok(refs)
}

fn ref_n(refname: &str, prefix: &str) -> Option<u64> {
    refname.strip_prefix(prefix)?.parse().ok()
}

// ------------------------------------------------------------------ journal

fn sessions_dir(home: &Path) -> PathBuf {
    home.join(".canopy").join("sessions")
}

/// Whether this session's edit journal recorded an edit in `[from, to]`
/// (seconds). Read-only consumer of the journal canopy_hook writes.
fn journal_edit_between(home: &Path, session: &str, from_secs: u64, to_secs: u64) -> bool {
    let path = sessions_dir(home).join(format!("{session}.edits.jsonl"));
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    raw.lines().rev().take(400).any(|l| {
        serde_json::from_str::<serde_json::Value>(l)
            .ok()
            .and_then(|v| v["ts"].as_u64())
            .map(|ts| ts >= from_secs && ts <= to_secs)
            .unwrap_or(false)
    })
}

/// `p` relative to `root`, lexically (the file may be gone), trying both the
/// path as given and the canonical root so a symlinked home still matches.
fn rel_to_root(p: &Path, root: &Path, canon_root: &Path) -> Option<String> {
    let rel: PathBuf = match p.strip_prefix(root).or_else(|_| p.strip_prefix(canon_root)) {
        Ok(r) => r.to_path_buf(),
        Err(_) => {
            // The recorded path may go through a symlink the root does not
            // (e.g. /tmp vs /private/tmp); resolve its parent and retry.
            let canon_parent = std::fs::canonicalize(p.parent()?).ok()?;
            canon_parent
                .strip_prefix(canon_root)
                .ok()?
                .join(p.file_name()?)
        }
    };
    let s = rel.to_string_lossy().replace('\\', "/");
    if s.is_empty() || s.split('/').any(|c| c == "..") {
        return None;
    }
    Some(s)
}

/// Paths (repo-relative) the edit journal and digest attribute to `session`.
pub fn session_paths(home: &Path, session: &str, root: &Path) -> BTreeSet<String> {
    let canon_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut out = BTreeSet::new();
    let dir = sessions_dir(home);
    if let Ok(raw) = std::fs::read_to_string(dir.join(format!("{session}.edits.jsonl"))) {
        for l in raw.lines() {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else {
                continue;
            };
            if let Some(p) = v["path"].as_str() {
                let pb = PathBuf::from(p);
                let abs = if pb.is_absolute() { pb } else { root.join(pb) };
                if let Some(r) = rel_to_root(&abs, root, &canon_root) {
                    out.insert(r);
                }
            }
        }
    }
    // The digest's `files` list survives the journal's size cap; its entries
    // are relative to the digest's cwd, or absolute.
    if let Ok(raw) = std::fs::read_to_string(dir.join(format!("{session}.json"))) {
        if let Ok(d) = serde_json::from_str::<serde_json::Value>(&raw) {
            let cwd = PathBuf::from(d["cwd"].as_str().unwrap_or(""));
            for f in d["files"].as_array().into_iter().flatten() {
                if let Some(f) = f.as_str() {
                    let pb = PathBuf::from(f);
                    let abs = if pb.is_absolute() { pb } else { cwd.join(pb) };
                    if let Some(r) = rel_to_root(&abs, root, &canon_root) {
                        out.insert(r);
                    }
                }
            }
        }
    }
    out
}

/// Other live sessions working in the same checkout (same work-tree root —
/// not a path prefix, since Canopy's worktrees live under the main checkout).
pub fn other_active_sessions(
    home: &Path,
    session: &str,
    root: &Path,
    now_secs: u64,
) -> Vec<String> {
    let canon_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut tops: HashMap<String, Option<PathBuf>> = HashMap::new();
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(sessions_dir(home)) else {
        return out;
    };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(sid) = name.strip_suffix(".json") else {
            continue;
        };
        if sid == session || sid.ends_with(".edits") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(e.path()) else {
            continue;
        };
        let Ok(d) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        if d["state"].as_str() == Some("ended") || d["micro"].as_bool() == Some(true) {
            continue;
        }
        if now_secs.saturating_sub(d["updated"].as_u64().unwrap_or(0)) > PEER_ACTIVE_SECS {
            continue;
        }
        let cwd = d["cwd"].as_str().unwrap_or("").to_string();
        if cwd.is_empty() {
            continue;
        }
        let top = tops
            .entry(cwd.clone())
            .or_insert_with(|| toplevel(Path::new(&cwd)))
            .clone();
        let same = top
            .map(|t| std::fs::canonicalize(&t).unwrap_or(t) == canon_root)
            .unwrap_or(false);
        if same {
            out.push(sid.to_string());
        }
    }
    out.sort();
    out
}

// ------------------------------------------------------------------ snapshot

#[derive(Serialize, Clone, Debug)]
pub struct SnapshotOutcome {
    /// False when skipped (duplicate delivery, disabled, nothing to attach to).
    pub taken: bool,
    #[serde(rename = "ref")]
    pub refname: Option<String>,
    pub n: Option<u64>,
    pub late: bool,
    pub note: Option<String>,
}

fn skipped(note: &str) -> SnapshotOutcome {
    SnapshotOutcome {
        taken: false,
        refname: None,
        n: None,
        late: false,
        note: Some(note.into()),
    }
}

/// Take the turn-boundary snapshot for `session` in `root`. `kind` is "start"
/// (UserPromptSubmit) or "end" (Stop). `observed_ms` is when the boundary was
/// seen; used for the `late` verdict.
pub fn snapshot(
    root: &Path,
    home: &Path,
    session: &str,
    kind: &str,
    prompt: Option<&str>,
    observed_ms: u64,
) -> Result<SnapshotOutcome, String> {
    if !valid_session(session) {
        return Err("invalid session id".into());
    }
    if kind != "start" && kind != "end" {
        return Err(format!("unknown snapshot kind {kind}"));
    }
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    {
        let mut recent = RECENT.lock().unwrap_or_else(|e| e.into_inner());
        let map = recent.get_or_insert_with(HashMap::new);
        let key = (root.to_path_buf(), session.to_string(), kind.to_string());
        if map
            .get(&key)
            .map(|t| t.elapsed() < Duration::from_millis(1500))
            .unwrap_or(false)
        {
            return Ok(skipped("duplicate delivery"));
        }
        map.insert(key, Instant::now());
    }

    let starts = list_refs(root, &[format!("{TURNS}/{session}/")])?;
    let ends = list_refs(root, &[format!("{ENDS}/{session}/")])?;
    let sp = format!("{TURNS}/{session}/");
    let ep = format!("{ENDS}/{session}/");
    let max_start = starts.iter().filter_map(|r| ref_n(&r.refname, &sp)).max();
    let max_end = ends.iter().filter_map(|r| ref_n(&r.refname, &ep)).max();
    let latest = max_start.max(max_end);

    let n = match kind {
        "start" => latest.map(|n| n + 1).unwrap_or(1),
        // A Stop closes the newest turn if it is still open; a Stop with no
        // open turn (its start was missed) becomes a turn of its own with an
        // end and no start, so "Back to here" still works for it.
        _ => match (max_start, max_end) {
            (Some(s), e) if e.map(|e| e < s).unwrap_or(true) => s,
            _ => latest.map(|n| n + 1).unwrap_or(1),
        },
    };

    let tree = write_worktree_tree(root)?;
    let ts_ms = now_ms();
    let late = kind == "start"
        && journal_edit_between(
            home,
            session,
            (observed_ms / 1000).saturating_sub(1),
            ts_ms / 1000,
        );
    let meta = SnapMeta {
        v: 1,
        kind: kind.into(),
        session: session.into(),
        n: Some(n),
        ts_ms,
        observed_ms: Some(observed_ms),
        prompt: prompt.map(|p| {
            let flat = p.split_whitespace().collect::<Vec<_>>().join(" ");
            flat.chars().take(200).collect()
        }),
        late,
        root: root.to_string_lossy().into(),
        target: None,
    };
    let message = format!(
        "canopy turn {n} {kind}\n\n{}\n",
        serde_json::to_string(&meta).map_err(|e| e.to_string())?
    );
    let commit = commit_tree(root, &tree, &message)?;
    let refname = format!(
        "{}/{session}/{n}",
        if kind == "start" { TURNS } else { ENDS }
    );
    create_ref(root, &refname, &commit)?;
    let _ = prune(root, session, ts_ms / 1000);
    Ok(SnapshotOutcome {
        taken: true,
        refname: Some(refname),
        n: Some(n),
        late,
        note: None,
    })
}

// ------------------------------------------------------------------ retention

/// Drop everything past the retention policy: per session, only the newest
/// [`MAX_TURNS`] turns and [`MAX_RESTORES`] restore points; across every
/// session, anything older than [`MAX_AGE_SECS`]. Returns the refs deleted.
pub fn prune(root: &Path, session: &str, now_secs: u64) -> Result<Vec<String>, String> {
    let all = list_refs(root, &["refs/canopy/".to_string()])?;
    let mut doomed: BTreeSet<String> = all
        .iter()
        .filter(|r| now_secs.saturating_sub(r.time) > MAX_AGE_SECS)
        .map(|r| r.refname.clone())
        .collect();
    let sp = format!("{TURNS}/{session}/");
    let ep = format!("{ENDS}/{session}/");
    let mut turns: BTreeSet<u64> = BTreeSet::new();
    for r in &all {
        if let Some(n) = ref_n(&r.refname, &sp).or_else(|| ref_n(&r.refname, &ep)) {
            turns.insert(n);
        }
    }
    if turns.len() > MAX_TURNS {
        let cut: Vec<u64> = turns
            .iter()
            .take(turns.len() - MAX_TURNS)
            .copied()
            .collect();
        for n in cut {
            doomed.insert(format!("{sp}{n}"));
            doomed.insert(format!("{ep}{n}"));
        }
    }
    let rp = format!("{RESTORES}/{session}/");
    let mut restores: Vec<u64> = all.iter().filter_map(|r| ref_n(&r.refname, &rp)).collect();
    restores.sort_unstable();
    if restores.len() > MAX_RESTORES {
        for ms in &restores[..restores.len() - MAX_RESTORES] {
            doomed.insert(format!("{rp}{ms}"));
        }
    }
    let existing: BTreeSet<&str> = all.iter().map(|r| r.refname.as_str()).collect();
    let doomed: Vec<String> = doomed
        .into_iter()
        .filter(|r| existing.contains(r.as_str()))
        .collect();
    if doomed.is_empty() {
        return Ok(doomed);
    }
    let script: String = doomed.iter().map(|r| format!("delete {r}\n")).collect();
    run_bytes(
        git(root).args(["update-ref", "--stdin"]),
        Some(script.as_bytes()),
    )?;
    Ok(doomed)
}

// ------------------------------------------------------------------ listing

#[derive(Serialize, Clone, Debug)]
pub struct TurnPoint {
    pub n: u64,
    pub start: Option<SnapRef>,
    pub end: Option<SnapRef>,
    pub prompt: Option<String>,
    pub late: bool,
    /// Claude's own checkpoint id (the replayed user-message uuid) paired with
    /// this turn, when the session ran headless with file checkpointing on.
    pub native_uuid: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RestorePoint {
    #[serde(rename = "ref")]
    pub refname: String,
    pub ts_ms: u64,
    pub target: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct TurnList {
    /// False outside a git work tree: rollback needs git.
    pub git: bool,
    pub root: Option<String>,
    /// Other live agents share this checkout, so restores default to this
    /// session's attributed paths.
    pub shared: bool,
    pub peers: Vec<String>,
    pub turns: Vec<TurnPoint>,
    pub restores: Vec<RestorePoint>,
}

#[derive(serde::Deserialize, Serialize, Clone, Debug)]
pub struct NativeCheckpoint {
    pub uuid: String,
    pub ts_ms: u64,
}

fn native_path(home: &Path, session: &str) -> PathBuf {
    home.join(".canopy")
        .join("turns")
        .join(format!("{session}.native.jsonl"))
}

/// Remember a Claude checkpoint uuid seen on a headless session's stream.
pub fn record_native(home: &Path, session: &str, uuid: &str, ts_ms: u64) -> Result<(), String> {
    if !valid_session(session) || !valid_uuid(uuid) {
        return Err("invalid session or checkpoint id".into());
    }
    let path = native_path(home, session);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    let line = serde_json::to_string(&NativeCheckpoint {
        uuid: uuid.into(),
        ts_ms,
    })
    .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

fn read_native(home: &Path, session: &str) -> Vec<NativeCheckpoint> {
    std::fs::read_to_string(native_path(home, session))
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Pair each turn with the checkpoint uuid recorded closest to its start,
/// order-preserving: a uuid is used at most once, and only within `window_ms`.
/// Both sides come from different pipes (hook bus vs. the runner's stdout), so
/// timestamps are the only join key they share.
pub fn pair_native(
    turn_starts: &[(u64, u64)],
    uuids: &[NativeCheckpoint],
    window_ms: u64,
) -> HashMap<u64, String> {
    let mut sorted: Vec<&NativeCheckpoint> = uuids.iter().collect();
    sorted.sort_by_key(|c| c.ts_ms);
    let mut out = HashMap::new();
    let mut next = 0usize;
    for &(n, ts) in turn_starts {
        let mut best: Option<(usize, u64)> = None;
        for (i, c) in sorted.iter().enumerate().skip(next) {
            let d = c.ts_ms.abs_diff(ts);
            if d <= window_ms && best.map(|(_, bd)| d < bd).unwrap_or(true) {
                best = Some((i, d));
            }
            if c.ts_ms > ts + window_ms {
                break;
            }
        }
        if let Some((i, _)) = best {
            out.insert(n, sorted[i].uuid.clone());
            next = i + 1;
        }
    }
    out
}

pub fn list(root: &Path, home: &Path, session: &str, now_secs: u64) -> Result<TurnList, String> {
    if !valid_session(session) {
        return Err("invalid session id".into());
    }
    let sp = format!("{TURNS}/{session}/");
    let ep = format!("{ENDS}/{session}/");
    let rp = format!("{RESTORES}/{session}/");
    let refs = list_refs(root, &[sp.clone(), ep.clone(), rp.clone()])?;
    let mut turns: BTreeMap<u64, TurnPoint> = BTreeMap::new();
    let mut restores = Vec::new();
    let snap = |r: &RawRef| SnapRef {
        refname: r.refname.clone(),
        commit: r.commit.clone(),
        tree: r.tree.clone(),
        ts_ms: r.meta.as_ref().map(|m| m.ts_ms).unwrap_or(r.time * 1000),
    };
    for r in &refs {
        if let Some(n) = ref_n(&r.refname, &sp) {
            let t = turns.entry(n).or_insert_with(|| TurnPoint {
                n,
                start: None,
                end: None,
                prompt: None,
                late: false,
                native_uuid: None,
            });
            t.start = Some(snap(r));
            if let Some(m) = &r.meta {
                t.prompt = m.prompt.clone();
                t.late = m.late;
            }
        } else if let Some(n) = ref_n(&r.refname, &ep) {
            let t = turns.entry(n).or_insert_with(|| TurnPoint {
                n,
                start: None,
                end: None,
                prompt: None,
                late: false,
                native_uuid: None,
            });
            t.end = Some(snap(r));
        } else if ref_n(&r.refname, &rp).is_some() {
            restores.push(RestorePoint {
                refname: r.refname.clone(),
                ts_ms: r.meta.as_ref().map(|m| m.ts_ms).unwrap_or(r.time * 1000),
                target: r.meta.as_ref().and_then(|m| m.target.clone()),
            });
        }
    }
    let starts: Vec<(u64, u64)> = turns
        .values()
        .filter_map(|t| {
            // Pair on when the prompt was observed when we have it: the
            // snapshot itself can finish seconds later on a big tree.
            let s = t.start.as_ref()?;
            let observed = refs
                .iter()
                .find(|r| r.refname == s.refname)
                .and_then(|r| r.meta.as_ref()?.observed_ms)
                .unwrap_or(s.ts_ms);
            Some((t.n, observed))
        })
        .collect();
    let paired = pair_native(&starts, &read_native(home, session), 60_000);
    for (n, uuid) in paired {
        if let Some(t) = turns.get_mut(&n) {
            t.native_uuid = Some(uuid);
        }
    }
    restores.sort_by_key(|r| r.ts_ms);
    let peers = other_active_sessions(home, session, root, now_secs);
    Ok(TurnList {
        git: true,
        root: Some(root.to_string_lossy().into()),
        shared: !peers.is_empty(),
        peers,
        turns: turns.into_values().collect(),
        restores,
    })
}

// ------------------------------------------------------------------ restore

/// Which paths a restore may change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// This session's attributed paths when the checkout is shared; else all.
    Auto,
    /// Only paths the edit journal attributes to this session.
    Session,
    /// The whole tree.
    All,
}

impl Scope {
    pub fn parse(s: &str) -> Scope {
        match s {
            "session" => Scope::Session,
            "all" => Scope::All,
            _ => Scope::Auto,
        }
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Change {
    pub path: String,
    /// "add" (restored file that is missing now), "modify", or "delete" (a file
    /// that did not exist at the target point).
    pub status: String,
    #[serde(skip)]
    new_mode: String,
    #[serde(skip)]
    new_sha: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Plan {
    pub changes: Vec<Change>,
    /// Paths that differ but were left alone because nothing attributes them
    /// to this session (Bash-created files, another agent's work).
    pub excluded: Vec<String>,
    pub scoped: bool,
    pub shared: bool,
    #[serde(skip)]
    current_tree: String,
    #[serde(skip)]
    target_tree: String,
}

/// The ref must be one of this session's snapshot refs, and must have been
/// taken in this work tree.
fn resolve_target(root: &Path, session: &str, target: &str) -> Result<String, String> {
    if !valid_session(session) {
        return Err("invalid session id".into());
    }
    let ok = [TURNS, ENDS, RESTORES].iter().any(|p| {
        target
            .strip_prefix(&format!("{p}/{session}/"))
            .map(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false)
    });
    if !ok {
        return Err("not a snapshot of this session".into());
    }
    let refs = list_refs(root, &[target.to_string()])?;
    let r = refs
        .into_iter()
        .find(|r| r.refname == target)
        .ok_or("that snapshot no longer exists (pruned?)")?;
    if let Some(m) = &r.meta {
        let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
        if !m.root.is_empty() && canon(Path::new(&m.root)) != canon(root) {
            return Err(format!(
                "that snapshot was taken in {}, not this checkout",
                m.root
            ));
        }
    }
    Ok(r.tree)
}

fn diff_trees(root: &Path, from: &str, to: &str) -> Result<Vec<Change>, String> {
    let out = run_bytes(
        git(root).args(["diff-tree", "-r", "-z", "--no-renames", "--raw", from, to]),
        None,
    )?;
    let mut changes = Vec::new();
    let mut parts = out.split(|b| *b == 0).filter(|p| !p.is_empty());
    while let Some(head) = parts.next() {
        let head = String::from_utf8_lossy(head);
        let Some(path) = parts.next() else { break };
        let path = String::from_utf8_lossy(path).to_string();
        // :oldmode newmode oldsha newsha status
        let f: Vec<&str> = head.trim_start_matches(':').split(' ').collect();
        if f.len() < 5 {
            continue;
        }
        let (old_mode, new_mode, new_sha, st) = (f[0], f[1], f[3], f[4]);
        // Submodules / embedded repos are recorded as gitlinks; restoring them
        // would mean moving another repository's HEAD. Out of scope.
        if old_mode == "160000" || new_mode == "160000" {
            continue;
        }
        let status = match st.chars().next() {
            Some('A') => "add",
            Some('D') => "delete",
            _ => "modify",
        };
        changes.push(Change {
            path,
            status: status.into(),
            new_mode: new_mode.into(),
            new_sha: new_sha.into(),
        });
    }
    Ok(changes)
}

pub fn plan(
    root: &Path,
    home: &Path,
    session: &str,
    target: &str,
    scope: Scope,
    now_secs: u64,
) -> Result<Plan, String> {
    let target_tree = resolve_target(root, session, target)?;
    let current_tree = write_worktree_tree(root)?;
    plan_against(
        root,
        home,
        session,
        &current_tree,
        &target_tree,
        scope,
        now_secs,
    )
}

fn plan_against(
    root: &Path,
    home: &Path,
    session: &str,
    current_tree: &str,
    target_tree: &str,
    scope: Scope,
    now_secs: u64,
) -> Result<Plan, String> {
    let shared = !other_active_sessions(home, session, root, now_secs).is_empty();
    let scoped = match scope {
        Scope::All => false,
        Scope::Session => true,
        Scope::Auto => shared,
    };
    let scope_set = scoped.then(|| session_paths(home, session, root));
    let all = diff_trees(root, current_tree, target_tree)?;
    let (changes, excluded): (Vec<Change>, Vec<Change>) = match &scope_set {
        None => (all, Vec::new()),
        Some(set) => all.into_iter().partition(|c| set.contains(&c.path)),
    };
    Ok(Plan {
        changes,
        excluded: excluded.into_iter().map(|c| c.path).collect(),
        scoped,
        shared,
        current_tree: current_tree.into(),
        target_tree: target_tree.into(),
    })
}

#[derive(Serialize, Clone, Debug)]
pub struct Preview {
    #[serde(flatten)]
    pub plan: Plan,
    /// Unified diff from the current tree to the target, limited to the files
    /// the restore would change.
    pub patch: String,
    pub truncated: bool,
}

pub fn preview(
    root: &Path,
    home: &Path,
    session: &str,
    target: &str,
    scope: Scope,
    now_secs: u64,
) -> Result<Preview, String> {
    let plan = plan(root, home, session, target, scope, now_secs)?;
    let (raw, mut truncated) = run_capped(
        git(root).args([
            "diff",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            &plan.current_tree,
            &plan.target_tree,
        ]),
        None,
    )?;
    // Section on line starts only, so file content mentioning "diff --git"
    // cannot split a file's patch in two.
    let raw = format!("\n{}", String::from_utf8_lossy(&raw));
    let wanted: BTreeSet<&str> = plan.changes.iter().map(|c| c.path.as_str()).collect();
    let mut patch = String::new();
    for section in raw.split("\ndiff --git ").filter(|s| !s.is_empty()) {
        // "a/<path> b/<path>\n…" — the b-side path is what we keyed on; for a
        // deletion it is the same path.
        let first = section.lines().next().unwrap_or("");
        let keep = wanted
            .iter()
            .any(|p| first == format!("a/{p} b/{p}") || first.ends_with(&format!(" b/{p}")));
        if !keep {
            continue;
        }
        if patch.len() + section.len() > PATCH_MAX {
            truncated = true;
            break;
        }
        patch.push_str("diff --git ");
        patch.push_str(section);
        patch.push('\n');
    }
    Ok(Preview {
        plan,
        patch,
        truncated,
    })
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct NativeOutcome {
    pub attempted: bool,
    pub ok: bool,
    pub message: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct RestoreOutcome {
    pub written: Vec<String>,
    pub deleted: Vec<String>,
    pub excluded: Vec<String>,
    pub failed: Vec<String>,
    /// The restore point holding the tree as it was just before this restore.
    pub redo_ref: String,
    pub native: NativeOutcome,
}

/// Claude's own file rewind: `claude -p --resume <id> --rewind-files <uuid>`
/// with SDK file checkpointing enabled (verified live against 2.1.310: prints
/// "Files rewound to state at message <uuid>"; without the env var it fails
/// with "File rewinding is not enabled"). Bounded, and never fatal: the
/// snapshot pass that follows covers whatever it skipped or refused.
fn native_rewind(root: &Path, bin: &str, session: &str, uuid: &str) -> NativeOutcome {
    if !valid_uuid(uuid) || !valid_session(session) {
        return NativeOutcome {
            attempted: false,
            ok: false,
            message: "invalid checkpoint id".into(),
        };
    }
    let mut cmd = Command::new(crate::procenv::resolve_command(bin));
    cmd.args([
        "-p",
        "--resume",
        session,
        "--rewind-files",
        uuid,
        "--permission-mode",
        "dontAsk",
    ])
    .current_dir(root)
    .env("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "true")
    // Not a turn: keep the hook bus and digests out of it.
    .env_remove("CANOPY")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    if let Some(path) = crate::procenv::child_path() {
        cmd.env("PATH", path);
    }
    cmd.no_console_window();
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return NativeOutcome {
                attempted: true,
                ok: false,
                message: format!("could not start {bin}: {e}"),
            }
        }
    };
    // Drain both pipes while waiting (bounded: the answer is one line), so a
    // chatty child can never fill a pipe and stall against the deadline.
    const KEEP: usize = 16 * 1024;
    let out_t = child
        .stdout
        .take()
        .map(|s| std::thread::spawn(move || crate::process_capture::drain_capped(s, KEEP)));
    let err_t = child
        .stderr
        .take()
        .map(|s| std::thread::spawn(move || crate::process_capture::drain_capped(s, KEEP)));
    let deadline = Instant::now() + Duration::from_secs(90);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let text = |t: Option<std::thread::JoinHandle<(Vec<u8>, bool)>>| {
        t.and_then(|t| t.join().ok())
            .map(|(b, _)| String::from_utf8_lossy(&b).trim().to_string())
            .unwrap_or_default()
    };
    let message = format!("{} {}", text(out_t), text(err_t));
    match status {
        Some(status) => NativeOutcome {
            attempted: true,
            ok: status.success(),
            message: message.trim().chars().take(400).collect(),
        },
        None => NativeOutcome {
            attempted: true,
            ok: false,
            message: "native rewind timed out".into(),
        },
    }
}

/// Write `rel` from blob `sha`, through the repository's smudge filters, with
/// the mode recorded in the tree.
fn write_blob(
    root: &Path,
    canon_root: &Path,
    rel: &str,
    sha: &str,
    mode: &str,
) -> Result<(), String> {
    if rel.split('/').any(|c| c == ".." || c.is_empty()) || Path::new(rel).is_absolute() {
        return Err(format!("refusing path {rel}"));
    }
    let dest = root.join(rel);
    let parent = dest.parent().ok_or("no parent")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    // Never write through a symlinked directory that leads out of the repo.
    let canon_parent = std::fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !canon_parent.starts_with(canon_root) {
        return Err(format!("{rel} resolves outside the repository"));
    }
    if dest.is_dir() && !dest.is_symlink() {
        std::fs::remove_dir(&dest).map_err(|_| format!("{rel} is a non-empty directory now"))?;
    }
    if mode == "120000" {
        let target = run_bytes(git(root).args(["cat-file", "blob", sha]), None)?;
        let _ = std::fs::remove_file(&dest);
        #[cfg(unix)]
        {
            use std::os::unix::ffi::OsStrExt;
            std::os::unix::fs::symlink(std::ffi::OsStr::from_bytes(&target), &dest)
                .map_err(|e| e.to_string())?;
        }
        #[cfg(not(unix))]
        std::fs::write(&dest, &target).map_err(|e| e.to_string())?;
        return Ok(());
    }
    let tmp = parent.join(format!(
        ".{}.canopy-restore-{}",
        dest.file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default(),
        std::process::id()
    ));
    // Streamed straight into the temp file: a restored file can be any size,
    // and none of it needs to pass through memory.
    let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let status = git(root)
        .args(["cat-file", "--filters", &format!("--path={rel}"), sha])
        .stdin(Stdio::null())
        .stdout(Stdio::from(file))
        .stderr(Stdio::null())
        .status()
        .map_err(|e| e.to_string());
    if !matches!(status, Ok(s) if s.success()) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("could not read {rel} from the snapshot"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let m = if mode == "100755" { 0o755 } else { 0o644 };
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(m));
    }
    if dest.is_symlink() {
        let _ = std::fs::remove_file(&dest);
    }
    std::fs::rename(&tmp, &dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

fn delete_path(root: &Path, rel: &str) -> Result<(), String> {
    if rel.split('/').any(|c| c == ".." || c.is_empty()) {
        return Err(format!("refusing path {rel}"));
    }
    let dest = root.join(rel);
    match std::fs::remove_file(&dest) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    // Tidy directories this left empty, never above the root.
    let mut dir = dest.parent().map(Path::to_path_buf);
    while let Some(d) = dir {
        if d == root || !d.starts_with(root) {
            break;
        }
        if std::fs::remove_dir(&d).is_err() {
            break;
        }
        dir = d.parent().map(Path::to_path_buf);
    }
    Ok(())
}

fn apply(root: &Path, plan: &Plan) -> (Vec<String>, Vec<String>, Vec<String>) {
    let canon_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let (mut written, mut deleted, mut failed) = (Vec::new(), Vec::new(), Vec::new());
    // Deletions first: a file that replaces a directory needs the directory's
    // files gone before it can be written.
    for c in plan.changes.iter().filter(|c| c.status == "delete") {
        match delete_path(root, &c.path) {
            Ok(()) => deleted.push(c.path.clone()),
            Err(e) => failed.push(format!("{}: {e}", c.path)),
        }
    }
    for c in plan.changes.iter().filter(|c| c.status != "delete") {
        match write_blob(root, &canon_root, &c.path, &c.new_sha, &c.new_mode) {
            Ok(()) => written.push(c.path.clone()),
            Err(e) => failed.push(format!("{}: {e}", c.path)),
        }
    }
    (written, deleted, failed)
}

/// Restore the working tree to `target` (within scope). Order:
///  1. snapshot the current tree as a restore point (redo);
///  2. Claude's native rewind, when a checkpoint uuid is known;
///  3. diff a fresh snapshot against the target and write/delete to match.
pub fn restore(
    root: &Path,
    home: &Path,
    session: &str,
    target: &str,
    scope: Scope,
    native: Option<(&str, &str)>,
    now_secs: u64,
) -> Result<RestoreOutcome, String> {
    let target_tree = resolve_target(root, session, target)?;
    let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let before = write_worktree_tree(root)?;
    let ts_ms = now_ms();
    let meta = SnapMeta {
        v: 1,
        kind: "restore-point".into(),
        session: session.into(),
        n: None,
        ts_ms,
        observed_ms: None,
        prompt: None,
        late: false,
        root: root.to_string_lossy().into(),
        target: Some(target.into()),
    };
    let message = format!(
        "canopy restore point\n\n{}\n",
        serde_json::to_string(&meta).map_err(|e| e.to_string())?
    );
    let commit = commit_tree(root, &before, &message)?;
    let mut redo_ref = format!("{RESTORES}/{session}/{ts_ms}");
    if create_ref(root, &redo_ref, &commit).is_err() {
        redo_ref = format!("{RESTORES}/{session}/{}", ts_ms + 1);
        create_ref(root, &redo_ref, &commit)?;
    }

    let native = match native {
        Some((bin, uuid)) => native_rewind(root, bin, session, uuid),
        None => NativeOutcome::default(),
    };
    let current = if native.attempted {
        write_worktree_tree(root)?
    } else {
        before
    };
    let plan = plan_against(root, home, session, &current, &target_tree, scope, now_secs)?;
    let (written, deleted, failed) = apply(root, &plan);
    let _ = prune(root, session, now_secs);
    Ok(RestoreOutcome {
        written,
        deleted,
        excluded: plan.excluded,
        failed,
        redo_ref,
        native,
    })
}

// ------------------------------------------------------------------ commands

fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "no home dir".to_string())
}

/// Resolve `cwd` to its work-tree root, inside a registered workspace root.
/// Ok(None) = not a git work tree.
fn scoped_root(
    state: &tauri::State<'_, crate::fsx::WorkspaceManager>,
    cwd: &str,
) -> Result<Option<PathBuf>, String> {
    let dir = crate::fsx::check_scope(state, Path::new(cwd))?;
    let Some(top) = toplevel(&dir) else {
        return Ok(None);
    };
    crate::fsx::check_scope(state, &top).map(Some)
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn turn_snapshot(
    state: tauri::State<'_, crate::fsx::WorkspaceManager>,
    cwd: String,
    session_id: String,
    kind: String,
    prompt: Option<String>,
    observed_ms: Option<u64>,
) -> Result<SnapshotOutcome, String> {
    let Some(root) = scoped_root(&state, &cwd)? else {
        return Ok(skipped("rollback needs git"));
    };
    let home = home_dir()?;
    let observed = observed_ms.unwrap_or_else(now_ms);
    blocking(move || {
        snapshot(
            &root,
            &home,
            &session_id,
            &kind,
            prompt.as_deref(),
            observed,
        )
    })
    .await
}

#[tauri::command]
pub async fn turn_list(
    state: tauri::State<'_, crate::fsx::WorkspaceManager>,
    cwd: String,
    session_id: String,
) -> Result<TurnList, String> {
    let Some(root) = scoped_root(&state, &cwd)? else {
        return Ok(TurnList {
            git: false,
            root: None,
            shared: false,
            peers: vec![],
            turns: vec![],
            restores: vec![],
        });
    };
    let home = home_dir()?;
    blocking(move || list(&root, &home, &session_id, now_ms() / 1000)).await
}

#[tauri::command]
pub async fn turn_preview(
    state: tauri::State<'_, crate::fsx::WorkspaceManager>,
    cwd: String,
    session_id: String,
    target: String,
    scope: String,
) -> Result<Preview, String> {
    let root = scoped_root(&state, &cwd)?.ok_or("rollback needs git")?;
    let home = home_dir()?;
    blocking(move || {
        preview(
            &root,
            &home,
            &session_id,
            &target,
            Scope::parse(&scope),
            now_ms() / 1000,
        )
    })
    .await
}

#[tauri::command]
pub async fn turn_restore(
    state: tauri::State<'_, crate::fsx::WorkspaceManager>,
    cwd: String,
    session_id: String,
    target: String,
    scope: String,
    claude_bin: Option<String>,
    native_uuid: Option<String>,
) -> Result<RestoreOutcome, String> {
    let root = scoped_root(&state, &cwd)?.ok_or("rollback needs git")?;
    let home = home_dir()?;
    blocking(move || {
        let native = match (&claude_bin, &native_uuid) {
            (Some(b), Some(u)) if !b.is_empty() && !u.is_empty() => Some((b.as_str(), u.as_str())),
            _ => None,
        };
        restore(
            &root,
            &home,
            &session_id,
            &target,
            Scope::parse(&scope),
            native,
            now_ms() / 1000,
        )
    })
    .await
}

#[tauri::command]
pub async fn turn_native_checkpoint(session_id: String, uuid: String) -> Result<(), String> {
    let home = home_dir()?;
    blocking(move || record_native(&home, &session_id, &uuid, now_ms())).await
}

// ------------------------------------------------------------------ tests

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway directory removed on drop.
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Self {
            static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let p = std::env::temp_dir().join(format!(
                "canopy-turns-{tag}-{}-{}-{n}",
                std::process::id(),
                now_ms()
            ));
            std::fs::create_dir_all(&p).unwrap();
            Tmp(std::fs::canonicalize(&p).unwrap())
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Clear the duplicate-delivery window for one repo (each test owns its
    /// temp repo, so this never touches a parallel test's entries).
    fn forget(root: &Path) {
        if let Some(m) = RECENT.lock().unwrap().as_mut() {
            m.retain(|(r, _, _), _| r != root);
        }
    }

    fn sh(root: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(root)
            .args([
                "-c",
                "user.name=T",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgSign=false",
            ])
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).to_string()
    }

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    fn read(root: &Path, rel: &str) -> Option<String> {
        std::fs::read_to_string(root.join(rel)).ok()
    }

    /// Repo with a commit, a staged change, an unstaged change, an untracked
    /// file and an ignored file.
    fn fixture() -> (Tmp, Tmp) {
        let repo = Tmp::new("repo");
        let home = Tmp::new("home");
        std::fs::create_dir_all(home.0.join(".canopy/sessions")).unwrap();
        let r = &repo.0;
        sh(r, &["init", "-q", "-b", "main"]);
        write(r, ".gitignore", "ignored.log\nbuild/\n");
        write(r, "tracked.txt", "v1\n");
        write(r, "src/lib.rs", "fn a() {}\n");
        sh(r, &["add", "-A"]);
        sh(r, &["commit", "-q", "-m", "init"]);
        sh(r, &["branch", "feature"]);
        write(r, "src/lib.rs", "fn a() { staged }\n");
        sh(r, &["add", "src/lib.rs"]);
        write(r, "tracked.txt", "v1 unstaged\n");
        write(r, "untracked.txt", "new file\n");
        write(r, "ignored.log", "noise\n");
        write(r, "build/out.bin", "artifact\n");
        (repo, home)
    }

    /// Everything a snapshot promises not to touch, as bytes.
    fn fingerprint(r: &Path) -> Vec<(String, Vec<u8>)> {
        let git_dir = r.join(".git");
        let mut v = vec![
            (
                "index".into(),
                std::fs::read(git_dir.join("index")).unwrap(),
            ),
            ("HEAD".into(), std::fs::read(git_dir.join("HEAD")).unwrap()),
            (
                "refs/heads".into(),
                sh(r, &["for-each-ref", "refs/heads"]).into_bytes(),
            ),
            (
                "status".into(),
                sh(
                    r,
                    &[
                        "status",
                        "--porcelain=v2",
                        "--untracked-files=all",
                        "--ignored",
                    ],
                )
                .into_bytes(),
            ),
        ];
        for f in [
            "tracked.txt",
            "src/lib.rs",
            "untracked.txt",
            "ignored.log",
            "build/out.bin",
            ".gitignore",
        ] {
            v.push((f.into(), std::fs::read(r.join(f)).unwrap_or_default()));
        }
        v
    }

    fn files_in_tree(r: &Path, rev: &str) -> Vec<String> {
        sh(r, &["ls-tree", "-r", "--name-only", rev])
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn snapshot_leaves_index_worktree_head_and_branches_byte_identical() {
        let (repo, home) = fixture();
        let r = &repo.0;
        // `git status` refreshes the index stat cache; settle it first so the
        // fingerprint is about us, not about status.
        sh(r, &["status", "--porcelain"]);
        let before = fingerprint(r);
        let index_before = std::fs::read(r.join(".git/index")).unwrap();
        let out = snapshot(r, &home.0, "s1", "start", Some("do the thing"), now_ms()).unwrap();
        assert!(out.taken);
        assert_eq!(
            std::fs::read(r.join(".git/index")).unwrap(),
            index_before,
            "user index changed"
        );
        assert_eq!(fingerprint(r), before);
        assert_eq!(out.refname.as_deref(), Some("refs/canopy/turns/s1/1"));

        // The tree holds tracked + staged + unstaged + untracked, not ignored.
        let files = files_in_tree(r, "refs/canopy/turns/s1/1");
        assert!(files.contains(&"untracked.txt".to_string()));
        assert!(files.contains(&"tracked.txt".to_string()));
        assert!(!files
            .iter()
            .any(|f| f == "ignored.log" || f.starts_with("build/")));
        assert_eq!(
            sh(r, &["show", "refs/canopy/turns/s1/1:tracked.txt"]),
            "v1 unstaged\n"
        );
        assert_eq!(
            sh(r, &["show", "refs/canopy/turns/s1/1:src/lib.rs"]),
            "fn a() { staged }\n"
        );
        // Staged state in the user's index is still exactly what it was.
        assert_eq!(
            sh(r, &["diff", "--cached", "--name-only"]).trim(),
            "src/lib.rs"
        );
    }

    #[test]
    fn snapshot_works_on_an_unborn_branch() {
        let repo = Tmp::new("unborn");
        let home = Tmp::new("home");
        sh(&repo.0, &["init", "-q", "-b", "main"]);
        write(&repo.0, "a.txt", "hello\n");
        let out = snapshot(&repo.0, &home.0, "s1", "start", None, now_ms()).unwrap();
        assert!(out.taken);
        assert_eq!(
            sh(&repo.0, &["show", "refs/canopy/turns/s1/1:a.txt"]),
            "hello\n"
        );
        assert!(head_commit(&repo.0).is_none(), "HEAD must stay unborn");
        assert!(
            !repo.0.join(".git/index").exists(),
            "no index may be created"
        );
    }

    #[test]
    fn non_git_directory_reports_no_toplevel() {
        let dir = Tmp::new("plain");
        assert!(toplevel(&dir.0).is_none());
    }

    #[test]
    fn turns_number_in_order_and_stop_closes_the_open_turn() {
        let (repo, home) = fixture();
        let r = &repo.0;
        let s = |k: &str| {
            // Bypass the duplicate-delivery window between deliberate calls.
            forget(&repo.0);
            snapshot(r, &home.0, "s2", k, Some("p"), now_ms()).unwrap()
        };
        assert_eq!(s("start").n, Some(1));
        assert_eq!(s("end").n, Some(1));
        assert_eq!(s("start").n, Some(2));
        assert_eq!(s("end").n, Some(2));
        // A Stop with no open turn becomes its own (end-only) turn.
        assert_eq!(s("end").n, Some(3));
        let l = list(r, &home.0, "s2", now_ms() / 1000).unwrap();
        assert_eq!(l.turns.len(), 3);
        assert!(l.turns[2].start.is_none() && l.turns[2].end.is_some());
        assert_eq!(l.turns[0].prompt.as_deref(), Some("p"));
    }

    #[test]
    fn duplicate_delivery_is_collapsed() {
        let (repo, home) = fixture();
        forget(&repo.0);
        let a = snapshot(&repo.0, &home.0, "dup", "start", None, now_ms()).unwrap();
        let b = snapshot(&repo.0, &home.0, "dup", "start", None, now_ms()).unwrap();
        assert!(a.taken && !b.taken);
    }

    #[test]
    fn restore_brings_back_exact_content_and_removes_files_created_since() {
        let (repo, home) = fixture();
        let r = &repo.0;
        forget(&repo.0);
        snapshot(r, &home.0, "s3", "start", None, now_ms()).unwrap();
        let index_before = std::fs::read(r.join(".git/index")).unwrap();
        // The "turn": edit, delete, create, chmod.
        write(r, "tracked.txt", "agent rewrote this\n");
        std::fs::remove_file(r.join("untracked.txt")).unwrap();
        write(r, "new/dir/created.txt", "by the agent\n");
        write(r, "ignored.log", "agent noise\n");

        let pv = preview(
            r,
            &home.0,
            "s3",
            "refs/canopy/turns/s3/1",
            Scope::All,
            now_ms() / 1000,
        )
        .unwrap();
        let mut paths: Vec<(&str, &str)> = pv
            .plan
            .changes
            .iter()
            .map(|c| (c.path.as_str(), c.status.as_str()))
            .collect();
        paths.sort();
        assert_eq!(
            paths,
            vec![
                ("new/dir/created.txt", "delete"),
                ("tracked.txt", "modify"),
                ("untracked.txt", "add")
            ]
        );
        assert!(pv.patch.contains("agent rewrote this"));

        let out = restore(
            r,
            &home.0,
            "s3",
            "refs/canopy/turns/s3/1",
            Scope::All,
            None,
            now_ms() / 1000,
        )
        .unwrap();
        assert!(out.failed.is_empty(), "{:?}", out.failed);
        assert_eq!(read(r, "tracked.txt").as_deref(), Some("v1 unstaged\n"));
        assert_eq!(read(r, "untracked.txt").as_deref(), Some("new file\n"));
        assert!(!r.join("new/dir/created.txt").exists());
        assert!(!r.join("new").exists(), "emptied directories are tidied");
        // Ignored files are not rollback's business.
        assert_eq!(read(r, "ignored.log").as_deref(), Some("agent noise\n"));
        // The user's index is never written by a restore.
        assert_eq!(std::fs::read(r.join(".git/index")).unwrap(), index_before);

        // And the restore is undoable: the restore point holds the agent's tree.
        let redo = restore(
            r,
            &home.0,
            "s3",
            &out.redo_ref,
            Scope::All,
            None,
            now_ms() / 1000,
        )
        .unwrap();
        assert!(redo.failed.is_empty());
        assert_eq!(
            read(r, "tracked.txt").as_deref(),
            Some("agent rewrote this\n")
        );
        assert_eq!(
            read(r, "new/dir/created.txt").as_deref(),
            Some("by the agent\n")
        );
        assert!(!r.join("untracked.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn restore_keeps_the_executable_bit() {
        use std::os::unix::fs::PermissionsExt;
        let (repo, home) = fixture();
        let r = &repo.0;
        write(r, "run.sh", "#!/bin/sh\necho hi\n");
        std::fs::set_permissions(r.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        forget(&repo.0);
        snapshot(r, &home.0, "x", "start", None, now_ms()).unwrap();
        std::fs::remove_file(r.join("run.sh")).unwrap();
        restore(
            r,
            &home.0,
            "x",
            "refs/canopy/turns/x/1",
            Scope::All,
            None,
            now_ms() / 1000,
        )
        .unwrap();
        let mode = std::fs::metadata(r.join("run.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111);
    }

    #[test]
    fn restore_runs_smudge_filters_like_checkout() {
        let (repo, home) = fixture();
        let r = &repo.0;
        // A clean/smudge pair that upper-cases on clean and lower-cases on
        // smudge: a plain `cat-file blob` would write the cleaned bytes back.
        sh(r, &["config", "filter.shout.clean", "tr a-z A-Z"]);
        sh(r, &["config", "filter.shout.smudge", "tr A-Z a-z"]);
        write(r, ".gitattributes", "*.shout filter=shout\n");
        write(r, "x.shout", "quiet words\n");
        forget(&repo.0);
        snapshot(r, &home.0, "f", "start", None, now_ms()).unwrap();
        assert_eq!(
            sh(r, &["cat-file", "blob", "refs/canopy/turns/f/1:x.shout"]),
            "QUIET WORDS\n"
        );
        write(r, "x.shout", "changed\n");
        restore(
            r,
            &home.0,
            "f",
            "refs/canopy/turns/f/1",
            Scope::All,
            None,
            now_ms() / 1000,
        )
        .unwrap();
        assert_eq!(read(r, "x.shout").as_deref(), Some("quiet words\n"));
    }

    #[test]
    fn restore_honours_autocrlf_round_trip() {
        let (repo, home) = fixture();
        let r = &repo.0;
        sh(r, &["config", "core.autocrlf", "true"]);
        write(r, "win.txt", "line1\r\nline2\r\n");
        forget(&repo.0);
        snapshot(r, &home.0, "c", "start", None, now_ms()).unwrap();
        write(r, "win.txt", "other\r\n");
        restore(
            r,
            &home.0,
            "c",
            "refs/canopy/turns/c/1",
            Scope::All,
            None,
            now_ms() / 1000,
        )
        .unwrap();
        assert_eq!(read(r, "win.txt").as_deref(), Some("line1\r\nline2\r\n"));
    }

    /// A peer digest in the same checkout makes it shared; the journal says
    /// which paths are ours.
    fn make_shared(home: &Path, repo: &Path, ours: &str, our_files: &[&str]) {
        let now = now_ms() / 1000;
        let peer = serde_json::json!({
            "session_id": "peer", "cwd": repo.to_string_lossy(), "updated": now, "state": "working"
        });
        std::fs::write(home.join(".canopy/sessions/peer.json"), peer.to_string()).unwrap();
        let mut journal = String::new();
        for f in our_files {
            journal.push_str(
                &serde_json::json!({"ts": now, "agent": "claude", "path": repo.join(f).to_string_lossy(), "tool": "Write"})
                    .to_string(),
            );
            journal.push('\n');
        }
        std::fs::write(
            home.join(format!(".canopy/sessions/{ours}.edits.jsonl")),
            journal,
        )
        .unwrap();
    }

    #[test]
    fn shared_checkout_restores_only_attributed_paths() {
        let (repo, home) = fixture();
        let r = &repo.0;
        forget(&repo.0);
        snapshot(r, &home.0, "me", "start", None, now_ms()).unwrap();
        // Our agent edits tracked.txt and creates mine.txt; the peer edits
        // src/lib.rs and creates theirs.txt in the same checkout.
        write(r, "tracked.txt", "mine edit\n");
        write(r, "mine.txt", "mine new\n");
        write(r, "src/lib.rs", "peer edit\n");
        write(r, "theirs.txt", "peer new\n");
        make_shared(&home.0, r, "me", &["tracked.txt", "mine.txt"]);

        let l = list(r, &home.0, "me", now_ms() / 1000).unwrap();
        assert!(l.shared);
        assert_eq!(l.peers, vec!["peer".to_string()]);

        let out = restore(
            r,
            &home.0,
            "me",
            "refs/canopy/turns/me/1",
            Scope::Auto,
            None,
            now_ms() / 1000,
        )
        .unwrap();
        assert_eq!(read(r, "tracked.txt").as_deref(), Some("v1 unstaged\n"));
        assert!(!r.join("mine.txt").exists());
        // The peer's work is untouched and reported as excluded.
        assert_eq!(read(r, "src/lib.rs").as_deref(), Some("peer edit\n"));
        assert_eq!(read(r, "theirs.txt").as_deref(), Some("peer new\n"));
        let mut ex = out.excluded.clone();
        ex.sort();
        assert_eq!(ex, vec!["src/lib.rs".to_string(), "theirs.txt".to_string()]);

        // Explicit "all" overrides the scoping.
        write(r, "tracked.txt", "again\n");
        restore(
            r,
            &home.0,
            "me",
            "refs/canopy/turns/me/1",
            Scope::All,
            None,
            now_ms() / 1000,
        )
        .unwrap();
        assert_eq!(
            read(r, "src/lib.rs").as_deref(),
            Some("fn a() { staged }\n")
        );
        assert!(!r.join("theirs.txt").exists());
    }

    #[test]
    fn a_peer_in_another_worktree_does_not_make_the_checkout_shared() {
        let (repo, home) = fixture();
        let r = &repo.0;
        let wt = r.join(".claude/worktrees/w1");
        sh(
            r,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "feature"],
        );
        let now = now_ms() / 1000;
        let peer = serde_json::json!({"session_id": "peer", "cwd": wt.to_string_lossy(), "updated": now, "state": "working"});
        std::fs::write(home.0.join(".canopy/sessions/peer.json"), peer.to_string()).unwrap();
        assert!(other_active_sessions(&home.0, "me", r, now).is_empty());
        // …but it does share its own worktree with a session there.
        assert_eq!(
            other_active_sessions(&home.0, "me", &wt, now),
            vec!["peer".to_string()]
        );
    }

    #[test]
    fn late_start_snapshot_is_flagged_from_the_journal() {
        let (repo, home) = fixture();
        let observed = now_ms();
        std::fs::write(
            home.0.join(".canopy/sessions/late.edits.jsonl"),
            format!(
                "{}\n",
                serde_json::json!({"ts": observed / 1000, "path": "/x", "tool": "Edit"})
            ),
        )
        .unwrap();
        forget(&repo.0);
        let out = snapshot(&repo.0, &home.0, "late", "start", None, observed).unwrap();
        assert!(out.late);
        // An old edit (a previous turn) does not count.
        forget(&repo.0);
        let out = snapshot(&repo.0, &home.0, "late", "start", None, observed + 10_000).unwrap();
        assert!(!out.late);
    }

    #[test]
    fn retention_keeps_the_newest_turns_and_drops_old_ones() {
        let (repo, home) = fixture();
        let r = &repo.0;
        forget(&repo.0);
        snapshot(r, &home.0, "keep", "start", None, now_ms()).unwrap();
        let commit = sh(r, &["rev-parse", "refs/canopy/turns/keep/1"])
            .trim()
            .to_string();
        // Fabricate MAX_TURNS + 5 turns cheaply (same commit, new names).
        let mut script = String::new();
        for n in 2..=(MAX_TURNS as u64 + 5) {
            script.push_str(&format!("create refs/canopy/turns/keep/{n} {commit}\n"));
        }
        script.push_str(&format!("create refs/canopy/turn-ends/keep/3 {commit}\n"));
        run_bytes(
            git(r).args(["update-ref", "--stdin"]),
            Some(script.as_bytes()),
        )
        .unwrap();
        let now = now_ms() / 1000;
        let gone = prune(r, "keep", now).unwrap();
        assert_eq!(gone.len(), 6, "{gone:?}"); // starts 1..=5 and end 3
        let l = list(r, &home.0, "keep", now).unwrap();
        assert_eq!(l.turns.len(), MAX_TURNS);
        assert_eq!(l.turns.first().unwrap().n, 6);

        // Age: everything older than 30 days goes, for every session.
        let gone = prune(r, "other-session", now + MAX_AGE_SECS + 120).unwrap();
        assert_eq!(gone.len(), MAX_TURNS);
        assert!(list(r, &home.0, "keep", now).unwrap().turns.is_empty());
        // Branches survived all of it.
        assert!(sh(r, &["for-each-ref", "refs/heads"]).contains("refs/heads/feature"));
    }

    #[test]
    fn restore_refuses_foreign_refs() {
        let (repo, home) = fixture();
        let r = &repo.0;
        assert!(restore(r, &home.0, "s", "refs/heads/main", Scope::All, None, 0).is_err());
        assert!(restore(
            r,
            &home.0,
            "s",
            "refs/canopy/turns/other/1",
            Scope::All,
            None,
            0
        )
        .is_err());
        assert!(snapshot(r, &home.0, "../evil", "start", None, 0).is_err());
    }

    /// Live end-to-end check against a real, signed-in `claude` (ignored by
    /// default; run with `CANOPY_LIVE_CLAUDE=1 cargo test --lib live_claude --
    /// --ignored --nocapture`). Claude's real UserPromptSubmit/Stop/PreToolUse
    /// hook payloads are appended to a file, which this test polls every
    /// 500 ms exactly like the app's hook bridge, snapshotting off each
    /// boundary while Claude keeps working — the production timing, race and
    /// all. Then: restore turn 1 with the native rewind first.
    #[test]
    #[ignore]
    fn live_claude_turns_snapshot_and_restore() {
        if std::env::var("CANOPY_LIVE_CLAUDE").as_deref() != Ok("1") {
            return;
        }
        use std::io::{BufRead, BufReader};
        let (repo, home) = fixture();
        let r = repo.0.clone();
        let events = home.0.join("hook-events.jsonl");
        let log = format!(
            "python3 -c 'import sys,json,time; d=json.load(sys.stdin); d[\"_ms\"]=int(time.time()*1000); print(json.dumps(d))' >> {}",
            events.display()
        );
        let hook = serde_json::json!([{ "hooks": [{ "type": "command", "command": log }] }]);
        let settings = serde_json::json!({ "hooks": {
            "UserPromptSubmit": hook, "Stop": hook, "PreToolUse": hook
        }});
        let session = format!(
            "{:08x}-0000-4000-8000-{:012x}",
            std::process::id(),
            now_ms() & 0xffff_ffff_ffff
        );
        let mut child = Command::new(crate::procenv::resolve_command("claude"))
            .current_dir(&r)
            .env_remove("CANOPY")
            .env("CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING", "true")
            .args([
                "-p",
                "--input-format",
                "stream-json",
                "--output-format",
                "stream-json",
                "--verbose",
                "--replay-user-messages",
                "--session-id",
                &session,
                "--permission-mode",
                "acceptEdits",
                "--allowedTools",
                "Bash",
                "--settings",
                &settings.to_string(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("claude on PATH");
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(v) = serde_json::from_str(&line) {
                    let _ = tx.send(v);
                }
            }
        });
        let say = |stdin: &mut std::process::ChildStdin, text: &str| {
            let msg = serde_json::json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":text}]}});
            writeln!(stdin, "{msg}").unwrap();
        };
        say(&mut stdin, "Use the Write tool to overwrite tracked.txt with the single word: agent. Then run this exact Bash command: echo bash > made_by_bash.txt. Then reply done.");
        let (mut results, mut uuids, mut offset, mut pre_tool_ms) =
            (0, Vec::new(), 0usize, Vec::new());
        let deadline = Instant::now() + Duration::from_secs(300);
        let mut stdin = Some(stdin);
        while results < 2 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(500)); // the bridge's poll
            while let Ok(v) = rx.try_recv() {
                if v["type"] == "user" && v["isReplay"] == true {
                    uuids.push(v["uuid"].as_str().unwrap().to_string());
                    record_native(&home.0, &session, uuids.last().unwrap(), now_ms()).unwrap();
                }
                if v["type"] == "result" {
                    results += 1;
                    if results == 1 {
                        say(stdin.as_mut().unwrap(), "Use the Write tool to overwrite tracked.txt with the single word: second. Then reply done.");
                    } else {
                        stdin.take();
                    }
                }
            }
            let raw = std::fs::read_to_string(&events).unwrap_or_default();
            for line in raw[offset.min(raw.len())..].lines() {
                let v: serde_json::Value = serde_json::from_str(line).unwrap();
                let name = v["hook_event_name"].as_str().unwrap_or("");
                let observed = now_ms();
                match name {
                    "UserPromptSubmit" | "Stop" => {
                        let kind = if name == "Stop" { "end" } else { "start" };
                        forget(&r);
                        let out =
                            snapshot(&r, &home.0, &session, kind, v["prompt"].as_str(), observed)
                                .unwrap();
                        eprintln!(
                            "live: {name} hook@{} seen@{observed} snapshot done@{} -> {:?} late={}",
                            v["_ms"],
                            now_ms(),
                            out.refname,
                            out.late
                        );
                    }
                    "PreToolUse" => {
                        eprintln!("live: PreToolUse {} @{}", v["tool_name"], v["_ms"]);
                        pre_tool_ms.push(v["_ms"].as_u64().unwrap_or(0));
                    }
                    _ => {}
                }
            }
            offset = raw.len();
        }
        let _ = child.wait();
        assert_eq!(results, 2, "claude did not finish two turns");
        assert_eq!(uuids.len(), 2, "replayed prompt uuids: {uuids:?}");

        let l = list(&r, &home.0, &session, now_ms() / 1000).unwrap();
        assert_eq!(l.turns.len(), 2, "{l:?}");
        let t1 = &l.turns[0];
        assert_eq!(t1.native_uuid.as_deref(), Some(uuids[0].as_str()));
        let start1 = t1.start.as_ref().unwrap();
        let end1 = t1.end.as_ref().unwrap();
        let show = |rev: &str| {
            Command::new("git")
                .arg("-C")
                .arg(&r)
                .args(["show", rev])
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
                .unwrap_or_default()
        };
        eprintln!(
            "live: start1 tracked.txt = {:?} (late={})",
            show(&format!("{}:tracked.txt", start1.refname)),
            t1.late
        );
        assert_eq!(
            show(&format!("{}:tracked.txt", end1.refname)).trim(),
            "agent"
        );
        assert_eq!(
            show(&format!("{}:made_by_bash.txt", end1.refname)).trim(),
            "bash"
        );
        assert_eq!(
            read(&r, "tracked.txt").as_deref().map(str::trim),
            Some("second")
        );

        // Undo turn 1: native rewind first, then the snapshot covers the Bash file.
        let out = restore(
            &r,
            &home.0,
            &session,
            &start1.refname,
            Scope::All,
            Some(("claude", uuids[0].as_str())),
            now_ms() / 1000,
        )
        .unwrap();
        eprintln!("live: restore -> {out:?}");
        assert!(out.native.ok, "native rewind: {}", out.native.message);
        assert_eq!(read(&r, "tracked.txt").as_deref(), Some("v1 unstaged\n"));
        assert!(
            !r.join("made_by_bash.txt").exists(),
            "Bash-made file must go"
        );
    }

    #[test]
    fn native_checkpoints_pair_with_the_nearest_turn_in_order() {
        let cps = vec![
            NativeCheckpoint {
                uuid: "a".into(),
                ts_ms: 1_000,
            },
            NativeCheckpoint {
                uuid: "b".into(),
                ts_ms: 30_500,
            },
            NativeCheckpoint {
                uuid: "c".into(),
                ts_ms: 500_000,
            },
        ];
        let p = pair_native(&[(1, 1_400), (2, 30_000), (3, 200_000)], &cps, 60_000);
        assert_eq!(p.get(&1).map(String::as_str), Some("a"));
        assert_eq!(p.get(&2).map(String::as_str), Some("b"));
        assert!(p.get(&3).is_none(), "c is outside the window");
    }

    #[test]
    fn native_checkpoints_round_trip_through_the_list() {
        let (repo, home) = fixture();
        forget(&repo.0);
        let observed = now_ms();
        snapshot(&repo.0, &home.0, "nat", "start", None, observed).unwrap();
        record_native(
            &home.0,
            "nat",
            "2748084d-4288-4316-bfb9-6ae8954e3e20",
            observed + 300,
        )
        .unwrap();
        assert!(record_native(&home.0, "nat", "not a uuid!", 0).is_err());
        let l = list(&repo.0, &home.0, "nat", observed / 1000).unwrap();
        assert_eq!(
            l.turns[0].native_uuid.as_deref(),
            Some("2748084d-4288-4316-bfb9-6ae8954e3e20")
        );
    }
}

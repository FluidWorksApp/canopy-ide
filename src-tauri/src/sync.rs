//! Branch sync: keeping a feature branch current with the branch it was cut
//! from, and finding out about conflicts while they are still cheap to fix.
//!
//! The gap this closes is the one every branch has: from the moment you cut it
//! to the moment you open a PR, the base branch keeps moving and nothing tells
//! you. The first news of a conflict arrives from the PR page, days of work
//! later, when the offending change is no longer fresh in anyone's memory.
//!
//! Two rules shape everything here:
//!
//!   * **The probe never writes.** `git merge-tree --write-tree` performs the
//!     whole three-way merge in the object store and hands back a tree — the
//!     worktree, the index and HEAD are not touched, and nothing is left to
//!     clean up. So we can answer "would this conflict?" on a timer, while the
//!     user is mid-edit, without them ever knowing we asked.
//!   * **Only `apply` writes, and only when asked.** Merging is a decision
//!     about someone's working state, so it happens on an explicit click,
//!     never on a poll. We merge rather than rebase: a merge leaves every
//!     existing commit exactly where it is, which is the only behaviour that
//!     is safe on a branch a teammate — or an agent in a worktree — may also
//!     be holding.

use crate::fsx::WorkspaceManager;
use crate::git::{default_base, git, head_branch, repo_path, run, run_net};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

/// Incoming commit subjects carried back for the "what's coming" line. A
/// long-neglected branch can be hundreds behind; the UI only shows a handful.
const SUBJECT_LIMIT: usize = 8;

/// Conflicting paths carried back. A merge that conflicts in more files than
/// this is not a list to read — it is a "this branch has drifted" verdict.
const CONFLICT_LIMIT: usize = 50;

/// What the branch can do about its base right now.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum SyncState {
    /// Nothing on the base that isn't already here.
    Current,
    /// Behind, and the merge would apply without conflicts.
    Clean,
    /// Behind, and the merge would stop on conflicts (`conflicts` names them).
    Conflict,
    /// Behind, but this git can't dry-run a merge (`merge-tree --write-tree`
    /// needs 2.38+). We report the gap and let the user decide blind rather
    /// than claim a cleanliness we didn't verify.
    Unknown,
    /// A merge can't be offered at all — see `blocked` for why.
    Blocked,
}

#[derive(Serialize, Clone, Debug)]
pub struct SyncProbe {
    pub repo: String,
    /// None when HEAD is detached.
    pub branch: Option<String>,
    /// The ref we measure against, e.g. `origin/main`.
    pub base: String,
    /// Base tip commit. The UI keys "already asked about this" on it, so a
    /// dismissal lasts until the base actually moves again.
    pub base_head: String,
    /// Commits on the base that this branch doesn't have.
    pub behind: u32,
    /// Commits here that the base doesn't have.
    pub ahead: u32,
    /// Uncommitted files in the worktree (tracked or not).
    pub dirty: u32,
    pub state: SyncState,
    /// Paths the merge would conflict in, capped at `CONFLICT_LIMIT`.
    pub conflicts: Vec<String>,
    /// Files the incoming commits touch that also have uncommitted edits here.
    /// Not a conflict — a warning that `git merge` will refuse to start until
    /// they're committed or stashed.
    pub overlap: Vec<String>,
    /// Newest-first subjects of the incoming commits, capped.
    pub subjects: Vec<String>,
    /// Why no merge can be offered (detached HEAD, a merge already in
    /// progress, sitting on the base branch itself).
    pub blocked: Option<String>,
    /// The fetch failed — offline, no credentials, remote down. The counts
    /// below are then from whatever we last fetched, not from the remote as
    /// it is now, and the UI says so rather than pretending to be current.
    pub fetch_error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct SyncOutcome {
    /// The merge completed and the branch now contains the base.
    pub merged: bool,
    /// Paths left with conflict markers for the user to resolve. Non-empty
    /// only when `merged` is false and the merge actually started.
    pub conflicts: Vec<String>,
    /// git's own first line — "Fast-forward", "Merge made by the 'ort'
    /// strategy", or the reason it stopped.
    pub message: String,
}

/// The real git directory, following the `.git` *file* a worktree has instead
/// of a directory. In-progress merge state lives per worktree, so resolving
/// this correctly is what keeps one agent's half-finished merge from reading
/// as everyone else's.
fn git_dir(top: &Path) -> Option<PathBuf> {
    let out = run(git(top).args(["rev-parse", "--absolute-git-dir"])).ok()?;
    let p = PathBuf::from(out.trim());
    p.is_dir().then_some(p)
}

/// A merge, rebase, cherry-pick or bisect already underway. Offering to merge
/// on top of one would compound a mess the user is already in the middle of.
fn in_progress(top: &Path) -> Option<String> {
    let dir = git_dir(top)?;
    for (file, what) in [
        ("MERGE_HEAD", "a merge"),
        ("rebase-merge", "a rebase"),
        ("rebase-apply", "a rebase"),
        ("CHERRY_PICK_HEAD", "a cherry-pick"),
        ("REVERT_HEAD", "a revert"),
        ("BISECT_LOG", "a bisect"),
    ] {
        if dir.join(file).exists() {
            return Some(format!("{what} is already in progress here"));
        }
    }
    None
}

/// NUL-separated fields, empties dropped. `-z` everywhere: paths can contain
/// newlines, and a path that breaks the parser is a path we'd merge blind.
fn nul_fields(raw: &str) -> impl Iterator<Item = &str> {
    raw.split('\0').filter(|s| !s.is_empty())
}

/// Uncommitted paths, ignored files excluded (porcelain omits them by default).
fn dirty_paths(top: &Path) -> Vec<String> {
    let Ok(raw) = run(git(top).args(["status", "--porcelain", "-z"])) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut parts = raw.split('\0');
    while let Some(part) = parts.next() {
        if part.len() < 4 {
            continue;
        }
        let code: Vec<char> = part[..2].chars().collect();
        // A rename carries its origin path in the next field — consume it so
        // it isn't read as a status line of its own.
        if code[0] == 'R' || code[0] == 'C' {
            parts.next();
        }
        out.push(part[3..].to_string());
    }
    out
}

/// Does this git have `merge-tree --write-tree`? Exit status tells us apart:
/// 0 clean, 1 conflicts, anything else (129 usage, 128 fatal) means we cannot
/// trust the answer.
enum DryRun {
    Clean,
    Conflicts(Vec<String>),
    Unsupported,
}

/// Merge HEAD with `base` entirely in the object store. Nothing on disk moves:
/// this is the whole reason the watcher can run on a timer.
fn dry_run_merge(top: &Path, base: &str) -> DryRun {
    let out = crate::process_capture::output(
        git(top).args([
            "merge-tree",
            "--write-tree",
            "--name-only",
            "--no-messages",
            "-z",
            "HEAD",
            base,
        ]),
        crate::process_capture::DEFAULT_STREAM_MAX,
    );
    let Ok(out) = out else {
        return DryRun::Unsupported;
    };
    match out.status.code() {
        Some(0) => DryRun::Clean,
        Some(1) => {
            let raw = String::from_utf8_lossy(&out.stdout);
            // First field is the resulting tree's oid; the rest are the
            // conflicted paths.
            let files: Vec<String> = nul_fields(&raw)
                .skip(1)
                .take(CONFLICT_LIMIT)
                .map(str::to_string)
                .collect();
            DryRun::Conflicts(files)
        }
        _ => DryRun::Unsupported,
    }
}

/// Everything the UI needs to decide whether to ask the user anything, without
/// touching the working tree. Safe to call on a timer.
pub(crate) fn probe(
    top: &Path,
    fetch: bool,
    base_override: Option<&str>,
) -> Result<SyncProbe, String> {
    let (branch, detached) = head_branch(top);

    let base = match base_override.map(str::trim).filter(|s| !s.is_empty()) {
        Some(b) => b.to_string(),
        None => default_base(top),
    };

    // Refresh the remote's side before measuring. A failure here is not fatal:
    // on a plane, the honest answer is the last known state plus a note that
    // it may be stale — not an error that hides the branch's status entirely.
    let mut fetch_error = None;
    if fetch {
        if let Some((remote, _)) = base.split_once('/') {
            let mut cmd = git(top);
            cmd.args(["fetch", "--quiet", "--prune", remote]);
            if let Err(e) = run_net(&mut cmd) {
                fetch_error = Some(e);
            }
        }
    }

    let base_head = run(git(top).args([
        "rev-parse",
        "--verify",
        "--quiet",
        &format!("{base}^{{commit}}"),
    ]))
    .map(|s| s.trim().to_string())
    .map_err(|_| format!("base branch \"{base}\" doesn't exist in this repository"))?;
    if base_head.is_empty() {
        return Err(format!(
            "base branch \"{base}\" doesn't exist in this repository"
        ));
    }

    // `A...B` with --left-right: left = ours only (ahead), right = theirs only
    // (behind). Both are measured from the merge base, which is exactly the
    // "since I cut the branch" the user has in mind.
    let (mut ahead, mut behind) = (0u32, 0u32);
    if let Ok(counts) = run(git(top).args([
        "rev-list",
        "--left-right",
        "--count",
        &format!("HEAD...{base}"),
    ])) {
        let mut it = counts.split_whitespace();
        ahead = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        behind = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    }

    let dirty = dirty_paths(top);

    let mut probe = SyncProbe {
        repo: top.to_string_lossy().to_string(),
        branch: branch.clone(),
        base: base.clone(),
        base_head,
        behind,
        ahead,
        dirty: dirty.len() as u32,
        state: SyncState::Current,
        conflicts: Vec::new(),
        overlap: Vec::new(),
        subjects: Vec::new(),
        blocked: None,
        fetch_error,
    };

    // Reasons a merge can't be offered. Reported, not thrown: the branch bar
    // still wants to show how far behind you are while you finish the merge
    // you're already in.
    let blocked = if detached {
        Some("HEAD is detached — check out a branch to merge into".to_string())
    } else if branch.as_deref() == Some(base.rsplit('/').next().unwrap_or(&base)) && behind == 0 {
        // Sitting on the base branch itself: `git pull` is the tool, not this.
        Some(format!("this is the {base} branch itself"))
    } else {
        in_progress(top)
    };
    if blocked.is_some() {
        probe.blocked = blocked;
        probe.state = if behind == 0 {
            SyncState::Current
        } else {
            SyncState::Blocked
        };
        return Ok(probe);
    }

    if behind == 0 {
        return Ok(probe);
    }

    probe.subjects = run(git(top).args([
        "log",
        "--no-merges",
        "--format=%s",
        &format!("-{SUBJECT_LIMIT}"),
        &format!("HEAD..{base}"),
    ]))
    .map(|s| s.lines().map(str::to_string).collect())
    .unwrap_or_default();

    // Files the incoming work touches that you've also edited but not
    // committed. git refuses to start a merge over these, so naming them turns
    // "error: Your local changes would be overwritten" into something the user
    // can act on before clicking anything.
    if !dirty.is_empty() {
        if let Ok(raw) =
            run(git(top).args(["diff", "--name-only", "-z", &format!("HEAD...{base}")]))
        {
            let incoming: std::collections::HashSet<&str> = nul_fields(&raw).collect();
            probe.overlap = dirty
                .iter()
                .filter(|p| incoming.contains(p.as_str()))
                .take(CONFLICT_LIMIT)
                .cloned()
                .collect();
        }
    }

    probe.state = match dry_run_merge(top, &base) {
        DryRun::Clean => SyncState::Clean,
        DryRun::Conflicts(files) => {
            probe.conflicts = files;
            SyncState::Conflict
        }
        DryRun::Unsupported => SyncState::Unknown,
    };

    Ok(probe)
}

/// Merge `base` into the current branch. The only writing operation here, and
/// it runs on an explicit click.
///
/// Three outcomes, all recoverable: merged; started but stopped on conflicts
/// (files carry markers, `sync_abort` undoes it); or refused before touching
/// anything, in which case git's own message is the error.
pub(crate) fn apply(top: &Path, base: &str) -> Result<SyncOutcome, String> {
    let (branch, detached) = head_branch(top);
    if detached {
        return Err("HEAD is detached — check out a branch before merging".into());
    }
    let branch = branch.ok_or("no current branch to merge into")?;
    if let Some(reason) = in_progress(top) {
        return Err(format!("can't merge: {reason}"));
    }
    let base = base.trim();
    if base.is_empty() {
        return Err("no base branch to merge from".into());
    }
    if base == branch {
        return Err("that's the branch you're on".into());
    }
    run(git(top).args([
        "rev-parse",
        "--verify",
        "--quiet",
        &format!("{base}^{{commit}}"),
    ]))
    .map_err(|_| format!("base branch \"{base}\" doesn't exist in this repository"))?;

    // --no-edit: take git's own merge message rather than opening an editor
    // there is no terminal for. Fast-forward stays enabled, so a branch with
    // no commits of its own just moves up without a merge commit.
    let out = crate::process_capture::output(
        git(top).args(["merge", "--no-edit", base]),
        crate::process_capture::DEFAULT_STREAM_MAX,
    )?;
    crate::process_capture::reject_truncated(&out, "git merge")?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();

    if out.status.success() {
        return Ok(SyncOutcome {
            merged: true,
            conflicts: Vec::new(),
            message: first_line(&stdout).unwrap_or_else(|| format!("Merged {base} into {branch}")),
        });
    }

    // Unmerged paths mean the merge started and stopped: the worktree now
    // holds conflict markers and MERGE_HEAD, which is a state the user asked
    // for. No unmerged paths means git refused before writing anything.
    let conflicts: Vec<String> =
        run(git(top).args(["diff", "--name-only", "--diff-filter=U", "-z"]))
            .map(|raw| {
                nul_fields(&raw)
                    .take(CONFLICT_LIMIT)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

    if conflicts.is_empty() {
        return Err(if stderr.is_empty() { stdout } else { stderr });
    }
    Ok(SyncOutcome {
        merged: false,
        conflicts,
        message: first_line(&stderr)
            .or_else(|| first_line(&stdout))
            .unwrap_or_else(|| "merge stopped on conflicts".into()),
    })
}

fn first_line(s: &str) -> Option<String> {
    s.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// Back out of a conflicted merge, restoring the pre-merge worktree. The escape
/// hatch that makes "resolve now" a safe thing to click.
pub(crate) fn abort(top: &Path) -> Result<String, String> {
    if git_dir(top)
        .map(|d| !d.join("MERGE_HEAD").exists())
        .unwrap_or(false)
    {
        return Err("no merge in progress".into());
    }
    run(git(top).args(["merge", "--abort"]))
        .map(|_| "Merge aborted — your branch is back as it was".into())
}

// ---------- commands ----------

#[tauri::command]
pub async fn git_sync_probe(
    state: State<'_, WorkspaceManager>,
    repo: String,
    fetch: bool,
    base: Option<String>,
) -> Result<SyncProbe, String> {
    let top = repo_path(&state, &repo)?;
    probe(&top, fetch, base.as_deref())
}

#[tauri::command]
pub async fn git_sync_apply(
    state: State<'_, WorkspaceManager>,
    repo: String,
    base: String,
) -> Result<SyncOutcome, String> {
    let top = repo_path(&state, &repo)?;
    apply(&top, &base)
}

#[tauri::command]
pub async fn git_sync_abort(
    state: State<'_, WorkspaceManager>,
    repo: String,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    abort(&top)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A throwaway repo with a base branch and a feature branch cut from it.
    /// Real git, real commits — the whole point is to test what git actually
    /// does with these arguments, which a mock could only guess at.
    struct Fixture {
        dir: PathBuf,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    impl Fixture {
        fn git(&self, args: &[&str]) -> String {
            let out = git(&self.dir).args(args).output().expect("git runs");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }

        fn write(&self, name: &str, body: &str) {
            std::fs::write(self.dir.join(name), body).unwrap();
        }

        fn commit(&self, msg: &str) {
            self.git(&["add", "-A"]);
            self.git(&["commit", "-m", msg]);
        }

        /// main has `f.txt` = a/b/c and `g.txt`; `feat` is cut from it.
        fn new() -> Self {
            let n = SEQ.fetch_add(1, Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("canopy-sync-test-{}-{n}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let f = Fixture { dir };
            f.git(&["init", "-q", "-b", "main"]);
            // Identity lives in the repo, not in this process's environment:
            // the merge under test is git run by `apply`, and it needs a
            // committer too. A machine without a global identity — CI — has
            // no other source for one.
            f.git(&["config", "user.name", "t"]);
            f.git(&["config", "user.email", "t@example.invalid"]);
            f.write("f.txt", "a\nb\nc\n");
            f.write("g.txt", "one\n");
            f.commit("base");
            f.git(&["checkout", "-q", "-b", "feat"]);
            f
        }

        /// Move main forward without leaving `feat`, the way a teammate's push
        /// arrives: the branch you're on never moves.
        fn advance_main(&self, file: &str, body: &str, msg: &str) {
            let head = self.git(&["rev-parse", "HEAD"]);
            let cur = self.git(&["rev-parse", "--abbrev-ref", "HEAD"]);
            self.git(&["checkout", "-q", "main"]);
            self.write(file, body);
            self.commit(msg);
            self.git(&["checkout", "-q", &cur]);
            assert_eq!(self.git(&["rev-parse", "HEAD"]), head, "feat must not move");
        }
    }

    #[test]
    fn reports_current_when_base_has_not_moved() {
        let f = Fixture::new();
        let p = probe(&f.dir, false, Some("main")).unwrap();
        assert_eq!(p.state, SyncState::Current);
        assert_eq!(p.behind, 0);
        assert!(p.subjects.is_empty(), "nothing incoming to describe");
    }

    #[test]
    fn clean_when_incoming_commits_touch_other_files() {
        let f = Fixture::new();
        f.write("h.txt", "mine\n");
        f.commit("feat work");
        f.advance_main("g.txt", "two\n", "teammate edits g");

        let p = probe(&f.dir, false, Some("main")).unwrap();
        assert_eq!(p.state, SyncState::Clean);
        assert_eq!((p.ahead, p.behind), (1, 1));
        assert_eq!(p.subjects, vec!["teammate edits g"]);
        assert!(p.conflicts.is_empty());
    }

    #[test]
    fn conflict_names_the_file_without_touching_the_worktree() {
        let f = Fixture::new();
        f.write("f.txt", "a\nMINE\nc\n");
        f.commit("my edit");
        f.advance_main("f.txt", "a\nTHEIRS\nc\n", "their edit");

        let before = std::fs::read_to_string(f.dir.join("f.txt")).unwrap();
        let p = probe(&f.dir, false, Some("main")).unwrap();

        assert_eq!(p.state, SyncState::Conflict);
        assert_eq!(p.conflicts, vec!["f.txt"]);
        // The whole promise of the probe: asking cost the user nothing.
        assert_eq!(
            std::fs::read_to_string(f.dir.join("f.txt")).unwrap(),
            before
        );
        assert!(
            f.git(&["status", "--porcelain"]).is_empty(),
            "worktree stays clean"
        );
        assert!(
            !f.dir.join(".git").join("MERGE_HEAD").exists(),
            "no merge started"
        );
    }

    #[test]
    fn probing_repeatedly_is_stable() {
        let f = Fixture::new();
        f.write("f.txt", "a\nMINE\nc\n");
        f.commit("my edit");
        f.advance_main("f.txt", "a\nTHEIRS\nc\n", "their edit");
        let head = f.git(&["rev-parse", "HEAD"]);
        for _ in 0..3 {
            assert_eq!(
                probe(&f.dir, false, Some("main")).unwrap().state,
                SyncState::Conflict
            );
        }
        assert_eq!(f.git(&["rev-parse", "HEAD"]), head);
    }

    #[test]
    fn apply_merges_cleanly_and_keeps_existing_commits() {
        let f = Fixture::new();
        f.write("h.txt", "mine\n");
        f.commit("feat work");
        let mine = f.git(&["rev-parse", "HEAD"]);
        f.advance_main("g.txt", "two\n", "teammate edits g");

        let out = apply(&f.dir, "main").unwrap();
        assert!(out.merged, "{}", out.message);
        assert!(out.conflicts.is_empty());
        // Merge, not rebase: the commit I already pushed still exists.
        assert!(
            f.git(&["merge-base", "--is-ancestor", &mine, "HEAD"])
                .is_empty()
                && f.git(&["cat-file", "-t", &mine]) == "commit",
            "my commit must survive untouched"
        );
        assert_eq!(
            std::fs::read_to_string(f.dir.join("g.txt")).unwrap(),
            "two\n"
        );
        assert_eq!(
            probe(&f.dir, false, Some("main")).unwrap().state,
            SyncState::Current
        );
    }

    #[test]
    fn apply_fast_forwards_when_branch_has_no_commits_of_its_own() {
        let f = Fixture::new();
        f.advance_main("g.txt", "two\n", "teammate edits g");
        let out = apply(&f.dir, "main").unwrap();
        assert!(out.merged);
        // A fast-forward leaves no merge commit behind to explain later.
        assert_eq!(f.git(&["rev-parse", "HEAD"]), f.git(&["rev-parse", "main"]));
        assert_eq!(f.git(&["rev-list", "--count", "--merges", "HEAD"]), "0");
    }

    #[test]
    fn apply_on_conflict_reports_files_and_can_be_aborted() {
        let f = Fixture::new();
        f.write("f.txt", "a\nMINE\nc\n");
        f.commit("my edit");
        let before = f.git(&["rev-parse", "HEAD"]);
        f.advance_main("f.txt", "a\nTHEIRS\nc\n", "their edit");

        let out = apply(&f.dir, "main").unwrap();
        assert!(!out.merged);
        assert_eq!(out.conflicts, vec!["f.txt"]);
        assert!(f.dir.join(".git").join("MERGE_HEAD").exists());
        assert!(std::fs::read_to_string(f.dir.join("f.txt"))
            .unwrap()
            .contains("<<<<<<<"));

        abort(&f.dir).unwrap();
        assert_eq!(
            f.git(&["rev-parse", "HEAD"]),
            before,
            "abort restores the branch"
        );
        assert_eq!(
            std::fs::read_to_string(f.dir.join("f.txt")).unwrap(),
            "a\nMINE\nc\n"
        );
        assert!(!f.dir.join(".git").join("MERGE_HEAD").exists());
    }

    #[test]
    fn uncommitted_edits_to_incoming_files_are_reported_as_overlap() {
        let f = Fixture::new();
        f.advance_main("g.txt", "two\n", "teammate edits g");
        f.write("g.txt", "my uncommitted g\n");

        let p = probe(&f.dir, false, Some("main")).unwrap();
        assert_eq!(p.overlap, vec!["g.txt"], "the file git will refuse over");
        assert_eq!(p.dirty, 1);
    }

    #[test]
    fn apply_refuses_without_writing_when_local_changes_are_in_the_way() {
        let f = Fixture::new();
        f.advance_main("g.txt", "two\n", "teammate edits g");
        f.write("g.txt", "my uncommitted g\n");
        let before = f.git(&["rev-parse", "HEAD"]);

        let err = apply(&f.dir, "main").unwrap_err();
        assert!(err.to_lowercase().contains("local changes"), "got: {err}");
        // Refused before starting: my edit is still exactly where I left it.
        assert_eq!(
            std::fs::read_to_string(f.dir.join("g.txt")).unwrap(),
            "my uncommitted g\n"
        );
        assert_eq!(f.git(&["rev-parse", "HEAD"]), before);
        assert!(!f.dir.join(".git").join("MERGE_HEAD").exists());
    }

    #[test]
    fn a_merge_already_in_progress_blocks_instead_of_compounding() {
        let f = Fixture::new();
        f.write("f.txt", "a\nMINE\nc\n");
        f.commit("my edit");
        f.advance_main("f.txt", "a\nTHEIRS\nc\n", "their edit");
        apply(&f.dir, "main").unwrap();

        let p = probe(&f.dir, false, Some("main")).unwrap();
        assert_eq!(p.state, SyncState::Blocked);
        assert!(p.blocked.unwrap().contains("merge"));
        assert!(
            apply(&f.dir, "main").is_err(),
            "must not merge on top of a merge"
        );
    }

    #[test]
    fn detached_head_blocks() {
        let f = Fixture::new();
        f.advance_main("g.txt", "two\n", "teammate edits g");
        let head = f.git(&["rev-parse", "HEAD"]);
        f.git(&["checkout", "-q", &head]);

        let p = probe(&f.dir, false, Some("main")).unwrap();
        assert_eq!(p.state, SyncState::Blocked);
        assert!(apply(&f.dir, "main").is_err());
    }

    #[test]
    fn missing_base_is_an_error_not_a_silent_zero() {
        let f = Fixture::new();
        assert!(probe(&f.dir, false, Some("origin/nope")).is_err());
    }
}

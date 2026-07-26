//! Native git repository management.
//!
//! Everything shells out to the system `git` (and `gh` for pull requests)
//! rather than linking libgit2: no new dependency, and it inherits the user's
//! existing config, credential helpers, hooks and SSH keys — the same git they
//! already trust from the terminal.
//!
//! Two invariants throughout:
//!   * every repo path is validated against the workspace scope, so the UI can
//!     never drive git against a directory the user hasn't opened;
//!   * `GIT_TERMINAL_PROMPT=0` — a GUI app has no TTY, so a credential prompt
//!     would hang the command forever. Failing fast with git's own error is the
//!     honest outcome.

use crate::winproc::NoConsoleWindow;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::State;

use crate::fsx::{check_scope, WorkspaceManager};

/// Network operations get a ceiling so a stalled remote can't wedge a worker
/// thread for the life of the app.
const NET_TIMEOUT_SECS: u64 = 120;

#[derive(Serialize, Clone)]
pub struct RepoInfo {
    /// Repository top level (may be an ancestor of the component dir).
    pub path: String,
    pub name: String,
    /// Component labels/paths that live inside this repo.
    pub components: Vec<String>,
    pub branch: Option<String>,
    pub detached: bool,
}

#[derive(Serialize, Clone, Default)]
pub struct FileChange {
    /// Two-char porcelain code, e.g. " M", "A ", "??", "UU".
    pub status: String,
    /// Path relative to the repo root — what git itself speaks.
    pub path: String,
    /// Absolute path, for opening in the editor.
    pub abs: String,
    pub staged: bool,
    pub untracked: bool,
    pub conflicted: bool,
}

#[derive(Serialize, Clone, Default)]
pub struct RepoStatus {
    pub path: String,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub detached: bool,
    pub staged: Vec<FileChange>,
    pub unstaged: Vec<FileChange>,
    pub untracked: Vec<FileChange>,
    pub conflicted: Vec<FileChange>,
}

#[derive(Serialize, Clone)]
pub struct BranchInfo {
    /// Logical branch name — never an `origin/…` tracking ref.
    pub name: String,
    pub current: bool,
    /// Exists on a remote but not checked out locally; selecting it checks it
    /// out (git auto-creates the local tracking branch).
    pub remote_only: bool,
    /// A local branch that also exists on the remote (already pushed).
    pub synced: bool,
    pub subject: String,
}

#[derive(Serialize, Clone)]
pub struct CommitInfo {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub date: String,
    pub subject: String,
    pub refs: String,
}

// ---------- plumbing ----------

fn git(repo: &Path) -> Command {
    let mut cmd = Command::new("git");
    // No TTY in a GUI app: prompting would hang forever, so make git fail with
    // a real message instead. The user's credential helper still works.
    cmd.env("GIT_TERMINAL_PROMPT", "0");
    // Don't take locks we don't need. `git status` normally refreshes the index
    // as a side effect, which takes index.lock — and this panel polls status
    // every few seconds, per repo. That races anything else touching the repo:
    // the user's own `git commit` in a terminal, or an agent's, fails with
    // "Unable to create index.lock: File exists" purely because we happened to
    // be looking. Same switch VS Code uses (--no-optional-locks).
    //
    // This only skips *optional* locks. Commit, stage and checkout take
    // required locks and still work; the cost is that status may report
    // stat-dirty files it would otherwise have quietly re-checked, which is a
    // fair trade for never breaking someone else's write.
    cmd.env("GIT_OPTIONAL_LOCKS", "0");
    cmd.arg("-C").arg(repo);
    cmd.no_console_window();
    cmd
}

fn run(cmd: &mut Command) -> Result<String, String> {
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
        // git puts useful detail on either stream depending on the subcommand.
        Err(if err.is_empty() { stdout } else { err })
    }
}

/// Resolve + scope-check a repo path handed to us by the frontend.
fn repo_path(state: &State<'_, WorkspaceManager>, path: &str) -> Result<PathBuf, String> {
    let dir = check_scope(state, Path::new(path))?;
    let top = run(git(&dir).args(["rev-parse", "--show-toplevel"]))?;
    let top = PathBuf::from(top.trim());
    // The toplevel can sit above the component dir; make sure it's still inside
    // a registered root rather than escaping upward via a parent repo.
    check_scope(state, &top)
}

fn toplevel_of(dir: &Path) -> Option<PathBuf> {
    let out = git(dir)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

fn head_branch(repo: &Path) -> (Option<String>, bool) {
    match run(git(repo).args(["symbolic-ref", "--quiet", "--short", "HEAD"])) {
        Ok(b) if !b.trim().is_empty() => (Some(b.trim().to_string()), false),
        // Detached HEAD: report the short hash rather than pretending there's a
        // branch, so the UI can disable branch-only actions.
        _ => (
            run(git(repo).args(["rev-parse", "--short", "HEAD"]))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            true,
        ),
    }
}

// ---------- discovery ----------

/// The distinct repos backing a project's components. Several components often
/// live in one repo (a monorepo), so they're grouped rather than listed twice.
#[tauri::command]
pub async fn git_repos(
    state: State<'_, WorkspaceManager>,
    components: Vec<(String, String)>, // (label, path)
) -> Result<Vec<RepoInfo>, String> {
    let mut repos: Vec<RepoInfo> = Vec::new();
    for (label, path) in components {
        let Ok(dir) = check_scope(&state, Path::new(&path)) else {
            continue;
        };
        let Some(top) = toplevel_of(&dir) else {
            continue;
        };
        let top_str = top.to_string_lossy().to_string();
        if let Some(existing) = repos.iter_mut().find(|r| r.path == top_str) {
            existing.components.push(label);
            continue;
        }
        let (branch, detached) = head_branch(&top);
        repos.push(RepoInfo {
            name: top
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| top_str.clone()),
            path: top_str,
            components: vec![label],
            branch,
            detached,
        });
    }
    Ok(repos)
}

// ---------- status ----------

/// Porcelain v1 `-z` parse. Index and worktree columns are separate: a file can
/// be both staged and modified again, and it must appear in both lists.
#[tauri::command]
pub async fn git_repo_status(
    state: State<'_, WorkspaceManager>,
    repo: String,
) -> Result<RepoStatus, String> {
    let top = repo_path(&state, &repo)?;
    let (branch, detached) = head_branch(&top);

    let upstream = run(git(&top).args(["rev-parse", "--abbrev-ref", "@{upstream}"]))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let (mut ahead, mut behind) = (0, 0);
    if upstream.is_some() {
        if let Ok(counts) =
            run(git(&top).args(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]))
        {
            let mut it = counts.split_whitespace();
            behind = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
            ahead = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
        }
    }

    let raw = run(git(&top).args(["status", "--porcelain", "-z"]))?;
    let mut status = RepoStatus {
        path: top.to_string_lossy().to_string(),
        branch,
        upstream,
        ahead,
        behind,
        detached,
        ..Default::default()
    };

    let mut parts = raw.split('\0');
    while let Some(part) = parts.next() {
        if part.len() < 4 {
            continue;
        }
        let code: Vec<char> = part[..2].chars().collect();
        let (index, tree) = (code[0], code[1]);
        let rel = part[3..].to_string();
        // Renames/copies carry their origin path as the next NUL-separated field.
        if index == 'R' || index == 'C' {
            parts.next();
        }
        let abs = top.join(&rel).to_string_lossy().to_string();
        let mk = |staged: bool, untracked: bool, conflicted: bool| FileChange {
            status: part[..2].to_string(),
            path: rel.clone(),
            abs: abs.clone(),
            staged,
            untracked,
            conflicted,
        };

        // Unmerged: any of these combinations means a conflict, and staging it
        // blindly would silently resolve it — keep it in its own bucket.
        let conflicted = matches!((index, tree), ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D'));
        if conflicted {
            status.conflicted.push(mk(false, false, true));
            continue;
        }
        if index == '?' && tree == '?' {
            status.untracked.push(mk(false, true, false));
            continue;
        }
        if index != ' ' && index != '?' {
            status.staged.push(mk(true, false, false));
        }
        if tree != ' ' && tree != '?' {
            status.unstaged.push(mk(false, false, false));
        }
    }
    Ok(status)
}

// ---------- branches ----------

#[tauri::command]
pub async fn git_branches(
    state: State<'_, WorkspaceManager>,
    repo: String,
) -> Result<Vec<BranchInfo>, String> {
    let top = repo_path(&state, &repo)?;
    // One row per *logical* branch, not per ref. A raw ref list shows `main`,
    // its `origin/main` tracking copy, and the `origin/HEAD` symref (whose short
    // name is a bare `origin`) all as separate lines — noise no one asked for.
    // We fold each local branch together with its remote twin, drop symrefs, and
    // surface only the remote branches that aren't checked out yet.
    //
    // `%(refname)` (full) tells local from remote reliably; `%(symref)` is
    // non-empty only for HEAD pointers, which we skip.
    let fmt = "%(refname)\x1f%(refname:short)\x1f%(HEAD)\x1f%(symref)\x1f%(contents:subject)";
    let out = run(git(&top).args([
        "for-each-ref",
        "--sort=-committerdate",
        &format!("--format={fmt}"),
        "refs/heads",
        "refs/remotes",
    ]))?;

    struct Ref<'a> {
        full: &'a str,
        short: &'a str,
        is_head: bool,
        subject: &'a str,
    }
    let mut refs: Vec<Ref> = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split('\x1f').collect();
        if f.len() < 5 || f[1].is_empty() {
            continue;
        }
        // Symref (origin/HEAD, whatever its short name renders as) — a pointer,
        // not a branch anyone checks out.
        if !f[3].is_empty() {
            continue;
        }
        refs.push(Ref {
            full: f[0],
            short: f[1],
            is_head: f[2] == "*",
            subject: f[4],
        });
    }

    // The logical name of a remote ref is its short name minus the remote (first
    // path segment): `origin/feat/x` -> `feat/x`.
    let logical = |r: &Ref| -> String {
        if r.full.starts_with("refs/remotes/") {
            r.short.splitn(2, '/').nth(1).unwrap_or(r.short).to_string()
        } else {
            r.short.to_string()
        }
    };
    let local_names: std::collections::HashSet<String> = refs
        .iter()
        .filter(|r| r.full.starts_with("refs/heads/"))
        .map(|r| r.short.to_string())
        .collect();
    let remote_logicals: std::collections::HashSet<String> = refs
        .iter()
        .filter(|r| r.full.starts_with("refs/remotes/"))
        .map(logical)
        .collect();

    // Build in committerdate order, emitting each logical branch once: a local
    // ref always wins; a remote ref is emitted only when it has no local twin.
    let mut branches = Vec::new();
    let mut emitted: std::collections::HashSet<String> = std::collections::HashSet::new();
    for r in &refs {
        let name = logical(r);
        if emitted.contains(&name) {
            continue;
        }
        let is_local = r.full.starts_with("refs/heads/");
        if !is_local && local_names.contains(&name) {
            continue; // remote twin of a local branch — folded into the local row
        }
        emitted.insert(name.clone());
        branches.push(BranchInfo {
            current: r.is_head,
            remote_only: !is_local,
            synced: is_local && remote_logicals.contains(&name),
            subject: r.subject.to_string(),
            name,
        });
    }
    Ok(branches)
}

#[tauri::command]
pub async fn git_checkout(
    state: State<'_, WorkspaceManager>,
    repo: String,
    branch: String,
    create: bool,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = git(&top);
    if create {
        cmd.args(["checkout", "-b", &branch]);
    } else {
        cmd.args(["checkout", &branch]);
    }
    run(&mut cmd)?;
    Ok(format!("Switched to {branch}"))
}

// ---------- staging ----------

#[tauri::command]
pub async fn git_stage(
    state: State<'_, WorkspaceManager>,
    repo: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let top = repo_path(&state, &repo)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut cmd = git(&top);
    // `--` so a path that looks like a flag can't become one.
    cmd.args(["add", "--"]);
    cmd.args(&paths);
    run(&mut cmd).map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(
    state: State<'_, WorkspaceManager>,
    repo: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let top = repo_path(&state, &repo)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut cmd = git(&top);
    cmd.args(["restore", "--staged", "--"]);
    cmd.args(&paths);
    run(&mut cmd).map(|_| ())
}

/// Throw away working-tree changes. Destructive and unrecoverable — the UI must
/// confirm before calling this.
#[tauri::command]
pub async fn git_discard(
    state: State<'_, WorkspaceManager>,
    repo: String,
    paths: Vec<String>,
) -> Result<(), String> {
    let top = repo_path(&state, &repo)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut cmd = git(&top);
    cmd.args(["checkout", "--"]);
    cmd.args(&paths);
    run(&mut cmd).map(|_| ())
}

#[tauri::command]
pub async fn git_commit(
    state: State<'_, WorkspaceManager>,
    repo: String,
    message: String,
    amend: bool,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    if message.trim().is_empty() && !amend {
        return Err("commit message is empty".into());
    }
    let mut cmd = git(&top);
    cmd.args(["commit", "-m", &message]);
    if amend {
        cmd.arg("--amend");
    }
    let out = run(&mut cmd)?;
    Ok(out.lines().next().unwrap_or("committed").to_string())
}

// ---------- remotes ----------

pub(crate) fn run_net(cmd: &mut Command) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    // Drain both pipes on their own threads for the whole life of the child,
    // rather than reading them once it has exited. A pipe holds ~64KB before
    // the writer blocks, so a command whose output is bigger than that — a PR
    // diff is routinely 100KB+ — would fill it, block forever in write(), never
    // exit, and be reported as "timed out after 120s" while `gh` sat there with
    // more to say. The reader threads end at EOF, which is the child exiting.
    let mut so = child.stdout.take();
    let mut se = child.stderr.take();
    let out_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(o) = so.as_mut() {
            let _ = o.read_to_string(&mut buf);
        }
        buf
    });
    let err_thread = std::thread::spawn(move || {
        let mut buf = String::new();
        if let Some(e) = se.as_mut() {
            let _ = e.read_to_string(&mut buf);
        }
        buf
    });

    let start = std::time::Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                let out = out_thread.join().unwrap_or_default();
                let err = err_thread.join().unwrap_or_default();
                // git reports progress on stderr even on success, so merge.
                return if status.success() {
                    Ok(format!("{out}{err}").trim().to_string())
                } else {
                    Err(if err.trim().is_empty() { out } else { err }
                        .trim()
                        .to_string())
                };
            }
            None => {
                if start.elapsed().as_secs() > NET_TIMEOUT_SECS {
                    let _ = child.kill();
                    let _ = child.wait();
                    // Killing the child closes the pipes, so the readers end.
                    let _ = out_thread.join();
                    let _ = err_thread.join();
                    return Err(format!(
                        "timed out after {NET_TIMEOUT_SECS}s — remote unreachable, or it wants credentials this app can't prompt for"
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(80));
            }
        }
    }
}

#[tauri::command]
pub async fn git_fetch(state: State<'_, WorkspaceManager>, repo: String) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = git(&top);
    cmd.args(["fetch", "--prune"]);
    run_net(&mut cmd).map(|o| {
        if o.is_empty() {
            "Already up to date".into()
        } else {
            o
        }
    })
}

#[tauri::command]
pub async fn git_pull(state: State<'_, WorkspaceManager>, repo: String) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = git(&top);
    // --ff-only: never create a surprise merge commit on the user's behalf.
    // If it can't fast-forward, they should decide how to reconcile.
    cmd.args(["pull", "--ff-only"]);
    run_net(&mut cmd)
}

#[tauri::command]
pub async fn git_push(
    state: State<'_, WorkspaceManager>,
    repo: String,
    set_upstream: bool,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let (branch, detached) = head_branch(&top);
    if detached {
        return Err("HEAD is detached — checkout a branch before pushing".into());
    }
    let branch = branch.ok_or("no current branch")?;
    let mut cmd = git(&top);
    if set_upstream {
        cmd.args(["push", "--set-upstream", "origin", &branch]);
    } else {
        cmd.arg("push");
    }
    run_net(&mut cmd).map(|o| if o.is_empty() { "Pushed".into() } else { o })
}

#[derive(Serialize, Clone)]
pub struct CloneResult {
    /// Absolute path of the freshly cloned working tree.
    pub path: String,
    /// The directory name git chose — a good default component label.
    pub name: String,
}

/// Derive the directory `git clone` would create from a URL: the last path
/// segment, minus a trailing `.git`. Handles https/ssh/scp-style remotes.
fn clone_dir_name(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    // scp form (git@host:owner/repo) has no scheme; split on ':' and '/' alike.
    let last = trimmed.rsplit(['/', ':']).next()?;
    let name = last.strip_suffix(".git").unwrap_or(last).trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Clone a repository into `parent` (a directory the user picked). Returns the
/// new working tree so the caller can register it as a project component.
///
/// No scope check: like `workspace_add`, this is the app being *granted* a new
/// location the user chose, not reaching into an existing one. `git()` sets
/// GIT_TERMINAL_PROMPT=0, so a private URL with no credential helper fails with
/// git's own message rather than hanging on a prompt with no TTY. Args go after
/// `--` so a URL starting with `-` can't be read as a flag.
#[tauri::command]
pub async fn git_clone(parent: String, url: String) -> Result<CloneResult, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("enter a git URL".into());
    }
    let parent = PathBuf::from(&parent)
        .canonicalize()
        .map_err(|_| "the folder to clone into doesn't exist".to_string())?;
    if !parent.is_dir() {
        return Err("the clone location is not a folder".into());
    }
    let name = clone_dir_name(&url).ok_or("couldn't read a repository name from that URL")?;
    let dest = parent.join(&name);
    if dest.exists() {
        return Err(format!("a folder named \"{name}\" already exists here"));
    }
    let dest_str = dest.to_string_lossy().to_string();
    // `git()` wants a repo dir; clone has none yet, so run it from `parent`.
    let mut cmd = git(&parent);
    cmd.args(["clone", "--progress", "--", &url, &dest_str]);
    run_net(&mut cmd)?;
    Ok(CloneResult {
        path: dest_str,
        name,
    })
}

// ---------- diff & log ----------

/// Unified diff for one path. `staged` selects index-vs-HEAD instead of
/// worktree-vs-index. Untracked files have no git diff, so they're rendered as
/// an all-additions diff against nothing.
#[tauri::command]
pub async fn git_diff(
    state: State<'_, WorkspaceManager>,
    repo: String,
    path: String,
    staged: bool,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = git(&top);
    cmd.args(["diff", "--no-color"]);
    if staged {
        cmd.arg("--staged");
    }
    cmd.args(["--", &path]);
    let out = run(&mut cmd)?;
    if out.trim().is_empty() && !staged {
        // Untracked: show it as new content rather than an empty diff.
        let mut c = git(&top);
        c.args(["diff", "--no-color", "--no-index", "--", "/dev/null", &path]);
        // --no-index exits 1 when files differ, which is the normal case here.
        if let Ok(o) = c.output() {
            let text = String::from_utf8_lossy(&o.stdout).to_string();
            if !text.trim().is_empty() {
                return Ok(text);
            }
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn git_log(
    state: State<'_, WorkspaceManager>,
    repo: String,
    limit: Option<u32>,
) -> Result<Vec<CommitInfo>, String> {
    let top = repo_path(&state, &repo)?;
    let limit = limit.unwrap_or(50);
    let out = run(git(&top).args([
        "log",
        &format!("-{limit}"),
        "--date=short",
        "--pretty=format:%H\x1f%h\x1f%an\x1f%ad\x1f%s\x1f%D",
    ]))?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\x1f').collect();
            if f.len() < 5 {
                return None;
            }
            Some(CommitInfo {
                hash: f[0].into(),
                short: f[1].into(),
                author: f[2].into(),
                date: f[3].into(),
                subject: f[4].into(),
                refs: f.get(5).unwrap_or(&"").to_string(),
            })
        })
        .collect())
}

// ---------- pull requests (gh) ----------
//
// The GitHub CLI is used rather than the REST API directly: it already holds
// the user's auth in the system keyring, so we never handle a token.

#[derive(Serialize, Clone)]
pub struct PrInfo {
    pub number: u32,
    pub title: String,
    pub author: String,
    pub branch: String,
    pub base: String,
    pub draft: bool,
    pub state: String,
    pub url: String,
    pub created: String,
    pub updated: String,
    pub review_decision: String,
    pub additions: u32,
    pub deletions: u32,
    pub mine: bool,
    /// GitHub's mergeability: "MERGEABLE", "CONFLICTING", or "UNKNOWN".
    pub mergeable: String,
    /// Rolled-up CI state: "PASS", "FAIL", "PENDING", or "" when no checks ran.
    pub checks: String,
    /// Human count for a tooltip, e.g. "3/4 checks passed" ("" when none).
    pub checks_summary: String,
}

/// Collapse gh's `statusCheckRollup` (a mix of CheckRun and StatusContext
/// entries with different shapes) into one state plus a "passed/total" summary.
/// Any failure wins over pending, pending over success — the same precedence
/// GitHub shows on the merge box.
fn roll_up_checks(rollup: &serde_json::Value) -> (String, String) {
    let Some(items) = rollup.as_array() else {
        return (String::new(), String::new());
    };
    if items.is_empty() {
        return (String::new(), String::new());
    }
    let (mut passed, mut failed, mut pending) = (0u32, 0u32, 0u32);
    for it in items {
        // CheckRun: has `status` (QUEUED/IN_PROGRESS/COMPLETED) + `conclusion`.
        // StatusContext: has `state` (SUCCESS/FAILURE/PENDING/ERROR).
        if let Some(state) = it["state"].as_str() {
            match state {
                "SUCCESS" => passed += 1,
                "PENDING" | "EXPECTED" => pending += 1,
                _ => failed += 1, // FAILURE, ERROR
            }
        } else {
            let status = it["status"].as_str().unwrap_or("");
            if status != "COMPLETED" {
                pending += 1;
            } else {
                match it["conclusion"].as_str().unwrap_or("") {
                    "SUCCESS" | "NEUTRAL" | "SKIPPED" => passed += 1,
                    _ => failed += 1, // FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE
                }
            }
        }
    }
    let total = passed + failed + pending;
    let state = if failed > 0 {
        "FAIL"
    } else if pending > 0 {
        "PENDING"
    } else {
        "PASS"
    };
    (state.to_string(), format!("{passed}/{total} checks passed"))
}

/// gh infers the repository from the working directory, which avoids parsing
/// remote URLs ourselves and works with forks/multiple remotes as the user has
/// them configured.
/// Absolute path to a tool, resolved through the user's LOGIN shell.
///
/// A GUI app on macOS inherits launchd's minimal PATH (/usr/bin:/bin:...),
/// not the shell's — so Homebrew lives outside it. `git` happens to sit in
/// /usr/bin (Xcode CLT) and worked; `gh` sits in /opt/homebrew/bin and did
/// not, which is why the PR tab claimed "needs the GitHub CLI" on machines
/// where `gh` is plainly installed and every other git feature worked.
/// Resolved once per tool per run: spawning a login shell is expensive, and
/// a tool's location doesn't move while the app is open.
fn tool_path(tool: &'static str) -> String {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<&'static str, String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().unwrap().get(tool) {
        return hit.clone();
    }
    // `command -v` is a shell builtin, so this works even where `which` isn't
    // installed. -l loads the profile that sets PATH in the first place.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let resolved = std::process::Command::new(shell)
        .no_console_window()
        .args(["-lc", &format!("command -v {tool}")])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|p| !p.is_empty())
        // Fall back to the bare name: if it IS on the inherited PATH this
        // still works, and if it isn't the caller reports it as missing.
        .unwrap_or_else(|| tool.to_string());
    cache.lock().unwrap().insert(tool, resolved.clone());
    resolved
}

pub(crate) fn gh_bin() -> String {
    tool_path("gh")
}

fn gh_in(repo: &Path) -> Command {
    let mut cmd = Command::new(gh_bin());
    cmd.env("GH_PROMPT_DISABLED", "1");
    cmd.current_dir(repo);
    cmd.no_console_window();
    cmd
}

/// `gh` with no repo context, for calls that name their target with `--repo
/// OWNER/NAME`. Crash reports use this: they go to Canopy's own tracker and
/// must not inherit whatever repo the user happens to have open.
pub(crate) fn gh_anywhere() -> Command {
    let mut cmd = Command::new(gh_bin());
    cmd.env("GH_PROMPT_DISABLED", "1");
    cmd.no_console_window();
    cmd
}

#[tauri::command]
pub async fn gh_available() -> bool {
    Command::new(gh_bin())
        .no_console_window()
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn gh_pr_list(
    state: State<'_, WorkspaceManager>,
    repo: String,
) -> Result<Vec<PrInfo>, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args([
        "pr", "list", "--limit", "50", "--state", "open", "--json",
        "number,title,author,headRefName,baseRefName,isDraft,state,url,createdAt,updatedAt,reviewDecision,additions,deletions,mergeable,statusCheckRollup",
    ]);
    let out = run_net(&mut cmd)?;
    let v: serde_json::Value =
        serde_json::from_str(&out).map_err(|e| format!("gh returned unexpected output: {e}"))?;
    let me = run_net(&mut {
        let mut c = gh_in(&top);
        c.args(["api", "user", "--jq", ".login"]);
        c
    })
    .unwrap_or_default()
    .trim()
    .to_string();

    Ok(v.as_array()
        .map(|arr| {
            arr.iter()
                .map(|p| {
                    let author = p["author"]["login"].as_str().unwrap_or("").to_string();
                    let (checks, checks_summary) = roll_up_checks(&p["statusCheckRollup"]);
                    PrInfo {
                        number: p["number"].as_u64().unwrap_or(0) as u32,
                        title: p["title"].as_str().unwrap_or("").to_string(),
                        mine: !me.is_empty() && author == me,
                        author,
                        branch: p["headRefName"].as_str().unwrap_or("").to_string(),
                        base: p["baseRefName"].as_str().unwrap_or("").to_string(),
                        draft: p["isDraft"].as_bool().unwrap_or(false),
                        state: p["state"].as_str().unwrap_or("").to_string(),
                        url: p["url"].as_str().unwrap_or("").to_string(),
                        created: p["createdAt"].as_str().unwrap_or("").to_string(),
                        updated: p["updatedAt"].as_str().unwrap_or("").to_string(),
                        review_decision: p["reviewDecision"].as_str().unwrap_or("").to_string(),
                        additions: p["additions"].as_u64().unwrap_or(0) as u32,
                        deletions: p["deletions"].as_u64().unwrap_or(0) as u32,
                        mergeable: p["mergeable"].as_str().unwrap_or("UNKNOWN").to_string(),
                        checks,
                        checks_summary,
                    }
                })
                .collect()
        })
        .unwrap_or_default())
}

/// Files reassembled from the per-file endpoint before we stop. A PR touching
/// more than this is not being read in one sitting, and every extra page is
/// another request.
const MAX_PATCH_FILES: usize = 400;

#[tauri::command]
pub async fn gh_pr_diff(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args(["pr", "diff", &number.to_string()]);
    match run_net(&mut cmd) {
        Ok(diff) => Ok(diff),
        // GitHub refuses to render one combined diff past 20,000 lines (HTTP
        // 406, `diff too_large`) — and a release PR is exactly the one you most
        // want to read. The same patches are still served per file, so fall
        // back to those and stitch them into the patch the view already parses.
        Err(e) if is_diff_too_large(&e) => pr_files_patch(&top, number),
        Err(e) => Err(e),
    }
}

/// The 406 GitHub returns for an oversized combined diff, in the shapes `gh`
/// passes it through as.
fn is_diff_too_large(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("too_large")
        || e.contains("exceeded the maximum number of lines")
        || (e.contains("406") && e.contains("diff"))
}

/// Rebuild a unified patch out of `pulls/{n}/files`. `--paginate` walks the
/// pages and the jq filter emits one compact object per line, which is stable
/// across gh versions in a way `--slurp` is not.
fn pr_files_patch(top: &Path, number: u32) -> Result<String, String> {
    let (owner, name) = gh_nwo(top)?;
    let mut cmd = gh_in(top);
    cmd.args([
        "api",
        "--paginate",
        "--jq",
        ".[] | @json",
        &format!("repos/{owner}/{name}/pulls/{number}/files?per_page=100"),
    ]);
    Ok(assemble_patch(&run_net(&mut cmd)?))
}

/// One JSON object per line (GitHub's per-file entries) → a unified patch.
///
/// The hunks are GitHub's own, so what comes out is the same text `gh pr diff`
/// would have produced; only the headers are reconstructed. Files whose patch
/// GitHub omits — binaries, and single files too large to inline — keep their
/// header and say why, so they are still listed rather than silently missing.
fn assemble_patch(lines: &str) -> String {
    let mut out = String::new();
    let mut files = 0usize;
    let mut skipped = 0usize;
    for line in lines.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(f) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let path = s(&f["filename"]);
        if path.is_empty() {
            continue;
        }
        if files >= MAX_PATCH_FILES {
            skipped += 1;
            continue;
        }
        files += 1;
        let status = s(&f["status"]);
        let old = match status.as_str() {
            "added" => "/dev/null".to_string(),
            "renamed" => format!("a/{}", s(&f["previous_filename"])),
            _ => format!("a/{path}"),
        };
        let new = if status == "removed" {
            "/dev/null".to_string()
        } else {
            format!("b/{path}")
        };
        let from = if status == "renamed" {
            s(&f["previous_filename"])
        } else {
            path.clone()
        };
        out.push_str(&format!("diff --git a/{from} b/{path}\n"));
        match f["patch"].as_str() {
            Some(patch) => {
                out.push_str(&format!("--- {old}\n+++ {new}\n"));
                out.push_str(patch.trim_end_matches('\n'));
                out.push('\n');
            }
            // No patch field: a binary, or a file GitHub decided is too big to
            // inline. The first line is the one the view already recognises as
            // binary; the second explains the other case in the file's own card.
            None => {
                let changes = f["changes"].as_u64().unwrap_or(0);
                if changes == 0 {
                    out.push_str(&format!("Binary files a/{path} and b/{path} differ\n"));
                } else {
                    out.push_str(&format!(
                        "Binary files a/{path} and b/{path} differ\n\
                         (GitHub didn't include this file's patch — {changes} changed lines. \
                         Open it on GitHub.)\n"
                    ));
                }
            }
        }
    }
    if skipped > 0 {
        out.push_str(&format!(
            "diff --git a/… b/…\nBinary files a/… and b/… differ\n\
             ({skipped} more file(s) not shown — this pull request touches more than \
             {MAX_PATCH_FILES}.)\n"
        ));
    }
    out
}

#[tauri::command]
pub async fn gh_pr_body(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args([
        "pr",
        "view",
        &number.to_string(),
        "--json",
        "body",
        "--jq",
        ".body",
    ]);
    run_net(&mut cmd)
}

/// Submit a review. This is outward-facing and visible to other people on a
/// real repository, so the UI confirms before it ever reaches here — and the
/// action is never inferred, only taken when explicitly chosen.
#[tauri::command]
pub async fn gh_pr_review(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
    action: String,
    body: Option<String>,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let flag = match action.as_str() {
        "approve" => "--approve",
        "comment" => "--comment",
        "request-changes" => "--request-changes",
        other => return Err(format!("unsupported review action: {other}")),
    };
    let mut cmd = gh_in(&top);
    cmd.args(["pr", "review", &number.to_string(), flag]);
    // GitHub requires a body for comment/request-changes; approve may omit it.
    let body = body.unwrap_or_default();
    if !body.trim().is_empty() {
        cmd.args(["--body", &body]);
    } else if flag != "--approve" {
        return Err("a comment is required for this review action".into());
    }
    run_net(&mut cmd)?;
    Ok(match flag {
        "--approve" => format!("Approved #{number}"),
        "--request-changes" => format!("Requested changes on #{number}"),
        _ => format!("Commented on #{number}"),
    })
}

#[tauri::command]
pub async fn gh_pr_checkout(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args(["pr", "checkout", &number.to_string()]);
    run_net(&mut cmd)?;
    Ok(format!("Checked out #{number}"))
}

/// Merge a PR through `gh pr merge`. This is outward-facing and lands commits on
/// the base branch, so the UI always confirms before calling it. `method` picks
/// how history is written — one of the three GitHub offers.
#[tauri::command]
pub async fn gh_pr_merge(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
    method: String,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let (flag, verb) = match method.as_str() {
        "squash" => ("--squash", "Squashed and merged"),
        "merge" => ("--merge", "Merged"),
        "rebase" => ("--rebase", "Rebased and merged"),
        other => return Err(format!("unsupported merge method: {other}")),
    };
    let mut cmd = gh_in(&top);
    cmd.args(["pr", "merge", &number.to_string(), flag]);
    run_net(&mut cmd)?;
    Ok(format!("{verb} #{number}"))
}

/// Close a PR without merging. Outward-facing (others see it close), so the UI
/// confirms first. With `delete_branch`, gh also deletes the PR's branch on the
/// remote *and* the local copy if present — the full "close it and throw the
/// work away" that `gh pr close --delete-branch` performs.
#[tauri::command]
pub async fn gh_pr_close(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
    delete_branch: bool,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args(["pr", "close", &number.to_string()]);
    if delete_branch {
        cmd.arg("--delete-branch");
    }
    run_net(&mut cmd)?;
    Ok(if delete_branch {
        format!("Closed #{number} and deleted its branch")
    } else {
        format!("Closed #{number}")
    })
}

/// Take a draft PR out of draft so it can be reviewed and merged.
#[tauri::command]
pub async fn gh_pr_ready(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args(["pr", "ready", &number.to_string()]);
    run_net(&mut cmd)?;
    Ok(format!("#{number} is ready for review"))
}

// ---------- pull request conversation (gh api graphql) ----------
//
// Review threads — the inline comments, and the only place resolved/outdated
// live — are not in GitHub's REST API at all, and `gh` has no command for them
// (cli/cli#12419). So everything below is `gh api graphql`, which still rides
// the CLI's stored auth: we never hold a token.
//
// One composite query per refresh: body, conversation, reviews, threads, files
// and the check rollup together. It runs independently of `gh_pr_diff`, so the
// conversation paints while a large patch is still being parsed.

#[derive(Serialize, Clone, Default)]
pub struct PrComment {
    /// GraphQL node id — what a reply or a resolve is addressed to.
    pub id: String,
    pub author: String,
    pub body: String,
    pub created: String,
    pub url: String,
    /// Authored by the signed-in user.
    pub mine: bool,
    /// OWNER / MEMBER / COLLABORATOR / CONTRIBUTOR / NONE. Gates whose words an
    /// agent is allowed to act on — see the trust note in the module docs.
    pub association: String,
}

#[derive(Serialize, Clone, Default)]
pub struct PrReviewSummary {
    pub id: String,
    pub author: String,
    pub body: String,
    /// APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED / PENDING.
    pub state: String,
    pub submitted: String,
    pub url: String,
    pub mine: bool,
    pub association: String,
    /// The head commit this review was submitted against — the anchor for
    /// "what changed since I last looked".
    pub commit: String,
}

#[derive(Serialize, Clone, Default)]
pub struct PrThread {
    pub id: String,
    pub path: String,
    /// Line in the file as of the PR head; 0 when GitHub reports none (an
    /// outdated thread whose line no longer exists).
    pub line: u32,
    pub start_line: u32,
    /// LEFT or RIGHT — which side of the diff the thread hangs off.
    pub side: String,
    pub resolved: bool,
    pub outdated: bool,
    pub comments: Vec<PrComment>,
}

#[derive(Serialize, Clone, Default)]
pub struct PrFileState {
    pub path: String,
    /// GitHub's own per-file checkbox (VIEWED), shared with the web UI.
    pub viewed: bool,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Serialize, Clone, Default)]
pub struct PrConversation {
    /// The PR's GraphQL node id, needed by every mutation below.
    pub node_id: String,
    pub body: String,
    pub head_sha: String,
    /// The signed-in login, so the UI can tell your own words from everyone's.
    pub viewer: String,
    pub review_decision: String,
    pub mergeable: String,
    /// Live rollup: PASS / FAIL / PENDING / "" — the same vocabulary as PrInfo,
    /// but current rather than whatever the PR list saw when the tab opened.
    pub checks: String,
    pub auto_merge: bool,
    pub draft: bool,
    pub comments: Vec<PrComment>,
    pub reviews: Vec<PrReviewSummary>,
    pub threads: Vec<PrThread>,
    pub files: Vec<PrFileState>,
    /// Head sha of your most recent submitted review, for the delta toggle.
    pub my_last_review_sha: String,
}

const PR_CONVERSATION_QUERY: &str = r#"
query($owner:String!,$name:String!,$number:Int!){
  viewer{ login }
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      id body isDraft mergeable reviewDecision
      headRefOid
      autoMergeRequest{ enabledAt }
      comments(first:100){nodes{ id author{login} body createdAt url viewerDidAuthor authorAssociation }}
      reviews(first:50){nodes{ id author{login} body state submittedAt url viewerDidAuthor authorAssociation commit{oid} }}
      reviewThreads(first:100){nodes{
        id isResolved isOutdated path line startLine diffSide
        comments(first:50){nodes{ id author{login} body createdAt url viewerDidAuthor authorAssociation }}
      }}
      files(first:100){nodes{ path viewerViewedState additions deletions }}
      commits(last:1){nodes{commit{ statusCheckRollup{ state } }}}
    }
  }
}"#;

/// `owner` and `name` for the repo `gh` resolves in this checkout.
fn gh_nwo(top: &Path) -> Result<(String, String), String> {
    let mut cmd = gh_in(top);
    cmd.args([
        "repo",
        "view",
        "--json",
        "nameWithOwner",
        "--jq",
        ".nameWithOwner",
    ]);
    let nwo = run_net(&mut cmd)?;
    let nwo = nwo.trim();
    let (owner, name) = nwo
        .split_once('/')
        .ok_or_else(|| format!("couldn't read owner/name from {nwo:?}"))?;
    Ok((owner.to_string(), name.to_string()))
}

/// Run a GraphQL document with typed variables and return `data`. `-F` sends
/// numbers and booleans as themselves (`-f` would stringify them, which the
/// schema rejects for Int!).
fn gh_graphql(top: &Path, query: &str, vars: &[(&str, String)]) -> Result<Value, String> {
    let mut cmd = gh_in(top);
    cmd.args(["api", "graphql", "-f", &format!("query={query}")]);
    for (k, v) in vars {
        cmd.args(["-F", &format!("{k}={v}")]);
    }
    graphql_data(run_net(&mut cmd)?)
}

/// A GraphQL document that names its own targets, run with no repo context —
/// what the cross-project PR watcher uses, since one document covers many
/// repositories and none of them is "the" current one.
pub(crate) fn gh_graphql_anywhere(query: &str) -> Result<Value, String> {
    let mut cmd = gh_anywhere();
    cmd.args(["api", "graphql", "-f", &format!("query={query}")]);
    graphql_data(run_net(&mut cmd)?)
}

/// `data` out of a GraphQL response, or the errors as a message. A 200 with an
/// `errors` array is the normal failure shape, so it can't be ignored.
fn graphql_data(out: String) -> Result<Value, String> {
    let v: Value =
        serde_json::from_str(&out).map_err(|e| format!("gh returned unexpected output: {e}"))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()) {
        if !errors.is_empty() {
            let msg = errors
                .iter()
                .filter_map(|e| e["message"].as_str())
                .collect::<Vec<_>>()
                .join("; ");
            return Err(if msg.is_empty() {
                "GitHub rejected the request".into()
            } else {
                msg
            });
        }
    }
    Ok(v.get("data").cloned().unwrap_or(Value::Null))
}

/// The repo toplevel for a component path, scope-checked. The PR watcher uses it
/// to fold many component paths onto the repos they actually live in.
pub(crate) fn gh_repo_toplevel(
    state: &State<'_, WorkspaceManager>,
    path: &str,
) -> Result<PathBuf, String> {
    repo_path(state, path)
}

/// `owner/name` for an already-validated repo path. Resolved once per repo by
/// the watcher and cached — this is a subprocess, and it never changes.
pub(crate) fn gh_nwo_of(repo: &str) -> Result<String, String> {
    let (owner, name) = gh_nwo(Path::new(repo))?;
    Ok(format!("{owner}/{name}"))
}

fn s(v: &Value) -> String {
    v.as_str().unwrap_or("").to_string()
}

fn parse_comment(c: &Value) -> PrComment {
    PrComment {
        id: s(&c["id"]),
        author: s(&c["author"]["login"]),
        body: s(&c["body"]),
        created: s(&c["createdAt"]),
        url: s(&c["url"]),
        mine: c["viewerDidAuthor"].as_bool().unwrap_or(false),
        association: s(&c["authorAssociation"]),
    }
}

fn nodes<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v[key]["nodes"].as_array().map(|a| &a[..]).unwrap_or(&[])
}

/// GraphQL's check state vocabulary, collapsed onto PrInfo's.
pub(crate) fn rollup_state(state: &str) -> String {
    match state {
        "SUCCESS" => "PASS",
        "FAILURE" | "ERROR" => "FAIL",
        "PENDING" | "EXPECTED" => "PENDING",
        _ => "",
    }
    .to_string()
}

#[tauri::command]
pub async fn gh_pr_conversation(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
) -> Result<PrConversation, String> {
    let top = repo_path(&state, &repo)?;
    let (owner, name) = gh_nwo(&top)?;
    let data = gh_graphql(
        &top,
        PR_CONVERSATION_QUERY,
        &[
            ("owner", owner),
            ("name", name),
            ("number", number.to_string()),
        ],
    )?;
    parse_conversation(&data, number)
}

/// The query's `data` shaped into what the tab renders. Split from the command
/// so the parsing — the part that breaks when GitHub renames a field — is
/// testable without a network round trip.
fn parse_conversation(data: &Value, number: u32) -> Result<PrConversation, String> {
    let pr = &data["repository"]["pullRequest"];
    if pr.is_null() {
        return Err(format!("#{number} not found on this repository"));
    }
    let viewer = s(&data["viewer"]["login"]);

    let comments = nodes(pr, "comments").iter().map(parse_comment).collect();
    let reviews: Vec<PrReviewSummary> = nodes(pr, "reviews")
        .iter()
        .map(|r| PrReviewSummary {
            id: s(&r["id"]),
            author: s(&r["author"]["login"]),
            body: s(&r["body"]),
            state: s(&r["state"]),
            submitted: s(&r["submittedAt"]),
            url: s(&r["url"]),
            mine: r["viewerDidAuthor"].as_bool().unwrap_or(false),
            association: s(&r["authorAssociation"]),
            commit: s(&r["commit"]["oid"]),
        })
        .collect();
    let threads = nodes(pr, "reviewThreads")
        .iter()
        .map(|t| PrThread {
            id: s(&t["id"]),
            path: s(&t["path"]),
            line: t["line"].as_u64().unwrap_or(0) as u32,
            start_line: t["startLine"].as_u64().unwrap_or(0) as u32,
            side: s(&t["diffSide"]),
            resolved: t["isResolved"].as_bool().unwrap_or(false),
            outdated: t["isOutdated"].as_bool().unwrap_or(false),
            comments: nodes(t, "comments").iter().map(parse_comment).collect(),
        })
        .collect();
    let files = nodes(pr, "files")
        .iter()
        .map(|f| PrFileState {
            path: s(&f["path"]),
            viewed: s(&f["viewerViewedState"]) == "VIEWED",
            additions: f["additions"].as_u64().unwrap_or(0) as u32,
            deletions: f["deletions"].as_u64().unwrap_or(0) as u32,
        })
        .collect();
    // Your latest *submitted* review anchors the delta view; a PENDING one has
    // no commit to compare against.
    let my_last_review_sha = reviews
        .iter()
        .filter(|r| r.mine && r.state != "PENDING" && !r.commit.is_empty())
        .max_by(|a, b| a.submitted.cmp(&b.submitted))
        .map(|r| r.commit.clone())
        .unwrap_or_default();
    let checks = nodes(pr, "commits")
        .first()
        .map(|c| rollup_state(&s(&c["commit"]["statusCheckRollup"]["state"])))
        .unwrap_or_default();

    Ok(PrConversation {
        node_id: s(&pr["id"]),
        body: s(&pr["body"]),
        head_sha: s(&pr["headRefOid"]),
        viewer,
        review_decision: s(&pr["reviewDecision"]),
        mergeable: s(&pr["mergeable"]),
        checks,
        auto_merge: !pr["autoMergeRequest"].is_null(),
        draft: pr["isDraft"].as_bool().unwrap_or(false),
        comments,
        reviews,
        threads,
        files,
        my_last_review_sha,
    })
}

/// Reply on an existing review thread. Outward-facing, so the UI asks first.
#[tauri::command]
pub async fn gh_pr_thread_reply(
    state: State<'_, WorkspaceManager>,
    repo: String,
    thread_id: String,
    body: String,
) -> Result<String, String> {
    if body.trim().is_empty() {
        return Err("a reply needs a body".into());
    }
    let top = repo_path(&state, &repo)?;
    gh_graphql(
        &top,
        "mutation($t:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$t,body:$b}){comment{id}}}",
        &[("t", thread_id), ("b", body)],
    )?;
    Ok("Replied".into())
}

/// Resolve or reopen a thread. Needs Contents: read+write on a fine-grained
/// token; a classic `gh auth login` scope already covers it.
#[tauri::command]
pub async fn gh_pr_thread_resolved(
    state: State<'_, WorkspaceManager>,
    repo: String,
    thread_id: String,
    resolved: bool,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let q = if resolved {
        "mutation($t:ID!){resolveReviewThread(input:{threadId:$t}){thread{id isResolved}}}"
    } else {
        "mutation($t:ID!){unresolveReviewThread(input:{threadId:$t}){thread{id isResolved}}}"
    };
    gh_graphql(&top, q, &[("t", thread_id)])?;
    Ok(if resolved { "Resolved" } else { "Reopened" }.into())
}

/// GitHub's per-file "viewed" checkbox. Shared with the web UI, so ticking a
/// file here is still ticked when the same PR is opened in a browser.
#[tauri::command]
pub async fn gh_pr_file_viewed(
    state: State<'_, WorkspaceManager>,
    repo: String,
    pr_id: String,
    path: String,
    viewed: bool,
) -> Result<(), String> {
    let top = repo_path(&state, &repo)?;
    let q = if viewed {
        "mutation($p:ID!,$f:String!){markFileAsViewed(input:{pullRequestId:$p,path:$f}){clientMutationId}}"
    } else {
        "mutation($p:ID!,$f:String!){unmarkFileAsViewed(input:{pullRequestId:$p,path:$f}){clientMutationId}}"
    };
    gh_graphql(&top, q, &[("p", pr_id), ("f", path)])?;
    Ok(())
}

/// One inline comment in a review that hasn't been posted yet.
#[derive(Deserialize, Clone)]
pub struct DraftThread {
    pub path: String,
    pub line: u32,
    pub start_line: Option<u32>,
    /// LEFT or RIGHT.
    pub side: String,
    pub body: String,
}

/// Submit a review with its inline comments as ONE review — the pending-review
/// model. `gh pr review` can only post a body, so this is the mutation route.
/// Every bit of it is outward-facing: the UI confirms before calling.
#[tauri::command]
pub async fn gh_pr_review_batch(
    state: State<'_, WorkspaceManager>,
    repo: String,
    pr_id: String,
    event: String,
    body: Option<String>,
    threads: Vec<DraftThread>,
) -> Result<String, String> {
    let ev = match event.as_str() {
        "approve" => "APPROVE",
        "comment" => "COMMENT",
        "request-changes" => "REQUEST_CHANGES",
        other => return Err(format!("unsupported review action: {other}")),
    };
    let body = body.unwrap_or_default();
    if ev != "APPROVE" && body.trim().is_empty() && threads.is_empty() {
        return Err("a comment is required for this review action".into());
    }
    let top = repo_path(&state, &repo)?;
    let thread_json: Vec<Value> = threads
        .iter()
        .map(|t| {
            let mut o = serde_json::Map::new();
            o.insert("path".into(), Value::String(t.path.clone()));
            o.insert("line".into(), Value::from(t.line));
            o.insert("side".into(), Value::String(t.side.clone()));
            if let Some(start) = t.start_line.filter(|s| *s > 0 && *s < t.line) {
                o.insert("startLine".into(), Value::from(start));
                o.insert("startSide".into(), Value::String(t.side.clone()));
            }
            o.insert("body".into(), Value::String(t.body.clone()));
            Value::Object(o)
        })
        .collect();
    gh_graphql(
        &top,
        "mutation($p:ID!,$e:PullRequestReviewEvent!,$b:String,$t:[DraftPullRequestReviewThread!]){\
         addPullRequestReview(input:{pullRequestId:$p,event:$e,body:$b,threads:$t}){pullRequestReview{url}}}",
        &[
            ("p", pr_id),
            ("e", ev.to_string()),
            ("b", body),
            ("t", serde_json::to_string(&thread_json).unwrap_or_else(|_| "[]".into())),
        ],
    )?;
    let n = threads.len();
    Ok(match ev {
        "APPROVE" => format!("Approved{}", count_suffix(n)),
        "REQUEST_CHANGES" => format!("Requested changes{}", count_suffix(n)),
        _ => format!("Review posted{}", count_suffix(n)),
    })
}

fn count_suffix(n: usize) -> String {
    match n {
        0 => String::new(),
        1 => " with 1 inline comment".into(),
        n => format!(" with {n} inline comments"),
    }
}

/// Bring the base branch into the PR — the trivial half of "it conflicts",
/// which GitHub can do server-side without an agent or a checkout.
#[tauri::command]
pub async fn gh_pr_update_branch(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args(["pr", "update-branch", &number.to_string()]);
    run_net(&mut cmd)?;
    Ok(format!("#{number} updated from its base"))
}

/// Ask for review. Empty `reviewers` re-requests from whoever already reviewed,
/// which is what an author wants after pushing a round of fixes.
#[tauri::command]
pub async fn gh_pr_request_review(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
    reviewers: Vec<String>,
) -> Result<String, String> {
    if reviewers.is_empty() {
        return Err("no reviewer to ask".into());
    }
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args(["pr", "edit", &number.to_string()]);
    for r in &reviewers {
        cmd.args(["--add-reviewer", r]);
    }
    run_net(&mut cmd)?;
    Ok(format!(
        "Asked {} to review #{number}",
        reviewers.join(", ")
    ))
}

/// Logins worth offering as reviewers: everyone with access to the repository.
/// Without this "Ask for review" can only re-request people who already
/// reviewed, which on a PR nobody has looked at yet is an empty menu.
#[tauri::command]
pub async fn gh_pr_reviewer_candidates(
    state: State<'_, WorkspaceManager>,
    repo: String,
) -> Result<Vec<String>, String> {
    let top = repo_path(&state, &repo)?;
    let (owner, name) = gh_nwo(&top)?;
    let mut cmd = gh_in(&top);
    cmd.args([
        "api",
        "--paginate",
        "--jq",
        ".[].login",
        &format!("repos/{owner}/{name}/collaborators?per_page=100"),
    ]);
    // Listing collaborators needs push access; on a repo where we don't have it
    // an empty list is the honest answer, not an error the user can act on.
    let out = run_net(&mut cmd).unwrap_or_default();
    Ok(out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// Hand the landing decision to GitHub: it merges when the branch-protection
/// conditions are met, so nothing here has to poll or judge readiness.
#[tauri::command]
pub async fn gh_pr_auto_merge(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
    method: String,
    enable: bool,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let flag = match method.as_str() {
        "squash" => "--squash",
        "merge" => "--merge",
        "rebase" => "--rebase",
        other => return Err(format!("unsupported merge method: {other}")),
    };
    let mut cmd = gh_in(&top);
    if enable {
        cmd.args(["pr", "merge", &number.to_string(), "--auto", flag]);
    } else {
        cmd.args(["pr", "merge", &number.to_string(), "--disable-auto"]);
    }
    run_net(&mut cmd)?;
    Ok(if enable {
        format!("#{number} will merge automatically once its checks and reviews pass")
    } else {
        format!("Auto-merge off for #{number}")
    })
}

/// The tail of the failing checks' logs — the input an agent needs to fix CI,
/// and the thing you'd otherwise open a browser for. Capped: a failed run's log
/// can be megabytes, and only the end of it says what broke.
#[tauri::command]
pub async fn gh_pr_failing_logs(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args([
        "pr",
        "checks",
        &number.to_string(),
        "--json",
        "name,state,link",
    ]);
    let out = run_net(&mut cmd)?;
    let v: Value = serde_json::from_str(&out).unwrap_or(Value::Null);
    let failed: Vec<&Value> = v
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|c| {
                    matches!(
                        c["state"].as_str().unwrap_or(""),
                        "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED"
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    if failed.is_empty() {
        return Ok(String::new());
    }
    let mut report = String::new();
    for c in failed.iter().take(3) {
        let name = s(&c["name"]);
        let link = s(&c["link"]);
        report.push_str(&format!("=== {name} ({link})\n"));
        // The run id is the numeric segment after /runs/ in the check's link.
        let run_id = link
            .split("/runs/")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .unwrap_or("")
            .to_string();
        if run_id.is_empty() {
            report.push_str("(no run id in this check's link — open it on GitHub)\n\n");
            continue;
        }
        let mut logs = gh_in(&top);
        logs.args(["run", "view", &run_id, "--log-failed"]);
        match run_net(&mut logs) {
            Ok(text) => {
                let tail: Vec<&str> = text.lines().rev().take(120).collect();
                for line in tail.into_iter().rev() {
                    report.push_str(line);
                    report.push('\n');
                }
            }
            Err(e) => report.push_str(&format!("(couldn't read the log: {e})\n")),
        }
        report.push('\n');
    }
    Ok(report)
}

/// The diff between two commits of this PR — "what changed since I last
/// reviewed". Served by GitHub's compare API so it works whether or not the
/// branch is fetched locally.
#[tauri::command]
pub async fn gh_pr_diff_since(
    state: State<'_, WorkspaceManager>,
    repo: String,
    base_sha: String,
    head_sha: String,
) -> Result<String, String> {
    if base_sha.is_empty() || head_sha.is_empty() {
        return Err("need two commits to compare".into());
    }
    let top = repo_path(&state, &repo)?;
    let (owner, name) = gh_nwo(&top)?;
    let mut cmd = gh_in(&top);
    cmd.args([
        "api",
        "-H",
        "Accept: application/vnd.github.v3.diff",
        &format!("repos/{owner}/{name}/compare/{base_sha}...{head_sha}"),
    ]);
    run_net(&mut cmd)
}

// ---------- worktrees ----------
//
// Worktrees are the core primitive for running agents in parallel: each agent
// gets its own checkout of the same repo, so they can work on different
// branches simultaneously without fighting over one working tree.

#[derive(Serialize, Clone, Default)]
pub struct WorktreeInfo {
    pub path: String,
    pub name: String,
    pub head: String,
    pub branch: Option<String>,
    pub detached: bool,
    pub bare: bool,
    /// Locked worktrees can't be pruned; the reason is git's own.
    pub locked: Option<String>,
    /// Git thinks this worktree's directory is gone — safe to prune.
    pub prunable: Option<String>,
    /// The repo's own main working tree, not a linked one.
    pub is_main: bool,
    pub dirty: u32,
}

/// `git worktree list --porcelain` — blank-line separated records of
/// `key [value]` lines. Attribute lines (bare/detached/locked/prunable) may
/// appear with or without a value.
#[tauri::command]
pub async fn git_worktrees(
    state: State<'_, WorkspaceManager>,
    repo: String,
) -> Result<Vec<WorktreeInfo>, String> {
    let top = repo_path(&state, &repo)?;
    list_worktrees(&top)
}

/// Parse `git worktree list --porcelain` and count uncommitted files in each
/// live worktree. Shared by the Worktrees tab and the work audit.
fn list_worktrees(top: &Path) -> Result<Vec<WorktreeInfo>, String> {
    let out = run(git(top).args(["worktree", "list", "--porcelain"]))?;

    let mut list: Vec<WorktreeInfo> = Vec::new();
    let mut cur: Option<WorktreeInfo> = None;
    for line in out.lines() {
        if line.trim().is_empty() {
            if let Some(w) = cur.take() {
                list.push(w);
            }
            continue;
        }
        let (key, value) = match line.split_once(' ') {
            Some((k, v)) => (k, v.to_string()),
            None => (line, String::new()),
        };
        match key {
            "worktree" => {
                if let Some(w) = cur.take() {
                    list.push(w);
                }
                cur = Some(WorktreeInfo {
                    name: value.rsplit('/').next().unwrap_or(&value).to_string(),
                    path: value,
                    ..Default::default()
                });
            }
            "HEAD" => {
                if let Some(w) = cur.as_mut() {
                    w.head = value.chars().take(8).collect();
                }
            }
            "branch" => {
                if let Some(w) = cur.as_mut() {
                    w.branch = Some(value.trim_start_matches("refs/heads/").to_string());
                }
            }
            "detached" => {
                if let Some(w) = cur.as_mut() {
                    w.detached = true;
                }
            }
            "bare" => {
                if let Some(w) = cur.as_mut() {
                    w.bare = true;
                }
            }
            "locked" => {
                if let Some(w) = cur.as_mut() {
                    w.locked = Some(if value.is_empty() {
                        "locked".into()
                    } else {
                        value
                    });
                }
            }
            "prunable" => {
                if let Some(w) = cur.as_mut() {
                    w.prunable = Some(if value.is_empty() {
                        "prunable".into()
                    } else {
                        value
                    });
                }
            }
            _ => {}
        }
    }
    if let Some(w) = cur.take() {
        list.push(w);
    }

    // First record is always the main working tree. Count dirty files per
    // worktree so the UI can show which ones have uncommitted work — the thing
    // you need before removing one.
    for (i, w) in list.iter_mut().enumerate() {
        w.is_main = i == 0;
        if w.prunable.is_none() && !w.bare {
            if let Ok(s) = run(git(std::path::Path::new(&w.path)).args(["status", "--porcelain"])) {
                w.dirty = s.lines().filter(|l| !l.trim().is_empty()).count() as u32;
            }
        }
    }
    Ok(list)
}

/// Create a worktree. `branch` is checked out there; with `create` it's a new
/// branch off the current HEAD. A branch can only be checked out in one
/// worktree at a time — git enforces that, and we surface its error verbatim.
#[tauri::command]
pub async fn git_worktree_add(
    state: State<'_, WorkspaceManager>,
    repo: String,
    path: String,
    branch: String,
    create: bool,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    if branch.trim().is_empty() {
        return Err("branch name is required".into());
    }
    let mut cmd = git(&top);
    cmd.arg("worktree").arg("add");
    if create {
        cmd.arg("-b").arg(branch.trim());
        cmd.arg(&path);
    } else {
        cmd.arg(&path);
        cmd.arg(branch.trim());
    }
    run(&mut cmd)?;
    Ok(format!("Worktree created at {path}"))
}

/// Fetch a PR's head and check it out in a fresh worktree, without touching the
/// main checkout's current branch. `pull/<n>/head` is exposed for every PR —
/// fork or not — so this reaches branches a plain `fetch` (origin's own branches
/// only) can't. `-B` (re)points the PR's branch at the fetched head and checks
/// it out in the worktree; the main checkout is never switched.
#[tauri::command]
pub async fn git_worktree_add_pr(
    state: State<'_, WorkspaceManager>,
    repo: String,
    path: String,
    number: u32,
    branch: String,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    if branch.trim().is_empty() {
        return Err("branch name is required".into());
    }
    let mut fetch = git(&top);
    fetch.args(["fetch", "origin", &format!("pull/{number}/head")]);
    run_net(&mut fetch)?;
    let mut add = git(&top);
    add.arg("worktree")
        .arg("add")
        .arg("-B")
        .arg(branch.trim())
        .arg(&path)
        .arg("FETCH_HEAD");
    run(&mut add)?;
    Ok(format!("Worktree created at {path}"))
}

/// Remove a worktree. Destructive when it holds uncommitted work, so `force` is
/// only ever passed after the UI has confirmed with the dirty count in hand.
#[tauri::command]
pub async fn git_worktree_remove(
    state: State<'_, WorkspaceManager>,
    repo: String,
    path: String,
    force: bool,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = git(&top);
    cmd.arg("worktree").arg("remove");
    if force {
        cmd.arg("--force");
    }
    cmd.arg(&path);
    run(&mut cmd)?;
    Ok("Worktree removed".into())
}

/// Drop administrative records for worktrees whose directories are gone.
#[tauri::command]
pub async fn git_worktree_prune(
    state: State<'_, WorkspaceManager>,
    repo: String,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let out = run(git(&top).args(["worktree", "prune", "-v"]))?;
    Ok(if out.trim().is_empty() {
        "Nothing to prune".into()
    } else {
        out.trim().to_string()
    })
}

/// A commit's metadata — everything the header needs, and nothing that costs
/// a diff computation. Split from the patch on purpose: `git show -s` is
/// milliseconds even on a big repo, so the view can paint immediately while
/// the patch (which is the expensive part) loads behind it.
#[derive(Serialize, Clone)]
pub struct CommitDetail {
    pub hash: String,
    pub short: String,
    pub author: String,
    pub email: String,
    /// ISO-ish author date, as git formats it.
    pub date: String,
    pub subject: String,
    /// Commit message minus the subject line.
    pub body: String,
    pub refs: String,
    /// Parent hashes — more than one means a merge.
    pub parents: Vec<String>,
}

#[derive(Serialize, Clone)]
pub struct CommitPatch {
    pub patch: String,
    pub files_changed: u32,
    pub insertions: u32,
    pub deletions: u32,
    /// The patch was too large to ship whole; `patch` holds the head of it.
    pub truncated: bool,
}

/// Count a unified patch's files and +/- lines.
///
/// Counting must happen INSIDE hunks: a removed line whose content begins with
/// `--` renders as `---`, and skipping every `---`/`+++` prefix to dodge the
/// file headers silently swallowed those. Headers only appear before the first
/// `@@` of a file, so tracking hunk state is both simpler and correct.
fn patch_stats(patch: &str) -> (u32, u32, u32) {
    let (mut files, mut adds, mut dels) = (0_u32, 0_u32, 0_u32);
    let mut in_hunk = false;
    for line in patch.lines() {
        if line.starts_with("diff --git ") {
            files += 1;
            in_hunk = false;
        } else if line.starts_with("@@") {
            in_hunk = true;
        } else if in_hunk {
            match line.as_bytes().first() {
                Some(b'+') => adds += 1,
                Some(b'-') => dels += 1,
                _ => {}
            }
        }
    }
    (files, adds, dels)
}

/// Truncate to at most `max` bytes, on a line boundary, without splitting a
/// character. Slicing a String by a raw byte index panics when that index
/// lands inside a multi-byte character — a 2 MB patch containing CJK or an
/// emoji would take the whole command down with it.
fn truncate_patch(patch: &mut String, max: usize) -> bool {
    if patch.len() <= max {
        return false;
    }
    let mut cut = max;
    while cut > 0 && !patch.is_char_boundary(cut) {
        cut -= 1;
    }
    let cut = patch[..cut].rfind('\n').map(|i| i + 1).unwrap_or(cut);
    patch.truncate(cut);
    true
}

/// Reject a branch name that could be read as an option or extra revision
/// argument. Names come from git itself here, but they reach a command line,
/// and `--upload-pack=…`-style injection is the reason to be strict.
fn checked_ref(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty()
        || n.starts_with('-')
        || n.contains("..")
        || n.contains(char::is_whitespace)
        || n.contains('~')
        || n.contains('^')
        || n.contains(':')
    {
        return Err("invalid branch name".into());
    }
    Ok(n.to_string())
}

/// Reject anything that isn't a hex object name before it reaches git — these
/// strings come from the UI, and `git show` accepts far broader revision
/// syntax (`HEAD@{...}`, ranges, paths after `--`).
fn checked_hash(hash: &str) -> Result<String, String> {
    let h = hash.trim();
    if h.is_empty() || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("invalid commit hash".into());
    }
    Ok(h.to_string())
}

#[tauri::command]
pub async fn git_commit_detail(
    state: State<'_, WorkspaceManager>,
    repo: String,
    hash: String,
) -> Result<CommitDetail, String> {
    let top = repo_path(&state, &repo)?;
    let hash = checked_hash(&hash)?;
    let meta = run(git(&top).args([
        "show",
        "-s",
        "--date=iso",
        "--pretty=format:%H\x1f%h\x1f%an\x1f%ae\x1f%ad\x1f%s\x1f%b\x1f%D\x1f%P",
        &hash,
    ]))?;
    let f: Vec<&str> = meta.split('\x1f').collect();
    if f.len() < 9 {
        return Err("commit not found".into());
    }
    Ok(CommitDetail {
        hash: f[0].to_string(),
        short: f[1].to_string(),
        author: f[2].to_string(),
        email: f[3].to_string(),
        date: f[4].to_string(),
        subject: f[5].to_string(),
        body: f[6].trim().to_string(),
        refs: f[7].to_string(),
        parents: f[8].split_whitespace().map(String::from).collect(),
    })
}

/// A commit's patch, with its stats derived from the patch itself rather than
/// a second `--stat` pass — that pass recomputed the identical diff, which on
/// a large commit is the single most expensive thing this view did.
///
/// Commits are immutable, so results are cached for the run: reopening a tab
/// (or revisiting one) costs nothing.
#[tauri::command]
pub async fn git_commit_patch(
    state: State<'_, WorkspaceManager>,
    repo: String,
    hash: String,
) -> Result<CommitPatch, String> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    /// Big enough for any patch a human reviews; past this the cost is all in
    /// shipping and rendering megabytes of generated diff (lockfiles, vendored
    /// trees) that nobody reads line by line.
    const MAX_PATCH_BYTES: usize = 2 * 1024 * 1024;
    static CACHE: OnceLock<Mutex<HashMap<String, CommitPatch>>> = OnceLock::new();

    let top = repo_path(&state, &repo)?;
    let hash = checked_hash(&hash)?;
    let cache_key = format!("{}\x1f{hash}", top.display());
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().unwrap().get(&cache_key) {
        return Ok(hit.clone());
    }

    // Merges print no patch under plain `git show`; that is reported as an
    // empty patch rather than reaching for a combined diff the renderer
    // cannot display anyway.
    let mut patch = run(git(&top).args(["show", "--patch", "--format=", &hash]))?;

    let (files, adds, dels) = patch_stats(&patch);
    let truncated = truncate_patch(&mut patch, MAX_PATCH_BYTES);

    let result = CommitPatch {
        patch,
        files_changed: files,
        insertions: adds,
        deletions: dels,
        truncated,
    };
    cache.lock().unwrap().insert(cache_key, result.clone());
    Ok(result)
}

/// Whether the GitHub CLI is installed and who it is signed in as. Powers the
/// Integrations settings section: "install it", "sign in", "signed in as X,
/// sign out" are three different states and the UI has to tell them apart.
#[derive(Serialize, Clone)]
pub struct GhAuth {
    pub installed: bool,
    /// Resolved path, so the settings screen can show what it found.
    pub path: String,
    pub authenticated: bool,
    /// Login name when signed in.
    pub account: String,
    pub host: String,
    /// gh's own message when something is off — shown verbatim rather than
    /// paraphrased, since it usually says exactly what to do.
    pub detail: String,
}

#[tauri::command]
pub async fn gh_auth() -> Result<GhAuth, String> {
    let bin = gh_bin();
    let installed = Command::new(&bin)
        .no_console_window()
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !installed {
        return Ok(GhAuth {
            installed: false,
            path: String::new(),
            authenticated: false,
            account: String::new(),
            host: String::new(),
            detail: String::new(),
        });
    }
    // `gh api user` is the honest test: `gh auth status` reports a stored
    // token even when it has been revoked server-side.
    let mut cmd = Command::new(&bin);
    cmd.env("GH_PROMPT_DISABLED", "1");
    cmd.no_console_window();
    cmd.args(["api", "user", "--jq", ".login"]);
    let (authenticated, account, detail) = match cmd.output() {
        Ok(o) if o.status.success() => (
            true,
            String::from_utf8_lossy(&o.stdout).trim().to_string(),
            String::new(),
        ),
        Ok(o) => (
            false,
            String::new(),
            String::from_utf8_lossy(&o.stderr)
                .trim()
                .lines()
                .next()
                .unwrap_or("")
                .to_string(),
        ),
        Err(e) => (false, String::new(), e.to_string()),
    };
    let host = Command::new(&bin)
        .no_console_window()
        .args(["auth", "status"])
        .output()
        .ok()
        .map(|o| {
            let text = format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            text.lines()
                .find(|l| l.trim_start().starts_with("Logged in to"))
                .and_then(|l| l.split_whitespace().nth(3).map(String::from))
                .unwrap_or_default()
        })
        .unwrap_or_default();
    Ok(GhAuth {
        installed: true,
        path: bin,
        authenticated,
        account,
        host,
        detail,
    })
}

/// The repo's browsable web URL, derived from origin. Empty when there is no
/// origin or it isn't an http/ssh remote we can rewrite (a local path, say).
///
/// Both remote spellings normalise to the same https base:
///   git@github.com:owner/repo.git  ->  https://github.com/owner/repo
///   https://github.com/owner/repo.git
#[tauri::command]
pub async fn git_remote_url(
    state: State<'_, WorkspaceManager>,
    repo: String,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let raw = run(git(&top).args(["remote", "get-url", "origin"])).unwrap_or_default();
    let raw = raw.trim();
    if raw.is_empty() {
        return Ok(String::new());
    }
    let url = if let Some(rest) = raw.strip_prefix("git@") {
        // host:owner/repo -> host/owner/repo
        match rest.split_once(':') {
            Some((host, path)) => format!("https://{host}/{path}"),
            None => return Ok(String::new()),
        }
    } else if raw.starts_with("https://") || raw.starts_with("http://") {
        raw.to_string()
    } else if let Some(rest) = raw.strip_prefix("ssh://git@") {
        format!("https://{rest}")
    } else {
        // file:// or a bare path — nothing to browse.
        return Ok(String::new());
    };
    Ok(url
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_string())
}

// ---------- work audit: what did the agents leave behind ----------
//
// The question this answers is NOT "which branches exist" — it is "which of
// these can I delete, and which hold work that exists nowhere else". Agents
// create worktrees and branches faster than anyone can track, then move on;
// what is left behind is indistinguishable at a glance from active work.
//
// Safety is about EXISTENCE, not merge status: uncommitted files live only in
// that directory, and unpushed commits live only in this clone. Those are the
// two states where deleting loses work for good. Merge status is about
// clutter — a merged branch is safe to remove, it is just noise until you do.

#[derive(Serialize, Clone)]
pub struct BranchWork {
    pub branch: String,
    /// Worktree holding it, if any. None = a branch nobody checked out.
    pub worktree: Option<String>,
    pub is_main: bool,
    /// Worktree directory is gone; the record is stale.
    pub prunable: bool,
    pub current: bool,
    /// Uncommitted files in its worktree. Only this directory has them.
    pub dirty: u32,
    /// Commits not on its upstream (or, with no upstream, not on base).
    pub ahead: u32,
    pub behind: u32,
    pub upstream: Option<String>,
    /// Upstream was deleted — on GitHub, what happens when a PR merges with
    /// "delete branch on merge" on. Strong signal the work landed.
    pub upstream_gone: bool,
    /// Tip is an ancestor of base: merged the plain way.
    pub merged: bool,
    /// An integration branch (main/develop/…) or the base itself — never
    /// offered for cleanup or deletion, however "merged" it reads.
    pub protected: bool,
    pub last_commit: String,
    pub age_days: u32,
    pub subject: String,
    pub author: String,
}

#[derive(Serialize, Clone)]
pub struct WorkAudit {
    /// Branch merge status was measured against.
    pub base: String,
    /// True when git could not report counts against base (needs git 2.41+
    /// for %(ahead-behind:)) — the UI then hides "unpushed" for branches
    /// with no upstream rather than showing a wrong zero.
    pub counts_degraded: bool,
    pub items: Vec<BranchWork>,
}

/// The branch merges are measured against: origin's default branch when it is
/// knowable, else a local main/master, else the current branch (which makes
/// every other branch read as unmerged — correct, if unhelpful).
fn default_base(top: &Path) -> String {
    if let Ok(sym) = run(git(top).args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])) {
        let s = sym.trim();
        if !s.is_empty() {
            return s.to_string();
        }
    }
    for cand in ["origin/main", "origin/master", "main", "master"] {
        if run(git(top).args(["rev-parse", "--verify", "--quiet", cand])).is_ok() {
            return cand.to_string();
        }
    }
    run(git(top).args(["rev-parse", "--abbrev-ref", "HEAD"]))
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|_| "HEAD".into())
}

/// Branches that must never be offered for cleanup or deletion: the integration
/// branches every repo keeps forever, plus whatever this repo's base actually
/// is. `base` may carry a remote prefix (origin/main) — compare on the leaf.
fn is_protected_branch(name: &str, base: &str) -> bool {
    let base_leaf = base.rsplit('/').next().unwrap_or(base);
    name == base_leaf
        || matches!(
            name,
            "main" | "master" | "develop" | "development" | "trunk" | "staging" | "production"
        )
}

#[tauri::command]
pub async fn git_work_audit(
    state: State<'_, WorkspaceManager>,
    repo: String,
) -> Result<WorkAudit, String> {
    let top = repo_path(&state, &repo)?;
    let base = default_base(&top);

    // Worktrees first: this is the only part that costs a process per entry
    // (a status per worktree), and it is what gives us dirty counts.
    let worktrees = list_worktrees(&top)?;
    let current = run(git(&top).args(["rev-parse", "--abbrev-ref", "HEAD"]))
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    // Every local branch in ONE call: upstream, tracking, date, subject,
    // author. Never per-branch — a repo with 24 agent worktrees would spawn a
    // process storm for a panel that should feel instant.
    const FIELDS: &str = "%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:unix)%1f%(contents:subject)%1f%(authorname)";
    let refs = run(git(&top).args(["for-each-ref", "--format", FIELDS, "refs/heads"]))?;

    // Ahead/behind vs base needs git 2.41+. Asked for separately so an older
    // git degrades to "no counts" instead of failing the whole listing.
    let mut vs_base: std::collections::HashMap<String, (u32, u32)> = Default::default();
    let ab_fmt = format!("%(refname:short)%1f%(ahead-behind:{base})");
    let counts_degraded =
        match run(git(&top).args(["for-each-ref", "--format", &ab_fmt, "refs/heads"])) {
            Ok(out) => {
                for line in out.lines() {
                    let mut f = line.split('\x1f');
                    let (Some(name), Some(counts)) = (f.next(), f.next()) else {
                        continue;
                    };
                    let mut n = counts.split_whitespace();
                    if let (Some(a), Some(b)) = (n.next(), n.next()) {
                        if let (Ok(a), Ok(b)) = (a.parse(), b.parse()) {
                            vs_base.insert(name.to_string(), (a, b));
                        }
                    }
                }
                vs_base.is_empty()
            }
            Err(_) => true,
        };

    let merged: std::collections::HashSet<String> =
        run(git(&top).args(["branch", "--merged", &base, "--format", "%(refname:short)"]))
            .unwrap_or_default()
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let mut items = Vec::new();
    for line in refs.lines() {
        let f: Vec<&str> = line.split('\x1f').collect();
        if f.len() < 6 {
            continue;
        }
        let branch = f[0].to_string();
        let upstream = (!f[1].is_empty()).then(|| f[1].to_string());
        let track = f[2];
        let upstream_gone = track.contains("gone");
        // "[ahead 2, behind 1]" — absent entirely when in sync.
        let parse_track = |kw: &str| -> u32 {
            track
                .split(|c| c == '[' || c == ']' || c == ',')
                .find_map(|p| p.trim().strip_prefix(kw))
                .and_then(|n| n.trim().parse().ok())
                .unwrap_or(0)
        };
        // With an upstream, "unpushed" means ahead of it. Without one, the
        // work exists only here, so measure against base instead.
        let (ahead, behind) = if upstream.is_some() && !upstream_gone {
            (parse_track("ahead "), parse_track("behind "))
        } else {
            vs_base.get(&branch).copied().unwrap_or((0, 0))
        };
        let ts: u64 = f[3].parse().unwrap_or(now);
        let wt = worktrees
            .iter()
            .find(|w| w.branch.as_deref() == Some(branch.as_str()));
        items.push(BranchWork {
            worktree: wt.map(|w| w.path.clone()),
            is_main: wt.map(|w| w.is_main).unwrap_or(false),
            prunable: wt.map(|w| w.prunable.is_some()).unwrap_or(false),
            current: branch == current,
            dirty: wt.map(|w| w.dirty).unwrap_or(0),
            ahead,
            behind,
            upstream,
            upstream_gone,
            merged: merged.contains(&branch),
            protected: is_protected_branch(&branch, &base),
            last_commit: f[3].to_string(),
            age_days: ((now.saturating_sub(ts)) / 86_400) as u32,
            subject: f[4].to_string(),
            author: f[5].to_string(),
            branch,
        });
    }

    Ok(WorkAudit {
        base,
        counts_degraded,
        items,
    })
}

/// Delete a local branch. `force` uses `-D` (needed for a squash-merged branch
/// whose remote is gone — git can't see it as merged), else the safe `-d` which
/// refuses to drop unmerged work. Protected and current branches are refused
/// here too, not only hidden in the UI: this command is reachable from page
/// script, so the guard can't live only in the frontend.
#[tauri::command]
pub async fn git_branch_delete(
    state: State<'_, WorkspaceManager>,
    repo: String,
    branch: String,
    force: bool,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let branch = checked_ref(&branch)?;
    let base = default_base(&top);
    if is_protected_branch(&branch, &base) {
        return Err(format!(
            "{branch} is a protected branch and can't be deleted here"
        ));
    }
    let current = run(git(&top).args(["rev-parse", "--abbrev-ref", "HEAD"]))
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    if branch == current {
        return Err("can't delete the branch you're on — switch away first".into());
    }
    let flag = if force { "-D" } else { "-d" };
    run(git(&top).args(["branch", flag, &branch]))?;
    Ok(format!("Deleted {branch}"))
}

/// Delete a branch on the remote — `git push origin --delete <branch>`. This is
/// the twin of git_branch_delete: that one removes the *local* copy, this one
/// removes the copy on GitHub, and a fully-cleaned branch needs both. Outward
/// facing (everyone loses the branch), so the UI confirms first. Protected
/// branches are refused here as well, so a stray right-click can't wipe `main`
/// off the remote.
#[tauri::command]
pub async fn git_branch_delete_remote(
    state: State<'_, WorkspaceManager>,
    repo: String,
    branch: String,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let branch = checked_ref(&branch)?;
    let base = default_base(&top);
    if is_protected_branch(&branch, &base) {
        return Err(format!(
            "{branch} is a protected branch and can't be deleted here"
        ));
    }
    let mut cmd = git(&top);
    // The push refspec `:branch` (empty source) is git's own way of saying
    // "delete that ref on the remote"; --delete is the readable spelling of it.
    cmd.args(["push", "origin", "--delete", &branch]);
    run_net(&mut cmd)?;
    Ok(format!("Deleted {branch} on GitHub"))
}

/// Commits a branch has that the base does not — the "what is in here" list
/// behind a Loose ends row. Metadata only: no patches, so this is one process
/// and paints instantly (see the branch patch command for the heavy half).
#[tauri::command]
pub async fn git_branch_commits(
    state: State<'_, WorkspaceManager>,
    repo: String,
    branch: String,
) -> Result<Vec<CommitInfo>, String> {
    let top = repo_path(&state, &repo)?;
    let branch = checked_ref(&branch)?;
    let base = default_base(&top);
    Ok(branch_commits_of(&top, &base, &branch))
}

/// base..branch — commits on the branch and not on base. Bounded: a branch
/// with thousands of commits is a fork, not a loose end.
fn branch_commits_of(top: &Path, base: &str, branch: &str) -> Vec<CommitInfo> {
    let out = run(git(top).args([
        "log",
        "-200",
        "--date=short",
        "--pretty=format:%H\x1f%h\x1f%an\x1f%ad\x1f%s\x1f%D",
        &format!("{base}..{branch}"),
    ]))
    .unwrap_or_default();
    out.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\x1f').collect();
            if f.len() < 5 {
                return None;
            }
            Some(CommitInfo {
                hash: f[0].to_string(),
                short: f[1].to_string(),
                author: f[2].to_string(),
                date: f[3].to_string(),
                subject: f[4].to_string(),
                refs: f.get(5).unwrap_or(&"").to_string(),
            })
        })
        .collect()
}

/// One agent session's work, joined against git: the digest's cwd resolved to
/// a workdir this repo owns, the live branch, counts, and the base..branch
/// commit list. Metadata only — patches stay behind `git_branch_patch` and the
/// PR match stays behind `gh_pr_list`, so this paints instantly.
#[derive(Serialize)]
pub struct AgentWorkspace {
    pub session_id: String,
    pub agent: Option<String>,
    pub state: Option<String>,
    pub cwd: Option<String>,
    pub updated: Option<u64>,
    /// Files the agent itself reported editing — intent, capped by the hook;
    /// the diff panes are the authoritative list.
    pub touched: Vec<String>,
    /// Live HEAD of the workdir when it exists, else the digest's snapshot.
    pub branch: Option<String>,
    pub detached: bool,
    pub base: String,
    /// The agent works directly on the base/protected branch — there is no
    /// branch-scoped view, only uncommitted changes.
    pub on_base: bool,
    /// Directory for uncommitted diffs, authorized against this repo's own
    /// worktree list. None when the cwd is gone or belongs elsewhere.
    pub workdir: Option<String>,
    /// The workdir is a linked worktree, not the shared checkout.
    pub isolated: bool,
    pub cwd_missing: bool,
    pub dirty: u32,
    pub ahead: u32,
    pub behind: u32,
    pub merged: bool,
    pub commits: Vec<CommitInfo>,
}

#[tauri::command]
pub async fn agent_workspace(
    state: State<'_, WorkspaceManager>,
    repo: String,
    session_id: String,
) -> Result<AgentWorkspace, String> {
    // The id becomes a file name inside ~/.canopy/sessions — same guard as
    // session_forget, expressed as an allowlist.
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        || session_id.contains("..")
    {
        return Err("invalid session id".into());
    }
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let digest_path = PathBuf::from(&home)
        .join(".canopy")
        .join("sessions")
        .join(format!("{session_id}.json"));
    let digest: serde_json::Value = std::fs::read_to_string(&digest_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .ok_or_else(|| "no digest for this session".to_string())?;
    let dstr = |k: &str| digest.get(k).and_then(|v| v.as_str()).map(str::to_string);

    let top = repo_path(&state, &repo)?;
    let base = default_base(&top);
    let touched = digest
        .get("files")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|f| f.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    workspace_join(
        &top,
        base,
        session_id,
        dstr("agent"),
        dstr("state"),
        digest.get("updated").and_then(|v| v.as_u64()),
        touched,
        dstr("cwd"),
        dstr("branch"),
    )
}

/// Same workspace, keyed on a live terminal's cwd rather than a hook digest —
/// so a hookless CLI (codex, agy, …) gets the full branch/diff/commit/PR view
/// too. Identity (`agent`) comes from the caller (the process tree), never from
/// a stale digest that a reused PTY might still carry. A `session_id` is optional
/// enrichment: when a hook wrote one, its state and reported-file list ride along.
#[tauri::command]
pub async fn agent_workspace_at(
    state: State<'_, WorkspaceManager>,
    repo: String,
    cwd: String,
    agent: Option<String>,
    session_id: Option<String>,
) -> Result<AgentWorkspace, String> {
    let top = repo_path(&state, &repo)?;
    let base = default_base(&top);
    // Digest enrichment only when the id is present and well-formed (same guard
    // as agent_workspace); everything below the identity line is git-derived
    // from `cwd`, so a missing or malformed id degrades to a bare workspace.
    let valid = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
            && !s.contains("..")
    };
    let (sid, state_s, updated, touched, branch_fallback) = match session_id.as_deref() {
        Some(s) if valid(s) => {
            let home = std::env::var("HOME").unwrap_or_default();
            let digest: Option<serde_json::Value> = std::fs::read_to_string(
                PathBuf::from(&home)
                    .join(".canopy")
                    .join("sessions")
                    .join(format!("{s}.json")),
            )
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok());
            let d = digest.as_ref();
            let dstr = |k: &str| {
                d.and_then(|v| v.get(k))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            };
            let touched = d
                .and_then(|v| v.get("files"))
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|f| f.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let updated = d.and_then(|v| v.get("updated")).and_then(|v| v.as_u64());
            (
                s.to_string(),
                dstr("state"),
                updated,
                touched,
                dstr("branch"),
            )
        }
        _ => (String::new(), None, None, Vec::new(), None),
    };
    workspace_join(
        &top,
        base,
        sid,
        agent,
        state_s,
        updated,
        touched,
        Some(cwd),
        branch_fallback,
    )
}

/// One edit the agent authored, read back from its change journal. `present`
/// says the `new` text is still in the file — a later edit by anyone supersedes
/// it, which is how a co-edited file reads honestly: this agent's hunks, each
/// marked live or superseded, regardless of what the shared working tree shows.
#[derive(Serialize)]
pub struct AgentEdit {
    pub ts: u64,
    /// Repo-relative when it resolves under this repo, else the recorded path.
    pub path: String,
    pub tool: String,
    pub old: Option<String>,
    pub new: Option<String>,
    pub present: bool,
}

/// The per-agent change journal for a session: what *this* agent changed, at
/// the moment it changed it (written by canopy_hook on each edit). Unlike the
/// working-tree diff, this attributes hunks per agent even on a shared checkout.
/// Newest last, capped. Missing journal (hookless CLI, or a session that predates
/// journaling) simply returns empty — the caller falls back to the tree view.
#[tauri::command]
pub async fn agent_edits(
    state: State<'_, WorkspaceManager>,
    repo: Option<String>,
    session_id: String,
) -> Result<Vec<AgentEdit>, String> {
    // Same allowlist guard as agent_workspace — the id is a file name.
    if session_id.is_empty()
        || !session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        || session_id.contains("..")
    {
        return Err("invalid session id".into());
    }
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let jpath = PathBuf::from(&home)
        .join(".canopy")
        .join("sessions")
        .join(format!("{session_id}.edits.jsonl"));
    let Ok(raw) = std::fs::read_to_string(&jpath) else {
        return Ok(vec![]);
    };
    // The present-check reads files; keep it inside the opened repo so a tampered
    // journal can't turn this into an arbitrary-read. No repo → no present-check
    // and no relativisation, but the authored edits still show.
    let top = repo.as_deref().and_then(|r| repo_path(&state, r).ok());
    let canon_top = top
        .as_deref()
        .map(|t| std::fs::canonicalize(t).unwrap_or_else(|_| t.to_path_buf()));
    // Read each touched file at most once.
    let mut cache: std::collections::HashMap<String, Option<String>> =
        std::collections::HashMap::new();
    const MAX_EDITS: usize = 400;
    let lines: Vec<&str> = raw.lines().collect();
    let start = lines.len().saturating_sub(MAX_EDITS);
    let mut out = Vec::new();
    for line in &lines[start..] {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let abs = v["path"].as_str().unwrap_or("");
        if abs.is_empty() {
            continue;
        }
        let new = v["new"].as_str().map(str::to_string);
        let old = v["old"].as_str().map(str::to_string);
        // Only files under the opened repo are read; anything else is left
        // unresolved (present = false) rather than touched.
        let under_repo = canon_top
            .as_ref()
            .map(|t| {
                std::fs::canonicalize(abs)
                    .map(|a| a.starts_with(t))
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        let present = if under_repo {
            let content = cache
                .entry(abs.to_string())
                .or_insert_with(|| std::fs::read_to_string(abs).ok());
            match (&new, content.as_ref()) {
                (Some(n), Some(c)) => {
                    let needle = n.trim_end_matches("\n…(truncated)");
                    !needle.is_empty() && c.contains(needle)
                }
                _ => false,
            }
        } else {
            false
        };
        let path = canon_top
            .as_ref()
            .and_then(|t| {
                std::fs::canonicalize(abs).ok().and_then(|a| {
                    a.strip_prefix(t)
                        .ok()
                        .map(|p| p.to_string_lossy().to_string())
                })
            })
            .unwrap_or_else(|| abs.to_string());
        out.push(AgentEdit {
            ts: v["ts"].as_u64().unwrap_or(0),
            path,
            tool: v["tool"].as_str().unwrap_or("").to_string(),
            old,
            new,
            present,
        });
    }
    Ok(out)
}

/// The git half of an agent workspace, shared by the digest-keyed
/// `agent_workspace` and the cwd-keyed `agent_workspace_at`: resolve the cwd to
/// a workdir this repo owns, then read the live branch, counts and commit list.
/// Identity (`agent`/`state`/`touched`) is supplied by the caller — from a hook
/// digest when there is one, or from the live process when there isn't.
#[allow(clippy::too_many_arguments)]
fn workspace_join(
    top: &Path,
    base: String,
    session_id: String,
    agent: Option<String>,
    state: Option<String>,
    updated: Option<u64>,
    touched: Vec<String>,
    cwd: Option<String>,
    branch_fallback: Option<String>,
) -> Result<AgentWorkspace, String> {
    // Resolve the cwd to a workdir this repo actually owns. Git's own worktree
    // list is the authority, compared canonically — agent-made worktrees were
    // never registered as workspace roots (see git_branch_patch for the full
    // rationale).
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let mut workdir: Option<PathBuf> = None;
    let mut cwd_missing = false;
    if let Some(c) = cwd.as_deref() {
        let dir = Path::new(c);
        if dir.is_dir() {
            if let Some(wt_top) = toplevel_of(dir) {
                let want = canon(&wt_top);
                if want == canon(top)
                    || list_worktrees(top)?
                        .iter()
                        .any(|w| canon(Path::new(&w.path)) == want)
                {
                    workdir = Some(wt_top);
                }
            }
        } else {
            cwd_missing = true;
        }
    }
    let isolated = workdir
        .as_deref()
        .map(|w| canon(w) != canon(top))
        .unwrap_or(false);

    // The live branch beats the snapshot; the snapshot still names the branch
    // after the workdir is gone.
    let (mut branch, mut detached) = (None, false);
    if let Some(w) = &workdir {
        let (b, d) = head_branch(w);
        branch = b;
        detached = d;
    }
    if branch.is_none() && !detached {
        branch = branch_fallback;
    }
    let on_base = !detached
        && branch
            .as_deref()
            .map(|b| is_protected_branch(b, &base))
            .unwrap_or(false);

    let mut dirty = 0u32;
    if let Some(w) = &workdir {
        if let Ok(s) = run(git(w).args(["status", "--porcelain"])) {
            dirty = s.lines().filter(|l| !l.trim().is_empty()).count() as u32;
        }
    }

    let (mut ahead, mut behind, mut merged) = (0u32, 0u32, false);
    let mut commits = Vec::new();
    if !detached && !on_base {
        // checked_ref guards the digest-supplied fallback; a live branch from
        // symbolic-ref passes trivially. A weird name degrades to no counts
        // rather than failing the whole view.
        if let Some(b) = branch.as_deref().and_then(|b| checked_ref(b).ok()) {
            if let Ok(out) = run(git(top).args([
                "rev-list",
                "--left-right",
                "--count",
                &format!("{base}...{b}"),
            ])) {
                let mut n = out.split_whitespace();
                behind = n.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                ahead = n.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            }
            merged = git(top)
                .args(["merge-base", "--is-ancestor", &b, &base])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            commits = branch_commits_of(top, &base, &b);
        }
    }

    Ok(AgentWorkspace {
        session_id,
        agent,
        state,
        cwd,
        updated,
        touched,
        branch,
        detached,
        base,
        on_base,
        workdir: workdir.map(|w| w.to_string_lossy().to_string()),
        isolated,
        cwd_missing,
        dirty,
        ahead,
        behind,
        merged,
        commits,
    })
}

/// A branch's patch. `uncommitted` gives the working-tree changes in its
/// worktree (never cached — they change as you look at them); otherwise the
/// cumulative diff of base...branch (cached: for a given pair of tips it can
/// not change).
#[tauri::command]
pub async fn git_branch_patch(
    state: State<'_, WorkspaceManager>,
    repo: String,
    branch: String,
    worktree: Option<String>,
    uncommitted: bool,
) -> Result<CommitPatch, String> {
    const MAX_PATCH_BYTES: usize = 2 * 1024 * 1024;
    let top = repo_path(&state, &repo)?;
    let branch = checked_ref(&branch)?;

    let mut patch = if uncommitted {
        let dir = match worktree {
            // Authorize against the repo's OWN worktree list, not the
            // workspace roots. A worktree an agent created in a terminal was
            // never registered as a root, so check_scope refused it — which
            // is precisely the abandoned worktree Loose ends is for. Git
            // itself is the authority on what belongs to this repo.
            Some(w) => {
                // Compare canonically: a trailing slash, a `..`, or a
                // symlinked prefix (/tmp vs /private/tmp on macOS) all name
                // the same worktree in strings git never produced, and an
                // exact-string match would refuse a worktree that plainly
                // exists.
                let canon = |p: &str| std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
                let want = canon(&w);
                let known = list_worktrees(&top)?
                    .into_iter()
                    .any(|x| canon(&x.path) == want);
                if !known {
                    return Err("not a worktree of this repository".into());
                }
                // git keeps listing a worktree after its directory is deleted
                // (that is what "prunable" means, and those are exactly the
                // ones Loose ends surfaces). Every git call below would fail
                // on the missing cwd and unwrap_or_default() would render that
                // as an empty diff. Say what is actually true instead.
                if !want.is_dir() {
                    return Err("this worktree's directory no longer exists".into());
                }
                want
            }
            None => top.clone(),
        };
        // Tracked changes, plus untracked files rendered as additions —
        // `git diff` alone would silently omit brand-new files, which is
        // exactly the work most at risk of being thrown away.
        let mut p = run(git(&dir).args(["diff", "HEAD"])).unwrap_or_default();
        // -z: NUL-delimited and UNQUOTED. Without it, core.quotePath wraps any
        // path with non-ASCII or special characters in quotes and escapes it
        // ("caf\303\251.md"), and that literal — quotes included — was handed
        // to `git diff` as a filename, which failed. Since the error is
        // swallowed below, those files vanished from the patch: the same
        // "nothing here, safe to delete" lie in a new costume.
        let untracked = run(git(&dir).args(["ls-files", "--others", "--exclude-standard", "-z"]))
            .unwrap_or_default();
        // `git diff --no-index` exits 1 whenever the files differ — which is
        // always, since we are diffing against /dev/null. run() reports a
        // non-zero exit as an error, so every untracked file was silently
        // dropped and a worktree of brand-new files rendered as empty: the
        // exact "there is nothing here, safe to delete" lie this pane exists
        // to prevent. Read stdout directly, like git_diff already does.
        for file in untracked.split('\0').filter(|l| !l.is_empty()).take(100) {
            // Stop as soon as we are past what we would keep anyway. Without
            // this the whole loop runs first and truncates after, so a
            // worktree of large new files built the entire patch in memory
            // before throwing most of it away.
            if p.len() >= MAX_PATCH_BYTES {
                break;
            }
            // No --binary: a new PNG or database file would otherwise be
            // inlined as base85 and dwarf the text this pane exists to show.
            // Plain --no-index prints "Binary files ... differ", which is the
            // useful fact — the file is there and it is new.
            if let Ok(out) = git(&dir)
                .args(["diff", "--no-index", "--", "/dev/null", file])
                .output()
            {
                p.push_str(&String::from_utf8_lossy(&out.stdout));
            }
        }
        p
    } else {
        let base = default_base(&top);
        run(git(&top).args(["diff", &format!("{base}...{branch}")])).unwrap_or_default()
    };

    let (files, adds, dels) = patch_stats(&patch);
    let truncated = truncate_patch(&mut patch, MAX_PATCH_BYTES);
    Ok(CommitPatch {
        patch,
        files_changed: files,
        insertions: adds,
        deletions: dels,
        truncated,
    })
}

// ---------- tickets (issue #15) ----------
//
// One row shape for every tracker. GitHub Issues arrive through the user's
// own `gh` CLI — zero configuration, inherits their auth, exactly like the
// PR list. Linear is opt-in via a personal API key the frontend stores
// locally; the request goes straight from this machine to api.linear.app
// via curl (matching the shell-out-no-deps pattern), with the key delivered
// through curl's stdin config so it never appears in a process list.

#[derive(Serialize, Clone)]
pub struct TicketInfo {
    /// "#42" for GitHub, "ENG-123" for Linear.
    pub id: String,
    pub title: String,
    /// Human-readable state name ("open", "In Progress").
    pub state: String,
    /// Coarse machine type — GitHub: open/closed; Linear: its state.type
    /// (triage/backlog/unstarted/started).
    pub state_type: String,
    pub assignee: Option<String>,
    pub mine: bool,
    pub url: String,
    /// The tracker's own suggested branch name when it has one (Linear's
    /// branchName). GitHub has none; the frontend matches its
    /// "<number>-slug" branch convention instead.
    pub branch: Option<String>,
    /// Markdown description. Fetched with the list rather than on demand —
    /// both trackers return it in the same call, so a detail view costs no
    /// extra round trip.
    pub body: String,
    /// Human priority label when the tracker has one ("High"); empty otherwise.
    pub priority: String,
}

#[tauri::command]
pub async fn gh_issue_list(
    state: State<'_, WorkspaceManager>,
    repo: String,
) -> Result<Vec<TicketInfo>, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args([
        "issue",
        "list",
        "--state",
        "all",
        "--limit",
        "80",
        "--json",
        "number,title,state,url,assignees,updatedAt,body,labels",
    ]);
    let out = run_net(&mut cmd)?;
    let v: serde_json::Value =
        serde_json::from_str(&out).map_err(|e| format!("gh returned unexpected output: {e}"))?;
    let me = run_net(&mut {
        let mut c = gh_in(&top);
        c.args(["api", "user", "--jq", ".login"]);
        c
    })
    .unwrap_or_default()
    .trim()
    .to_string();

    Ok(v.as_array()
        .map(|arr| {
            arr.iter()
                .map(|i| {
                    let assignees: Vec<String> = i["assignees"]
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x["login"].as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    let state = i["state"].as_str().unwrap_or("").to_lowercase();
                    TicketInfo {
                        id: format!("#{}", i["number"].as_u64().unwrap_or(0)),
                        title: i["title"].as_str().unwrap_or("").to_string(),
                        state_type: state.clone(),
                        state,
                        mine: !me.is_empty() && assignees.iter().any(|a| a == &me),
                        assignee: assignees.into_iter().next(),
                        url: i["url"].as_str().unwrap_or("").to_string(),
                        branch: None,
                        body: i["body"].as_str().unwrap_or("").to_string(),
                        // GitHub has no priority field; surface a priority/P0
                        // style label if the repo uses one.
                        priority: i["labels"]
                            .as_array()
                            .and_then(|ls| {
                                ls.iter().find_map(|l| {
                                    let n = l["name"].as_str().unwrap_or("");
                                    let low = n.to_lowercase();
                                    (low.starts_with("p0")
                                        || low.starts_with("p1")
                                        || low.starts_with("priority"))
                                    .then(|| n.to_string())
                                })
                            })
                            .unwrap_or_default(),
                    }
                })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn linear_issues(api_key: String) -> Result<Vec<TicketInfo>, String> {
    use std::io::Write;
    if api_key.trim().is_empty() {
        return Err("no Linear API key".into());
    }
    // Active work only — completed/canceled would bury the list.
    let query = r#"{ viewer { id } issues(first: 100, orderBy: updatedAt, filter: { state: { type: { in: ["triage", "backlog", "unstarted", "started"] } } }) { nodes { identifier title url branchName description priorityLabel state { name type } assignee { id displayName } } } }"#;
    let body = serde_json::json!({ "query": query }).to_string();
    let mut child = std::process::Command::new(tool_path("curl"))
        .no_console_window()
        .args([
            "-sS",
            "--max-time",
            "15",
            "-K",
            "-", // read config (the auth header) from stdin — keeps the key out of argv
            "-H",
            "Content-Type: application/json",
            "--data-binary",
            &body,
            "https://api.linear.app/graphql",
        ])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("curl not available: {e}"))?;
    child
        .stdin
        .as_mut()
        .ok_or("curl stdin unavailable")?
        .write_all(format!("header = \"Authorization: {}\"\n", api_key.trim()).as_bytes())
        .map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "Linear request failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let v: serde_json::Value = serde_json::from_str(&String::from_utf8_lossy(&out.stdout))
        .map_err(|_| "Linear returned unexpected output".to_string())?;
    if let Some(err) = v["errors"].as_array().and_then(|a| a.first()) {
        return Err(format!(
            "Linear: {}",
            err["message"].as_str().unwrap_or("request rejected")
        ));
    }
    let viewer = v["data"]["viewer"]["id"].as_str().unwrap_or("").to_string();
    Ok(v["data"]["issues"]["nodes"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|i| {
                    let assignee_id = i["assignee"]["id"].as_str().unwrap_or("");
                    TicketInfo {
                        id: i["identifier"].as_str().unwrap_or("").to_string(),
                        title: i["title"].as_str().unwrap_or("").to_string(),
                        state: i["state"]["name"].as_str().unwrap_or("").to_string(),
                        state_type: i["state"]["type"].as_str().unwrap_or("").to_string(),
                        assignee: i["assignee"]["displayName"].as_str().map(String::from),
                        mine: !viewer.is_empty() && assignee_id == viewer,
                        url: i["url"].as_str().unwrap_or("").to_string(),
                        branch: i["branchName"].as_str().map(String::from),
                        body: i["description"].as_str().unwrap_or("").to_string(),
                        priority: match i["priorityLabel"].as_str().unwrap_or("") {
                            // Linear reports "No priority" for unset — treat
                            // that as no label rather than rendering it.
                            "No priority" => String::new(),
                            other => other.to_string(),
                        },
                    }
                })
                .collect()
        })
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clone_dir_name_handles_https_scp_and_git_suffix() {
        assert_eq!(
            clone_dir_name("https://github.com/owner/repo.git").as_deref(),
            Some("repo")
        );
        assert_eq!(
            clone_dir_name("https://github.com/owner/repo").as_deref(),
            Some("repo")
        );
        // scp form has no scheme; the split must handle ':' as well as '/'.
        assert_eq!(
            clone_dir_name("git@github.com:owner/repo.git").as_deref(),
            Some("repo")
        );
        // A trailing slash must not swallow the name.
        assert_eq!(
            clone_dir_name("https://host/owner/repo/").as_deref(),
            Some("repo")
        );
    }

    #[test]
    fn clone_dir_name_rejects_empty() {
        assert_eq!(clone_dir_name(""), None);
        assert_eq!(clone_dir_name("   "), None);
        assert_eq!(clone_dir_name("/"), None);
    }

    #[test]
    fn patch_stats_counts_files_and_hunk_lines_only() {
        // The diff/index/hunk headers must NOT be counted as additions/deletions
        // even though several begin with '+'/'-' (+++ / ---).
        let patch = "\
diff --git a/one.txt b/one.txt
index 111..222 100644
--- a/one.txt
+++ b/one.txt
@@ -1,2 +1,2 @@
-old line
+new line
 context
diff --git a/two.txt b/two.txt
index 333..444 100644
--- a/two.txt
+++ b/two.txt
@@ -0,0 +1 @@
+added
";
        let (files, adds, dels) = patch_stats(patch);
        assert_eq!(files, 2);
        assert_eq!(adds, 2); // "+new line" and "+added"
        assert_eq!(dels, 1); // "-old line"
    }

    #[test]
    fn patch_stats_empty_patch_is_zero() {
        assert_eq!(patch_stats(""), (0, 0, 0));
    }

    #[test]
    fn truncate_patch_leaves_short_input_untouched() {
        let mut p = "short\n".to_string();
        assert!(!truncate_patch(&mut p, 1000));
        assert_eq!(p, "short\n");
    }

    #[test]
    fn truncate_patch_cuts_on_a_line_boundary() {
        let mut p = "line1\nline2\nline3\n".to_string();
        let cut = truncate_patch(&mut p, 8); // lands inside "line2"
        assert!(cut);
        assert_eq!(p, "line1\n"); // rolled back to the last newline
    }

    #[test]
    fn truncate_patch_never_splits_a_multibyte_char() {
        // A patch of multi-byte chars with no newline: truncation must land on a
        // char boundary, never mid-codepoint (which would panic on slice).
        let mut p = "日本語テキスト".to_string();
        let cut = truncate_patch(&mut p, 7); // 7 bytes is inside a 3-byte char
        assert!(cut);
        assert!(p.is_char_boundary(p.len()));
        assert!(p.len() <= 7);
    }

    #[test]
    fn checked_ref_accepts_a_plain_branch() {
        assert_eq!(checked_ref("feature/foo").unwrap(), "feature/foo");
        assert_eq!(checked_ref("  main  ").unwrap(), "main"); // trimmed
    }

    #[test]
    fn checked_ref_rejects_injection_shaped_names() {
        for bad in [
            "",
            "-x",
            "a..b",
            "a b",
            "a~1",
            "a^",
            "a:b",
            "--upload-pack=x",
        ] {
            assert!(checked_ref(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn checked_hash_accepts_only_hex() {
        assert_eq!(checked_hash("deadBEEF01").unwrap(), "deadBEEF01");
        // Non-hex revision syntax git would otherwise accept must be rejected.
        for bad in ["", "xyz", "HEAD", "HEAD@{1}", "abc..def"] {
            assert!(checked_hash(bad).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn is_protected_branch_covers_integration_branches_and_the_base_leaf() {
        // Always-protected names regardless of base.
        for name in [
            "main",
            "master",
            "develop",
            "staging",
            "production",
            "trunk",
        ] {
            assert!(is_protected_branch(name, "origin/main"));
        }
        // The repo's own base, compared on the leaf (base may carry a remote).
        assert!(is_protected_branch("release", "origin/release"));
        // A normal feature branch is not protected.
        assert!(!is_protected_branch("feature/x", "origin/main"));
    }

    #[test]
    fn roll_up_checks_empty_is_blank() {
        assert_eq!(roll_up_checks(&json!([])), (String::new(), String::new()));
        assert_eq!(roll_up_checks(&json!(null)), (String::new(), String::new()));
    }

    #[test]
    fn roll_up_checks_fails_when_any_check_fails() {
        let rollup = json!([
            { "state": "SUCCESS" },
            { "status": "COMPLETED", "conclusion": "FAILURE" },
        ]);
        let (state, summary) = roll_up_checks(&rollup);
        assert_eq!(state, "FAIL");
        assert_eq!(summary, "1/2 checks passed");
    }

    #[test]
    fn roll_up_checks_pending_when_incomplete_but_none_failed() {
        let rollup = json!([
            { "state": "SUCCESS" },
            { "status": "IN_PROGRESS" },
        ]);
        let (state, summary) = roll_up_checks(&rollup);
        assert_eq!(state, "PENDING");
        assert_eq!(summary, "1/2 checks passed");
    }

    #[test]
    fn roll_up_checks_passes_when_all_green() {
        let rollup = json!([
            { "state": "SUCCESS" },
            { "status": "COMPLETED", "conclusion": "NEUTRAL" },
            { "status": "COMPLETED", "conclusion": "SKIPPED" },
        ]);
        let (state, summary) = roll_up_checks(&rollup);
        assert_eq!(state, "PASS");
        assert_eq!(summary, "3/3 checks passed");
    }

    /// A response shaped like the real one, so the field names the query depends
    /// on are pinned: if GitHub renames one, this fails instead of the tab
    /// silently rendering an empty conversation.
    fn conversation_fixture() -> Value {
        json!({
          "viewer": { "login": "me" },
          "repository": { "pullRequest": {
            "id": "PR_kw1",
            "body": "## What\nA thing.",
            "isDraft": false,
            "mergeable": "MERGEABLE",
            "reviewDecision": "CHANGES_REQUESTED",
            "headRefOid": "headsha",
            "autoMergeRequest": null,
            "comments": { "nodes": [
              { "id": "IC_1", "author": { "login": "alice" }, "body": "ship it?",
                "createdAt": "2026-07-01T10:00:00Z", "url": "u1",
                "viewerDidAuthor": false, "authorAssociation": "COLLABORATOR" }
            ]},
            "reviews": { "nodes": [
              { "id": "PRR_1", "author": { "login": "alice" }, "body": "one thing",
                "state": "CHANGES_REQUESTED", "submittedAt": "2026-07-01T11:00:00Z", "url": "u2",
                "viewerDidAuthor": false, "authorAssociation": "COLLABORATOR",
                "commit": { "oid": "sha1" } },
              { "id": "PRR_2", "author": { "login": "me" }, "body": "looks fine",
                "state": "COMMENTED", "submittedAt": "2026-07-02T11:00:00Z", "url": "u3",
                "viewerDidAuthor": true, "authorAssociation": "OWNER",
                "commit": { "oid": "sha2" } },
              { "id": "PRR_3", "author": { "login": "me" }, "body": "wip",
                "state": "PENDING", "submittedAt": null, "url": "u4",
                "viewerDidAuthor": true, "authorAssociation": "OWNER",
                "commit": { "oid": "sha3" } }
            ]},
            "reviewThreads": { "nodes": [
              { "id": "PRRT_1", "isResolved": false, "isOutdated": true,
                "path": "src/a.ts", "line": 12, "startLine": null, "diffSide": "RIGHT",
                "comments": { "nodes": [
                  { "id": "PRRC_1", "author": { "login": "alice" }, "body": "leaks",
                    "createdAt": "2026-07-01T10:30:00Z", "url": "u5",
                    "viewerDidAuthor": false, "authorAssociation": "COLLABORATOR" }
                ]}},
              { "id": "PRRT_2", "isResolved": true, "isOutdated": false,
                "path": "src/b.ts", "line": null, "startLine": null, "diffSide": "LEFT",
                "comments": { "nodes": [] }}
            ]},
            "files": { "nodes": [
              { "path": "src/a.ts", "viewerViewedState": "VIEWED", "additions": 4, "deletions": 1 },
              { "path": "src/b.ts", "viewerViewedState": "UNVIEWED", "additions": 0, "deletions": 2 }
            ]},
            "commits": { "nodes": [
              { "commit": { "statusCheckRollup": { "state": "FAILURE" } } }
            ]}
          }}
        })
    }

    #[test]
    fn parse_conversation_reads_every_comment_kind() {
        let c = parse_conversation(&conversation_fixture(), 1).expect("parses");
        assert_eq!(c.node_id, "PR_kw1");
        assert_eq!(c.viewer, "me");
        assert_eq!(c.head_sha, "headsha");
        assert_eq!(c.review_decision, "CHANGES_REQUESTED");
        assert!(!c.auto_merge);
        assert_eq!(c.comments.len(), 1);
        assert_eq!(c.comments[0].association, "COLLABORATOR");
        assert!(!c.comments[0].mine);
        assert_eq!(c.reviews.len(), 3);
        assert_eq!(c.threads.len(), 2);
        assert_eq!(c.threads[0].line, 12);
        assert!(c.threads[0].outdated && !c.threads[0].resolved);
        // A thread whose line is gone reports 0 rather than failing to parse —
        // the UI lists those in the rail instead of anchoring them in the diff.
        assert_eq!(c.threads[1].line, 0);
        assert_eq!(c.files.len(), 2);
        assert!(c.files[0].viewed);
        assert!(!c.files[1].viewed);
    }

    #[test]
    fn parse_conversation_takes_my_latest_submitted_review_as_the_delta_anchor() {
        let c = parse_conversation(&conversation_fixture(), 1).expect("parses");
        // sha2 is mine and submitted; sha1 is someone else's and sha3 is a
        // PENDING review, which has nothing to compare against.
        assert_eq!(c.my_last_review_sha, "sha2");
    }

    #[test]
    fn parse_conversation_uses_the_live_check_rollup() {
        let c = parse_conversation(&conversation_fixture(), 1).expect("parses");
        assert_eq!(c.checks, "FAIL");
    }

    #[test]
    fn parse_conversation_errors_when_the_pr_is_missing() {
        let empty = json!({ "viewer": { "login": "me" }, "repository": { "pullRequest": null } });
        let err = parse_conversation(&empty, 42)
            .err()
            .expect("no PR, no parse");
        assert!(err.contains("#42"));
    }

    #[test]
    fn rollup_state_collapses_graphql_states_onto_prinfo_vocabulary() {
        assert_eq!(rollup_state("SUCCESS"), "PASS");
        assert_eq!(rollup_state("FAILURE"), "FAIL");
        assert_eq!(rollup_state("ERROR"), "FAIL");
        assert_eq!(rollup_state("PENDING"), "PENDING");
        assert_eq!(rollup_state("EXPECTED"), "PENDING");
        assert_eq!(rollup_state(""), "");
    }

    /// The regression this file's history most needs: a command whose output is
    /// bigger than a pipe buffer used to deadlock — the child blocked in write,
    /// never exited, and the user was told "timed out after 120s" 120 seconds
    /// later. Any PR diff over ~64KB hit it.
    #[cfg(unix)]
    #[test]
    fn run_net_reads_output_larger_than_a_pipe_buffer() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args([
            "-c",
            "yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c 200000",
        ]);
        let started = std::time::Instant::now();
        let out = run_net(&mut cmd).expect("a large stdout is read, not timed out");
        assert!(out.len() > 190_000, "only got {} bytes", out.len());
        assert!(
            started.elapsed().as_secs() < 20,
            "took {}s — that is the deadlock, not slowness",
            started.elapsed().as_secs()
        );
    }

    #[cfg(unix)]
    #[test]
    fn run_net_still_reports_failure_output() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "echo trouble >&2; exit 3"]);
        assert_eq!(run_net(&mut cmd).unwrap_err(), "trouble");
    }

    #[test]
    fn recognises_githubs_oversized_diff_refusal() {
        // The shapes gh passes the 406 through as; a release PR hits this, and
        // it must not read as "no diff".
        assert!(is_diff_too_large(
            "could not find pull request diff: HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)"
        ));
        assert!(is_diff_too_large("PullRequest.diff too_large"));
        assert!(!is_diff_too_large("HTTP 404: Not Found"));
        assert!(!is_diff_too_large("could not find pull request"));
    }

    fn files_payload() -> String {
        [
            r#"{"filename":"src/a.ts","status":"modified","changes":3,"patch":"@@ -1,2 +1,3 @@\n a\n+b"}"#,
            r#"{"filename":"src/new.ts","status":"added","changes":1,"patch":"@@ -0,0 +1 @@\n+hello"}"#,
            r#"{"filename":"src/gone.ts","status":"removed","changes":1,"patch":"@@ -1 +0,0 @@\n-bye"}"#,
            r#"{"filename":"src/now.ts","previous_filename":"src/was.ts","status":"renamed","changes":1,"patch":"@@ -1 +1 @@\n-x\n+y"}"#,
            r#"{"filename":"logo.png","status":"modified","changes":0}"#,
            r#"{"filename":"pnpm-lock.yaml","status":"modified","changes":4211}"#,
        ]
        .join("\n")
    }

    #[test]
    fn assemble_patch_rebuilds_headers_git_can_be_parsed_from() {
        let patch = assemble_patch(&files_payload());
        // The view splits on `diff --git`, so every file must carry one.
        assert_eq!(patch.matches("diff --git ").count(), 6);
        assert!(
            patch.contains("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@")
        );
        // Added and removed files point at /dev/null on the side that has no
        // content, the way git writes them.
        assert!(patch.contains("--- /dev/null\n+++ b/src/new.ts"));
        assert!(patch.contains("--- a/src/gone.ts\n+++ /dev/null"));
        // A rename names both ends.
        assert!(patch.contains("diff --git a/src/was.ts b/src/now.ts"));
    }

    #[test]
    fn assemble_patch_explains_the_files_github_would_not_inline() {
        let patch = assemble_patch(&files_payload());
        // A real binary says only that.
        assert!(patch.contains("Binary files a/logo.png and b/logo.png differ"));
        // A file with changes but no patch is not a binary, and says so — the
        // frontend surfaces this line instead of claiming "binary".
        assert!(patch.contains("4211 changed lines"));
        assert!(patch.contains("GitHub didn't include this file's patch"));
    }

    #[test]
    fn assemble_patch_survives_junk_and_says_when_it_stopped() {
        // A blank line and an unparseable one are skipped, not fatal.
        let mixed = format!("\n{{not json\n{}", files_payload());
        assert_eq!(assemble_patch(&mixed).matches("diff --git ").count(), 6);

        let many: Vec<String> = (0..MAX_PATCH_FILES + 5)
            .map(|i| format!(r#"{{"filename":"f{i}.ts","status":"modified","changes":1,"patch":"@@ -1 +1 @@\n-a\n+b"}}"#))
            .collect();
        let patch = assemble_patch(&many.join("\n"));
        assert!(patch.contains("5 more file(s) not shown"));
    }

    #[test]
    fn assemble_patch_of_nothing_is_nothing() {
        assert_eq!(assemble_patch(""), "");
        assert_eq!(assemble_patch("\n\n"), "");
    }

    #[test]
    fn review_count_suffix_reads_naturally() {
        assert_eq!(count_suffix(0), "");
        assert_eq!(count_suffix(1), " with 1 inline comment");
        assert_eq!(count_suffix(4), " with 4 inline comments");
    }
}

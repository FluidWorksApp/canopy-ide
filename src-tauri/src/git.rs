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

use serde::Serialize;
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
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
    pub remote: bool,
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
    let out = git(dir).args(["rev-parse", "--show-toplevel"]).output().ok()?;
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
        let Ok(dir) = check_scope(&state, Path::new(&path)) else { continue };
        let Some(top) = toplevel_of(&dir) else { continue };
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
        if let Ok(counts) = run(git(&top).args(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]))
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
        let conflicted = matches!(
            (index, tree),
            ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D')
        );
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
    // Unit-separator format: branch names can contain almost anything else.
    let fmt = "%(refname:short)\x1f%(HEAD)\x1f%(upstream:short)\x1f%(contents:subject)";
    let out = run(git(&top).args([
        "for-each-ref",
        "--sort=-committerdate",
        &format!("--format={fmt}"),
        "refs/heads",
        "refs/remotes",
    ]))?;
    let mut branches = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split('\x1f').collect();
        if f.is_empty() || f[0].is_empty() {
            continue;
        }
        let name = f[0].to_string();
        // origin/HEAD is a symref pointer, not a branch anyone checks out.
        if name.ends_with("/HEAD") {
            continue;
        }
        branches.push(BranchInfo {
            current: f.get(1).map(|s| *s == "*").unwrap_or(false),
            upstream: f.get(2).filter(|s| !s.is_empty()).map(|s| s.to_string()),
            remote: name.starts_with("origin/") || name.matches('/').count() >= 1 && !name.starts_with("refs/heads"),
            subject: f.get(3).unwrap_or(&"").to_string(),
            name,
        });
    }
    // for-each-ref can't tell us which are remotes reliably from the name alone;
    // re-derive from the ref namespace instead.
    let locals = run(git(&top).args(["for-each-ref", "--format=%(refname:short)", "refs/heads"]))?;
    let local_set: Vec<&str> = locals.lines().collect();
    for b in branches.iter_mut() {
        b.remote = !local_set.contains(&b.name.as_str());
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

fn run_net(cmd: &mut Command) -> Result<String, String> {
    use std::io::Read;
    use std::process::Stdio;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                let mut out = String::new();
                let mut err = String::new();
                if let Some(mut o) = child.stdout.take() {
                    let _ = o.read_to_string(&mut out);
                }
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut err);
                }
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
    run_net(&mut cmd).map(|o| if o.is_empty() { "Already up to date".into() } else { o })
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
    pub updated: String,
    pub review_decision: String,
    pub additions: u32,
    pub deletions: u32,
    pub mine: bool,
}

/// gh infers the repository from the working directory, which avoids parsing
/// remote URLs ourselves and works with forks/multiple remotes as the user has
/// them configured.
fn gh_in(repo: &Path) -> Command {
    let mut cmd = Command::new("gh");
    cmd.env("GH_PROMPT_DISABLED", "1");
    cmd.current_dir(repo);
    cmd
}

#[tauri::command]
pub async fn gh_available() -> bool {
    Command::new("gh")
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
        "number,title,author,headRefName,baseRefName,isDraft,state,url,updatedAt,reviewDecision,additions,deletions",
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
                        updated: p["updatedAt"].as_str().unwrap_or("").to_string(),
                        review_decision: p["reviewDecision"].as_str().unwrap_or("").to_string(),
                        additions: p["additions"].as_u64().unwrap_or(0) as u32,
                        deletions: p["deletions"].as_u64().unwrap_or(0) as u32,
                    }
                })
                .collect()
        })
        .unwrap_or_default())
}

#[tauri::command]
pub async fn gh_pr_diff(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args(["pr", "diff", &number.to_string()]);
    run_net(&mut cmd)
}

#[tauri::command]
pub async fn gh_pr_body(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args(["pr", "view", &number.to_string(), "--json", "body", "--jq", ".body"]);
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
    let out = run(git(&top).args(["worktree", "list", "--porcelain"]))?;

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
                    w.locked = Some(if value.is_empty() { "locked".into() } else { value });
                }
            }
            "prunable" => {
                if let Some(w) = cur.as_mut() {
                    w.prunable = Some(if value.is_empty() { "prunable".into() } else { value });
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
    Ok(if out.trim().is_empty() { "Nothing to prune".into() } else { out.trim().to_string() })
}

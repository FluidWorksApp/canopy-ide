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
    cmd
}

#[tauri::command]
pub async fn gh_available() -> bool {
    Command::new(gh_bin())
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

    let mut files = 0_u32;
    let mut adds = 0_u32;
    let mut dels = 0_u32;
    for line in patch.lines() {
        if line.starts_with("diff --git ") {
            files += 1;
        } else if line.starts_with("+++") || line.starts_with("---") {
            // File headers, not content.
        } else if line.starts_with('+') {
            adds += 1;
        } else if line.starts_with('-') {
            dels += 1;
        }
    }

    let truncated = patch.len() > MAX_PATCH_BYTES;
    if truncated {
        // Cut on a line boundary so the last hunk the renderer sees is valid.
        let cut = patch[..MAX_PATCH_BYTES]
            .rfind('\n')
            .unwrap_or(MAX_PATCH_BYTES);
        patch.truncate(cut);
    }

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
        "issue", "list", "--state", "all", "--limit", "80", "--json",
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

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
    Ok(CloneResult { path: dest_str, name })
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
/// confirms first.
#[tauri::command]
pub async fn gh_pr_close(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args(["pr", "close", &number.to_string()]);
    run_net(&mut cmd)?;
    Ok(format!("Closed #{number}"))
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
            String::from_utf8_lossy(&o.stderr).trim().lines().next().unwrap_or("").to_string(),
        ),
        Err(e) => (false, String::new(), e.to_string()),
    };
    let host = Command::new(&bin)
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
    Ok(url.trim_end_matches('/').trim_end_matches(".git").to_string())
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
    let counts_degraded = match run(git(&top).args(["for-each-ref", "--format", &ab_fmt, "refs/heads"]))
    {
        Ok(out) => {
            for line in out.lines() {
                let mut f = line.split('\x1f');
                let (Some(name), Some(counts)) = (f.next(), f.next()) else { continue };
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
        let wt = worktrees.iter().find(|w| w.branch.as_deref() == Some(branch.as_str()));
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

    Ok(WorkAudit { base, counts_degraded, items })
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
        return Err(format!("{branch} is a protected branch and can't be deleted here"));
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

    // Resolve the digest's cwd to a workdir this repo actually owns. Git's own
    // worktree list is the authority, compared canonically — agent-made
    // worktrees were never registered as workspace roots (see git_branch_patch
    // for the full rationale).
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let cwd = dstr("cwd");
    let mut workdir: Option<PathBuf> = None;
    let mut cwd_missing = false;
    if let Some(c) = cwd.as_deref() {
        let dir = Path::new(c);
        if dir.is_dir() {
            if let Some(wt_top) = toplevel_of(dir) {
                let want = canon(&wt_top);
                if want == canon(&top)
                    || list_worktrees(&top)?
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
    let isolated = workdir.as_deref().map(|w| canon(w) != canon(&top)).unwrap_or(false);

    // The live branch beats the digest's snapshot; the snapshot still names
    // the branch after the workdir is gone.
    let (mut branch, mut detached) = (None, false);
    if let Some(w) = &workdir {
        let (b, d) = head_branch(w);
        branch = b;
        detached = d;
    }
    if branch.is_none() && !detached {
        branch = dstr("branch");
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
            if let Ok(out) = run(git(&top).args([
                "rev-list",
                "--left-right",
                "--count",
                &format!("{base}...{b}"),
            ])) {
                let mut n = out.split_whitespace();
                behind = n.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                ahead = n.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            }
            merged = git(&top)
                .args(["merge-base", "--is-ancestor", &b, &base])
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false);
            commits = branch_commits_of(&top, &base, &b);
        }
    }

    Ok(AgentWorkspace {
        session_id,
        agent: dstr("agent"),
        state: dstr("state"),
        cwd,
        updated: digest.get("updated").and_then(|v| v.as_u64()),
        touched: digest
            .get("files")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|f| f.as_str().map(str::to_string)).collect())
            .unwrap_or_default(),
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
                let known = list_worktrees(&top)?.into_iter().any(|x| canon(&x.path) == want);
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
        let untracked = run(git(&dir).args([
            "ls-files", "--others", "--exclude-standard", "-z",
        ]))
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
    Ok(CommitPatch { patch, files_changed: files, insertions: adds, deletions: dels, truncated })
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

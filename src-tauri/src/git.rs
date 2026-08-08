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

use crate::blocking;
use crate::process_capture::{
    drain_capped, output as command_output_capped, reject_truncated as reject_truncated_output,
    wait_with_capped_output, DEFAULT_STREAM_MAX,
};
use crate::winproc::NoConsoleWindow;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::State;

use crate::fsx::{check_scope, WorkspaceManager};

/// Network operations get a ceiling so a stalled remote can't wedge a worker
/// thread for the life of the app.
const NET_TIMEOUT_SECS: u64 = 120;
const PROCESS_STREAM_MAX: usize = DEFAULT_STREAM_MAX;

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
    /// An integration branch, or this repo's actual base. Decided here because
    /// only the backend knows what the base is — a hardcoded list in the UI
    /// cannot see a repo whose base is neither main nor master.
    pub protected: bool,
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

pub(crate) fn git(repo: &Path) -> Command {
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

/// Both of git's streams, because one refusal routinely spans them and one
/// success routinely carries a warning.
///
/// On failure git splits a single message: the mid-merge refusal puts the file
/// list on stdout (`f.txt: needs merge`) and the sentence about it on stderr
/// (`error: you need to resolve your current index first`). Returning only one
/// destroys half the evidence before any classifier sees it, so both come back,
/// stdout first — the order git wrote them in.
///
/// On success stderr is where git puts the things it will never say again: the
/// orphaned-commits warning after leaving a detached HEAD, `warning: refname
/// 'x' is ambiguous.`, the sparse-checkout note. All exit 0, so a caller that
/// only reads stdout tells the user "done" and drops the warning on the floor.
fn run_verbose(cmd: &mut Command) -> Result<(String, String), String> {
    // The choke point for ~100 call sites, and the reason `blocking::io` exists:
    // waiting on a subprocess from an async command otherwise parks a runtime
    // worker for the whole of it. See blocking.rs.
    let out = blocking::io(|| command_output_capped(cmd, PROCESS_STREAM_MAX))?;
    reject_truncated_output(&out, "git")?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        Ok((stdout, stderr))
    } else {
        Err(join_streams(&stdout, &stderr))
    }
}

/// stdout then stderr, each trimmed, empties skipped — one text to classify.
fn join_streams(stdout: &str, stderr: &str) -> String {
    [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The ~100 call sites that only want git's answer. Failures still carry both
/// streams; successes drop the warning, which is exactly why the switch paths
/// use `run_verbose` instead.
pub(crate) fn run(cmd: &mut Command) -> Result<String, String> {
    run_verbose(cmd).map(|(stdout, _)| stdout)
}

/// Resolve + scope-check a repo path handed to us by the frontend.
pub(crate) fn repo_path(
    state: &State<'_, WorkspaceManager>,
    path: &str,
) -> Result<PathBuf, String> {
    let dir = check_scope(state, Path::new(path))?;
    let top = run(git(&dir).args(["rev-parse", "--show-toplevel"]))?;
    let top = PathBuf::from(top.trim());
    // The toplevel can sit above the component dir; make sure it's still inside
    // a registered root rather than escaping upward via a parent repo.
    check_scope(state, &top)
}

fn toplevel_of(dir: &Path) -> Option<PathBuf> {
    let out = blocking::io(|| {
        command_output_capped(
            git(dir).args(["rev-parse", "--show-toplevel"]),
            PROCESS_STREAM_MAX,
        )
    })
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

/// Where this checkout's git state actually lives — `<repo>/.git` normally,
/// and the *main* checkout's `.git` for a linked worktree, whose own `.git` is
/// a one-line file pointing there. That's the directory to watch: refs, HEAD
/// and the index of every worktree hang off it. `None` when the path isn't a
/// repo at all.
pub(crate) fn common_dir(dir: &Path) -> Option<PathBuf> {
    let out = blocking::io(|| {
        command_output_capped(
            git(dir).args(["rev-parse", "--git-common-dir"]),
            PROCESS_STREAM_MAX,
        )
    })
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    // It answers with a relative path (".git") when asked from the top level.
    let path = Path::new(&raw);
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        dir.join(path)
    };
    path.canonicalize().ok()
}

pub(crate) fn head_branch(repo: &Path) -> (Option<String>, bool) {
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
    let base = default_base(&top);
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
            protected: is_protected_branch(&name, &base),
            name,
        });
    }
    Ok(branches)
}

// ---------- switching branches ----------
//
// Switching is the one git operation a non-expert reaches for constantly, and
// the one with the most ways to refuse. Every refusal git can produce here is
// something a person can resolve, so they come back as *outcomes* the UI turns
// into choices — `Err` stays reserved for "we couldn't even run git".

/// The worktree standing between you and a branch: git allows a branch in one
/// checkout at a time, so switching means dealing with whoever has it.
#[derive(Serialize, Clone)]
pub struct BranchHolder {
    pub branch: String,
    pub path: String,
    pub name: String,
    /// Under `.claude/worktrees` — a workspace Canopy made for an agent, not
    /// something the user set up by hand.
    pub agent: bool,
    pub is_main: bool,
    pub dirty: u32,
    pub locked: Option<String>,
    pub prunable: Option<String>,
    pub head: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CheckoutOutcome {
    Switched {
        message: String,
        /// The checkout the caller should now work in, when it isn't the repo
        /// root — a workspace we landed in or created. `None` means "here".
        path: Option<String>,
    },
    /// Another worktree holds the branch.
    BranchInWorktree { holder: BranchHolder },
    /// Uncommitted work here would be overwritten; `files` is git's own list.
    LocalChanges {
        files: Vec<String>,
        untracked: bool,
        detail: String,
    },
    /// The switch happened, but the set-aside changes wouldn't reapply. They
    /// are still saved — this outcome exists so the UI can say where.
    ChangesStashed { stash: String, detail: String },
    /// A half-finished merge/rebase/cherry-pick/revert/am, or another git
    /// process holding the index. `operation` is one of "merge", "rebase",
    /// "cherry-pick", "revert", "am", "another-command".
    RepoBusy { operation: String, detail: String },
    /// No branch, tag or commit of that name is here. `can_create` says the
    /// name is a legal one and nothing already holds it, so starting it here is
    /// a real way out.
    NothingCalled {
        name: String,
        can_create: bool,
        detail: String,
    },
    /// A create-shaped request refused because the name is taken. Distinct from
    /// `Failed` so nothing offers to look at a branch that doesn't exist.
    NameTaken { branch: String, detail: String },
    /// A workspace couldn't go there — something is already at that path.
    /// `usable` means it is a worktree of *this* repo, so opening it is safe.
    PathInUse {
        path: String,
        usable: bool,
        detail: String,
    },
    /// GitHub couldn't be reached, or doesn't have what we asked it for.
    RemoteUnreachable { summary: String, detail: String },
    /// The switch worked, but it left a detached HEAD's commits on no branch.
    /// Git says this on stderr and exits 0, so nothing else would ever mention
    /// it. `commits` is "<short> <subject>", newest first.
    SwitchedWithLeftovers {
        message: String,
        commits: Vec<String>,
        detail: String,
    },
    /// Nothing we recognise. Still carries a human first line so the raw text
    /// is never the whole message.
    Failed { summary: String, detail: String },
}

fn is_agent_worktree(path: &str) -> bool {
    path.contains("/.claude/worktrees/") || path.contains("\\.claude\\worktrees\\")
}

fn same_dir(a: &Path, b: &Path) -> bool {
    a == b
        || matches!(
            (a.canonicalize(), b.canonicalize()),
            (Ok(x), Ok(y)) if x == y
        )
}

/// Which worktree holds `branch`, if it isn't this one. Run before every
/// switch, so it stays to two git processes however many worktrees the repo
/// has: the listing, then a status for the one worktree that matters.
fn branch_holder(top: &Path, branch: &str) -> Option<BranchHolder> {
    let w = scan_worktrees(top)
        .ok()?
        .into_iter()
        .find(|w| w.branch.as_deref() == Some(branch) && !same_dir(Path::new(&w.path), top))?;
    let dirty = if w.prunable.is_none() && !w.bare {
        run(git(Path::new(&w.path)).args(["status", "--porcelain"]))
            .map(|s| s.lines().filter(|l| !l.trim().is_empty()).count() as u32)
            .unwrap_or(0)
    } else {
        0
    };
    Some(BranchHolder {
        branch: branch.to_string(),
        agent: is_agent_worktree(&w.path),
        name: w.name,
        path: w.path,
        is_main: w.is_main,
        dirty,
        locked: w.locked,
        prunable: w.prunable,
        head: w.head,
    })
}

/// The checkout refusals worth acting on. Git's wording for these has been
/// stable for many releases; anything else stays `Unknown` and is shown raw
/// beneath a summary rather than guessed at.
#[derive(Debug, PartialEq)]
enum CheckoutRefusal {
    LocalChanges { files: Vec<String>, untracked: bool },
    BranchInWorktree { path: String },
    Unknown,
}

fn classify_checkout(err: &str) -> CheckoutRefusal {
    if let Some(path) = err
        .lines()
        .find(|l| l.contains("is already used by worktree at"))
        .and_then(|l| l.split_once("worktree at "))
        .map(|(_, p)| p.trim().trim_matches('\'').to_string())
    {
        return CheckoutRefusal::BranchInWorktree { path };
    }
    let mut lines = err.lines();
    while let Some(line) = lines.next() {
        if !line.contains("would be overwritten by") {
            continue;
        }
        // Git indents the file list; the "Please …" advice returns to column 0.
        let files: Vec<String> = lines
            .by_ref()
            .take_while(|f| f.starts_with(char::is_whitespace) && !f.trim().is_empty())
            .map(|f| f.trim().to_string())
            .collect();
        return CheckoutRefusal::LocalChanges {
            files,
            untracked: line.contains("untracked"),
        };
    }
    CheckoutRefusal::Unknown
}

/// Which half-finished operation a checkout is sitting in the middle of. The
/// string is both git's subcommand (`git <op> --quit`) and the token the UI
/// turns into plain words.
#[derive(Debug, PartialEq, Clone, Copy)]
enum RepoOp {
    Merge,
    Rebase,
    CherryPick,
    Revert,
    Am,
}

impl RepoOp {
    fn as_str(self) -> &'static str {
        match self {
            RepoOp::Merge => "merge",
            RepoOp::Rebase => "rebase",
            RepoOp::CherryPick => "cherry-pick",
            RepoOp::Revert => "revert",
            RepoOp::Am => "am",
        }
    }
}

/// The refusals worth acting on that git's older wording never covered, plus
/// the ones gh only produces at its fetch stage. Consulted *only* when
/// `classify_checkout` has nothing, so the two shapes it knows keep their exact
/// meaning and its tests keep their exact truth.
#[derive(Debug, PartialEq)]
enum ExtraRefusal {
    BranchInWorktree { path: String },
    MidOperation { op: RepoOp },
    NameTaken { branch: String },
    NothingCalled { name: String },
    PathInUse { path: String },
    LockedWorkspace { path: String, reason: String },
    AnotherCommandRunning,
    RemoteUnreachable { summary: String },
}

/// The text between the first pair of single quotes on a line.
fn quoted(line: &str) -> Option<String> {
    let (_, rest) = line.split_once('\'')?;
    let (inner, _) = rest.split_once('\'')?;
    Some(inner.to_string())
}

fn classify_extra(err: &str) -> Option<ExtraRefusal> {
    for line in err.lines() {
        let l = line.trim();

        // gh reaches the branch-is-taken case one stage earlier than checkout
        // does, and git words it differently there. Same human situation.
        // (fetch.c, stable since git 2.20.)
        if l.contains("refusing to fetch into branch ") {
            if let Some((_, at)) = l.split_once(" checked out at ") {
                return Some(ExtraRefusal::BranchInWorktree {
                    path: at.trim().trim_matches('\'').to_string(),
                });
            }
        }

        // Git refuses a switch mid-operation with one sentence per operation.
        let mid = if l.contains("cannot switch branch while merging") {
            Some(RepoOp::Merge)
        } else if l.contains("cannot switch branch while rebasing") {
            Some(RepoOp::Rebase)
        } else if l.contains("cannot switch branch while cherry-picking") {
            Some(RepoOp::CherryPick)
        } else if l.contains("cannot switch branch while reverting") {
            Some(RepoOp::Revert)
        } else if l.contains("in the middle of an am session") {
            Some(RepoOp::Am)
        } else if l.contains("you need to resolve your current index first") {
            // An unresolved merge, said from the index's point of view.
            Some(RepoOp::Merge)
        } else {
            None
        };
        if let Some(op) = mid {
            return Some(ExtraRefusal::MidOperation { op });
        }

        // Order matters: a taken *branch* name also ends in "already exists",
        // and it is a different question from a taken *path*.
        if l.contains("a branch named ") && l.contains(" already exists") {
            if let Some(branch) = quoted(l) {
                return Some(ExtraRefusal::NameTaken { branch });
            }
        }
        if l.contains("' already exists") && !l.contains("a branch named ") {
            if let Some(path) = quoted(l) {
                return Some(ExtraRefusal::PathInUse { path });
            }
        }

        // git 2.31 dropped this line's trailing period, so never anchor its end.
        if l.contains("pathspec ") && l.contains(" did not match") {
            if let Some(name) = quoted(l) {
                return Some(ExtraRefusal::NothingCalled { name });
            }
        }
        if let Some((_, name)) = l.split_once("invalid reference: ") {
            return Some(ExtraRefusal::NothingCalled {
                name: name.trim().trim_matches('\'').to_string(),
            });
        }

        if l.contains("cannot remove a locked working tree")
            || l.contains("cannot move a locked working tree")
        {
            let reason = l
                .split_once("lock reason: ")
                .map(|(_, r)| r.trim().to_string())
                .filter(|r| !r.is_empty())
                .unwrap_or_else(|| "locked".into());
            return Some(ExtraRefusal::LockedWorkspace {
                // git names the reason here, never the path; the caller knows it.
                path: String::new(),
                reason,
            });
        }

        if l.contains("Unable to create '") && l.contains("index.lock': File exists") {
            return Some(ExtraRefusal::AnotherCommandRunning);
        }

        if l.contains("couldn't find remote ref pull/")
            || l.contains("no git remotes found")
            || l.contains("Could not resolve to a PullRequest")
            // run_net's own ceiling, and gh's not-signed-in advice.
            || l.contains("remote unreachable, or it wants credentials")
            || l.contains("gh auth login")
        {
            return Some(ExtraRefusal::RemoteUnreachable {
                summary: l.trim_start_matches("fatal: ").to_string(),
            });
        }
    }
    None
}

/// gh streams git's lines through verbatim and appends its own wrapper line
/// last. That line means nothing to a person, so it comes off the *detail* —
/// never off the text we classify, because git's untouched sentences are
/// exactly what makes the existing patterns match straight through gh.
fn strip_gh_noise(err: &str) -> String {
    let mut lines: Vec<&str> = err.lines().collect();
    while lines.last().is_some_and(|l| {
        let t = l.trim();
        t.is_empty()
            || t.strip_prefix("failed to run git: exit status ")
                .is_some_and(|n| n.trim().parse::<i32>().is_ok())
    }) {
        lines.pop();
    }
    lines.join("\n").trim().to_string()
}

/// Everything we know about the worktree git just named. `branch_holder` is
/// tried first because it carries the dirty count, the lock and the prunable
/// flag; failing that we still look the path up in the worktree list, and only
/// then fall back to what the one error line said.
fn holder_at(top: &Path, branch: &str, path: &str) -> BranchHolder {
    if let Some(h) = branch_holder(top, branch) {
        return h;
    }
    if let Some(w) = scan_worktrees(top).ok().and_then(|ws| {
        ws.into_iter()
            .find(|w| same_dir(Path::new(&w.path), Path::new(path)))
    }) {
        return BranchHolder {
            branch: branch.to_string(),
            agent: is_agent_worktree(&w.path),
            name: w.name,
            path: w.path,
            is_main: w.is_main,
            dirty: 0,
            locked: w.locked,
            prunable: w.prunable,
            head: w.head,
        };
    }
    // Last resort: one line of git's. Split the leaf on both separators — a
    // Windows path has no forward slashes to split on — and settle is_main by
    // comparing paths rather than assuming false, so nothing ever leads with
    // "move the branch here" against the repo's own main checkout.
    BranchHolder {
        branch: branch.to_string(),
        name: path
            .trim_end_matches(['/', '\\'])
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(path)
            .to_string(),
        agent: is_agent_worktree(path),
        is_main: same_dir(Path::new(path), top),
        path: path.to_string(),
        dirty: 0,
        locked: None,
        prunable: None,
        head: String::new(),
    }
}

/// Would `name` be a legal new branch here, and is it still free? "Start it
/// here" means starting it from HEAD, so an unborn checkout has nothing to
/// start it from and the offer must not be made.
fn can_create_branch(top: &Path, name: &str) -> bool {
    !repo_state(top).unborn
        && run(git(top).args(["check-ref-format", "--branch", name])).is_ok()
        && run(git(top).args([
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{name}"),
        ]))
        .is_err()
}

/// Is `path` a worktree of *this* repo? Only then is "use the folder that's
/// there" an offer we can keep.
fn is_known_worktree(top: &Path, path: &str) -> bool {
    scan_worktrees(top)
        .map(|ws| {
            ws.iter()
                .any(|w| same_dir(Path::new(&w.path), Path::new(path)))
        })
        .unwrap_or(false)
}

fn repo_busy(op: RepoOp) -> CheckoutOutcome {
    let name = op.as_str();
    CheckoutOutcome::RepoBusy {
        operation: name.into(),
        detail: format!(
            "git {name} --quit — the {name} state is cleared; the working tree is untouched."
        ),
    }
}

/// The body of the "couldn't get that from GitHub" question, chosen by cause.
///
/// Quoting git's or gh's first line here — which is what this did — puts raw
/// stderr in the one sentence the user reads, and says the same thing whichever
/// of three quite different situations they are actually in. The raw text keeps
/// its place in `detail`, where it teaches rather than blocks. `pr` lets the
/// missing-head case name the pull request it is about.
fn remote_unreachable_for(err: &str, pr: Option<u32>) -> CheckoutOutcome {
    let detail = strip_gh_noise(err);
    let l = detail.to_lowercase();
    let summary = if l.contains("gh auth login")
        || l.contains("not logged in")
        || l.contains("requires authentication")
        || l.contains("wants credentials")
        || l.contains("authentication failed")
    {
        "Canopy couldn't reach GitHub with the sign-in it has.".to_string()
    } else if l.contains("no git remotes found") || l.contains("does not appear to be a git repo") {
        "This project has no remote to fetch from.".to_string()
    } else if l.contains("couldn't find remote ref")
        || l.contains("could not resolve to a pullrequest")
    {
        match pr {
            Some(n) => format!(
                "GitHub doesn't have a copy of #{n}'s changes to fetch. A private fork you can't read is the usual reason."
            ),
            None => "GitHub doesn't have a copy of those changes to fetch. A private fork you can't read is the usual reason.".into(),
        }
    } else {
        "Canopy couldn't reach GitHub just now.".to_string()
    };
    CheckoutOutcome::RemoteUnreachable { summary, detail }
}

/// The same question, asked about no pull request in particular.
fn remote_unreachable(err: &str) -> CheckoutOutcome {
    remote_unreachable_for(err, None)
}

fn switch_failed(top: &Path, target: &str, err: String) -> CheckoutOutcome {
    // Classification always sees the untouched text; only the detail is tidied.
    let detail = strip_gh_noise(&err);
    match classify_checkout(&err) {
        // Preflight missed it, or the worktree appeared in between.
        CheckoutRefusal::BranchInWorktree { path } => CheckoutOutcome::BranchInWorktree {
            holder: holder_at(top, target, &path),
        },
        CheckoutRefusal::LocalChanges { files, untracked } => CheckoutOutcome::LocalChanges {
            files,
            untracked,
            detail,
        },
        CheckoutRefusal::Unknown => match classify_extra(&err) {
            Some(ExtraRefusal::BranchInWorktree { path }) => CheckoutOutcome::BranchInWorktree {
                holder: holder_at(top, target, &path),
            },
            Some(ExtraRefusal::MidOperation { op }) => repo_busy(op),
            Some(ExtraRefusal::AnotherCommandRunning) => CheckoutOutcome::RepoBusy {
                operation: "another-command".into(),
                detail,
            },
            Some(ExtraRefusal::NameTaken { branch }) => {
                CheckoutOutcome::NameTaken { branch, detail }
            }
            Some(ExtraRefusal::NothingCalled { name }) => CheckoutOutcome::NothingCalled {
                can_create: can_create_branch(top, &name),
                name,
                detail,
            },
            Some(ExtraRefusal::PathInUse { path }) => CheckoutOutcome::PathInUse {
                usable: is_known_worktree(top, &path),
                path,
                detail,
            },
            // A locked workspace is still a workspace holding the branch: the
            // frontend already knows to re-ask with "move it here" disabled.
            Some(ExtraRefusal::LockedWorkspace { path, reason }) => {
                let mut holder = holder_at(top, target, &path);
                holder.locked.get_or_insert(reason);
                CheckoutOutcome::BranchInWorktree { holder }
            }
            Some(ExtraRefusal::RemoteUnreachable { .. }) => remote_unreachable(&err),
            None => CheckoutOutcome::Failed {
                summary: format!("Git couldn't switch to {target}."),
                detail,
            },
        },
    }
}

/// The states of this checkout that make a switch mean something other than
/// what the user asked for. Read *before* the switch, because git will not tell
/// us after: it succeeds, exits 0, and quietly does the wrong thing.
#[derive(Debug, Default, Clone)]
struct RepoState {
    /// A half-finished operation. `git checkout other` mid-rebase succeeds and
    /// abandons the rebase in place — a success that discards user work.
    mid: Option<RepoOp>,
    unborn: bool,
    /// Commits on a detached HEAD that no branch or remote holds — "<short>
    /// <subject>", newest first.
    orphan_commits: Vec<String>,
}

fn repo_state(top: &Path) -> RepoState {
    // One `--git-dir` and then plain joins, rather than a `--git-path` process
    // per marker: every marker below is per-worktree, so it lives in this
    // checkout's own git dir — which is what --git-dir returns, linked worktree
    // or not. This runs before every switch, so it stays to three processes.
    let dir = run(git(top).args(["rev-parse", "--git-dir"]))
        .map(|s| {
            let p = PathBuf::from(s.trim());
            if p.is_absolute() {
                p
            } else {
                top.join(p)
            }
        })
        .unwrap_or_else(|_| top.join(".git"));
    let exists = |p: &str| dir.join(p).exists();

    let mid = if exists("rebase-merge") {
        Some(RepoOp::Rebase)
    } else if exists("rebase-apply") {
        // `git am` and `git rebase --apply` share the directory; only am leaves
        // an `applying` marker inside it.
        Some(if exists("rebase-apply/applying") {
            RepoOp::Am
        } else {
            RepoOp::Rebase
        })
    } else if exists("MERGE_HEAD") {
        Some(RepoOp::Merge)
    } else if exists("CHERRY_PICK_HEAD") {
        Some(RepoOp::CherryPick)
    } else if exists("REVERT_HEAD") {
        Some(RepoOp::Revert)
    } else {
        None
    };

    let unborn = run(git(top).args(["rev-parse", "--verify", "--quiet", "HEAD"])).is_err();
    // Only a detached HEAD can be carrying commits nothing else points at.
    let detached = run(git(top).args(["symbolic-ref", "--quiet", "HEAD"])).is_err();
    let orphan_commits = if detached && !unborn {
        run(git(top).args([
            "log",
            "--max-count=20",
            "--format=%h %s",
            "HEAD",
            "--not",
            "--branches",
            "--remotes",
        ]))
        .map(|s| {
            s.lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
    } else {
        Vec::new()
    };

    RepoState {
        mid,
        unborn,
        orphan_commits,
    }
}

/// A switch that worked. If HEAD was sitting on commits no branch holds, that
/// is a success which loses work unless we say so here.
fn settled(message: String, path: Option<String>, before: &RepoState) -> CheckoutOutcome {
    if before.orphan_commits.is_empty() {
        return CheckoutOutcome::Switched { message, path };
    }
    let first = before.orphan_commits[0]
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();
    CheckoutOutcome::SwitchedWithLeftovers {
        message,
        commits: before.orphan_commits.clone(),
        detail: format!("git branch saved-{first} {first} — the commit gets a name, and stops being reachable only by luck."),
    }
}

fn stash_top(top: &Path) -> Option<String> {
    run(git(top).args(["rev-parse", "-q", "--verify", "refs/stash"]))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[tauri::command]
pub async fn git_checkout(
    state: State<'_, WorkspaceManager>,
    repo: String,
    branch: String,
    create: bool,
) -> Result<CheckoutOutcome, String> {
    let top = repo_path(&state, &repo)?;
    // Mid-operation first: git does not refuse this one, it succeeds and
    // abandons the half-finished work in place.
    let mut before = repo_state(&top);
    if let Some(op) = before.mid {
        return Ok(repo_busy(op));
    }
    // `checkout -b` off a snapshot is how a loose commit stops being loose —
    // the new branch is exactly the name it was missing. Warning that it was
    // "left behind" would be the opposite of what just happened.
    if create {
        before.orphan_commits.clear();
    }
    if !create {
        if let Some(holder) = branch_holder(&top, &branch) {
            return Ok(CheckoutOutcome::BranchInWorktree { holder });
        }
    }
    let mut cmd = git(&top);
    if create {
        cmd.args(["checkout", "-b", &branch]);
    } else {
        cmd.args(["checkout", &branch]);
    }
    match run(&mut cmd) {
        Ok(_) => Ok(settled(format!("Switched to {branch}"), None, &before)),
        Err(err) => Ok(switch_failed(&top, &branch, err)),
    }
}

/// What a name points at. `checkout --detach` does none of the guessing plain
/// `checkout` does, so a branch you have only ever seen on GitHub has to be
/// resolved to its remote-tracking twin here — otherwise the one option that
/// touches nothing would be the one that refuses.
///
/// Every configured remote is tried, not just origin: a branch that only exists
/// on `upstream` is a branch, and reporting it as nonexistent was a lie.
fn resolve_ref(top: &Path, name: &str) -> Option<String> {
    let mut candidates = vec![name.to_string()];
    let remotes = run(git(top).args(["remote"])).unwrap_or_default();
    for r in remotes.lines().map(str::trim).filter(|r| !r.is_empty()) {
        candidates.push(format!("refs/remotes/{r}/{name}"));
    }
    for candidate in candidates {
        let spec = format!("{candidate}^{{commit}}");
        // No --quiet: it also swallows "refname 'x' is ambiguous", which is
        // something the user needs to hear.
        if run(git(top).args(["rev-parse", "--verify", &spec])).is_ok() {
            return Some(candidate);
        }
    }
    None
}

/// Check out a ref without moving any branch onto it — the "look at this, then
/// go back" switch. The next branch switch undoes it entirely.
#[tauri::command]
pub async fn git_checkout_detached(
    state: State<'_, WorkspaceManager>,
    repo: String,
    refname: String,
) -> Result<CheckoutOutcome, String> {
    let top = repo_path(&state, &repo)?;
    let name = refname.trim();
    if name.is_empty() {
        return Err("need a branch or commit to look at".into());
    }
    let before = repo_state(&top);
    if let Some(op) = before.mid {
        return Ok(repo_busy(op));
    }
    let Some(target) = resolve_ref(&top, name) else {
        // Not a dead end: the name may only exist on the remote, and starting
        // it here may be what was meant. Both are answerable questions.
        return Ok(CheckoutOutcome::NothingCalled {
            can_create: can_create_branch(&top, name),
            name: name.to_string(),
            detail: format!(
                "git rev-parse --verify {name} finds nothing — not locally, and not on any remote this checkout knows."
            ),
        });
    };
    match run(git(&top).args(["checkout", "--detach", &target])) {
        Ok(_) => Ok(settled(
            format!("Looking at {name} — nothing moved"),
            None,
            &before,
        )),
        Err(err) => Ok(switch_failed(&top, name, err)),
    }
}

/// Free a branch name from the worktree holding it. That worktree goes to a
/// detached HEAD at the same commit, so its files — including uncommitted work
/// — are left exactly as they are; only the name is released.
///
/// Every refusal here is a question, not an error: a locked workspace comes
/// back as the holder it is, so the caller can re-ask with the ways out that
/// still work instead of landing in a dialog whose only button is Close.
#[tauri::command]
pub async fn git_branch_release(
    state: State<'_, WorkspaceManager>,
    repo: String,
    branch: String,
) -> Result<CheckoutOutcome, String> {
    let top = repo_path(&state, &repo)?;
    let free = || CheckoutOutcome::Switched {
        message: format!("{branch} is free"),
        path: None,
    };
    let Some(holder) = branch_holder(&top, &branch) else {
        return Ok(free());
    };
    if holder.prunable.is_some() {
        // Its directory is gone; only git's bookkeeping still claims the name.
        // `prune` skips locked entries silently, so a locked-and-missing one
        // needs the record removed by force first — nothing on disk to lose.
        if holder.locked.is_some() {
            let _ = run(git(&top).args(["worktree", "remove", "--force", "--force", &holder.path]));
        }
        run(git(&top).args(["worktree", "prune"]))?;
        return Ok(if branch_holder(&top, &branch).is_some() {
            CheckoutOutcome::BranchInWorktree {
                holder: branch_holder(&top, &branch).unwrap_or(holder),
            }
        } else {
            free()
        });
    }
    if holder.locked.is_some() {
        return Ok(CheckoutOutcome::BranchInWorktree { holder });
    }
    // Not user input: this path came from `git worktree list` for a repo that
    // was already scope-checked, so it is part of that repo by construction.
    match run(git(Path::new(&holder.path)).args(["switch", "--detach"])) {
        Ok(_) => Ok(free()),
        // The directory went away between the listing and now — same situation
        // as prunable, so take the same way out.
        Err(err)
            if err.contains("cannot change to '") || err.contains("No such file or directory") =>
        {
            run(git(&top).args(["worktree", "prune"]))?;
            Ok(free())
        }
        Err(err) => Ok(switch_failed(&top, &branch, err)),
    }
}

/// What the carry dance did around the caller's operation.
enum Carried {
    /// The operation ran. `changes` says whether set-aside work came back with
    /// it, so the caller can word its own success.
    Done { changes: bool },
    /// It didn't — this outcome is the whole answer.
    Stopped(CheckoutOutcome),
}

/// Set the working tree aside, do the thing, put it back. A push that fails is
/// an outcome, not an `Err`: this is the path with the most to lose, and it
/// fails exactly when it is offered — unmerged files after a local-changes
/// refusal are the case where `stash push` itself declines.
fn carrying<F>(top: &Path, branch: &str, f: F) -> Result<Carried, String>
where
    F: FnOnce() -> Result<(), String>,
{
    let before = stash_top(top);
    if let Err(detail) = run(git(top).args([
        "stash",
        "push",
        "--include-untracked",
        "-m",
        &format!("canopy: switching to {branch}"),
    ])) {
        return Ok(Carried::Stopped(CheckoutOutcome::Failed {
            summary: "Your changes couldn't be set aside, so nothing was moved.".into(),
            detail: strip_gh_noise(&detail),
        }));
    }
    // Comparing the stash ref beats parsing "No local changes to save": it is
    // the same answer without depending on git's wording.
    let after = stash_top(top);
    let stashed = after.is_some() && after != before;

    if let Err(err) = f() {
        if stashed {
            let _ = run(git(top).args(["stash", "pop"]));
        }
        return Ok(Carried::Stopped(switch_failed(top, branch, err)));
    }
    if !stashed {
        return Ok(Carried::Done { changes: false });
    }
    match run(git(top).args(["stash", "pop"])) {
        Ok(_) => Ok(Carried::Done { changes: true }),
        // A conflicting pop leaves the stash in place — that is git's own
        // safety net, and the reason this outcome can promise nothing is lost.
        // Name the entry we actually made, not a position that may have moved.
        Err(detail) => Ok(Carried::Stopped(CheckoutOutcome::ChangesStashed {
            stash: after.unwrap_or_else(|| "refs/stash".into()),
            detail,
        })),
    }
}

/// Switch with the working tree's changes carried across: set them aside, move
/// the branch, put them back. If they clash with the new branch they stay
/// saved rather than being forced anywhere — the switch is never worth losing
/// work over.
#[tauri::command]
pub async fn git_checkout_carry(
    state: State<'_, WorkspaceManager>,
    repo: String,
    branch: String,
) -> Result<CheckoutOutcome, String> {
    let top = repo_path(&state, &repo)?;
    let before = repo_state(&top);
    if let Some(op) = before.mid {
        return Ok(repo_busy(op));
    }
    if let Some(holder) = branch_holder(&top, &branch) {
        return Ok(CheckoutOutcome::BranchInWorktree { holder });
    }
    match carrying(&top, &branch, || {
        run(git(&top).args(["checkout", &branch])).map(|_| ())
    })? {
        Carried::Stopped(outcome) => Ok(outcome),
        Carried::Done { changes } => Ok(settled(
            if changes {
                format!("Switched to {branch} with your changes")
            } else {
                format!("Switched to {branch}")
            },
            None,
            &before,
        )),
    }
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
///
/// The two lists are different jobs and git has no single command for both.
/// `tracked` is restored from HEAD, which also clears anything staged for those
/// paths, so one Discard means the same thing whether the change was staged or
/// not. `untracked` has no HEAD to restore from — the only way to discard a
/// file git has never seen is to delete it, which is what `clean` does, and it
/// touches nothing tracked even if a caller mixes the lists up.
#[tauri::command]
pub async fn git_discard(
    state: State<'_, WorkspaceManager>,
    repo: String,
    tracked: Vec<String>,
    untracked: Vec<String>,
) -> Result<(), String> {
    let top = repo_path(&state, &repo)?;
    if !tracked.is_empty() {
        let mut cmd = git(&top);
        // `--` so a path that looks like a flag can't become one.
        cmd.args(["checkout", "HEAD", "--"]);
        cmd.args(&tracked);
        run(&mut cmd)?;
    }
    if !untracked.is_empty() {
        let mut cmd = git(&top);
        // -d for a directory the file is the only thing in; -f because clean
        // refuses to do anything without it.
        cmd.args(["clean", "-f", "-d", "--"]);
        cmd.args(&untracked);
        run(&mut cmd)?;
    }
    Ok(())
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

/// Commit only the paths the user reviewed, preserving unrelated index state.
#[tauri::command]
pub async fn git_commit_paths(
    state: State<'_, WorkspaceManager>,
    repo: String,
    message: String,
    paths: Vec<String>,
) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("commit message is empty".into());
    }
    if paths.is_empty() {
        return Err("no paths were selected for the checkpoint".into());
    }
    let top = repo_path(&state, &repo)?;
    let mut stage = git(&top);
    stage.args(["add", "--"]);
    stage.args(&paths);
    run(&mut stage)?;

    let mut commit = git(&top);
    commit.args(["commit", "--only", "-m", &message, "--"]);
    commit.args(&paths);
    let out = run(&mut commit)?;
    Ok(out.lines().next().unwrap_or("committed").to_string())
}

// ---------- remotes ----------

pub(crate) fn run_net(cmd: &mut Command) -> Result<String, String> {
    run_net_with_input(cmd, None)
}

/// `run_net`, plus a request body on stdin. Its own writer thread for the same
/// reason the readers have theirs: a body bigger than the pipe buffer blocks in
/// write() until the child drains it, and the child can't drain while we're
/// blocked. A review with a dozen findings clears 64KB easily.
pub(crate) fn run_net_with_input(cmd: &mut Command, input: Option<&str>) -> Result<String, String> {
    // The longest block in the file: this waits on a remote for up to
    // NET_TIMEOUT_SECS, polling in 80ms sleeps. Holding a runtime worker for
    // two minutes is what `blocking::io` exists to prevent.
    blocking::io(move || run_net_blocking(cmd, input, false))
}

fn run_graphql(cmd: &mut Command, input: Option<&str>) -> Result<String, String> {
    // `gh api graphql` exits non-zero when GitHub returns field-level errors,
    // even though stdout still contains the partial response. Keep that JSON so
    // `graphql_data` can decide whether the response is usable.
    blocking::io(move || run_net_blocking(cmd, input, true))
}

fn run_net_blocking(
    cmd: &mut Command,
    input: Option<&str>,
    preserve_failure_stdout: bool,
) -> Result<String, String> {
    use std::io::Write;
    use std::process::Stdio;
    let _capture_permit = crate::process_capture::acquire(PROCESS_STREAM_MAX)?;
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let in_thread = input.map(|body| {
        let owned = body.to_string();
        let mut si = child.stdin.take();
        std::thread::spawn(move || {
            if let Some(s) = si.as_mut() {
                let _ = s.write_all(owned.as_bytes());
            }
            // Dropping it closes the pipe — without the EOF `gh` waits forever.
            drop(si);
        })
    });

    // Drain both pipes on their own threads for the whole life of the child,
    // rather than reading them once it has exited. A pipe holds ~64KB before
    // the writer blocks, so a command whose output is bigger than that — a PR
    // diff is routinely 100KB+ — would fill it, block forever in write(), never
    // exit, and be reported as "timed out after 120s" while `gh` sat there with
    // more to say. The reader threads end at EOF, which is the child exiting.
    let so = child.stdout.take().ok_or("network stdout was not piped")?;
    let se = child.stderr.take().ok_or("network stderr was not piped")?;
    let out_thread = std::thread::spawn(move || drain_capped(so, PROCESS_STREAM_MAX));
    let err_thread = std::thread::spawn(move || drain_capped(se, PROCESS_STREAM_MAX));

    let start = std::time::Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                if let Some(t) = in_thread {
                    let _ = t.join();
                }
                let (out, out_truncated) = out_thread.join().unwrap_or_default();
                let (err, err_truncated) = err_thread.join().unwrap_or_default();
                if out_truncated || err_truncated {
                    return Err(format!(
                        "network command output exceeded the {} MiB per-stream limit",
                        PROCESS_STREAM_MAX / 1024 / 1024
                    ));
                }
                let out = String::from_utf8_lossy(&out);
                let err = String::from_utf8_lossy(&err);
                // git reports progress on stderr even on success, so merge.
                return if status.success() {
                    Ok(format!("{out}{err}").trim().to_string())
                } else if preserve_failure_stdout && !out.trim().is_empty() {
                    Ok(out.trim().to_string())
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
                    if let Some(t) = in_thread {
                        let _ = t.join();
                    }
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
    const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
    let top = repo_path(&state, &repo)?;
    let mut cmd = git(&top);
    cmd.args(["diff", "--no-color"]);
    if staged {
        cmd.arg("--staged");
    }
    cmd.args(["--", &path]);
    let out = run_patch_capped(&mut cmd, MAX_DIFF_BYTES, false)?;
    if out.patch.trim().is_empty() && !staged {
        // Untracked: show it as new content rather than an empty diff.
        let mut c = git(&top);
        c.args(["diff", "--no-color", "--no-index", "--", "/dev/null", &path]);
        // --no-index exits 1 when files differ, which is the normal case here.
        if let Ok(o) = run_patch_capped(&mut c, MAX_DIFF_BYTES, true) {
            if !o.patch.trim().is_empty() {
                return Ok(if o.truncated {
                    format!("{}\n[Canopy: diff truncated after 2 MiB]\n", o.patch)
                } else {
                    o.patch
                });
            }
        }
    }
    Ok(if out.truncated {
        format!("{}\n[Canopy: diff truncated after 2 MiB]\n", out.patch)
    } else {
        out.patch
    })
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
pub(crate) fn tool_path(tool: &'static str) -> String {
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
    // A login shell has a whole profile to source before it answers.
    let resolved = blocking::io(|| {
        let mut cmd = std::process::Command::new(shell);
        cmd.no_console_window()
            .args(["-lc", &format!("command -v {tool}")]);
        command_output_capped(&mut cmd, PROCESS_STREAM_MAX)
    })
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

/// Every pull request this repo has had, open or not — number, url and head
/// branch, nothing else.
///
/// For provenance's backfill, which adopts the history already on disk and so
/// wants the merged PRs the watcher never lists. Deliberately a different call
/// from `gh_pr_list`: that one is the inbox and asks for the twelve fields a
/// row renders, where this wants three fields and a much longer tail.
pub(crate) fn gh_pr_refs(top: &Path, limit: u32) -> Result<Vec<(u64, String, String)>, String> {
    let mut cmd = gh_in(top);
    cmd.args([
        "pr",
        "list",
        "--limit",
        &limit.to_string(),
        "--state",
        "all",
        "--json",
        "number,url,headRefName",
    ]);
    let out = run_net(&mut cmd)?;
    let v: serde_json::Value =
        serde_json::from_str(&out).map_err(|e| format!("gh returned unexpected output: {e}"))?;
    Ok(v.as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    Some((
                        r.get("number")?.as_u64()?,
                        r.get("url")?.as_str()?.to_string(),
                        r.get("headRefName")?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default())
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
    blocking::io(|| {
        let mut cmd = Command::new(gh_bin());
        cmd.no_console_window().arg("--version");
        command_output_capped(&mut cmd, PROCESS_STREAM_MAX)
    })
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

/// One PR's state: "OPEN", "MERGED" or "CLOSED".
///
/// The PR watcher only ever holds *open* pull requests, so a linked PR that has
/// vanished from its list could equally have merged, been closed, or simply not
/// been polled. Research asks this instead: marking a finding "implemented"
/// because a PR stopped being open would be inferring the one fact that matters
/// from the one signal that cannot carry it.
#[tauri::command]
pub async fn gh_pr_state(
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
        "state",
        "--jq",
        ".state",
    ]);
    run_net(&mut cmd).map(|s| s.trim().to_uppercase())
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

/// Check out a PR's head here. Ordinary branch switching wearing gh's coat, so
/// it refuses in exactly the same ways and comes back as the same outcomes.
///
/// gh does not mangle git's stderr — it streams git's lines through verbatim
/// and appends its own `failed to run git: exit status N` last — so the shapes
/// `classify_checkout` already knows match straight through the wrapper. What
/// gh cannot do is preflight, which is why the branch and the repo's own state
/// are checked here before it runs at all.
#[tauri::command]
pub async fn gh_pr_checkout(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
    carry: bool,
) -> Result<CheckoutOutcome, String> {
    let top = repo_path(&state, &repo)?;

    // Learn the head branch without touching the checkout, so the preflights
    // below have something to preflight against.
    let mut view = gh_in(&top);
    view.args([
        "pr",
        "view",
        &number.to_string(),
        "--json",
        "headRefName,isCrossRepository",
    ]);
    let head = match run_net(&mut view) {
        // Nothing has moved, so nothing needs undoing.
        Err(err) => return Ok(remote_unreachable_for(&err, Some(number))),
        Ok(json) => serde_json::from_str::<Value>(&json)
            .ok()
            .and_then(|v| {
                v.get("headRefName")
                    .and_then(|h| h.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_default(),
    };
    if head.trim().is_empty() {
        // Built rather than classified: there is no stderr here to read a cause
        // out of, only an answer with nothing in it.
        return Ok(CheckoutOutcome::RemoteUnreachable {
            summary: format!("GitHub didn't say which branch #{number} comes from."),
            detail: "gh pr view --json headRefName returned no head branch.".into(),
        });
    }

    // A same-repo PR whose branch is held elsewhere is the ordinary case, and
    // it is the same question as any other switch — asked before gh can turn it
    // into a fetch-stage error nobody reads.
    if let Some(holder) = branch_holder(&top, &head) {
        return Ok(CheckoutOutcome::BranchInWorktree { holder });
    }
    let before = repo_state(&top);
    if let Some(op) = before.mid {
        return Ok(repo_busy(op));
    }

    // Fork PRs still need gh: only it knows the refspec to fetch.
    let checkout = || {
        let mut cmd = gh_in(&top);
        cmd.args(["pr", "checkout", &number.to_string()]);
        run_net(&mut cmd).map(|_| ())
    };
    let message = format!("Checked out #{number} — you're on {head}");
    if carry {
        match carrying(&top, &head, checkout)? {
            Carried::Stopped(outcome) => Ok(outcome),
            Carried::Done { changes } => Ok(settled(
                if changes {
                    format!("{message}, with your changes")
                } else {
                    message
                },
                None,
                &before,
            )),
        }
    } else {
        match checkout() {
            Ok(()) => Ok(settled(message, None, &before)),
            Err(err) => Ok(switch_failed(&top, &head, err)),
        }
    }
}

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct PrMergeResult {
    pub message: String,
    /// Stacked PRs are accepted for asynchronous merging rather than landing
    /// before this command returns.
    pub pending: bool,
}

fn stacked_merge_required(error: &str) -> bool {
    error.contains("part of a stack") && error.contains("asynchronous merge REST API")
}

fn parse_async_merge(out: &str, number: u32, verb: &str) -> Result<PrMergeResult, String> {
    let value: Value = serde_json::from_str(out)
        .map_err(|e| format!("GitHub returned an unexpected merge response: {e}"))?;
    let message = value["details"]["message"]
        .as_str()
        .unwrap_or("GitHub did not explain the merge result");
    match value["status"].as_str().unwrap_or("") {
        "merged" => Ok(PrMergeResult {
            message: format!("{verb} #{number}"),
            pending: false,
        }),
        "pending" | "enqueued" => Ok(PrMergeResult {
            message: format!("Merge started for #{number} — GitHub is processing its PR stack"),
            pending: true,
        }),
        "failed" => Err(message.to_string()),
        status => Err(format!(
            "GitHub returned an unknown asynchronous merge status {status:?}: {message}"
        )),
    }
}

/// Merge a PR through `gh pr merge`. GitHub's CLI uses the GraphQL mutation,
/// which stacked PRs reject, so that one explicit error falls back to the REST
/// asynchronous merge endpoint required for stacks. This is outward-facing and
/// lands commits on the base branch, so the UI always confirms before calling
/// it. `method` picks how history is written — one of the three GitHub offers.
#[tauri::command]
pub async fn gh_pr_merge(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
    method: String,
) -> Result<PrMergeResult, String> {
    let top = repo_path(&state, &repo)?;
    let (flag, verb) = match method.as_str() {
        "squash" => ("--squash", "Squashed and merged"),
        "merge" => ("--merge", "Merged"),
        "rebase" => ("--rebase", "Rebased and merged"),
        other => return Err(format!("unsupported merge method: {other}")),
    };
    let mut cmd = gh_in(&top);
    cmd.args(["pr", "merge", &number.to_string(), flag]);
    match run_net(&mut cmd) {
        Ok(_) => Ok(PrMergeResult {
            message: format!("{verb} #{number}"),
            pending: false,
        }),
        Err(error) if stacked_merge_required(&error) => {
            let (owner, name) = gh_nwo(&top)?;
            let endpoint = format!("repos/{owner}/{name}/pulls/{number}/merge-async");
            let merge_method = format!("merge_method={method}");
            let mut async_cmd = gh_in(&top);
            async_cmd.args([
                "api",
                "--method",
                "PUT",
                &endpoint,
                "-f",
                &merge_method,
                "-f",
                "merge_action=default",
            ]);
            parse_async_merge(&run_net(&mut async_cmd)?, number, verb)
        }
        Err(error) => Err(error),
    }
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
    /// OPEN / CLOSED / MERGED, in PrInfo's vocabulary. The tab's PrInfo is the
    /// snapshot the list handed over when it opened and never learns that the PR
    /// landed — here, or on github.com — so this is the one that decides whether
    /// Merge is still a thing you can press.
    pub state: String,
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
      id body isDraft mergeable reviewDecision state
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
    graphql_data(run_graphql(&mut cmd, None)?)
}

/// GraphQL whose variables aren't all scalars.
///
/// `-F` only types booleans, null, integers and `@file`; every other value it
/// passes reaches GitHub as a **string**. For a `[DraftPullRequestReviewThread!]`
/// that means the whole array arrives as one string and the mutation is rejected
/// with "expected ... to be a key-value object" — which is why inline review
/// comments could never post. There is no flag that fixes it: the body has to be
/// real JSON, so it goes in on stdin via `--input -`.
fn gh_graphql_json(top: &Path, query: &str, variables: Value) -> Result<Value, String> {
    let body = serde_json::json!({ "query": query, "variables": variables }).to_string();
    let mut cmd = gh_in(top);
    cmd.args(["api", "graphql", "--input", "-"]);
    graphql_data(run_graphql(&mut cmd, Some(&body))?)
}

/// A GraphQL document that names its own targets, run with no repo context —
/// what the cross-project PR watcher uses, since one document covers many
/// repositories and none of them is "the" current one.
pub(crate) fn gh_graphql_anywhere(query: &str) -> Result<Value, String> {
    let mut cmd = gh_anywhere();
    cmd.args(["api", "graphql", "-f", &format!("query={query}")]);
    graphql_data(run_graphql(&mut cmd, None)?)
}

/// `data` out of a GraphQL response, or the errors as a message. A 200 with an
/// `errors` array is the normal failure shape, so it can't be ignored.
fn graphql_data(out: String) -> Result<Value, String> {
    let v: Value =
        serde_json::from_str(&out).map_err(|e| format!("gh returned unexpected output: {e}"))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()) {
        let fatal = errors
            .iter()
            .filter(|error| !review_thread_line_error(error))
            .collect::<Vec<_>>();
        if !fatal.is_empty() {
            let msg = fatal
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

/// GitHub occasionally cannot map an outdated review thread back onto the
/// current diff. It reports the nullable field as an error while returning the
/// rest of the PR, with that line set to null. Treat only that precise partial
/// failure as usable; unrelated GraphQL errors must still reach the user.
fn review_thread_line_error(error: &Value) -> bool {
    let message = error["message"].as_str().unwrap_or("");
    let field = error["path"]
        .as_array()
        .and_then(|path| path.last())
        .and_then(Value::as_str);
    let in_review_threads = error["path"].as_array().is_some_and(|path| {
        path.iter()
            .any(|part| part.as_str() == Some("reviewThreads"))
    });

    in_review_threads
        && matches!(field, Some("line") | Some("startLine"))
        && matches!(
            message,
            "Line could not be resolved" | "Start line could not be resolved"
        )
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

/// One thing this PR is attached to: an issue it will close, a PR stacked
/// either side of it, or something that merely refers to it.
#[derive(Serialize, Clone, Default)]
pub struct PrLink {
    /// "issue" or "pr" — decides the glyph, and whether MERGED is a state it
    /// can be in.
    pub kind: String,
    pub number: u32,
    pub title: String,
    pub url: String,
    /// OPEN / CLOSED / MERGED.
    pub state: String,
    pub draft: bool,
    /// "owner/name", set only when it *isn't* this repo. A cross-repo link has
    /// to say where it lives, or "#12" points at the wrong #12.
    pub repo: String,
    /// The branch this one merges into. Only carried for stacked PRs, where it
    /// is the thing that makes them stacked.
    pub base: String,
}

/// What a PR is attached to, in the four groups that mean different things.
///
/// These are deliberately not one list. "closes #12" is a promise about what
/// merging does; a PR stacked on this one is a queue that merging unblocks;
/// and a mention is neither — it's context. Flattening them would leave the
/// reader to work out which of the three each row is, from the title.
#[derive(Serialize, Clone, Default)]
pub struct PrLinks {
    /// Issues this PR closes when it lands. GitHub's own linked issues: the
    /// closing keywords in the body, plus anything attached by hand in the
    /// Development panel.
    pub closes: Vec<PrLink>,
    /// Open PRs branching off *this* PR's head — the stack sitting on top of
    /// it. This is the group that makes merging this one a decision about more
    /// than this one.
    pub children: Vec<PrLink>,
    /// The open PR this one branches off, when its base is another PR's head
    /// rather than a plain branch. Usually empty; never empty when it matters.
    pub parents: Vec<PrLink>,
    /// Issues and PRs that reference this one without closing it.
    pub mentions: Vec<PrLink>,
}

/// Everything this PR is attached to, in one document.
///
/// `head` and `base` come in from the caller rather than being read out of the
/// PR here, because a GraphQL variable can't be filled from that same query's
/// own result — resolving them server-side would mean a second round trip for
/// two strings the tab has had since it opened.
const PR_LINKS_QUERY: &str = r#"
query($owner:String!,$name:String!,$number:Int!,$head:String!,$base:String!){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      closingIssuesReferences(first:20){nodes{
        number title url state repository{nameWithOwner}
      }}
      timelineItems(first:100,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{
        ... on CrossReferencedEvent{ source{
          __typename
          ... on Issue{ number title url state repository{nameWithOwner} }
          ... on PullRequest{ number title url state isDraft repository{nameWithOwner} }
        }}
      }}
    }
    children: pullRequests(baseRefName:$head,states:[OPEN],first:20){nodes{
      number title url state isDraft baseRefName
    }}
    parents: pullRequests(headRefName:$base,states:[OPEN],first:5){nodes{
      number title url state isDraft baseRefName
    }}
  }
}"#;

fn parse_link(v: &Value, kind: &str, this_repo: &str) -> PrLink {
    let repo = s(&v["repository"]["nameWithOwner"]);
    PrLink {
        kind: kind.to_string(),
        number: v["number"].as_u64().unwrap_or(0) as u32,
        title: s(&v["title"]),
        url: s(&v["url"]),
        state: s(&v["state"]),
        draft: v["isDraft"].as_bool().unwrap_or(false),
        // Same repo is the overwhelming case, and prefixing every row with the
        // name of the repo you are already looking at is noise that hides the
        // handful of rows where the prefix is load-bearing.
        repo: if repo.is_empty() || repo == this_repo {
            String::new()
        } else {
            repo
        },
        base: s(&v["baseRefName"]),
    }
}

fn parse_links(data: &Value, number: u32, this_repo: &str) -> PrLinks {
    let repo = &data["repository"];
    let pr = &repo["pullRequest"];

    let closes: Vec<PrLink> = nodes(pr, "closingIssuesReferences")
        .iter()
        .map(|n| parse_link(n, "issue", this_repo))
        .collect();
    let children: Vec<PrLink> = nodes(repo, "children")
        .iter()
        .map(|n| parse_link(n, "pr", this_repo))
        .collect();
    let parents: Vec<PrLink> = nodes(repo, "parents")
        .iter()
        .map(|n| parse_link(n, "pr", this_repo))
        .collect();

    // A URL identifies an issue or PR across every repo, which a number can't:
    // the stack, the closed issues and the mentions can all name the same
    // thing, and it should appear once, in the most specific group it earned.
    let mut seen: std::collections::HashSet<String> = closes
        .iter()
        .chain(&children)
        .chain(&parents)
        .map(|l| l.url.clone())
        .collect();

    let mut mentions = Vec::new();
    for n in nodes(pr, "timelineItems") {
        let src = &n["source"];
        let kind = match src["__typename"].as_str() {
            Some("Issue") => "issue",
            Some("PullRequest") => "pr",
            // A cross-reference from something that is neither — or an empty
            // node, which is what a reference to a repo you can't read comes
            // back as. Nothing to show and nothing to link to.
            _ => continue,
        };
        let link = parse_link(src, kind, this_repo);
        if link.url.is_empty() {
            continue;
        }
        // A PR referring to itself is not a related PR.
        if link.kind == "pr" && link.number == number && link.repo.is_empty() {
            continue;
        }
        if seen.insert(link.url.clone()) {
            mentions.push(link);
        }
    }

    PrLinks {
        closes,
        children,
        parents,
        mentions,
    }
}

/// The issues and pull requests this one is attached to — what it closes, what
/// is stacked on it, and what refers to it.
///
/// Split out of `gh_pr_conversation` rather than folded into it: the
/// conversation is what the tab can't render without, and this is context
/// beside it. On its own call it can't slow the comments down, and the rail
/// can show it arriving separately.
#[tauri::command]
pub async fn gh_pr_links(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u32,
    head: String,
    base: String,
) -> Result<PrLinks, String> {
    let top = repo_path(&state, &repo)?;
    let (owner, name) = gh_nwo(&top)?;
    let this_repo = format!("{owner}/{name}");
    // Sent as real JSON rather than through `-F`: `-F` retypes anything that
    // looks like a number, so a branch literally named "42" would reach a
    // String! argument as an Int and the whole query would be rejected.
    let data = gh_graphql_json(
        &top,
        PR_LINKS_QUERY,
        serde_json::json!({
            "owner": owner,
            "name": name,
            "number": number,
            "head": head,
            "base": base,
        }),
    )?;
    Ok(parse_links(&data, number, &this_repo))
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
        state: s(&pr["state"]),
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
    gh_graphql_json(
        &top,
        "mutation($p:ID!,$e:PullRequestReviewEvent!,$b:String,$t:[DraftPullRequestReviewThread!]){\
         addPullRequestReview(input:{pullRequestId:$p,event:$e,body:$b,threads:$t}){pullRequestReview{url}}}",
        serde_json::json!({ "p": pr_id, "e": ev, "b": body, "t": thread_json }),
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
    let mut list = scan_worktrees(top)?;
    // Dirty counts are the expensive half — a `git status` per worktree, and a
    // repo can have 20+ of them. Anything that only needs to know *which*
    // worktree holds a branch calls scan_worktrees instead.
    for w in list.iter_mut() {
        if w.prunable.is_none() && !w.bare {
            if let Ok(s) = run(git(std::path::Path::new(&w.path)).args(["status", "--porcelain"])) {
                w.dirty = s.lines().filter(|l| !l.trim().is_empty()).count() as u32;
            }
        }
    }
    Ok(list)
}

/// The worktree records alone — one git process, no per-worktree status.
pub(crate) fn scan_worktrees(top: &Path) -> Result<Vec<WorktreeInfo>, String> {
    let out = run(git(top).args(["worktree", "list", "--porcelain"]))?;
    let mut list = parse_worktrees(&out);
    mark_missing(&mut list);
    Ok(list)
}

/// Git omits the `prunable` line for a *locked* worktree even when its
/// directory is gone, so a caller branching on `prunable` first would offer to
/// open a folder that isn't there. Say it is prunable and keep the lock, so the
/// caller knows both: it needs clearing, and clearing it takes force.
fn mark_missing(list: &mut [WorktreeInfo]) {
    for w in list.iter_mut() {
        if w.prunable.is_none() && w.locked.is_some() && !w.is_main && !Path::new(&w.path).exists()
        {
            w.prunable = Some("its folder is gone".into());
        }
    }
}

fn parse_worktrees(out: &str) -> Vec<WorktreeInfo> {
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

    // First record is always the main working tree.
    for (i, w) in list.iter_mut().enumerate() {
        w.is_main = i == 0;
    }
    list
}

/// Create a worktree. `branch` is checked out there; with `create` it's a new
/// branch off the current HEAD.
///
/// A branch lives in one worktree at a time, and git says so with the very same
/// sentence a plain checkout uses (`branch.c die_if_checked_out()`), so the
/// branch is preflighted here and every refusal goes through `switch_failed` —
/// the caller gets the same question it would get from any other switch, not
/// git's stderr in a toast.
///
/// Deliberately *not* preflighted for a half-finished merge or rebase: a
/// worktree of its own is the recommended way out of that state, and refusing
/// here would close the only door.
#[tauri::command]
pub async fn git_worktree_add(
    state: State<'_, WorkspaceManager>,
    repo: String,
    path: String,
    branch: String,
    create: bool,
) -> Result<CheckoutOutcome, String> {
    let top = repo_path(&state, &repo)?;
    let branch = branch.trim().to_string();
    if branch.is_empty() {
        return Err("branch name is required".into());
    }
    if !create {
        if let Some(holder) = branch_holder(&top, &branch) {
            return Ok(CheckoutOutcome::BranchInWorktree { holder });
        }
    }
    let mut cmd = git(&top);
    cmd.arg("worktree").arg("add");
    if create {
        cmd.arg("-b").arg(&branch);
        cmd.arg(&path);
    } else {
        cmd.arg(&path);
        cmd.arg(&branch);
    }
    match run(&mut cmd) {
        Ok(_) => Ok(CheckoutOutcome::Switched {
            message: format!("Workspace created at {path}"),
            path: Some(path),
        }),
        Err(err) => Ok(switch_failed(&top, &branch, err)),
    }
}

/// Fetch a PR's head and check it out in a fresh worktree, without touching the
/// main checkout's current branch. `pull/<n>/head` is exposed for every PR —
/// fork or not — so this reaches branches a plain `fetch` (origin's own branches
/// only) can't. The worktree is detached at that head rather than on the PR's
/// branch: git allows a branch in one worktree at a time, and the branch is
/// routinely checked out in the main repo already. `branch` is still taken —
/// it names what the agent pushes to (`HEAD:<branch>`) and is validated here.
#[tauri::command]
pub async fn git_worktree_add_pr(
    state: State<'_, WorkspaceManager>,
    repo: String,
    path: String,
    number: u32,
    branch: String,
) -> Result<CheckoutOutcome, String> {
    let top = repo_path(&state, &repo)?;
    if branch.trim().is_empty() {
        return Err("branch name is required".into());
    }
    let mut fetch = git(&top);
    fetch.args(["fetch", "origin", &format!("pull/{number}/head")]);
    // A private fork we can't read, a remote that isn't there, a stall — all
    // one question ("try again?"), not three shapes of raw stderr.
    if let Err(err) = run_net(&mut fetch) {
        return Ok(remote_unreachable_for(&err, Some(number)));
    }
    // Detached, not `-B <branch>`, for two reasons the old form got wrong.
    //
    // Git lets a branch be checked out in exactly one worktree, so `-B` failed
    // outright — "already used by worktree" — whenever the PR's branch was
    // checked out anywhere else, including the main checkout, which is the
    // ordinary case for a PR you are working on. And `-B` force-moves the local
    // branch to the fetched head, which silently discards local commits on it.
    //
    // At the same commit either way; the agent pushes with an explicit refspec
    // (see detachedPushLine) instead of a bare `git push`.
    let mut add = git(&top);
    add.arg("worktree")
        .arg("add")
        .arg("--detach")
        .arg(&path)
        .arg("FETCH_HEAD");
    match run(&mut add) {
        Ok(_) => Ok(CheckoutOutcome::Switched {
            message: format!("Workspace created at {path}, at #{number}'s head"),
            path: Some(path),
        }),
        // A leftover directory from a previous review is the routine failure
        // here — the path is derived, not chosen — and `path_in_use` is the
        // question that has "use the one that's there" in it.
        Err(err) => Ok(switch_failed(&top, branch.trim(), err)),
    }
}

/// What a fresh worktree needs before it can build, and what we managed to give
/// it. `install` is the one thing this command deliberately does *not* run: it
/// takes minutes and belongs in the RUNS rail where its output is readable, so
/// it comes back as a command for the frontend to start.
#[derive(Serialize, Default)]
pub struct BootstrapReport {
    /// Gitignored config carried over from the main checkout (`.env` and kin).
    pub carried: Vec<String>,
    /// Dependency directories cloned instead of reinstalled.
    pub cloned: Vec<String>,
    /// Set when nothing could be cloned: the install to run in the new worktree.
    pub install: Option<String>,
    /// Why the clone didn't happen, when it didn't. Small print, not an error.
    pub note: Option<String>,
}

/// Ignored entries worth carrying into a new worktree: the local config a
/// checkout can't run without and git will never hand you. Deliberately narrow
/// — a `.env` is the file people forget, `dist/` is not.
fn is_carryable(entry: &str) -> bool {
    let name = entry.rsplit('/').next().unwrap_or(entry);
    name.starts_with(".env") || name == ".envrc" || name == ".tool-versions"
}

/// Copy-on-write clone of a directory. Near-free on APFS and on reflink-capable
/// Linux filesystems, which is what makes cloning 40k files of `node_modules`
/// preferable to a five-minute reinstall. Fails loudly (rather than falling back
/// to a real copy) so the caller can offer the install instead — a slow deep
/// copy is the worst of both.
#[cfg(any(target_os = "macos", target_os = "linux"))]
fn clone_dir(src: &Path, dst: &Path) -> Result<(), String> {
    let mut cmd = Command::new("cp");
    #[cfg(target_os = "macos")]
    cmd.arg("-c").arg("-R");
    #[cfg(target_os = "linux")]
    cmd.arg("--reflink=always").arg("-r");
    cmd.arg(src).arg(dst);
    cmd.no_console_window();
    let out = command_output_capped(&mut cmd, PROCESS_STREAM_MAX)?;
    reject_truncated_output(&out, "copy-on-write clone")?;
    if out.status.success() {
        return Ok(());
    }
    Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn clone_dir(_src: &Path, _dst: &Path) -> Result<(), String> {
    Err("copy-on-write clone is not available on this platform".into())
}

/// The install a checkout of this repo would need, read off whichever lockfile
/// is committed. `npm ci` over `npm install` on purpose: a worktree is a fresh
/// checkout, and the lockfile is the whole point of one.
fn install_command(top: &Path) -> Option<String> {
    for (lock, cmd) in [
        ("pnpm-lock.yaml", "pnpm install"),
        ("yarn.lock", "yarn install"),
        ("bun.lockb", "bun install"),
        ("package-lock.json", "npm ci"),
    ] {
        if top.join(lock).exists() {
            return Some(cmd.into());
        }
    }
    top.join("package.json")
        .exists()
        .then(|| "npm install".into())
}

/// Make a just-created worktree runnable.
///
/// `git worktree add` gives you tracked files and nothing else, which is why a
/// new workspace has always died on its first `npm run dev`: no `node_modules`,
/// no `.env`. This closes that gap in the two ways that are actually fast —
/// copy-on-write clone the dependency directories, copy the ignored config —
/// and reports an install command for the case where cloning isn't possible.
///
/// Ignored entries come from git itself (`ls-files --others --ignored
/// --directory`), so a monorepo's nested `node_modules` are found without this
/// having to know anything about the project's layout.
#[tauri::command]
pub async fn git_worktree_bootstrap(
    state: State<'_, WorkspaceManager>,
    repo: String,
    path: String,
) -> Result<BootstrapReport, String> {
    let top = repo_path(&state, &repo)?;
    let dst_root = PathBuf::from(&path);
    if !dst_root.is_dir() {
        return Err(format!("{path} is not a directory"));
    }
    let listing = run(git(&top).args([
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
    ]))
    .unwrap_or_default();

    let mut report = BootstrapReport::default();
    let mut clone_failure: Option<String> = None;
    let mut wanted_deps = false;

    for entry in listing.lines().map(str::trim).filter(|e| !e.is_empty()) {
        let rel = entry.trim_end_matches('/');
        // `..` can't appear in git's own output, but this is a path we join
        // against a root, so it is checked rather than assumed.
        if rel.is_empty() || rel.split('/').any(|p| p == ".." || p == ".git") {
            continue;
        }
        let src = top.join(rel);
        let dst = dst_root.join(rel);
        if dst.exists() {
            continue;
        }
        let is_dir = entry.ends_with('/');
        let name = rel.rsplit('/').next().unwrap_or(rel);

        if is_dir && name == "node_modules" {
            wanted_deps = true;
            if let Some(parent) = dst.parent() {
                if std::fs::create_dir_all(parent).is_err() {
                    continue;
                }
            }
            match clone_dir(&src, &dst) {
                Ok(()) => report.cloned.push(rel.to_string()),
                Err(err) => {
                    // One reason is enough; the rest fail for the same one.
                    clone_failure.get_or_insert(err);
                    let _ = std::fs::remove_dir_all(&dst);
                }
            }
        } else if !is_dir && is_carryable(rel) {
            // A secret this size is a mistake, not a config file. Skipping it
            // beats silently duplicating something large into a throwaway dir.
            let too_big = std::fs::metadata(&src)
                .map(|m| m.len() > 512 * 1024)
                .unwrap_or(true);
            if too_big {
                continue;
            }
            if let Some(parent) = dst.parent() {
                if std::fs::create_dir_all(parent).is_err() {
                    continue;
                }
            }
            if std::fs::copy(&src, &dst).is_ok() {
                report.carried.push(rel.to_string());
            }
        }
    }

    // The install is offered when cloning produced nothing usable — either it
    // failed, or the main checkout had no dependencies to clone in the first
    // place. A worktree that cloned everything needs no install at all.
    if report.cloned.is_empty() {
        report.install = install_command(&top);
        report.note = match (&clone_failure, wanted_deps) {
            (Some(err), _) => Some(format!("Couldn't clone dependencies: {err}")),
            (None, false) if report.install.is_some() => {
                Some("No dependencies installed in the main checkout to clone from.".into())
            }
            _ => None,
        };
    } else if let Some(err) = clone_failure {
        report.note = Some(format!("Some dependencies couldn't be cloned: {err}"));
    }

    Ok(report)
}

/// Remove a worktree. Destructive when it holds uncommitted work, so `force` is
/// only ever raised after the UI has confirmed with the dirty count in hand.
///
/// `force` counts, it isn't a flag: one `--force` drops uncommitted work, and a
/// *locked* worktree needs two — git says so itself ("use 'remove -f -f' to
/// override or unlock first"), and relaying that sentence as a red toast left
/// the user with no way to act on it.
#[tauri::command]
pub async fn git_worktree_remove(
    state: State<'_, WorkspaceManager>,
    repo: String,
    path: String,
    force: u8,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = git(&top);
    cmd.arg("worktree").arg("remove");
    for _ in 0..force.min(2) {
        cmd.arg("--force");
    }
    cmd.arg(&path);
    run(&mut cmd)?;
    Ok("Workspace removed".into())
}

/// Drop administrative records for worktrees whose directories are gone.
#[tauri::command]
pub async fn git_worktree_prune(
    state: State<'_, WorkspaceManager>,
    repo: String,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let out = run(git(&top).args(["worktree", "prune", "-v"]))?;
    // Prune skips locked records silently and still exits 0 with nothing to
    // say, so "Nothing to prune" was a lie in the one case that matters: a
    // locked workspace whose folder is gone keeps claiming its branch forever.
    let stuck: Vec<String> = scan_worktrees(&top)
        .unwrap_or_default()
        .into_iter()
        .filter(|w| !w.is_main && !Path::new(&w.path).exists())
        .map(|w| w.name)
        .collect();
    let pruned = out.trim().to_string();
    Ok(match (pruned.is_empty(), stuck.is_empty()) {
        (true, true) => "Nothing to clear".into(),
        (false, true) => pruned,
        (true, false) => format!(
            "{} is still recorded even though its folder is gone — it's locked, so clearing it takes force.",
            stuck.join(", ")
        ),
        (false, false) => format!(
            "{pruned}\n{} is still recorded even though its folder is gone — it's locked, so clearing it takes force.",
            stuck.join(", ")
        ),
    })
}

/// Call off a half-finished merge/rebase/cherry-pick/revert/am. Only the
/// operation's own bookkeeping is dropped; every file in the working tree stays
/// exactly as it is. This is the "keep your files" way out of `repo_busy`.
#[tauri::command]
pub async fn git_operation_quit(
    state: State<'_, WorkspaceManager>,
    repo: String,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let Some(op) = repo_state(&top).mid else {
        return Ok("Nothing was half-finished".into());
    };
    run(git(&top).args([op.as_str(), "--quit"]))?;
    Ok(format!(
        "Called it off — your files are exactly as you left them ({})",
        op.as_str()
    ))
}

/// Give a commit a branch name without checking anything out. This is the "save
/// it to a branch" way out of a switch that left commits reachable from nothing
/// — and the reason it is `git branch` rather than `git checkout -b` is that the
/// user has just landed where they asked to be, and moving them again to rescue
/// a commit would undo the very switch they made.
#[tauri::command]
pub async fn git_branch_at(
    state: State<'_, WorkspaceManager>,
    repo: String,
    name: String,
    commit: String,
) -> Result<String, String> {
    let top = repo_path(&state, &repo)?;
    let name = name.trim();
    let commit = commit.trim();
    if name.is_empty() || commit.is_empty() {
        return Err("need a name and a commit to save it at".into());
    }
    run(git(&top).args(["branch", name, commit]))?;
    Ok(format!("Saved as {name}"))
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

#[derive(Default)]
struct CappedPatchOutput {
    patch: String,
    files: u32,
    adds: u32,
    dels: u32,
    truncated: bool,
}

/// Drain a patch completely so git can exit, but retain only `max` bytes while
/// counting diff statistics over the full stream. This prevents the old
/// capture-full-then-truncate path from transiently allocating an arbitrarily
/// large lockfile/vendor diff.
fn drain_patch<R: Read>(mut reader: R, max: usize) -> std::io::Result<CappedPatchOutput> {
    let mut kept = Vec::with_capacity(max.min(64 * 1024));
    let mut total = 0usize;
    let (mut files, mut adds, mut dels) = (0u32, 0u32, 0u32);
    let mut in_hunk = false;
    let mut prefix = Vec::with_capacity(12);
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = reader.read(&mut buf)?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read);
        if kept.len() < max {
            let take = read.min(max - kept.len());
            kept.extend_from_slice(&buf[..take]);
        }
        for byte in &buf[..read] {
            if *byte == b'\n' {
                if prefix.starts_with(b"diff --git ") {
                    files = files.saturating_add(1);
                    in_hunk = false;
                } else if prefix.starts_with(b"@@") {
                    in_hunk = true;
                } else if in_hunk {
                    match prefix.first() {
                        Some(b'+') => adds = adds.saturating_add(1),
                        Some(b'-') => dels = dels.saturating_add(1),
                        _ => {}
                    }
                }
                prefix.clear();
            } else if prefix.len() < 12 {
                prefix.push(*byte);
            }
        }
    }
    let mut patch = String::from_utf8_lossy(&kept).into_owned();
    let truncated = total > kept.len();
    if truncated {
        let _ = truncate_patch(&mut patch, kept.len());
    }
    Ok(CappedPatchOutput {
        patch,
        files,
        adds,
        dels,
        truncated,
    })
}

fn drain_bytes<R: Read>(mut reader: R, max: usize) -> std::io::Result<Vec<u8>> {
    let mut kept = Vec::with_capacity(max.min(8 * 1024));
    let mut buf = [0u8; 16 * 1024];
    loop {
        let read = reader.read(&mut buf)?;
        if read == 0 {
            break;
        }
        if kept.len() < max {
            let take = read.min(max - kept.len());
            kept.extend_from_slice(&buf[..take]);
        }
    }
    Ok(kept)
}

fn run_patch_capped(
    cmd: &mut Command,
    max: usize,
    accept_diff_exit: bool,
) -> Result<CappedPatchOutput, String> {
    blocking::io(|| {
        let mut child = cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("git stdout was not piped")?;
        let stderr = child.stderr.take().ok_or("git stderr was not piped")?;
        let out = std::thread::spawn(move || drain_patch(stdout, max));
        let err = std::thread::spawn(move || drain_bytes(stderr, 256 * 1024));
        let status = child.wait().map_err(|e| e.to_string())?;
        let output = out
            .join()
            .map_err(|_| "git stdout reader panicked".to_string())?
            .map_err(|e| e.to_string())?;
        let stderr = err
            .join()
            .map_err(|_| "git stderr reader panicked".to_string())?
            .map_err(|e| e.to_string())?;
        if status.success() || (accept_diff_exit && status.code() == Some(1)) {
            Ok(output)
        } else {
            Err(String::from_utf8_lossy(&stderr).trim().to_string())
        }
    })
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
    use std::sync::{Mutex, OnceLock};
    /// Big enough for any patch a human reviews; past this the cost is all in
    /// shipping and rendering megabytes of generated diff (lockfiles, vendored
    /// trees) that nobody reads line by line.
    const MAX_PATCH_BYTES: usize = 2 * 1024 * 1024;
    /// Commits are immutable, so a hit is always valid — but "always valid" is
    /// not "keep forever". Each entry is up to MAX_PATCH_BYTES, so scrolling a
    /// history view in a large repo used to retain a couple of hundred megabytes
    /// for the life of the process. Insertion-ordered, oldest evicted first: the
    /// case worth keeping is the tab you just closed, not the commit you looked
    /// at an hour ago.
    const MAX_CACHED_PATCHES: usize = 24;
    static CACHE: OnceLock<Mutex<Vec<(String, CommitPatch)>>> = OnceLock::new();

    let top = repo_path(&state, &repo)?;
    let hash = checked_hash(&hash)?;
    let cache_key = format!("{}\x1f{hash}", top.display());
    let cache = CACHE.get_or_init(|| Mutex::new(Vec::new()));
    if let Some((_, hit)) = cache.lock().unwrap().iter().find(|(k, _)| k == &cache_key) {
        return Ok(hit.clone());
    }

    // Merges print no patch under plain `git show`; that is reported as an
    // empty patch rather than reaching for a combined diff the renderer
    // cannot display anyway.
    let output = run_patch_capped(
        git(&top).args(["show", "--patch", "--format=", &hash]),
        MAX_PATCH_BYTES,
        false,
    )?;

    let result = CommitPatch {
        patch: output.patch,
        files_changed: output.files,
        insertions: output.adds,
        deletions: output.dels,
        truncated: output.truncated,
    };
    {
        let mut held = cache.lock().unwrap();
        held.push((cache_key, result.clone()));
        while held.len() > MAX_CACHED_PATCHES {
            held.remove(0);
        }
    }
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
    let installed = blocking::io(|| {
        let mut cmd = Command::new(&bin);
        cmd.no_console_window().arg("--version");
        command_output_capped(&mut cmd, PROCESS_STREAM_MAX)
    })
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
    // A network round-trip to GitHub, on the runtime's worker without this.
    let (authenticated, account, detail) =
        match blocking::io(|| command_output_capped(&mut cmd, PROCESS_STREAM_MAX)) {
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
    let host = blocking::io(|| {
        let mut cmd = Command::new(&bin);
        cmd.no_console_window().args(["auth", "status"]);
        command_output_capped(&mut cmd, PROCESS_STREAM_MAX)
    })
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
pub(crate) fn default_base(top: &Path) -> String {
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
pub(crate) fn is_protected_branch(name: &str, base: &str) -> bool {
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

/// A session's working-time clock, lifted off its digest. One value rather than
/// two more scalars on `workspace_join`, which is already at the arity where an
/// argument gets passed in the wrong slot.
#[derive(Default, Clone, Copy)]
pub struct SessionClock {
    pub active_secs: Option<u64>,
    pub run_secs: Option<u64>,
}

impl SessionClock {
    /// Read from a digest value, absent for anything written before the clock
    /// existed or for a CLI with no hook at all.
    fn of(digest: Option<&serde_json::Value>) -> Self {
        let n = |k: &str| digest.and_then(|v| v.get(k)).and_then(|v| v.as_u64());
        SessionClock {
            active_secs: n("active_secs"),
            run_secs: n("run_secs"),
        }
    }
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
    /// Which rung of the evidence ladder produced `state`. Carried through so
    /// the workspace header needs no second source — it used to compute the
    /// chip from the raw state and the clock from a decay function with the CPU
    /// hard-coded to zero, and show both answers at once.
    pub state_via: Option<String>,
    pub cwd: Option<String>,
    pub updated: Option<u64>,
    /// The session's working-time clock, as canopy_hook.rs keeps it: seconds
    /// actually spent working over the session's life, and seconds in the
    /// current uninterrupted stretch. Zero/None for a session with no digest.
    pub active_secs: Option<u64>,
    pub run_secs: Option<u64>,
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
    /// Commits on the branch that its upstream doesn't have. None when the
    /// branch has no upstream at all — i.e. it was never pushed.
    pub unpushed: Option<u32>,
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
        dstr("state_via"),
        digest.get("updated").and_then(|v| v.as_u64()),
        touched,
        dstr("cwd"),
        dstr("branch"),
        SessionClock::of(Some(&digest)),
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
    let (sid, state_s, state_via, updated, touched, branch_fallback, clock) =
        match session_id.as_deref() {
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
                    dstr("state_via"),
                    updated,
                    touched,
                    dstr("branch"),
                    SessionClock::of(d),
                )
            }
            _ => (
                String::new(),
                None,
                None,
                None,
                Vec::new(),
                None,
                SessionClock::default(),
            ),
        };
    workspace_join(
        &top,
        base,
        sid,
        agent,
        state_s,
        state_via,
        updated,
        touched,
        Some(cwd),
        branch_fallback,
        clock,
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
    state_via: Option<String>,
    updated: Option<u64>,
    touched: Vec<String>,
    cwd: Option<String>,
    branch_fallback: Option<String>,
    clock: SessionClock,
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
    let mut unpushed: Option<u32> = None;
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
            merged = blocking::io(|| {
                command_output_capped(
                    git(top).args(["merge-base", "--is-ancestor", &b, &base]),
                    PROCESS_STREAM_MAX,
                )
            })
            .map(|o| o.status.success())
            .unwrap_or(false);
            // rev-list fails when the branch has no upstream, which is exactly
            // the None this reports: never pushed, as opposed to 0 left to push.
            unpushed =
                run(git(top).args(["rev-list", "--count", &format!("{b}@{{upstream}}..{b}")]))
                    .ok()
                    .and_then(|o| o.trim().parse().ok());
            commits = branch_commits_of(top, &base, &b);
        }
    }

    Ok(AgentWorkspace {
        session_id,
        agent,
        state,
        state_via,
        cwd,
        updated,
        active_secs: clock.active_secs,
        run_secs: clock.run_secs,
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
        unpushed,
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
            if let Ok(out) = blocking::io(|| {
                command_output_capped(
                    git(&dir).args(["diff", "--no-index", "--", "/dev/null", file]),
                    PROCESS_STREAM_MAX,
                )
            }) {
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

#[derive(Serialize)]
pub struct IssueComment {
    pub id: String,
    pub author: String,
    pub body: String,
    pub created_at: String,
    pub url: String,
}

#[derive(Serialize)]
pub struct IssueStateOption {
    pub id: String,
    pub name: String,
}

#[derive(Serialize)]
pub struct IssueDetail {
    pub internal_id: String,
    pub author: String,
    pub created_at: String,
    pub updated_at: String,
    pub state: String,
    pub state_id: String,
    pub states: Vec<IssueStateOption>,
    pub comments: Vec<IssueComment>,
}

#[tauri::command]
pub async fn gh_issue_detail(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u64,
) -> Result<IssueDetail, String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args([
        "issue",
        "view",
        &number.to_string(),
        "--json",
        "author,createdAt,updatedAt,state,comments",
    ]);
    let out = run_net(&mut cmd)?;
    let v: serde_json::Value =
        serde_json::from_str(&out).map_err(|e| format!("gh returned unexpected output: {e}"))?;
    let comments = v["comments"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|c| IssueComment {
                    id: c["id"].as_str().unwrap_or("").to_string(),
                    author: c["author"]["login"].as_str().unwrap_or("ghost").to_string(),
                    body: c["body"].as_str().unwrap_or("").to_string(),
                    created_at: c["createdAt"].as_str().unwrap_or("").to_string(),
                    url: c["url"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(IssueDetail {
        internal_id: String::new(),
        author: v["author"]["login"].as_str().unwrap_or("ghost").to_string(),
        created_at: v["createdAt"].as_str().unwrap_or("").to_string(),
        updated_at: v["updatedAt"].as_str().unwrap_or("").to_string(),
        state: v["state"].as_str().unwrap_or("").to_lowercase(),
        state_id: String::new(),
        states: Vec::new(),
        comments,
    })
}

fn linear_graphql(
    api_key: &str,
    query: &str,
    variables: serde_json::Value,
) -> Result<serde_json::Value, String> {
    use std::io::Write;
    if api_key.trim().is_empty() {
        return Err("no Linear API key".into());
    }
    let body = serde_json::json!({ "query": query, "variables": variables }).to_string();
    let capture_permit = crate::process_capture::acquire(PROCESS_STREAM_MAX)?;
    let mut child = std::process::Command::new(tool_path("curl"))
        .no_console_window()
        .args([
            "-sS",
            "--max-time",
            "15",
            "-K",
            "-", // read the auth header from stdin so the key never appears in argv
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
    drop(child.stdin.take());
    let out = blocking::io(|| wait_with_capped_output(child, PROCESS_STREAM_MAX, capture_permit))?;
    reject_truncated_output(&out, "Linear")?;
    if !out.status.success() {
        return Err(format!(
            "Linear request failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let value: serde_json::Value = serde_json::from_str(&String::from_utf8_lossy(&out.stdout))
        .map_err(|_| "Linear returned unexpected output".to_string())?;
    if let Some(err) = value["errors"].as_array().and_then(|rows| rows.first()) {
        return Err(format!(
            "Linear: {}",
            err["message"].as_str().unwrap_or("request rejected")
        ));
    }
    Ok(value)
}

#[tauri::command]
pub async fn linear_issue_detail(
    api_key: String,
    identifier: String,
) -> Result<IssueDetail, String> {
    let query = r#"query IssueDetail($id: String!) { issue(id: $id) { id creator { displayName } createdAt updatedAt state { id name } team { states { nodes { id name } } } comments(first: 100) { nodes { id body createdAt user { displayName } } } } }"#;
    let value = linear_graphql(&api_key, query, serde_json::json!({ "id": identifier }))?;
    let issue = &value["data"]["issue"];
    if issue.is_null() {
        return Err("Linear issue not found".into());
    }
    let comments = issue["comments"]["nodes"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|comment| IssueComment {
                    id: comment["id"].as_str().unwrap_or("").to_string(),
                    author: comment["user"]["displayName"]
                        .as_str()
                        .unwrap_or("Former member")
                        .to_string(),
                    body: comment["body"].as_str().unwrap_or("").to_string(),
                    created_at: comment["createdAt"].as_str().unwrap_or("").to_string(),
                    url: String::new(),
                })
                .collect()
        })
        .unwrap_or_default();
    let states = issue["team"]["states"]["nodes"]
        .as_array()
        .map(|rows| {
            rows.iter()
                .map(|state| IssueStateOption {
                    id: state["id"].as_str().unwrap_or("").to_string(),
                    name: state["name"].as_str().unwrap_or("").to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(IssueDetail {
        internal_id: issue["id"].as_str().unwrap_or("").to_string(),
        author: issue["creator"]["displayName"]
            .as_str()
            .unwrap_or("Former member")
            .to_string(),
        created_at: issue["createdAt"].as_str().unwrap_or("").to_string(),
        updated_at: issue["updatedAt"].as_str().unwrap_or("").to_string(),
        state: issue["state"]["name"].as_str().unwrap_or("").to_string(),
        state_id: issue["state"]["id"].as_str().unwrap_or("").to_string(),
        states,
        comments,
    })
}

#[tauri::command]
pub async fn linear_issue_set_state(
    api_key: String,
    issue_id: String,
    state_id: String,
) -> Result<(), String> {
    let query = r#"mutation SetIssueState($issueId: String!, $stateId: String!) { issueUpdate(id: $issueId, input: { stateId: $stateId }) { success } }"#;
    linear_graphql(
        &api_key,
        query,
        serde_json::json!({ "issueId": issue_id, "stateId": state_id }),
    )?;
    Ok(())
}

#[tauri::command]
pub async fn linear_issue_comment(
    api_key: String,
    issue_id: String,
    body: String,
) -> Result<(), String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("comment cannot be empty".into());
    }
    let query = r#"mutation CommentOnIssue($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }"#;
    linear_graphql(
        &api_key,
        query,
        serde_json::json!({ "issueId": issue_id, "body": body }),
    )?;
    Ok(())
}

#[tauri::command]
pub async fn gh_issue_set_state(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u64,
    open: bool,
) -> Result<(), String> {
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args([
        "issue",
        if open { "reopen" } else { "close" },
        &number.to_string(),
    ]);
    run_net(&mut cmd).map(|_| ())
}

#[tauri::command]
pub async fn gh_issue_comment(
    state: State<'_, WorkspaceManager>,
    repo: String,
    number: u64,
    body: String,
) -> Result<(), String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("comment cannot be empty".into());
    }
    let top = repo_path(&state, &repo)?;
    let mut cmd = gh_in(&top);
    cmd.args(["issue", "comment", &number.to_string(), "--body", body]);
    run_net(&mut cmd).map(|_| ())
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
    // Active work only — completed/canceled would bury the list.
    let query = r#"{ viewer { id } issues(first: 100, orderBy: updatedAt, filter: { state: { type: { in: ["triage", "backlog", "unstarted", "started"] } } }) { nodes { identifier title url branchName description priorityLabel state { name type } assignee { id displayName } } } }"#;
    let v = linear_graphql(&api_key, query, serde_json::json!({}))?;
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

    #[test]
    fn stacked_merge_error_is_the_only_cli_failure_that_falls_back() {
        assert!(stacked_merge_required(
            "GraphQL: This pull request is part of a stack and must be merged using the asynchronous merge REST API. (mergePullRequest)"
        ));
        assert!(!stacked_merge_required(
            "GraphQL: Pull Request is not mergeable"
        ));
        assert!(!stacked_merge_required("authentication failed"));
    }

    #[test]
    fn async_merge_response_distinguishes_accepted_from_landed() {
        let pending = parse_async_merge(
            r#"{"status":"pending","details":{"message":"Merge request accepted","uuid":"abc"}}"#,
            42,
            "Squashed and merged",
        )
        .unwrap();
        assert!(pending.pending);
        assert!(pending.message.contains("processing its PR stack"));

        let merged = parse_async_merge(
            r#"{"status":"merged","details":{"message":"Pull request merged","sha":"abc"}}"#,
            42,
            "Squashed and merged",
        )
        .unwrap();
        assert_eq!(
            merged,
            PrMergeResult {
                message: "Squashed and merged #42".into(),
                pending: false,
            }
        );
    }

    #[test]
    fn async_merge_response_surfaces_github_failure() {
        let error = parse_async_merge(
            r#"{"status":"failed","details":{"message":"Required check failed"}}"#,
            42,
            "Merged",
        )
        .unwrap_err();
        assert_eq!(error, "Required check failed");
    }
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
    fn streaming_patch_drain_caps_retention_but_counts_the_full_diff() {
        let mut patch = String::new();
        for index in 0..2000 {
            patch.push_str(&format!(
                "diff --git a/{index} b/{index}\n@@ -1 +1 @@\n-old {index}\n+new {index}\n"
            ));
        }
        let output = drain_patch(std::io::Cursor::new(patch.as_bytes()), 4096).unwrap();
        assert!(output.truncated);
        assert!(output.patch.len() <= 4096);
        assert_eq!(output.files, 2000);
        assert_eq!(output.adds, 2000);
        assert_eq!(output.dels, 2000);
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
            "state": "OPEN",
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
    fn parse_conversation_carries_whether_the_pr_is_still_open() {
        // The tab's PrInfo is frozen at open time, so this is the only thing
        // that ever tells it the PR landed — merged here, or on github.com.
        let c = parse_conversation(&conversation_fixture(), 1).expect("parses");
        assert_eq!(c.state, "OPEN");

        let mut merged = conversation_fixture();
        merged["repository"]["pullRequest"]["state"] = json!("MERGED");
        assert_eq!(
            parse_conversation(&merged, 1).expect("parses").state,
            "MERGED"
        );
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

    #[test]
    fn graphql_keeps_pr_data_when_an_outdated_thread_line_cannot_resolve() {
        let response = json!({
            "data": { "repository": { "pullRequest": { "id": "PR_1" } } },
            "errors": [{
                "message": "Line could not be resolved",
                "path": ["repository", "pullRequest", "reviewThreads", "nodes", 0, "line"]
            }]
        });

        let data = graphql_data(response.to_string()).expect("the partial PR remains usable");
        assert_eq!(data["repository"]["pullRequest"]["id"], "PR_1");
    }

    #[test]
    fn graphql_does_not_hide_unrelated_errors() {
        let response = json!({
            "data": { "repository": null },
            "errors": [{
                "message": "Line could not be resolved",
                "path": ["repository", "line"]
            }]
        });

        assert_eq!(
            graphql_data(response.to_string()).unwrap_err(),
            "Line could not be resolved"
        );
    }

    /// The regression this file's history most needs: a command whose output is
    /// bigger than a pipe buffer used to deadlock — the child blocked in write,
    /// never exited, and the user was told "timed out after 120s" 120 seconds
    /// later. Any PR diff over ~64KB hit it.
    #[cfg(unix)]
    #[test]
    fn capped_process_output_drains_beyond_the_retained_window() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args([
            "-c",
            "yes 0123456789abcdefghijklmnopqrstuvwxyz | head -c 200000",
        ]);
        let out = command_output_capped(&mut cmd, 8 * 1024).expect("command completes");
        assert!(out.status.success());
        assert_eq!(out.stdout.len(), 8 * 1024);
        assert!(out.stdout_truncated);
        assert!(!out.stderr_truncated);
    }

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
    fn run_net_writes_a_body_bigger_than_a_pipe_buffer_to_stdin() {
        // The mirror of the stdout test, and the same deadlock: a review with a
        // dozen findings clears 64KB, and writing it inline would block in
        // write() while the child waited for us to stop writing.
        let body = "x".repeat(200_000);
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "wc -c"]);
        let out = run_net_with_input(&mut cmd, Some(&body)).expect("a large stdin is written");
        assert_eq!(out.trim(), "200000", "got {out:?}");
    }

    #[cfg(unix)]
    #[test]
    fn run_net_closes_stdin_so_a_reader_sees_eof() {
        // Without the drop, `gh api --input -` reads forever and the review
        // "times out" having never been sent.
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "cat"]);
        assert_eq!(run_net_with_input(&mut cmd, Some("done")).unwrap(), "done");
    }

    #[cfg(unix)]
    #[test]
    fn run_net_still_reports_failure_output() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", "echo trouble >&2; exit 3"]);
        assert_eq!(run_net(&mut cmd).unwrap_err(), "trouble");
    }

    #[cfg(unix)]
    #[test]
    fn graphql_keeps_json_stdout_when_gh_exits_for_a_field_error() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args([
            "-c",
            "echo '{\"data\":{\"repository\":{}}}'; echo 'gh: Line could not be resolved' >&2; exit 1",
        ]);
        assert_eq!(
            run_graphql(&mut cmd, None).unwrap(),
            r#"{"data":{"repository":{}}}"#
        );
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

    // The strings below are git's real output, captured from git 2.x — the
    // classifier's whole job is to keep them out of the user's face.

    #[test]
    fn classify_reads_the_worktree_that_holds_a_branch() {
        let err = "fatal: 'feat/embedded-browser' is already used by worktree at '/Users/dev/repo/.claude/worktrees/agent-a17876ad98b03ff64'";
        assert_eq!(
            classify_checkout(err),
            CheckoutRefusal::BranchInWorktree {
                path: "/Users/dev/repo/.claude/worktrees/agent-a17876ad98b03ff64".into()
            }
        );
    }

    #[test]
    fn classify_collects_the_files_checkout_would_overwrite() {
        let err = "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/app.ts\n\tsrc/index.css\nPlease commit your changes or stash them before you switch branches.\nAborting";
        assert_eq!(
            classify_checkout(err),
            CheckoutRefusal::LocalChanges {
                files: vec!["src/app.ts".into(), "src/index.css".into()],
                untracked: false,
            }
        );
    }

    #[test]
    fn classify_tells_untracked_collisions_apart() {
        let err = "error: The following untracked working tree files would be overwritten by checkout:\n\tnotes.md\nPlease move or remove them before you switch branches.\nAborting";
        assert_eq!(
            classify_checkout(err),
            CheckoutRefusal::LocalChanges {
                files: vec!["notes.md".into()],
                untracked: true,
            }
        );
    }

    #[test]
    fn classify_leaves_anything_else_alone() {
        assert_eq!(
            classify_checkout("fatal: invalid reference: nope"),
            CheckoutRefusal::Unknown
        );
        assert_eq!(classify_checkout(""), CheckoutRefusal::Unknown);
    }

    // The second stage. Every string below is real git 2.50.1 / gh 2.96.0
    // stderr; `classify_checkout` is consulted first and returns Unknown for
    // all of them, which is exactly why they live here.

    #[test]
    fn a_failure_keeps_what_git_said_on_both_streams() {
        // The mid-merge refusal splits: the file list on stdout, the sentence
        // about it on stderr. Losing either loses the point.
        let mut cmd = Command::new("sh");
        cmd.args([
            "-c",
            "echo 'f.txt: needs merge'; echo 'error: you need to resolve your current index first' >&2; exit 1",
        ]);
        let err = run(&mut cmd).expect_err("a non-zero exit is an error");
        assert_eq!(
            err,
            "f.txt: needs merge\nerror: you need to resolve your current index first"
        );
        // And that combined text still classifies.
        assert_eq!(
            classify_extra(&err),
            Some(ExtraRefusal::MidOperation { op: RepoOp::Merge })
        );
    }

    #[test]
    fn a_success_keeps_the_warning_git_only_says_on_stderr() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo out; echo 'warning: refname is ambiguous' >&2"]);
        let (stdout, stderr) = run_verbose(&mut cmd).expect("exit 0 is a success");
        assert_eq!(stdout.trim(), "out");
        assert_eq!(stderr, "warning: refname is ambiguous");
    }

    #[test]
    fn extra_reads_ghs_fetch_stage_wording_for_a_held_branch() {
        let err = "fatal: refusing to fetch into branch 'refs/heads/new-branch' checked out at '/Users/dev/repo-wt-new-branch'\nfailed to run git: exit status 128";
        assert_eq!(
            classify_extra(err),
            Some(ExtraRefusal::BranchInWorktree {
                path: "/Users/dev/repo-wt-new-branch".into()
            })
        );
    }

    #[test]
    fn extra_names_the_operation_the_repo_is_in_the_middle_of() {
        for (err, op) in [
            ("fatal: cannot switch branch while merging", RepoOp::Merge),
            (
                "fatal: cannot switch branch while rebasing\nConsider \"git rebase --quit\" or \"git worktree add\".",
                RepoOp::Rebase,
            ),
            (
                "fatal: cannot switch branch while cherry-picking",
                RepoOp::CherryPick,
            ),
            ("fatal: cannot switch branch while reverting", RepoOp::Revert),
            (
                "fatal: cannot switch branch in the middle of an am session",
                RepoOp::Am,
            ),
        ] {
            assert_eq!(
                classify_extra(err),
                Some(ExtraRefusal::MidOperation { op }),
                "{err}"
            );
        }
    }

    #[test]
    fn extra_reads_an_unresolved_index_as_an_unfinished_merge() {
        let err = "error: you need to resolve your current index first";
        assert_eq!(
            classify_extra(err),
            Some(ExtraRefusal::MidOperation { op: RepoOp::Merge })
        );
    }

    #[test]
    fn extra_tells_a_taken_branch_name_from_a_taken_path() {
        assert_eq!(
            classify_extra("fatal: a branch named 'feat/x' already exists"),
            Some(ExtraRefusal::NameTaken {
                branch: "feat/x".into()
            })
        );
        assert_eq!(
            classify_extra("fatal: '/Users/dev/canopy-wt-feat-x' already exists"),
            Some(ExtraRefusal::PathInUse {
                path: "/Users/dev/canopy-wt-feat-x".into()
            })
        );
    }

    #[test]
    fn extra_recognises_a_name_that_is_not_here() {
        // git 2.31 dropped this line's trailing period; both forms must match.
        assert_eq!(
            classify_extra("error: pathspec 'feat/x' did not match any file(s) known to git"),
            Some(ExtraRefusal::NothingCalled {
                name: "feat/x".into()
            })
        );
        assert_eq!(
            classify_extra("error: pathspec 'feat/x' did not match any file(s) known to git."),
            Some(ExtraRefusal::NothingCalled {
                name: "feat/x".into()
            })
        );
        assert_eq!(
            classify_extra("fatal: invalid reference: nope"),
            Some(ExtraRefusal::NothingCalled {
                name: "nope".into()
            })
        );
    }

    #[test]
    fn extra_reads_a_locked_workspace_with_and_without_a_reason() {
        assert_eq!(
            classify_extra(
                "fatal: cannot remove a locked working tree, lock reason: review in progress\nuse 'remove -f -f' to override or unlock first"
            ),
            Some(ExtraRefusal::LockedWorkspace {
                path: String::new(),
                reason: "review in progress".into()
            })
        );
        assert_eq!(
            classify_extra("fatal: cannot move a locked working tree"),
            Some(ExtraRefusal::LockedWorkspace {
                path: String::new(),
                reason: "locked".into()
            })
        );
    }

    #[test]
    fn extra_recognises_another_git_holding_the_index() {
        let err = "fatal: Unable to create '/Users/dev/repo/.git/index.lock': File exists.\n\nAnother git process seems to be running in this repository, e.g.\nan editor opened by 'git commit'. Please make sure all processes\nare terminated then try again.";
        assert_eq!(
            classify_extra(err),
            Some(ExtraRefusal::AnotherCommandRunning)
        );
    }

    #[test]
    fn extra_recognises_the_ways_github_is_out_of_reach() {
        for err in [
            "fatal: couldn't find remote ref pull/142/head",
            "no git remotes found",
            "GraphQL: Could not resolve to a PullRequest with the number of 999. (repository.pullRequest)",
            "timed out after 120s — remote unreachable, or it wants credentials this app can't prompt for",
        ] {
            assert!(
                matches!(
                    classify_extra(err),
                    Some(ExtraRefusal::RemoteUnreachable { .. })
                ),
                "{err}"
            );
        }
    }

    /// The one sentence a person reads is ours, never git's or gh's. Quoting
    /// their first line said the same unhelpful thing in three quite different
    /// situations; the raw text belongs in the folded detail instead.
    #[test]
    fn out_of_reach_says_which_of_the_three_it_is_in_our_own_words() {
        let body = |err: &str, pr: Option<u32>| match remote_unreachable_for(err, pr) {
            CheckoutOutcome::RemoteUnreachable { summary, detail } => {
                // git's own words are kept, just not as the headline.
                assert!(!detail.is_empty(), "{err}");
                assert!(!summary.contains("fatal:"), "{summary}");
                summary
            }
            _ => unreachable!(),
        };
        assert_eq!(
            body(
                "To get started with GitHub CLI, please run: gh auth login",
                None
            ),
            "Canopy couldn't reach GitHub with the sign-in it has."
        );
        assert_eq!(
            body("no git remotes found", None),
            "This project has no remote to fetch from."
        );
        assert!(
            body("fatal: couldn't find remote ref pull/142/head", Some(142))
                .starts_with("GitHub doesn't have a copy of #142's changes")
        );
    }

    #[test]
    fn ghs_wrapper_line_never_changes_what_a_refusal_means() {
        // gh streams git's lines through verbatim and appends its own last, so
        // the shapes classify_checkout already knows match straight through it.
        let err = "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/app.ts\nPlease commit your changes or stash them before you switch branches.\nAborting\nfailed to run git: exit status 1";
        assert_eq!(
            classify_checkout(err),
            CheckoutRefusal::LocalChanges {
                files: vec!["src/app.ts".into()],
                untracked: false,
            }
        );
        // …and the wrapper line comes off the detail, which is all it costs.
        assert_eq!(
            strip_gh_noise(err),
            "error: Your local changes to the following files would be overwritten by checkout:\n\tsrc/app.ts\nPlease commit your changes or stash them before you switch branches.\nAborting"
        );
    }

    #[test]
    fn strip_gh_noise_leaves_git_alone() {
        let err = "fatal: invalid reference: nope";
        assert_eq!(strip_gh_noise(err), err);
    }

    #[test]
    fn a_locked_workspace_whose_folder_is_gone_reads_as_prunable() {
        // Git omits the `prunable` line for a locked worktree, which made the
        // busy dialog offer to open a directory that isn't there.
        let out = "worktree /Users/dev/repo\nHEAD abc1234567\nbranch refs/heads/main\n\nworktree /Users/dev/repo-wt-gone\nHEAD def4567890\nbranch refs/heads/feat/x\nlocked review in progress\n";
        let mut list = parse_worktrees(out);
        assert_eq!(list.len(), 2);
        assert!(list[0].is_main);
        assert_eq!(list[1].locked.as_deref(), Some("review in progress"));
        assert_eq!(list[1].prunable, None);
        mark_missing(&mut list);
        assert_eq!(list[1].prunable.as_deref(), Some("its folder is gone"));
        // The lock stays: clearing this record still takes force.
        assert_eq!(list[1].locked.as_deref(), Some("review in progress"));
    }

    #[test]
    fn a_synthesised_holder_survives_a_windows_path() {
        let h = holder_at(
            Path::new("/nonexistent-repo"),
            "feat/x",
            r"C:\Users\dev\repo\.claude\worktrees\agent-a1",
        );
        assert_eq!(h.name, "agent-a1");
        assert!(h.agent);
        assert!(!h.is_main);
    }

    #[test]
    fn agent_worktrees_are_recognised_by_where_they_live() {
        assert!(is_agent_worktree(
            "/Users/dev/repo/.claude/worktrees/agent-a1"
        ));
        assert!(is_agent_worktree(
            r"C:\Users\dev\repo\.claude\worktrees\agent-a1"
        ));
        // A worktree the user made themselves is not an agent's.
        assert!(!is_agent_worktree("/Users/dev/repo-wt-feature"));
        assert!(!is_agent_worktree("/Users/dev/claude/worktrees/thing"));
    }

    #[test]
    fn only_local_config_is_carried_into_a_new_workspace() {
        // The files a checkout cannot run without and git will never give you.
        assert!(is_carryable(".env"));
        assert!(is_carryable(".env.local"));
        assert!(is_carryable("api/.env.development"));
        assert!(is_carryable(".envrc"));
        assert!(is_carryable(".tool-versions"));
        // Build output and dependencies are not config. `dist/` in particular
        // would be a stale copy that looks current, which is worse than absent.
        assert!(!is_carryable("dist"));
        assert!(!is_carryable("node_modules"));
        assert!(!is_carryable("target"));
        assert!(!is_carryable("coverage/index.html"));
        // A name that merely starts the same way isn't one of ours.
        assert!(!is_carryable("environment.ts"));
    }

    #[test]
    fn the_install_follows_the_committed_lockfile() {
        let root = std::env::temp_dir().join(format!("canopy-boot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        // Nothing to install at all.
        assert_eq!(install_command(&root), None);

        // A package.json with no lockfile can only be `npm install`.
        std::fs::write(root.join("package.json"), "{}").unwrap();
        assert_eq!(install_command(&root).as_deref(), Some("npm install"));

        // With a lockfile, the install that respects it — `npm ci`, not
        // `npm install`, because a worktree is a fresh checkout.
        std::fs::write(root.join("package-lock.json"), "{}").unwrap();
        assert_eq!(install_command(&root).as_deref(), Some("npm ci"));

        // pnpm outranks npm's lockfile when both are present: a repo that has
        // both is a repo mid-migration, and pnpm's is the one being written.
        std::fs::write(root.join("pnpm-lock.yaml"), "").unwrap();
        assert_eq!(install_command(&root).as_deref(), Some("pnpm install"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn cloning_a_directory_reproduces_it() {
        let root = std::env::temp_dir().join(format!("canopy-clone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src/nested")).unwrap();
        std::fs::write(root.join("src/a.js"), "one").unwrap();
        std::fs::write(root.join("src/nested/b.js"), "two").unwrap();

        clone_dir(&root.join("src"), &root.join("dst")).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("dst/a.js")).unwrap(),
            "one"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("dst/nested/b.js")).unwrap(),
            "two"
        );

        // A clone is a copy, not a link: writing through one must not be
        // visible through the other, or two workspaces would share deps.
        std::fs::write(root.join("dst/a.js"), "changed").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("src/a.js")).unwrap(),
            "one"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// A links response with one of everything, plus the three shapes that have
    /// to be dropped: the PR referring to itself, a duplicate of something
    /// already grouped, and a cross-reference to something unreadable.
    fn links_fixture() -> Value {
        json!({"repository": {
            "pullRequest": {
                "closingIssuesReferences": {"nodes": [
                    {"number": 12, "title": "Secrets leak on push", "url": "https://gh/o/r/issues/12",
                     "state": "OPEN", "repository": {"nameWithOwner": "o/r"}}
                ]},
                "timelineItems": {"nodes": [
                    // Already in `closes` — must not be repeated as a mention.
                    {"source": {"__typename": "Issue", "number": 12, "title": "Secrets leak on push",
                                "url": "https://gh/o/r/issues/12", "state": "OPEN",
                                "repository": {"nameWithOwner": "o/r"}}},
                    // A genuine mention, from another repo.
                    {"source": {"__typename": "Issue", "number": 4, "title": "Roll out the scanner",
                                "url": "https://gh/other/repo/issues/4", "state": "CLOSED",
                                "repository": {"nameWithOwner": "other/repo"}}},
                    // This PR, cross-referencing itself.
                    {"source": {"__typename": "PullRequest", "number": 302, "title": "This one",
                                "url": "https://gh/o/r/pull/302", "state": "OPEN",
                                "repository": {"nameWithOwner": "o/r"}}},
                    // A reference to something the token can't read.
                    {"source": {}}
                ]}
            },
            "children": {"nodes": [
                {"number": 303, "title": "Scan the whole tree", "url": "https://gh/o/r/pull/303",
                 "state": "OPEN", "isDraft": true, "baseRefName": "chore/secret-scan-gate"}
            ]},
            "parents": {"nodes": [
                {"number": 300, "title": "Add the hook runner", "url": "https://gh/o/r/pull/300",
                 "state": "OPEN", "isDraft": false, "baseRefName": "main"}
            ]}
        }})
    }

    #[test]
    fn parse_links_groups_closes_children_and_parents() {
        let l = parse_links(&links_fixture(), 302, "o/r");

        assert_eq!(l.closes.len(), 1);
        assert_eq!(l.closes[0].number, 12);
        assert_eq!(l.closes[0].kind, "issue");
        // Same repo as the PR, so the row carries no prefix to disambiguate.
        assert_eq!(l.closes[0].repo, "");

        assert_eq!(l.children.len(), 1);
        assert_eq!(l.children[0].number, 303);
        assert_eq!(l.children[0].kind, "pr");
        assert!(l.children[0].draft);
        assert_eq!(l.children[0].base, "chore/secret-scan-gate");

        assert_eq!(l.parents.len(), 1);
        assert_eq!(l.parents[0].number, 300);
        assert!(!l.parents[0].draft);
    }

    #[test]
    fn parse_links_drops_duplicates_self_and_unreadable_refs() {
        let l = parse_links(&links_fixture(), 302, "o/r");

        // #12 is already a closing reference; #302 is this PR; the empty source
        // is a reference to something we can't see. One mention survives.
        let urls: Vec<&str> = l.mentions.iter().map(|m| m.url.as_str()).collect();
        assert_eq!(urls, vec!["https://gh/other/repo/issues/4"]);
        assert_eq!(l.mentions[0].state, "CLOSED");
    }

    #[test]
    fn parse_links_keeps_the_repo_prefix_only_when_it_changes_the_meaning() {
        let l = parse_links(&links_fixture(), 302, "o/r");
        // "#4" alone would point at this repo's #4, which is a different issue.
        assert_eq!(l.mentions[0].repo, "other/repo");
        assert_eq!(l.mentions[0].number, 4);
    }

    #[test]
    fn parse_links_survives_a_pr_with_nothing_attached() {
        // Every group absent rather than empty — what the query returns for a
        // PR that closes nothing and that nothing has referenced.
        let l = parse_links(&json!({"repository": {"pullRequest": {}}}), 1, "o/r");
        assert!(l.closes.is_empty());
        assert!(l.children.is_empty());
        assert!(l.parents.is_empty());
        assert!(l.mentions.is_empty());
    }

    #[test]
    fn parse_links_does_not_mistake_another_repos_pr_number_for_this_one() {
        // Same number as the PR being viewed, different repo: a real mention.
        let data = json!({"repository": {"pullRequest": {"timelineItems": {"nodes": [
            {"source": {"__typename": "PullRequest", "number": 302, "title": "Elsewhere",
                        "url": "https://gh/other/repo/pull/302", "state": "MERGED",
                        "repository": {"nameWithOwner": "other/repo"}}}
        ]}}}});
        let l = parse_links(&data, 302, "o/r");
        assert_eq!(l.mentions.len(), 1);
        assert_eq!(l.mentions[0].repo, "other/repo");
        assert_eq!(l.mentions[0].state, "MERGED");
    }
}

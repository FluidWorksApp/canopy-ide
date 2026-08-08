//! Reclaiming the disk a project only borrowed.
//!
//! Parallel worktrees are Canopy's flagship (a checkout per agent), and every
//! one of them arrives with its own `node_modules` — cloned copy-on-write, so it
//! costs nothing on the day it is made, and then diverges into real gigabytes as
//! installs and builds run inside it. Nothing ever gave that space back: a
//! workspace removed in the Git panel took its own folder with it, but the
//! twenty still around are each holding a full install for a branch nobody has
//! touched in a month.
//!
//! So this is one built-in task, in Rust, with no agent involved: find what a
//! build can make again, say what it costs and what it would take to get back,
//! and let the user pick. The whole design is three rules.
//!
//! **Allowlist only.** A directory is a candidate because its name is in
//! `ARTIFACTS` *and* the ecosystem marker that explains it sits beside it — a
//! `target/` next to `Cargo.toml` is Rust's build output, a `target/` anywhere
//! else is somebody's source folder. Nothing outside the table is reachable,
//! at scan time or at delete time.
//!
//! **Git decides what is disposable.** Every candidate inside a checkout must be
//! ignored by that repo (`check-ignore`, one process per checkout). If git tracks
//! it, it is somebody's work, whatever it is called.
//!
//! **Nothing live is recommended.** Activity is read per *checkout*, not per
//! repo, because that is the unit that is busy or idle here: a terminal or agent
//! running in it, uncommitted files, how long since its last commit, whether its
//! project is hibernating. Everything is still selectable — the user can always
//! overrule us — but the default selection never includes a workspace that
//! something is using. Deliberately no automatic cleanup anywhere: not on
//! hibernation, not on a timer. Hibernating a project is a promise to bring it
//! back exactly as it was, and a wake that has to reinstall first would break
//! that promise on the one path where the user explicitly asked to keep the
//! arrangement. Reclaiming disk is always a thing the user clicked.
use crate::fsx::{check_scope, WorkspaceManager};
use crate::git::{git, scan_worktrees};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager, State};

/// What a directory is, which is also the order of how happily we part with it:
/// a cache is free to lose, an install costs a download, a build costs a build.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Cache,
    Build,
    Deps,
}

impl Category {
    fn as_str(self) -> &'static str {
        match self {
            Category::Cache => "cache",
            Category::Build => "build",
            Category::Deps => "deps",
        }
    }
}

/// One row of the allowlist. `name` is matched against the *tail* of the path,
/// so an entry can name a nested directory (`vendor/bundle`) without the walk
/// having to know anything about it.
struct Artifact {
    name: &'static str,
    category: Category,
    /// One of these must sit in the artifact's own directory or its parent — the
    /// file that explains why the directory exists. Empty means the name alone
    /// is unambiguous (`__pycache__`, `.parcel-cache`).
    markers: &'static [&'static str],
    /// What brings it back. Shown to the user, never run.
    regenerate: &'static str,
}

/// Everything Canopy will ever delete. Ordered only for readability; lookup
/// tries every entry whose name matches and takes the first whose marker is
/// present, so two ecosystems can share a directory name (`target`, `build`).
const ARTIFACTS: &[Artifact] = &[
    // ---- installs ----
    Artifact {
        name: "node_modules",
        category: Category::Deps,
        markers: &["package.json"],
        regenerate: "npm install",
    },
    Artifact {
        name: ".venv",
        category: Category::Deps,
        markers: &[
            "pyproject.toml",
            "requirements.txt",
            "setup.py",
            "setup.cfg",
        ],
        regenerate: "python -m venv .venv && pip install -r requirements.txt",
    },
    Artifact {
        name: "venv",
        category: Category::Deps,
        markers: &[
            "pyproject.toml",
            "requirements.txt",
            "setup.py",
            "setup.cfg",
        ],
        regenerate: "python -m venv venv && pip install -r requirements.txt",
    },
    Artifact {
        name: "Pods",
        category: Category::Deps,
        markers: &["Podfile"],
        regenerate: "pod install",
    },
    Artifact {
        name: "vendor/bundle",
        category: Category::Deps,
        markers: &["Gemfile"],
        regenerate: "bundle install",
    },
    // ---- build output ----
    Artifact {
        name: "target",
        category: Category::Build,
        markers: &["Cargo.toml"],
        regenerate: "cargo build",
    },
    Artifact {
        name: "target",
        category: Category::Build,
        markers: &["pom.xml"],
        regenerate: "mvn package",
    },
    Artifact {
        name: "dist",
        category: Category::Build,
        markers: &["package.json"],
        regenerate: "npm run build",
    },
    Artifact {
        name: "build",
        category: Category::Build,
        markers: &[
            "pubspec.yaml",
            "build.gradle",
            "build.gradle.kts",
            "CMakeLists.txt",
        ],
        regenerate: "rebuild the project",
    },
    Artifact {
        name: ".next",
        category: Category::Build,
        markers: &["package.json"],
        regenerate: "next build",
    },
    Artifact {
        name: ".nuxt",
        category: Category::Build,
        markers: &["package.json"],
        regenerate: "nuxt build",
    },
    Artifact {
        name: ".svelte-kit",
        category: Category::Build,
        markers: &["package.json"],
        regenerate: "vite build",
    },
    // ---- caches ----
    Artifact {
        name: ".turbo",
        category: Category::Cache,
        markers: &["package.json"],
        regenerate: "rebuilt on the next turbo run",
    },
    Artifact {
        name: ".parcel-cache",
        category: Category::Cache,
        markers: &[],
        regenerate: "rebuilt on the next parcel run",
    },
    Artifact {
        name: ".gradle",
        category: Category::Cache,
        markers: &[
            "build.gradle",
            "build.gradle.kts",
            "settings.gradle",
            "settings.gradle.kts",
        ],
        regenerate: "rebuilt on the next gradle run",
    },
    Artifact {
        name: ".dart_tool",
        category: Category::Cache,
        markers: &["pubspec.yaml"],
        regenerate: "rebuilt by flutter pub get",
    },
    Artifact {
        name: "__pycache__",
        category: Category::Cache,
        markers: &[],
        regenerate: "rebuilt on the next import",
    },
    Artifact {
        name: ".mypy_cache",
        category: Category::Cache,
        markers: &[],
        regenerate: "rebuilt on the next mypy run",
    },
    Artifact {
        name: ".pytest_cache",
        category: Category::Cache,
        markers: &[],
        regenerate: "rebuilt on the next pytest run",
    },
    Artifact {
        name: ".ruff_cache",
        category: Category::Cache,
        markers: &[],
        regenerate: "rebuilt on the next ruff run",
    },
];

/// How deep under a checkout the walk looks. A monorepo's `packages/*/…` sits at
/// three or four; past eight it is only ever finding artifacts inside artifacts.
const MAX_DEPTH: usize = 8;

/// Directories visited before the scan gives up and says so. A pathological
/// tree must not hang the popup that opened it.
const DIR_BUDGET: usize = 60_000;

/// Files counted inside one artifact before its size is reported as "at least
/// this much". A `node_modules` is 40k files; nothing is a million.
const FILE_BUDGET: u64 = 400_000;

/// Touched inside this many days and we leave it alone by default: a build that
/// ran this week is a build you are using.
const RECENT_BUILD_DAYS: u32 = 3;

/// No commit in a checkout for this long and its artifacts are offered by
/// default. dev-cleaner's line, and it holds up: a month is longer than any
/// branch anybody is mid-thought on.
const IDLE_DAYS: u32 = 30;

/// Uncommitted work extends the protection to this long, because the diff is
/// the work and losing its build is a worse trade than the disk.
const DIRTY_IDLE_DAYS: u32 = 90;

/// One directory Canopy will delete, with everything the user needs to judge it.
#[derive(Serialize, Clone)]
pub struct CleanupTarget {
    pub path: String,
    /// The allowlist entry that matched — `node_modules`, `target`.
    pub name: String,
    /// Where it sits inside its checkout (`packages/web/node_modules`).
    pub rel: String,
    pub category: &'static str,
    pub bytes: u64,
    pub files: u64,
    /// Whole-directory mtimes mean nothing here, so this is days since the
    /// newest file *inside* it was written — when the build last ran.
    pub idle_days: u32,
    pub regenerate: String,
    /// The checkout it belongs to, keyed to `CleanupWorkspace::path`.
    pub workspace: String,
    /// In the default selection.
    pub recommended: bool,
    /// Why it isn't, in words the row can show as-is.
    pub hold: Option<String>,
    /// Its size is a floor: the count hit `FILE_BUDGET`.
    pub partial: bool,
}

/// A checkout — the repo's own, or one of its worktrees — and what is going on
/// in it. This is the unit the recommendation is made against.
#[derive(Serialize, Clone)]
pub struct CleanupWorkspace {
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    /// The repo's own working tree rather than a linked worktree.
    pub main: bool,
    /// Uncommitted files in it.
    pub dirty: u32,
    /// A terminal, agent or server is live inside it.
    pub busy: bool,
    /// Its project is hibernating — the wake expects to find this intact.
    pub asleep: bool,
    /// Days since its last commit; absent when it isn't a git checkout.
    pub idle_days: Option<u32>,
    /// Its work is already in the base branch, and how we know — the sentence the
    /// row shows to explain why a workspace this new is being offered.
    pub landed: Option<String>,
    pub bytes: u64,
    pub recommended_bytes: u64,
}

#[derive(Serialize, Clone, Default)]
pub struct CleanupScan {
    pub workspaces: Vec<CleanupWorkspace>,
    pub targets: Vec<CleanupTarget>,
    pub bytes: u64,
    pub recommended_bytes: u64,
    /// Places the scan refused to look, said out loud rather than dropped — a
    /// worktree outside the open projects, a directory it couldn't read.
    pub skipped: Vec<String>,
    /// The walk hit `DIR_BUDGET`, so the list is not the whole story.
    pub truncated: bool,
}

/// Progress for the dialog while the walk runs: one event per checkout finished.
#[derive(Serialize, Clone)]
struct ScanProgress {
    workspace: String,
    done: usize,
    total: usize,
}

#[derive(Serialize, Clone, Default)]
pub struct CleanupOutcome {
    pub removed: Vec<String>,
    pub bytes: u64,
    /// Path and the reason it survived.
    pub failed: Vec<(String, String)>,
    /// Paths the delete-time allowlist check rejected. Should always be empty;
    /// if it isn't, something handed us a path the scan never produced.
    pub refused: Vec<String>,
    /// Sent to the Trash rather than unlinked, so the space comes back when the
    /// Trash is emptied.
    pub trashed: bool,
}

// ---------------------------------------------------------------------------
// the volume
//
// The tray already answers "what is this costing me" for CPU, memory and
// tokens. Disk was the one resource Canopy spent freely and never reported —
// which is exactly why nobody noticed twenty worktrees adding up. So the same
// panel that shows plan limits shows the volume the projects live on, and the
// cleanup task hangs off it.

/// One volume the open projects sit on.
#[derive(Serialize, Clone)]
pub struct DiskUsage {
    pub mount: String,
    /// The volume's own name, for the case where projects span two of them.
    pub label: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

/// The volumes behind the given roots — deduped, so N projects on one disk are
/// one bar. Cheap (a statfs per mount, no walking), so the panel can poll it.
#[tauri::command]
pub async fn cleanup_disk(
    state: State<'_, WorkspaceManager>,
    roots: Vec<String>,
) -> Result<Vec<DiskUsage>, String> {
    let mut resolved: Vec<PathBuf> = Vec::new();
    for r in &roots {
        // A root that has gone away (an unplugged drive) is not an error worth
        // failing the whole panel over.
        if let Ok(p) = check_scope(&state, Path::new(r)) {
            resolved.push(p);
        }
    }
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut out: Vec<DiskUsage> = Vec::new();
    for root in &resolved {
        // Longest matching mount wins: `/` matches everything, so a project on
        // an external volume must not be attributed to the boot disk.
        let best = disks
            .iter()
            .filter(|d| root.starts_with(d.mount_point()))
            .max_by_key(|d| d.mount_point().as_os_str().len());
        let Some(disk) = best else { continue };
        let mount = disk.mount_point().to_string_lossy().to_string();
        if out.iter().any(|d| d.mount == mount) {
            continue;
        }
        out.push(DiskUsage {
            mount,
            label: disk.name().to_string_lossy().to_string(),
            total_bytes: disk.total_space(),
            free_bytes: disk.available_space(),
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// matching

fn under(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn under_any(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|r| under(path, r))
}

/// The tail of `path` matches `name`, which may itself name several components.
fn tail_matches(path: &Path, name: &str) -> bool {
    let want: Vec<&str> = name.split('/').collect();
    let have: Vec<String> = path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().to_string())
        .collect();
    if have.len() < want.len() {
        return false;
    }
    have[have.len() - want.len()..]
        .iter()
        .zip(want)
        .all(|(a, b)| a == b)
}

/// The allowlist entry for a directory, or None — which is a refusal, not a
/// "probably fine". `has_marker` is injected so the table can be tested without
/// a filesystem.
fn classify_with(
    path: &Path,
    has_marker: &dyn Fn(&Path, &str) -> bool,
) -> Option<&'static Artifact> {
    ARTIFACTS.iter().find(|a| {
        if !tail_matches(path, a.name) {
            return false;
        }
        if a.markers.is_empty() {
            return true;
        }
        // The marker sits beside the artifact, or one level up: `vendor/bundle`
        // is explained by a `Gemfile` above `vendor`, `node_modules` by the
        // `package.json` next to it.
        let parent = path.parent();
        let grandparent = parent.and_then(|p| p.parent());
        a.markers.iter().any(|m| {
            parent.map(|p| has_marker(p, m)).unwrap_or(false)
                || grandparent.map(|p| has_marker(p, m)).unwrap_or(false)
        })
    })
}

fn classify(path: &Path) -> Option<&'static Artifact> {
    classify_with(path, &|dir: &Path, marker: &str| dir.join(marker).exists())
}

/// Hidden directories are skipped wholesale except the ones the table names —
/// otherwise the walk spends its budget inside `.git` and every editor's cache.
fn walkable(name: &str) -> bool {
    if name == ".git" || name == "node_modules" {
        return false;
    }
    if !name.starts_with('.') {
        return true;
    }
    ARTIFACTS.iter().any(|a| {
        a.name
            .split('/')
            .next()
            .map(|first| first == name)
            .unwrap_or(false)
    })
}

// ---------------------------------------------------------------------------
// measuring

struct Size {
    bytes: u64,
    files: u64,
    /// Newest mtime seen anywhere inside.
    newest: Option<SystemTime>,
    partial: bool,
}

/// Recursive `du`, without following a single symlink: a link inside
/// `node_modules` (pnpm's store, a `file:` dependency) points at something we
/// are not deleting, so counting it would inflate the number and following it
/// could leave the tree entirely.
fn measure(dir: &Path) -> Size {
    let mut out = Size {
        bytes: 0,
        files: 0,
        newest: None,
        partial: false,
    };
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                stack.push(entry.path());
                continue;
            }
            out.files += 1;
            if out.files > FILE_BUDGET {
                out.partial = true;
                return out;
            }
            if let Ok(meta) = entry.metadata() {
                out.bytes += meta.len();
                if let Ok(m) = meta.modified() {
                    if out.newest.map(|n| m > n).unwrap_or(true) {
                        out.newest = Some(m);
                    }
                }
            }
        }
    }
    out
}

fn days_since(t: SystemTime) -> u32 {
    SystemTime::now()
        .duration_since(t)
        .unwrap_or(Duration::ZERO)
        .as_secs()
        .saturating_div(86_400) as u32
}

// ---------------------------------------------------------------------------
// the verdict
//
// Split out and taking plain numbers so every rule below is a unit test rather
// than a thing you find out about by losing a build.

/// What the checkout's state is worth knowing about, for `verdict`.
pub struct Activity {
    pub busy: bool,
    pub asleep: bool,
    pub dirty: u32,
    pub idle_days: Option<u32>,
    /// Its work is already in the base branch, and how we know. This is the
    /// signal that makes this feature useful at all: a worktree for a merged PR
    /// is finished the day it merges, and waiting a month for the "idle" rule to
    /// notice leaves twenty full installs on disk in the meantime.
    pub landed: Option<String>,
}

/// Should this be selected when the dialog opens, and if not, why not.
///
/// The order is the argument: something using it right now outranks how big it
/// is, and "a cache is free" outranks "you were here last week".
pub fn verdict(act: &Activity, category: Category, built_days_ago: u32) -> (bool, Option<String>) {
    if act.busy {
        return (
            false,
            Some("a terminal or agent is live in this workspace".into()),
        );
    }
    if act.asleep {
        return (
            false,
            Some("this project is hibernating — waking it expects this back".into()),
        );
    }
    if act.dirty > 0 && act.idle_days.unwrap_or(0) < DIRTY_IDLE_DAYS {
        return (
            false,
            Some(format!(
                "{} uncommitted file{} here",
                act.dirty,
                if act.dirty == 1 { "" } else { "s" }
            )),
        );
    }
    // Nothing is running, nothing is uncommitted, and the work is in the base
    // branch — the age of the build is beside the point.
    if act.landed.is_some() {
        return (true, None);
    }
    if built_days_ago < RECENT_BUILD_DAYS {
        return (
            false,
            Some(match built_days_ago {
                0 => "written today".into(),
                1 => "written yesterday".into(),
                d => format!("written {d} days ago"),
            }),
        );
    }
    if category == Category::Cache {
        return (true, None);
    }
    match act.idle_days {
        Some(d) if d >= IDLE_DAYS => (true, None),
        Some(d) => (
            false,
            Some(format!(
                "last commit {d} day{} ago",
                if d == 1 { "" } else { "s" }
            )),
        ),
        // Not a git checkout, so there is no "when did you last work here" to
        // read. Offer nothing but a build's own age; the row is still selectable.
        None => (
            false,
            Some("not a git checkout — no history to judge by".into()),
        ),
    }
}

// ---------------------------------------------------------------------------
// scanning

/// Days since the last commit in this checkout. A worktree has its own HEAD, so
/// this is per-checkout and not per-repo — which is the entire point: the repo
/// is busy, the branch from last March is not.
fn last_commit_days(dir: &Path) -> Option<u32> {
    let out = crate::process_capture::output(
        git(dir).args(["log", "-1", "--format=%ct"]),
        crate::process_capture::DEFAULT_STREAM_MAX,
    )
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let secs: u64 = String::from_utf8_lossy(&out.stdout).trim().parse().ok()?;
    Some(days_since(
        SystemTime::UNIX_EPOCH + Duration::from_secs(secs),
    ))
}

/// Whether this checkout's work is already in the base branch, and how we know.
///
/// Two shapes, because that is how a PR ends. The tip is an ancestor of the base
/// — a plain merge or fast-forward. Or its remote branch is gone, which is what
/// GitHub's "delete branch on merge" leaves behind and the only trace a *squash*
/// merge leaves at all (the squashed commit is not this commit, so no ancestry
/// check can see it). The Git panel's work audit reads both the same way.
///
/// Never for the repo's own checkout or a protected branch: `main` is trivially
/// an ancestor of itself, and "your main checkout's work has landed" is a
/// sentence that would offer to delete the install you are working in.
fn landed(dir: &Path, base: &str, branch: Option<&str>, main: bool) -> Option<String> {
    if main {
        return None;
    }
    if branch.map(|b| crate::git::is_protected_branch(b, base)) == Some(true) {
        return None;
    }
    let merged = crate::process_capture::output(
        git(dir).args(["merge-base", "--is-ancestor", "HEAD", base]),
        crate::process_capture::DEFAULT_STREAM_MAX,
    )
    .map(|o| o.status.success())
    .unwrap_or(false);
    if merged {
        return Some(format!("already merged into {base}"));
    }
    // An upstream that was configured and no longer exists. `for-each-ref` on
    // the branch itself, so this reads the same config git push would.
    let b = branch?;
    let upstream = crate::process_capture::output(
        git(dir).args([
            "for-each-ref",
            "--format=%(upstream)",
            &format!("refs/heads/{b}"),
        ]),
        crate::process_capture::DEFAULT_STREAM_MAX,
    )
    .ok()
    .filter(|o| o.status.success())
    .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    .filter(|s| !s.is_empty())?;
    let gone = !crate::process_capture::output(
        git(dir).args(["rev-parse", "--verify", "--quiet", &upstream]),
        crate::process_capture::DEFAULT_STREAM_MAX,
    )
    .map(|o| o.status.success())
    .unwrap_or(false);
    gone.then(|| "its remote branch is gone — the work landed".to_string())
}

fn dirty_count(dir: &Path) -> u32 {
    crate::process_capture::output(
        git(dir).args(["status", "--porcelain"]),
        crate::process_capture::DEFAULT_STREAM_MAX,
    )
    .ok()
    .filter(|o| o.status.success())
    .map(|o| {
        String::from_utf8_lossy(&o.stdout)
            .lines()
            .filter(|l| !l.trim().is_empty())
            .count() as u32
    })
    .unwrap_or(0)
}

/// Which of these paths the repo ignores, in one process. The safety net under
/// the allowlist: a `dist/` somebody committed on purpose is tracked, so git
/// leaves it out of this answer and the scan drops it.
///
/// `check-ignore` exits 1 when nothing matched, which is an answer ("none of
/// them") and not an error — only a higher code is a failure, and then this
/// returns None so the caller can refuse the whole checkout rather than guess.
fn ignored_set(dir: &Path, paths: &[PathBuf]) -> Option<HashSet<PathBuf>> {
    use std::io::Write;
    use std::process::Stdio;
    if paths.is_empty() {
        return Some(HashSet::new());
    }
    let permit =
        crate::process_capture::acquire(crate::process_capture::DEFAULT_STREAM_MAX).ok()?;
    let mut child = git(dir)
        .args(["check-ignore", "--stdin", "-z"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    {
        let mut stdin = child.stdin.take()?;
        for p in paths {
            let _ = stdin.write_all(p.to_string_lossy().as_bytes());
            let _ = stdin.write_all(&[0]);
        }
    }
    let out = crate::process_capture::wait_with_capped_output(
        child,
        crate::process_capture::DEFAULT_STREAM_MAX,
        permit,
    )
    .ok()?;
    match out.status.code() {
        Some(0) | Some(1) => {}
        _ => return None,
    }
    Some(
        String::from_utf8_lossy(&out.stdout)
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(|s| {
                let p = PathBuf::from(s);
                if p.is_absolute() {
                    p
                } else {
                    dir.join(p)
                }
            })
            .collect(),
    )
}

/// Candidate artifact directories under one checkout. Stops at `stop_at` (the
/// other checkouts) so a worktree living inside the repo is scanned as itself
/// and never counted twice, and never descends into something it just matched.
fn candidates(root: &Path, stop_at: &[PathBuf], budget: &mut usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if depth >= MAX_DEPTH || *budget == 0 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            // Symlinked directories are somebody else's tree wearing a local
            // name. Never a candidate, never walked.
            if kind.is_symlink() || !kind.is_dir() {
                continue;
            }
            let path = entry.path();
            if stop_at.contains(&path) {
                continue;
            }
            if *budget == 0 {
                break;
            }
            *budget -= 1;
            if classify(&path).is_some() {
                found.push(path);
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if walkable(&name) {
                stack.push((path, depth + 1));
            }
        }
    }
    found.sort();
    found
}

/// The repo a directory belongs to, or None when it is in none.
fn toplevel(dir: &Path) -> Option<PathBuf> {
    crate::process_capture::output(
        git(dir).args(["rev-parse", "--show-toplevel"]),
        crate::process_capture::DEFAULT_STREAM_MAX,
    )
    .ok()
    .filter(|o| o.status.success())
    .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim().to_string()))
    .filter(|p| p.is_dir())
}

/// Repos sitting *inside* a folder that isn't itself one — the "folder of
/// projects" root, which Canopy allows and which would otherwise have all its
/// checkouts counted as one anonymous blob. Shallow on purpose: a repo nested
/// four levels down is somebody's dependency, not a project of theirs.
fn nested_repos(root: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() || !kind.is_dir() {
            continue;
        }
        let path = entry.path();
        if path.join(".git").exists() {
            out.push(path);
            // Its own worktrees come from git, not from walking further in.
            continue;
        }
        if walkable(&entry.file_name().to_string_lossy()) {
            nested_repos(&path, depth - 1, out);
        }
    }
}

/// Every checkout the open projects reach: each root's repo and that repo's
/// worktrees, any repos nested inside a root that isn't one, and the root itself
/// when it is not a checkout (so artifacts outside every repo still count).
///
/// A worktree parked outside the open projects is reported as skipped rather
/// than silently scanned — the registered roots are the only ground truth we
/// have for "the user meant this folder".
/// What `checkouts` collects: where it is, the branch in it, whether it is the
/// repo's own working tree, and the branch merges are measured against (absent
/// when the folder is not a checkout at all).
struct Checkout {
    path: PathBuf,
    branch: Option<String>,
    main: bool,
    base: Option<String>,
}

/// Every worktree of one repo, main first (git's own order), skipping the ones
/// that live outside the open projects.
fn add_repo(
    top: &Path,
    roots: &[PathBuf],
    out: &mut Vec<Checkout>,
    seen: &mut HashSet<PathBuf>,
    repos: &mut HashSet<PathBuf>,
    skipped: &mut Vec<String>,
) {
    if !repos.insert(top.to_path_buf()) {
        return;
    }
    // Once per repo, not once per worktree: it is up to four git processes and
    // every worktree of a repo has the same answer.
    let base = crate::git::default_base(top);
    for w in scan_worktrees(top).unwrap_or_default() {
        if w.bare {
            continue;
        }
        let path = PathBuf::from(&w.path);
        if w.prunable.is_some() || !path.is_dir() {
            continue;
        }
        if !under_any(&path, roots) {
            skipped.push(format!(
                "{} — a workspace of {} that lives outside your open projects",
                w.path,
                top.file_name().unwrap_or_default().to_string_lossy()
            ));
            continue;
        }
        if seen.insert(path.clone()) {
            out.push(Checkout {
                path,
                branch: w.branch.clone(),
                main: w.is_main,
                base: Some(base.clone()),
            });
        }
    }
}

fn checkouts(roots: &[PathBuf], skipped: &mut Vec<String>) -> Vec<Checkout> {
    let mut out: Vec<Checkout> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut repos: HashSet<PathBuf> = HashSet::new();

    for root in roots {
        // A root *inside* a repo (a component folder of a monorepo) still means
        // the repo: worktrees hang off the top, and so does .gitignore. A `top`
        // above every registered root is a repo the user has not opened, so it
        // is left alone and the root is treated as a plain folder.
        match toplevel(root).filter(|top| under_any(top, roots)) {
            Some(top) => add_repo(&top, roots, &mut out, &mut seen, &mut repos, skipped),
            None => {
                if seen.insert(root.clone()) {
                    out.push(Checkout {
                        path: root.clone(),
                        branch: None,
                        main: true,
                        base: None,
                    });
                }
                let mut nested = Vec::new();
                nested_repos(root, 3, &mut nested);
                for repo in nested {
                    let top = toplevel(&repo).unwrap_or(repo);
                    if under_any(&top, roots) {
                        add_repo(&top, roots, &mut out, &mut seen, &mut repos, skipped);
                    }
                }
            }
        }
    }
    out
}

/// Split the roots the dialog asked about into the ones this window may look at
/// and a note for each one it may not. `resolve` is the scope check, injected so
/// the rule can be tested without a `WorkspaceManager`.
fn in_scope_roots(
    roots: &[String],
    resolve: &dyn Fn(&str) -> Option<PathBuf>,
) -> (Vec<PathBuf>, Vec<String>) {
    let mut ok = Vec::new();
    let mut skipped = Vec::new();
    for r in roots {
        match resolve(r) {
            Some(p) => ok.push(p),
            None => skipped.push(format!(
                "{r} — not in this window's scope; a sleeping project releases \
                 its folders, so wake it to include it"
            )),
        }
    }
    (ok, skipped)
}

/// Scan the open projects for disposable directories.
///
/// `busy` is every cwd the frontend knows something live in (terminals, agents,
/// server runs) — unioned below with the process monitor's own last reading, so
/// the "nothing live is recommended" rule doesn't rest on the caller getting it
/// right. `asleep` is the roots of hibernating projects, which only the frontend
/// knows. Both only ever *remove* things from the default selection.
#[tauri::command]
pub async fn cleanup_scan(
    app: AppHandle,
    state: State<'_, WorkspaceManager>,
    roots: Vec<String>,
    busy: Vec<String>,
    asleep: Vec<String>,
) -> Result<CleanupScan, String> {
    // Scope-check while we still hold State, then hand owned paths to the
    // worker: this is minutes of `read_dir` on a big tree and must not sit on
    // the async runtime.
    //
    // A root can be out of scope while still being a folder of an open project:
    // a hibernating project releases its watchers and scopes — that is what
    // hibernating *is* — and its folders come back only when it wakes. Failing
    // the whole command on the first such root meant one sleeping project made
    // "Cleanup resources" show nothing but a scope error for every other
    // project. So an out-of-scope root is skipped and said out loud, the same
    // way the walk reports anywhere else it wouldn't look, and only a scan with
    // nothing left to look at is an error.
    let (resolved, mut out_of_scope) =
        in_scope_roots(&roots, &|r| check_scope(&state, Path::new(r)).ok());
    if resolved.is_empty() {
        return Err(if roots.is_empty() {
            "no project folders to scan".into()
        } else {
            // Every project asked about is asleep. Saying that beats "no project
            // folders", which reads as a bug when the tab strip is full.
            "nothing to scan — the open projects are all hibernating, and a \
             sleeping project keeps what it expects to wake up to"
                .to_string()
        });
    }
    // The frontend's `busy` is what it knows about; the monitor's last reading is
    // what is actually running. Union, because neither is a superset: a headless
    // portal PTY is in the monitor and not in the tab strip, and a run the
    // monitor hasn't ticked for yet is in the tab strip and not the monitor.
    // Over-reporting busy only ever un-ticks a row.
    let mut busy = busy;
    if let Some(cache) = app.try_state::<crate::agents::StatsCache>() {
        if let Ok(sessions) = cache.0.lock() {
            busy.extend(sessions.iter().map(|s| s.cwd.clone()));
        }
    }
    let mut out = tauri::async_runtime::spawn_blocking(move || {
        scan(&resolved, &busy, &asleep, &mut |p| {
            let _ = app.emit("cleanup:progress", p);
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    // First, ahead of the walk's own notes: "my project isn't in this list" is
    // the question these answer.
    out_of_scope.extend(std::mem::take(&mut out.skipped));
    out.skipped = out_of_scope;
    Ok(out)
}

/// The scan itself, with the app reduced to a progress callback — so the test
/// below can run the real thing (git processes, `read_dir`, sizing) against a
/// fixture repo instead of only the rules it is made of.
fn scan(
    roots: &[PathBuf],
    busy: &[String],
    asleep: &[String],
    progress: &mut dyn FnMut(ScanProgress),
) -> CleanupScan {
    let mut out = CleanupScan::default();
    // Canonical from here down. Git reports real paths (`/private/var/…` on
    // macOS, where `/var` is a symlink), so a root that isn't canonical makes
    // every "is this checkout inside the projects" check fail and the scan
    // quietly finds nothing. `check_scope` already canonicalizes in production;
    // this makes the function safe to call with anything.
    let roots: Vec<PathBuf> = roots
        .iter()
        .map(|r| r.canonicalize().unwrap_or_else(|_| r.clone()))
        .collect();
    let found = checkouts(&roots, &mut out.skipped);
    let all: Vec<PathBuf> = found.iter().map(|c| c.path.clone()).collect();
    let busy: Vec<PathBuf> = busy.iter().map(PathBuf::from).collect();
    let asleep: Vec<PathBuf> = asleep.iter().map(PathBuf::from).collect();
    let mut budget = DIR_BUDGET;
    let total = found.len();

    for (i, checkout) in found.iter().enumerate() {
        let path = &checkout.path;
        // Every other checkout is a wall: a worktree under `.claude/worktrees/`
        // belongs to itself, not to the repo it is nested in.
        let stop: Vec<PathBuf> = all.iter().filter(|p| *p != path).cloned().collect();
        let cands = candidates(path, &stop, &mut budget);
        let is_repo = checkout.base.is_some() || path.join(".git").exists();
        // Anything git tracks is somebody's work, whatever it is named.
        let cands = if is_repo {
            match ignored_set(path, &cands) {
                Some(ignored) => cands.into_iter().filter(|c| ignored.contains(c)).collect(),
                None => {
                    out.skipped.push(format!(
                        "{} — couldn't ask git what it ignores here",
                        path.display()
                    ));
                    Vec::new()
                }
            }
        } else {
            cands
        };

        let act = Activity {
            busy: busy.iter().any(|b| under(b, path)),
            asleep: asleep.iter().any(|a| under(path, a) || under(a, path)),
            dirty: if is_repo { dirty_count(path) } else { 0 },
            idle_days: if is_repo {
                last_commit_days(path)
            } else {
                None
            },
            landed: checkout
                .base
                .as_deref()
                .and_then(|base| landed(path, base, checkout.branch.as_deref(), checkout.main)),
        };

        let mut ws = CleanupWorkspace {
            path: path.to_string_lossy().to_string(),
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            branch: checkout.branch.clone(),
            main: checkout.main,
            dirty: act.dirty,
            busy: act.busy,
            asleep: act.asleep,
            idle_days: act.idle_days,
            landed: act.landed.clone(),
            bytes: 0,
            recommended_bytes: 0,
        };

        for cand in cands {
            let Some(artifact) = classify(&cand) else {
                continue;
            };
            let size = measure(&cand);
            // An empty artifact directory is noise in a list about disk.
            if size.bytes == 0 {
                continue;
            }
            let built = size.newest.map(days_since).unwrap_or(u32::MAX);
            let (recommended, hold) = verdict(&act, artifact.category, built);
            ws.bytes += size.bytes;
            if recommended {
                ws.recommended_bytes += size.bytes;
            }
            out.targets.push(CleanupTarget {
                rel: cand
                    .strip_prefix(path)
                    .unwrap_or(&cand)
                    .to_string_lossy()
                    .to_string(),
                path: cand.to_string_lossy().to_string(),
                name: artifact.name.to_string(),
                category: artifact.category.as_str(),
                bytes: size.bytes,
                files: size.files,
                idle_days: if built == u32::MAX { 0 } else { built },
                regenerate: artifact.regenerate.to_string(),
                workspace: ws.path.clone(),
                recommended,
                hold,
                partial: size.partial,
            });
        }

        out.bytes += ws.bytes;
        out.recommended_bytes += ws.recommended_bytes;
        out.workspaces.push(ws);
        progress(ScanProgress {
            workspace: path.to_string_lossy().to_string(),
            done: i + 1,
            total,
        });
    }

    out.truncated = budget == 0;
    // Biggest first within a workspace; the workspaces themselves keep git's
    // order (the repo's own checkout first) so the list doesn't reshuffle
    // between scans.
    out.targets
        .sort_by(|a, b| a.workspace.cmp(&b.workspace).then(b.bytes.cmp(&a.bytes)));
    out
}

// ---------------------------------------------------------------------------
// deleting

/// Everything that must still be true at delete time, checked again from
/// scratch. The scan's output is not a capability: the frontend could hand back
/// a path it never produced, and this is the gate that says no.
fn deletable(path: &Path, roots: &[PathBuf]) -> Result<(), String> {
    if !under_any(path, roots) {
        return Err("outside your open projects".into());
    }
    if classify(path).is_none() {
        return Err("not something a build can make again".into());
    }
    let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() {
        return Err("a symlink — the real directory is somewhere else".into());
    }
    if !meta.is_dir() {
        return Err("not a directory".into());
    }
    // A checkout root can carry an allowlisted name (a repo literally called
    // `dist`), and deleting one takes the working tree with it.
    if path.join(".git").exists() {
        return Err("a git checkout, not a build directory".into());
    }
    if roots.iter().any(|r| r == path) {
        return Err("one of your project folders".into());
    }
    Ok(())
}

/// Delete the chosen directories. `trash` is the default the dialog offers:
/// reversible, at the cost of the space only coming back when the Trash is
/// emptied — which the dialog says out loud, because a "cleanup" that appears to
/// free nothing is worse than one that asks.
#[tauri::command]
pub async fn cleanup_run(
    state: State<'_, WorkspaceManager>,
    paths: Vec<String>,
    trash: bool,
) -> Result<CleanupOutcome, String> {
    let mut resolved: Vec<PathBuf> = Vec::new();
    for p in &paths {
        resolved.push(check_scope(&state, Path::new(p))?);
    }
    let roots: Vec<PathBuf> = crate::fsx::roots_of(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = CleanupOutcome {
            trashed: trash,
            ..Default::default()
        };
        for path in resolved {
            if let Err(why) = deletable(&path, &roots) {
                out.refused.push(format!("{} — {why}", path.display()));
                continue;
            }
            // Measured before the delete, so the total reported is the total
            // actually reclaimed rather than the scan's older guess.
            let bytes = measure(&path).bytes;
            let result = if trash {
                trash::delete(&path).map_err(|e| e.to_string())
            } else {
                std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
            };
            match result {
                Ok(()) => {
                    out.removed.push(path.to_string_lossy().to_string());
                    out.bytes += bytes;
                }
                Err(e) => out.failed.push((path.to_string_lossy().to_string(), e)),
            }
        }
        out
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker_in<'a>(
        dirs: &'a [(&'static str, &'static str)],
    ) -> impl Fn(&Path, &str) -> bool + 'a {
        move |dir: &Path, marker: &str| {
            dirs.iter()
                .any(|(d, m)| Path::new(d) == dir && *m == marker)
        }
    }

    #[test]
    fn tail_match_spans_several_components() {
        assert!(tail_matches(Path::new("/a/b/node_modules"), "node_modules"));
        assert!(tail_matches(Path::new("/a/vendor/bundle"), "vendor/bundle"));
        // The whole tail must match, not just the last component.
        assert!(!tail_matches(Path::new("/a/other/bundle"), "vendor/bundle"));
        // A name is a whole component, never a prefix of one.
        assert!(!tail_matches(Path::new("/a/node_modules2"), "node_modules"));
    }

    #[test]
    fn an_artifact_needs_the_marker_that_explains_it() {
        // A Rust target/ is build output...
        let rust = marker_in(&[("/p", "Cargo.toml")]);
        let hit = classify_with(Path::new("/p/target"), &rust).expect("classified");
        assert_eq!(hit.category, Category::Build);
        assert_eq!(hit.regenerate, "cargo build");
        // ...and a target/ with nothing to explain it is somebody's source dir.
        let bare = marker_in(&[]);
        assert!(classify_with(Path::new("/p/target"), &bare).is_none());
    }

    #[test]
    fn the_marker_may_sit_one_level_above() {
        let ruby = marker_in(&[("/p", "Gemfile")]);
        let hit = classify_with(Path::new("/p/vendor/bundle"), &ruby).expect("classified");
        assert_eq!(hit.regenerate, "bundle install");
    }

    #[test]
    fn unambiguous_names_need_no_marker() {
        let none = marker_in(&[]);
        assert!(classify_with(Path::new("/p/src/__pycache__"), &none).is_some());
        assert!(classify_with(Path::new("/p/.mypy_cache"), &none).is_some());
    }

    #[test]
    fn nothing_outside_the_table_is_ever_a_candidate() {
        let node = marker_in(&[("/p", "package.json")]);
        for name in ["src", "assets", "public", "lib", "docs", ".env", "coverage"] {
            assert!(
                classify_with(&Path::new("/p").join(name), &node).is_none(),
                "{name} must not be classifiable"
            );
        }
    }

    #[test]
    fn the_walk_skips_hidden_dirs_but_not_the_ones_we_clean() {
        assert!(walkable("src"));
        assert!(walkable("packages"));
        assert!(!walkable(".git"));
        // Already matched as an artifact; descending into it would find nested
        // installs we are deleting anyway.
        assert!(!walkable("node_modules"));
        assert!(!walkable(".idea"));
        assert!(walkable(".next"));
        assert!(walkable(".venv"));
    }

    fn idle(days: u32) -> Activity {
        Activity {
            busy: false,
            asleep: false,
            dirty: 0,
            idle_days: Some(days),
            landed: None,
        }
    }

    #[test]
    fn a_live_workspace_is_never_recommended() {
        let act = Activity {
            busy: true,
            ..idle(400)
        };
        let (rec, hold) = verdict(&act, Category::Deps, 400);
        assert!(!rec);
        assert!(hold.unwrap().contains("live"));
    }

    #[test]
    fn hibernation_holds_everything_it_expects_back() {
        // The user's question answered in one rule: a sleeping project keeps its
        // installs, because the wake is a promise to come back as it was.
        let act = Activity {
            asleep: true,
            ..idle(400)
        };
        let (rec, hold) = verdict(&act, Category::Cache, 400);
        assert!(!rec);
        assert!(hold.unwrap().contains("hibernating"));
    }

    #[test]
    fn a_root_this_window_cannot_see_is_a_note_not_a_dead_dialog() {
        // A hibernating project is still an open project, and it holds no scope.
        // The scan looks at the rest and says which folders it left out; only a
        // scan with nothing at all to look at is an error (checked by the caller).
        let roots = vec![
            "/live/repo".to_string(),
            "/asleep/repo".to_string(),
            "/live/other".to_string(),
        ];
        let (ok, skipped) = in_scope_roots(&roots, &|r| {
            r.starts_with("/live").then(|| PathBuf::from(r))
        });
        assert_eq!(
            ok,
            vec![PathBuf::from("/live/repo"), PathBuf::from("/live/other")]
        );
        assert_eq!(skipped.len(), 1);
        assert!(skipped[0].starts_with("/asleep/repo — "));
        // The note has to name the way back, or it reads as a bug.
        assert!(skipped[0].contains("wake it"));
    }

    #[test]
    fn uncommitted_work_buys_ninety_days_not_thirty() {
        let dirty = Activity {
            dirty: 3,
            ..idle(60)
        };
        let (rec, hold) = verdict(&dirty, Category::Deps, 90);
        assert!(!rec);
        assert!(hold.unwrap().contains("3 uncommitted files"));
        // Past 90 the diff has stopped being work in progress.
        let stale = Activity {
            dirty: 3,
            ..idle(120)
        };
        assert!(verdict(&stale, Category::Deps, 200).0);
    }

    #[test]
    fn a_fresh_build_is_left_alone_however_old_the_branch_is() {
        let (rec, hold) = verdict(&idle(400), Category::Build, 0);
        assert!(!rec);
        assert_eq!(hold.as_deref(), Some("written today"));
        assert!(!verdict(&idle(400), Category::Build, 1).0);
        assert!(verdict(&idle(400), Category::Build, RECENT_BUILD_DAYS).0);
    }

    #[test]
    fn work_that_has_landed_is_offered_however_new_the_branch_is() {
        // The case this feature exists for: a worktree from a PR that merged two
        // days ago. Its branch is young, its build is fresh, and it is finished.
        let act = Activity {
            landed: Some("already merged into origin/main".into()),
            ..idle(2)
        };
        assert!(verdict(&act, Category::Deps, 0).0);
        assert_eq!(verdict(&act, Category::Deps, 0).1, None);
        // But not while something is running in it, or it is holding a diff.
        let busy = Activity {
            busy: true,
            ..Activity {
                landed: Some("already merged into origin/main".into()),
                ..idle(2)
            }
        };
        assert!(!verdict(&busy, Category::Deps, 0).0);
        let dirty = Activity {
            dirty: 1,
            ..Activity {
                landed: Some("already merged into origin/main".into()),
                ..idle(2)
            }
        };
        assert!(!verdict(&dirty, Category::Deps, 0).0);
    }

    #[test]
    fn caches_go_without_waiting_for_the_month() {
        assert!(verdict(&idle(1), Category::Cache, 10).0);
        // An install is a download, so it waits for the idle month.
        let (rec, hold) = verdict(&idle(1), Category::Deps, 10);
        assert!(!rec);
        assert_eq!(hold.as_deref(), Some("last commit 1 day ago"));
    }

    #[test]
    fn an_idle_month_is_the_line_for_installs_and_builds() {
        assert!(!verdict(&idle(IDLE_DAYS - 1), Category::Deps, 40).0);
        assert!(verdict(&idle(IDLE_DAYS), Category::Deps, 40).0);
        assert!(verdict(&idle(IDLE_DAYS), Category::Build, 40).0);
    }

    #[test]
    fn a_folder_with_no_git_history_is_never_auto_selected() {
        let act = Activity {
            busy: false,
            asleep: false,
            dirty: 0,
            idle_days: None,
            landed: None,
        };
        let (rec, hold) = verdict(&act, Category::Deps, 500);
        assert!(!rec);
        assert!(hold.unwrap().contains("no history"));
    }

    #[test]
    fn delete_refuses_everything_the_scan_would_not_have_produced() {
        let tmp = std::env::temp_dir().join(format!("canopy-cleanup-{}", std::process::id()));
        let project = tmp.join("proj");
        std::fs::create_dir_all(project.join("node_modules/pkg")).unwrap();
        std::fs::write(project.join("package.json"), "{}").unwrap();
        std::fs::create_dir_all(project.join("src")).unwrap();
        let roots = vec![tmp.clone()];

        // The real thing passes.
        assert!(deletable(&project.join("node_modules"), &roots).is_ok());
        // Source is not on the table.
        assert!(deletable(&project.join("src"), &roots).is_err());
        // Nor is anything outside the registered roots, allowlisted or not.
        assert!(deletable(Path::new("/tmp/elsewhere/node_modules"), &roots).is_err());
        // Nor a project folder itself.
        assert!(deletable(&project, &roots).is_err());
        // A checkout that happens to be named `dist` keeps its working tree.
        let repo = tmp.join("dist");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::write(tmp.join("package.json"), "{}").unwrap();
        assert!(deletable(&repo, &roots).is_err());

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn measure_counts_files_and_never_follows_a_link_out() {
        let tmp = std::env::temp_dir().join(format!("canopy-measure-{}", std::process::id()));
        let dir = tmp.join("node_modules");
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::write(dir.join("a/one"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("a/two"), vec![0u8; 50]).unwrap();
        let outside = tmp.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("big"), vec![0u8; 10_000]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, dir.join("linked")).unwrap();

        let size = measure(&dir);
        assert_eq!(size.files, 2);
        assert_eq!(size.bytes, 150);
        assert!(!size.partial);
        assert!(size.newest.is_some());

        std::fs::remove_dir_all(&tmp).ok();
    }

    /// The whole scan against a real repo with a real worktree — git processes,
    /// `read_dir`, sizing and all. The rule tests above cover the reasoning; this
    /// covers the wiring, which is where a cleanup tool does its damage.
    #[test]
    fn the_scan_finds_ignored_installs_per_checkout_and_leaves_tracked_dirs_alone() {
        let tmp = std::env::temp_dir().join(format!("canopy-scan-{}", std::process::id()));
        std::fs::remove_dir_all(&tmp).ok();
        std::fs::create_dir_all(&tmp).unwrap();
        // Canonical, because git reports real paths and this must look like the
        // roots the app registers (which are canonicalized too).
        let tmp = tmp.canonicalize().unwrap();
        let repo = tmp.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let run = |dir: &Path, args: &[&str]| {
            let out = git(dir).args(args).output().expect("git runs");
            assert!(out.status.success(), "git {args:?}: {:?}", out.status);
        };
        run(&repo, &["init", "-q", "-b", "main"]);
        run(&repo, &["config", "user.email", "t@example.com"]);
        run(&repo, &["config", "user.name", "T"]);
        std::fs::write(repo.join("package.json"), "{}").unwrap();
        std::fs::write(repo.join(".gitignore"), "node_modules/\n").unwrap();
        // A `dist/` somebody committed on purpose: allowlisted by name, tracked
        // by git, and therefore never a candidate.
        std::fs::create_dir_all(repo.join("dist")).unwrap();
        std::fs::write(repo.join("dist/committed.js"), vec![0u8; 2048]).unwrap();
        run(&repo, &["add", "-A"]);
        run(&repo, &["commit", "-qm", "init"]);
        // The install, ignored — the thing we are here for.
        std::fs::create_dir_all(repo.join("node_modules/pkg")).unwrap();
        std::fs::write(repo.join("node_modules/pkg/index.js"), vec![0u8; 4096]).unwrap();

        // Two linked worktrees with installs of their own, exactly the shape
        // parallel agents leave behind. `side` has nothing of its own on top of
        // main — the state of a worktree whose PR has merged. `wip` has a commit
        // main doesn't, so it is unfinished work.
        let wt = repo.join(".claude/worktrees/side");
        run(
            &repo,
            &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()],
        );
        std::fs::create_dir_all(wt.join("node_modules/pkg")).unwrap();
        std::fs::write(wt.join("node_modules/pkg/index.js"), vec![0u8; 8192]).unwrap();

        let wip = repo.join(".claude/worktrees/wip");
        run(
            &repo,
            &["worktree", "add", "-q", "-b", "wip", wip.to_str().unwrap()],
        );
        std::fs::write(wip.join("new.txt"), "work").unwrap();
        run(&wip, &["add", "-A"]);
        run(&wip, &["commit", "-qm", "wip"]);
        std::fs::create_dir_all(wip.join("node_modules/pkg")).unwrap();
        std::fs::write(wip.join("node_modules/pkg/index.js"), vec![0u8; 16384]).unwrap();

        let mut seen: Vec<usize> = Vec::new();
        // The repo's own checkout is busy; the worktree is not.
        let scanned = scan(
            std::slice::from_ref(&tmp),
            &[repo.to_string_lossy().to_string()],
            &[],
            &mut |p| seen.push(p.done),
        );

        let paths: Vec<&str> = scanned.targets.iter().map(|t| t.path.as_str()).collect();
        assert!(paths.contains(&repo.join("node_modules").to_string_lossy().as_ref()));
        assert!(paths.contains(&wt.join("node_modules").to_string_lossy().as_ref()));
        assert!(paths.contains(&wip.join("node_modules").to_string_lossy().as_ref()));
        // Tracked, so never offered — the safety net under the allowlist.
        assert!(!paths.iter().any(|p| p.ends_with("/dist")));
        assert_eq!(scanned.targets.len(), 3);

        // Each install is attributed to the checkout it is in, and only the
        // finished one is recommended.
        let own = scanned
            .targets
            .iter()
            .find(|t| t.workspace == repo.to_string_lossy())
            .expect("the repo's own install");
        let side = scanned
            .targets
            .iter()
            .find(|t| t.workspace == wt.to_string_lossy())
            .expect("the merged worktree's install");
        let unfinished = scanned
            .targets
            .iter()
            .find(|t| t.workspace == wip.to_string_lossy())
            .expect("the unmerged worktree's install");
        assert_eq!(own.bytes, 4096);
        assert_eq!(side.bytes, 8192);
        assert_eq!(unfinished.bytes, 16_384);
        assert!(!own.recommended, "a busy checkout is never recommended");
        assert!(own.hold.as_deref().unwrap_or_default().contains("live"));
        // Merged, nothing running, nothing uncommitted: offered, even though the
        // install was written seconds ago.
        assert!(side.recommended, "a merged worktree's install is offered");
        assert_eq!(side.hold, None);
        // The unmerged one is held by its own freshness, which is the honest
        // answer for a build made seconds ago on work that hasn't landed.
        assert!(!unfinished.recommended);
        assert_eq!(unfinished.hold.as_deref(), Some("written today"));
        assert_eq!(scanned.bytes, 28_672);
        assert_eq!(scanned.recommended_bytes, 8192);

        // Four checkouts reported progress in order: the folder the roots name
        // (which is not a repo, and holds nothing of its own), the repo, and its
        // two worktrees.
        assert_eq!(seen, vec![1, 2, 3, 4]);
        assert_eq!(scanned.workspaces.len(), 4);
        let outer = scanned
            .workspaces
            .iter()
            .find(|w| w.path == tmp.to_string_lossy())
            .expect("the plain folder is a workspace of its own");
        assert_eq!(outer.bytes, 0);
        assert_eq!(outer.idle_days, None);

        let ws = scanned
            .workspaces
            .iter()
            .find(|w| w.path == wt.to_string_lossy())
            .expect("the worktree is a workspace of its own");
        assert_eq!(ws.branch.as_deref(), Some("side"));
        assert!(!ws.main);
        // The reason it is offered, in the words the row shows.
        assert_eq!(ws.landed.as_deref(), Some("already merged into main"));
        let held = scanned
            .workspaces
            .iter()
            .find(|w| w.path == wip.to_string_lossy())
            .expect("the unmerged worktree");
        assert_eq!(held.landed, None);

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn candidates_stop_at_other_checkouts_and_inside_a_match() {
        let tmp = std::env::temp_dir().join(format!("canopy-cands-{}", std::process::id()));
        let repo = tmp.join("repo");
        std::fs::create_dir_all(repo.join("node_modules/nested/node_modules")).unwrap();
        std::fs::write(repo.join("package.json"), "{}").unwrap();
        std::fs::write(repo.join("node_modules/nested/package.json"), "{}").unwrap();
        // A worktree living inside the repo, with an install of its own.
        let wt = repo.join(".claude/worktrees/other");
        std::fs::create_dir_all(wt.join("node_modules")).unwrap();
        std::fs::write(wt.join("package.json"), "{}").unwrap();

        let mut budget = 10_000;
        let found = candidates(&repo, std::slice::from_ref(&wt), &mut budget);
        assert_eq!(found, vec![repo.join("node_modules")]);

        // Scanned as itself, it finds its own.
        let mut budget = 10_000;
        let own = candidates(&wt, &[], &mut budget);
        assert_eq!(own, vec![wt.join("node_modules")]);

        std::fs::remove_dir_all(&tmp).ok();
    }
}

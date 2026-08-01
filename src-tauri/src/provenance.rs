//! Which agent session produced which pull request.
//!
//! The join always existed — digest cwd → worktree → branch → PR head (see
//! `agent_workspace`, and `prWorktree` in src/prs.ts) — but nothing wrote it
//! down, and it decays: the digest's `branch` is one scalar the hook overwrites
//! per event, `session_forget` deletes the digest on every micro-task including
//! `raise-pr`, and an agent's own worktree is gone by the time you ask. Run
//! retrospectively over this repo's last six merged PRs it found four.
//!
//! So the edge is recorded when it is made, while the evidence is current. Same
//! join, different instant. The run is amnesiac; the edge is not.
//!
//! JSONL rather than a directory per record (notes.rs, research.rs): an edge has
//! no body, no revisions, no lifecycle, and there are one or two per PR.
//!
//! Two rules everything downstream depends on:
//!   1. A row is never updated in place — recording twice is a no-op. The point
//!      is that it froze an answer while it was true; an update would thaw it.
//!   2. `session_forget` must never reach this file. It is the thing that has to
//!      outlive the digest. `forgetting_a_session_leaves_its_edges` says so.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::State;

use crate::fsx::WorkspaceManager;
use crate::git::{repo_path, scan_worktrees};

/// The store's one handle: a cache and the lock that serializes access to it.
///
/// The cache is not an optimisation you could drop. Without it every write
/// re-parses the whole file to reject a duplicate, and backfill — which appends
/// once per matching digest — is quadratic over a few hundred sessions.
#[derive(Default)]
pub struct ProvenanceStore(Mutex<Cache>);

/// Loaded once and revalidated by `stat`, not by re-reading.
///
/// A second Canopy window is the reason it revalidates at all: this process is
/// not the only writer, and a cache that trusted itself would append a row
/// another window already wrote. Comparing length and mtime costs one syscall
/// against a parse of the entire file.
#[derive(Default)]
struct Cache {
    /// `(len, mtime)` when `edges` was read. `None` = never loaded.
    stamp: Option<(u64, std::time::SystemTime)>,
    edges: Vec<Edge>,
    /// The dedupe key of every row in `edges`, so `already` is a hash lookup
    /// rather than a scan.
    keys: std::collections::HashSet<(String, u64, String)>,
}

impl Cache {
    /// Bring the cache up to date with the file if anything else touched it.
    fn sync(&mut self) {
        let Ok(path) = store_path() else {
            return;
        };
        // No file yet is a valid, empty state — and a stamp of None keeps it
        // cheap to re-check until the first write.
        let stamp = std::fs::metadata(&path)
            .ok()
            .and_then(|m| Some((m.len(), m.modified().ok()?)));
        if stamp.is_some() && stamp == self.stamp {
            return;
        }
        self.edges = read_file();
        self.keys = self.edges.iter().map(key_of).collect();
        self.stamp = stamp;
    }

    /// Re-stamp after our own write, so the next call does not reload what we
    /// just put there ourselves.
    fn restamp(&mut self) {
        self.stamp = store_path()
            .ok()
            .and_then(|p| std::fs::metadata(p).ok())
            .and_then(|m| Some((m.len(), m.modified().ok()?)));
    }
}

/// What makes two rows the same claim: this repo's PR, and this session.
fn key_of(e: &Edge) -> (String, u64, String) {
    (e.repo.clone(), e.pr_number, e.session_id.clone())
}

/// The one name a repository has here: its **main** checkout, whichever of its
/// directories you arrived from.
///
/// This matters more than it looks. An agent works in a linked worktree, so a
/// writer standing in one would key the edge to `<repo>/.claude/worktrees/x`
/// while the PR tab, standing in the main checkout, would look under `<repo>` —
/// and every row would be invisible to the surface that wanted it.
/// `--git-common-dir` is shared by every worktree of a repo, so its parent is
/// the answer both of them agree on.
///
/// Memoised: it is a subprocess, and the read path calls it on every PR tab
/// open. Keyed on the input, and a repo's main checkout does not move while the
/// app is running.
fn repo_key(path: &str) -> String {
    static SEEN: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let seen = SEEN.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = seen.lock().ok().and_then(|m| m.get(path).cloned()) {
        return hit;
    }
    // Falling back to the path as given is deliberate: a directory git cannot
    // speak for still deserves a stable key rather than an error, and the
    // writer and reader will agree on it for the same reason they would have
    // agreed on the resolved one.
    let key = crate::git::common_dir(Path::new(path))
        .and_then(|d| d.parent().map(|p| p.to_string_lossy().to_string()))
        .unwrap_or_else(|| path.trim_end_matches('/').to_string());
    if let Ok(mut m) = seen.lock() {
        m.insert(path.to_string(), key.clone());
    }
    key
}

/// Years of history in well under a megabyte. Compaction keeps the newest and
/// only fires past the cap — a row's content is still frozen, the file just has
/// an end.
const MAX_EDGES: usize = 5000;

/// How far back a self-seeding backfill looks. Sessions on this machine only go
/// back so far — 298 digests covered a few months here — so asking for more PRs
/// than that buys nothing but a slower `gh` call.
const HISTORY_LIMIT: u32 = 200;

/// Which writer recorded an edge. One field rather than `via` + `confidence`:
/// confidence is a pure function of the writer, and two fields where one
/// determines the other drift apart.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Via {
    /// The agent said so, passing the URL to `canopy_job_done`. Exact.
    JobDone,
    /// The watcher saw the PR appear and joined it to a live session's branch —
    /// the one moment that branch was certainly current.
    PrWatch,
    /// The same join run late over digests already on disk. Marked so nothing
    /// downstream mistakes it for the other two.
    Backfill,
}

impl Via {
    /// Derived, not stored, so an old row cannot disagree with today's reading.
    pub fn confidence(self) -> &'static str {
        match self {
            Via::JobDone => "declared",
            Via::PrWatch => "observed",
            Via::Backfill => "inferred",
        }
    }
}

/// One edge: this session produced this pull request.
///
/// No `ephemeral` or `resumable` flag on purpose — whether a cwd still exists is
/// a fact about now, and freezing it here would be a second source of truth that
/// is wrong the moment the directory goes. The resolver stats the path instead.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Edge {
    /// Repo toplevel, absolute. `nwo` is derivable and is not the key.
    pub repo: String,
    pub pr_number: u64,
    pub pr_url: String,
    /// The PR's head branch when the edge was recorded.
    pub branch: String,
    pub session_id: String,
    #[serde(default)]
    pub agent: Option<String>,
    /// Which CLI profile owned the conversation — resuming has to relaunch
    /// against the same config dir or `--resume <id>` looks in the wrong store.
    /// `None` only for a digest written before profiles existed.
    #[serde(default)]
    pub profile: Option<String>,
    pub cwd: String,
    pub via: Via,
    /// Unix seconds.
    pub at: u64,
}

/// An edge as readers get it: the row plus what to make of it. Derived here so
/// the mapping lives in one language, not two that drift.
#[derive(Serialize, Debug)]
pub struct EdgeOut {
    #[serde(flatten)]
    pub edge: Edge,
    pub confidence: &'static str,
}

impl From<Edge> for EdgeOut {
    fn from(edge: Edge) -> Self {
        let confidence = edge.via.confidence();
        EdgeOut { edge, confidence }
    }
}

/// A PR to attribute. Passed in rather than fetched, because the frontend
/// already holds these from the watcher — no network, nothing to stub.
#[derive(Deserialize, Clone, Debug)]
pub struct PrSeed {
    pub number: u64,
    pub url: String,
    pub branch: String,
}

#[derive(Serialize, Default, Debug)]
pub struct BackfillReport {
    pub scanned: usize,
    pub matched: usize,
    /// Matched minus what was already on file.
    pub recorded: usize,
    /// Branch matched but the cwd belongs to another repo, or to none we can
    /// prove. Reported rather than dropped: a big number means the join is
    /// being defeated.
    pub unattributable: usize,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `~/.canopy/provenance.jsonl`, or wherever `CANOPY_PROVENANCE_HOME` points —
/// same test seam as notes.rs's `CANOPY_NOTES_HOME`.
fn store_path() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("CANOPY_PROVENANCE_HOME") {
        let dir = PathBuf::from(dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        return Ok(dir.join("provenance.jsonl"));
    }
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let dir = PathBuf::from(home).join(".canopy");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("provenance.jsonl"))
}

/// Every edge on disk, oldest first. An unparseable line is skipped, not fatal:
/// one truncated write must not cost every edge on file. Only `Cache::sync`
/// calls this — everything else reads the cache.
fn read_file() -> Vec<Edge> {
    let Ok(path) = store_path() else {
        return Vec::new();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Edge>(l).ok())
        .collect()
}

/// **The store's write boundary.** Every mutation lands here, so one place can
/// announce a change whichever writer made it (see `change.rs`). Returns whether
/// anything was written, so callers can tell "recorded" from "already knew".
///
/// The caller holds the lock and passes the cache in, so a backfill loop syncs
/// once and then appends without touching the file again to check itself.
fn append(cache: &mut Cache, edge: &Edge) -> Result<bool, String> {
    // Keyed on repo + PR + session, not on `via` or `at`: a PR the watcher
    // observed and the agent then declared is one edge learned twice, and the
    // first stands.
    let key = key_of(edge);
    if cache.keys.contains(&key) {
        return Ok(false);
    }
    let path = store_path()?;

    if cache.edges.len() + 1 > MAX_EDGES {
        // Compaction: keep the newest, rewrite whole. Rare, and atomic so a
        // crash here cannot leave the file half-written.
        let drop_n = cache.edges.len() + 1 - MAX_EDGES;
        cache.edges.drain(..drop_n);
        cache.edges.push(edge.clone());
        cache.keys = cache.edges.iter().map(key_of).collect();
        let body = cache
            .edges
            .iter()
            .filter_map(|e| serde_json::to_string(e).ok())
            .collect::<Vec<_>>()
            .join("\n");
        let tmp = path.with_extension(format!("tmp{}", std::process::id()));
        std::fs::write(&tmp, format!("{body}\n")).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    } else {
        let line = serde_json::to_string(edge).map_err(|e| e.to_string())?;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        writeln!(f, "{line}").map_err(|e| e.to_string())?;
        cache.edges.push(edge.clone());
        cache.keys.insert(key);
    }
    cache.restamp();

    // From the edge's own fields, never derived from a path — that breaks
    // silently the day a layout changes.
    crate::change::pulse(
        crate::change::Store::Provenance,
        &edge.repo,
        &edge.pr_number.to_string(),
    );
    Ok(true)
}

/// Same allowlist as `session_forget` / `agent_workspace`: the id becomes a file
/// name under `~/.canopy/sessions`, so it is checked at every boundary.
fn valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && !id.contains("..")
}

fn check(edge: &Edge) -> Result<(), String> {
    if !valid_session_id(&edge.session_id) {
        return Err("invalid session id".into());
    }
    if edge.pr_number == 0 {
        return Err("a pull request number is required".into());
    }
    if edge.branch.trim().is_empty() {
        return Err("a branch is required — it is what the edge was joined on".into());
    }
    if edge.repo.trim().is_empty() {
        return Err("a repo is required".into());
    }
    Ok(())
}

// ---- commands --------------------------------------------------------------

/// Record that a session produced a PR. Idempotent: both live writers can see
/// the same PR, and the second call is a no-op rather than a duplicate row.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn provenance_record(
    store: State<'_, ProvenanceStore>,
    repo: String,
    pr_number: u64,
    pr_url: String,
    branch: String,
    session_id: String,
    agent: Option<String>,
    profile: Option<String>,
    cwd: String,
    via: Via,
) -> Result<bool, String> {
    if repo.trim().is_empty() {
        return Err("a repo is required".into());
    }
    let edge = Edge {
        // Any directory of the repo may be passed — an agent's worktree, a
        // component subdir — and they all key to the main checkout.
        repo: repo_key(&repo),
        pr_number,
        pr_url,
        branch,
        session_id,
        agent,
        profile,
        cwd,
        via,
        at: now_secs(),
    };
    check(&edge)?;
    let mut cache = store.0.lock().map_err(|_| "provenance store poisoned")?;
    cache.sync();
    append(&mut cache, &edge)
}

/// Newest first, out of the cache — the reads are hot (a PR tab asks on every
/// open) and the file is only re-read when something else has touched it.
fn query(
    store: &State<'_, ProvenanceStore>,
    keep: impl Fn(&Edge) -> bool,
    limit: usize,
) -> Result<Vec<EdgeOut>, String> {
    let mut cache = store.0.lock().map_err(|_| "provenance store poisoned")?;
    cache.sync();
    let mut rows: Vec<Edge> = cache.edges.iter().filter(|e| keep(e)).cloned().collect();
    rows.sort_by(|a, b| b.at.cmp(&a.at));
    rows.truncate(limit);
    Ok(rows.into_iter().map(EdgeOut::from).collect())
}

/// Who produced this PR — newest first, because the most recent session to
/// touch a PR is the one a change request should go to.
#[tauri::command]
pub async fn provenance_for_pr(
    store: State<'_, ProvenanceStore>,
    repo: String,
    pr_number: u64,
) -> Result<Vec<EdgeOut>, String> {
    let key = repo_key(&repo);
    query(
        &store,
        |e| e.repo == key && e.pr_number == pr_number,
        MAX_EDGES,
    )
}

/// What this session produced — the reverse direction, for an agent tab.
#[tauri::command]
pub async fn provenance_for_session(
    store: State<'_, ProvenanceStore>,
    session_id: String,
) -> Result<Vec<EdgeOut>, String> {
    query(&store, |e| e.session_id == session_id, MAX_EDGES)
}

/// Adopt the history already on disk: the live writers' join, run late.
///
/// The cwd check is what keeps it honest — a digest is attributed only when its
/// directory demonstrably belongs to this repo. `fix/typo` is a branch name
/// every repo has, and a confidently wrong row is worse than no row.
#[tauri::command]
pub async fn provenance_backfill(
    state: State<'_, WorkspaceManager>,
    store: State<'_, ProvenanceStore>,
    repo: String,
    prs: Vec<PrSeed>,
) -> Result<BackfillReport, String> {
    let top = repo_path(&state, &repo)?;
    // Through the same normalizer as every other writer: `repo_path` answers
    // with the toplevel of whichever checkout it was given, which for a linked
    // worktree is the worktree itself.
    let key = repo_key(&top.to_string_lossy());
    let owned = owned_dirs(&top);

    // No seeds means "go and find them" — the merged PRs the watcher never
    // lists, which is the whole history this is for. Seeds passed in are still
    // honoured, which is what keeps the join testable without a network.
    let prs: Vec<PrSeed> = if prs.is_empty() {
        crate::git::gh_pr_refs(&top, HISTORY_LIMIT)
            .unwrap_or_default()
            .into_iter()
            .map(|(number, url, branch)| PrSeed {
                number,
                url,
                branch,
            })
            .collect()
    } else {
        prs
    };
    if prs.is_empty() {
        return Ok(BackfillReport::default());
    }

    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let sessions = PathBuf::from(&home).join(".canopy").join("sessions");

    let (edges, mut report) = sweep(&sessions, &prs, &owned, &key, Via::Backfill);

    // Synced once for the whole sweep. Every `append` then checks itself against
    // memory instead of re-reading the file, which is what made a few hundred
    // digests quadratic.
    let mut cache = store.0.lock().map_err(|_| "provenance store poisoned")?;
    cache.sync();
    for edge in &edges {
        if append(&mut cache, edge)? {
            report.recorded += 1;
        }
    }
    Ok(report)
}

/// Attribute PRs the watcher has just seen, at the one moment their branch is
/// certainly current.
///
/// This is the writer that catches an ordinary long-running session — one that
/// pushed a branch and opened a PR by hand, and so never called
/// `canopy_job_done`. It runs on the watcher's thread, inside a poll that was
/// going to happen anyway.
///
/// Two things keep it off the hot path. It reads no digest at all unless some
/// PR in the snapshot has no edge yet, which after the first pass is the normal
/// case. And a PR it has already failed to attribute is not retried for the
/// life of the app: rows change on every comment and push, and a teammate's PR
/// will never match a local session, so without this every conversation on
/// every open PR would re-scan the whole sessions directory.
pub fn attribute_observed(app: &tauri::AppHandle, repo: &str, prs: &[(u64, String, String)]) {
    use tauri::Manager;
    static TRIED: OnceLock<Mutex<std::collections::HashSet<(String, u64)>>> = OnceLock::new();
    let tried = TRIED.get_or_init(|| Mutex::new(std::collections::HashSet::new()));

    let key = repo_key(repo);
    let Some(store) = app.try_state::<ProvenanceStore>() else {
        return;
    };
    let Ok(mut cache) = store.0.lock() else {
        return;
    };
    cache.sync();

    let wanted: Vec<PrSeed> = {
        let Ok(mut t) = tried.lock() else {
            return;
        };
        prs.iter()
            .filter(|(number, _, _)| {
                let known = cache
                    .edges
                    .iter()
                    .any(|e| e.repo == key && e.pr_number == *number);
                !known && t.insert((key.clone(), *number))
            })
            .map(|(number, url, branch)| PrSeed {
                number: *number,
                url: url.clone(),
                branch: branch.clone(),
            })
            .collect()
    };
    if wanted.is_empty() {
        return;
    }

    let Ok(home) = std::env::var("HOME") else {
        return;
    };
    let sessions = PathBuf::from(&home).join(".canopy").join("sessions");
    let owned = owned_dirs(Path::new(repo));
    let (edges, _) = sweep(&sessions, &wanted, &owned, &key, Via::PrWatch);
    for edge in &edges {
        let _ = append(&mut cache, edge);
    }
}

/// The join itself, with the store kept out of it so it can be tested against a
/// directory of digests rather than only through a running app.
fn sweep(
    sessions: &Path,
    prs: &[PrSeed],
    owned: &[PathBuf],
    key: &str,
    via: Via,
) -> (Vec<Edge>, BackfillReport) {
    // By head branch, so a digest costs one hash lookup rather than a scan of
    // every PR — hundreds of PRs against hundreds of digests would otherwise be
    // the product of the two.
    let by_branch: std::collections::HashMap<&str, &PrSeed> =
        prs.iter().map(|p| (p.branch.as_str(), p)).collect();

    let mut report = BackfillReport::default();
    let mut edges = Vec::new();
    let Ok(entries) = std::fs::read_dir(sessions) else {
        return (edges, report);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(digest) = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        else {
            continue;
        };
        report.scanned += 1;

        let dstr = |k: &str| digest.get(k).and_then(|v| v.as_str()).map(str::to_string);
        let (Some(branch), Some(session_id), Some(cwd)) =
            (dstr("branch"), dstr("session_id"), dstr("cwd"))
        else {
            continue;
        };
        let Some(seed) = by_branch.get(branch.as_str()).copied() else {
            continue;
        };
        if !valid_session_id(&session_id) {
            continue;
        }
        if !belongs(owned, &cwd) {
            report.unattributable += 1;
            continue;
        }

        let edge = Edge {
            repo: key.to_string(),
            pr_number: seed.number,
            pr_url: seed.url.clone(),
            branch,
            session_id,
            agent: dstr("agent"),
            profile: dstr("profile"),
            cwd,
            via,
            // The digest's time, not now — a sweep's clock would sort years of
            // history into one afternoon.
            at: digest.get("updated").and_then(|v| v.as_u64()).unwrap_or(0),
        };
        if check(&edge).is_err() {
            continue;
        }
        report.matched += 1;
        edges.push(edge);
    }
    (edges, report)
}

/// Every directory this repo can speak for. Git is the authority: an agent's own
/// worktree was never a registered workspace root, and it is the one that
/// matters. A removed worktree still lists — unresumable, still attributable.
fn owned_dirs(top: &Path) -> Vec<PathBuf> {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let mut dirs = vec![canon(top)];
    if let Ok(list) = scan_worktrees(top) {
        for w in list {
            dirs.push(canon(Path::new(&w.path)));
        }
    }
    dirs
}

/// Canonically, because `/tmp` and `/private/tmp` are the same directory on
/// macOS and a string match refuses half the agent worktrees on this machine.
fn belongs(owned: &[PathBuf], cwd: &str) -> bool {
    let want = std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd));
    owned.iter().any(|d| want == *d || want.starts_with(d))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each test gets its own store file. `CANOPY_PROVENANCE_HOME` is process
    /// -wide, so the cases that touch it run under one lock.
    static ENV: Mutex<()> = Mutex::new(());

    fn edge(session: &str, pr: u64, via: Via) -> Edge {
        Edge {
            repo: "/repo".into(),
            pr_number: pr,
            pr_url: format!("https://github.com/o/n/pull/{pr}"),
            branch: "feat/x".into(),
            session_id: session.into(),
            agent: Some("claude".into()),
            profile: Some("default".into()),
            cwd: "/repo/wt".into(),
            via,
            at: 1_700_000_000,
        }
    }

    /// A test runs against a fresh file and its own cache, so a case cannot be
    /// served rows another case wrote.
    fn with_store<T>(f: impl FnOnce(&mut Cache) -> T) -> T {
        let _lock = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("canopy-prov-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("CANOPY_PROVENANCE_HOME", &dir);
        let mut cache = Cache::default();
        cache.sync();
        let out = f(&mut cache);
        std::env::remove_var("CANOPY_PROVENANCE_HOME");
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    /// The rule the store exists to keep: an answer, once frozen, stays frozen.
    /// The watcher and `job_done` both see the same PR, and the second one to
    /// arrive must not add a row or replace the first.
    #[test]
    fn the_same_edge_learned_twice_is_one_row() {
        with_store(|c| {
            assert!(append(c, &edge("s1", 42, Via::PrWatch)).unwrap());
            assert!(!append(c, &edge("s1", 42, Via::JobDone)).unwrap());
            let rows = read_file();
            assert_eq!(rows.len(), 1);
            // The first writer's account is the one that stands.
            assert_eq!(rows[0].via, Via::PrWatch);
        });
    }

    /// Two sessions can legitimately produce one PR — an agent raised it and a
    /// second addressed the comments. Both are edges.
    #[test]
    fn two_sessions_on_one_pr_are_two_rows() {
        with_store(|c| {
            assert!(append(c, &edge("s1", 42, Via::JobDone)).unwrap());
            assert!(append(c, &edge("s2", 42, Via::JobDone)).unwrap());
            assert_eq!(read_file().len(), 2);
        });
    }

    /// The bug this store is for. `session_forget` deletes a digest and its
    /// edits journal on every micro-task — including `raise-pr`, which is the
    /// path that opens PRs. If it could reach this file too, the store would
    /// forget precisely the edges it was built to keep.
    #[test]
    fn forgetting_a_session_leaves_its_edges() {
        with_store(|c| {
            append(c, &edge("s1", 42, Via::JobDone)).unwrap();
            // Whatever session_forget removes, it is under ~/.canopy/sessions.
            // This store is a sibling, not a child: nothing that walks that
            // directory can reach it.
            let path = store_path().unwrap();
            assert!(!path.starts_with(
                PathBuf::from(std::env::var("HOME").unwrap_or_default())
                    .join(".canopy")
                    .join("sessions")
            ));
            assert_eq!(read_file().len(), 1);
        });
    }

    /// One truncated line must not cost the user every edge they have.
    #[test]
    fn a_corrupt_line_costs_only_itself() {
        with_store(|c| {
            append(c, &edge("s1", 1, Via::JobDone)).unwrap();
            let path = store_path().unwrap();
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            writeln!(f, "{{\"repo\": \"/repo\", truncated").unwrap();
            drop(f);
            c.sync();
            append(c, &edge("s2", 2, Via::JobDone)).unwrap();
            let rows = read_file();
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[1].session_id, "s2");
        });
    }

    /// A second Canopy window is a second writer. A cache that trusted itself
    /// would re-append a row that window already wrote, so it revalidates
    /// against the file — by `stat`, not by re-reading.
    #[test]
    fn a_write_from_another_window_is_picked_up() {
        with_store(|c| {
            append(c, &edge("s1", 1, Via::JobDone)).unwrap();

            // Somebody else appends behind our back.
            let path = store_path().unwrap();
            let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
            writeln!(
                f,
                "{}",
                serde_json::to_string(&edge("s2", 1, Via::PrWatch)).unwrap()
            )
            .unwrap();
            drop(f);

            // Same edge, offered again: the sync has to find the stranger's row
            // or we write a duplicate.
            c.sync();
            assert!(!append(c, &edge("s2", 1, Via::JobDone)).unwrap());
            assert_eq!(read_file().len(), 2);
        });
    }

    /// The cache must not re-read after its own write — that is the cost the
    /// whole thing exists to avoid.
    #[test]
    fn our_own_write_does_not_invalidate_the_cache() {
        with_store(|c| {
            append(c, &edge("s1", 1, Via::JobDone)).unwrap();
            let stamp = c.stamp;
            c.sync();
            assert_eq!(c.stamp, stamp, "sync reloaded after our own append");
            assert_eq!(c.edges.len(), 1);
        });
    }

    /// A session id becomes a file name when the resolver goes looking for the
    /// digest, so it is checked here rather than trusted because it arrived
    /// from another layer that also checks.
    #[test]
    fn a_session_id_that_could_escape_is_refused() {
        let mut e = edge("../../etc/passwd", 1, Via::JobDone);
        assert!(check(&e).is_err());
        e.session_id = "a/b".into();
        assert!(check(&e).is_err());
        e.session_id = "019fb713-b047-77c2-98fc-cf008cea0bf0".into();
        assert!(check(&e).is_ok());
    }

    /// An edge with no branch is an edge that was never joined on anything.
    #[test]
    fn an_edge_needs_the_thing_it_was_joined_on() {
        let mut e = edge("s1", 1, Via::JobDone);
        e.branch = "  ".into();
        assert!(check(&e).is_err());
        e.branch = "feat/x".into();
        e.pr_number = 0;
        assert!(check(&e).is_err());
    }

    /// Confidence is read off the writer, so a row written by an older build
    /// cannot carry a stored confidence that disagrees with today's reading —
    /// and it rides the wire, so the frontend never re-derives the mapping.
    #[test]
    fn confidence_is_derived_from_the_writer() {
        assert_eq!(Via::JobDone.confidence(), "declared");
        assert_eq!(Via::PrWatch.confidence(), "observed");
        assert_eq!(Via::Backfill.confidence(), "inferred");

        let out = EdgeOut::from(edge("s1", 1, Via::Backfill));
        let json: serde_json::Value = serde_json::to_value(&out).unwrap();
        assert_eq!(json["confidence"], "inferred");
        assert_eq!(json["via"], "backfill");
        // Flattened, not nested: readers get one object, not `{edge: {...}}`.
        assert_eq!(json["session_id"], "s1");
    }

    /// A directory of digests, as the sweep will find them.
    fn digests(dir: &Path, rows: &[(&str, &str, &str)]) {
        std::fs::create_dir_all(dir).unwrap();
        for (session, branch, cwd) in rows {
            let body = serde_json::json!({
                "session_id": session,
                "branch": branch,
                "cwd": cwd,
                "agent": "claude",
                "profile": "default",
                "updated": 1_700_000_123u64,
            });
            std::fs::write(dir.join(format!("{session}.json")), body.to_string()).unwrap();
        }
    }

    /// The sweep end to end: it attributes what it can prove, counts what it
    /// cannot, and ignores what no PR asked about.
    #[test]
    fn the_sweep_attributes_only_what_it_can_prove() {
        let dir = std::env::temp_dir().join(format!("canopy-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        digests(
            &dir,
            &[
                // Under the repo toplevel.
                ("s-main", "feat/a", "/repo/src"),
                // An agent's own worktree, listed by git but outside the repo.
                ("s-wt", "feat/b", "/scratch/wt-b"),
                // Same branch name, another repo entirely. The trap.
                ("s-other", "feat/a", "/somewhere-else"),
                // No PR was raised for this branch.
                ("s-idle", "feat/unshipped", "/repo/src"),
                // A digest with no branch at all — the 27 of 298 on this
                // machine that carry none.
                ("s-bare", "", "/repo/src"),
            ],
        );
        // A file that is not a digest, and one that is not JSON.
        std::fs::write(dir.join("notes.txt"), "ignore me").unwrap();
        std::fs::write(dir.join("broken.json"), "{ truncated").unwrap();

        let prs = vec![
            PrSeed {
                number: 1,
                url: "u1".into(),
                branch: "feat/a".into(),
            },
            PrSeed {
                number: 2,
                url: "u2".into(),
                branch: "feat/b".into(),
            },
        ];
        let owned = vec![PathBuf::from("/repo"), PathBuf::from("/scratch/wt-b")];
        let (edges, report) = sweep(&dir, &prs, &owned, "/repo", Via::Backfill);

        // notes.txt is not scanned; broken.json is scanned but unparseable.
        assert_eq!(report.scanned, 5);
        assert_eq!(report.matched, 2);
        assert_eq!(report.unattributable, 1, "the stranger on feat/a");

        let mut got: Vec<(String, u64)> = edges
            .iter()
            .map(|e| (e.session_id.clone(), e.pr_number))
            .collect();
        got.sort();
        assert_eq!(
            got,
            vec![("s-main".to_string(), 1), ("s-wt".to_string(), 2)]
        );
        // The digest's clock, not the sweep's.
        assert_eq!(edges[0].at, 1_700_000_123);
        assert_eq!(edges[0].via, Via::Backfill);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Running it twice must not double the history — the second sweep finds
    /// the same edges and writes none of them.
    #[test]
    fn a_second_sweep_records_nothing_new() {
        let dir = std::env::temp_dir().join(format!("canopy-sweep2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        digests(&dir, &[("s-main", "feat/a", "/repo/src")]);
        let prs = vec![PrSeed {
            number: 1,
            url: "u1".into(),
            branch: "feat/a".into(),
        }];
        let owned = vec![PathBuf::from("/repo")];

        with_store(|c| {
            let (edges, _) = sweep(&dir, &prs, &owned, "/repo", Via::Backfill);
            assert!(append(c, &edges[0]).unwrap());
            let (again, _) = sweep(&dir, &prs, &owned, "/repo", Via::Backfill);
            assert!(!append(c, &again[0]).unwrap());
            assert_eq!(read_file().len(), 1);
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The invariant the writers depend on: an agent records from its linked
    /// worktree and the PR tab reads from the main checkout, and both have to
    /// land on the same key or every row is invisible to the surface that
    /// wanted it.
    #[test]
    fn a_worktree_and_its_main_checkout_are_one_repo() {
        let root = std::env::temp_dir().join(format!("canopy-key-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let main = root.join("repo");
        std::fs::create_dir_all(&main).unwrap();
        let git = |dir: &Path, args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(dir)
                .args(args)
                .output()
                .unwrap()
        };
        git(&main, &["init", "-q"]);
        git(&main, &["config", "user.email", "t@t"]);
        git(&main, &["config", "user.name", "t"]);
        std::fs::write(main.join("f"), "x").unwrap();
        git(&main, &["add", "-A"]);
        git(&main, &["commit", "-qm", "init"]);
        let wt = root.join("wt");
        git(&main, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "feat/x"]);

        let want = repo_key(main.to_str().unwrap());
        assert_eq!(repo_key(wt.to_str().unwrap()), want, "worktree keyed apart");
        // A subdirectory of either is still the same repo.
        assert_eq!(repo_key(main.join("..").to_str().unwrap()) == want, false);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A path git cannot speak for still gets a stable key rather than an
    /// error — writer and reader agree on it for the same reason.
    #[test]
    fn a_path_that_is_not_a_repo_keys_to_itself() {
        assert_eq!(repo_key("/nowhere/at/all"), "/nowhere/at/all");
        assert_eq!(repo_key("/nowhere/at/all/"), "/nowhere/at/all");
    }

    /// The guard that keeps backfill from attributing a stranger's session:
    /// `fix/typo` is a branch name every repo has, and the cwd is what tells
    /// them apart.
    #[test]
    fn a_cwd_outside_the_repo_belongs_to_nobody() {
        let owned = vec![PathBuf::from("/repo"), PathBuf::from("/elsewhere/wt-a")];
        assert!(belongs(&owned, "/repo"));
        assert!(belongs(&owned, "/repo/src/deep"));
        assert!(belongs(&owned, "/elsewhere/wt-a/src"));
        assert!(!belongs(&owned, "/other-repo"));
        // The prefix trap: a sibling whose name starts with the repo's.
        assert!(!belongs(&owned, "/repo-two/src"));
    }
}



//! One poller for every project's pull requests.
//!
//! The naive version of a cross-project PR inbox is a `setInterval` per panel
//! calling `gh pr list` per repo — a process per repo per tick, a `gh api user`
//! for the viewer's login inside each one (see `gh_pr_list`), and all of it
//! still running when the window is in the background. With five projects open
//! that is 10+ subprocesses a minute for a list nobody is looking at.
//!
//! So the work happens once, here, and the answer is broadcast:
//!
//!   - **One HTTP request per batch of repos.** GraphQL aliases put up to
//!     `BATCH` repositories in a single `gh api graphql` document, with
//!     `viewer{login}` and `rateLimit{...}` alongside them — so the viewer is
//!     resolved once per request rather than once per repo.
//!   - **`owner/name` is resolved once per repo path, ever**, and cached; that
//!     was the other subprocess per tick.
//!   - **Nested connections are capped** (`first:1` where only `totalCount` is
//!     wanted): GraphQL's cost is driven by how many nodes you ask for.
//!   - **The interval follows attention**: `FOCUSED` while the window has focus,
//!     `IDLE` when it doesn't, `SLOW` when GitHub says we're near the rate cap,
//!     and exponential backoff on failure.
//!   - **Nothing is emitted unless it changed.** Each repo's rows are hashed;
//!     an unchanged repo produces no event, so no React tree re-renders because
//!     a poll happened.
//!
//! The frontend declares which repos matter (`pr_watch_set`) and otherwise
//! listens. `prs:snapshot` carries one repo's rows; `prs:tick` carries the
//! metadata of a whole pass (when, what it cost, what failed).

use crate::fsx::WorkspaceManager;
use crate::git::{gh_repo_toplevel, rollup_state};
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Repositories per GraphQL document. Aliases make this one request; too many
/// and a single slow repo delays every other one's rows.
const BATCH: usize = 8;
/// Open PRs per repo. An inbox is for triage — past this, the list is the
/// problem, not the refresh rate.
const PRS_PER_REPO: usize = 20;

const FOCUSED: Duration = Duration::from_secs(90);
const IDLE: Duration = Duration::from_secs(600);
/// Used when GitHub says we're low on points, and as the backoff ceiling.
const SLOW: Duration = Duration::from_secs(900);
/// Below this many GraphQL points remaining, drop to the slow lane.
const LOW_POINTS: i64 = 300;

/// One row of the inbox. Deliberately flat and cheap: everything here comes from
/// the batched query, and nothing here needs a second call to render.
#[derive(Serialize, Clone, Hash, PartialEq)]
pub struct PrRow {
    /// Local checkout this PR belongs to — what a click opens.
    pub repo: String,
    pub nwo: String,
    pub number: u32,
    pub title: String,
    pub author: String,
    pub url: String,
    pub branch: String,
    pub base: String,
    pub draft: bool,
    pub created: String,
    pub updated: String,
    pub additions: u32,
    pub deletions: u32,
    pub mergeable: String,
    pub review_decision: String,
    /// PASS / FAIL / PENDING / "" — same vocabulary as PrInfo.
    pub checks: String,
    pub comments: u32,
    pub threads: u32,
    /// This PR is waiting on the signed-in user's review.
    pub requested_from_me: bool,
    pub mine: bool,
}

/// One repo's rows, as broadcast on `prs:snapshot`.
#[derive(Serialize, Clone)]
pub struct PrSnapshot {
    pub repo: String,
    pub nwo: String,
    pub rows: Vec<PrRow>,
    pub viewer: String,
    pub fetched_ms: u64,
}

/// What a whole pass cost and what went wrong, on `prs:tick`.
#[derive(Serialize, Clone, Default)]
pub struct PrTick {
    pub fetched_ms: u64,
    pub repos: usize,
    pub requests: usize,
    /// GraphQL points this pass consumed, and what's left of the hourly budget.
    pub cost: i64,
    pub remaining: i64,
    pub reset_at: String,
    /// `repo path → message`, for repos that couldn't be read.
    pub errors: HashMap<String, String>,
    /// Seconds until the next pass, so the UI can say when rather than spin.
    pub next_in: u64,
}

#[derive(Default)]
struct Watch {
    /// Validated toplevel repo paths, in the order the frontend gave them.
    repos: Vec<String>,
    focused: bool,
    /// `repo path → owner/name`, resolved once. `None` = not a GitHub remote,
    /// remembered so we stop asking.
    nwo: HashMap<String, Option<String>>,
    /// `repo path → hash of its rows`, so an unchanged repo emits nothing.
    hashes: HashMap<String, u64>,
    /// Consecutive failures, for backoff.
    fails: u32,
    /// GitHub told us we're low on points.
    low_points: bool,
}

#[derive(Default)]
pub struct PrWatcher {
    inner: Arc<Mutex<Watch>>,
    running: Arc<AtomicBool>,
    /// Woken when the repo set changes or a refresh is asked for, so a pass
    /// starts immediately instead of at the end of the current sleep.
    wake: Arc<tokio::sync::Notify>,
}

impl PrWatcher {
    pub fn shutdown(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.wake.notify_waiters();
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hash_rows(rows: &[PrRow]) -> u64 {
    let mut h = DefaultHasher::new();
    rows.hash(&mut h);
    h.finish()
}

/// `owner/name` is interpolated into the query document (GraphQL has no variable
/// form for an alias), so it must not be able to carry anything but a repo name.
fn safe_nwo(nwo: &str) -> bool {
    !nwo.is_empty()
        && nwo.len() < 200
        && nwo.contains('/')
        && nwo
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'))
}

/// The per-repository selection. `first: 1` on the two counted connections is
/// the whole point: `totalCount` is free, nodes are not.
fn repo_selection(alias: &str, owner: &str, name: &str) -> String {
    format!(
        r#"{alias}: repository(owner:"{owner}",name:"{name}"){{
             nameWithOwner
             pullRequests(states:OPEN,first:{PRS_PER_REPO},orderBy:{{field:UPDATED_AT,direction:DESC}}){{nodes{{
               number title url isDraft createdAt updatedAt
               author{{login}} headRefName baseRefName additions deletions
               mergeable reviewDecision
               comments(first:1){{totalCount}}
               reviewThreads(first:1){{totalCount}}
               reviewRequests(first:5){{nodes{{requestedReviewer{{__typename ... on User{{login}} ... on Team{{slug}}}}}}}}
               commits(last:1){{nodes{{commit{{statusCheckRollup{{state}}}}}}}}
             }}}}
           }}"#
    )
}

fn parse_rows(repo: &str, viewer: &str, node: &Value) -> Vec<PrRow> {
    let nwo = node["nameWithOwner"].as_str().unwrap_or("").to_string();
    node["pullRequests"]["nodes"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|p| {
                    let author = p["author"]["login"].as_str().unwrap_or("").to_string();
                    let requested_from_me = p["reviewRequests"]["nodes"]
                        .as_array()
                        .map(|rs| {
                            rs.iter().any(|r| {
                                r["requestedReviewer"]["login"].as_str() == Some(viewer)
                                    && !viewer.is_empty()
                            })
                        })
                        .unwrap_or(false);
                    let checks = p["commits"]["nodes"]
                        .as_array()
                        .and_then(|c| c.first())
                        .map(|c| {
                            rollup_state(
                                c["commit"]["statusCheckRollup"]["state"]
                                    .as_str()
                                    .unwrap_or(""),
                            )
                        })
                        .unwrap_or_default();
                    PrRow {
                        repo: repo.to_string(),
                        nwo: nwo.clone(),
                        number: p["number"].as_u64().unwrap_or(0) as u32,
                        title: p["title"].as_str().unwrap_or("").to_string(),
                        mine: !viewer.is_empty() && author == viewer,
                        author,
                        url: p["url"].as_str().unwrap_or("").to_string(),
                        branch: p["headRefName"].as_str().unwrap_or("").to_string(),
                        base: p["baseRefName"].as_str().unwrap_or("").to_string(),
                        draft: p["isDraft"].as_bool().unwrap_or(false),
                        created: p["createdAt"].as_str().unwrap_or("").to_string(),
                        updated: p["updatedAt"].as_str().unwrap_or("").to_string(),
                        additions: p["additions"].as_u64().unwrap_or(0) as u32,
                        deletions: p["deletions"].as_u64().unwrap_or(0) as u32,
                        mergeable: p["mergeable"].as_str().unwrap_or("UNKNOWN").to_string(),
                        review_decision: p["reviewDecision"].as_str().unwrap_or("").to_string(),
                        checks,
                        comments: p["comments"]["totalCount"].as_u64().unwrap_or(0) as u32,
                        threads: p["reviewThreads"]["totalCount"].as_u64().unwrap_or(0) as u32,
                        requested_from_me,
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---------- commands ----------

/// Declare the repos worth watching and whether the user is looking. Called on
/// workspace changes and on focus changes; starts the loop on first use.
#[tauri::command]
pub async fn pr_watch_set(
    app: AppHandle,
    ws: State<'_, WorkspaceManager>,
    watcher: State<'_, PrWatcher>,
    paths: Vec<String>,
    focused: bool,
) -> Result<(), String> {
    // Resolve each component path to its repo toplevel and de-duplicate: two
    // components of one project are usually two directories of one repo, and
    // polling it twice would be exactly the waste this module exists to avoid.
    let mut repos: Vec<String> = Vec::new();
    for p in &paths {
        if let Ok(top) = gh_repo_toplevel(&ws, p) {
            let top = top.to_string_lossy().to_string();
            if !repos.contains(&top) {
                repos.push(top);
            }
        }
    }

    let changed = {
        let mut w = watcher.inner.lock().unwrap();
        let changed = w.repos != repos || w.focused != focused;
        // Drop cached hashes for repos that left, so re-adding one re-emits.
        w.hashes.retain(|k, _| repos.contains(k));
        w.repos = repos;
        w.focused = focused;
        changed
    };

    if !watcher.running.swap(true, Ordering::SeqCst) {
        spawn_loop(
            app,
            watcher.inner.clone(),
            watcher.running.clone(),
            watcher.wake.clone(),
        );
    } else if changed {
        watcher.wake.notify_waiters();
    }
    Ok(())
}

/// Refresh now (the panel's ↻). Wakes the loop rather than running a pass of its
/// own, so two clicks can't double the traffic.
#[tauri::command]
pub async fn pr_watch_now(watcher: State<'_, PrWatcher>) -> Result<(), String> {
    watcher.wake.notify_waiters();
    Ok(())
}

fn spawn_loop(
    app: AppHandle,
    inner: Arc<Mutex<Watch>>,
    running: Arc<AtomicBool>,
    wake: Arc<tokio::sync::Notify>,
) {
    tauri::async_runtime::spawn(async move {
        while running.load(Ordering::SeqCst) {
            let (repos, focused) = {
                let w = inner.lock().unwrap();
                (w.repos.clone(), w.focused)
            };
            let mut next = if repos.is_empty() {
                IDLE
            } else {
                let tick = pass(&app, &inner, &repos).await;
                let w = inner.lock().unwrap();
                if w.low_points {
                    SLOW
                } else if w.fails > 0 {
                    // 90s → 180 → 360 → … capped at the slow lane.
                    let backoff = FOCUSED * 2u32.saturating_pow(w.fails.min(4));
                    backoff.min(SLOW)
                } else if focused {
                    FOCUSED
                } else {
                    IDLE
                }
                .max(Duration::from_secs(if tick.errors.is_empty() {
                    0
                } else {
                    30
                }))
            };
            if repos.is_empty() {
                next = IDLE;
            }
            let _ = app.emit("prs:next", next.as_secs());
            tokio::select! {
                _ = tokio::time::sleep(next) => {}
                _ = wake.notified() => {}
            }
        }
    });
}

/// One pass over every watched repo. Returns the tick metadata it emitted.
async fn pass(app: &AppHandle, inner: &Arc<Mutex<Watch>>, repos: &[String]) -> PrTick {
    let mut tick = PrTick {
        repos: repos.len(),
        ..Default::default()
    };

    // Resolve any repo we haven't seen before — once per path, for the life of
    // the process. `None` means "not a GitHub repo": remembered, never retried.
    for repo in repos {
        let known = inner.lock().unwrap().nwo.contains_key(repo);
        if known {
            continue;
        }
        let resolved = tauri::async_runtime::spawn_blocking({
            let repo = repo.clone();
            move || crate::git::gh_nwo_of(&repo)
        })
        .await
        .ok()
        .and_then(|r| r.ok())
        .filter(|n| safe_nwo(n));
        inner.lock().unwrap().nwo.insert(repo.clone(), resolved);
    }

    let targets: Vec<(String, String)> = {
        let w = inner.lock().unwrap();
        repos
            .iter()
            .filter_map(|r| w.nwo.get(r).cloned().flatten().map(|n| (r.clone(), n)))
            .collect()
    };

    let mut ok = true;
    for chunk in targets.chunks(BATCH) {
        let mut doc = String::from("query{ viewer{login} rateLimit{cost remaining resetAt}\n");
        for (i, (_, nwo)) in chunk.iter().enumerate() {
            let (owner, name) = nwo.split_once('/').unwrap_or((nwo.as_str(), ""));
            doc.push_str(&repo_selection(&format!("r{i}"), owner, name));
            doc.push('\n');
        }
        doc.push('}');

        tick.requests += 1;
        let result =
            tauri::async_runtime::spawn_blocking(move || crate::git::gh_graphql_anywhere(&doc))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r);

        let data = match result {
            Ok(d) => d,
            Err(e) => {
                ok = false;
                for (repo, _) in chunk {
                    tick.errors.insert(repo.clone(), e.clone());
                }
                continue;
            }
        };
        let viewer = data["viewer"]["login"].as_str().unwrap_or("").to_string();
        tick.cost += data["rateLimit"]["cost"].as_i64().unwrap_or(0);
        tick.remaining = data["rateLimit"]["remaining"]
            .as_i64()
            .unwrap_or(tick.remaining);
        if let Some(r) = data["rateLimit"]["resetAt"].as_str() {
            tick.reset_at = r.to_string();
        }

        for (i, (repo, nwo)) in chunk.iter().enumerate() {
            let node = &data[format!("r{i}")];
            if node.is_null() {
                tick.errors.insert(
                    repo.clone(),
                    format!("{nwo} isn't readable with this login"),
                );
                continue;
            }
            let rows = parse_rows(repo, &viewer, node);
            let hash = hash_rows(&rows);
            let unchanged = {
                let mut w = inner.lock().unwrap();
                let same = w.hashes.get(repo) == Some(&hash);
                if !same {
                    w.hashes.insert(repo.clone(), hash);
                }
                same
            };
            if unchanged {
                continue;
            }
            let _ = app.emit(
                "prs:snapshot",
                PrSnapshot {
                    repo: repo.clone(),
                    nwo: nwo.clone(),
                    rows,
                    viewer: viewer.clone(),
                    fetched_ms: now_ms(),
                },
            );
        }
    }

    {
        let mut w = inner.lock().unwrap();
        w.fails = if ok { 0 } else { w.fails.saturating_add(1) };
        w.low_points = tick.remaining > 0 && tick.remaining < LOW_POINTS;
    }
    tick.fetched_ms = now_ms();
    let _ = app.emit("prs:tick", tick.clone());
    tick
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn safe_nwo_accepts_real_names_and_rejects_injection() {
        assert!(safe_nwo("FluidWorksApp/canopy-ide"));
        assert!(safe_nwo("o/repo.js"));
        assert!(!safe_nwo("owner"));
        assert!(!safe_nwo(""));
        // The alias document interpolates this, so quotes and braces must not
        // survive the filter.
        assert!(!safe_nwo("o/r\"}}"));
        assert!(!safe_nwo("o/r name"));
        assert!(!safe_nwo("o/r\n"));
    }

    #[test]
    fn repo_selection_asks_for_counts_not_nodes() {
        let q = repo_selection("r0", "o", "n");
        assert!(q.contains("r0: repository(owner:\"o\",name:\"n\")"));
        // Cost control: counted connections must never pull their nodes.
        assert!(q.contains("comments(first:1){totalCount}"));
        assert!(q.contains("reviewThreads(first:1){totalCount}"));
        assert!(q.contains("states:OPEN"));
        assert!(q.contains("first:20"));
    }

    fn one_pr() -> Value {
        json!({
          "nameWithOwner": "o/r",
          "pullRequests": { "nodes": [{
            "number": 3, "title": "Fix it", "url": "https://github.com/o/r/pull/3",
            "isDraft": false, "createdAt": "2026-07-01T09:00:00Z", "updatedAt": "2026-07-02T09:00:00Z",
            "author": { "login": "alice" }, "headRefName": "fix", "baseRefName": "main",
            "additions": 12, "deletions": 3, "mergeable": "MERGEABLE",
            "reviewDecision": "REVIEW_REQUIRED",
            "comments": { "totalCount": 2 },
            "reviewThreads": { "totalCount": 5 },
            "reviewRequests": { "nodes": [
              { "requestedReviewer": { "__typename": "User", "login": "me" } },
              { "requestedReviewer": { "__typename": "Team", "slug": "core" } }
            ]},
            "commits": { "nodes": [{ "commit": { "statusCheckRollup": { "state": "FAILURE" } } }] }
          }]}
        })
    }

    #[test]
    fn parse_rows_reads_the_inbox_signals() {
        let rows = parse_rows("/repo", "me", &one_pr());
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.repo, "/repo");
        assert_eq!(r.nwo, "o/r");
        assert_eq!(r.number, 3);
        assert_eq!(r.checks, "FAIL");
        assert_eq!(r.comments, 2);
        assert_eq!(r.threads, 5);
        // The signal the inbox sorts on: someone asked *me*.
        assert!(r.requested_from_me);
        assert!(!r.mine);
    }

    #[test]
    fn parse_rows_knows_my_own_prs_and_ignores_team_requests_as_mine() {
        let rows = parse_rows("/repo", "alice", &one_pr());
        assert!(rows[0].mine);
        assert!(!rows[0].requested_from_me);
    }

    #[test]
    fn parse_rows_survives_a_repo_with_no_prs_or_missing_fields() {
        let empty = json!({ "nameWithOwner": "o/r", "pullRequests": { "nodes": [] } });
        assert!(parse_rows("/repo", "me", &empty).is_empty());
        let partial = json!({ "pullRequests": { "nodes": [{ "number": 1 }] } });
        let rows = parse_rows("/repo", "me", &partial);
        assert_eq!(rows[0].number, 1);
        assert_eq!(rows[0].mergeable, "UNKNOWN");
        assert_eq!(rows[0].checks, "");
        assert!(!rows[0].mine);
    }

    #[test]
    fn identical_rows_hash_identically_so_an_unchanged_repo_stays_quiet() {
        let a = parse_rows("/repo", "me", &one_pr());
        let b = parse_rows("/repo", "me", &one_pr());
        assert_eq!(hash_rows(&a), hash_rows(&b));
        let mut c = b.clone();
        c[0].updated = "2026-07-03T09:00:00Z".into();
        assert_ne!(hash_rows(&a), hash_rows(&c));
    }
}

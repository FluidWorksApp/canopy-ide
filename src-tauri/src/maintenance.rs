//! Scheduled maintenance, as one framework instead of one timer per chore.
//!
//! The app accumulates recurring background work — compact the stores under
//! `~/.canopy`, refresh volatile catalogues — and each would otherwise invent
//! its own thread, its own "did this already run today", its own backoff.
//! This module is the one loop they subscribe to instead: a job declares a
//! stable id and a frequency in `jobs()`, the scheduler invokes it when due
//! and records how the run went in `~/.canopy/maintenance.json` — so a daily
//! job that ran this morning stays quiet after a lunchtime restart rather
//! than re-running on every launch.
//!
//! It lives on this side of the IPC boundary, not the webview's, because the
//! work does: the stores being maintained are the backend's files, and a
//! backend thread ticks even when the window is hidden and WKWebView is
//! throttling timers. The scheduling rules are pure functions over
//! (cadence, record, now) — tested below — and the loop that applies them is
//! a thread in the shape of `start_hook_bridge`. Jobs run sequentially,
//! never concurrently: maintenance competes with the user's own work for
//! disk, and two chores at once is how a background task gets noticed.
//!
//! What does NOT belong here: anything that deletes user work. `cleanup.rs`
//! is a dialog on purpose — reclaim is never automatic — and this framework
//! only ever maintains Canopy's own bookkeeping.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

/// One recurring chore. Subscribe by adding an entry to `jobs()`.
pub struct Job {
    /// Stable identity — the completion record is keyed on it, so renaming a
    /// job forgets when it last ran.
    pub id: &'static str,
    /// Milliseconds between successful completions.
    pub every_ms: u64,
    /// Run on the first check of each session even when the last completion
    /// is recent — for work whose answer can change while the app was closed.
    pub eager: bool,
    /// The work. `Ok` is a completion; `Err` is retried with backoff rather
    /// than waiting out `every_ms`.
    pub run: fn(&AppHandle) -> Result<(), String>,
}

/// The manifest: every subscribed chore, in one place. A new chore is a new
/// entry here — never a new thread in `lib.rs`.
///
/// What a purge job may ever touch is an explicit allowlist, never
/// "everything in `~/.canopy` except…" — a deny-list deletes whatever the
/// next feature stores there before anyone classifies it. The ledger, so the
/// next candidate is judged deliberately:
///
///   Purgeable — derived or write-only, provably not read back:
///     agent-events.jsonl            the event bus; tailed live, history dead
///     spot-index.sqlite (+wal/shm)  FTS5 cache; rebuilt from source stores
///
///   Never purgeable, at any size:
///     notes/ research/ sessions/    the user's work, and the session records
///                                   `agents.rs` enumerates and reopens
///     clipboard.sqlite              history that cannot be re-captured — the
///                                   one non-rebuildable store (clipboard.rs)
///     vault.enc relay-identity      credentials; profiles/ holds logins
///     provenance.jsonl              the permanent session→PR record
///     models/                       dictation models; re-downloadable, but
///                                   deleting one is user-visible breakage —
///                                   reclaim like that is `cleanup.rs`, with
///                                   a dialog, never a background timer
///     bin/ *.json plan-usage/       the app's own plumbing; small, and
///     companion/                    deleting settings is never "maintenance"
fn jobs() -> Vec<Job> {
    vec![
        // The chore this framework was built for. agent-events.jsonl is an
        // append-only bus that nothing reads back — the bridge tails from
        // where it stands and a fresh launch starts at the end — so on a
        // busy machine it grows without bound (1.1GB seen in the field).
        Job {
            id: "agent-events-compact",
            every_ms: 24 * 60 * 60 * 1000,
            eager: false,
            run: compact_agent_events,
        },
        // The other unbounded file: SpotSearch's transcript index, seen at
        // 1.36GB. Retention deletes rows but FTS5 keeps the pages, so the
        // file only ever grows; past its cap it is cheaper to re-ingest than
        // to vacuum. spot.rs owns the file layout and the live connection,
        // so the how lives there.
        Job {
            id: "spot-index-purge",
            every_ms: 24 * 60 * 60 * 1000,
            eager: false,
            run: purge_spot_index,
        },
    ]
}

/// How a job's last runs went. This is the tracked record, not live state.
#[derive(Serialize, Deserialize, Clone, Default, Debug, PartialEq)]
pub struct Record {
    /// Epoch ms of the last successful completion.
    pub last_ok: Option<u64>,
    /// Epoch ms of the last attempt, successful or not.
    pub last_run: Option<u64>,
    /// Consecutive failures since the last success.
    pub failures: u32,
    /// What the last failure said, `None` after a success.
    pub last_error: Option<String>,
}

type Records = HashMap<String, Record>;

/// First retry after a failure; doubles per consecutive failure.
const RETRY_MS: u64 = 60_000;
/// Failure backoff never exceeds this (nor the job's own frequency).
const RETRY_MAX_MS: u64 = 30 * 60_000;
/// Long enough after launch that the first check never competes with boot.
const FIRST_CHECK: Duration = Duration::from_secs(15);
/// Between checks. Frequencies are hours and days; a minute of slack is noise.
const CHECK_EVERY: Duration = Duration::from_secs(60);

/// After a failure: how long until the next attempt is allowed.
fn retry_delay_ms(failures: u32, every_ms: u64) -> u64 {
    let doubled = RETRY_MS.saturating_mul(1 << failures.saturating_sub(1).min(31));
    doubled.min(RETRY_MAX_MS).min(every_ms)
}

/// Whether a job should run now. Pure, so the calendar is a thing that can
/// be tested rather than a thing that is watched. `ran_this_session` is what
/// makes `eager` mean "once per session" instead of "every check".
fn is_due(
    every_ms: u64,
    eager: bool,
    record: Option<&Record>,
    now_ms: u64,
    ran_this_session: bool,
) -> bool {
    let Some(r) = record else { return true };
    let Some(last_run) = r.last_run else {
        return true;
    };
    if r.failures > 0 {
        return now_ms.saturating_sub(last_run) >= retry_delay_ms(r.failures, every_ms);
    }
    if eager && !ran_this_session {
        return true;
    }
    let Some(last_ok) = r.last_ok else {
        return true;
    };
    // A record from the future means the clock moved back under us; running
    // resets the record to times that can age normally.
    if last_ok > now_ms {
        return true;
    }
    now_ms - last_ok >= every_ms
}

fn canopy_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".canopy"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load_records(path: &Path) -> Records {
    // A missing or corrupt file means every job runs once and rewrites it —
    // maintenance is idempotent by contract, so that is recovery, not harm.
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_records(path: &Path, records: &Records) {
    if let Ok(json) = serde_json::to_string_pretty(records) {
        // Untracked completions re-run next session; not worth surfacing.
        let _ = std::fs::write(path, json);
    }
}

/// Start the loop. Called once from setup, like the other resident threads.
pub fn start(app: AppHandle) {
    let Some(dir) = canopy_dir() else { return };
    let records_path = dir.join("maintenance.json");
    thread::Builder::new()
        .name("maintenance".into())
        .spawn(move || {
            let mut ran_this_session: Vec<&'static str> = Vec::new();
            thread::sleep(FIRST_CHECK);
            loop {
                let mut records = load_records(&records_path);
                for job in jobs() {
                    let due = is_due(
                        job.every_ms,
                        job.eager,
                        records.get(job.id),
                        now_ms(),
                        ran_this_session.contains(&job.id),
                    );
                    if !due {
                        continue;
                    }
                    ran_this_session.push(job.id);
                    let mut r = records.get(job.id).cloned().unwrap_or_default();
                    r.last_run = Some(now_ms());
                    match (job.run)(&app) {
                        Ok(()) => {
                            r.last_ok = Some(now_ms());
                            r.failures = 0;
                            r.last_error = None;
                        }
                        Err(e) => {
                            r.failures += 1;
                            log::warn!("maintenance job {} failed ({}): {e}", job.id, r.failures);
                            r.last_error = Some(e);
                        }
                    }
                    records.insert(job.id.to_string(), r);
                    // After every job, not every pass — a crash mid-pass
                    // keeps the completions that did happen.
                    save_records(&records_path, &records);
                }
                thread::sleep(CHECK_EVERY);
            }
        })
        .expect("spawn maintenance thread");
}

// ---------------------------------------------------------------------------
// The jobs themselves.

/// Truncate past this. Even a loud week of agents stays under it; the file
/// observed at 1.1GB was months of dead events.
const EVENTS_CAP_BYTES: u64 = 64 * 1024 * 1024;

/// Cap `~/.canopy/agent-events.jsonl`.
///
/// Truncating is safe by construction: history is never read — the bridge
/// starts tailing at the current end (`start_hook_bridge`) and treats a
/// shrunken file as "start over at 0", and `canopy-hook` reopens the file
/// per event, holding no fd across writes. Truncating to empty rather than
/// keeping a tail matters: a kept tail sits *after* the bridge's reset
/// offset and would be re-emitted as fresh events. An event appended in the
/// instant between the size check and the truncate is lost; digests travel
/// as separate files and the frontend keeps a fallback poll, so the worst
/// case is one delayed live update per day.
fn compact_agent_events(_app: &AppHandle) -> Result<(), String> {
    let Some(dir) = canopy_dir() else {
        return Ok(());
    };
    if let Some(freed) = compact_file(&dir.join("agent-events.jsonl"), EVENTS_CAP_BYTES)? {
        log::info!("maintenance: truncated agent-events.jsonl, freed {freed} bytes");
    }
    Ok(())
}

/// Delete `~/.canopy/spot-index.sqlite` and its WAL sidecars once they
/// outgrow spot.rs's cap. All policy is in `spot::purge_oversized_index`:
/// it holds the index's own state lock and drops the live connection before
/// touching the files, which this module has no business doing directly.
fn purge_spot_index(app: &AppHandle) -> Result<(), String> {
    if let Some(freed) = crate::spot::purge_oversized_index(app)? {
        log::info!("maintenance: purged spot-index.sqlite, freed {freed} bytes");
    }
    Ok(())
}

/// Truncate `file` to empty once it exceeds `cap`; `Ok(Some(bytes))` says how
/// much was freed, `Ok(None)` that it was left alone (including not existing).
fn compact_file(file: &Path, cap: u64) -> Result<Option<u64>, String> {
    let len = match std::fs::metadata(file) {
        Ok(m) => m.len(),
        Err(_) => return Ok(None),
    };
    if len <= cap {
        return Ok(None);
    }
    std::fs::File::create(file)
        .map(|_| Some(len))
        .map_err(|e| format!("truncate {}: {e}", file.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: u64 = 3_600_000;
    const DAY: u64 = 24 * HOUR;

    fn done(at: u64) -> Record {
        Record {
            last_ok: Some(at),
            last_run: Some(at),
            failures: 0,
            last_error: None,
        }
    }

    #[test]
    fn due_when_never_seen_and_again_once_the_frequency_has_passed() {
        assert!(is_due(DAY, false, None, 0, false));
        assert!(!is_due(DAY, false, Some(&done(0)), DAY - 1, false));
        assert!(is_due(DAY, false, Some(&done(0)), DAY, false));
    }

    #[test]
    fn eager_runs_once_per_session_not_once_per_check() {
        assert!(is_due(DAY, true, Some(&done(HOUR)), 2 * HOUR, false));
        assert!(!is_due(DAY, true, Some(&done(HOUR)), 2 * HOUR, true));
    }

    #[test]
    fn failures_retry_on_the_backoff_clock_not_the_frequency() {
        let failed = Record {
            last_ok: None,
            last_run: Some(0),
            failures: 1,
            last_error: Some("boom".into()),
        };
        assert!(!is_due(DAY, false, Some(&failed), RETRY_MS - 1, false));
        assert!(is_due(DAY, false, Some(&failed), RETRY_MS, false));
        // Doubling per failure, capped — and never slower than a quick
        // chore's own frequency.
        assert_eq!(retry_delay_ms(2, DAY), RETRY_MS * 2);
        assert_eq!(retry_delay_ms(20, DAY), RETRY_MAX_MS);
        assert_eq!(retry_delay_ms(20, RETRY_MS), RETRY_MS);
    }

    #[test]
    fn a_record_from_the_future_is_due_because_the_clock_moved_back() {
        assert!(is_due(DAY, false, Some(&done(50 * HOUR)), HOUR, false));
    }

    #[test]
    fn records_survive_the_disk_and_shrug_off_corruption() {
        let dir = std::env::temp_dir().join(format!("canopy-maint-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("maintenance.json");

        let mut records = Records::new();
        records.insert("chore".into(), done(7));
        save_records(&path, &records);
        assert_eq!(load_records(&path), records);

        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(load_records(&path), Records::new());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compaction_leaves_small_files_alone_and_empties_big_ones() {
        let dir = std::env::temp_dir().join(format!("canopy-compact-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("events.jsonl");

        assert_eq!(compact_file(&file, 10), Ok(None)); // missing: nothing to do
        std::fs::write(&file, "under the cap").unwrap();
        assert_eq!(compact_file(&file, 1024), Ok(None));
        std::fs::write(&file, vec![b'x'; 2048]).unwrap();
        assert_eq!(compact_file(&file, 1024), Ok(Some(2048)));
        assert_eq!(std::fs::metadata(&file).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

//! One change channel, spoken by the write itself.
//!
//! Every store under `~/.canopy` has more than one author: the frontend, a
//! `#[tauri::command]` the frontend invoked, an agent through the context
//! bridge, the portal. Only the frontend could ever announce a change — its
//! stores dispatch a `window` CustomEvent after their own mutators — so a note
//! an agent parked landed on disk correctly and stayed invisible until the app
//! restarted.
//!
//! Announcing from the callers is what created that hole, and adding one more
//! caller-side announce would only move it. So the pulse lives inside the
//! store's write boundary: every caller that exists inherits it, and so does
//! every caller anyone adds later. `notesGuard.test.ts` is what keeps it there.
//!
//! Shaped after `fsx::pulse_git`, which solved exactly this for git state: a
//! generation counter and a settle window, so a burst of writes is one event.
//! Two differences, both learned from that one's costs. Only one task ever
//! sleeps per key, so a sweep that fires two hundred reminders spawns one task
//! rather than two hundred. And the wait is capped: a debounce with no ceiling
//! never speaks at all while an agent appends in a loop, which is the failure
//! this module exists to prevent.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub use canopy_core::events::{Store, StoreChange};

#[derive(Clone, serde::Serialize)]
pub struct StoreChangeEntry {
    sequence: u64,
    change: StoreChange,
}

#[derive(serde::Serialize)]
pub struct StoreChangeBatch {
    cursor: u64,
    changes: Vec<StoreChangeEntry>,
}

const CHANGE_HISTORY_LIMIT: usize = 1_024;
static CHANGE_SEQUENCE: AtomicU64 = AtomicU64::new(0);
static CHANGE_HISTORY: OnceLock<Mutex<VecDeque<StoreChangeEntry>>> = OnceLock::new();

fn record(change: StoreChange) {
    let sequence = CHANGE_SEQUENCE.fetch_add(1, Ordering::SeqCst) + 1;
    let mut history = CHANGE_HISTORY
        .get_or_init(|| Mutex::new(VecDeque::new()))
        .lock()
        .unwrap();
    history.push_back(StoreChangeEntry { sequence, change });
    while history.len() > CHANGE_HISTORY_LIMIT {
        history.pop_front();
    }
}

#[tauri::command]
pub fn store_changes(after: Option<u64>) -> StoreChangeBatch {
    changes_after(after)
}

fn changes_after(after: Option<u64>) -> StoreChangeBatch {
    let cursor = CHANGE_SEQUENCE.load(Ordering::SeqCst);
    let changes = after
        .map(|after| {
            CHANGE_HISTORY
                .get_or_init(|| Mutex::new(VecDeque::new()))
                .lock()
                .unwrap()
                .iter()
                .filter(|entry| entry.sequence > after)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    StoreChangeBatch { cursor, changes }
}

static APP: OnceLock<AppHandle> = OnceLock::new();

struct Slot {
    generation: u64,
    /// Whether a task is already sleeping on this key. One is always enough:
    /// it re-reads the generation when it wakes.
    waiting: bool,
}

static PENDING: OnceLock<Mutex<HashMap<(Store, String), Slot>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<(Store, String), Slot>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Hand the channel the handle it emits on. Called once, from `setup`.
pub fn install(app: AppHandle) {
    let _ = APP.set(app);
}

/// Say that a store moved, once the writes stop.
///
/// Cheap and infallible on the hot path: a lock, a counter bump, and — only
/// when nothing is already waiting — one spawned task. Safe to call before
/// there is a window; with no handle installed it does nothing, because there
/// is nobody to tell.
pub fn pulse(store: Store, scope: &str, id: &str) {
    let Some(app) = APP.get() else {
        return;
    };
    let key = (store, scope.to_string());
    let generation = {
        let mut map = pending().lock().unwrap();
        let slot = map.entry(key.clone()).or_insert(Slot {
            generation: 0,
            waiting: false,
        });
        slot.generation = slot.generation.wrapping_add(1);
        if slot.waiting {
            // Someone is already sleeping on this key; the bump is the whole
            // message. It reads the new generation when it wakes.
            return;
        }
        slot.waiting = true;
        slot.generation
    };

    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let settle = store.settle();
        let max_wait = store.max_wait();
        let mut seen = generation;
        let mut waited = Duration::ZERO;
        loop {
            tokio::time::sleep(settle).await;
            waited += settle;
            // Never hold the lock across an await.
            let current = {
                let map = pending().lock().unwrap();
                map.get(&key).map(|s| s.generation).unwrap_or(seen)
            };
            if current == seen || waited >= max_wait {
                {
                    let mut map = pending().lock().unwrap();
                    if let Some(slot) = map.get_mut(&key) {
                        slot.waiting = false;
                    }
                }
                let change = StoreChange {
                    store: key.0.as_str(),
                    scope: key.1.clone(),
                    id,
                };
                record(change.clone());
                let _ = app.emit("store:change", change);
                return;
            }
            seen = current;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The channel must be safe to call before a window exists: stores are
    /// written during startup and by tests, and neither has a handle.
    #[test]
    fn pulse_without_a_handle_is_a_no_op() {
        pulse(Store::Notes, "p_test", "0001-x");
    }

    /// The scope and id ride the event verbatim. They come from the note's own
    /// `Meta`, never derived from path components, so moving a directory
    /// cannot silently change what a reader is told.
    #[test]
    fn store_ids_are_stable_strings() {
        assert_eq!(Store::Notes.as_str(), "notes");
    }

    /// A settle window shorter than the cadence of the writes it coalesces is
    /// the same as no coalescing at all.
    #[test]
    fn settle_is_below_human_perception_and_max_wait_bounds_it() {
        assert!(Store::Notes.settle() < Duration::from_millis(100));
        assert!(Store::Notes.max_wait() >= Store::Notes.settle());
    }

    #[test]
    fn change_feed_handshakes_then_returns_ordered_changes() {
        let initial = changes_after(None);
        assert!(initial.changes.is_empty());
        record(StoreChange {
            store: "notes",
            scope: "project".into(),
            id: "first".into(),
        });
        record(StoreChange {
            store: "tasks",
            scope: "project".into(),
            id: "second".into(),
        });

        let batch = changes_after(Some(initial.cursor));
        assert_eq!(batch.changes.len(), 2);
        assert_eq!(batch.changes[0].change.id, "first");
        assert_eq!(batch.changes[1].change.id, "second");
        assert!(batch.changes[0].sequence < batch.changes[1].sequence);
    }
}

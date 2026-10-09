//! The resumable change stream (protocol §5).
//!
//! Persisted stores are authoritative; this log only says what moved. A cursor
//! is `<epoch>:<seq>`. The epoch is minted on every service start, so a cursor
//! from before a restart never resumes into a history it did not see — it gets
//! a fresh snapshot instead. Sequence allocation, ring insertion and fan-out
//! happen under one lock, so a cursor never runs ahead of the log.

use canopy_core::events::{EventSink, StoreChange};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub const REPLAY_WINDOW: usize = 4096;
/// Per-subscriber queue. Large enough to replay the whole window into a fresh
/// subscriber; a subscriber that falls this far behind is told to resnapshot.
pub const SUBSCRIBER_QUEUE: usize = REPLAY_WINDOW + 256;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Change {
    #[serde(skip)]
    pub seq: u64,
    pub cursor: String,
    pub store: String,
    pub scope: String,
    pub id: String,
}

struct Subscriber {
    tx: mpsc::Sender<Change>,
    overflowed: Arc<AtomicBool>,
}

struct Inner {
    seq: u64,
    ring: VecDeque<Change>,
    subscribers: Vec<Subscriber>,
}

pub struct EventLog {
    epoch: String,
    inner: Mutex<Inner>,
    queue: usize,
}

/// What a new subscriber starts from.
pub enum Start {
    /// Send a snapshot whose cursor is `cursor`, then the receiver's events.
    Snapshot { cursor: String },
    /// The receiver already holds every event after the client's cursor.
    Resume,
}

pub struct Subscription {
    pub start: Start,
    pub rx: mpsc::Receiver<Change>,
    /// Set when the subscriber was dropped for falling behind; the stream ends
    /// with a `resnapshot` event rather than silently.
    pub overflowed: Arc<AtomicBool>,
}

impl EventLog {
    pub fn new(epoch: String) -> Self {
        Self::with_queue(epoch, SUBSCRIBER_QUEUE)
    }

    pub fn with_queue(epoch: String, queue: usize) -> Self {
        Self {
            epoch,
            inner: Mutex::new(Inner {
                seq: 0,
                ring: VecDeque::new(),
                subscribers: Vec::new(),
            }),
            queue,
        }
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    pub fn cursor(&self) -> String {
        format!("{}:{}", self.epoch, self.inner.lock().unwrap().seq)
    }

    pub fn publish(&self, store: &str, scope: &str, id: &str) -> String {
        let mut inner = self.inner.lock().unwrap();
        inner.seq += 1;
        let change = Change {
            seq: inner.seq,
            cursor: format!("{}:{}", self.epoch, inner.seq),
            store: store.to_string(),
            scope: scope.to_string(),
            id: id.to_string(),
        };
        inner.ring.push_back(change.clone());
        while inner.ring.len() > REPLAY_WINDOW {
            inner.ring.pop_front();
        }
        inner
            .subscribers
            .retain(|sub| match sub.tx.try_send(change.clone()) {
                Ok(()) => true,
                Err(mpsc::error::TrySendError::Full(_)) => {
                    sub.overflowed.store(true, Ordering::Release);
                    false
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            });
        change.cursor
    }

    /// Register a subscriber. With a cursor from this epoch that is still
    /// inside the replay window, the missed events are queued under the same
    /// lock that orders new ones; otherwise the caller must send a snapshot
    /// built *after* this returns, labelled with the returned watermark. A
    /// write racing the snapshot is then either in it or queued after it.
    pub fn subscribe(&self, cursor: Option<&str>) -> Subscription {
        let (tx, rx) = mpsc::channel(self.queue);
        let overflowed = Arc::new(AtomicBool::new(false));
        let mut inner = self.inner.lock().unwrap();
        let resume_from = cursor
            .and_then(|c| c.rsplit_once(':'))
            .filter(|(epoch, _)| *epoch == self.epoch)
            .and_then(|(_, seq)| seq.parse::<u64>().ok())
            .filter(|seq| *seq <= inner.seq)
            .filter(|seq| match inner.ring.front() {
                Some(oldest) => *seq + 1 >= oldest.seq,
                None => true,
            });
        let start = match resume_from {
            Some(seq) => {
                for change in inner.ring.iter().filter(|c| c.seq > seq) {
                    // Cannot be full: the queue is larger than the window.
                    let _ = tx.try_send(change.clone());
                }
                Start::Resume
            }
            None => Start::Snapshot {
                cursor: format!("{}:{}", self.epoch, inner.seq),
            },
        };
        inner.subscribers.push(Subscriber {
            tx,
            overflowed: overflowed.clone(),
        });
        Subscription {
            start,
            rx,
            overflowed,
        }
    }
}

/// The core stores publish through this; the service names their channel.
pub struct LogSink(pub Arc<EventLog>);

impl EventSink for LogSink {
    fn publish(&self, change: StoreChange) {
        self.0
            .publish(change.store.as_str(), &change.scope, &change.id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resumes_inside_the_window_and_snapshots_outside_it() {
        let log = EventLog::new("e1".into());
        for i in 0..5 {
            log.publish("mesh", "", &format!("m{i}"));
        }
        let mut sub = log.subscribe(Some("e1:3"));
        assert!(matches!(sub.start, Start::Resume));
        assert_eq!(sub.rx.try_recv().unwrap().cursor, "e1:4");
        assert_eq!(sub.rx.try_recv().unwrap().cursor, "e1:5");
        assert!(sub.rx.try_recv().is_err());
        log.publish("attention", "", "a1");
        assert_eq!(sub.rx.try_recv().unwrap().cursor, "e1:6");

        // Another epoch, a cursor from the future, or garbage: snapshot.
        for cursor in ["e0:3", "e1:99", "nonsense", ""] {
            match log.subscribe(Some(cursor)).start {
                Start::Snapshot { cursor } => assert_eq!(cursor, "e1:6"),
                Start::Resume => panic!("{cursor} must not resume"),
            }
        }
    }

    #[test]
    fn a_cursor_older_than_the_window_needs_a_snapshot() {
        let log = EventLog::new("e".into());
        for _ in 0..REPLAY_WINDOW + 10 {
            log.publish("mesh", "", "");
        }
        assert!(matches!(
            log.subscribe(Some("e:5")).start,
            Start::Snapshot { .. }
        ));
        assert!(matches!(
            log.subscribe(Some(&format!("e:{}", 10))).start,
            Start::Resume
        ));
    }

    #[test]
    fn a_slow_subscriber_is_dropped_and_flagged() {
        let log = EventLog::with_queue("e".into(), 2);
        let mut sub = log.subscribe(None);
        for _ in 0..3 {
            log.publish("mesh", "", "");
        }
        assert!(sub.overflowed.load(Ordering::Acquire));
        assert!(sub.rx.try_recv().is_ok());
        assert!(sub.rx.try_recv().is_ok());
        // The sender is gone: the reader sees the end and resnapshots.
        assert!(matches!(
            sub.rx.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        ));
    }
}

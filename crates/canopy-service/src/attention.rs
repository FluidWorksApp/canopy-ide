//! Persisted attention (protocol §5): fyi items and questions with deadlines.
//!
//! Each item is one JSON file under `attention/`, so a restart keeps pending
//! questions and their deadlines. A question resolves exactly once — the first
//! answer or its expiry — and expiry is never read as consent.

use crate::stream::EventLog;
use crate::util::{now_ms, random_hex, write_private};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::Notify;

pub const DEFAULT_ASK: Duration = Duration::from_secs(10 * 60);
pub const MAX_ASK: Duration = Duration::from_secs(60 * 60);
/// Resolved items kept for the IDE's history; pending ones are never pruned.
const MAX_RESOLVED: usize = 500;
pub const STORE: &str = "attention";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttentionItem {
    pub id: String,
    /// fyi | question
    pub kind: String,
    pub title: String,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choices: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<u64>,
    pub created_ms: u64,
    /// `{answer, actor, atMs}` or `{expired:true}`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<serde_json::Value>,
    /// Which terminal raised it, so the IDE can take the user there.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pty_id: Option<u32>,
    /// ask | confirm, for questions; the info/warn level for an fyi.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    /// The asking terminal's identity key, so a re-ask by request id can only
    /// rejoin that terminal's own question.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_key: Option<String>,
}

impl AttentionItem {
    pub fn pending(&self) -> bool {
        self.kind == "question" && self.resolution.is_none()
    }
}

pub struct NewQuestion {
    pub request_id: Option<String>,
    pub owner_key: String,
    pub pty_id: Option<u32>,
    pub op: String,
    pub title: String,
    pub body: String,
    pub choices: Option<Vec<String>>,
    pub timeout: Duration,
}

pub enum AnswerError {
    Unknown,
    /// One response wins; this carries the one that did.
    AlreadyResolved(serde_json::Value),
}

pub struct AttentionStore {
    dir: PathBuf,
    items: Mutex<BTreeMap<String, AttentionItem>>,
    notify: Notify,
    events: Arc<EventLog>,
}

impl AttentionStore {
    pub fn open(dir: PathBuf, events: Arc<EventLog>) -> Self {
        let mut items = BTreeMap::new();
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Some(item) = std::fs::read(&path)
                    .ok()
                    .and_then(|raw| serde_json::from_slice::<AttentionItem>(&raw).ok())
                {
                    items.insert(item.id.clone(), item);
                }
            }
        }
        let store = Self {
            dir,
            items: Mutex::new(items),
            notify: Notify::new(),
            events,
        };
        store.expire_due(now_ms());
        store
    }

    fn persist(&self, item: &AttentionItem) {
        let path = self.dir.join(format!("{}.json", item.id));
        if let Ok(bytes) = serde_json::to_vec_pretty(item) {
            if let Err(error) = write_private(&path, &bytes, 0o600) {
                eprintln!("canopy-serviced: attention write failed: {error}");
            }
        }
    }

    fn prune(&self, items: &mut BTreeMap<String, AttentionItem>) {
        let mut resolved: Vec<(u64, String)> = items
            .values()
            .filter(|i| !i.pending())
            .map(|i| (i.created_ms, i.id.clone()))
            .collect();
        if resolved.len() <= MAX_RESOLVED {
            return;
        }
        resolved.sort();
        let excess = resolved.len() - MAX_RESOLVED;
        for (_, id) in resolved.into_iter().take(excess) {
            items.remove(&id);
            let _ = std::fs::remove_file(self.dir.join(format!("{id}.json")));
        }
    }

    pub fn fyi(&self, title: &str, body: &str, level: &str, pty_id: Option<u32>) -> AttentionItem {
        let item = AttentionItem {
            id: format!("a{}", random_hex(8)),
            kind: "fyi".into(),
            title: title.into(),
            body: body.into(),
            choices: None,
            deadline_ms: None,
            created_ms: now_ms(),
            resolution: None,
            pty_id,
            op: None,
            level: Some(level.into()),
            owner_key: None,
        };
        let mut items = self.items.lock().unwrap();
        self.persist(&item);
        items.insert(item.id.clone(), item.clone());
        self.prune(&mut items);
        drop(items);
        self.events.publish(STORE, "fyi", &item.id);
        item
    }

    /// Create a question, or rejoin the caller's own question with the same
    /// request id — the retry an agent makes after the service restarted
    /// under its open connection.
    pub fn ask(&self, new: NewQuestion) -> AttentionItem {
        let mut items = self.items.lock().unwrap();
        if let Some(request) = new.request_id.as_deref() {
            let id = format!("q{request}");
            if let Some(existing) = items.get(&id) {
                if existing.owner_key.as_deref() == Some(new.owner_key.as_str()) {
                    return existing.clone();
                }
            }
        }
        let id = match new.request_id.as_deref() {
            Some(request) if !items.contains_key(&format!("q{request}")) => format!("q{request}"),
            _ => format!("q{}", random_hex(8)),
        };
        let created = now_ms();
        let item = AttentionItem {
            id: id.clone(),
            kind: "question".into(),
            title: new.title,
            body: new.body,
            choices: new.choices,
            deadline_ms: Some(created + new.timeout.as_millis() as u64),
            created_ms: created,
            resolution: None,
            pty_id: new.pty_id,
            op: Some(new.op),
            level: None,
            owner_key: Some(new.owner_key),
        };
        self.persist(&item);
        items.insert(id.clone(), item.clone());
        drop(items);
        self.events.publish(STORE, "question", &id);
        item
    }

    pub fn get(&self, id: &str) -> Option<AttentionItem> {
        self.items.lock().unwrap().get(id).cloned()
    }

    pub fn list(&self) -> Vec<AttentionItem> {
        let mut all: Vec<AttentionItem> = self.items.lock().unwrap().values().cloned().collect();
        all.sort_by_key(|i| i.created_ms);
        all
    }

    fn resolve(&self, id: &str, resolution: serde_json::Value) -> Result<(), AnswerError> {
        let mut items = self.items.lock().unwrap();
        let item = items.get_mut(id).ok_or(AnswerError::Unknown)?;
        if let Some(existing) = &item.resolution {
            return Err(AnswerError::AlreadyResolved(existing.clone()));
        }
        item.resolution = Some(resolution);
        let item = item.clone();
        self.persist(&item);
        self.prune(&mut items);
        drop(items);
        self.notify.notify_waiters();
        self.events.publish(STORE, &item.kind, id);
        Ok(())
    }

    pub fn answer(
        &self,
        id: &str,
        answer: serde_json::Value,
        actor: &str,
    ) -> Result<(), AnswerError> {
        let kind = self.get(id).map(|i| i.kind).ok_or(AnswerError::Unknown)?;
        let resolution = if kind == "question" {
            serde_json::json!({ "answer": answer, "actor": actor, "atMs": now_ms() })
        } else {
            serde_json::json!({ "answer": "ack", "actor": actor, "atMs": now_ms() })
        };
        self.resolve(id, resolution)
    }

    /// Expire every pending question whose deadline has passed. Driven by the
    /// workspace sweeper and by each waiter at its own deadline.
    pub fn expire_due(&self, now: u64) {
        let due: Vec<String> = self
            .items
            .lock()
            .unwrap()
            .values()
            .filter(|i| i.pending() && i.deadline_ms.is_some_and(|d| d <= now))
            .map(|i| i.id.clone())
            .collect();
        for id in due {
            let _ = self.resolve(&id, serde_json::json!({ "expired": true }));
        }
    }

    /// Hold until the question resolves or its deadline passes, then return
    /// the resolution. Never longer than the persisted deadline.
    pub async fn wait(&self, id: &str) -> Option<serde_json::Value> {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let item = self.get(id)?;
            if let Some(resolution) = item.resolution {
                return Some(resolution);
            }
            let deadline = item.deadline_ms.unwrap_or(0);
            let now = now_ms();
            if deadline <= now {
                self.expire_due(now);
                continue;
            }
            tokio::select! {
                _ = &mut notified => {}
                _ = tokio::time::sleep(Duration::from_millis(deadline - now)) => {
                    self.expire_due(now_ms());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question(timeout_ms: u64, request: Option<&str>) -> NewQuestion {
        NewQuestion {
            request_id: request.map(str::to_string),
            owner_key: "pty:remote-w:1".into(),
            pty_id: Some(1),
            op: "ask".into(),
            title: "Which?".into(),
            body: "Pick one".into(),
            choices: Some(vec!["a".into(), "b".into()]),
            timeout: Duration::from_millis(timeout_ms),
        }
    }

    #[tokio::test]
    async fn the_first_answer_wins_and_expiry_is_not_consent() {
        let dir = tempfile::tempdir().unwrap();
        let log = Arc::new(EventLog::new("e".into()));
        let store = AttentionStore::open(dir.path().into(), log.clone());
        let q = store.ask(question(60_000, None));
        assert!(store.answer(&q.id, "a".into(), "u1").is_ok());
        assert!(matches!(
            store.answer(&q.id, "b".into(), "u2"),
            Err(AnswerError::AlreadyResolved(_))
        ));
        assert_eq!(store.wait(&q.id).await.unwrap()["answer"], "a");

        let q = store.ask(question(50, None));
        assert_eq!(
            store.wait(&q.id).await.unwrap(),
            serde_json::json!({ "expired": true })
        );
        assert!(matches!(
            store.answer(&q.id, "a".into(), "u1"),
            Err(AnswerError::AlreadyResolved(_))
        ));
    }

    #[tokio::test]
    async fn questions_survive_reopen_and_rejoin_by_request_id() {
        let dir = tempfile::tempdir().unwrap();
        let log = Arc::new(EventLog::new("e".into()));
        let first = AttentionStore::open(dir.path().into(), log.clone());
        let q = first.ask(question(60_000, Some("r1")));
        drop(first);
        let second = AttentionStore::open(dir.path().into(), log);
        let again = second.ask(question(60_000, Some("r1")));
        assert_eq!(again.id, q.id);
        assert_eq!(again.deadline_ms, q.deadline_ms);
        second.answer(&q.id, "b".into(), "u").ok().unwrap();
        assert_eq!(second.wait(&q.id).await.unwrap()["answer"], "b");
    }
}

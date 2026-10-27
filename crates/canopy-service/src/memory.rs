//! Team memory for a cloud workspace's agents (`canopy_memory`,
//! `canopy_memory_propose`).
//!
//! The ledger that holds team memory is the desktop's (~/.canopy/ledger). The
//! desktop syncs a copy of what agents may be told — approved, in date, not
//! quarantined — to this service each time it connects and whenever a memory
//! changes (`memory_sync`), and retrieval answers from that copy with the
//! desktop's own rules (canopy-core `memory`). An agent's proposal is queued
//! here durably until the desktop takes it into its ledger as "proposed"
//! (`memory_ack`); nothing proposed is ever served from here.

use crate::util::{now_ms, random_hex, write_private};
use canopy_core::memory::{
    proposal_data, select, servable, validate_proposal, MemoryQuery, Proposal, SyncedEntry,
    PROPOSED_NOTE,
};
use std::path::PathBuf;
use std::sync::Mutex;

/// Proposals kept while the desktop is away; the oldest go first.
const MAX_QUEUED: usize = 500;
/// The most entries one sync may carry (the desktop queries at most 5000).
const MAX_SYNCED: usize = 5000;

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncedCopy {
    /// The desktop ledger root the copy came from.
    pub root: String,
    pub synced_ms: u64,
    pub entries: Vec<SyncedEntry>,
}

/// An agent's proposal waiting for the desktop: everything its ledger entry
/// needs, in the desktop's `proposal_entry` shape.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedProposal {
    pub memory_id: String,
    pub pty_id: u32,
    /// The proposing terminal's name, when it has one.
    #[serde(default)]
    pub terminal: Option<String>,
    /// The directory the agent proposed from, so the desktop files it under
    /// that project's ledger.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Who the agent said it is (`by`), "agent" when unnamed.
    pub by: String,
    pub scope: String,
    pub subject: String,
    pub data: serde_json::Value,
    pub expires_at: u64,
    pub proposed_ms: u64,
}

pub struct MemoryStore {
    dir: PathBuf,
    synced: Mutex<Option<SyncedCopy>>,
    queue: Mutex<Vec<QueuedProposal>>,
}

impl MemoryStore {
    pub fn open(dir: PathBuf) -> Self {
        let synced = std::fs::read(dir.join("memory.json"))
            .ok()
            .and_then(|raw| serde_json::from_slice::<SyncedCopy>(&raw).ok());
        let queue = std::fs::read(dir.join("memory-proposals.json"))
            .ok()
            .and_then(|raw| serde_json::from_slice::<Vec<QueuedProposal>>(&raw).ok())
            .unwrap_or_default();
        Self {
            dir,
            synced: Mutex::new(synced),
            queue: Mutex::new(queue),
        }
    }

    fn save<T: serde::Serialize>(&self, name: &str, value: &T) -> Result<(), String> {
        let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
        write_private(&self.dir.join(name), &bytes, 0o600).map_err(|e| e.to_string())
    }

    /// Replace the copy with what the desktop sent. Only memory entries are
    /// kept; the rest of the ledger never leaves the desktop through here.
    pub fn sync(&self, root: &str, entries: &[serde_json::Value]) -> Result<usize, String> {
        if entries.len() > MAX_SYNCED {
            return Err(format!("memory_sync carries at most {MAX_SYNCED} entries"));
        }
        let now = now_ms();
        let kept: Vec<SyncedEntry> = entries
            .iter()
            .filter_map(|e| serde_json::from_value::<SyncedEntry>(e.clone()).ok())
            .filter(|e| servable(e, now))
            .collect();
        let copy = SyncedCopy {
            root: root.to_string(),
            synced_ms: now,
            entries: kept,
        };
        let count = copy.entries.len();
        self.save("memory.json", &copy)?;
        *self.synced.lock().unwrap() = Some(copy);
        Ok(count)
    }

    pub fn list(&self) -> Vec<SyncedEntry> {
        self.synced
            .lock()
            .unwrap()
            .as_ref()
            .map(|c| c.entries.clone())
            .unwrap_or_default()
    }

    /// `canopy_memory`: the desktop's answer, from the synced copy.
    pub fn query(&self, q: &MemoryQuery, now: u64) -> serde_json::Value {
        let synced = self.synced.lock().unwrap();
        match synced.as_ref() {
            Some(copy) => select(&copy.entries, q, now),
            None => serde_json::json!({
                "memories": [],
                "matched": 0,
                "note": "Team memory hasn't been synced to this cloud workspace yet: it arrives \
                         from the Canopy desktop app the next time someone opens this workspace \
                         there. Decide on the evidence in front of you; if the decision is durable \
                         and non-obvious, propose it with canopy_memory_propose.",
            }),
        }
    }

    /// `canopy_memory_propose`: validated exactly as the desktop does, then
    /// queued for the desktop's ledger.
    pub fn propose(
        &self,
        p: &Proposal,
        pty_id: u32,
        terminal: Option<String>,
        cwd: Option<String>,
        now: u64,
    ) -> Result<serde_json::Value, String> {
        let v = validate_proposal(p, now)?;
        let memory_id = format!("mem-{now:x}-{}", random_hex(4));
        let queued = QueuedProposal {
            memory_id: memory_id.clone(),
            pty_id,
            terminal,
            cwd: cwd.filter(|c| !c.trim().is_empty()),
            by: v.by.clone(),
            scope: v.scope.clone(),
            subject: v.subject.clone(),
            data: proposal_data(&v, &memory_id, now),
            expires_at: v.expires_at,
            proposed_ms: now,
        };
        let mut queue = self.queue.lock().unwrap();
        queue.push(queued);
        let overflow = queue.len().saturating_sub(MAX_QUEUED);
        queue.drain(..overflow);
        self.save("memory-proposals.json", &*queue)?;
        Ok(serde_json::json!({
            "id": memory_id,
            "status": "proposed",
            "note": PROPOSED_NOTE,
        }))
    }

    pub fn proposals(&self) -> Vec<QueuedProposal> {
        self.queue.lock().unwrap().clone()
    }

    /// The desktop recorded these; drop them. Returns how many went.
    pub fn ack(&self, ids: &[String]) -> Result<usize, String> {
        let mut queue = self.queue.lock().unwrap();
        let before = queue.len();
        queue.retain(|q| !ids.contains(&q.memory_id));
        let removed = before - queue.len();
        if removed > 0 {
            self.save("memory-proposals.json", &*queue)?;
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, text: &str, status: &str) -> serde_json::Value {
        let now = now_ms();
        serde_json::json!({
            "id": format!("e-{id}"), "kind": "memory", "ts": now, "root": "/Users/a/repo",
            "author": { "kind": "human", "name": "Ash", "sessionId": "s1" }, "scope": "project",
            "subject": text,
            "data": { "memoryId": id, "type": "decision", "text": text, "why": "", "confidence": 0.8,
                      "createdAt": now, "source": "human", "provenance": { "files": [] } },
            "expiresAt": now + 86_400_000, "status": status
        })
    }

    fn store() -> (tempfile::TempDir, MemoryStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = MemoryStore::open(dir.path().to_path_buf());
        (dir, store)
    }

    #[test]
    fn unsynced_query_says_so_instead_of_failing() {
        let (_dir, s) = store();
        let out = s.query(&MemoryQuery::default(), now_ms());
        assert_eq!(out["matched"], 0);
        assert!(out["note"].as_str().unwrap().contains("hasn't been synced"));
    }

    #[test]
    fn sync_keeps_only_servable_memory_and_survives_a_restart() {
        let (dir, s) = store();
        let mut plan = entry("p1", "A plan that is not memory", "approved");
        plan["kind"] = "plan".into();
        let count = s
            .sync(
                "/Users/a/repo",
                &[
                    entry("m1", "Billing calls go through the queue", "approved"),
                    entry("m2", "Billing is quarantined text", "quarantined"),
                    plan,
                ],
            )
            .unwrap();
        assert_eq!(count, 1);
        let reopened = MemoryStore::open(dir.path().to_path_buf());
        let out = reopened.query(
            &MemoryQuery {
                query: "billing".into(),
                ..Default::default()
            },
            now_ms(),
        );
        assert_eq!(out["matched"], 1);
        assert_eq!(out["memories"][0]["id"], "m1");
        assert_eq!(out["memories"][0]["author"], "Ash");
        assert_eq!(reopened.list().len(), 1);
    }

    #[test]
    fn proposals_queue_until_acknowledged_and_are_never_served() {
        let (dir, s) = store();
        let bad = s.propose(
            &Proposal {
                kind: "opinion".into(),
                text: "Tabs are better than spaces".into(),
                ..Default::default()
            },
            3,
            None,
            None,
            now_ms(),
        );
        assert!(bad.unwrap_err().starts_with("type must be one of"));
        let ok = s
            .propose(
                &Proposal {
                    kind: "constraint".into(),
                    text: "Never call the billing API from a request handler".into(),
                    files: vec!["src/billing.ts".into()],
                    by: Some("Ash".into()),
                    ..Default::default()
                },
                3,
                Some("api agent".into()),
                Some("/workspace/api".into()),
                now_ms(),
            )
            .unwrap();
        assert_eq!(ok["status"], "proposed");
        let id = ok["id"].as_str().unwrap().to_string();
        let queued = MemoryStore::open(dir.path().to_path_buf()).proposals();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].memory_id, id);
        assert_eq!(queued[0].pty_id, 3);
        assert_eq!(queued[0].by, "Ash");
        assert_eq!(queued[0].cwd.as_deref(), Some("/workspace/api"));
        assert_eq!(queued[0].data["source"], "agent");
        assert_eq!(queued[0].data["provenance"]["files"][0], "src/billing.ts");
        // A proposal is not memory until a person approves it on the desktop.
        assert_eq!(
            s.query(
                &MemoryQuery {
                    query: "billing".into(),
                    ..Default::default()
                },
                now_ms()
            )["matched"],
            0
        );
        assert_eq!(s.ack(&[id]).unwrap(), 1);
        assert!(s.proposals().is_empty());
        assert!(MemoryStore::open(dir.path().to_path_buf())
            .proposals()
            .is_empty());
    }
}

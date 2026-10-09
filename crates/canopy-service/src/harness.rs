//! The seam for stores whose handlers move into canopy-core separately: notes
//! and research. The service owns routing, identity and storage roots; the
//! handler owns the store's rules. Until the shared `/ctx/notes` and
//! `/ctx/research` handlers land in core, `NotImplemented` answers every call
//! with the protocol's 503, never a hang and never a fake success.

use crate::stream::EventLog;
use std::path::PathBuf;
use std::sync::Arc;

/// The terminal a harness call acts for, established from its credential.
#[derive(Clone, Debug)]
pub struct HarnessCaller {
    pub pty_id: u32,
    pub instance: String,
    pub cwd: String,
    pub key: String,
}

/// Everything a store handler may touch for one workspace.
pub struct HarnessContext {
    pub workspace_id: String,
    pub project_id: String,
    pub project_name: String,
    pub project_root: String,
    pub notes_dir: PathBuf,
    pub research_dir: PathBuf,
    /// Publish `(store, scope, id)` invalidations after a write.
    pub events: Arc<EventLog>,
}

pub struct HarnessReply {
    pub status: u16,
    pub body: String,
}

impl HarnessReply {
    pub fn unavailable(reason: &str, message: &str) -> Self {
        Self {
            status: 503,
            body: serde_json::json!({
                "error": "unavailable",
                "reason": reason,
                "message": message,
            })
            .to_string(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HarnessStore {
    Notes,
    Research,
}

impl HarnessStore {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "notes" => Some(Self::Notes),
            "research" => Some(Self::Research),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Notes => "notes",
            Self::Research => "research",
        }
    }
}

pub trait Harness: Send + Sync {
    /// `POST /ctx/notes` or `/ctx/research` from an agent, body as received.
    fn agent_op(
        &self,
        ctx: &HarnessContext,
        store: HarnessStore,
        caller: &HarnessCaller,
        body: serde_json::Value,
    ) -> HarnessReply;
    /// Admin `query` (reads only).
    fn query(
        &self,
        ctx: &HarnessContext,
        store: HarnessStore,
        action: &str,
        args: serde_json::Value,
    ) -> HarnessReply;
    /// Admin `notes_write` / `research_write`, acting for `actor`.
    fn user_write(
        &self,
        ctx: &HarnessContext,
        store: HarnessStore,
        actor: &str,
        body: serde_json::Value,
    ) -> HarnessReply;
    /// The store's part of a stream snapshot.
    fn snapshot(&self, ctx: &HarnessContext, store: HarnessStore) -> serde_json::Value;
}

pub struct NotImplemented;

impl NotImplemented {
    fn reply(store: HarnessStore) -> HarnessReply {
        HarnessReply::unavailable(
            "not-implemented",
            &format!(
                "Canopy {} is not served by this cloud service yet.",
                store.as_str()
            ),
        )
    }
}

impl Harness for NotImplemented {
    fn agent_op(
        &self,
        _: &HarnessContext,
        store: HarnessStore,
        _: &HarnessCaller,
        _: serde_json::Value,
    ) -> HarnessReply {
        Self::reply(store)
    }
    fn query(
        &self,
        _: &HarnessContext,
        store: HarnessStore,
        _: &str,
        _: serde_json::Value,
    ) -> HarnessReply {
        Self::reply(store)
    }
    fn user_write(
        &self,
        _: &HarnessContext,
        store: HarnessStore,
        _: &str,
        _: serde_json::Value,
    ) -> HarnessReply {
        Self::reply(store)
    }
    fn snapshot(&self, _: &HarnessContext, _: HarnessStore) -> serde_json::Value {
        serde_json::Value::Null
    }
}

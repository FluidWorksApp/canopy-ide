//! Notes and research: the service owns routing, identity and storage roots;
//! canopy-core's shared handlers own each store's rules. `CoreHarness` is the
//! daemon's implementation; `NotImplemented` answers the protocol's 503 and
//! remains for embedders that do not serve these stores.

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

/// Notes and research served by canopy-core's shared handlers, one store pair
/// per workspace under `<state>/ws/<ws>/{notes,research}`.
#[derive(Default)]
pub struct CoreHarness {
    stores: std::sync::Mutex<
        std::collections::HashMap<
            String,
            (
                Arc<canopy_core::notes::NotesStore>,
                Arc<canopy_core::research::ResearchStore>,
            ),
        >,
    >,
}

fn reply_of(result: Result<serde_json::Value, String>) -> HarnessReply {
    match result {
        Ok(value) => HarnessReply {
            status: 200,
            body: value.to_string(),
        },
        // A tool failure the agent reads and corrects against, as on desktop.
        Err(text) => HarnessReply {
            status: 400,
            body: text,
        },
    }
}

impl CoreHarness {
    fn stores(
        &self,
        ctx: &HarnessContext,
    ) -> (
        Arc<canopy_core::notes::NotesStore>,
        Arc<canopy_core::research::ResearchStore>,
    ) {
        self.stores
            .lock()
            .unwrap()
            .entry(ctx.workspace_id.clone())
            .or_insert_with(|| {
                let sink: Arc<dyn canopy_core::events::EventSink> =
                    Arc::new(crate::stream::LogSink(ctx.events.clone()));
                (
                    Arc::new(canopy_core::notes::NotesStore::new(
                        Some(ctx.notes_dir.clone()),
                        sink.clone(),
                        // No OS scheduler on a host: reminders are in-app only.
                        Arc::new(canopy_core::notes::InAppReminders),
                    )),
                    Arc::new(canopy_core::research::ResearchStore::new(
                        Some(ctx.research_dir.clone()),
                        sink,
                    )),
                )
            })
            .clone()
    }

    /// Run one request as the desktop bridge would, with the project and the
    /// caller's directory fixed by the service rather than the body.
    fn run(
        &self,
        ctx: &HarnessContext,
        store: HarnessStore,
        mut body: serde_json::Value,
        caller: Option<&HarnessCaller>,
    ) -> HarnessReply {
        let Some(object) = body.as_object_mut() else {
            return HarnessReply {
                status: 400,
                body: "request body must be an object".into(),
            };
        };
        object.insert("cwd".into(), ctx.project_root.clone().into());
        object.remove("project");
        if let Some(caller) = caller {
            if store == HarnessStore::Research {
                object.insert("pty_id".into(), caller.pty_id.into());
                object.insert("instance".into(), caller.instance.clone().into());
            }
        }
        let roots = vec![ctx.project_root.clone()];
        let project = canopy_core::project::Project {
            id: &ctx.project_id,
            name: &ctx.project_name,
            roots: &roots,
        };
        let (notes, research) = self.stores(ctx);
        match store {
            HarnessStore::Notes => {
                let req: canopy_core::notes::NotesReq = match serde_json::from_value(body) {
                    Ok(req) => req,
                    Err(error) => {
                        return HarnessReply {
                            status: 400,
                            body: error.to_string(),
                        }
                    }
                };
                // Attachments name container paths, which the host cannot
                // read; refuse clearly rather than read a host file.
                let scope = |_: &std::path::Path| -> Result<PathBuf, String> {
                    Err(
                        "Attaching files is not available in a cloud workspace yet; put the \
                         path or its contents in the note text instead."
                            .to_string(),
                    )
                };
                reply_of(canopy_core::notes::op(&notes, project, &req, &scope))
            }
            HarnessStore::Research => {
                let req: canopy_core::research::ResearchReq = match serde_json::from_value(body) {
                    Ok(req) => req,
                    Err(error) => {
                        return HarnessReply {
                            status: 400,
                            body: error.to_string(),
                        }
                    }
                };
                reply_of(canopy_core::research::op(&research, project, &req))
            }
        }
    }

    fn list(
        &self,
        ctx: &HarnessContext,
        store: HarnessStore,
        args: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let (notes, research) = self.stores(ctx);
        let statuses = args
            .get("statuses")
            .and_then(|s| serde_json::from_value::<Vec<String>>(s.clone()).ok());
        let limit = args
            .get("limit")
            .and_then(|l| l.as_u64())
            .map(|l| l as usize);
        let rows = match store {
            HarnessStore::Notes => {
                serde_json::to_value(notes.list(ctx.project_id.clone(), statuses, limit)?)
            }
            HarnessStore::Research => {
                serde_json::to_value(research.list(ctx.project_id.clone(), statuses, limit)?)
            }
        };
        rows.map_err(|e| e.to_string())
    }
}

impl Harness for CoreHarness {
    fn agent_op(
        &self,
        ctx: &HarnessContext,
        store: HarnessStore,
        caller: &HarnessCaller,
        body: serde_json::Value,
    ) -> HarnessReply {
        self.run(ctx, store, body, Some(caller))
    }

    fn query(
        &self,
        ctx: &HarnessContext,
        store: HarnessStore,
        action: &str,
        args: serde_json::Value,
    ) -> HarnessReply {
        match action {
            "list" => match self.list(ctx, store, &args) {
                Ok(rows) => HarnessReply {
                    status: 200,
                    body: serde_json::json!({ "items": rows }).to_string(),
                },
                Err(error) => HarnessReply {
                    status: 500,
                    body: serde_json::json!({ "error": error }).to_string(),
                },
            },
            "get" | "search" => {
                let mut body = args;
                if !body.is_object() {
                    body = serde_json::json!({});
                }
                body["action"] = action.into();
                self.run(ctx, store, body, None)
            }
            other => HarnessReply {
                status: 400,
                body: serde_json::json!({ "error": format!("no query {other} on {}", store.as_str()) })
                    .to_string(),
            },
        }
    }

    fn user_write(
        &self,
        ctx: &HarnessContext,
        store: HarnessStore,
        actor: &str,
        mut body: serde_json::Value,
    ) -> HarnessReply {
        if let Some(object) = body.as_object_mut() {
            object.remove("kind");
            object.remove("actor");
            object.entry("by").or_insert_with(|| actor.into());
        }
        self.run(ctx, store, body, None)
    }

    fn snapshot(&self, ctx: &HarnessContext, store: HarnessStore) -> serde_json::Value {
        self.list(ctx, store, &serde_json::json!({}))
            .unwrap_or_else(|_| serde_json::json!([]))
    }
}

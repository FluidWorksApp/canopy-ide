//! Terminal operations needed by mesh delivery. Execution ownership stays in
//! the adapter; the core never reaches into Tauri state or spawns a runtime.

use crate::mesh::MeshStore;
use std::time::Duration;

pub const SUBMIT_DELAY: Duration = Duration::from_millis(250);

/// Numeric IDs can be reused after a runner restart. Bind both writes to the
/// same runtime and child generation, not whichever terminal has that ID later.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerminalTarget {
    pub id: u32,
    pub instance: String,
    pub generation: u64,
}

pub trait Terminals: Send + Sync {
    fn resolve(&self, id: u32) -> Result<TerminalTarget, String>;
    /// Validate the complete target and enqueue bytes against that same child.
    /// Success means queued input, not proof that the agent executed it.
    fn write(&self, target: &TerminalTarget, data: &str) -> Result<(), String>;
}

/// Existing desktop agent:message payload, also usable by a headless subscriber.
#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryReceipt {
    pub id: String,
    pub to_pty_id: u32,
    pub to_cwd: String,
    pub submitted: bool,
}

/// The caller owns scheduling: a successful begin must be followed by finish on
/// its runtime. Dropping this value leaves the message unsubmitted. There is no
/// automatic retry because the body may already be in the terminal composer.
pub struct PendingDelivery {
    target: TerminalTarget,
    receipt: DeliveryReceipt,
}

impl PendingDelivery {
    pub fn begin(
        terminals: &dyn Terminals,
        id: u32,
        target_cwd: String,
        message_id: String,
        line: &str,
    ) -> Result<Self, String> {
        let target = terminals.resolve(id)?;
        terminals.write(&target, line)?;
        Ok(Self {
            target,
            receipt: DeliveryReceipt {
                id: message_id,
                to_pty_id: id,
                to_cwd: target_cwd,
                submitted: false,
            },
        })
    }

    pub async fn finish(mut self, terminals: &dyn Terminals, mesh: &MeshStore) -> DeliveryReceipt {
        tokio::time::sleep(SUBMIT_DELAY).await;
        self.receipt.submitted = terminals.write(&self.target, "\r").is_ok();
        if self.receipt.submitted {
            mesh.mark_submitted(&self.receipt.id);
        }
        self.receipt
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::NoopEventSink;
    use std::sync::{Arc, Mutex};
    use tokio::time::Instant;

    struct FakeTerminals {
        generation: Mutex<u64>,
        writes: Mutex<Vec<(Instant, String)>>,
    }
    impl FakeTerminals {
        fn new() -> Self {
            Self {
                generation: Mutex::new(1),
                writes: Mutex::new(Vec::new()),
            }
        }
    }
    impl Terminals for FakeTerminals {
        fn resolve(&self, id: u32) -> Result<TerminalTarget, String> {
            Ok(TerminalTarget {
                id,
                instance: "test".into(),
                generation: *self.generation.lock().unwrap(),
            })
        }
        fn write(&self, target: &TerminalTarget, data: &str) -> Result<(), String> {
            if target.generation != *self.generation.lock().unwrap() {
                return Err("terminal replaced".into());
            }
            self.writes
                .lock()
                .unwrap()
                .push((Instant::now(), data.into()));
            Ok(())
        }
    }

    #[tokio::test(start_paused = true)]
    async fn body_and_return_are_separate_writes_at_least_250ms_apart() {
        let terminals = FakeTerminals::new();
        let mesh = MeshStore::with_events(None, Arc::new(NoopEventSink));
        let message = mesh
            .record(crate::mesh::tests::new_msg("hello", 7))
            .unwrap();
        let pending =
            PendingDelivery::begin(&terminals, 7, "/repo".into(), "m1".into(), "hello").unwrap();
        assert_eq!(terminals.writes.lock().unwrap().len(), 1);
        let receipt = pending.finish(&terminals, &mesh).await;
        assert!(receipt.submitted);
        assert!(mesh.get(&message.id).unwrap().submitted);
        let writes = terminals.writes.lock().unwrap();
        assert_eq!(writes.len(), 2);
        assert_eq!(writes[0].1, "hello");
        assert_eq!(writes[1].1, "\r");
        assert!(writes[1].0.duration_since(writes[0].0) >= SUBMIT_DELAY);
        assert_eq!(
            serde_json::to_value(receipt).unwrap(),
            serde_json::json!({"id":"m1","toPtyId":7,"toCwd":"/repo","submitted":true})
        );
    }

    #[tokio::test(start_paused = true)]
    async fn replacement_terminal_never_receives_the_return() {
        let terminals = FakeTerminals::new();
        let mesh = MeshStore::with_events(None, Arc::new(NoopEventSink));
        let message = mesh
            .record(crate::mesh::tests::new_msg("hello", 7))
            .unwrap();
        let pending =
            PendingDelivery::begin(&terminals, 7, "/repo".into(), "m1".into(), "hello").unwrap();
        *terminals.generation.lock().unwrap() = 2;
        assert!(!pending.finish(&terminals, &mesh).await.submitted);
        assert!(!mesh.get(&message.id).unwrap().submitted);
        assert_eq!(terminals.writes.lock().unwrap().len(), 1);
    }
}

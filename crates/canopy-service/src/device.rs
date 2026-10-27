//! Android devices for cloud agents. Devices are attached to the person's
//! computer, not the workspace, so a `canopy_device_*` call from an agent here
//! is relayed to the Canopy IDE that has this workspace open: the op waits in
//! this queue, the IDE long-polls for it (admin query `device` / `pending`),
//! runs it against the computer's own Android tooling, and answers with the
//! `device_answer` action — in pieces, because a screenshot can outgrow one
//! harness action. Nothing is persisted: an op outlives neither the agent's
//! wait nor this service.

use crate::util::{now_ms, random_hex};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::{oneshot, Notify};

/// An IDE that asked for ops this recently counts as connected.
pub const PRESENCE_MS: u64 = 30_000;
/// The longest an IDE's poll is held open (under the gateway's query timeout).
pub const MAX_POLL: Duration = Duration::from_secs(10);
/// A whole answer (base64 PNG screenshots, long logcats) is capped here.
pub const MAX_ANSWER_BYTES: usize = 24 * 1024 * 1024;

pub const NO_IDE: &str = "No Canopy IDE has this cloud workspace open right now, and the \
     Android devices are on the person's computer. Open this workspace in Canopy on the \
     computer the device is attached to, then try again.";

/// What the IDE answered: the desktop route's own status and body.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceAnswer {
    pub status: u16,
    pub body: String,
}

struct Pending {
    op: serde_json::Value,
    pty_id: u32,
    created_ms: u64,
    /// Taken by an IDE poll; a poll after the taker vanished hands it out again.
    taken_ms: Option<u64>,
    partial: String,
    reply: Option<oneshot::Sender<DeviceAnswer>>,
}

#[derive(Default)]
pub struct DeviceRelay {
    inner: Mutex<Inner>,
    arrived: Notify,
}

#[derive(Default)]
struct Inner {
    pending: BTreeMap<String, Pending>,
    last_poll_ms: Option<u64>,
}

impl DeviceRelay {
    /// Whether an IDE has polled recently enough to take an op.
    pub fn connected(&self, now: u64) -> bool {
        self.inner
            .lock()
            .unwrap()
            .last_poll_ms
            .is_some_and(|at| now.saturating_sub(at) < PRESENCE_MS)
    }

    /// Queue an op for the IDE and return the receiver its answer arrives on.
    pub fn submit(
        &self,
        op: serde_json::Value,
        pty_id: u32,
    ) -> (String, oneshot::Receiver<DeviceAnswer>) {
        let id = format!("dev-{}", random_hex(8));
        let (tx, rx) = oneshot::channel();
        self.inner.lock().unwrap().pending.insert(
            id.clone(),
            Pending {
                op,
                pty_id,
                created_ms: now_ms(),
                taken_ms: None,
                partial: String::new(),
                reply: Some(tx),
            },
        );
        self.arrived.notify_waiters();
        (id, rx)
    }

    /// The agent stopped waiting: forget the op.
    pub fn cancel(&self, id: &str) {
        self.inner.lock().unwrap().pending.remove(id);
    }

    fn take_ready(&self, now: u64) -> Vec<serde_json::Value> {
        let mut inner = self.inner.lock().unwrap();
        inner.last_poll_ms = Some(now);
        inner
            .pending
            .iter_mut()
            // An op taken by a poll whose IDE then went away is offered again.
            .filter(|(_, p)| {
                p.taken_ms
                    .is_none_or(|t| now.saturating_sub(t) > PRESENCE_MS)
            })
            .map(|(id, p)| {
                p.taken_ms = Some(now);
                serde_json::json!({
                    "id": id,
                    "op": p.op,
                    "ptyId": p.pty_id,
                    "createdMs": p.created_ms,
                })
            })
            .collect()
    }

    /// The IDE's long poll: ops not yet handed out, waiting up to `wait` for
    /// one to arrive. Polling is also how the IDE says it is there.
    pub async fn poll(&self, wait: Duration) -> Vec<serde_json::Value> {
        let deadline = tokio::time::Instant::now() + wait.min(MAX_POLL);
        loop {
            let arrived = self.arrived.notified();
            let ready = self.take_ready(now_ms());
            if !ready.is_empty() {
                return ready;
            }
            if tokio::time::timeout_at(deadline, arrived).await.is_err() {
                self.inner.lock().unwrap().last_poll_ms = Some(now_ms());
                return Vec::new();
            }
        }
    }

    /// One piece of the IDE's answer. The last piece (`done`) resolves the op.
    pub fn answer(
        &self,
        id: &str,
        status: u16,
        chunk: &str,
        offset: usize,
        done: bool,
    ) -> Result<(), (u16, String)> {
        let mut inner = self.inner.lock().unwrap();
        let Some(pending) = inner.pending.get_mut(id) else {
            return Err((
                404,
                format!("no device op {id} is waiting (the agent gave up, or it was answered)"),
            ));
        };
        if pending.partial.len() != offset {
            return Err((409, "device answer pieces arrived out of order".into()));
        }
        if pending.partial.len() + chunk.len() > MAX_ANSWER_BYTES {
            inner.pending.remove(id);
            return Err((413, "that device answer is too large to relay".into()));
        }
        pending.partial.push_str(chunk);
        if !done {
            return Ok(());
        }
        let mut pending = inner.pending.remove(id).expect("present");
        if let Some(reply) = pending.reply.take() {
            let _ = reply.send(DeviceAnswer {
                status,
                body: std::mem::take(&mut pending.partial),
            });
        }
        Ok(())
    }
}

/// How long the agent waits for an op, as the hook does (`device_op`).
pub fn op_timeout(op: &str) -> Duration {
    match op {
        "emulator_start" | "run" | "describe" => Duration::from_secs(600),
        _ => Duration::from_secs(60),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_op_reaches_a_polling_ide_and_its_answer_comes_back_in_pieces() {
        let relay = std::sync::Arc::new(DeviceRelay::default());
        assert!(!relay.connected(now_ms()));
        let (id, rx) = relay.submit(serde_json::json!({"op":"list"}), 4);
        let ops = relay.poll(Duration::from_millis(10)).await;
        assert_eq!(ops[0]["id"], id.as_str());
        assert!(relay.connected(now_ms()));
        assert!(
            relay.poll(Duration::from_millis(10)).await.is_empty(),
            "taken once"
        );
        assert_eq!(
            relay.answer(&id, 200, "{\"dev", 3, false).unwrap_err().0,
            409
        );
        relay.answer(&id, 200, "{\"dev", 0, false).unwrap();
        relay.answer(&id, 200, "ices\":[]}", 5, true).unwrap();
        assert_eq!(
            rx.await.unwrap(),
            DeviceAnswer {
                status: 200,
                body: "{\"devices\":[]}".into()
            }
        );
        assert_eq!(relay.answer(&id, 200, "", 0, true).unwrap_err().0, 404);
    }

    #[tokio::test]
    async fn a_poll_wakes_when_an_op_arrives() {
        let relay = std::sync::Arc::new(DeviceRelay::default());
        let waiting = {
            let relay = relay.clone();
            tokio::spawn(async move { relay.poll(Duration::from_secs(5)).await })
        };
        tokio::time::sleep(Duration::from_millis(50)).await;
        let _ = relay.submit(serde_json::json!({"op":"tap"}), 1);
        let ops = waiting.await.unwrap();
        assert_eq!(ops[0]["op"]["op"], "tap");
    }
}

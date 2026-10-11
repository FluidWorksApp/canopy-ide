//! One registered workspace: its stores, terminals, delivery queues and
//! access state. Every store lives under `<state>/ws/<id>/`, which is never
//! mounted into a container.

use crate::attention::AttentionStore;
use crate::harness::HarnessContext;
use crate::http::SocketServer;
use crate::ledger::{DeliveryRow, Ledger, NewOutbox};
use crate::relay::access::{AccessSnapshot, SignedSnapshot};
use crate::stream::{EventLog, LogSink};
use crate::terminals::{
    RunnerEndpoint, RunnerTerminals, TerminalRecord, TerminalRegistry, WORKSPACE_ROOT,
};
use crate::util::{now_ms, random_hex, write_private};
use canopy_core::claims::{Claim, Refusal};
use canopy_core::mesh::{ClaimStore, MeshStore};
use canopy_core::terminals::{PendingDelivery, Terminals};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};

const MAX_REFUSALS: usize = 50;
const MAX_ENDED_CLAIMS: usize = 200;
/// Workspace envelopes live seven days; so do the status replies about them.
pub const STATUS_LIFETIME_MS: u64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Registration {
    pub name: String,
    pub owner_user_id: String,
    #[serde(default)]
    pub runner_url: Option<String>,
    #[serde(default)]
    pub runner_token: Option<String>,
}

pub struct Workspace {
    pub id: String,
    pub instance: String,
    pub dir: PathBuf,
    pub registration: RwLock<Registration>,
    pub runner: Arc<RwLock<RunnerEndpoint>>,
    pub events: Arc<EventLog>,
    pub mesh: MeshStore,
    pub claims: ClaimStore,
    pub attention: AttentionStore,
    pub terminals: Arc<TerminalRegistry>,
    pub runner_terminals: RunnerTerminals,
    pub ledger: Ledger,
    access: Mutex<Option<(SignedSnapshot, AccessSnapshot)>>,
    queues: Mutex<HashMap<u32, Arc<tokio::sync::Mutex<()>>>>,
    pub socket: tokio::sync::Mutex<Option<SocketServer>>,
    background: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

#[derive(Debug)]
pub enum SendError {
    Status(u16, String),
    NotReady(String),
}

impl Workspace {
    pub fn open(
        state_dir: &std::path::Path,
        id: &str,
        registration: Registration,
        events: Arc<EventLog>,
    ) -> Result<Arc<Self>, String> {
        let dir = state_dir.join("ws").join(id);
        for sub in ["mesh", "notes", "research", "attention", "inbox", "keys"] {
            crate::util::create_dir_mode(&dir.join(sub), 0o700).map_err(|e| e.to_string())?;
        }
        let _ = crate::util::set_mode(&dir, 0o700);
        let instance = format!("remote-{id}");
        let runner = Arc::new(RwLock::new(RunnerEndpoint {
            url: registration.runner_url.clone(),
            token: registration.runner_token.clone(),
        }));
        let terminals = Arc::new(TerminalRegistry::open(
            dir.join("terminals.json"),
            instance.clone(),
        ));
        let access = std::fs::read(dir.join("access.json"))
            .ok()
            .and_then(|raw| serde_json::from_slice::<(SignedSnapshot, AccessSnapshot)>(&raw).ok());
        let workspace = Arc::new(Self {
            id: id.to_string(),
            dir: dir.clone(),
            mesh: MeshStore::with_events(
                Some(dir.join("mesh/messages.jsonl")),
                Arc::new(LogSink(events.clone())),
            ),
            // No process id is recorded on cloud claims (agents live in another
            // pid namespace), so they end on release, supersession or the
            // terminal's revocation — never on a service restart.
            claims: ClaimStore::load(Some(dir.join("mesh/claims.sqlite")), instance.clone()),
            attention: AttentionStore::open(dir.join("attention"), events.clone()),
            ledger: Ledger::open(&dir.join("inbox/service.sqlite"))?,
            runner_terminals: RunnerTerminals {
                registry: terminals.clone(),
                runner: runner.clone(),
            },
            terminals,
            runner,
            events,
            instance,
            registration: RwLock::new(registration),
            access: Mutex::new(access),
            queues: Mutex::new(HashMap::new()),
            socket: tokio::sync::Mutex::new(None),
            background: Mutex::new(Vec::new()),
        });
        Ok(workspace)
    }

    pub fn project_id(&self) -> String {
        format!("ws:{}", self.id)
    }

    pub fn harness_context(&self) -> HarnessContext {
        HarnessContext {
            workspace_id: self.id.clone(),
            project_id: self.project_id(),
            project_name: self.registration.read().unwrap().name.clone(),
            project_root: WORKSPACE_ROOT.into(),
            notes_dir: self.dir.join("notes"),
            research_dir: self.dir.join("research"),
            events: self.events.clone(),
        }
    }

    /// Whether a `project` argument names this workspace. Absent is fine.
    pub fn names_this_project(&self, project: Option<&str>) -> bool {
        match project.map(str::trim).filter(|p| !p.is_empty()) {
            None => true,
            Some(p) => {
                p == self.project_id()
                    || p == WORKSPACE_ROOT
                    || p == self.registration.read().unwrap().name
            }
        }
    }

    pub fn update_registration(&self, registration: Registration) -> bool {
        let mut current = self.registration.write().unwrap();
        let runner_changed = current.runner_url != registration.runner_url
            || current.runner_token != registration.runner_token;
        *self.runner.write().unwrap() = RunnerEndpoint {
            url: registration.runner_url.clone(),
            token: registration.runner_token.clone(),
        };
        *current = registration;
        runner_changed
    }

    pub fn spawn_background(&self, task: tokio::task::JoinHandle<()>) {
        self.background.lock().unwrap().push(task);
    }

    pub async fn close(&self) {
        for task in self.background.lock().unwrap().drain(..) {
            task.abort();
        }
        if let Some(socket) = self.socket.lock().await.take() {
            socket.close().await;
        }
    }

    // ---- access -------------------------------------------------------

    pub fn access(&self) -> Option<AccessSnapshot> {
        self.access.lock().unwrap().as_ref().map(|(_, s)| s.clone())
    }

    /// Accept a verified snapshot unless it rolls back the persisted one.
    ///
    /// The control plane re-signs the same revision on every refresh with a
    /// later `issuedAt`/`expiresAt`. A re-issue that grants exactly what the
    /// held one does replaces it, so validity moves forward; a stale or
    /// non-extending one is ignored. The same revision granting anything
    /// else is equivocation and is refused.
    pub fn store_access(
        &self,
        signed: SignedSnapshot,
        snapshot: AccessSnapshot,
    ) -> Result<u64, (u16, String)> {
        let mut current = self.access.lock().unwrap();
        if let Some((old_signed, old)) = current.as_ref() {
            if snapshot.revision < old.revision {
                return Err((
                    409,
                    format!(
                        "access snapshot revision {} is older than the accepted {}",
                        snapshot.revision, old.revision
                    ),
                ));
            }
            if snapshot.revision == old.revision {
                if old_signed.payload == signed.payload {
                    return Ok(old.revision);
                }
                if !old.same_authority(&snapshot) {
                    return Err((
                        409,
                        format!(
                            "a different snapshot already holds revision {}",
                            old.revision
                        ),
                    ));
                }
                if snapshot.issued_at <= old.issued_at || snapshot.expires_at <= old.expires_at {
                    return Ok(old.revision);
                }
            }
        }
        let bytes = serde_json::to_vec(&(&signed, &snapshot)).map_err(|e| (500, e.to_string()))?;
        write_private(&self.dir.join("access.json"), &bytes, 0o600)
            .map_err(|e| (500, e.to_string()))?;
        let revision = snapshot.revision;
        *current = Some((signed, snapshot));
        drop(current);
        self.events.publish("access", "", &revision.to_string());
        Ok(revision)
    }

    // ---- claims -------------------------------------------------------

    pub fn claim(
        &self,
        who: &TerminalRecord,
        action: &str,
        paths: Vec<String>,
        owner: &str,
        note: Option<String>,
    ) -> (u16, String) {
        let key = who.key(&self.instance);
        let paths: Vec<String> = paths
            .iter()
            .map(|p| crate::meshtext::normalize_claim_path(p, Some(WORKSPACE_ROOT)))
            .collect();
        if action == "history" {
            if paths.len() != 1 {
                return (400, "claim history needs exactly one path".into());
            }
            if !crate::meshtext::path_is_within(&paths[0], WORKSPACE_ROOT) {
                return (
                    403,
                    "claim history is outside this caller's workspace".into(),
                );
            }
            return match self.claims.history_for_path(&paths[0]) {
                Ok(history) => (
                    200,
                    serde_json::json!({ "path": paths[0], "claims": history }).to_string(),
                ),
                Err(error) => (500, error),
            };
        }
        let id = match self.claims.next_id() {
            Ok(id) => id,
            Err(error) => return (500, error),
        };
        let now = now_ms();
        let result = self.claims.mutate(|claims| {
            let reply = match action {
                "release" => {
                    let n = end_claims(claims, &key, now, "agent");
                    (200, format!("Released {n} claim(s)."))
                }
                "claim" => apply_claim(
                    claims,
                    &paths,
                    note,
                    who,
                    &key,
                    owner,
                    now,
                    &id,
                    &self.instance,
                ),
                other => (400, format!("unknown claim action: {other}")),
            };
            let changed = reply.0 != 400;
            (reply, changed)
        });
        match result {
            Ok((reply, changed)) => {
                if changed {
                    self.events.publish("mesh", "claims", "");
                }
                reply
            }
            Err(error) => (500, error),
        }
    }

    pub fn release_claims_for(&self, record: &TerminalRecord, how: &str) {
        let key = record.key(&self.instance);
        if let Ok(((), true)) = self.claims.mutate(|claims| {
            let n = end_claims(claims, &key, now_ms(), how);
            ((), n > 0)
        }) {
            self.events.publish("mesh", "claims", "");
        }
    }

    // ---- terminals ----------------------------------------------------

    /// End a credential and everything it held.
    pub fn revoke_terminal(&self, request_id: &str, how: &str) -> bool {
        match self.terminals.revoke(request_id, how) {
            Some(record) => {
                self.release_claims_for(&record, "death");
                self.events
                    .publish("terminals", "", &record.pty_id.to_string());
                true
            }
            None => false,
        }
    }

    // ---- mesh delivery ------------------------------------------------

    fn queue(&self, pty_id: u32) -> Arc<tokio::sync::Mutex<()>> {
        self.queues
            .lock()
            .unwrap()
            .entry(pty_id)
            .or_default()
            .clone()
    }

    pub fn sender_tag(&self, from: Option<&TerminalRecord>) -> String {
        match from {
            Some(t) => match t.name.as_deref() {
                Some(name) => format!(
                    "[canopy: message from {name}, the agent in {WORKSPACE_ROOT} (terminal {})]",
                    t.pty_id
                ),
                None => format!(
                    "[canopy: message from the agent in {WORKSPACE_ROOT} (terminal {})]",
                    t.pty_id
                ),
            },
            None => "[canopy: message from the Canopy service]".into(),
        }
    }

    /// Record and queue a terminal delivery, returning once the body write
    /// has landed or failed. The return follows ≥250 ms later on the same
    /// per-target queue, so concurrent senders never interleave.
    pub async fn deliver(
        self: &Arc<Self>,
        pty_id: u32,
        message_id: &str,
        line: &str,
        job_key: Option<&str>,
        inbox_id: Option<&str>,
    ) -> Result<(), SendError> {
        if let Err(error) = self.runner_terminals.resolve(pty_id) {
            return Err(classify(error));
        }
        let row = DeliveryRow {
            id: format!("d{}", random_hex(8)),
            message_id: message_id.into(),
            pty_id,
            line: line.into(),
            state: "queued".into(),
            job_key: job_key.map(str::to_string),
        };
        self.ledger
            .transaction(|tx| {
                Ledger::insert_delivery(tx, &row, inbox_id)?;
                if let Some(inbox) = inbox_id {
                    Ledger::set_inbox_state(tx, inbox, "handed", None)?;
                }
                if let Some(job) = job_key {
                    Ledger::set_job(tx, job, "accepted", None, Some(pty_id), Some(message_id))?;
                }
                Ok(())
            })
            .map_err(|e| SendError::Status(500, e))?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(self.clone().run_delivery(row, Some(tx)));
        rx.await
            .unwrap_or_else(|_| Err("delivery task ended".into()))
            .map_err(classify)
    }

    async fn run_delivery(
        self: Arc<Self>,
        row: DeliveryRow,
        reply: Option<tokio::sync::oneshot::Sender<Result<(), String>>>,
    ) {
        let lock = self.queue(row.pty_id);
        let _turn = lock.lock().await;
        let fail = |ws: &Arc<Self>, error: &str| {
            let _ = ws.ledger.set_delivery(&row.id, "failed", Some(error));
            if let Some(job) = row.job_key.as_deref() {
                ws.job_transition(job, "failed", &format!("Delivery failed: {error}"));
            }
            ws.events.publish("deliveries", "", &row.id);
        };
        if let Err(error) = self.ledger.set_delivery(&row.id, "writing", None) {
            fail(&self, &error);
            if let Some(reply) = reply {
                let _ = reply.send(Err(error));
            }
            return;
        }
        let ws = self.clone();
        let (line, message_id, pty_id) = (row.line.clone(), row.message_id.clone(), row.pty_id);
        let begun = tokio::task::spawn_blocking(move || {
            PendingDelivery::begin(
                &ws.runner_terminals,
                pty_id,
                WORKSPACE_ROOT.into(),
                message_id,
                &line,
            )
        })
        .await
        .unwrap_or_else(|_| Err("delivery worker panicked".into()));
        let pending = match begun {
            Ok(pending) => pending,
            Err(error) => {
                fail(&self, &error);
                if let Some(reply) = reply {
                    let _ = reply.send(Err(error));
                }
                return;
            }
        };
        let _ = self.ledger.set_delivery(&row.id, "written", None);
        if let Some(reply) = reply {
            let _ = reply.send(Ok(()));
        }
        // The runner write is a bounded host-local call; core's finish owns
        // the 250 ms gap and the generation re-check.
        let receipt = pending
            .finish(tokio::time::sleep, &self.runner_terminals, &self.mesh)
            .await;
        if receipt.submitted {
            let _ = self.ledger.set_delivery(&row.id, "submitted", None);
            if let Some(job) = row.job_key.as_deref() {
                self.job_transition(job, "started", "Delivered to the agent's terminal.");
            }
        } else {
            let detail =
                "The message was typed but the terminal ended before it could be submitted.";
            let _ = self.ledger.set_delivery(&row.id, "failed", Some(detail));
            if let Some(job) = row.job_key.as_deref() {
                self.job_transition(job, "failed", detail);
            }
        }
        self.events.publish("deliveries", "", &row.id);
    }

    /// After a restart: queued deliveries never touched a terminal and run
    /// now; ones caught mid-write are reported as uncertain, never replayed.
    pub fn recover_deliveries(self: &Arc<Self>) {
        let rows = match self.ledger.unfinished_deliveries() {
            Ok(rows) => rows,
            Err(error) => {
                eprintln!("canopy-serviced: {}: delivery recovery: {error}", self.id);
                return;
            }
        };
        for row in rows {
            if row.state == "queued" {
                tokio::spawn(self.clone().run_delivery(row, None));
                continue;
            }
            let detail = "The service restarted while this message was being typed into the \
                          terminal. It may or may not have been submitted; it was not sent again.";
            let _ = self.ledger.set_delivery(&row.id, "uncertain", Some(detail));
            self.attention.fyi(
                &format!("Delivery of {} is uncertain", row.message_id),
                &format!("Terminal {}: {detail}", row.pty_id),
                "warn",
                Some(row.pty_id),
            );
            if let Some(job) = row.job_key.as_deref() {
                self.job_transition(job, "uncertain", detail);
            }
            self.events.publish("deliveries", "", &row.id);
        }
    }

    // ---- jobs ---------------------------------------------------------

    /// Move a relay job and queue the status the sender sees, in one commit.
    pub fn job_transition(&self, key: &str, state: &str, detail: &str) {
        let wire_state = match state {
            "uncertain" => "failed",
            other => other,
        };
        let result = self.ledger.transaction(|tx| {
            let Some((_, job_id, team, user, device)) = Ledger::job_route(tx, key)? else {
                return Ok(());
            };
            Ledger::set_job(tx, key, state, Some(detail), None, None)?;
            let payload = serde_json::json!({
                "kind": "job-status",
                "status": {
                    "jobId": job_id,
                    "state": wire_state,
                    "detail": clip(detail, 4000),
                    "created": now_ms(),
                }
            });
            Ledger::push_outbox(
                tx,
                NewOutbox {
                    team: &team,
                    to_user: &user,
                    to_device: &device,
                    kind: "job-status",
                    payload: &payload,
                    expires_ms: now_ms() + STATUS_LIFETIME_MS,
                },
            )
        });
        if let Err(error) = result {
            eprintln!("canopy-serviced: job {key}: {error}");
        }
        self.events.publish("mesh", "jobs", key);
    }
}

pub fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        text.to_string()
    } else {
        let mut out: String = text.chars().take(max - 1).collect();
        out.push('…');
        out
    }
}

fn classify(error: String) -> SendError {
    match error.strip_prefix(crate::terminals::NOT_READY) {
        Some(message) => SendError::NotReady(message.to_string()),
        None if error.starts_with("No running Canopy terminal") => SendError::Status(404, error),
        None if error.starts_with("Canopy can't yet tell") => SendError::Status(403, error),
        None => SendError::Status(400, error),
    }
}

fn end_claims(claims: &mut [Claim], owner_key: &str, now: u64, how: &str) -> usize {
    let mut n = 0;
    for c in claims
        .iter_mut()
        .filter(|c| c.owner_key == owner_key && c.released_at_ms.is_none())
    {
        c.released_at_ms = Some(now);
        c.released_by = Some(how.to_string());
        n += 1;
    }
    n
}

fn prune_claims(claims: &mut Vec<Claim>) {
    let ended = claims.iter().filter(|c| c.released_at_ms.is_some()).count();
    if ended <= MAX_ENDED_CLAIMS {
        return;
    }
    let mut to_drop = ended - MAX_ENDED_CLAIMS;
    claims.retain(|c| {
        if to_drop > 0 && c.released_at_ms.is_some() {
            to_drop -= 1;
            return false;
        }
        true
    });
}

/// The desktop's claim rule (context.rs `apply_claim`), keyed on the
/// credential-derived owner key.
#[allow(clippy::too_many_arguments)]
fn apply_claim(
    claims: &mut Vec<Claim>,
    paths: &[String],
    note: Option<String>,
    who: &TerminalRecord,
    key: &str,
    owner: &str,
    now: u64,
    id: &str,
    instance: &str,
) -> (u16, String) {
    use crate::meshtext::paths_overlap;
    if paths.is_empty() {
        return (400, "claim needs paths".into());
    }
    if let Some(bad) = paths
        .iter()
        .find(|p| p.is_empty() || p.as_str() == "/" || !p.starts_with('/'))
    {
        return (
            400,
            format!(
                "\"{bad}\" isn't a file or directory this claim can name — claim the actual \
                 paths you're about to work on."
            ),
        );
    }
    let colliding: Vec<usize> = claims
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            c.released_at_ms.is_none()
                && c.owner_key != key
                && c.paths
                    .iter()
                    .any(|held| paths.iter().any(|want| paths_overlap(held, want)))
        })
        .map(|(i, _)| i)
        .collect();
    if !colliding.is_empty() {
        for &i in &colliding {
            let held = &mut claims[i];
            held.refusals.push(Refusal {
                owner: owner.to_string(),
                paths: paths.to_vec(),
                note: note.clone(),
                at_ms: now,
                attempt_id: None,
            });
            if held.refusals.len() > MAX_REFUSALS {
                let excess = held.refusals.len() - MAX_REFUSALS;
                held.refusals.drain(0..excess);
            }
        }
        let held = &claims[colliding[0]];
        let also = match colliding.len() - 1 {
            0 => String::new(),
            1 => " (and one other agent holds some of them too)".into(),
            n => format!(" (and {n} other agents hold some of them too)"),
        };
        return (
            409,
            format!(
                "{} already claimed {} ({}){}. Pick different files, or ask that agent to \
                 release them.",
                held.owner,
                held.paths.join(", "),
                held.note.clone().unwrap_or_else(|| "no note".into()),
                also
            ),
        );
    }
    end_claims(claims, key, now, "superseded");
    claims.push(Claim {
        id: id.to_string(),
        paths: paths.to_vec(),
        owner: owner.to_string(),
        owner_key: key.to_string(),
        pty_id: Some(who.pty_id),
        instance: Some(instance.to_string()),
        process_id: None,
        process_started_at: None,
        run_id: None,
        attempt_id: None,
        note,
        at_ms: now,
        released_at_ms: None,
        released_by: None,
        refusals: Vec::new(),
    });
    prune_claims(claims);
    (200, format!("Claimed {} path(s).", paths.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay::access::tests::{sign, snapshot};
    use crate::relay::access::{decide, verify, Decision, Principal};

    const MIN: u64 = 60 * 1000;

    struct Fixture {
        _dir: tempfile::TempDir,
        ws: Arc<Workspace>,
        key: ed25519_dalek::SigningKey,
        keys: HashMap<String, ed25519_dalek::VerifyingKey>,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let registration = Registration {
                name: "ws1".into(),
                owner_user_id: "owner".into(),
                runner_url: None,
                runner_token: None,
            };
            let events = Arc::new(EventLog::new("test".into()));
            let ws = Workspace::open(dir.path(), "ws1", registration, events).unwrap();
            let key = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
            let keys = HashMap::from([("k1".to_string(), key.verifying_key())]);
            Self {
                _dir: dir,
                ws,
                key,
                keys,
            }
        }

        fn put(&self, snapshot: &AccessSnapshot) -> Result<u64, (u16, String)> {
            let (signed, verified) =
                verify(&sign(&self.key, snapshot), &self.keys, "ws1", "dev").unwrap();
            self.ws.store_access(signed, verified)
        }
    }

    /// The control plane's refresh: same grant, issued later, 15 minutes long.
    fn issued(revision: u64, at: u64) -> AccessSnapshot {
        AccessSnapshot {
            issued_at: at,
            ..snapshot(revision, at + 15 * MIN, true)
        }
    }

    #[test]
    fn a_reissue_of_the_same_grant_extends_validity() {
        let f = Fixture::new();
        assert_eq!(f.put(&issued(1, 0)), Ok(1));
        assert_eq!(f.put(&issued(1, 5 * MIN)), Ok(1));
        assert_eq!(f.ws.access().unwrap().expires_at, 20 * MIN);
        assert_eq!(f.put(&issued(1, 10 * MIN)), Ok(1));
        assert_eq!(f.ws.access().unwrap().expires_at, 25 * MIN);
        // Past the first snapshot's expiry, the refreshed one still delivers.
        assert_eq!(
            decide("owner", f.ws.access().as_ref(), "granted", 22 * MIN),
            Decision::Deliver
        );
        // The extension is what a restart reloads.
        let raw = std::fs::read(f.ws.dir.join("access.json")).unwrap();
        let (_, persisted): (SignedSnapshot, AccessSnapshot) =
            serde_json::from_slice(&raw).unwrap();
        assert_eq!(persisted.expires_at, 25 * MIN);
    }

    #[test]
    fn a_reissue_signed_by_a_rotated_key_is_still_a_refresh() {
        let f = Fixture::new();
        assert_eq!(f.put(&issued(1, 0)), Ok(1));
        let rotated = ed25519_dalek::SigningKey::from_bytes(&[8u8; 32]);
        let keys = HashMap::from([
            ("k1".to_string(), f.key.verifying_key()),
            ("k2".to_string(), rotated.verifying_key()),
        ]);
        let next = AccessSnapshot {
            kid: "k2".into(),
            ..issued(1, 5 * MIN)
        };
        let (signed, verified) = verify(&sign(&rotated, &next), &keys, "ws1", "dev").unwrap();
        assert_eq!(f.ws.store_access(signed, verified), Ok(1));
        assert_eq!(f.ws.access().unwrap().kid, "k2");
    }

    #[test]
    fn the_same_revision_granting_anything_else_is_refused() {
        let f = Fixture::new();
        assert_eq!(f.put(&issued(1, 0)), Ok(1));
        let mut more = issued(1, 5 * MIN);
        more.principals.push(Principal {
            user_id: "intruder".into(),
            sessions_interact: true,
            projects: "all".into(),
        });
        let mut wider = issued(1, 5 * MIN);
        wider.principals[1].sessions_interact = true;
        let mut narrower = issued(1, 5 * MIN);
        narrower.principals[0].projects = serde_json::json!(["p1"]);
        let closed = AccessSnapshot {
            team_delivery: false,
            ..issued(1, 5 * MIN)
        };
        let new_owner = AccessSnapshot {
            owner_user_id: "someone".into(),
            ..issued(1, 5 * MIN)
        };
        for changed in [more, wider, narrower, closed, new_owner] {
            let (status, message) = f.put(&changed).unwrap_err();
            assert_eq!(status, 409);
            assert!(message.contains("already holds revision 1"), "{message}");
        }
        assert_eq!(f.ws.access().unwrap(), issued(1, 0));
    }

    #[test]
    fn an_older_or_non_extending_reissue_is_ignored_quietly() {
        let f = Fixture::new();
        assert_eq!(f.put(&issued(1, 10 * MIN)), Ok(1));
        assert_eq!(f.put(&issued(1, 5 * MIN)), Ok(1));
        let same_issue_shorter = AccessSnapshot {
            expires_at: 11 * MIN,
            ..issued(1, 10 * MIN)
        };
        assert_eq!(f.put(&same_issue_shorter), Ok(1));
        let later_but_shorter = AccessSnapshot {
            expires_at: 20 * MIN,
            ..issued(1, 12 * MIN)
        };
        assert_eq!(f.put(&later_but_shorter), Ok(1));
        assert_eq!(f.ws.access().unwrap(), issued(1, 10 * MIN));
    }

    #[test]
    fn revisions_still_move_forward_only() {
        let f = Fixture::new();
        assert_eq!(f.put(&issued(2, 0)), Ok(2));
        let (status, message) = f.put(&issued(1, 5 * MIN)).unwrap_err();
        assert_eq!(status, 409);
        assert!(message.contains("older than the accepted 2"), "{message}");
        // A higher revision may grant something else and needs no later issue.
        let changed = AccessSnapshot {
            team_delivery: false,
            ..issued(3, 0)
        };
        assert_eq!(f.put(&changed), Ok(3));
        assert!(!f.ws.access().unwrap().team_delivery);
    }

    #[test]
    fn an_expired_grant_comes_back_when_a_refresh_lands() {
        let f = Fixture::new();
        assert_eq!(f.put(&issued(1, 0)), Ok(1));
        let now = 16 * MIN;
        assert!(matches!(
            decide("owner", f.ws.access().as_ref(), "granted", now),
            Decision::Refuse(r) if r.contains("expired")
        ));
        assert_eq!(f.put(&issued(1, 15 * MIN)), Ok(1));
        assert_eq!(
            decide("owner", f.ws.access().as_ref(), "granted", now),
            Decision::Deliver
        );
        assert!(matches!(
            decide("owner", f.ws.access().as_ref(), "granted", 30 * MIN),
            Decision::Refuse(r) if r.contains("expired")
        ));
    }
}

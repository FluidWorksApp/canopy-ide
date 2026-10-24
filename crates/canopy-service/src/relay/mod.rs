//! The host as a mesh endpoint (protocol §6): poll the relay per workspace,
//! verify and decrypt v2 envelopes, dedupe durably before acknowledging,
//! apply the signed access rule, deliver into the addressed agent, and send
//! status and refusals back through a durable outbox.

pub mod access;
pub mod crypto;
pub mod device;
pub mod transport;

use crate::ledger::{InboxRow, Ledger, NewOutbox, ReplyRoute};
use crate::meshtext::mesh_notice_for;
use crate::service::Service;
use crate::util::now_ms;
use crate::workspace::{clip, SendError, Workspace, STATUS_LIFETIME_MS};
use access::Decision;
use canopy_core::mesh::{MeshRef, NewMessage};
use crypto::{Address, Envelope, SealInput};
use std::collections::HashMap;
use std::sync::Arc;
use transport::{PollRow, RelayTransport, TransportError};

const MAX_TITLE: usize = 120;
const MAX_BRIEF: usize = 16 * 1024;
/// A roster answers inside one 32 KB envelope, so it lists at most this many
/// agents with their text fields clipped.
const MAX_ROSTER: usize = 50;

fn log(ws: &str, message: &str) {
    eprintln!("canopy-serviced: {ws}: relay: {message}");
}

/// Where a mesh message or job is aimed inside the workspace.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Target {
    pty_id: Option<u32>,
    name: Option<String>,
}

enum Admission {
    /// Committed (or unrecoverable and recorded nowhere): acknowledge.
    Ack,
    /// Nothing durable happened; leave it on the relay for the next poll.
    Keep,
}

pub async fn poll_workspace(
    service: &Arc<Service>,
    ws: &Arc<Workspace>,
    transport: &dyn RelayTransport,
) -> bool {
    let device = service.device.device_id.clone();
    let rows = match transport.poll(&ws.id, &device).await {
        Ok(rows) => rows,
        Err(TransportError::NotConfigured) => return true,
        Err(TransportError::Failed(error)) => {
            log(&ws.id, &error);
            return false;
        }
    };
    let mut acknowledged = Vec::new();
    for row in rows {
        if let Admission::Ack = admit(service, ws, &row) {
            acknowledged.push(row.id);
        }
    }
    for chunk in acknowledged.chunks(100) {
        if let Err(error) = transport.ack(&ws.id, &device, chunk.to_vec()).await {
            log(&ws.id, &format!("ack failed: {error:?}"));
        }
    }
    true
}

fn valid_item_id(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn clip_opt(value: &Option<String>, n: usize) -> serde_json::Value {
    value
        .as_deref()
        .map(|v| serde_json::Value::from(clip(v, n)))
        .unwrap_or(serde_json::Value::Null)
}

/// The workspace's live agents, as `/ctx/snapshot` lists them to its own
/// agents: what a team device asking `roster-request` is told.
pub fn roster_agents(ws: &Workspace) -> Vec<serde_json::Value> {
    let mut agents: Vec<_> = ws
        .terminals
        .all()
        .into_iter()
        .filter(|t| t.live() && t.session_id.is_some())
        .collect();
    agents.sort_by_key(|t| std::cmp::Reverse(t.bound_ms.unwrap_or(t.minted_ms)));
    agents
        .into_iter()
        .take(MAX_ROSTER)
        .map(|t| {
            // The agent's own status wins; otherwise what the host observed.
            let status = t.status.as_ref().or(t.activity.as_ref()).map(|s| {
                serde_json::json!({
                    "title": s.get("title").and_then(|v| v.as_str()).map(|v| clip(v, 120)),
                    "description": s.get("description").and_then(|v| v.as_str()).map(|v| clip(v, 200)),
                })
            });
            serde_json::json!({
                "ptyId": t.pty_id,
                "name": clip_opt(&t.name, 80),
                "agent": clip_opt(&t.agent, 40),
                "task": clip_opt(&t.task, 200),
                "status": status,
                "closing": t.close_requested_ms.is_some(),
            })
        })
        .collect()
}

/// Under the relay's 32 000-byte envelope payload, with room for the request id.
const MAX_ROSTER_BYTES: usize = 30_000;

/// The roster answer, dropping the oldest agents until it fits one envelope.
fn fit_roster(mut agents: Vec<serde_json::Value>, request_id: &str) -> serde_json::Value {
    loop {
        let payload = serde_json::json!({
            "kind": "roster",
            "roster": { "requestId": request_id, "agents": agents, "created": now_ms() }
        });
        if agents.is_empty() || payload.to_string().len() <= MAX_ROSTER_BYTES {
            return payload;
        }
        agents.pop();
    }
}

fn roster_payload(ws: &Workspace, request_id: &str) -> serde_json::Value {
    fit_roster(roster_agents(ws), request_id)
}

/// A display name the sender chose for itself; typed into a terminal, so it
/// is flattened and bounded like any other typed text.
fn sender_label(message: &serde_json::Value) -> Option<String> {
    let name = crate::meshtext::sanitize_message(message["from"]["name"].as_str()?);
    (!name.is_empty()).then(|| clip(&name, 60))
}

fn refusal_payload(kind: &str, id: &str, reason: &str) -> (&'static str, serde_json::Value) {
    match kind {
        "job" => (
            "job-status",
            serde_json::json!({
                "kind": "job-status",
                "status": { "jobId": id, "state": "declined", "detail": clip(reason, 4000), "created": now_ms() }
            }),
        ),
        _ => (
            "mesh",
            serde_json::json!({
                "kind": "mesh-status",
                "status": { "messageId": id, "state": "refused", "detail": clip(reason, 4000), "created": now_ms() }
            }),
        ),
    }
}

/// Verify, dedupe, decide and commit one envelope. Acknowledgement happens
/// only after this returns `Ack`, so a crash before the commit leaves the
/// envelope on the relay and a crash after it is caught by the dedupe row.
fn admit(service: &Arc<Service>, ws: &Arc<Workspace>, row: &PollRow) -> Admission {
    let envelope: Envelope = match serde_json::from_value(row.envelope.clone()) {
        Ok(e) => e,
        Err(error) => {
            log(&ws.id, &format!("malformed envelope {}: {error}", row.id));
            return Admission::Ack;
        }
    };
    if envelope.version != 2 {
        log(&ws.id, "only version 2 workspace envelopes reach a host");
        return Admission::Ack;
    }
    if envelope.to.device != service.device.device_id
        || envelope.to.workspace.as_deref() != Some(ws.id.as_str())
    {
        log(&ws.id, "envelope addressed to another device or workspace");
        return Admission::Ack;
    }
    let Some(sender) = row.sender.as_ref() else {
        log(&ws.id, "poll row carries no sender identity");
        return Admission::Ack;
    };
    if sender.id != envelope.from.device || sender.user_id != envelope.from.user {
        log(
            &ws.id,
            "envelope sender does not match the relay's sender record",
        );
        return Admission::Ack;
    }
    let opened = match crypto::open(
        &service.device.agreement,
        &sender.public_keys,
        &envelope,
        now_ms(),
    ) {
        Ok(opened) => opened,
        Err(error) => {
            log(
                &ws.id,
                &format!("rejected envelope {}: {error}", envelope.id),
            );
            return Admission::Ack;
        }
    };
    match ws.ledger.inbox_state(&opened.replay_id) {
        Ok(Some(_)) => return Admission::Ack,
        Ok(None) => {}
        Err(error) => {
            log(&ws.id, &error);
            return Admission::Keep;
        }
    }
    let kind = envelope.kind.clone().unwrap_or_default();
    let payload: serde_json::Value = serde_json::from_str(&opened.text).unwrap_or_default();
    let from = &envelope.from;
    // What the sender named, for a refusal they can match to their request.
    let (item_id, problem) = match (kind.as_str(), payload.get("kind").and_then(|k| k.as_str())) {
        ("mesh", Some("mesh")) => {
            let message = &payload["message"];
            let id = message["id"].as_str().unwrap_or_default().to_string();
            let text = message["text"].as_str().unwrap_or_default();
            let problem = if id.is_empty() || id.len() > 64 {
                Some("mesh message needs an id")
            } else if text.trim().is_empty() || text.len() > crate::meshtext::MAX_MESH_TEXT {
                Some("mesh message text is empty or too long")
            } else if serde_json::from_value::<Target>(message["target"].clone()).is_err() {
                Some("mesh message needs a target {ptyId} or {name}")
            } else {
                None
            };
            (id, problem)
        }
        ("mesh", Some("roster-request")) => {
            let id = payload["request"]["id"]
                .as_str()
                .unwrap_or_default()
                .to_string();
            let problem = (!valid_item_id(&id)).then_some("roster request needs an id");
            (id, problem)
        }
        ("job", Some("job")) => {
            let job = &payload["job"];
            let id = job["id"].as_str().unwrap_or_default().to_string();
            let problem = if !valid_item_id(&id) {
                Some("job needs an id")
            } else if job["title"].as_str().is_none_or(|t| t.len() > MAX_TITLE)
                || job["brief"]
                    .as_str()
                    .is_none_or(|b| b.trim().is_empty() || b.len() > MAX_BRIEF)
            {
                Some("job title or brief is missing or too long")
            } else if job["workspace"].as_str().is_some_and(|w| w != ws.id) {
                Some("job names another workspace")
            } else if serde_json::from_value::<Option<Target>>(job["target"].clone())
                .ok()
                .flatten()
                .is_none_or(|t| t.pty_id.is_none() && t.name.is_none())
            {
                Some("a job delivered to a workspace needs a target agent {ptyId} or {name}")
            } else {
                None
            };
            (id, problem)
        }
        // Status replies and chat are not addressed to agents here.
        ("job-status", _) | ("chat", _) => (String::new(), Some("ignored")),
        _ => (
            String::new(),
            Some("payload does not match the envelope kind"),
        ),
    };
    let owner = ws.registration.read().unwrap().owner_user_id.clone();
    let decision = match problem {
        Some(reason) => Decision::Refuse(reason.to_string()),
        None => access::decide_now(&owner, ws.access().as_ref(), &from.user),
    };
    let ignored = problem == Some("ignored") || item_id.is_empty();
    let job_key = (kind == "job").then(|| format!("{}:{}", from.user, item_id));
    // A roster request is answered here and never reaches a terminal.
    let roster = (kind == "mesh" && payload["kind"] == "roster-request")
        .then(|| roster_payload(ws, &item_id));
    let committed = ws.ledger.transaction(|tx| {
        let (decision_label, reason, state) = match (&decision, ignored) {
            (_, true) => ("ignore", problem, "ignored"),
            (Decision::Deliver, false) if roster.is_some() => ("deliver", None, "answered"),
            (Decision::Deliver, false) => ("deliver", None, "accepted"),
            (Decision::Refuse(reason), false) => ("refuse", Some(reason.as_str()), "refused"),
        };
        Ledger::insert_inbox(
            tx,
            &opened.replay_id,
            &envelope.id,
            &row.id,
            &kind,
            &from.team,
            &from.user,
            &from.device,
            decision_label,
            reason,
            state,
            &opened.text,
            envelope.expires,
        )?;
        if ignored {
            return Ok(());
        }
        let status = |state: &str, detail: &str| {
            serde_json::json!({
                "kind": "job-status",
                "status": { "jobId": item_id, "state": state, "detail": detail, "created": now_ms() }
            })
        };
        if let Some(key) = job_key.as_deref() {
            let job = &payload["job"];
            Ledger::insert_job(
                tx,
                key,
                &item_id,
                &from.team,
                &from.user,
                &from.device,
                job["title"].as_str().unwrap_or_default(),
                job["brief"].as_str().unwrap_or_default(),
            )?;
        }
        let expires_ms = now_ms() + STATUS_LIFETIME_MS;
        let (out_kind, out_payload) = match &decision {
            Decision::Deliver if job_key.is_some() => {
                ("job-status", status("accepted", "Accepted by the workspace host."))
            }
            Decision::Deliver if roster.is_some() => ("mesh", roster.clone().unwrap()),
            Decision::Deliver => return Ok(()),
            Decision::Refuse(reason) => {
                if let Some(key) = job_key.as_deref() {
                    Ledger::set_job(tx, key, "declined", Some(reason), None, None)?;
                }
                refusal_payload(&kind, &item_id, reason)
            }
        };
        Ledger::push_outbox(
            tx,
            NewOutbox {
                team: &from.team,
                to_user: &from.user,
                to_device: &from.device,
                kind: out_kind,
                payload: &out_payload,
                expires_ms,
            },
        )
    });
    if let Err(error) = committed {
        log(
            &ws.id,
            &format!("could not record envelope {}: {error}", envelope.id),
        );
        return Admission::Keep;
    }
    ws.events.publish("mesh", "inbox", &envelope.id);
    if !ignored && decision == Decision::Deliver && roster.is_none() {
        let row = InboxRow {
            replay_id: opened.replay_id,
            kind,
            team: from.team.clone(),
            sender_user: from.user.clone(),
            sender_device: from.device.clone(),
            state: "accepted".into(),
            payload: opened.text,
        };
        tokio::spawn(hand_off(ws.clone(), row));
    }
    Admission::Ack
}

/// Admitted but never handed to delivery (a restart landed in between):
/// nothing was typed yet, so hand them off now.
pub fn resume_admitted(ws: &Arc<Workspace>) {
    match ws.ledger.accepted_inbox() {
        Ok(rows) => {
            for row in rows {
                tokio::spawn(hand_off(ws.clone(), row));
            }
        }
        Err(error) => log(&ws.id, &error),
    }
}

async fn hand_off(ws: Arc<Workspace>, row: InboxRow) {
    let payload: serde_json::Value = serde_json::from_str(&row.payload).unwrap_or_default();
    let is_job = row.kind == "job";
    let body = if is_job {
        &payload["job"]
    } else {
        &payload["message"]
    };
    let item_id = body["id"].as_str().unwrap_or_default().to_string();
    let job_key = is_job.then(|| format!("{}:{}", row.sender_user, item_id));
    let fail = |reason: String| {
        let ws = ws.clone();
        let row = row.clone();
        let item_id = item_id.clone();
        let job_key = job_key.clone();
        async move {
            let result = ws.ledger.transaction(|tx| {
                Ledger::set_inbox_state(tx, &row.replay_id, "failed", Some(&reason))?;
                if job_key.is_none() {
                    let (kind, payload) = refusal_payload("mesh", &item_id, &reason);
                    let mut payload = payload;
                    payload["status"]["state"] = "failed".into();
                    Ledger::push_outbox(
                        tx,
                        NewOutbox {
                            team: &row.team,
                            to_user: &row.sender_user,
                            to_device: &row.sender_device,
                            kind,
                            payload: &payload,
                            expires_ms: now_ms() + STATUS_LIFETIME_MS,
                        },
                    )?;
                }
                Ok(())
            });
            if let Err(error) = result {
                log(&ws.id, &error);
            }
            if let Some(key) = job_key.as_deref() {
                ws.job_transition(key, "failed", &reason);
            }
        }
    };
    let target: Option<Target> = serde_json::from_value(body["target"].clone()).ok();
    let target = match target {
        Some(Target {
            pty_id: Some(id), ..
        }) => ws
            .terminals
            .by_pty(id)
            .ok_or_else(|| format!("No running agent with terminal id {id} in this workspace.")),
        Some(Target {
            name: Some(name), ..
        }) => ws.terminals.by_name(&name),
        _ => Err("No target agent was named.".to_string()),
    };
    let target = match target {
        Ok(t) => t,
        Err(reason) => return fail(reason).await,
    };
    let text = if is_job {
        format!(
            "{}\n\n{}",
            body["title"].as_str().unwrap_or_default(),
            body["brief"].as_str().unwrap_or_default()
        )
    } else {
        body["text"].as_str().unwrap_or_default().to_string()
    };
    let record = ws.mesh.record(NewMessage {
        from_pty_id: None,
        from_cwd: None,
        from_name: Some(match sender_label(body) {
            Some(label) => format!("{label} ({} over the team mesh)", row.sender_user),
            None => format!("{} (team device {})", row.sender_user, row.sender_device),
        }),
        from_agent: None,
        from_task: None,
        to_pty_id: target.pty_id,
        to_cwd: Some(crate::terminals::WORKSPACE_ROOT.into()),
        to_name: target.name.clone(),
        to_agent: target.agent.clone(),
        to_task: target.task.clone(),
        text,
        items: Vec::new(),
        reply_to: None,
        reference: Some(MeshRef {
            kind: if is_job { "job".into() } else { "relay".into() },
            id: item_id.clone(),
        }),
        instance: Some(ws.instance.clone()),
        at_ms: now_ms(),
    });
    let record = match record {
        Ok(record) => record,
        Err(_) => return fail("The workspace owner disconnected this pair.".into()).await,
    };
    let what = if is_job {
        format!("job {item_id}")
    } else {
        "a message".to_string()
    };
    let who = match sender_label(body) {
        Some(label) => format!("{label} ({})", row.sender_user),
        None => row.sender_user.clone(),
    };
    let mut line = format!(
        "[canopy: {what} from {who} over the team mesh] {}",
        mesh_notice_for(&record)
    );
    if !is_job {
        let route = ReplyRoute {
            item_id: item_id.clone(),
            team: row.team.clone(),
            sender_user: row.sender_user.clone(),
            sender_device: row.sender_device.clone(),
        };
        match ws
            .ledger
            .insert_reply_route(&record.id, &route, now_ms() + STATUS_LIFETIME_MS)
        {
            Ok(()) => line.push_str(&format!(
                " — answer it with canopy_mesh_send ptyId 0 replyTo \"{}\"",
                record.id
            )),
            Err(error) => log(&ws.id, &format!("reply route for {}: {error}", record.id)),
        }
    }
    match ws
        .deliver(
            target.pty_id,
            &record.id,
            &line,
            job_key.as_deref(),
            Some(&row.replay_id),
        )
        .await
    {
        Ok(()) => {
            ws.mesh.note_delivery(&record.id, &line);
            ws.attention.fyi(
                &format!("{} reached terminal {}", row.sender_user, target.pty_id),
                &format!("Delivered {what} over the team mesh as {}.", record.id),
                "info",
                Some(target.pty_id),
            );
        }
        // A job's failure is recorded by the delivery itself once a delivery
        // row exists; before that (runner not ready, no terminal) it is here.
        Err(SendError::NotReady(reason)) | Err(SendError::Status(_, reason)) => {
            let delivery_recorded =
                matches!(ws.ledger.inbox_state(&row.replay_id), Ok(Some(s)) if s == "handed");
            if !delivery_recorded {
                fail(reason).await;
            }
        }
    }
}

/// Seal and send queued status replies and refusals for one workspace.
pub async fn flush_outbox(
    service: &Arc<Service>,
    ws: &Arc<Workspace>,
    transport: &dyn RelayTransport,
) {
    let rows = match ws.ledger.pending_outbox(now_ms()) {
        Ok(rows) if !rows.is_empty() => rows,
        Ok(_) => return,
        Err(error) => return log(&ws.id, &error),
    };
    let device = service.device.device_id.clone();
    let owner = ws.registration.read().unwrap().owner_user_id.clone();
    let mut directories: HashMap<String, Vec<transport::DirectoryDevice>> = HashMap::new();
    for row in rows {
        if !directories.contains_key(&row.team) {
            match transport.directory(&ws.id, &device, &row.team).await {
                Ok(devices) => {
                    directories.insert(row.team.clone(), devices);
                }
                Err(TransportError::NotConfigured) => return,
                Err(TransportError::Failed(error)) => {
                    let _ = ws.ledger.outbox_result(row.id, Some(&error));
                    continue;
                }
            }
        }
        let recipient = directories[&row.team]
            .iter()
            .find(|d| d.id == row.to_device && d.user_id == row.to_user)
            .cloned();
        let Some(recipient) = recipient else {
            let _ = ws
                .ledger
                .outbox_result(row.id, Some("recipient device is not in the directory"));
            continue;
        };
        let now = now_ms();
        let sealed = crypto::seal(SealInput {
            signing: &service.device.signing,
            recipient: &recipient.public_keys,
            from: Address {
                team: row.team.clone(),
                user: owner.clone(),
                device: device.clone(),
                workspace: None,
            },
            to: Address {
                team: row.team.clone(),
                user: row.to_user.clone(),
                device: row.to_device.clone(),
                workspace: Some(ws.id.clone()),
            },
            kind: Some(&row.kind),
            text: &row.payload,
            now,
            lifetime_ms: row
                .expires_ms
                .saturating_sub(now)
                .clamp(1, crypto::V2_MAX_LIFETIME_MS),
        });
        let envelope = match sealed {
            Ok(envelope) => envelope,
            Err(error) => {
                let _ = ws.ledger.outbox_result(row.id, Some(&error));
                continue;
            }
        };
        let sent = transport
            .relay(&ws.id, &device, &row.team, &row.to_device, &envelope)
            .await;
        match sent {
            Ok(()) => {
                let _ = ws.ledger.outbox_result(row.id, None);
            }
            Err(TransportError::NotConfigured) => return,
            Err(TransportError::Failed(error)) => {
                let _ = ws.ledger.outbox_result(row.id, Some(&error));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_roster_still_fits_one_envelope() {
        let long = "x".repeat(200);
        let agents: Vec<_> = (1..=MAX_ROSTER as u32)
            .map(|id| {
                serde_json::json!({
                    "ptyId": id, "name": &long[..80], "agent": &long[..40], "task": long,
                    "status": {"title": &long[..120], "description": long}, "closing": false,
                })
            })
            .collect();
        let payload = fit_roster(agents, "roster-0001");
        assert!(payload.to_string().len() <= MAX_ROSTER_BYTES);
        let kept = payload["roster"]["agents"].as_array().unwrap();
        assert!(!kept.is_empty() && kept.len() < MAX_ROSTER);
        assert_eq!(kept[0]["ptyId"], 1);
    }
}

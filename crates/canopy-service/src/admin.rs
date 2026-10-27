//! The admin API (protocol §3). The socket's filesystem permission is the
//! credential; the gateway is the only client and supplies `actor`.

use crate::agent::accepted;
use crate::attention::AnswerError;
use crate::harness::HarnessStore;
use crate::service::Service;
use crate::stream::Start;
use crate::terminals::MintRequest;
use crate::util::valid_workspace_id;
use crate::workspace::{Registration, Workspace};
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::Router;
use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::Ordering;
use std::sync::Arc;

type Svc = State<Arc<Service>>;

pub fn router(service: Arc<Service>) -> Router {
    Router::new()
        .route("/admin/health", get(health))
        .route("/admin/device", get(device))
        .route(
            "/admin/workspaces/:ws",
            put(put_workspace).delete(delete_workspace),
        )
        .route("/admin/workspaces/:ws/terminals", post(mint))
        .route("/admin/workspaces/:ws/terminals/:request/bind", post(bind))
        .route(
            "/admin/workspaces/:ws/terminals/:request",
            axum::routing::delete(revoke).patch(describe),
        )
        .route("/admin/workspaces/:ws/access", put(put_access))
        .route("/admin/workspaces/:ws/stream", get(stream))
        .route("/admin/workspaces/:ws/query", post(query))
        .route("/admin/workspaces/:ws/actions", post(actions))
        .with_state(service)
}

fn json(status: u16, value: serde_json::Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [("content-type", "application/json")],
        value.to_string(),
    )
        .into_response()
}

fn error(status: u16, message: impl Into<String>) -> Response {
    json(status, serde_json::json!({ "error": message.into() }))
}

fn parse<T: serde::de::DeserializeOwned>(body: &Bytes) -> Result<T, Response> {
    serde_json::from_slice(body).map_err(|e| error(400, format!("invalid request body: {e}")))
}

fn workspace(service: &Service, id: &str) -> Result<Arc<Workspace>, Response> {
    service
        .workspace(id)
        .ok_or_else(|| error(404, format!("workspace {id} is not registered")))
}

async fn health() -> Response {
    json(
        200,
        serde_json::json!({ "ready": true, "version": env!("CARGO_PKG_VERSION") }),
    )
}

#[derive(serde::Deserialize)]
struct DeviceQuery {
    workspace: Option<String>,
    created: Option<u64>,
}

/// The host's public relay identity; with `?workspace=&created=` also the
/// optional `register-host` proof (protocol §6.2).
async fn device(State(service): Svc, Query(q): Query<DeviceQuery>) -> Response {
    let mut out = serde_json::json!({
        "deviceId": service.device.device_id,
        "keys": service.device.public(),
    });
    if let (Some(ws), Some(created)) = (q.workspace.as_deref(), q.created) {
        out["created"] = created.into();
        out["proof"] = service
            .device
            .registration_proof("canopy-host-device-v1", ws, created)
            .into();
    }
    json(200, out)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PutWorkspace {
    name: String,
    owner_user_id: String,
    #[serde(default)]
    runner_url: Option<String>,
    #[serde(default)]
    runner_token: Option<String>,
}

async fn put_workspace(State(service): Svc, Path(ws): Path<String>, body: Bytes) -> Response {
    if !valid_workspace_id(&ws) {
        return error(400, "invalid workspace id");
    }
    let req: PutWorkspace = match parse(&body) {
        Ok(req) => req,
        Err(response) => return response,
    };
    if req.owner_user_id.trim().is_empty() {
        return error(400, "ownerUserId is required");
    }
    if let Some(url) = req.runner_url.as_deref() {
        if !url.starts_with("http://") {
            return error(400, "runnerUrl must be an http:// URL on this host");
        }
    }
    let registration = Registration {
        name: req.name,
        owner_user_id: req.owner_user_id,
        runner_url: req.runner_url.filter(|u| !u.is_empty()),
        runner_token: req.runner_token.filter(|t| !t.is_empty()),
    };
    match service.register(&ws, registration).await {
        Ok(dir) => json(200, serde_json::json!({ "agentSocketDir": dir })),
        Err(message) => error(500, message),
    }
}

async fn delete_workspace(State(service): Svc, Path(ws): Path<String>) -> Response {
    match service.unregister(&ws).await {
        Ok(true) => json(200, serde_json::json!({})),
        Ok(false) => error(404, format!("workspace {ws} is not registered")),
        Err(message) => error(500, message),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MintBody {
    request_id: String,
    agent: Option<String>,
    name: Option<String>,
    task: Option<String>,
}

async fn mint(State(service): Svc, Path(ws): Path<String>, body: Bytes) -> Response {
    let ws = match workspace(&service, &ws) {
        Ok(ws) => ws,
        Err(response) => return response,
    };
    let req: MintBody = match parse(&body) {
        Ok(req) => req,
        Err(response) => return response,
    };
    match ws.terminals.mint(MintRequest {
        request_id: req.request_id,
        agent: req.agent,
        name: req.name,
        task: req.task,
    }) {
        Ok((token, record)) => {
            ws.events
                .publish("mesh", "terminals", &record.pty_id.to_string());
            json(
                200,
                serde_json::json!({ "token": token, "ptyId": record.pty_id }),
            )
        }
        Err((status, message)) => error(status, message),
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BindBody {
    session_id: u64,
    pid: u32,
}

async fn bind(
    State(service): Svc,
    Path((ws, request)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let ws = match workspace(&service, &ws) {
        Ok(ws) => ws,
        Err(response) => return response,
    };
    let req: BindBody = match parse(&body) {
        Ok(req) => req,
        Err(response) => return response,
    };
    match ws.terminals.bind(&request, req.session_id, req.pid) {
        Ok(record) => {
            ws.events
                .publish("mesh", "terminals", &record.pty_id.to_string());
            json(200, serde_json::json!({ "ptyId": record.pty_id }))
        }
        Err((status, message)) => error(status, message),
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DescribeBody {
    agent: Option<String>,
    name: Option<String>,
    task: Option<String>,
    activity: Option<ActivityBody>,
    /// What the host observed the agent working on (session-resume.mjs).
    repo: Option<String>,
    root: Option<String>,
    files: Option<Vec<WorkFile>>,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct WorkFile {
    path: String,
    #[serde(default)]
    ts: u64,
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ActivityBody {
    #[serde(default)]
    title: String,
    #[serde(default)]
    description: String,
}

async fn describe(
    State(service): Svc,
    Path((ws, request)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let ws = match workspace(&service, &ws) {
        Ok(ws) => ws,
        Err(response) => return response,
    };
    let mut req: DescribeBody = match parse(&body) {
        Ok(req) => req,
        Err(response) => return response,
    };
    let work = (req.repo.is_some() || req.root.is_some() || req.files.is_some()).then(|| {
        (
            req.repo.clone(),
            req.root.clone(),
            req.files
                .take()
                .unwrap_or_default()
                .into_iter()
                .map(|f| (f.path, f.ts))
                .collect::<Vec<_>>(),
        )
    });
    match ws.terminals.describe(
        &request,
        req.agent,
        req.name,
        req.task,
        req.activity.map(|a| (a.title, a.description)),
    ) {
        Ok((record, mut changed)) => {
            if let Some((repo, root, files)) = work {
                match ws.terminals.describe_work(&request, repo, root, files) {
                    Ok(more) => changed |= more,
                    Err((status, message)) => return error(status, message),
                }
            }
            if changed {
                ws.events
                    .publish("mesh", "terminals", &record.pty_id.to_string());
            }
            json(
                200,
                serde_json::json!({ "ptyId": record.pty_id, "changed": changed }),
            )
        }
        Err((status, message)) => error(status, message),
    }
}

async fn revoke(State(service): Svc, Path((ws, request)): Path<(String, String)>) -> Response {
    let ws = match workspace(&service, &ws) {
        Ok(ws) => ws,
        Err(response) => return response,
    };
    ws.revoke_terminal(&request, "exit");
    json(200, serde_json::json!({}))
}

async fn put_access(State(service): Svc, Path(ws): Path<String>, body: Bytes) -> Response {
    let ws = match workspace(&service, &ws) {
        Ok(ws) => ws,
        Err(response) => return response,
    };
    let keys = crate::relay::access::load_keys(&service.config.access_keys);
    let (signed, snapshot) =
        match crate::relay::access::verify(&body, &keys, &ws.id, &service.device.device_id) {
            Ok(verified) => verified,
            Err(message) => return error(400, message),
        };
    match ws.store_access(signed, snapshot) {
        Ok(revision) => json(200, serde_json::json!({ "revision": revision })),
        Err((status, message)) => error(status, message),
    }
}

async fn stream(
    State(service): Svc,
    Path(ws): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let ws = match workspace(&service, &ws) {
        Ok(ws) => ws,
        Err(response) => return response,
    };
    let subscription = ws.events.subscribe(q.get("cursor").map(String::as_str));
    // Built after registering the subscriber: a write racing it is either in
    // the snapshot or queued behind it.
    let first = match subscription.start {
        Start::Snapshot { cursor } => Some(
            Event::default().event("snapshot").id(cursor.clone()).data(
                serde_json::json!({ "cursor": cursor, "stores": service.snapshot_stores(&ws) })
                    .to_string(),
            ),
        ),
        Start::Resume => None,
    };
    let state = (first, subscription.rx, subscription.overflowed, false);
    let events =
        futures_util::stream::unfold(state, |(first, mut rx, overflowed, done)| async move {
            if done {
                return None;
            }
            if let Some(event) = first {
                return Some((Ok::<_, Infallible>(event), (None, rx, overflowed, false)));
            }
            match rx.recv().await {
                Some(change) => {
                    let event = Event::default()
                        .event("change")
                        .id(change.cursor.clone())
                        .data(serde_json::to_string(&change).unwrap_or_default());
                    Some((Ok(event), (None, rx, overflowed, false)))
                }
                None if overflowed.load(Ordering::Acquire) => Some((
                    Ok(Event::default().event("resnapshot").data("{}")),
                    (None, rx, overflowed, true),
                )),
                None => None,
            }
        });
    Sse::new(events)
        .keep_alive(KeepAlive::default())
        .into_response()
}

#[derive(serde::Deserialize)]
struct QueryBody {
    store: String,
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    args: serde_json::Value,
}

fn items(rows: impl serde::Serialize) -> Response {
    json(200, serde_json::json!({ "items": rows }))
}

/// Reads only. Every list answers `{items:[...]}` in the snapshot's shapes.
async fn query(State(service): Svc, Path(ws): Path<String>, body: Bytes) -> Response {
    let ws = match workspace(&service, &ws) {
        Ok(ws) => ws,
        Err(response) => return response,
    };
    let req: QueryBody = match parse(&body) {
        Ok(req) => req,
        Err(response) => return response,
    };
    let action = req.action.as_deref().unwrap_or("list");
    match (req.store.as_str(), action) {
        ("mesh", "list" | "messages") => items(ws.mesh.all()),
        ("mesh", "severed") => items(ws.mesh.severed_pairs()),
        ("mesh", "claims") | ("claims", "list") => match ws.claims.held() {
            Ok(claims) => items(claims),
            Err(message) => error(500, message),
        },
        ("mesh", "claim_history") | ("claims", "history") => {
            let result = match req.args.get("path").and_then(|p| p.as_str()) {
                // Stored normalized (Workspace::claim), so look it up the same way.
                Some(path) => ws
                    .claims
                    .history_for_path(&crate::meshtext::normalize_claim_path(
                        path,
                        Some(crate::terminals::WORKSPACE_ROOT),
                    )),
                None => ws.claims.all_newest(),
            };
            match result {
                Ok(claims) => items(claims),
                Err(message) => error(500, message),
            }
        }
        // The IDE's long poll for device ops (device.rs); asking is also how
        // it says it is there to run them.
        ("device", "pending") => {
            let wait = req.args.get("wait").and_then(|w| w.as_u64()).unwrap_or(0);
            items(ws.device.poll(std::time::Duration::from_millis(wait)).await)
        }
        ("attention", "list") => items(ws.attention.list()),
        ("terminals", "list") => items(
            ws.terminals
                .all()
                .iter()
                .map(|t| t.view())
                .collect::<Vec<_>>(),
        ),
        ("access", "get") => json(200, serde_json::json!({ "snapshot": ws.access() })),
        ("memory", "list") => items(ws.memory.list()),
        ("memory", "proposals") => items(ws.memory.proposals()),
        (table @ ("deliveries" | "jobs" | "inbox" | "outbox"), "list") => {
            match ws.ledger.list(table, 200) {
                Ok(rows) => items(rows),
                Err(message) => error(500, message),
            }
        }
        (store @ ("notes" | "research"), action) => {
            let store = HarnessStore::parse(store).expect("matched");
            let reply = service
                .harness
                .query(&ws.harness_context(), store, action, req.args);
            (
                StatusCode::from_u16(reply.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                [("content-type", "application/json")],
                reply.body,
            )
                .into_response()
        }
        (store, action) => error(400, format!("no query {action} on store {store}")),
    }
}

async fn actions(State(service): Svc, Path(ws): Path<String>, body: Bytes) -> Response {
    let ws = match workspace(&service, &ws) {
        Ok(ws) => ws,
        Err(response) => return response,
    };
    let value: serde_json::Value = match parse(&body) {
        Ok(v) => v,
        Err(response) => return response,
    };
    let Some(actor) = value
        .get("actor")
        .and_then(|a| a.as_str())
        .filter(|a| !a.trim().is_empty())
        .map(str::to_string)
    else {
        return error(400, "actions need the acting user in actor");
    };
    let kind = value
        .get("kind")
        .and_then(|k| k.as_str())
        .unwrap_or_default();
    match kind {
        "answer" | "attention_ack" => {
            let Some(id) = value.get("id").and_then(|i| i.as_str()) else {
                return error(400, format!("{kind} needs id"));
            };
            let answer = if kind == "answer" {
                match value.get("answer") {
                    Some(answer) => answer.clone(),
                    None => return error(400, "answer needs answer"),
                }
            } else {
                "ack".into()
            };
            match ws.attention.answer(id, answer.clone(), &actor) {
                Ok(()) => {
                    let mut out = serde_json::json!({ "ok": true });
                    if kind == "answer"
                        && ws.attention.get(id).and_then(|i| i.op).as_deref() == Some("confirm")
                    {
                        out["accepted"] = accepted(&answer).into();
                    }
                    json(200, out)
                }
                Err(AnswerError::Unknown) => error(404, format!("no attention item {id}")),
                Err(AnswerError::AlreadyResolved(resolution)) => json(
                    409,
                    serde_json::json!({ "error": "already resolved", "resolution": resolution }),
                ),
            }
        }
        "notes_write" | "research_write" => {
            let store = if kind == "notes_write" {
                HarnessStore::Notes
            } else {
                HarnessStore::Research
            };
            let ctx = ws.harness_context();
            let harness = service.harness.clone();
            let reply =
                tokio::task::spawn_blocking(move || harness.user_write(&ctx, store, &actor, value))
                    .await;
            match reply {
                Ok(reply) => (
                    StatusCode::from_u16(reply.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                    [("content-type", "application/json")],
                    reply.body,
                )
                    .into_response(),
                Err(_) => error(500, "the store handler failed"),
            }
        }
        // The control panel's escape hatch for a claim an agent died holding.
        "claim_release" => {
            let Some(owner_key) = value
                .get("ownerKey")
                .and_then(|k| k.as_str())
                .filter(|k| !k.trim().is_empty())
            else {
                return error(400, "claim_release needs ownerKey");
            };
            match ws.release_claims_of(owner_key, "canopy") {
                Ok(released) => json(200, serde_json::json!({ "ok": true, "released": released })),
                Err(message) => error(500, message),
            }
        }
        // Sever or reconnect one pair; answers with the updated list, as the
        // desktop command does.
        "mesh_sever" => {
            let pty = |key: &str| {
                value
                    .get(key)
                    .and_then(|v| v.as_u64())
                    .and_then(|v| u32::try_from(v).ok())
            };
            let (Some(a), Some(b), Some(severed)) = (
                pty("a"),
                pty("b"),
                value.get("severed").and_then(|s| s.as_bool()),
            ) else {
                return error(400, "mesh_sever needs a, b and severed");
            };
            ws.mesh
                .set_severed(a, b, &ws.instance, severed, crate::util::now_ms());
            items(ws.mesh.severed_pairs())
        }
        "mesh_job_update" => mesh_job_update(&ws, &value).await,
        // A piece of the IDE's answer to a relayed device op.
        "device_answer" => {
            let Some(id) = value.get("id").and_then(|i| i.as_str()) else {
                return error(400, "device_answer needs id");
            };
            let status = value
                .get("status")
                .and_then(|s| s.as_u64())
                .and_then(|s| u16::try_from(s).ok())
                .filter(|s| (100..600).contains(s))
                .unwrap_or(200);
            let chunk = value.get("chunk").and_then(|c| c.as_str()).unwrap_or("");
            let offset = value.get("offset").and_then(|o| o.as_u64()).unwrap_or(0) as usize;
            let done = value.get("done").and_then(|d| d.as_bool()).unwrap_or(true);
            match ws.device.answer(id, status, chunk, offset, done) {
                Ok(()) => json(200, serde_json::json!({ "ok": true })),
                Err((status, message)) => error(status, message),
            }
        }
        // Agent awareness, run by the IDE: a hotspot claim for the agent that
        // just edited it (desktop context_hotspot_claim).
        "hotspot_claim" => {
            let Some(pty_id) = value
                .get("ptyId")
                .and_then(|v| v.as_u64())
                .and_then(|v| u32::try_from(v).ok())
            else {
                return error(400, "hotspot_claim needs ptyId");
            };
            let paths: Vec<String> = value
                .get("paths")
                .and_then(|p| serde_json::from_value(p.clone()).ok())
                .unwrap_or_default();
            let owner = value
                .get("owner")
                .and_then(|o| o.as_str())
                .unwrap_or("Canopy")
                .chars()
                .take(200)
                .collect::<String>();
            let note = value
                .get("note")
                .and_then(|n| n.as_str())
                .map(|n| n.chars().take(500).collect());
            match ws.hotspot_claim(pty_id, paths, &owner, note) {
                (200, message) => json(200, serde_json::json!({ "ok": true, "message": message })),
                (status, message) => error(status, message),
            }
        }
        // The desktop's copy of servable team memory, replacing the last.
        "memory_sync" => {
            let root = value
                .get("root")
                .and_then(|r| r.as_str())
                .unwrap_or_default();
            let Some(entries) = value.get("entries").and_then(|e| e.as_array()) else {
                return error(400, "memory_sync needs entries");
            };
            match ws.memory.sync(root, entries) {
                Ok(count) => json(200, serde_json::json!({ "ok": true, "entries": count })),
                Err(message) => error(400, message),
            }
        }
        // Proposals the desktop has taken into its ledger.
        "memory_ack" => {
            let Some(ids) = value.get("ids").and_then(|i| i.as_array()) else {
                return error(400, "memory_ack needs ids");
            };
            let ids: Vec<String> = ids
                .iter()
                .filter_map(|i| i.as_str().map(str::to_string))
                .collect();
            match ws.memory.ack(&ids) {
                Ok(removed) => json(200, serde_json::json!({ "ok": true, "removed": removed })),
                Err(message) => error(500, message),
            }
        }
        other => error(400, format!("unknown action kind {other}")),
    }
}

/// One step of a mesh job (or a relay reply) reported to the workspace
/// terminal that submitted it, as desktop `context_mesh_job_update` does for
/// its own: kept on the mesh under `ref {kind, id}` and announced in that
/// terminal. From Canopy itself, so no sever applies.
async fn mesh_job_update(ws: &Arc<Workspace>, value: &serde_json::Value) -> Response {
    // A job step, a relay reply, an agent-awareness note from the IDE, or
    // "team-chat": the user handing this agent a Teams chat message ("Send to
    // agent" in the IDE viewing this workspace); `jobId` is the message's id.
    let kind = match value.get("refKind").and_then(|k| k.as_str()) {
        None | Some("job") => "job",
        Some("relay") => "relay",
        Some("awareness") => "awareness",
        Some("team-chat") => "team-chat",
        Some(other) => return error(400, format!("unknown mesh update kind {other}")),
    };
    let Some(pty_id) = value
        .get("ptyId")
        .and_then(|v| v.as_u64())
        .and_then(|v| u32::try_from(v).ok())
    else {
        return error(400, "mesh_job_update needs ptyId");
    };
    if value.get("instance").and_then(|i| i.as_str()) != Some(ws.instance.as_str()) {
        return error(
            400,
            "the submitting terminal belongs to an earlier Canopy run",
        );
    }
    let job_id = value
        .get("jobId")
        .and_then(|j| j.as_str())
        .unwrap_or_default()
        .trim();
    if job_id.is_empty() || job_id.len() > 64 {
        return error(400, "a job update needs its job id");
    }
    let text = value
        .get("text")
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .trim();
    if text.is_empty() {
        return error(400, "a job update needs text");
    }
    let text: String = text.chars().take(crate::meshtext::MAX_MESH_TEXT).collect();
    if ws.runner_terminals.runner.read().unwrap().url.is_none() {
        return json(
            503,
            serde_json::json!({
                "error": "unavailable",
                "reason": "not-ready",
                "message": "this workspace's container is not running yet",
            }),
        );
    }
    let Some(target) = ws.terminals.by_pty(pty_id) else {
        return error(404, format!("terminal {pty_id} has exited"));
    };
    let record = ws.mesh.record(canopy_core::mesh::NewMessage {
        from_pty_id: None,
        from_cwd: None,
        from_name: None,
        from_agent: None,
        from_task: None,
        to_pty_id: pty_id,
        to_cwd: Some(crate::terminals::WORKSPACE_ROOT.into()),
        to_name: target.name.clone(),
        to_agent: target.agent.clone(),
        to_task: crate::agent::task_of(&target),
        text,
        items: Vec::new(),
        reply_to: None,
        reference: Some(canopy_core::mesh::MeshRef {
            kind: kind.into(),
            id: job_id.to_string(),
        }),
        instance: Some(ws.instance.clone()),
        at_ms: crate::util::now_ms(),
    });
    let Ok(record) = record else {
        return error(403, "the mesh refused this job update");
    };
    let notice = match kind {
        "relay" => format!(
            "[canopy: cloud workspace reply to {job_id}] {}",
            crate::meshtext::mesh_notice_for(&record)
        ),
        "awareness" => format!(
            "[canopy: awareness] {}",
            crate::meshtext::mesh_notice_for(&record)
        ),
        "team-chat" => format!(
            "[canopy: from the user, via Teams chat] {}",
            crate::meshtext::mesh_notice_for(&record)
        ),
        _ => format!(
            "[canopy: mesh job {job_id}] {}",
            crate::meshtext::mesh_notice_for(&record)
        ),
    };
    if let Err(failure) = ws.deliver(pty_id, &record.id, &notice, None, None).await {
        return match failure {
            crate::workspace::SendError::NotReady(message) => json(
                503,
                serde_json::json!({ "error": "unavailable", "reason": "not-ready", "message": message }),
            ),
            crate::workspace::SendError::Status(status, message) => error(status, message),
        };
    }
    ws.mesh.note_delivery(&record.id, &notice);
    json(200, serde_json::json!({ "id": record.id }))
}

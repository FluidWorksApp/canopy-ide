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
            axum::routing::delete(revoke),
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
                Some(path) => ws.claims.history_for_path(path),
                None => ws.claims.all_newest(),
            };
            match result {
                Ok(claims) => items(claims),
                Err(message) => error(500, message),
            }
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
        other => error(400, format!("unknown action kind {other}")),
    }
}

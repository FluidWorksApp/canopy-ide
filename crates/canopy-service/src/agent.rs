//! The agent API (protocol §2): the desktop bridge's paths, bodies and
//! response shapes, served on one workspace's socket. The credential in
//! `Authorization: Bearer` is the caller; no body field can name another.

use crate::attention::{NewQuestion, DEFAULT_ASK, MAX_ASK};
use crate::harness::{HarnessCaller, HarnessStore};
use crate::meshtext::{
    agent_has_mesh_reader, item_kind, mesh_notice_for, sanitize_message, MAX_MESH_ITEMS,
    MAX_MESH_TEXT,
};
use crate::service::Service;
use crate::terminals::{TerminalRecord, WORKSPACE_ROOT};
use crate::tools::{LAPTOP_ONLY_TOOLS, SERVICE_ACTIONS, SUPPORTED_TOOLS};
use crate::util::now_ms;
use crate::workspace::{SendError, Workspace};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use canopy_core::mesh::{MeshItem, MeshMessage, MeshRef, NewMessage};
use std::sync::Arc;
use std::time::Duration;

pub const BROWSER_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone)]
pub struct AgentState {
    pub service: Arc<Service>,
    pub workspace: Arc<Workspace>,
}

pub fn router(state: AgentState) -> Router {
    Router::new()
        .route("/ctx/identity", get(identity))
        .route("/ctx/tools", get(tools))
        .route("/ctx/claims", get(claims_list).post(claims_post))
        .route("/ctx/mesh", post(mesh_op))
        .route("/ctx/notes", post(notes_op))
        .route("/ctx/research", post(research_op))
        .route("/ctx/action", post(action))
        .route("/ctx/ask", post(ask))
        .route("/ctx/ui", post(ui_op))
        .route("/ctx/browser", post(browser))
        .fallback(fallback)
        .with_state(state)
}

fn reply(status: u16, body: impl Into<String>) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        body.into(),
    )
        .into_response()
}

fn json(status: u16, value: serde_json::Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [("content-type", "application/json")],
        value.to_string(),
    )
        .into_response()
}

/// The protocol's 503: a bounded, specific "not here", never a hang.
pub fn unavailable(reason: &str, message: &str) -> Response {
    json(
        503,
        serde_json::json!({ "error": "unavailable", "reason": reason, "message": message }),
    )
}

fn unauthorized() -> Response {
    reply(401, "bad token")
}

fn caller(state: &AgentState, headers: &HeaderMap) -> Option<TerminalRecord> {
    let presented = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))?;
    state.workspace.terminals.identify(presented.trim())
}

fn parse<T: serde::de::DeserializeOwned>(body: &Bytes) -> Result<T, Response> {
    serde_json::from_slice(body).map_err(|e| reply(400, format!("invalid request body: {e}")))
}

async fn identity(State(state): State<AgentState>, headers: HeaderMap) -> Response {
    let Some(who) = caller(&state, &headers) else {
        return unauthorized();
    };
    json(
        200,
        serde_json::json!({
            "ptyId": who.pty_id,
            "instance": state.workspace.instance,
            "cwd": WORKSPACE_ROOT,
            "runId": null,
            "attemptId": null,
            "workspace": state.workspace.id,
            "project": state.workspace.project_id(),
        }),
    )
}

async fn tools(State(state): State<AgentState>, headers: HeaderMap) -> Response {
    if caller(&state, &headers).is_none() {
        return unauthorized();
    }
    json(
        200,
        serde_json::json!({
            "disabled": LAPTOP_ONLY_TOOLS,
            "buildId": concat!("canopy-service-", env!("CARGO_PKG_VERSION")),
            "supportedActions": SERVICE_ACTIONS,
            "supportedTools": SUPPORTED_TOOLS,
        }),
    )
}

async fn claims_list(State(state): State<AgentState>, headers: HeaderMap) -> Response {
    if caller(&state, &headers).is_none() {
        return unauthorized();
    }
    match state.workspace.claims.held() {
        Ok(claims) => json(200, serde_json::json!({ "claims": claims })),
        Err(error) => reply(500, error),
    }
}

#[derive(serde::Deserialize)]
struct ClaimReq {
    action: String,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    owner: Option<String>,
    note: Option<String>,
    #[serde(default)]
    project: Option<String>,
}

async fn claims_post(State(state): State<AgentState>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(who) = caller(&state, &headers) else {
        return unauthorized();
    };
    let req: ClaimReq = match parse(&body) {
        Ok(req) => req,
        Err(response) => return response,
    };
    if !state.workspace.names_this_project(req.project.as_deref()) {
        return other_project();
    }
    let owner = req
        .owner
        .filter(|o| !o.trim().is_empty())
        .unwrap_or_else(|| display_name(&who));
    let (status, body) = state
        .workspace
        .claim(&who, &req.action, req.paths, &owner, req.note);
    reply(status, body)
}

fn display_name(who: &TerminalRecord) -> String {
    match who.name.as_deref() {
        Some(name) => format!("{name} ({WORKSPACE_ROOT})"),
        None => format!("terminal {} ({WORKSPACE_ROOT})", who.pty_id),
    }
}

fn other_project() -> Response {
    reply(
        400,
        "This cloud workspace is one project; name it or leave project out.",
    )
}

#[derive(serde::Deserialize)]
struct MeshQuery {
    action: String,
    id: Option<String>,
    #[serde(rename = "withPtyId")]
    with_pty_id: Option<u32>,
    #[serde(rename = "refKind")]
    ref_kind: Option<String>,
    #[serde(rename = "refId")]
    ref_id: Option<String>,
    limit: Option<usize>,
    since: Option<String>,
}

fn mesh_seq(id: &str) -> u64 {
    id.strip_prefix('m')
        .and_then(|n| n.parse::<u64>().ok())
        .unwrap_or(0)
}

/// Read side of the mesh. A workspace is one project, so every message in
/// it concerns every agent in it — the desktop's same-project rule.
async fn mesh_op(State(state): State<AgentState>, headers: HeaderMap, body: Bytes) -> Response {
    if caller(&state, &headers).is_none() {
        return unauthorized();
    }
    let q: MeshQuery = match parse(&body) {
        Ok(q) => q,
        Err(response) => return response,
    };
    let mesh = &state.workspace.mesh;
    match q.action.as_str() {
        "get" => {
            let Some(id) = q.id.as_deref() else {
                return reply(400, "get needs id, e.g. m12");
            };
            match mesh.get(id) {
                Some(m) => json(200, serde_json::json!({ "message": m })),
                None => reply(
                    404,
                    format!("No mesh message {id} in your history (see canopy_mesh history)"),
                ),
            }
        }
        "history" => {
            let limit = q.limit.unwrap_or(50).clamp(1, 200);
            let since = q.since.as_deref().map(mesh_seq).unwrap_or(0);
            let mut messages: Vec<MeshMessage> = mesh
                .all()
                .into_iter()
                .filter(|m| since == 0 || mesh_seq(&m.id) > since)
                .filter(|m| {
                    q.with_pty_id.is_none()
                        || m.from_pty_id == q.with_pty_id
                        || Some(m.to_pty_id) == q.with_pty_id
                })
                .filter(|m| match (&q.ref_kind, &q.ref_id) {
                    (None, None) => true,
                    _ => m.reference.as_ref().is_some_and(|r| {
                        q.ref_kind.as_deref().is_none_or(|k| r.kind == k)
                            && q.ref_id.as_deref().is_none_or(|i| r.id == i)
                    }),
                })
                .collect();
            let total = messages.len();
            if messages.len() > limit {
                let excess = messages.len() - limit;
                messages.drain(0..excess);
            }
            json(
                200,
                serde_json::json!({
                    "messages": messages,
                    "total": total,
                    "note": "oldest first; pass since=<last id> to fetch only what's new",
                }),
            )
        }
        other => reply(
            400,
            format!("canopy_mesh has no action \"{other}\" — use history or get"),
        ),
    }
}

async fn harness_op(
    state: AgentState,
    headers: HeaderMap,
    body: Bytes,
    store: HarnessStore,
) -> Response {
    let Some(who) = caller(&state, &headers) else {
        return unauthorized();
    };
    let value: serde_json::Value = match parse(&body) {
        Ok(v) => v,
        Err(response) => return response,
    };
    if !state
        .workspace
        .names_this_project(value.get("project").and_then(|p| p.as_str()))
    {
        return other_project();
    }
    let caller = HarnessCaller {
        pty_id: who.pty_id,
        instance: state.workspace.instance.clone(),
        cwd: WORKSPACE_ROOT.into(),
        key: who.key(&state.workspace.instance),
    };
    let ctx = state.workspace.harness_context();
    let harness = state.service.harness.clone();
    let out =
        tokio::task::spawn_blocking(move || harness.agent_op(&ctx, store, &caller, value)).await;
    match out {
        Ok(r) => reply(r.status, r.body),
        Err(_) => reply(500, "the store handler failed"),
    }
}

async fn notes_op(State(state): State<AgentState>, headers: HeaderMap, body: Bytes) -> Response {
    harness_op(state, headers, body, HarnessStore::Notes).await
}

async fn research_op(State(state): State<AgentState>, headers: HeaderMap, body: Bytes) -> Response {
    harness_op(state, headers, body, HarnessStore::Research).await
}

#[derive(serde::Deserialize)]
struct MeshItemReq {
    path: String,
    kind: Option<String>,
    note: Option<String>,
}

#[derive(serde::Deserialize)]
struct Action {
    kind: String,
    #[serde(default)]
    project: Option<String>,
    #[serde(rename = "ptyId")]
    pty_id: Option<u32>,
    name: Option<String>,
    text: Option<String>,
    pr: Option<String>,
    level: Option<String>,
    status: Option<String>,
    summary: Option<String>,
    asked: Option<String>,
    url: Option<String>,
    title: Option<String>,
    description: Option<String>,
    icon: Option<String>,
    tags: Option<Vec<String>>,
    items: Option<Vec<MeshItemReq>>,
    #[serde(rename = "replyTo")]
    reply_to: Option<String>,
    #[serde(rename = "ref")]
    mesh_ref: Option<MeshRef>,
}

async fn action(State(state): State<AgentState>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(who) = caller(&state, &headers) else {
        return unauthorized();
    };
    let act: Action = match parse(&body) {
        Ok(act) => act,
        Err(response) => return response,
    };
    if !state.workspace.names_this_project(act.project.as_deref()) {
        return other_project();
    }
    let ws = &state.workspace;
    match act.kind.as_str() {
        "job_done" => job_done(ws, &who, act),
        "task_named" => task_named(ws, &who, act),
        "notify" => {
            let Some(text) = act.text.as_deref() else {
                return reply(400, "notify needs text");
            };
            ws.attention.fyi(
                &display_name(&who),
                text,
                act.level.as_deref().unwrap_or("info"),
                Some(who.pty_id),
            );
            reply(200, "Told the user.")
        }
        "close_session" => {
            // The caller's own terminal, from its credential — a body ptyId
            // cannot name another. The gateway owns stopping the session once
            // the turn ends; it sees the request on the stream.
            ws.terminals
                .update(who.pty_id, |t| t.close_requested_ms = Some(now_ms()));
            ws.events
                .publish("terminals", "close", &who.pty_id.to_string());
            reply(
                200,
                "Closing this terminal — Canopy waits for your turn to end first. Say goodbye in \
                 one sentence, start nothing new, and call no more tools.",
            )
        }
        "mesh_send" => mesh_send(ws, &who, act).await,
        "message_agent" => message_agent(ws, &who, act).await,
        "open_file" | "show_diff" | "open_preview" => unavailable(
            "no-ide",
            &format!(
                "{} needs the Canopy IDE, and none is attached to this cloud workspace.",
                act.kind
            ),
        ),
        "start_server"
        | "stop_server"
        | "restart_server"
        | "spawn_agent"
        | "message_agent_start" => unavailable(
            "not-implemented",
            &format!("{} is not served by this cloud service yet.", act.kind),
        ),
        other => reply(400, format!("unknown action: {other}")),
    }
}

fn job_done(ws: &Arc<Workspace>, who: &TerminalRecord, act: Action) -> Response {
    let status =
        match act.status.as_deref() {
            Some(s @ ("done" | "blocked")) => s.to_string(),
            _ => return reply(
                400,
                "job_done needs status: \"done\" (job complete) or \"blocked\" (you need the user)",
            ),
        };
    let Some(summary) = act.summary.filter(|s| !s.trim().is_empty()) else {
        return reply(
            400,
            "job_done needs a summary — one sentence on what happened or what you need",
        );
    };
    let outcome = serde_json::json!({
        "status": status,
        "summary": summary,
        "asked": act.asked,
        "url": act.url,
        "title": act.title,
        "icon": act.icon,
        "tags": act.tags,
        "atMs": now_ms(),
    });
    ws.terminals
        .update(who.pty_id, |t| t.job_done = Some(outcome));
    ws.attention.fyi(
        &format!(
            "{} {}",
            display_name(who),
            if status == "done" {
                "finished"
            } else {
                "is blocked"
            }
        ),
        &summary,
        if status == "done" { "success" } else { "warn" },
        Some(who.pty_id),
    );
    if let Ok(Some(job)) = ws.ledger.open_job_for_pty(who.pty_id) {
        ws.job_transition(&job, &status, &summary);
    }
    ws.events
        .publish("terminals", "job_done", &who.pty_id.to_string());
    reply(
        200,
        match status.as_str() {
            "done" => "Acknowledged — the user has been told. If this terminal is a Canopy micro-task it now closes: say goodbye in one sentence and start nothing new.",
            _ => "Noted — Canopy told the user what you need. This session stays open; wait for their reply here.",
        },
    )
}

fn task_named(ws: &Arc<Workspace>, who: &TerminalRecord, act: Action) -> Response {
    if act.title.is_none() && act.description.is_none() && act.icon.is_none() && act.tags.is_none()
    {
        return reply(
            400,
            "canopy_name_task needs at least one of title, description, icon or tags",
        );
    }
    if act
        .description
        .as_deref()
        .is_some_and(|d| d.trim().is_empty())
    {
        return reply(400, "working-on status needs a non-empty description");
    }
    ws.terminals.update(who.pty_id, |t| {
        let mut status = t.status.take().unwrap_or_else(|| serde_json::json!({}));
        for (key, value) in [
            ("title", act.title.map(serde_json::Value::from)),
            ("description", act.description.map(serde_json::Value::from)),
            ("icon", act.icon.map(serde_json::Value::from)),
            ("tags", act.tags.map(serde_json::Value::from)),
        ] {
            if let Some(value) = value {
                status[key] = value;
            }
        }
        status["atMs"] = now_ms().into();
        t.status = Some(status);
    });
    ws.events
        .publish("terminals", "status", &who.pty_id.to_string());
    reply(
        200,
        "Noted — the run name and live description are updated. Carry on with the job.",
    )
}

fn task_of(t: &TerminalRecord) -> Option<String> {
    t.status
        .as_ref()
        .and_then(|s| s.get("title"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| t.task.clone())
}

fn new_message(
    ws: &Workspace,
    from: &TerminalRecord,
    to: &TerminalRecord,
    text: String,
    items: Vec<MeshItem>,
    reply_to: Option<String>,
    reference: Option<MeshRef>,
) -> NewMessage {
    NewMessage {
        from_pty_id: Some(from.pty_id),
        from_cwd: Some(WORKSPACE_ROOT.into()),
        from_name: from.name.clone(),
        from_agent: from.agent.clone(),
        from_task: task_of(from),
        to_pty_id: to.pty_id,
        to_cwd: Some(WORKSPACE_ROOT.into()),
        to_name: to.name.clone(),
        to_agent: to.agent.clone(),
        to_task: task_of(to),
        text,
        items,
        reply_to,
        reference,
        instance: Some(ws.instance.clone()),
        at_ms: now_ms(),
    }
}

fn severed_refusal(severed: &canopy_core::mesh::Severed) -> Response {
    reply(
        404,
        format!(
            "No route to Canopy terminal {to} from your terminal {from}: the user disconnected \
             this pair in the agent control panel. It can be reconnected there; until then, \
             reach the user with canopy_notify (see canopy_agents).",
            to = severed.to_pty_id,
            from = severed.from_pty_id,
        ),
    )
}

fn send_error(error: SendError) -> Response {
    match error {
        SendError::NotReady(message) => unavailable("not-ready", &message),
        SendError::Status(status, message) => reply(status, message),
    }
}

fn target_by_id(ws: &Workspace, id: u32) -> Result<TerminalRecord, Response> {
    ws.terminals.by_pty(id).ok_or_else(|| {
        reply(
            404,
            format!("No running Canopy terminal with id {id} (see canopy_agents)"),
        )
    })
}

async fn mesh_send(ws: &Arc<Workspace>, who: &TerminalRecord, act: Action) -> Response {
    let Some(id) = act.pty_id else {
        return reply(
            400,
            "mesh_send needs ptyId — a terminal id from canopy_agents",
        );
    };
    let Some(text) = act.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) else {
        return reply(400, "mesh_send needs text");
    };
    if text.len() > MAX_MESH_TEXT {
        return reply(
            400,
            format!(
                "mesh_send text is capped at {} KB — share the rest as a file item",
                MAX_MESH_TEXT / 1024
            ),
        );
    }
    let target = match target_by_id(ws, id) {
        Ok(t) => t,
        Err(response) => return response,
    };
    if who.pty_id == id {
        return reply(
            400,
            "That's your own terminal — say it to the user instead.",
        );
    }
    let items = act.items.unwrap_or_default();
    if items.len() > MAX_MESH_ITEMS {
        return reply(
            400,
            format!(
                "a mesh message shares at most {MAX_MESH_ITEMS} items — share a directory path \
                 in the text instead"
            ),
        );
    }
    // Items are container paths; the host cannot stat them, so only their
    // shape is checked here.
    let mut checked = Vec::new();
    for item in items {
        let path = item.path.trim().to_string();
        if !path.starts_with('/') {
            return reply(
                400,
                format!("item path {path} isn't absolute — the receiver resolves nothing"),
            );
        }
        checked.push(MeshItem {
            kind: item.kind.unwrap_or_else(|| item_kind(&path)),
            path,
            note: item.note,
        });
    }
    if let Some(r) = act.reply_to.as_deref() {
        if ws.mesh.get(r).is_none() {
            return reply(
                400,
                format!("replyTo \"{r}\" names no mesh message (see canopy_mesh)"),
            );
        }
    }
    let record = match ws.mesh.record(new_message(
        ws,
        who,
        &target,
        text.to_string(),
        checked,
        act.reply_to.clone(),
        act.mesh_ref.clone(),
    )) {
        Ok(record) => record,
        Err(severed) => return severed_refusal(&severed),
    };
    let notice = format!("{} {}", ws.sender_tag(Some(who)), mesh_notice_for(&record));
    if let Err(error) = ws.deliver(id, &record.id, &notice, None, None).await {
        return send_error(error);
    }
    ws.mesh.note_delivery(&record.id, &notice);
    reply(
        200,
        if agent_has_mesh_reader(record.to_agent.as_deref()) {
            format!(
                "Sent mesh message {rid} to terminal {id}: a one-line notice with the id was \
                 typed into its session, and the full message ({}between you on the mesh). It \
                 can read it with canopy_mesh get {rid} and reply with canopy_mesh_send \
                 replyTo \"{rid}\".",
                if record.items.is_empty() {
                    "kept "
                } else {
                    "with its shared items, kept "
                },
                rid = record.id,
            )
        } else {
            format!(
                "Sent mesh message {} to terminal {id}. That CLI has no mesh reader, so its \
                 bounded body and shared file paths were typed inline.",
                record.id
            )
        },
    )
}

async fn message_agent(ws: &Arc<Workspace>, who: &TerminalRecord, act: Action) -> Response {
    let Some(text) = act.text.as_deref() else {
        return reply(400, "message_agent needs text");
    };
    if act.pty_id.is_some() && act.name.is_some() {
        return reply(400, "message_agent accepts either ptyId or name, not both");
    }
    let target = if let Some(id) = act.pty_id {
        match target_by_id(ws, id) {
            Ok(t) => t,
            Err(response) => return response,
        }
    } else if let Some(name) = act.name.as_deref() {
        match ws.terminals.by_name(name) {
            Ok(t) => t,
            Err(error) => return reply(404, error),
        }
    } else if act.pr.is_some() {
        return unavailable(
            "not-implemented",
            "Messaging the agent behind a pull request is not served by this cloud service yet; \
             address it by ptyId or name.",
        );
    } else {
        return reply(400, "message_agent needs ptyId, name, or pr");
    };
    let id = target.pty_id;
    if who.pty_id == id {
        return reply(
            400,
            "That's your own terminal — say it to the user instead.",
        );
    }
    let body = sanitize_message(text);
    if body.is_empty() {
        return reply(400, "message_agent needs text with something in it");
    }
    let record = match ws.mesh.record(new_message(
        ws,
        who,
        &target,
        body.clone(),
        Vec::new(),
        None,
        None,
    )) {
        Ok(record) => record,
        Err(severed) => return severed_refusal(&severed),
    };
    let line = format!("{} {body}", ws.sender_tag(Some(who)));
    if let Err(error) = ws.deliver(id, &record.id, &line, None, None).await {
        return send_error(error);
    }
    reply(
        200,
        format!(
            "Sent to terminal {id} as mesh message {rid}, tagged as coming from you. It \
             answers in its own session — read its reply with canopy_server_output({id}). \
             The send is on the mesh: canopy_mesh keeps it, and a reply can name it via \
             replyTo.",
            rid = record.id
        ),
    )
}

#[derive(serde::Deserialize)]
struct AskReq {
    #[serde(default)]
    op: Option<String>,
    question: Option<String>,
    #[serde(default)]
    options: Vec<String>,
    action: Option<String>,
    detail: Option<String>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
}

/// ask_user / confirm (protocol §5): a persisted question that holds the
/// connection until its deadline. Timeout is never consent.
async fn ask(State(state): State<AgentState>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(who) = caller(&state, &headers) else {
        return unauthorized();
    };
    let req: AskReq = match parse(&body) {
        Ok(req) => req,
        Err(response) => return response,
    };
    ask_with(&state, &who, req).await
}

async fn ask_with(state: &AgentState, who: &TerminalRecord, req: AskReq) -> Response {
    let op = req.op.as_deref().unwrap_or("ask");
    let (title, body, choices) = match op {
        "ask" => {
            let Some(question) = req.question.filter(|q| !q.trim().is_empty()) else {
                return reply(400, "ask needs a question");
            };
            let choices = (!req.options.is_empty()).then_some(req.options);
            (question, String::new(), choices)
        }
        "confirm" => {
            let Some(action) = req.action.filter(|a| !a.trim().is_empty()) else {
                return reply(400, "confirm needs an action");
            };
            (
                action,
                req.detail.unwrap_or_default(),
                Some(vec!["accept".to_string(), "decline".to_string()]),
            )
        }
        other => return reply(400, format!("unknown ask op: {other}")),
    };
    if req
        .request_id
        .as_deref()
        .is_some_and(|r| !crate::terminals::valid_request_id(r))
    {
        return reply(400, "requestId must be 8-128 of [A-Za-z0-9:-]");
    }
    let timeout = req
        .timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_ASK)
        .min(MAX_ASK);
    let ws = &state.workspace;
    let item = ws.attention.ask(NewQuestion {
        request_id: req.request_id,
        owner_key: who.key(&ws.instance),
        pty_id: Some(who.pty_id),
        op: op.to_string(),
        title,
        body,
        choices,
        timeout,
    });
    let resolution = ws.attention.wait(&item.id).await.unwrap_or_default();
    let confirm = op == "confirm";
    if resolution.get("expired").and_then(|v| v.as_bool()) == Some(true) {
        let mut out =
            serde_json::json!({ "expired": true, "message": "no user present", "id": item.id });
        if confirm {
            out["accepted"] = false.into();
        }
        return json(200, out);
    }
    let answer = resolution.get("answer").cloned().unwrap_or_default();
    let mut out = serde_json::json!({ "answer": answer, "id": item.id });
    if confirm {
        out["accepted"] = accepted(&answer).into();
    }
    json(200, out)
}

/// Only an explicit acceptance is consent; anything else declines.
pub fn accepted(answer: &serde_json::Value) -> bool {
    match answer {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::String(s) => {
            matches!(s.as_str(), "accept" | "accepted" | "yes" | "allow")
        }
        _ => false,
    }
}

/// The desktop's `/ctx/ui`: ask and confirm are served here as attention;
/// every other op needs something this service does not have.
async fn ui_op(State(state): State<AgentState>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(who) = caller(&state, &headers) else {
        return unauthorized();
    };
    let value: serde_json::Value = match parse(&body) {
        Ok(v) => v,
        Err(response) => return response,
    };
    let op = value.get("op").and_then(|v| v.as_str()).unwrap_or_default();
    match op {
        "ask" | "confirm" => match serde_json::from_value::<AskReq>(value.clone()) {
            Ok(req) => ask_with(&state, &who, req).await,
            Err(error) => reply(400, error.to_string()),
        },
        "vault" => unavailable("laptop-only", "The vault stays on the laptop."),
        "open_project" => unavailable(
            "no-ide",
            "open_project needs the Canopy IDE, and none is attached to this cloud workspace.",
        ),
        other => unavailable(
            "not-implemented",
            &format!("{other} is not served by this cloud service yet."),
        ),
    }
}

/// Browser ops run against the container's Chromium through the runner.
async fn browser(State(state): State<AgentState>, headers: HeaderMap, body: Bytes) -> Response {
    if caller(&state, &headers).is_none() {
        return unauthorized();
    }
    let mut value: serde_json::Value = match parse(&body) {
        Ok(v) => v,
        Err(response) => return response,
    };
    let Some(op) = value.get("op").and_then(|v| v.as_str()).map(str::to_string) else {
        return reply(400, "browser needs op");
    };
    if let Some(object) = value.as_object_mut() {
        object.remove("op");
    }
    let endpoint = state.workspace.runner.read().unwrap().clone();
    let Some(url) = endpoint.url else {
        return unavailable(
            "not-ready",
            "This workspace's container is not running yet.",
        );
    };
    let mut request = state
        .service
        .http
        .post(format!("{}/browser", url.trim_end_matches('/')))
        .timeout(BROWSER_TIMEOUT)
        .header("content-type", "application/json")
        .body(serde_json::json!({ "op": op, "args": value }).to_string());
    if let Some(token) = endpoint.token.as_deref() {
        request = request.bearer_auth(token);
    }
    match request.send().await {
        Ok(response) => {
            let status = response.status().as_u16();
            let text = response.text().await.unwrap_or_default();
            reply(status, text)
        }
        Err(error) if error.is_timeout() => reply(
            504,
            format!(
                "The browser did not answer {op} within {} s.",
                BROWSER_TIMEOUT.as_secs()
            ),
        ),
        Err(error) => reply(502, format!("The browser runner is unreachable: {error}")),
    }
}

async fn fallback(State(state): State<AgentState>, headers: HeaderMap, uri: Uri) -> Response {
    if caller(&state, &headers).is_none() {
        return unauthorized();
    }
    let path = uri.path();
    let (reason, what) = match path {
        "/ctx/device" => ("laptop-only", "Device tools run only on the laptop."),
        "/ctx/editor" | "/ctx/annotations" => (
            "no-ide",
            "This needs the Canopy IDE, and none is attached to this cloud workspace.",
        ),
        _ => (
            "not-implemented",
            "This is not served by this cloud service yet.",
        ),
    };
    unavailable(reason, &format!("{path}: {what}"))
}

//! Context bridge: the app-side answer to "what does the IDE know that my
//! agent doesn't?".
//!
//! Agents run in Canopy's PTYs, but as plain CLI processes they can't see the
//! IDE around them — which components the project has, which dev servers are
//! running, what those servers are printing. This module serves that context
//! over a loopback-only, token-gated HTTP endpoint, and `canopy-hook --mcp`
//! (see bin/canopy_hook.rs) exposes it to the agent as MCP tools. The port and
//! token travel to agents via PTY env (`CANOPY_CTX_PORT` / `CANOPY_CTX_TOKEN`,
//! set in pty.rs), so only processes inside Canopy's own terminals can ask.
//!
//! The workspace model (projects, components, run commands) lives in the
//! frontend, so the frontend pushes per-project snapshots down via
//! `context_publish`; PTY scrollback is already Rust-side and is read live.

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager};

/// Directories never worth an agent's attention (or token budget) when listing
/// a component's files.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".venv",
    "__pycache__",
    "coverage",
];
const MAX_FILES_DEFAULT: usize = 500;
const MAX_OUTPUT_BYTES: usize = 512 * 1024;

pub struct ContextBridge {
    /// Per-project snapshots the frontend publishes, keyed by project id.
    snapshots: Mutex<HashMap<String, serde_json::Value>>,
    port: OnceLock<u16>,
    /// The process-wide credential, for callers Canopy starts itself that are
    /// not a terminal — the companion. It names nobody, so anything that has to
    /// know *which* agent is asking refuses it; see `Caller`.
    token: String,
    /// One credential per terminal, minted at spawn and dropped at exit. This
    /// is what makes "who is calling" answerable at all: with a single shared
    /// token every identity claim had to be a body field the caller filled in
    /// itself, so an agent could name any owner, release anyone's claim, and be
    /// believed. The token is the identity, and the caller cannot choose it.
    agents: Mutex<HashMap<String, AgentIdentity>>,
    /// Browser-control and UI ops in flight: the HTTP handler parks a sender
    /// here and waits; the frontend answers through the `browser_result`
    /// command (one ticket space for every request/response op, browser or not).
    pending: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<(bool, serde_json::Value)>>>,
    next_op: AtomicU64,
    /// Advisory file claims, newest last, held and ended together. Several
    /// agents routinely share one checkout; a claim is how one says "I'm editing
    /// these" loudly enough for the others (and the Agents panel) to see it.
    /// Advisory on purpose — nothing here blocks a write, it just stops the
    /// collision being invisible.
    claims: Mutex<Vec<Claim>>,
    /// Claim ids, which only have to be unique within this app run — see
    /// MAX_ENDED_CLAIMS for why the store never outlives it.
    next_claim: AtomicU64,
    /// Tools the user switched off in Settings → Agents. `None` until the
    /// frontend publishes, which is the same as "everything is on".
    disabled_tools: Mutex<Option<Vec<String>>>,
    /// Every message one agent has typed into another's terminal this run,
    /// newest last. A message used to leave no trace anywhere: it arrived in
    /// the target's composer looking exactly like something the user had typed,
    /// so neither the user nor the receiving agent could tell that another
    /// agent had reached in.
    messages: Mutex<Vec<MeshMessage>>,
    next_message: AtomicU64,
}

/// Who is on the other end of a bridge request, established from the
/// credential rather than from anything the caller wrote in the body.
#[derive(Clone, Debug, PartialEq)]
pub struct AgentIdentity {
    pub pty_id: u32,
    /// The app run that spawned the terminal. Pty ids restart at 1 every
    /// launch, so the id alone names a different terminal after a restart.
    pub instance: String,
    pub cwd: String,
}

impl AgentIdentity {
    /// The identity a claim is keyed by, and the thing two agents sharing one
    /// checkout must not have in common. The cwd is deliberately absent: it is
    /// what the old owner string was built from, and it is the same for every
    /// agent in a shared checkout — which is exactly the case claims exist for.
    pub fn key(&self) -> String {
        format!("pty:{}:{}", self.instance, self.pty_id)
    }
}

/// A caller the bridge has authenticated.
#[derive(Clone, Debug, PartialEq)]
pub enum Caller {
    /// A terminal Canopy spawned, holding the token minted for it.
    Agent(AgentIdentity),
    /// The process-wide token. Trusted — Canopy handed it out — but anonymous,
    /// so it can act for itself and never for a named agent.
    Root,
}

impl Caller {
    fn agent(&self) -> Option<&AgentIdentity> {
        match self {
            Caller::Agent(a) => Some(a),
            Caller::Root => None,
        }
    }
}

/// One agent-to-agent message, as delivered.
#[derive(Clone, serde::Serialize)]
pub struct MeshMessage {
    pub id: String,
    /// The terminal that sent it, when the sender was an agent. `None` is the
    /// companion or another root-token caller.
    pub from_pty_id: Option<u32>,
    pub from_cwd: Option<String>,
    pub to_pty_id: u32,
    /// What was actually written into the target — after flattening and
    /// sanitising, not what the sender passed. The record is of the delivery.
    pub text: String,
    pub at_ms: u64,
    /// False when the terminal died before the return that submits it could be
    /// written, which leaves the message sitting unsent in the target's
    /// composer. Previously this failure was discarded and nobody ever learned
    /// the message had not landed.
    pub submitted: bool,
}

/// How many delivered messages the log keeps. Same reasoning as
/// MAX_ENDED_CLAIMS: it is worth having while the agents involved are alive,
/// and they all die with the app.
const MAX_MESSAGES: usize = 200;

/// One agent's advisory claim over a set of paths, and everything that has
/// happened to it since.
///
/// A release used to delete the row, so the two questions the user asks of a
/// claim after the fact — when did that agent let go, and what did it hold up
/// while it had it — had no answer anywhere. Ending a claim now writes its
/// ending down instead.
#[derive(Clone, serde::Serialize)]
pub struct Claim {
    /// Identity for the detail tab. The owner cannot be it: an agent that
    /// claims, releases and claims again is two claims with one owner, and a
    /// tab opened on the first must not silently start showing the second.
    pub id: String,
    pub paths: Vec<String>,
    /// Who holds it, for a human to read — the agent's cwd plus whatever name
    /// it gave itself. Display only: it is supplied by the caller, and every
    /// agent in a shared checkout writes the same one.
    pub owner: String,
    /// Who holds it, for the rules to compare. Derived from the caller's
    /// credential (see `AgentIdentity::key`), never from the body.
    ///
    /// Splitting this from `owner` is the whole fix for the defect that made
    /// claims useless where they mattered most: the conflict test was
    /// `owner != owner`, and two agents sharing a checkout had the same owner
    /// string — so they never collided with each other, and the second one's
    /// claim silently superseded the first's.
    pub owner_key: String,
    /// The terminal behind the claim, so a claim can be swept when its agent
    /// dies and resolved to a live session without parsing a display string.
    pub pty_id: Option<u32>,
    pub instance: Option<String>,
    pub note: Option<String>,
    pub at_ms: u64,
    /// None while it is held; this is the only thing that decides whether a
    /// claim still blocks anyone.
    pub released_at_ms: Option<u64>,
    /// How it ended: `agent` (it released), `canopy` (dropped from the UI, for
    /// an agent that died holding it) or `superseded` (the same owner claimed
    /// again). The wording is the frontend's business; this is the fact.
    pub released_by: Option<String>,
    /// Claims turned away because they overlapped this one, oldest first. The
    /// collision is the most useful thing a claim ever records — it is the
    /// moment two agents wanted the same file — and it used to exist only in a
    /// 409 body the user never saw.
    pub refusals: Vec<Refusal>,
}

/// A claim that was refused, recorded against the claim that refused it.
#[derive(Clone, serde::Serialize)]
pub struct Refusal {
    pub owner: String,
    pub paths: Vec<String>,
    pub note: Option<String>,
    pub at_ms: u64,
}

/// How many refusals one held claim remembers.
///
/// Unbounded, this is a hole: the 409 tells the refused agent to "pick
/// different files, or ask that agent to release them", and an agent that
/// instead retries in a loop appends a refusal per attempt forever — each one
/// re-serialised into every claims response thereafter. The newest are the ones
/// worth keeping; a contested path says the same thing at ten refusals as at
/// ten thousand.
const MAX_REFUSALS: usize = 50;

/// How many ended claims the history keeps.
///
/// The store stays in memory, and this cap is its whole retention policy. A
/// claim's history is worth having while the agents involved are still around
/// to be asked about it, and every one of them dies with the app — so writing
/// it under ~/.canopy would buy a log of processes that no longer exist, at the
/// price of a store to migrate, prune and keep two app instances from
/// corrupting. The live list is empty after a restart by definition; its
/// history being empty too is the honest match.
const MAX_ENDED_CLAIMS: usize = 200;

impl Default for ContextBridge {
    fn default() -> Self {
        let mut bytes = [0u8; 16];
        let _ = getrandom::getrandom(&mut bytes);
        Self {
            snapshots: Mutex::new(HashMap::new()),
            port: OnceLock::new(),
            token: hex::encode(bytes),
            agents: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
            next_op: AtomicU64::new(1),
            claims: Mutex::new(Vec::new()),
            next_claim: AtomicU64::new(1),
            disabled_tools: Mutex::new(None),
            messages: Mutex::new(Vec::new()),
            next_message: AtomicU64::new(1),
        }
    }
}

fn random_token() -> String {
    let mut bytes = [0u8; 16];
    let _ = getrandom::getrandom(&mut bytes);
    hex::encode(bytes)
}

impl ContextBridge {
    /// What Canopy's own non-terminal children export (the companion). Names
    /// nobody on purpose — see `token`.
    pub fn env(&self) -> Option<(u16, String)> {
        self.port.get().map(|p| (*p, self.token.clone()))
    }

    /// Mint this terminal's own credential. Called once per spawn, before the
    /// child exists, so the token is in its environment from its first
    /// instruction and there is no window in which it holds someone else's.
    pub fn mint_agent(&self, pty_id: u32, cwd: &str) -> Option<(u16, String)> {
        let port = *self.port.get()?;
        let token = random_token();
        self.agents.lock().unwrap().insert(
            token.clone(),
            AgentIdentity {
                pty_id,
                instance: crate::pty::instance_token().to_string(),
                cwd: cwd.to_string(),
            },
        );
        Some((port, token))
    }

    /// Drop a terminal's credential when the terminal goes. Returns the
    /// identity it named, which is what the claim sweep needs — after this the
    /// bridge can no longer answer "who was pty 7", so the caller must be given
    /// it here rather than looking it up afterwards.
    pub fn retire_agent(&self, pty_id: u32) -> Option<AgentIdentity> {
        let mut agents = self.agents.lock().unwrap();
        let instance = crate::pty::instance_token();
        let token = agents
            .iter()
            .find(|(_, a)| a.pty_id == pty_id && a.instance == instance)
            .map(|(t, _)| t.clone())?;
        agents.remove(&token)
    }

    fn identify(&self, presented: &str) -> Option<Caller> {
        if constant_time_eq(presented, &self.token) {
            return Some(Caller::Root);
        }
        // Not constant-time against the agent map, and it does not need to be:
        // a hit is a full-length random token the attacker would have to
        // possess, and the map is keyed by the token itself, so there is no
        // per-candidate comparison to time.
        self.agents
            .lock()
            .unwrap()
            .get(presented)
            .cloned()
            .map(Caller::Agent)
    }
}

/// Compare without leaking where the first difference was. The token travels
/// over loopback to processes Canopy started, so this is defence in depth
/// rather than a live hole — but a byte-by-byte `==` on a credential is worth
/// no argument.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Bind the loopback listener and serve until app exit. Called once from
/// setup; failures are logged, not fatal — the IDE works without the bridge,
/// agents just lose the context tools.
pub fn start(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", 0)).await {
            Ok(l) => l,
            Err(e) => {
                log::warn!("context bridge: cannot bind: {e}");
                return;
            }
        };
        let port = match listener.local_addr() {
            Ok(a) => a.port(),
            Err(e) => {
                log::warn!("context bridge: no local addr: {e}");
                return;
            }
        };
        let _ = app.state::<ContextBridge>().port.set(port);
        let router = Router::new()
            .route("/ctx/snapshot", get(snapshot))
            .route("/ctx/server-output/:id", get(server_output))
            .route("/ctx/files", get(files))
            .route("/ctx/annotations", get(annotations))
            .route("/ctx/resources", get(resources))
            .route("/ctx/action", post(action))
            .route("/ctx/browser", post(browser))
            .route("/ctx/device", post(device))
            .route("/ctx/network", get(network))
            .route("/ctx/editor", get(editor))
            .route("/ctx/ui", post(ui_op))
            .route("/ctx/wait", get(wait))
            .route("/ctx/claims", get(claims_list).post(claims_post))
            .route("/ctx/research", post(research_op))
            .route("/ctx/notes", post(notes_op))
            .route("/ctx/tools", get(tools))
            .with_state(app.clone());
        let _ = axum::serve(listener, router).await;
    });
}

// ---- commands the frontend feeds the bridge with --------------------------

#[tauri::command]
pub fn context_publish(
    state: tauri::State<'_, ContextBridge>,
    project_id: String,
    data: String,
) -> Result<(), String> {
    let value: serde_json::Value =
        serde_json::from_str(&data).map_err(|e| format!("bad snapshot: {e}"))?;
    state.snapshots.lock().unwrap().insert(project_id, value);
    Ok(())
}

#[tauri::command]
pub fn context_remove(state: tauri::State<'_, ContextBridge>, project_id: String) {
    state.snapshots.lock().unwrap().remove(&project_id);
}

/// Which canopy_* tools the user switched off (Settings → Agents). Published on
/// change and at startup; the sidecar filters its `tools/list` against this, so
/// a disabled tool never even reaches the agent's context window.
#[tauri::command]
pub fn context_tools(state: tauri::State<'_, ContextBridge>, disabled: Vec<String>) {
    *state.disabled_tools.lock().unwrap() = Some(disabled);
}

/// Every advisory claim currently held, for the Agents panel. Held only: the
/// count beside "Claimed files" means "files an agent has right now", and an
/// ended claim is history, not a holder.
#[tauri::command]
pub fn context_claims(state: tauri::State<'_, ContextBridge>) -> Vec<Claim> {
    state
        .claims
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.released_at_ms.is_none())
        .cloned()
        .collect()
}

/// Held and ended claims together, newest first — what a claim's detail tab
/// reads. Separate from `context_claims` so the panel's list keeps meaning what
/// it always meant.
#[tauri::command]
pub fn context_claim_history(state: tauri::State<'_, ContextBridge>) -> Vec<Claim> {
    let mut all = state.claims.lock().unwrap().clone();
    all.reverse();
    all
}

/// Drop a claim from the UI — the escape hatch for an agent that died holding
/// one, so a stale claim is never permanent.
#[tauri::command]
pub fn context_release_claim(app: tauri::AppHandle, owner_key: String) {
    with_claims(&app, |claims| {
        let n = end_claims(claims, &owner_key, now_ms(), "canopy");
        ((), n > 0)
    });
}

/// Every message one agent has typed into another this run, newest last — the
/// evidence that used to exist nowhere.
#[tauri::command]
pub fn context_messages(state: tauri::State<'_, ContextBridge>) -> Vec<MeshMessage> {
    state.messages.lock().unwrap().clone()
}

/// The frontend's answer to a browser-control op: `data` is a JSON document
/// (or plain text) that becomes the waiting HTTP response's body. An id nobody
/// is waiting on (op timed out, duplicate answer) is dropped silently.
#[tauri::command]
pub fn browser_result(state: tauri::State<'_, ContextBridge>, id: u64, ok: bool, data: String) {
    if let Some(tx) = state.pending.lock().unwrap().remove(&id) {
        let value = serde_json::from_str(&data).unwrap_or(serde_json::Value::String(data));
        let _ = tx.send((ok, value));
    }
}

// ---- HTTP handlers --------------------------------------------------------

/// Who is asking, or `None` if the credential is not one Canopy issued.
///
/// Every handler that acts *for* a caller — claims, messages — must use this
/// rather than `authorized`, because the identity it returns is the only one
/// the caller did not choose for itself.
fn caller(app: &tauri::AppHandle, headers: &HeaderMap) -> Option<Caller> {
    let presented = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))?;
    app.state::<ContextBridge>().identify(presented)
}

/// For handlers that only serve context back and so do not care who asked.
fn authorized(app: &tauri::AppHandle, headers: &HeaderMap) -> bool {
    caller(app, headers).is_some()
}

async fn snapshot(State(app): State<tauri::AppHandle>, headers: HeaderMap) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let projects: Vec<serde_json::Value> = app
        .state::<ContextBridge>()
        .snapshots
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect();
    (
        StatusCode::OK,
        serde_json::json!({ "projects": projects }).to_string(),
    )
}

/// The annotations the user has marked on preview pages, across open projects
/// — read-only, so an agent can pull the current visual feedback (element +
/// comment + which component serves it) without waiting for it to be typed in.
async fn annotations(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let list: Vec<serde_json::Value> = app
        .state::<ContextBridge>()
        .snapshots
        .lock()
        .unwrap()
        .values()
        .filter_map(|p| p.get("annotations").and_then(|a| a.as_array()).cloned())
        .flatten()
        .collect();
    (
        StatusCode::OK,
        serde_json::json!({ "annotations": list }).to_string(),
    )
}

/// What the user is looking at right now: the focused project, its open tabs,
/// the file in front of them, and where the caret sits. The context an agent is
/// otherwise missing when the ask is "fix this" or "make it match the other
/// one" — the IDE is the only thing that knows what "this" is.
async fn editor(State(app): State<tauri::AppHandle>, headers: HeaderMap) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let states: Vec<serde_json::Value> = app
        .state::<ContextBridge>()
        .snapshots
        .lock()
        .unwrap()
        .values()
        .filter_map(|p| {
            let e = p.get("editor")?.clone();
            let mut obj = e.as_object()?.clone();
            obj.insert("project".into(), p.get("name").cloned().unwrap_or_default());
            Some(serde_json::Value::Object(obj))
        })
        .collect();
    (
        StatusCode::OK,
        serde_json::json!({ "projects": states }).to_string(),
    )
}

// ---- research -------------------------------------------------------------
//
// Research is scoped to one project, and this handler is the only door an agent
// has to it. That scoping is not a filter applied to a global result — it is
// the first thing that happens: the caller's cwd resolves to exactly one open
// project, every action runs against that project's directory, and there is no
// argument an agent can pass to reach another one. A cwd inside no open project
// is an error, never a machine-wide list.

/// Which open project owns this directory. The longest matching component path
/// wins, so a component nested inside another (a sub-package registered in its
/// own right) resolves to the nearer one rather than to whichever was published
/// first.
/// Resolve a project the caller NAMED, rather than one inferred from where it
/// happens to be sitting.
///
/// Notes and research are scoped to a project, and until now the only way to
/// say which was the caller's cwd. That works for a coding agent, which lives
/// in exactly one checkout, and fails for the companion, which deliberately
/// lives in none — it could read every project's notes and write to none of
/// them, and had to explain that to the user as a limitation.
///
/// Matched on name, case-insensitively, because the name is what the user and
/// the companion both say out loud. An unknown name is None, so the caller gets
/// the "which project?" error rather than silently landing in another one.
/// Why a request found no project, said in the terms the caller can act on:
/// the name it gave was not one Canopy has, or it gave none and its directory
/// is not in one either.
fn scope_hint(project: Option<&str>, cwd: &str) -> String {
    match project {
        Some(p) if !p.trim().is_empty() => format!(" (no project called \"{p}\")"),
        _ => format!(" ({cwd} is not inside one)"),
    }
}

fn project_by_name(app: &tauri::AppHandle, name: &str) -> Option<ProjectCandidate> {
    let wanted = name.trim().to_lowercase();
    if wanted.is_empty() {
        return None;
    }
    let bridge = app.state::<ContextBridge>();
    let snapshots = bridge.snapshots.lock().unwrap();
    snapshots.values().find_map(|snap| {
        let id = snap.get("id").and_then(|v| v.as_str())?;
        if id.is_empty() {
            return None;
        }
        let name = snap.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name.to_lowercase() != wanted {
            return None;
        }
        let roots: Vec<String> = snap
            .get("components")
            .and_then(|v| v.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|c| c.get("path").and_then(|p| p.as_str()))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        Some((id.to_string(), name.to_string(), roots))
    })
}

/// The project a request is about: the one it named, else the one its cwd is
/// in. Naming wins, so an agent that knows which project it means is never
/// overruled by where it is running.
fn project_for_request(
    app: &tauri::AppHandle,
    project: Option<&str>,
    cwd: &str,
) -> Option<ProjectCandidate> {
    project
        .and_then(|p| project_by_name(app, p))
        .or_else(|| project_for_cwd(app, cwd))
}

/// The directory an action or a browser op should be *routed* by: the project
/// the caller named, else the directory it happens to be sitting in.
///
/// The cwd alone was the whole routing story, and for a coding agent it still
/// is — it lives in one checkout and that checkout is the answer. The companion
/// lives in none, so its cwd (`~/.canopy/companion`) matched no project and the
/// frontend fell back to "the single open project": correct with one project
/// open, and with two it refused outright — "an agent asked to act, but its
/// directory isn't in any open project" — so the companion could not put a
/// preview in front of the user at all. Naming the project is how an agent that
/// is in none says which one it means.
///
/// An unknown name is an error rather than a fallback, on the same terms as
/// notes and research: silently landing in another project is worse than being
/// told the name was wrong.
fn route_for_project(
    app: &tauri::AppHandle,
    project: Option<&str>,
    cwd: Option<&str>,
) -> Result<String, String> {
    match project.map(str::trim).filter(|p| !p.is_empty()) {
        Some(name) => project_by_name(app, name)
            .and_then(|(_, _, roots)| roots.into_iter().next())
            .ok_or_else(|| {
                format!("no project called \"{name}\" — canopy_workspace lists them by name")
            }),
        None => Ok(cwd.unwrap_or_default().to_string()),
    }
}

fn project_for_cwd(app: &tauri::AppHandle, cwd: &str) -> Option<ProjectCandidate> {
    let bridge = app.state::<ContextBridge>();
    let snapshots = bridge.snapshots.lock().unwrap();
    let candidates: Vec<ProjectCandidate> = snapshots
        .values()
        .filter_map(|snap| {
            let id = snap.get("id").and_then(|v| v.as_str())?;
            if id.is_empty() {
                return None;
            }
            let name = snap
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let roots: Vec<String> = snap
                .get("components")
                .and_then(|v| v.as_array())
                .map(|list| {
                    list.iter()
                        .filter_map(|c| c.get("path").and_then(|p| p.as_str()))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            Some((id.to_string(), name, roots))
        })
        .collect();
    resolve_project(&candidates, cwd, main_worktree)
}

/// A project a directory can resolve to: its id, its display name, and the
/// component paths that decide whether a directory belongs to it.
type ProjectCandidate = (String, String, Vec<String>);

/// The scoping rule itself, separated from where the snapshots came from so it
/// can be tested: longest containing component path wins.
/// The main checkout behind a directory, when that directory is a linked
/// worktree. `--git-common-dir` is the shared `.git` every worktree of a repo
/// points at, so its parent is the original checkout — which is the thing
/// actually registered as a project component.
///
/// A subprocess, on a path that only runs when the direct match already
/// failed. Research calls are a handful per session, not per tool call, so the
/// few milliseconds buy correctness cheaply.
fn main_worktree(cwd: &str) -> Option<String> {
    let out = std::process::Command::new("git")
        .args([
            "-C",
            cwd,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let git_dir = String::from_utf8(out.stdout).ok()?.trim().to_string();
    if git_dir.is_empty() {
        return None;
    }
    let root = std::path::Path::new(&git_dir).parent()?;
    Some(root.to_string_lossy().to_string())
}

/// Which project owns this directory, falling back to the repo it is a
/// worktree of.
///
/// Agents work in worktrees constantly — it is how every isolated micro-task
/// runs, including the one that implements research — and a worktree created
/// as `<repo>-wt-<branch>` is a *sibling* of the checkout, so no component path
/// contains it. Research therefore refused exactly the sessions most likely to
/// produce any, and an agent with no legitimate place to write improvised one
/// by hand-writing the store. Resolving through git is what removes the reason
/// to improvise.
///
/// `main_of` is injected so the rule can be tested without a repo on disk.
fn resolve_project(
    candidates: &[ProjectCandidate],
    cwd: &str,
    main_of: impl Fn(&str) -> Option<String>,
) -> Option<ProjectCandidate> {
    if let Some(hit) = pick_project(candidates, cwd) {
        return Some(hit);
    }
    let root = main_of(cwd)?;
    // Only worth a second look if git actually moved us somewhere else.
    if root == cwd {
        return None;
    }
    pick_project(candidates, &root)
}

fn pick_project(candidates: &[ProjectCandidate], cwd: &str) -> Option<ProjectCandidate> {
    let mut best: Option<(usize, &ProjectCandidate)> = None;
    for cand in candidates {
        for root in &cand.2 {
            let r = root.trim_end_matches('/');
            // Directory containment, not string prefix: /repo-old must not
            // resolve to /repo.
            if r.is_empty() || !(cwd == r || cwd.starts_with(&format!("{r}/"))) {
                continue;
            }
            // Spelled out rather than `is_none_or`, which is stable only since
            // 1.82 and this crate's MSRV is 1.77.2.
            let better = match best {
                Some((n, _)) => r.len() > n,
                None => true,
            };
            if better {
                best = Some((r.len(), cand));
            }
        }
    }
    best.map(|(_, c)| c.clone())
}

#[derive(serde::Deserialize)]
struct ResearchReq {
    action: String,
    cwd: String,
    /// Which project this is about, by name. Absent falls back to `cwd`.
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    question: Option<String>,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    statuses: Option<Vec<String>>,
    #[serde(default)]
    digest: Option<String>,
    #[serde(default)]
    recommendation: Option<String>,
    #[serde(default)]
    open_questions: Option<Vec<String>>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    by: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    pty_id: Option<u64>,
    /// Which app launch the calling terminal belongs to — pty ids restart with
    /// the app, so the session binding is keyed by both.
    #[serde(default)]
    instance: Option<String>,
    #[serde(default)]
    pr: Option<crate::research::PrLink>,
    #[serde(default)]
    ticket: Option<crate::research::TicketLink>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    files: Option<Vec<String>>,
    #[serde(default)]
    supersedes: Option<String>,
    /// import: the markdown file to adopt.
    #[serde(default)]
    path: Option<String>,
}

async fn research_op(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Json(req): Json<ResearchReq>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let Some((project_id, project_name, roots)) =
        project_for_request(&app, req.project.as_deref(), &req.cwd)
    else {
        return (
            StatusCode::BAD_REQUEST,
            format!(
                "Research is scoped to a project, and this call named none Canopy has open{}. \
                 Pass `project` with the project's name to say which — or run from inside one \
                 of its directories. Do not write to the research store by hand: an entry made \
                 that way skips the status rules, the size limits and the history.",
                scope_hint(req.project.as_deref(), &req.cwd)
            ),
        );
    };
    let store = app.state::<crate::research::ResearchStore>();
    let need_id = |r: &ResearchReq| -> Result<String, String> {
        r.id.clone()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "this action needs an id — call list to see them".to_string())
    };

    let out: Result<serde_json::Value, String> = (|| match req.action.as_str() {
        "list" => {
            crate::research::research_list(project_id.clone(), req.statuses.clone(), req.limit)
                .map(|rows| serde_json::json!({ "research": rows }))
        }
        "search" => crate::research::research_search(
            project_id.clone(),
            req.query.clone().unwrap_or_default(),
            req.limit,
        )
        .map(|rows| serde_json::json!({ "research": rows })),
        "get" => crate::research::research_get(project_id.clone(), need_id(&req)?)
            .and_then(|d| serde_json::to_value(d).map_err(|e| e.to_string())),
        "start" => crate::research::research_start(
            app.clone(),
            store.clone(),
            project_id.clone(),
            Some(project_name.clone()),
            Some(roots.clone()),
            req.title.clone().unwrap_or_default(),
            req.question.clone(),
            req.agent.clone(),
            Some(req.cwd.clone()),
            req.pty_id,
            req.tags.clone(),
            req.instance.clone(),
        )
        .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
        // digest and append are the same command; naming them separately at the
        // tool boundary is what stops an agent treating the digest as somewhere
        // to put the whole finding.
        "digest" | "update" | "append" => crate::research::research_update(
            app.clone(),
            store.clone(),
            project_id.clone(),
            need_id(&req)?,
            req.title.clone(),
            req.digest.clone(),
            req.recommendation.clone(),
            req.open_questions.clone(),
            req.tags.clone(),
            (req.action == "append").then(|| req.text.clone().unwrap_or_default()),
            None,
        )
        .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
        "source" => crate::research::research_add_source(
            app.clone(),
            store.clone(),
            project_id.clone(),
            need_id(&req)?,
            req.title.clone().unwrap_or_default(),
            req.text.clone().unwrap_or_default(),
            req.origin.clone(),
        )
        .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
        "status" => crate::research::research_set_status(
            app.clone(),
            store.clone(),
            project_id.clone(),
            need_id(&req)?,
            req.status.clone().unwrap_or_default(),
            req.by.clone(),
            req.note.clone(),
        )
        .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
        // The same adoption the file tab's button performs, reachable by an
        // agent that finds loose research while doing something else.
        "import" => crate::research::research_import(
            app.clone(),
            store.clone(),
            project_id.clone(),
            Some(project_name.clone()),
            Some(roots.clone()),
            req.path.clone().unwrap_or_default(),
            req.instance.clone(),
        )
        .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
        "link" | "supersede" => crate::research::research_link(
            app.clone(),
            store.clone(),
            project_id.clone(),
            need_id(&req)?,
            req.pr.clone(),
            req.ticket.clone(),
            req.branch.clone(),
            req.files.clone(),
            req.supersedes.clone(),
        )
        .and_then(|d| serde_json::to_value(d).map_err(|e| e.to_string())),
        other => Err(format!(
            "unknown research action: {other} — one of list, search, get, start, digest, \
             append, source, status, link, import"
        )),
    })();

    match out {
        Ok(value) => (StatusCode::OK, value.to_string()),
        // A tool failure, not a protocol failure: the agent reads the text and
        // corrects itself (a cap it exceeded, a transition it may not make).
        Err(text) => (StatusCode::BAD_REQUEST, text),
    }
}

// ---- the scratchpad ------------------------------------------------------
//
// The half of notes that agents get. The panel and ⌘K are how a human parks a
// thought; this is how an agent does — "I noticed three unrelated things while
// fixing this" is the case, and before this the only options were to derail
// onto them or to lose them.

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotesReq {
    action: String,
    cwd: String,
    /// Which project this is about, by name. Absent falls back to `cwd`.
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    statuses: Option<Vec<String>>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    note: Option<String>,
    #[serde(default)]
    by: Option<String>,
    #[serde(default)]
    pr: Option<crate::notes::PrLink>,
    #[serde(default)]
    research: Option<String>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    file: Option<crate::notes::FileRef>,
    /// attach: an absolute path already on disk, inside a workspace root.
    #[serde(default)]
    path: Option<String>,
    /// remind: when. Any of the shapes `remind::parse_when` accepts — an ISO
    /// stamp, a local wall clock, a bare date, or epoch seconds. Taken as a
    /// string even when it is a number so a JSON integer and its digits are the
    /// same request.
    #[serde(default)]
    at: Option<serde_json::Value>,
    /// remind: a delay instead of a time — `45m`, `2h`, `3d`.
    #[serde(default, rename = "in")]
    within: Option<String>,
    /// remind: `true` takes the reminder off.
    #[serde(default)]
    clear: Option<bool>,
}

async fn notes_op(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Json(req): Json<NotesReq>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let Some((project_id, project_name, roots)) =
        project_for_request(&app, req.project.as_deref(), &req.cwd)
    else {
        return (
            StatusCode::BAD_REQUEST,
            format!(
                "A note belongs to a project, and this call named none Canopy has open{}. \
                 Pass `project` with the project's name to say which — or run from inside one \
                 of its directories.",
                scope_hint(req.project.as_deref(), &req.cwd)
            ),
        );
    };
    let store = app.state::<crate::notes::NotesStore>();
    let ws = app.state::<crate::fsx::WorkspaceManager>();
    let need_id = |r: &NotesReq| -> Result<String, String> {
        r.id.clone()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "this action needs an id — call list to see them".to_string())
    };

    let out: Result<serde_json::Value, String> = (|| match req.action.as_str() {
        "list" => crate::notes::notes_list(project_id.clone(), req.statuses.clone(), req.limit)
            .map(|rows| serde_json::json!({ "notes": rows })),
        "search" => crate::notes::notes_search(
            project_id.clone(),
            req.query.clone().unwrap_or_default(),
            req.limit,
        )
        .map(|rows| serde_json::json!({ "notes": rows })),
        "get" => crate::notes::notes_get(project_id.clone(), need_id(&req)?)
            .and_then(|d| serde_json::to_value(d).map_err(|e| e.to_string())),
        "create" => crate::notes::notes_create(
            store.clone(),
            project_id.clone(),
            Some(project_name.clone()),
            Some(roots.clone()),
            req.title.clone().unwrap_or_default(),
            req.text.clone(),
            req.tags.clone(),
            // No page context: an agent has no page. The `origin` is what
            // answers "where do my notes come from" later.
            None,
            Some("agent".into()),
            Some(req.cwd.clone()),
        )
        .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
        "append" => crate::notes::notes_update(
            store.clone(),
            project_id.clone(),
            need_id(&req)?,
            req.title.clone(),
            None,
            req.text.clone(),
            req.tags.clone(),
        )
        .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
        "status" => crate::notes::notes_set_status(
            store.clone(),
            project_id.clone(),
            need_id(&req)?,
            req.status.clone().unwrap_or_default(),
            // Credited to the agent, not to the user: the history is the one
            // record of who moved a note, and it has to stay honest.
            req.by.clone().or_else(|| Some("an agent".into())),
            req.note.clone(),
        )
        .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string())),
        "link" => crate::notes::notes_link(
            store.clone(),
            project_id.clone(),
            need_id(&req)?,
            req.pr.clone(),
            req.research.clone(),
            None,
            req.branch.clone(),
            req.file.clone(),
        )
        .and_then(|d| serde_json::to_value(d).map_err(|e| e.to_string())),
        "attach" => crate::notes::notes_attach_file(
            store.clone(),
            ws.clone(),
            project_id.clone(),
            need_id(&req)?,
            req.path.clone().unwrap_or_default(),
            req.title.clone(),
            None,
        )
        .and_then(|a| serde_json::to_value(a).map_err(|e| e.to_string())),
        // The agent's half of the reminder. Worth its own action rather than a
        // field on `create`: the case that matters most is putting a time on a
        // note that already exists — the user's own, written weeks ago — and an
        // agent that could only set one while creating would be an agent that
        // has to duplicate the note to remind you of it.
        "remind" => {
            let clear = req.clear.unwrap_or(false);
            let at = if clear {
                None
            } else {
                let raw = req.at.as_ref().and_then(|v| match v {
                    serde_json::Value::String(s) => Some(s.clone()),
                    serde_json::Value::Number(n) => Some(n.to_string()),
                    _ => None,
                });
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                Some(crate::remind::parse_when(
                    raw.as_deref(),
                    req.within.as_deref(),
                    now,
                )?)
            };
            crate::notes::notes_remind(
                store.clone(),
                project_id.clone(),
                need_id(&req)?,
                at,
                req.text.clone().or_else(|| req.note.clone()),
                req.by.clone().or_else(|| Some("an agent".into())),
            )
            .and_then(|s| serde_json::to_value(s).map_err(|e| e.to_string()))
        }
        other => Err(format!(
            "unknown notes action: {other} — one of list, search, get, create, append, \
             status, link, attach, remind"
        )),
    })();

    match out {
        Ok(value) => (StatusCode::OK, value.to_string()),
        Err(text) => (StatusCode::BAD_REQUEST, text),
    }
}

/// The tool switches from Settings → Agents. Answered even when nothing has
/// been published (nothing disabled), so the sidecar can treat any error as
/// "everything is on" rather than hiding tools on a hiccup.
async fn tools(State(app): State<tauri::AppHandle>, headers: HeaderMap) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let disabled = app
        .state::<ContextBridge>()
        .disabled_tools
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_default();
    (
        StatusCode::OK,
        serde_json::json!({ "disabled": disabled }).to_string(),
    )
}

async fn claims_list(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
) -> (StatusCode, String) {
    let Some(who) = caller(&app, &headers) else {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    };
    // Held only. An agent asks this to find out what it must not touch, and a
    // claim somebody let go of is not that.
    //
    // Scoped to the caller's own tree. Unscoped, this shipped every open
    // project's claimed paths and owner directories to every agent — including
    // when the user had shared context switched off for the project, whose
    // whole promise is that one session cannot be read from another.
    let cwd = who.agent().map(|a| a.cwd.clone());
    let claims: Vec<Claim> = app
        .state::<ContextBridge>()
        .claims
        .lock()
        .unwrap()
        .iter()
        .filter(|c| c.released_at_ms.is_none())
        .filter(|c| match cwd.as_deref() {
            Some(cwd) => claim_concerns(c, cwd),
            // The companion asks on the user's behalf, not an agent's.
            None => true,
        })
        .cloned()
        .collect();
    (
        StatusCode::OK,
        serde_json::json!({ "claims": claims }).to_string(),
    )
}

/// Whether a claim is any of this caller's business: it holds files under the
/// caller's directory, or its owner works in a directory that contains (or sits
/// inside) the caller's. Deliberately a tree test rather than a project lookup
/// — a claim is about files, and the question an agent is really asking is
/// "could this collide with me".
fn claim_concerns(claim: &Claim, cwd: &str) -> bool {
    claim_owner_cwd(&claim.owner).is_some_and(|owner_cwd| paths_overlap(&owner_cwd, cwd))
        || claim.paths.iter().any(|p| paths_overlap(p, cwd))
}

/// The directory out of a display owner string ("name (/path)"). Display-only
/// parsing, and never used to decide who holds what — that is `owner_key`.
fn claim_owner_cwd(owner: &str) -> Option<String> {
    let start = owner.rfind('(')?;
    let end = owner.rfind(')')?;
    (end > start).then(|| owner[start + 1..end].to_string())
}

#[derive(serde::Deserialize)]
struct ClaimReq {
    /// claim | release
    action: String,
    #[serde(default)]
    paths: Vec<String>,
    /// What to call the holder in the UI. Display only — see `Claim::owner`.
    owner: String,
    note: Option<String>,
}

/// Take or drop an advisory claim. A claim that overlaps someone else's is
/// refused with the holder's name: the point is to surface the collision at the
/// moment it would happen, while the agent can still pick different work.
async fn claims_post(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Json(mut req): Json<ClaimReq>,
) -> (StatusCode, String) {
    let Some(who) = caller(&app, &headers) else {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    };
    let bridge = app.state::<ContextBridge>();
    let id = format!("c{}", bridge.next_claim.fetch_add(1, Ordering::Relaxed));
    let holder = ClaimIdentity::of(&who, &req.owner);
    // Relative paths are resolved against the caller's own directory, and `..`
    // is folded out, before anything compares them. Two agents claiming the
    // same file by different spellings both used to succeed: the overlap test
    // is string-prefix, so "src/auth" and "/repo/src/auth" never met.
    req.paths = req
        .paths
        .iter()
        .map(|p| normalize_claim_path(p, who.agent().map(|a| a.cwd.as_str())))
        .collect();
    let reply = with_claims(&app, |claims| {
        let reply = apply_claim(claims, &req, &holder, now_ms(), &id);
        // A refusal is a write too — it is recorded against the claim that
        // turned it away — so it announces like any other.
        let changed = !matches!(reply, ClaimReply::Bad(_));
        (reply, changed)
    });
    match reply {
        Some(ClaimReply::Ok(msg)) => (StatusCode::OK, msg),
        Some(ClaimReply::Conflict(msg)) => (StatusCode::CONFLICT, msg),
        Some(ClaimReply::Bad(msg)) => (StatusCode::BAD_REQUEST, msg),
        // The bridge answered, so its own state must exist; saying so beats a
        // success the caller would believe.
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "the claim store isn't available".into(),
        ),
    }
}

/// The one door to the claim store, and therefore the one place that says it
/// moved.
///
/// `change.rs` argues this at length for the stores under ~/.canopy: announcing
/// from the callers is what leaves a write silent, and the fix is to put the
/// announce where the write is. Claims are in-memory and single-process, so
/// they keep their own event rather than joining the `store:change` channel —
/// but the boundary rule is the same one, and it is enforced by there being no
/// other way to reach the lock.
fn with_claims<R: tauri::Runtime, T>(
    app: &tauri::AppHandle<R>,
    f: impl FnOnce(&mut Vec<Claim>) -> (T, bool),
) -> Option<T> {
    // try_state, and generic over the runtime, so the sweep on pty exit comes
    // through this door too — a second way to write claims is how the announce
    // goes missing again.
    let bridge = app.try_state::<ContextBridge>()?;
    let (out, changed) = {
        let mut claims = bridge.claims.lock().unwrap();
        f(&mut claims)
    };
    if changed {
        let _ = app.emit("agent:claims", ());
    }
    Some(out)
}

/// Who a claim belongs to, resolved from the credential.
struct ClaimIdentity {
    key: String,
    display: String,
    pty_id: Option<u32>,
    instance: Option<String>,
}

impl ClaimIdentity {
    fn of(who: &Caller, display: &str) -> Self {
        match who.agent() {
            Some(a) => Self {
                key: a.key(),
                display: display.to_string(),
                pty_id: Some(a.pty_id),
                instance: Some(a.instance.clone()),
            },
            // The companion has no terminal, so it cannot be told apart from
            // another root-token caller by anything but what it calls itself.
            // Keyed separately so it can never collide with a real agent's key.
            None => Self {
                key: format!("root:{display}"),
                display: display.to_string(),
                pty_id: None,
                instance: None,
            },
        }
    }
}

/// Fold `.` and `..` out of a path and resolve a relative one against the
/// agent's directory, without touching the filesystem — a claim is often taken
/// on a file that does not exist yet.
fn normalize_claim_path(raw: &str, base: Option<&str>) -> String {
    // On Windows a backslash is a separator, and `..` spelled with them was
    // invisible to a `/`-only split — which put the traversal straight back,
    // backslash-spelled, into every check built on this. On Unix a backslash is
    // a legal filename character and must be left alone.
    let raw = if cfg!(windows) {
        std::borrow::Cow::Owned(raw.replace('\\', "/"))
    } else {
        std::borrow::Cow::Borrowed(raw)
    };
    let trimmed = raw.trim();
    let joined = match (trimmed.starts_with('/'), base) {
        (false, Some(base)) if !trimmed.is_empty() => {
            format!("{}/{}", base.trim_end_matches('/'), trimmed)
        }
        _ => trimmed.to_string(),
    };
    let absolute = joined.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                // A leading `..` on a relative path has nothing to pop and must
                // survive, or two different paths flatten into one.
                if matches!(out.last(), Some(&last) if last != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            p => out.push(p),
        }
    }
    let body = out.join("/");
    if absolute {
        format!("/{body}")
    } else {
        body
    }
}

enum ClaimReply {
    Ok(String),
    Conflict(String),
    Bad(String),
}

/// The claim rules themselves, over the store the bridge holds.
///
/// Lifted out of the handler so they can be tested: that an ended claim blocks
/// nobody, that a refused claim is recorded against the one that turned it
/// away, and that neither of those quietly loses the history.
fn apply_claim(
    claims: &mut Vec<Claim>,
    req: &ClaimReq,
    who: &ClaimIdentity,
    now: u64,
    id: &str,
) -> ClaimReply {
    match req.action.as_str() {
        "release" => {
            // Keyed by identity, so releasing ends the caller's own claims and
            // only those. Keyed by the display string, as it was, an agent
            // could end anyone's claims simply by naming them — and two agents
            // in one checkout ended each other's without meaning to, because
            // they shared a name.
            let n = end_claims(claims, &who.key, now, "agent");
            ClaimReply::Ok(format!("Released {n} claim(s)."))
        }
        "claim" => {
            if req.paths.is_empty() {
                return ClaimReply::Bad("claim needs paths".into());
            }
            // A path that normalises to nothing, or to the root, overlaps
            // everything: `paths_overlap` is a prefix test, so an empty string
            // is a prefix of every path there is. Claiming one would collide
            // with every held claim in the app — reading back the first
            // holder's directory and note on the way — and, if nothing were
            // held, would take a claim that refused every other agent
            // everywhere until it was released.
            if let Some(bad) = req
                .paths
                .iter()
                .find(|p| p.is_empty() || p.as_str() == "/" || !p.starts_with('/'))
            {
                return ClaimReply::Bad(format!(
                    "\"{bad}\" isn't a file or directory this claim can name — claim the actual \
                     paths you're about to work on."
                ));
            }
            let colliding: Vec<usize> = claims
                .iter()
                .enumerate()
                .filter(|(_, c)| {
                    c.released_at_ms.is_none()
                        && c.owner_key != who.key
                        && c.paths
                            .iter()
                            .any(|held| req.paths.iter().any(|want| paths_overlap(held, want)))
                })
                .map(|(i, _)| i)
                .collect();
            if !colliding.is_empty() {
                // Recorded against every holder it collided with, not just the
                // first. A claim spanning files held by three agents used to
                // tell one of them and leave the other two believing their
                // files were uncontested.
                for &i in &colliding {
                    let held = &mut claims[i];
                    held.refusals.push(Refusal {
                        owner: who.display.clone(),
                        paths: req.paths.clone(),
                        note: req.note.clone(),
                        at_ms: now,
                    });
                    if held.refusals.len() > MAX_REFUSALS {
                        let excess = held.refusals.len() - MAX_REFUSALS;
                        held.refusals.drain(0..excess);
                    }
                }
                let held = &claims[colliding[0]];
                let others = colliding.len() - 1;
                let also = match others {
                    0 => String::new(),
                    1 => " (and one other agent holds some of them too)".into(),
                    n => format!(" (and {n} other agents hold some of them too)"),
                };
                return ClaimReply::Conflict(format!(
                    "{} already claimed {} ({}){}. Pick different files, or ask that agent \
                     to release them.",
                    held.owner,
                    held.paths.join(", "),
                    held.note.clone().unwrap_or_else(|| "no note".into()),
                    also
                ));
            }
            end_claims(claims, &who.key, now, "superseded");
            claims.push(Claim {
                id: id.to_string(),
                paths: req.paths.clone(),
                owner: who.display.clone(),
                owner_key: who.key.clone(),
                pty_id: who.pty_id,
                instance: who.instance.clone(),
                note: req.note.clone(),
                at_ms: now,
                released_at_ms: None,
                released_by: None,
                refusals: Vec::new(),
            });
            prune_claims(claims);
            ClaimReply::Ok(format!("Claimed {} path(s).", req.paths.len()))
        }
        other => ClaimReply::Bad(format!("unknown claim action: {other}")),
    }
}

/// End every claim this identity still holds, and say how. Returns how many,
/// which is what the agent is told it released.
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

/// Let go of everything a terminal was holding, because the terminal is gone.
///
/// Without this a crashed agent's claim was permanent until a human noticed the
/// row and pressed Release: the store is in memory, nothing watched pty exits,
/// and the claim carried no terminal to sweep by even if something had.
pub fn release_claims_for_pty<R: tauri::Runtime>(app: &tauri::AppHandle<R>, pty_id: u32) {
    let Some(identity) = app
        .try_state::<ContextBridge>()
        .and_then(|b| b.retire_agent(pty_id))
    else {
        return;
    };
    with_claims(app, |claims| {
        let n = end_claims(claims, &identity.key(), now_ms(), "canopy");
        ((), n > 0)
    });
}

/// Forget the oldest endings once the history is longer than it is useful. Only
/// ended claims are ever dropped — a held one is live state, however old.
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

/// Same file, or one inside the other's directory — a claim on a directory
/// covers what's under it.
fn paths_overlap(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim_end_matches('/'), b.trim_end_matches('/'));
    a == b || a.starts_with(&format!("{b}/")) || b.starts_with(&format!("{a}/"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Live CPU/memory for every Canopy terminal, with a per-process breakdown —
/// the same reading the status tray shows, served so an agent can see what a
/// build or dev server is costing (and which child process is the hog) without
/// a shell. Read straight from the monitor's latest tick.
async fn resources(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let stats = app
        .state::<crate::agents::StatsCache>()
        .0
        .lock()
        .unwrap()
        .clone();
    let terminals: Vec<serde_json::Value> = stats
        .iter()
        .map(|s| {
            serde_json::json!({
                "id": s.id,
                "title": s.title,
                "cwd": s.cwd,
                "cpuPercent": (s.total_cpu * 10.0).round() / 10.0,
                "memBytes": s.total_mem_bytes,
                "memHuman": human_bytes(s.total_mem_bytes),
                "ports": s.ports,
                "processes": s.procs.iter().map(|p| serde_json::json!({
                    "pid": p.pid,
                    "name": p.name,
                    "cmd": p.cmd,
                    "cpuPercent": (p.cpu * 10.0).round() / 10.0,
                    "memBytes": p.mem_bytes,
                    "memHuman": human_bytes(p.mem_bytes),
                })).collect::<Vec<_>>(),
            })
        })
        .collect();
    (
        StatusCode::OK,
        serde_json::json!({ "terminals": terminals }).to_string(),
    )
}

fn human_bytes(n: u64) -> String {
    const U: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < U.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", U[i])
    }
}

/// How long to wait between typing a message into another agent's terminal and
/// sending the return that submits it. Matches the delay the desktop uses for
/// every seeded prompt: long enough that the TUI has settled the text as input
/// rather than folding the CR into a paste, short enough not to feel deferred.
const SUBMIT_DELAY: std::time::Duration = std::time::Duration::from_millis(250);

/// How a message announces where it came from.
///
/// The receiving agent is otherwise being handed something indistinguishable
/// from its own user typing, so "another agent asked me to do this" was not a
/// thing it could establish — and anything carried in the message inherited the
/// user's authority by default. Both delivery routes use this, or the one that
/// doesn't becomes the way around it.
fn sender_tag(who: &Caller) -> String {
    match who.agent() {
        Some(a) => format!(
            "[canopy: message from the agent in {} (terminal {})]",
            a.cwd, a.pty_id
        ),
        None => "[canopy: message from the Canopy companion]".to_string(),
    }
}

/// What is safe to type into somebody else's terminal.
///
/// Newlines have to go because a newline in a TUI composer submits, and a
/// half-sent message is worse than a flattened one. Everything else in C0 has
/// to go because it is not text at all: ESC opens a control sequence the target
/// TUI will act on, ^C interrupts whatever it is doing, ^D ends its input. The
/// read direction has had `strip_ansi` since the beginning; this is the write
/// direction finally getting its counterpart.
fn sanitize_message(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_space = false;
    for ch in text.chars() {
        let keep = if ch.is_control() { ' ' } else { ch };
        // Collapse the runs the substitution creates, so a multi-line handoff
        // does not arrive padded with the ghosts of its own line breaks.
        if keep == ' ' {
            if !last_space && !out.is_empty() {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(keep);
            last_space = false;
        }
    }
    out.trim().to_string()
}

/// A write the frontend has to perform (start a run command, open a preview
/// tab, restart a server): validated here against the published snapshots, then
/// handed to the UI over the app event bus. Kept an event (not a direct call)
/// because the target project's ProjectView owns the tab/PTY state — the same
/// path a phone-spawned PTY takes. Stopping is the exception: it's a pure
/// backend kill, done here directly. Best-effort by nature: the tool acks the
/// request, and the agent confirms with the read tools (canopy_project /
/// server output / resources).
#[derive(serde::Deserialize)]
struct Action {
    kind: String,
    /// The agent's cwd (the sidecar's), for routing to a project when no more
    /// specific target is given.
    cwd: Option<String>,
    /// open_preview: which project's window to open it in, by name. What an
    /// agent that is inside no project uses instead of its cwd.
    #[serde(default)]
    project: Option<String>,
    /// start_server: the component directory + the run command's name.
    dir: Option<String>,
    command: Option<String>,
    /// open_preview: the localhost URL to open in the embedded browser.
    url: Option<String>,
    /// stop_server / restart_server / message_agent / job_done / close_session:
    /// the terminal id to act on. For close_session it is the caller's own
    /// CANOPY_PTY — the tool takes no id, so it can name no other terminal.
    #[serde(rename = "ptyId")]
    pty_id: Option<u32>,
    /// open_file / show_diff: the file to put in front of the user, and where
    /// in it to land.
    path: Option<String>,
    line: Option<u32>,
    /// notify / message_agent: what to say.
    text: Option<String>,
    /// message_agent: a pull request number or url, instead of `ptyId` — reach
    /// whoever raised it without having to know who that was.
    pr: Option<String>,
    /// notify: info | success | warn | error.
    level: Option<String>,
    /// job_done: how the micro-task ended (done | blocked) and its one-line
    /// summary. The artifact URL, if any, rides in `url` above.
    status: Option<String>,
    summary: Option<String>,
    /// job_done: the agent's one-line reading of what it was asked for — the
    /// "before" the summary is the "after" of.
    asked: Option<String>,
    /// job_done / task_named: what the agent decided to call this run, the
    /// glyph it picked, and a few tags for the kind of work. Passed through
    /// unvalidated on purpose: the shape (one glyph, four tags, a title that
    /// fits a row) is a display concern, and it is enforced once, in
    /// taskIdentity.ts, rather than twice in two languages.
    title: Option<String>,
    icon: Option<String>,
    tags: Option<Vec<String>>,
    /// job_done / close_session: the launching app instance (env
    /// CANOPY_INSTANCE), so a pty id recycled across an app restart can't
    /// close an unrelated tab.
    instance: Option<String>,
}

async fn action(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Json(act): Json<Action>,
) -> (StatusCode, String) {
    let Some(who) = caller(&app, &headers) else {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    };
    let snaps = app.state::<ContextBridge>();
    let msg = match act.kind.as_str() {
        "start_server" => {
            let (Some(dir), Some(command)) = (act.dir.as_deref(), act.command.as_deref()) else {
                return (
                    StatusCode::BAD_REQUEST,
                    "start_server needs dir and command".into(),
                );
            };
            // Resolve the run command by name against the component's published
            // commands, so the agent can pass the friendly name and the UI gets
            // the exact command string to run — and an unknown one is rejected
            // now, with the valid list, instead of silently doing nothing.
            match resolve_command(&snaps, dir, command) {
                Ok(cmdline) => {
                    let _ = app.emit(
                        "agent:action",
                        serde_json::json!({
                            "kind": "start_server",
                            "route": dir,
                            "dir": dir,
                            "name": command,
                            "command": cmdline,
                        }),
                    );
                    format!("Starting \"{command}\" in {dir}. Give it a few seconds, then call canopy_project to see it listening and canopy_server_output for its logs.")
                }
                Err(e) => return (StatusCode::BAD_REQUEST, e),
            }
        }
        "open_preview" => {
            let Some(url) = act.url.as_deref() else {
                return (StatusCode::BAD_REQUEST, "open_preview needs a url".into());
            };
            if !is_previewable_http(url) {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("{url} isn't an http:// or https:// URL — the preview opens web pages"),
                );
            }
            let route = match route_for_project(&app, act.project.as_deref(), act.cwd.as_deref()) {
                Ok(route) => route,
                Err(e) => return (StatusCode::BAD_REQUEST, e),
            };
            let _ = app.emit(
                "agent:action",
                serde_json::json!({
                    "kind": "open_preview",
                    "route": route,
                    "url": url,
                    "ptyId": act.pty_id,
                }),
            );
            match act
                .project
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
            {
                Some(p) => format!("Opened a preview of {url} in {p}."),
                None => format!("Opened a preview of {url} in Canopy."),
            }
        }
        "stop_server" => {
            let Some(id) = act.pty_id else {
                return (StatusCode::BAD_REQUEST, "stop_server needs ptyId".into());
            };
            if let Err(e) = may_act_on_terminal(&who, id, terminal_role(&app, id), "stop") {
                return (StatusCode::FORBIDDEN, e);
            }
            // A pure backend kill — no UI state to thread, and the pty:exit it
            // triggers updates the tab on its own. Scoped to real Canopy ptys:
            // an id that isn't one is refused, not silently ignored.
            match app.state::<crate::pty::PtyManager>().kill(id) {
                Ok(()) => format!("Stopped terminal {id}."),
                Err(_) => {
                    return (
                        StatusCode::NOT_FOUND,
                        format!("No running Canopy terminal with id {id} (see canopy_project)"),
                    )
                }
            }
        }
        "restart_server" => {
            let Some(id) = act.pty_id else {
                return (StatusCode::BAD_REQUEST, "restart_server needs ptyId".into());
            };
            if app.state::<crate::pty::PtyManager>().get(id).is_none() {
                return (
                    StatusCode::NOT_FOUND,
                    format!("No running Canopy terminal with id {id} (see canopy_project)"),
                );
            }
            if let Err(e) = may_act_on_terminal(&who, id, terminal_role(&app, id), "restart") {
                return (StatusCode::FORBIDDEN, e);
            }
            // Restart reuses the tab (and its command), which only the owning
            // ProjectView can do — route it there. `route` isn't a path here, so
            // App falls back to the single open project / broadcast by ptyId.
            let _ = app.emit(
                "agent:action",
                serde_json::json!({ "kind": "restart_server", "route": "", "ptyId": id }),
            );
            format!("Restarting terminal {id}. Call canopy_server_output shortly to watch it come back up.")
        }
        "job_done" => {
            let status = match act.status.as_deref() {
                Some(s @ ("done" | "blocked")) => s,
                _ => {
                    return (
                        StatusCode::BAD_REQUEST,
                        "job_done needs status: \"done\" (job complete) or \"blocked\" (you need the user)".into(),
                    )
                }
            };
            let Some(summary) = act.summary.as_deref().filter(|s| !s.trim().is_empty()) else {
                return (
                    StatusCode::BAD_REQUEST,
                    "job_done needs a summary — one sentence on what happened or what you need"
                        .into(),
                );
            };
            // A sidecar left over from a previous app launch can hold a pty id
            // that now names someone else's terminal: ack it, act on nothing.
            let stale = act
                .instance
                .as_deref()
                .is_some_and(|i| i != crate::pty::instance_token());
            if !stale {
                // Keyed by terminal like restart_server: route is empty, App
                // broadcasts, and the ProjectView owning the pty acts.
                let _ = app.emit(
                    "agent:action",
                    serde_json::json!({
                        "kind": "job_done",
                        "route": "",
                        "ptyId": act.pty_id,
                        "status": status,
                        "summary": summary,
                        "asked": act.asked,
                        "url": act.url,
                        "cwd": act.cwd,
                        "title": act.title,
                        "icon": act.icon,
                        "tags": act.tags,
                    }),
                );
            }
            match status {
                "done" => "Acknowledged — the user has been told. If this terminal is a Canopy micro-task it now closes: say goodbye in one sentence and start nothing new.".to_string(),
                _ => "Noted — Canopy told the user what you need. This session stays open; wait for their reply here.".to_string(),
            }
        }
        "task_named" => {
            // A name is not an outcome: nothing is settled, nothing closes, and
            // an empty call is a no-op rather than an error — an agent that
            // sends only a title has still said something useful.
            if act.title.is_none() && act.icon.is_none() && act.tags.is_none() {
                return (
                    StatusCode::BAD_REQUEST,
                    "canopy_name_task needs at least one of title, icon or tags".into(),
                );
            }
            let stale = act
                .instance
                .as_deref()
                .is_some_and(|i| i != crate::pty::instance_token());
            if !stale {
                let _ = app.emit(
                    "agent:action",
                    serde_json::json!({
                        "kind": "task_named",
                        "route": "",
                        "ptyId": act.pty_id,
                        "cwd": act.cwd,
                        "title": act.title,
                        "icon": act.icon,
                        "tags": act.tags,
                    }),
                );
            }
            "Noted — the user's Tasks list now shows this run by that name. Carry on with the job."
                .to_string()
        }
        "close_session" => {
            // The id is the sidecar's own CANOPY_PTY, never an argument — an
            // agent has no way to name someone else's terminal here. It still
            // has to be a live Canopy pty of *this* app run: an id from a
            // previous launch names a different terminal now.
            let Some(id) = act.pty_id else {
                return (StatusCode::BAD_REQUEST, "close_session needs ptyId".into());
            };
            let stale = act
                .instance
                .as_deref()
                .is_some_and(|i| i != crate::pty::instance_token());
            if stale || app.state::<crate::pty::PtyManager>().get(id).is_none() {
                return (
                    StatusCode::NOT_FOUND,
                    format!("Terminal {id} isn't a live Canopy terminal in this window — nothing to close"),
                );
            }
            // Keyed by terminal like restart_server: route is empty, App
            // broadcasts, and the ProjectView owning the pty closes the tab
            // once this turn ends.
            let _ = app.emit(
                "agent:action",
                serde_json::json!({
                    "kind": "close_session",
                    "route": "",
                    "ptyId": id,
                    "cwd": act.cwd,
                }),
            );
            "Closing this terminal — Canopy waits for your turn to end first. Say goodbye in one sentence, start nothing new, and call no more tools.".to_string()
        }
        "open_file" | "show_diff" => {
            let Some(path) = act.path.as_deref() else {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("{} needs a path", act.kind),
                );
            };
            if !std::path::Path::new(path).is_file() {
                return (
                    StatusCode::NOT_FOUND,
                    format!("{path} isn't a file on this machine"),
                );
            }
            // Inside a workspace, like every other path the bridge accepts. The
            // check used to be `is_file()` alone, which made this a way to put
            // any readable file on the machine — ~/.ssh/id_rsa, another
            // project's source — in front of the user in their own editor.
            if !within_a_workspace(&app, path) {
                return (
                    StatusCode::FORBIDDEN,
                    format!(
                        "{path} is outside every open project, and the bridge only opens files \
                         inside one"
                    ),
                );
            }
            // The file's own directory routes it: an agent naming a path in a
            // project other than its cwd's still lands in the right window.
            let route = std::path::Path::new(path)
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| act.cwd.clone().unwrap_or_default());
            let _ = app.emit(
                "agent:action",
                serde_json::json!({
                    "kind": act.kind,
                    "route": route,
                    "path": path,
                    "line": act.line,
                }),
            );
            match (act.kind.as_str(), act.line) {
                ("show_diff", _) => format!("Showing {path} as a diff against git HEAD in Canopy."),
                (_, Some(l)) => format!("Opened {path} at line {l} in Canopy."),
                _ => format!("Opened {path} in Canopy."),
            }
        }
        "notify" => {
            let Some(text) = act.text.as_deref() else {
                return (StatusCode::BAD_REQUEST, "notify needs text".into());
            };
            let _ = app.emit(
                "agent:action",
                serde_json::json!({
                    "kind": "notify",
                    "route": act.cwd.clone().unwrap_or_default(),
                    // Absent for an agent running outside a Canopy terminal;
                    // the frontend then falls back to routing by cwd.
                    "ptyId": act.pty_id,
                    "text": text,
                    "level": act.level.as_deref().unwrap_or("info"),
                }),
            );
            "Told the user.".to_string()
        }
        "message_agent" => {
            let Some(text) = act.text.as_deref() else {
                return (StatusCode::BAD_REQUEST, "message_agent needs text".into());
            };
            // The `pr` form names a pull request rather than a terminal, and
            // resolving it is the frontend's job: only it holds the pty→session
            // binding, and only it can reopen an ended conversation or open a
            // tab for a fresh agent. So this hands over rather than answering.
            if act.pty_id.is_none() {
                let Some(pr) = act.pr.as_deref() else {
                    return (
                        StatusCode::BAD_REQUEST,
                        "message_agent needs ptyId or pr".into(),
                    );
                };
                // Prepared here, exactly as the ptyId form is. The frontend
                // types this string into a terminal verbatim, so leaving it
                // raw meant the whole route around a PR skipped the flattening,
                // the control-byte stripping and the provenance tag — every
                // property the other branch had just gained.
                let body = sanitize_message(text);
                if body.is_empty() {
                    return (
                        StatusCode::BAD_REQUEST,
                        "message_agent needs text with something in it".into(),
                    );
                }
                let _ = app.emit(
                    "agent:action",
                    serde_json::json!({
                        "kind": "message_agent",
                        "route": act.cwd.clone().unwrap_or_default(),
                        "cwd": act.cwd,
                        "pr": pr,
                        "text": format!("{} {body}", sender_tag(&who)),
                    }),
                );
                // Handed over, not delivered — and said that way. Canopy may
                // find no open PR by that number, or no project to route it to,
                // and both of those are reported to the user rather than back
                // here. Claiming delivery in that case is how an agent came to
                // believe it had handed work off that nobody ever received.
                return (
                    StatusCode::OK,
                    format!(
                        "Asked Canopy to find whoever raised {pr}: it types into that session if \
                         it is still running, reopens its conversation if not, and starts a fresh \
                         agent if there is nothing left to reopen. None of that is confirmed \
                         here — if no open {pr} exists in this project the user is told and \
                         nothing is delivered. Check canopy_agents for a session working on it."
                    ),
                );
            }
            let Some(id) = act.pty_id else {
                return (
                    StatusCode::BAD_REQUEST,
                    "message_agent needs ptyId and text".into(),
                );
            };
            // Straight into the other agent's stdin, exactly as if the user had
            // typed it — that IS the interface every agent CLI exposes. Which
            // is also why the target has to be an agent: the check used to be
            // "is there a terminal with this id", and pty ids are small
            // sequential integers, so a message aimed at a plain shell tab was
            // a line of text followed by a return — a command, run as the user.
            let manager = app.state::<crate::pty::PtyManager>();
            if manager.get(id).is_none() {
                return (
                    StatusCode::NOT_FOUND,
                    format!("No running Canopy terminal with id {id} (see canopy_agents)"),
                );
            }
            if let Err(e) = may_message_terminal(id, terminal_role(&app, id)) {
                return (StatusCode::FORBIDDEN, e);
            }
            if who.agent().is_some_and(|a| a.pty_id == id) {
                return (
                    StatusCode::BAD_REQUEST,
                    "That's your own terminal — say it to the user instead.".into(),
                );
            }
            // Everything below C0 goes, not just the newlines. The old flatten
            // passed ESC and the rest through untouched, so a message could
            // carry ^C to interrupt the target mid-turn, or CSI sequences that
            // drive its TUI's keybindings rather than landing in its composer.
            let body = sanitize_message(text);
            if body.is_empty() {
                return (
                    StatusCode::BAD_REQUEST,
                    "message_agent needs text with something in it".into(),
                );
            }
            // The receiving agent is told where this came from. Without it a
            // message is indistinguishable from the user typing, so "another
            // agent asked me to do this" was not a thing the target could
            // establish — and anything carried in the message inherited the
            // user's authority by default.
            let line = format!("{} {body}", sender_tag(&who));
            if let Err(e) = manager.write(id, &line) {
                return (StatusCode::BAD_REQUEST, e);
            }
            let msg_id = format!("m{}", snaps.next_message.fetch_add(1, Ordering::Relaxed));
            {
                let mut log = snaps.messages.lock().unwrap();
                log.push(MeshMessage {
                    id: msg_id.clone(),
                    from_pty_id: who.agent().map(|a| a.pty_id),
                    from_cwd: who.agent().map(|a| a.cwd.clone()),
                    to_pty_id: id,
                    text: body.clone(),
                    at_ms: now_ms(),
                    // Not yet: the return that submits it is still to come.
                    submitted: false,
                });
                if log.len() > MAX_MESSAGES {
                    let excess = log.len() - MAX_MESSAGES;
                    log.drain(0..excess);
                }
            }
            // The return has to arrive as its own write, a beat later. An agent
            // TUI reads a burst that ends in CR as a paste and keeps the whole
            // thing in its composer — which is exactly what this did: the
            // message appeared in the other agent's prompt box and sat there
            // unsent until the user pressed enter. Every send from the desktop
            // has always split the two; only this one didn't.
            let send = app.clone();
            let sent_id = msg_id.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(SUBMIT_DELAY).await;
                // Re-checked, because 250ms is long enough for the terminal to
                // have gone. The result of this write used to be discarded, so
                // a message left sitting unsent in a dead composer looked
                // exactly like a delivered one.
                let bridge = send.state::<ContextBridge>();
                let submitted = send
                    .state::<crate::pty::PtyManager>()
                    .write(id, "\r")
                    .is_ok();
                if submitted {
                    if let Some(m) = bridge
                        .messages
                        .lock()
                        .unwrap()
                        .iter_mut()
                        .find(|m| m.id == sent_id)
                    {
                        m.submitted = true;
                    }
                }
                // The user is told either way: an agent reaching into another
                // agent's session is exactly the "something happened over here"
                // the attention channel exists for, and it used to happen
                // entirely in silence.
                let _ = send.emit(
                    "agent:message",
                    serde_json::json!({
                        "id": sent_id,
                        "toPtyId": id,
                        "submitted": submitted,
                    }),
                );
            });
            format!(
                "Sent to terminal {id}, tagged as coming from you. It answers in its own \
                 session — read its reply with canopy_server_output({id})."
            )
        }
        other => return (StatusCode::BAD_REQUEST, format!("unknown action: {other}")),
    };
    (StatusCode::OK, msg)
}

/// A browser-control op (canopy_browser_* tools): drive the embedded preview —
/// navigate, snapshot the DOM, click, type, eval, read the console. Unlike
/// /ctx/action these are request/response: the op is handed to the UI with a
/// ticket id, the handler parks on a oneshot, and the frontend (ultimately the
/// script injected into the previewed page) answers through `browser_result`.
#[derive(serde::Deserialize)]
struct BrowserOp {
    op: String,
    cwd: Option<String>,
    /// The agent terminal issuing the operation. When navigation creates a
    /// preview, this becomes the tab's default feedback destination.
    #[serde(rename = "ptyId")]
    pty_id: Option<u32>,
    /// Which project's preview to drive, by name — for an agent (the
    /// companion) whose cwd is inside none of them.
    #[serde(default)]
    project: Option<String>,
    /// screenshot: browser (default) | ide.
    scope: Option<String>,
    url: Option<String>,
    /// navigate: back | forward | reload (when no url is given).
    action: Option<String>,
    /// resize: CSS viewport dimensions, or reset to fill the preview pane.
    width: Option<u32>,
    height: Option<u32>,
    reset: Option<bool>,
    /// click / type: element address — a snapshot ref or a CSS selector.
    r#ref: Option<u64>,
    selector: Option<String>,
    /// type
    text: Option<String>,
    submit: Option<bool>,
    append: Option<bool>,
    /// point: what to call the thing being pointed at, shown on the cursor.
    label: Option<String>,
    /// eval
    code: Option<String>,
    /// console
    lines: Option<u64>,
    clear: Option<bool>,
    /// snapshot
    max: Option<u64>,
}

/// How long the app + page get to answer a browser op. Covers a preview tab
/// mounting and its page loading; the sidecar's own read timeout is longer.
const BROWSER_OP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

fn validate_browser_resize(
    width: Option<u32>,
    height: Option<u32>,
    reset: bool,
) -> Result<(), &'static str> {
    if reset {
        return if width.is_none() && height.is_none() {
            Ok(())
        } else {
            Err("resize takes either reset = true or width and height, not both")
        };
    }
    let valid = |n: Option<u32>| n.is_some_and(|n| (200..=7680).contains(&n));
    if valid(width) && valid(height) {
        Ok(())
    } else {
        Err("resize needs width and height between 200 and 7680 CSS pixels, or reset = true")
    }
}

/// An Android device op (canopy_device_* tools).
///
/// Unlike the browser ops, these never round-trip through the frontend: a
/// device is reachable from the backend directly, so an agent can drive one
/// with no device tab open and without depending on a window being on screen.
/// The tab, when there is one, is just another viewer of the same device.
#[derive(serde::Deserialize)]
struct DeviceOp {
    op: String,
    serial: Option<String>,
    #[serde(rename = "projectDir")]
    project_dir: Option<String>,
    x: Option<i32>,
    y: Option<i32>,
    x2: Option<i32>,
    y2: Option<i32>,
    ms: Option<u32>,
    text: Option<String>,
    key: Option<String>,
    package: Option<String>,
    lines: Option<u32>,
    name: Option<String>,
    apk: Option<String>,
}

async fn device(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Json(op): Json<DeviceOp>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let dir = op.project_dir.clone();
    let bad = |e: String| (StatusCode::BAD_REQUEST, e);

    // Ops that address the SDK rather than one device resolve no serial.
    if op.op == "list" {
        let status = crate::android::resolve(dir.as_deref());
        let sdk = match &status.sdk {
            Some(s) => s.clone(),
            None => return bad(status.missing.join("; ")),
        };
        let devices = match crate::android::devices(&sdk) {
            Ok(d) => d,
            Err(e) => return bad(e),
        };
        // Absent cmdline-tools this simply has no emulators to report, which is
        // already said in `missing` — no reason to fail the whole listing.
        let avds = crate::android::android_avds(dir.clone()).unwrap_or_default();
        return (
            StatusCode::OK,
            serde_json::json!({
                "devices": devices,
                "emulators": avds,
                "missing": status.missing,
            })
            .to_string(),
        );
    }
    if op.op == "emulator_start" {
        let Some(name) = op.name.clone() else {
            return bad("emulator_start needs a name (from canopy_device_list)".into());
        };
        return match crate::android::android_emulator_start(dir, name).await {
            Ok(serial) => (
                StatusCode::OK,
                serde_json::json!({ "serial": serial }).to_string(),
            ),
            Err(e) => bad(e),
        };
    }
    if op.op == "describe" {
        let Some(project) = dir else {
            return bad("describe needs a projectDir".into());
        };
        return match crate::android::android_describe(project).await {
            Ok(out) => (
                StatusCode::OK,
                serde_json::json!({ "describe": out }).to_string(),
            ),
            Err(e) => bad(e),
        };
    }

    // Everything below acts on one device. Naming it is optional while exactly
    // one is attached, which is the common case and saves a round trip.
    let serial = match op.serial.clone() {
        Some(s) if !s.is_empty() => s,
        _ => match crate::android::only_device(dir.as_deref()) {
            Ok(s) => s,
            Err(e) => return bad(e),
        },
    };

    let result: Result<serde_json::Value, String> = match op.op.as_str() {
        "screenshot" => crate::android::screencap_bytes(dir, serial.clone())
            .await
            .map(|bytes| {
                use base64::Engine;
                serde_json::json!({
                    "image": base64::engine::general_purpose::STANDARD.encode(&bytes),
                    "mimeType": "image/png",
                    "serial": serial,
                })
            }),
        "snapshot" => crate::android::android_layout(dir, serial)
            .await
            .map(|json| serde_json::json!({ "layout": json })),
        "foreground" => crate::android::android_foreground(dir, serial)
            .await
            .map(|c| serde_json::json!({ "component": c })),
        "tap" => match (op.x, op.y) {
            (Some(x), Some(y)) => crate::android::android_tap(dir, serial, x, y)
                .await
                .map(|_| serde_json::json!({ "tapped": [x, y] })),
            _ => Err(
                "tap needs x and y in device pixels (canopy_device_snapshot reports the \
                      centre of every node)"
                    .into(),
            ),
        },
        "type" => match op.text.clone() {
            Some(t) => crate::android::android_text(dir, serial, t)
                .await
                .map(|_| serde_json::json!({ "typed": true })),
            None => Err("type needs text".into()),
        },
        "key" => match op.key.clone() {
            Some(k) => crate::android::android_key(dir, serial, k)
                .await
                .map(|_| serde_json::json!({ "pressed": true })),
            None => Err("key needs a keyevent name, e.g. BACK or ENTER".into()),
        },
        "swipe" => match (op.x, op.y, op.x2, op.y2) {
            (Some(x), Some(y), Some(x2), Some(y2)) => {
                crate::android::android_swipe(dir, serial, x, y, x2, y2, op.ms)
                    .await
                    .map(|_| serde_json::json!({ "swiped": true }))
            }
            _ => Err("swipe needs x, y, x2 and y2".into()),
        },
        "logcat" => crate::android::android_logcat(dir, serial, op.package.clone(), op.lines)
            .await
            .map(|log| serde_json::json!({ "logcat": log })),
        "emulator_stop" => crate::android::android_emulator_stop(dir, serial)
            .await
            .map(|_| serde_json::json!({ "stopped": true })),
        "run" => match (op.project_dir.clone(), op.apk.clone()) {
            (Some(project), Some(apk)) => crate::android::android_run(project, apk, serial)
                .await
                .map(|out| serde_json::json!({ "run": out })),
            _ => Err(
                "run needs projectDir and apk (canopy_device_describe reports APK paths)".into(),
            ),
        },
        other => Err(format!("unknown device op: {other}")),
    };

    match result {
        Ok(v) => (StatusCode::OK, v.to_string()),
        Err(e) => bad(e),
    }
}

async fn browser(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Json(op): Json<BrowserOp>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    // Everything checkable without the page is checked here, so the agent gets
    // an immediate 4xx to correct against instead of a UI round-trip.
    match op.op.as_str() {
        "navigate" => match (&op.url, op.action.as_deref()) {
            (Some(u), _) if !is_previewable_http(u) => {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("{u} isn't an http:// or https:// URL — the preview opens web pages"),
                );
            }
            (Some(_), _) | (None, Some("back" | "forward" | "reload")) => {}
            _ => {
                return (
                    StatusCode::BAD_REQUEST,
                    "navigate needs a url, or action = back | forward | reload".into(),
                )
            }
        },
        "click" | "type" | "point" => {
            if op.r#ref.is_none() && op.selector.is_none() {
                return (
                    StatusCode::BAD_REQUEST,
                    format!(
                        "{} needs a ref (from canopy_browser_snapshot) or a selector",
                        op.op
                    ),
                );
            }
            if op.op == "type" && op.text.is_none() {
                return (StatusCode::BAD_REQUEST, "type needs text".into());
            }
        }
        "resize" => {
            if let Err(message) =
                validate_browser_resize(op.width, op.height, op.reset.unwrap_or(false))
            {
                return (StatusCode::BAD_REQUEST, message.into());
            }
        }
        "eval" => {
            if op.code.as_deref().map_or(true, |c| c.trim().is_empty()) {
                return (StatusCode::BAD_REQUEST, "eval needs code".into());
            }
        }
        // `network` used to be answered here, from the preview proxy's own
        // request log. The webview engine has no proxy to log anything, so the
        // page collects its own traffic (see preview_picker.js) and this became
        // an ordinary page round-trip like the rest. `/ctx/network` below still
        // reads the proxy log directly, for a preview running that engine.
        "snapshot" | "console" | "network" => {}
        "screenshot" => {
            if !matches!(op.scope.as_deref(), None | Some("browser") | Some("ide")) {
                return (
                    StatusCode::BAD_REQUEST,
                    "scope must be browser or ide".into(),
                );
            }
        }
        other => {
            return (
                StatusCode::BAD_REQUEST,
                format!("unknown browser op: {other}"),
            )
        }
    }

    // Which window's preview this drives. Checked before a ticket is minted:
    // an unknown project name must come back as an error the agent can read,
    // not as a request nobody answers until the timeout.
    let route = if op.op == "screenshot" && op.scope.as_deref() == Some("ide") {
        op.cwd.clone().unwrap_or_default()
    } else {
        match route_for_project(&app, op.project.as_deref(), op.cwd.as_deref()) {
            Ok(route) => route,
            Err(e) => return (StatusCode::BAD_REQUEST, e),
        }
    };

    let bridge = app.state::<ContextBridge>();
    let id = bridge.next_op.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    bridge.pending.lock().unwrap().insert(id, tx);

    let _ = app.emit(
        "agent:browser",
        serde_json::json!({
            "id": id,
            "op": op.op,
            "route": route,
            "ptyId": op.pty_id,
            "scope": op.scope,
            "url": op.url,
            "action": op.action,
            "width": op.width,
            "height": op.height,
            "reset": op.reset,
            "ref": op.r#ref,
            "selector": op.selector,
            "text": op.text,
            "label": op.label,
            "submit": op.submit,
            "append": op.append,
            "code": op.code,
            "lines": op.lines,
            "clear": op.clear,
            "max": op.max,
        }),
    );

    match tokio::time::timeout(BROWSER_OP_TIMEOUT, rx).await {
        Ok(Ok((true, data))) => (StatusCode::OK, body_text(data)),
        Ok(Ok((false, data))) => (StatusCode::BAD_REQUEST, body_text(data)),
        // Sender dropped without answering — shouldn't happen, but don't hang.
        Ok(Err(_)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "the preview dropped this request".into(),
        ),
        Err(_) => {
            app.state::<ContextBridge>()
                .pending
                .lock()
                .unwrap()
                .remove(&id);
            (
                StatusCode::GATEWAY_TIMEOUT,
                "The preview didn't answer in time. The page may still be loading, or the \
                 Canopy window may be busy — try again, or call canopy_project to check the \
                 server is running."
                    .into(),
            )
        }
    }
}

/// The request/response ops that need something only the running UI can answer:
/// the language server it keeps warm (diagnostics, references, definition), the
/// trackers it holds keys for (tickets, reviews), a question put to the user, a
/// picture of the previewed page. Same ticket/oneshot machinery as the browser
/// ops — the frontend answers through `browser_result` — but with a per-op
/// deadline, because "ask the user" and "read a marker" are not the same wait.
#[derive(serde::Deserialize)]
struct UiOp {
    op: String,
    cwd: Option<String>,
    /// diagnostics / references / definition / hover / symbols: where to look.
    path: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
    symbol: Option<String>,
    /// symbols: a name to search the workspace for, instead of a file to outline.
    query: Option<String>,
    /// diagnostics: how long the caller is prepared to wait. The edit hook asks
    /// for a couple of seconds; without it a cold server would stall the agent's
    /// loop behind an index it never asked for.
    #[serde(rename = "waitMs")]
    wait_ms: Option<u64>,
    /// ask: the question, its options, and how long the agent will hold.
    question: Option<String>,
    #[serde(default)]
    options: Vec<String>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    /// vault: list | fill | read.
    #[serde(rename = "vaultOp")]
    vault_op: Option<String>,
    /// vault: a specific entry, when the agent has already listed them.
    #[serde(rename = "entryId")]
    entry_id: Option<String>,
    /// The companion's cross-project ops. Scoped to one project by name when
    /// given; every one of them answers for the whole workspace otherwise,
    /// which is the point of the companion having them at all.
    project: Option<String>,
    /// confirm: what the agent proposes to do, and the specifics the user needs
    /// in order to judge it.
    action: Option<String>,
    detail: Option<String>,
    /// open_project: one line the user sees explaining why their window moved.
    why: Option<String>,
    /// workspace_search: how many rows to return.
    limit: Option<u32>,
    /// remember: the fact, what it concerns, and whether this retracts one.
    fact: Option<String>,
    about: Option<String>,
    #[serde(default)]
    forget: bool,
    /// Companion PR operations. The repo path is checked against the workspace
    /// by the UI before any existing GitHub command is called.
    repo: Option<String>,
    number: Option<u64>,
    #[serde(rename = "includeDiff")]
    include_diff: Option<bool>,
    #[serde(rename = "includeLogs")]
    include_logs: Option<bool>,
    body: Option<String>,
    review: Option<String>,
    #[serde(default)]
    reviewers: Vec<String>,
    #[serde(rename = "threadId")]
    thread_id: Option<String>,
    resolved: Option<bool>,
    method: Option<String>,
    enable: Option<bool>,
    #[serde(rename = "deleteBranch")]
    delete_branch: Option<bool>,
}

const UI_OP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
/// PR reads shell out to GitHub and failing logs may require several downloads.
/// Keep the bridge alive past git.rs's network ceilings so a write never lands
/// after its caller was told it failed and invited to retry.
const PR_UI_OP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);
/// A question waits on a human, so it gets minutes — bounded so a forgotten
/// dialog can't pin an agent forever.
const MAX_ASK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

async fn ui_op(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Json(op): Json<UiOp>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let deadline = match op.op.as_str() {
        "diagnostics" | "tickets" | "reviews" => UI_OP_TIMEOUT,
        "references" | "definition" | "hover" => {
            if op.path.is_none() {
                return (StatusCode::BAD_REQUEST, format!("{} needs a path", op.op));
            }
            if op.symbol.is_none() && op.line.is_none() {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("{} needs a symbol, or a line and column", op.op),
                );
            }
            UI_OP_TIMEOUT
        }
        "symbols" => {
            if op.query.as_deref().map_or(true, |q| q.trim().is_empty()) && op.path.is_none() {
                return (
                    StatusCode::BAD_REQUEST,
                    "symbols needs a query to search for, or a path to outline".into(),
                );
            }
            UI_OP_TIMEOUT
        }
        "ask" => {
            if op.question.as_deref().map_or(true, |q| q.trim().is_empty()) {
                return (StatusCode::BAD_REQUEST, "ask needs a question".into());
            }
            op.timeout_ms
                .map(std::time::Duration::from_millis)
                .unwrap_or(std::time::Duration::from_secs(120))
                .min(MAX_ASK_TIMEOUT)
        }
        "vault" => {
            match op.vault_op.as_deref().unwrap_or("list") {
                "list" | "fill" | "read" => {}
                other => {
                    return (
                        StatusCode::BAD_REQUEST,
                        format!("unknown vault op: {other} (list, fill or read)"),
                    )
                }
            }
            // A fill the user has not approved yet puts a prompt on screen, so
            // this waits on a person exactly like `ask` does.
            MAX_ASK_TIMEOUT
        }
        // These read state the app already holds, so they answer as fast as the
        // language-server ops do.
        "workspace" | "workspace_git" | "workspace_agents" | "open_project" | "recall"
        | "remember" => UI_OP_TIMEOUT,
        // These delegate to GitHub. A details call can download several failing
        // logs, and writes must not time out locally while the remote succeeds.
        "workspace_prs" | "pr_details" | "pr_action" => PR_UI_OP_TIMEOUT,
        "workspace_search" => {
            if op.query.as_deref().map_or(true, |q| q.trim().is_empty()) {
                return (
                    StatusCode::BAD_REQUEST,
                    "workspace_search needs a query".into(),
                );
            }
            UI_OP_TIMEOUT
        }
        // The companion asking permission. Waits on a person, exactly like
        // `ask` — and for the same reason it must not time out early: an agent
        // that stops waiting does not know whether it may proceed.
        "confirm" => {
            if op.action.as_deref().map_or(true, |a| a.trim().is_empty()) {
                return (StatusCode::BAD_REQUEST, "confirm needs an action".into());
            }
            op.timeout_ms
                .map(std::time::Duration::from_millis)
                .unwrap_or(std::time::Duration::from_secs(120))
                .min(MAX_ASK_TIMEOUT)
        }
        other => return (StatusCode::BAD_REQUEST, format!("unknown ui op: {other}")),
    };

    let bridge = app.state::<ContextBridge>();
    let id = bridge.next_op.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = tokio::sync::oneshot::channel();
    bridge.pending.lock().unwrap().insert(id, tx);

    let _ = app.emit(
        "agent:ui",
        serde_json::json!({
            "id": id,
            "op": op.op,
            "route": op.cwd.clone().unwrap_or_default(),
            "path": op.path,
            "line": op.line,
            "column": op.column,
            "symbol": op.symbol,
            "query": op.query,
            "waitMs": op.wait_ms,
            "question": op.question,
            "options": op.options,
            "vaultOp": op.vault_op,
            "entryId": op.entry_id,
            "project": op.project,
            "action": op.action,
            "detail": op.detail,
            "why": op.why,
            "limit": op.limit,
            "fact": op.fact,
            "about": op.about,
            "forget": op.forget,
            "repo": op.repo,
            "number": op.number,
            "includeDiff": op.include_diff,
            "includeLogs": op.include_logs,
            "body": op.body,
            "review": op.review,
            "reviewers": op.reviewers,
            "threadId": op.thread_id,
            "resolved": op.resolved,
            "method": op.method,
            "enable": op.enable,
            "deleteBranch": op.delete_branch,
        }),
    );

    match tokio::time::timeout(deadline, rx).await {
        Ok(Ok((true, data))) => (StatusCode::OK, body_text(data)),
        Ok(Ok((false, data))) => (StatusCode::BAD_REQUEST, body_text(data)),
        Ok(Err(_)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "Canopy dropped this request".into(),
        ),
        Err(_) => {
            app.state::<ContextBridge>()
                .pending
                .lock()
                .unwrap()
                .remove(&id);
            let why = if op.op == "pr_action" {
                "The GitHub action did not finish in time. Its outcome is unknown — inspect the pull request before deciding whether to try anything again."
            } else if op.op == "ask" || op.op == "vault" || op.op == "confirm" {
                "The user didn't answer in time — carry on without them, or ask again."
            } else {
                "Canopy didn't answer in time. The window may be busy, or the language server \
                 may still be warming up — try again."
            };
            (StatusCode::GATEWAY_TIMEOUT, why.into())
        }
    }
}

/// Block until a terminal does something worth waking up for: prints a matching
/// line, starts listening on a port, or goes quiet. The alternative is the agent
/// polling canopy_server_output in a loop, which costs a turn and a few hundred
/// tokens per look — the supervisor can just wait.
#[derive(serde::Deserialize)]
struct WaitParams {
    server: u32,
    /// Substring to wait for in new output (case-insensitive).
    pattern: Option<String>,
    /// listening | idle | output (default: pattern when given, else listening).
    until: Option<String>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    /// idle: how long the output must stay quiet to count.
    #[serde(rename = "idleMs")]
    idle_ms: Option<u64>,
}

const WAIT_POLL: std::time::Duration = std::time::Duration::from_millis(250);

async fn wait(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Query(p): Query<WaitParams>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let ptys = app.state::<crate::pty::PtyManager>();
    let read = |id: u32| {
        ptys.scrollback_tail(id, MAX_OUTPUT_BYTES)
            .map(|b| strip_ansi(&b))
    };
    let Some(initial) = read(p.server) else {
        return (
            StatusCode::NOT_FOUND,
            format!(
                "no running terminal with id {} — it may have exited",
                p.server
            ),
        );
    };
    let until = p.until.clone().unwrap_or_else(|| {
        if p.pattern.is_some() {
            "output".into()
        } else {
            "listening".into()
        }
    });
    let timeout =
        std::time::Duration::from_millis(p.timeout_ms.unwrap_or(60_000).clamp(1_000, 600_000));
    let idle_for = std::time::Duration::from_millis(p.idle_ms.unwrap_or(2_000).clamp(200, 60_000));
    let needle = p.pattern.as_deref().map(str::to_lowercase);

    // Everything is measured against what was already on screen when the call
    // arrived, so a pattern that matched an hour ago doesn't return instantly.
    let mut base = initial.chars().count();
    let mut last_len = base;
    let mut last_change = std::time::Instant::now();
    let started = std::time::Instant::now();

    loop {
        let Some(text) = read(p.server) else {
            return (
                StatusCode::OK,
                format!("Terminal {} exited while waiting.", p.server),
            );
        };
        let len = text.chars().count();
        // Scrollback rolls; when it does, the old offset points past the start.
        if len < base {
            base = 0;
        }
        if len != last_len {
            last_len = len;
            last_change = std::time::Instant::now();
        }
        let fresh: String = text.chars().skip(base).collect();

        match until.as_str() {
            "output" => {
                if let Some(n) = &needle {
                    if let Some(line) = fresh
                        .lines()
                        .find(|l| l.to_lowercase().contains(n.as_str()))
                    {
                        return (
                            StatusCode::OK,
                            format!(
                                "Matched after {:.1}s:\n{line}\n\n--- new output ---\n{}",
                                started.elapsed().as_secs_f32(),
                                tail_lines(&fresh, 40)
                            ),
                        );
                    }
                } else if !fresh.trim().is_empty() {
                    return (
                        StatusCode::OK,
                        format!(
                            "New output after {:.1}s:\n{}",
                            started.elapsed().as_secs_f32(),
                            tail_lines(&fresh, 40)
                        ),
                    );
                }
            }
            "listening" => {
                let ports: Vec<u16> = app
                    .state::<crate::agents::StatsCache>()
                    .0
                    .lock()
                    .unwrap()
                    .iter()
                    .find(|s| s.id == p.server)
                    .map(|s| s.ports.clone())
                    .unwrap_or_default();
                if !ports.is_empty() {
                    return (
                        StatusCode::OK,
                        format!(
                            "Terminal {} is listening on {} after {:.1}s. Open it with \
                             canopy_browser_navigate (http://localhost:{}).",
                            p.server,
                            ports
                                .iter()
                                .map(|x| x.to_string())
                                .collect::<Vec<_>>()
                                .join(", "),
                            started.elapsed().as_secs_f32(),
                            ports[0]
                        ),
                    );
                }
            }
            "idle" => {
                if last_change.elapsed() >= idle_for {
                    return (
                        StatusCode::OK,
                        format!(
                            "Quiet for {:.1}s (waited {:.1}s). Last output:\n{}",
                            last_change.elapsed().as_secs_f32(),
                            started.elapsed().as_secs_f32(),
                            tail_lines(&text, 40)
                        ),
                    );
                }
            }
            other => {
                return (
                    StatusCode::BAD_REQUEST,
                    format!("unknown wait target: {other} (use output | listening | idle)"),
                )
            }
        }

        if started.elapsed() >= timeout {
            return (
                StatusCode::OK,
                format!(
                    "Gave up after {:.0}s waiting for {until}{}. Last output:\n{}",
                    timeout.as_secs_f32(),
                    needle
                        .as_ref()
                        .map(|n| format!(" matching \"{n}\""))
                        .unwrap_or_default(),
                    tail_lines(&text, 40)
                ),
            );
        }
        tokio::time::sleep(WAIT_POLL).await;
    }
}

fn tail_lines(text: &str, n: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(n)..].join("\n")
}

/// A result payload as an HTTP body: strings verbatim, JSON otherwise.
fn body_text(data: serde_json::Value) -> String {
    match data {
        serde_json::Value::String(s) => s,
        other => other.to_string(),
    }
}

/// The preview proxy's request log — served straight from PreviewManager.
fn network_response(app: &tauri::AppHandle, url: Option<&str>) -> (StatusCode, String) {
    let previews = app.state::<crate::preview::PreviewManager>();
    let origin = match url {
        Some(u) => match origin_of(u) {
            Some(o) => Some(o),
            None => return (StatusCode::BAD_REQUEST, format!("not an http:// URL: {u}")),
        },
        None => None,
    };
    match previews.network_log(origin.as_deref(), 100) {
        Some(log) => (StatusCode::OK, log.to_string()),
        None => {
            let running = previews.origins();
            let hint = if running.is_empty() {
                "no preview is open — open one with canopy_browser_navigate first".to_string()
            } else {
                format!("previews are open for: {}", running.join(", "))
            };
            (
                StatusCode::NOT_FOUND,
                format!(
                    "no preview proxy for {} ({hint})",
                    origin.unwrap_or_default()
                ),
            )
        }
    }
}

#[derive(serde::Deserialize)]
struct NetworkParams {
    url: Option<String>,
}

async fn network(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Query(params): Query<NetworkParams>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    network_response(&app, params.url.as_deref())
}

/// `http://host:port/...` → `http://host:port` (the proxy map's key shape).
fn origin_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("http://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return None;
    }
    Some(format!("http://{authority}"))
}

/// Look up a component's run command by name in the published snapshots,
/// returning its command line. Errs (with the available names) when the
/// directory isn't a known component or the name isn't one of its commands.
fn resolve_command(bridge: &ContextBridge, dir: &str, name: &str) -> Result<String, String> {
    let snaps = bridge.snapshots.lock().unwrap();
    for project in snaps.values() {
        let Some(components) = project.get("components").and_then(|c| c.as_array()) else {
            continue;
        };
        for comp in components {
            if comp.get("path").and_then(|p| p.as_str()) != Some(dir) {
                continue;
            }
            let commands = comp.get("commands").and_then(|c| c.as_array());
            let names: Vec<&str> = commands
                .into_iter()
                .flatten()
                .filter_map(|c| c.get("name").and_then(|n| n.as_str()))
                .collect();
            let found = comp
                .get("commands")
                .and_then(|c| c.as_array())
                .into_iter()
                .flatten()
                .find(|c| c.get("name").and_then(|n| n.as_str()) == Some(name))
                .and_then(|c| c.get("command").and_then(|v| v.as_str()));
            return match found {
                Some(cmd) => Ok(cmd.to_string()),
                None => Err(format!(
                    "\"{name}\" isn't a run command of {dir}. Configured commands: {}",
                    if names.is_empty() {
                        "(none)".into()
                    } else {
                        names.join(", ")
                    }
                )),
            };
        }
    }
    Err(format!(
        "{dir} isn't a component of any open Canopy project (call canopy_project for the list)"
    ))
}

/// A URL the embedded preview will accept: any http(s) page with a host.
///
/// It used to be loopback-only, on the theory that a preview is a dev server.
/// It isn't only that — a staging deployment, a hosted docs page, an API
/// console are all things an agent is asked to open and look at — and the proxy
/// serves a remote origin the same way it serves localhost. What stays out is
/// the schemes that aren't a page: file://, data:, javascript:.
fn is_previewable_http(url: &str) -> bool {
    let rest = match url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
    {
        Some(r) => r,
        None => return false,
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty() && !host.starts_with(':')
}

#[derive(serde::Deserialize)]
struct OutputParams {
    lines: Option<usize>,
}

async fn server_output(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<u32>,
    Query(params): Query<OutputParams>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    let Some(raw) = app
        .state::<crate::pty::PtyManager>()
        .scrollback_tail(id, MAX_OUTPUT_BYTES)
    else {
        return (
            StatusCode::NOT_FOUND,
            format!("no running terminal with id {id} — it may have exited"),
        );
    };
    let text = strip_ansi(&raw);
    let lines = params.lines.unwrap_or(200).clamp(1, 5000);
    let tail: Vec<&str> = {
        let all: Vec<&str> = text.lines().collect();
        all[all.len().saturating_sub(lines)..].to_vec()
    };
    (StatusCode::OK, tail.join("\n"))
}

#[derive(serde::Deserialize)]
struct FilesParams {
    dir: String,
    max: Option<usize>,
}

async fn files(
    State(app): State<tauri::AppHandle>,
    headers: HeaderMap,
    Query(params): Query<FilesParams>,
) -> (StatusCode, String) {
    if !authorized(&app, &headers) {
        return (StatusCode::UNAUTHORIZED, "bad token".into());
    }
    // Only directories the workspace actually contains: the bridge must not be
    // a token-gated read of arbitrary paths. A published component (or a
    // subdirectory of one) is in scope; anything else is refused.
    //
    // Normalised first. `Path::starts_with` compares components and does not
    // resolve `..`, so "/repo/../../etc" started with "/repo" and was allowed
    // straight back out of the workspace it was being checked against.
    let normalized = normalize_claim_path(&params.dir, None);
    let dir = std::path::PathBuf::from(&normalized);
    let allowed = within_a_workspace(&app, &normalized);
    if !allowed {
        return (
            StatusCode::FORBIDDEN,
            format!(
                "{} is not inside any component of an open Canopy project",
                params.dir
            ),
        );
    }
    let max = params.max.unwrap_or(MAX_FILES_DEFAULT).clamp(1, 5000);
    let (list, truncated) = walk(&dir, max);
    (
        StatusCode::OK,
        serde_json::json!({ "files": list, "truncated": truncated }).to_string(),
    )
}

/// Whether a normalised path sits inside a component of some open project.
///
/// One answer, shared by every handler that takes a path from an agent, so a
/// new one cannot quietly be laxer than the others — which is how `open_file`
/// came to accept anything on the disk while `/ctx/files` was checking roots
/// two hundred lines away.
fn within_a_workspace(app: &tauri::AppHandle, path: &str) -> bool {
    let normalized = normalize_claim_path(path, None);
    let target = std::path::Path::new(&normalized);
    let bridge = app.state::<ContextBridge>();
    let snaps = bridge.snapshots.lock().unwrap();
    snaps.values().any(|p| {
        p.get("components")
            .and_then(|c| c.as_array())
            .is_some_and(|comps| {
                comps.iter().any(|c| {
                    c.get("path")
                        .and_then(|p| p.as_str())
                        .is_some_and(|root| target.starts_with(normalize_claim_path(root, None)))
                })
            })
    })
}

/// What a terminal is running, as far as the monitor has been able to tell.
///
/// Read from the same `agent_hint` the frontend renders agent cards from, so
/// the tools' idea of "that is an agent" is the user's idea of it. Every PTY
/// Canopy opens holds a bridge credential — that is about identity, not about
/// what is running — so the registry cannot answer this and must not be asked.
///
/// `Unknown` is a third answer and not a synonym for either of the others. The
/// monitor classifies on a tick, so a freshly spawned terminal has no verdict
/// yet, and a CLI it cannot name never gets one. Both consumers below have to
/// decide what to do about that, and they decide *differently* — which is the
/// whole reason this is not a bool.
#[derive(Clone, Copy, PartialEq, Debug)]
enum TerminalRole {
    Agent,
    NotAgent,
    Unknown,
}

fn terminal_role(app: &tauri::AppHandle, pty_id: u32) -> TerminalRole {
    match app
        .state::<crate::agents::StatsCache>()
        .0
        .lock()
        .unwrap()
        .iter()
        .find(|s| s.id == pty_id)
    {
        Some(s) if s.agent_hint.is_some() => TerminalRole::Agent,
        Some(_) => TerminalRole::NotAgent,
        None => TerminalRole::Unknown,
    }
}

/// Whether this caller may type into that terminal.
///
/// Only a terminal known to be running an agent. An unclassified one is
/// refused, because the cost of being wrong here is that a line of text plus a
/// return runs as a command in somebody's shell.
fn may_message_terminal(pty_id: u32, role: TerminalRole) -> Result<(), String> {
    match role {
        TerminalRole::Agent => Ok(()),
        TerminalRole::NotAgent => Err(format!(
            "Terminal {pty_id} isn't an agent session — it's a shell or a run, and typing into \
             it would execute what you sent. canopy_agents lists the sessions you can message."
        )),
        TerminalRole::Unknown => Err(format!(
            "Canopy can't yet tell what terminal {pty_id} is running, so it won't type into it. \
             If it has only just started, call canopy_agents again in a moment."
        )),
    }
}

/// Whether this caller may stop or restart that terminal.
///
/// An agent owns its own terminal and nobody else's. `close_session` has always
/// been careful about this — it takes no id at all, so it can name no other
/// terminal — but `stop_server` took an arbitrary one with no check, which made
/// the restriction decorative: any agent could SIGTERM any other agent's
/// session by guessing a small integer.
///
/// `Unknown` is refused here for the same reason `Agent` is, and this is the
/// half that is easy to get backwards: reading "not classified yet" as "not an
/// agent" would leave a newly spawned session killable for as long as the
/// monitor takes to reach it, and a CLI the monitor cannot name killable
/// forever. Stopping a dev server one tick later costs nothing; the reverse
/// mistake ends somebody's work.
fn may_act_on_terminal(
    who: &Caller,
    pty_id: u32,
    role: TerminalRole,
    verb: &str,
) -> Result<(), String> {
    if role == TerminalRole::NotAgent {
        return Ok(());
    }
    // Your own session, or the user's own control surface acting for them —
    // the companion is how a runaway agent gets stopped.
    if who.agent().is_none_or(|a| a.pty_id == pty_id) {
        return Ok(());
    }
    let what = match role {
        TerminalRole::Unknown => "may be another agent's session",
        _ => "is another agent's session",
    };
    Err(format!(
        "Terminal {pty_id} {what}, not a server — you can't {verb} it. Send it a message with \
         canopy_message_agent, or ask the user."
    ))
}

/// Breadth-first file walk, relative paths, ignore-list applied. BFS so a cap
/// hit still yields the shallow (orienting) layers rather than one deep corner.
fn walk(root: &std::path::Path, max: usize) -> (Vec<String>, bool) {
    let mut out = Vec::new();
    let mut queue = std::collections::VecDeque::from([root.to_path_buf()]);
    while let Some(dir) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    queue.push_back(path);
                }
                continue;
            }
            if out.len() >= max {
                return (out, true);
            }
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().to_string());
            }
        }
    }
    (out, false)
}

/// Terminal output minus the terminal: CSI/OSC escape sequences and carriage
/// returns dropped, so agents read text, not control codes.
fn strip_ansi(bytes: &[u8]) -> String {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == 0x1b {
            i += 1;
            match bytes.get(i) {
                // CSI: parameters then one final byte in 0x40..=0x7e.
                Some(b'[') => {
                    i += 1;
                    while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                        i += 1;
                    }
                    i += 1;
                }
                // OSC: until BEL or ST (ESC \).
                Some(b']') => {
                    i += 1;
                    while i < bytes.len() {
                        if bytes[i] == 0x07 {
                            i += 1;
                            break;
                        }
                        if bytes[i] == 0x1b && bytes.get(i + 1) == Some(&b'\\') {
                            i += 2;
                            break;
                        }
                        i += 1;
                    }
                }
                // Two-byte escapes (charset selection etc.).
                Some(_) => i += 1,
                None => {}
            }
            continue;
        }
        if b != b'\r' {
            out.push(b);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_ansi_drops_csi_osc_and_cr() {
        let input = b"\x1b[31mred\x1b[0m plain\r\n\x1b]0;title\x07next\n\x1b[2K\x1b[1Gprompt";
        assert_eq!(strip_ansi(input), "red plain\nnext\nprompt");
    }

    #[test]
    fn strip_ansi_passes_utf8_through() {
        assert_eq!(strip_ansi("héllo → wörld".as_bytes()), "héllo → wörld");
    }

    #[test]
    fn browser_resize_requires_a_complete_size_or_reset() {
        assert!(validate_browser_resize(Some(390), Some(844), false).is_ok());
        assert!(validate_browser_resize(None, None, true).is_ok());
        assert!(validate_browser_resize(Some(390), None, false).is_err());
        assert!(validate_browser_resize(Some(199), Some(844), false).is_err());
        assert!(validate_browser_resize(Some(390), Some(844), true).is_err());
    }

    #[test]
    fn walk_caps_and_skips_dependency_dirs() {
        let root = std::env::temp_dir().join(format!("canopy-ctx-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/dep")).unwrap();
        std::fs::write(root.join("a.txt"), "x").unwrap();
        std::fs::write(root.join("src/b.txt"), "x").unwrap();
        std::fs::write(root.join("node_modules/dep/c.txt"), "x").unwrap();

        let (files, truncated) = walk(&root, 10);
        assert!(!truncated);
        assert_eq!(files, vec!["a.txt".to_string(), "src/b.txt".into()]);

        let (files, truncated) = walk(&root, 1);
        assert!(truncated);
        assert_eq!(files.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn claims_collide_on_containment_not_just_equality() {
        assert!(paths_overlap("/w/src/auth.ts", "/w/src/auth.ts"));
        // A directory claim covers what's under it, in both directions —
        // otherwise claiming a folder would silently permit claiming its files.
        assert!(paths_overlap("/w/src", "/w/src/auth.ts"));
        assert!(paths_overlap("/w/src/auth.ts", "/w/src"));
        assert!(paths_overlap("/w/src/", "/w/src"));
        // Neighbours with a shared prefix are not the same directory.
        assert!(!paths_overlap("/w/src", "/w/srcs/a.ts"));
        assert!(!paths_overlap("/w/src/a.ts", "/w/src/b.ts"));
    }

    fn claim_req(action: &str, owner: &str, paths: &[&str]) -> ClaimReq {
        ClaimReq {
            action: action.into(),
            paths: paths.iter().map(|p| p.to_string()).collect(),
            owner: owner.into(),
            note: Some(format!("{owner}'s work")),
        }
    }

    /// An agent in its own terminal. The identity is the terminal, so two of
    /// these are two agents however alike their display names are.
    fn who(name: &str, pty_id: u32) -> ClaimIdentity {
        ClaimIdentity {
            key: format!("pty:test:{pty_id}"),
            display: name.into(),
            pty_id: Some(pty_id),
            instance: Some("test".into()),
        }
    }

    /// Distinct agents whose display names differ, which is the easy case.
    fn named(name: &str) -> ClaimIdentity {
        let pty = name
            .bytes()
            .fold(0u32, |a, b| a.wrapping_mul(31) + b as u32);
        who(name, pty)
    }

    fn claim(
        claims: &mut Vec<Claim>,
        w: &ClaimIdentity,
        paths: &[&str],
        now: u64,
        id: &str,
    ) -> ClaimReply {
        apply_claim(claims, &claim_req("claim", &w.display, paths), w, now, id)
    }

    fn release(claims: &mut Vec<Claim>, w: &ClaimIdentity, now: u64) -> ClaimReply {
        apply_claim(
            claims,
            &claim_req("release", &w.display, &[]),
            w,
            now,
            "unused",
        )
    }

    fn ok(reply: ClaimReply) -> String {
        match reply {
            ClaimReply::Ok(m) => m,
            ClaimReply::Conflict(m) | ClaimReply::Bad(m) => panic!("expected success, got {m}"),
        }
    }

    fn conflict(reply: ClaimReply) -> String {
        match reply {
            ClaimReply::Conflict(m) => m,
            ClaimReply::Ok(m) | ClaimReply::Bad(m) => {
                panic!("expected an overlapping claim to be refused, got {m}")
            }
        }
    }

    fn held(claims: &[Claim]) -> Vec<&Claim> {
        claims
            .iter()
            .filter(|c| c.released_at_ms.is_none())
            .collect()
    }

    #[test]
    fn a_released_claim_keeps_its_history_and_blocks_nobody() {
        let (mut claims, alice, bob) = (Vec::new(), named("alice"), named("bob"));
        ok(claim(&mut claims, &alice, &["/w/src/auth.ts"], 100, "c1"));
        ok(release(&mut claims, &alice, 200));
        // The row survives the release — this is the whole point: "when did
        // that agent let go of it" used to be unanswerable because the release
        // deleted the only record there was.
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].released_at_ms, Some(200));
        assert_eq!(claims[0].released_by.as_deref(), Some("agent"));
        assert!(held(&claims).is_empty());
        // And it is history, not a holder: the next agent gets the file.
        ok(claim(&mut claims, &bob, &["/w/src/auth.ts"], 300, "c3"));
        assert_eq!(held(&claims).len(), 1);
        assert_eq!(held(&claims)[0].owner, "bob");
    }

    #[test]
    fn a_refused_claim_is_recorded_against_the_one_that_refused_it() {
        let (mut claims, alice, bob) = (Vec::new(), named("alice"), named("bob"));
        ok(claim(&mut claims, &alice, &["/w/src"], 100, "c1"));
        let msg = conflict(claim(&mut claims, &bob, &["/w/src/auth.ts"], 150, "c2"));
        assert!(msg.contains("alice"));
        // Refusing bob must not give bob a claim, and must leave a trace on
        // alice's — the collision is the most useful thing a claim records.
        assert_eq!(claims.len(), 1);
        assert_eq!(claims[0].refusals.len(), 1);
        assert_eq!(claims[0].refusals[0].owner, "bob");
        assert_eq!(claims[0].refusals[0].paths, vec!["/w/src/auth.ts"]);
        assert_eq!(claims[0].refusals[0].at_ms, 150);
        // Once alice lets go, the same claim goes through and the refusal is
        // still there to explain the wait.
        ok(release(&mut claims, &alice, 200));
        ok(claim(&mut claims, &bob, &["/w/src/auth.ts"], 250, "c4"));
        assert_eq!(claims[0].refusals.len(), 1);
        assert_eq!(held(&claims).len(), 1);
    }

    /// The defect claims existed for and could not survive: the conflict test
    /// was owner-string against owner-string, and `claim_owner` built that
    /// string out of the cwd — so the agents most likely to collide, the ones
    /// sharing a checkout, were the one pair that never could.
    #[test]
    fn two_agents_in_one_checkout_still_collide() {
        let mut claims = Vec::new();
        // Same display name, because they really are in the same directory.
        let (first, second) = (who("canopy (/w)", 1), who("canopy (/w)", 2));
        ok(claim(&mut claims, &first, &["/w/src/auth.ts"], 100, "c1"));
        let msg = conflict(claim(&mut claims, &second, &["/w/src/auth.ts"], 150, "c2"));
        assert!(msg.contains("/w/src/auth.ts"));
        // And the second agent's attempt must not have quietly taken the first
        // one's claim away, which is what superseding by owner string did.
        assert_eq!(held(&claims).len(), 1);
        assert_eq!(held(&claims)[0].id, "c1");
        assert_eq!(held(&claims)[0].owner_key, first.key);
    }

    /// Releasing ends your own claims and nobody else's. Keyed by the display
    /// string, `release` ended every claim that named the same directory — so
    /// one agent finishing dropped its neighbour's protection too.
    #[test]
    fn releasing_cannot_reach_another_agents_claims() {
        let mut claims = Vec::new();
        let (first, second) = (who("canopy (/w)", 1), who("canopy (/w)", 2));
        ok(claim(&mut claims, &first, &["/w/a.ts"], 100, "c1"));
        ok(claim(&mut claims, &second, &["/w/b.ts"], 110, "c2"));
        assert_eq!(
            ok(release(&mut claims, &second, 200)),
            "Released 1 claim(s)."
        );
        let still = held(&claims);
        assert_eq!(still.len(), 1);
        assert_eq!(still[0].id, "c1");
    }

    /// A claim spanning files held by several agents told the first one and
    /// left the rest believing their files were uncontested.
    #[test]
    fn every_holder_it_collided_with_hears_about_it() {
        let (mut claims, a, b, greedy) = (Vec::new(), named("a"), named("b"), named("greedy"));
        ok(claim(&mut claims, &a, &["/w/one.ts"], 100, "c1"));
        ok(claim(&mut claims, &b, &["/w/two.ts"], 110, "c2"));
        let msg = conflict(claim(
            &mut claims,
            &greedy,
            &["/w/one.ts", "/w/two.ts"],
            120,
            "c3",
        ));
        assert!(msg.contains("one other agent"), "got: {msg}");
        assert_eq!(claims[0].refusals.len(), 1);
        assert_eq!(claims[1].refusals.len(), 1);
    }

    /// An agent that answers a 409 by retrying — which the refusal text
    /// invites — must not be able to grow the holder's record without limit.
    #[test]
    fn refusals_are_capped() {
        let (mut claims, holder, pest) = (Vec::new(), named("holder"), named("pest"));
        ok(claim(&mut claims, &holder, &["/w/hot.ts"], 100, "c1"));
        for n in 0..MAX_REFUSALS + 25 {
            conflict(claim(
                &mut claims,
                &pest,
                &["/w/hot.ts"],
                200 + n as u64,
                "cx",
            ));
        }
        assert_eq!(claims[0].refusals.len(), MAX_REFUSALS);
        // The newest survive: an old refusal says nothing a recent one doesn't.
        let last = claims[0].refusals.last().unwrap().at_ms;
        assert_eq!(last, 200 + (MAX_REFUSALS + 24) as u64);
    }

    /// A dead agent's claim used to be permanent until a human pressed
    /// Release. The sweep needs the terminal on the claim to find it.
    #[test]
    fn a_claim_records_the_terminal_behind_it() {
        let mut claims = Vec::new();
        let agent = who("canopy (/w)", 7);
        ok(claim(&mut claims, &agent, &["/w/a.ts"], 100, "c1"));
        assert_eq!(claims[0].pty_id, Some(7));
        assert_eq!(claims[0].instance.as_deref(), Some("test"));
        // Which is exactly what the exit sweep ends them by.
        assert_eq!(end_claims(&mut claims, &agent.key, 200, "canopy"), 1);
        assert_eq!(claims[0].released_by.as_deref(), Some("canopy"));
    }

    #[test]
    fn reclaiming_supersedes_rather_than_erases() {
        let (mut claims, alice) = (Vec::new(), named("alice"));
        ok(claim(&mut claims, &alice, &["/w/a.ts"], 100, "c1"));
        ok(claim(&mut claims, &alice, &["/w/b.ts"], 200, "c2"));
        assert_eq!(claims.len(), 2);
        assert_eq!(claims[0].released_by.as_deref(), Some("superseded"));
        assert_eq!(held(&claims).len(), 1);
        assert_eq!(held(&claims)[0].id, "c2");
    }

    #[test]
    fn the_history_is_capped_but_never_at_a_held_claim() {
        let mut claims = Vec::new();
        for n in 0..MAX_ENDED_CLAIMS + 10 {
            let agent = who(&format!("agent-{n}"), n as u32 + 1);
            ok(claim(
                &mut claims,
                &agent,
                &[&format!("/w/{n}.ts")],
                n as u64,
                &format!("c{n}"),
            ));
            ok(release(&mut claims, &agent, n as u64 + 1));
        }
        ok(claim(
            &mut claims,
            &named("live"),
            &["/w/live.ts"],
            9999,
            "c-live",
        ));
        assert_eq!(
            claims.iter().filter(|c| c.released_at_ms.is_some()).count(),
            MAX_ENDED_CLAIMS
        );
        // The oldest endings go first, and the held one is never a candidate.
        assert_eq!(claims[0].id, "c10");
        assert_eq!(held(&claims).len(), 1);
        assert_eq!(held(&claims)[0].id, "c-live");
    }

    /// Two spellings of one file must meet. Prefix comparison alone let an
    /// agent claim `src/auth.ts` while another held `/w/src/auth.ts`, and both
    /// walked away believing they had it exclusively.
    #[test]
    fn claim_paths_are_normalised_before_they_are_compared() {
        let base = Some("/w");
        assert_eq!(normalize_claim_path("src/auth.ts", base), "/w/src/auth.ts");
        assert_eq!(
            normalize_claim_path("./src/auth.ts", base),
            "/w/src/auth.ts"
        );
        assert_eq!(
            normalize_claim_path("/w/src/../src/auth.ts", base),
            "/w/src/auth.ts"
        );
        assert_eq!(normalize_claim_path("/w/src/", base), "/w/src");
        // With no base to resolve against, a relative path stays relative
        // rather than being invented into an absolute one.
        assert_eq!(normalize_claim_path("src/auth.ts", None), "src/auth.ts");
        // A leading `..` has nothing to pop and must survive, or two unrelated
        // paths flatten into the same string.
        assert_eq!(
            normalize_claim_path("../sibling/a.ts", None),
            "../sibling/a.ts"
        );

        let (mut claims, a, b) = (Vec::new(), named("a"), named("b"));
        ok(claim(&mut claims, &a, &["/w/src/auth.ts"], 100, "c1"));
        let spelled_differently = normalize_claim_path("src/../src/auth.ts", base);
        conflict(claim(&mut claims, &b, &[&spelled_differently], 150, "c2"));
    }

    /// `Path::starts_with` compares components and does not resolve `..`, so
    /// this exact string passed the workspace check and walked straight back
    /// out of the workspace it was being checked against.
    #[test]
    fn traversal_cannot_escape_a_workspace_root() {
        let escape = normalize_claim_path("/Users/me/repo/../../../etc", None);
        assert_eq!(escape, "/etc");
        assert!(!std::path::Path::new(&escape).starts_with("/Users/me/repo"));
        // And the honest case still resolves inside.
        let inside = normalize_claim_path("/Users/me/repo/src/../lib", None);
        assert!(std::path::Path::new(&inside).starts_with("/Users/me/repo"));
    }

    /// Everything that is not text is stripped, not just the newlines. A
    /// message used to be able to carry ^C to interrupt the target mid-turn,
    /// or escape sequences its TUI would act on rather than display.
    #[test]
    fn a_message_carries_no_control_bytes() {
        assert_eq!(sanitize_message("hello\r\nworld"), "hello world");
        assert_eq!(sanitize_message("stop\u{3}now"), "stop now");
        assert_eq!(sanitize_message("\u{1b}[201~escaped"), "[201~escaped");
        assert_eq!(sanitize_message("a\u{4}\u{7}b"), "a b");
        // Runs left by the substitution collapse, and the edges are trimmed,
        // so a multi-line handoff does not arrive padded with its line breaks.
        assert_eq!(sanitize_message("  a\n\n\n  b  "), "a b");
        assert_eq!(sanitize_message("\r\n\u{3}"), "");
        // Ordinary text, including non-ASCII, is untouched.
        assert_eq!(
            sanitize_message("rebase onto main — then push"),
            "rebase onto main — then push"
        );
    }

    /// The identity is the terminal, so two agents in one directory are two
    /// identities — and the same terminal in a later app run is not the same
    /// agent, because pty ids restart at 1.
    #[test]
    fn an_identity_is_a_terminal_not_a_directory() {
        let a = AgentIdentity {
            pty_id: 1,
            instance: "run-a".into(),
            cwd: "/w".into(),
        };
        let b = AgentIdentity {
            pty_id: 2,
            instance: "run-a".into(),
            cwd: "/w".into(),
        };
        let recycled = AgentIdentity {
            pty_id: 1,
            instance: "run-b".into(),
            cwd: "/w".into(),
        };
        assert_ne!(a.key(), b.key());
        assert_ne!(a.key(), recycled.key());
        assert_eq!(
            a.key(),
            AgentIdentity {
                pty_id: 1,
                instance: "run-a".into(),
                cwd: "/elsewhere".into()
            }
            .key()
        );
    }

    /// The registry is what makes "who is calling" answerable, and what tells
    /// an agent session apart from the user's own shell — the question
    /// `message_agent` was never asking before it typed into one.
    #[test]
    fn a_terminals_credential_names_it_and_dies_with_it() {
        let bridge = ContextBridge::default();
        let _ = bridge.port.set(4242);

        let (port, token) = bridge.mint_agent(7, "/w/app").expect("port is set");
        assert_eq!(port, 4242);

        match bridge.identify(&token) {
            Some(Caller::Agent(a)) => {
                assert_eq!(a.pty_id, 7);
                assert_eq!(a.cwd, "/w/app");
            }
            other => panic!("the minted token must name its terminal, got {other:?}"),
        }
        // The process-wide token is trusted but nameless, so it can never act
        // as some particular agent.
        assert_eq!(bridge.identify(&bridge.token), Some(Caller::Root));
        assert_eq!(bridge.identify("not a token"), None);

        // Two terminals in one directory get two credentials and two
        // identities, which is the whole point.
        let (_, second) = bridge.mint_agent(8, "/w/app").unwrap();
        assert_ne!(token, second);
        let key_of = |t: &str| match bridge.identify(t) {
            Some(Caller::Agent(a)) => a.key(),
            _ => panic!("expected an agent"),
        };
        assert_ne!(key_of(&token), key_of(&second));

        // Retiring hands back the identity the sweep needs, and the credential
        // stops working immediately.
        let retired = bridge.retire_agent(7).expect("pty 7 was registered");
        assert_eq!(retired.pty_id, 7);
        assert_eq!(bridge.identify(&token), None);
        assert!(bridge.retire_agent(7).is_none());
        // The other terminal is untouched by its neighbour's exit.
        assert!(matches!(bridge.identify(&second), Some(Caller::Agent(_))));
    }

    /// An agent owns its own terminal and nobody else's. `close_session` was
    /// careful about this and `stop_server` was not, which made the
    /// restriction decorative.
    #[test]
    fn one_agent_cannot_stop_anothers_session() {
        let bridge = ContextBridge::default();
        let _ = bridge.port.set(1);
        let (_, mine) = bridge.mint_agent(1, "/w").unwrap();
        let me = bridge.identify(&mine).unwrap();
        use TerminalRole::{Agent, NotAgent};

        // Another agent's session: refused, with somewhere else to go.
        let err = may_act_on_terminal(&me, 2, Agent, "stop").unwrap_err();
        assert!(err.contains("canopy_message_agent"), "got: {err}");
        // My own: allowed.
        assert!(may_act_on_terminal(&me, 1, Agent, "stop").is_ok());
        // A dev server or a shell stays fair game — stopping one is the point
        // of the tool.
        assert!(may_act_on_terminal(&me, 99, NotAgent, "stop").is_ok());
        // The user's own control surface can stop a runaway agent; the rule is
        // about one agent reaching for another, not about Canopy itself.
        assert!(may_act_on_terminal(&Caller::Root, 2, Agent, "stop").is_ok());
    }

    /// The half that is easy to get backwards. The monitor classifies on a
    /// tick, so a session that has only just started — and any CLI the monitor
    /// cannot name at all — is `Unknown`; reading that as "not an agent" would
    /// leave it killable by any other agent for as long as that lasts.
    #[test]
    fn an_unclassified_terminal_is_protected_but_not_messaged() {
        let bridge = ContextBridge::default();
        let _ = bridge.port.set(1);
        let (_, mine) = bridge.mint_agent(1, "/w").unwrap();
        let me = bridge.identify(&mine).unwrap();

        // Stopping: refused while we cannot tell, and the wording says why.
        let err = may_act_on_terminal(&me, 2, TerminalRole::Unknown, "stop").unwrap_err();
        assert!(err.contains("may be another agent's session"), "got: {err}");
        // Messaging: also refused, but for the opposite reason — typing into
        // something that might be a shell runs what you sent.
        let err = may_message_terminal(2, TerminalRole::Unknown).unwrap_err();
        assert!(err.contains("can't yet tell"), "got: {err}");
        // And a known agent is messageable, a known shell is not.
        assert!(may_message_terminal(2, TerminalRole::Agent).is_ok());
        assert!(may_message_terminal(2, TerminalRole::NotAgent).is_err());
    }

    /// `paths_overlap` is a prefix test, so a path that normalises to nothing
    /// is a prefix of every path there is: claiming one collided with every
    /// held claim in the app — reading back the first holder on the way — and
    /// on an empty store took a claim that refused everybody everywhere.
    #[test]
    fn a_claim_cannot_name_everything() {
        let (mut claims, greedy, honest) = (Vec::new(), named("greedy"), named("honest"));
        for wildcard in ["", "/", "   ", "src/relative.ts"] {
            match claim(&mut claims, &greedy, &[wildcard], 100, "c1") {
                ClaimReply::Bad(_) => {}
                other => panic!(
                    "{wildcard:?} must be refused as a claim, got {}",
                    match other {
                        ClaimReply::Ok(m) | ClaimReply::Conflict(m) | ClaimReply::Bad(m) => m,
                    }
                ),
            }
        }
        assert!(claims.is_empty(), "a refused claim must not be stored");
        // A real path still works, and still only collides with itself.
        ok(claim(&mut claims, &honest, &["/w/real.ts"], 100, "c1"));
        assert_eq!(held(&claims).len(), 1);
    }

    #[test]
    fn a_credential_comparison_does_not_leak_its_prefix() {
        assert!(constant_time_eq("abc123", "abc123"));
        assert!(!constant_time_eq("abc123", "abc124"));
        assert!(!constant_time_eq("abc", "abc1"));
        assert!(constant_time_eq("", ""));
    }

    /// Claims are the caller's business only when they could collide with it.
    /// Unscoped, an agent learned every open project's claimed paths — even
    /// with shared context switched off for its own.
    #[test]
    fn claims_are_scoped_to_the_callers_tree() {
        let mine = Claim {
            id: "c1".into(),
            paths: vec!["/w/app/src/a.ts".into()],
            owner: "app (/w/app)".into(),
            owner_key: "pty:test:1".into(),
            pty_id: Some(1),
            instance: Some("test".into()),
            note: None,
            at_ms: 0,
            released_at_ms: None,
            released_by: None,
            refusals: Vec::new(),
        };
        let theirs = Claim {
            paths: vec!["/w/other/src/b.ts".into()],
            owner: "other (/w/other)".into(),
            ..mine.clone()
        };
        assert!(claim_concerns(&mine, "/w/app"));
        assert!(!claim_concerns(&theirs, "/w/app"));
        // A subdirectory of the claimed tree still concerns me.
        assert!(claim_concerns(&mine, "/w/app/src"));
    }

    #[test]
    fn an_owner_display_string_yields_its_directory() {
        assert_eq!(
            claim_owner_cwd("canopy (/w/canopy)").as_deref(),
            Some("/w/canopy")
        );
        assert_eq!(claim_owner_cwd("no directory here"), None);
    }

    #[test]
    fn tail_lines_returns_the_end_and_survives_short_input() {
        let text = (1..=10)
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(tail_lines(&text, 3), "8\n9\n10");
        assert_eq!(tail_lines("only", 5), "only");
        assert_eq!(tail_lines("", 5), "");
    }

    fn proj(id: &str, roots: &[&str]) -> (String, String, Vec<String>) {
        (
            id.into(),
            id.to_uppercase(),
            roots.iter().map(|r| r.to_string()).collect(),
        )
    }

    #[test]
    fn research_resolves_to_exactly_one_project() {
        let projects = vec![
            proj("app", &["/Users/dev/app"]),
            proj("other", &["/Users/dev/other"]),
            // A sub-package registered as a component in its own right.
            proj("pkg", &["/Users/dev/app/packages/ui"]),
        ];

        let id = |cwd: &str| pick_project(&projects, cwd).map(|(id, ..)| id);
        assert_eq!(id("/Users/dev/app"), Some("app".into()));
        assert_eq!(id("/Users/dev/app/src/components"), Some("app".into()));
        // The nearer component wins, so a nested package's research does not
        // land in its parent's list.
        assert_eq!(id("/Users/dev/app/packages/ui/src"), Some("pkg".into()));
        // A sibling sharing a textual prefix is a different project.
        assert_eq!(id("/Users/dev/app-old"), None);
        // Outside every project there is no answer — the handler turns this
        // into an error rather than a machine-wide list, which is the whole
        // scoping rule.
        assert_eq!(id("/tmp/somewhere"), None);
    }

    #[test]
    fn a_worktree_resolves_to_the_checkout_it_came_from() {
        // The bug this fixes: agents work in worktrees constantly — it is how
        // every isolated micro-task runs, including the one that implements
        // research — and `<repo>-wt-<branch>` is a *sibling* of the checkout,
        // so no component path contains it. Research refused exactly the
        // sessions most likely to produce any, and an agent with nowhere legal
        // to write hand-wrote the store instead.
        let projects = vec![proj("app", &["/Users/dev/app"])];
        let wt = "/Users/dev/app-wt-feat-x";
        // Unresolvable on its own — this is the refusal that was happening.
        assert!(pick_project(&projects, wt).is_none());
        // Resolved through git, it lands on the project that owns it.
        let id =
            resolve_project(&projects, wt, |_| Some("/Users/dev/app".into())).map(|(id, ..)| id);
        assert_eq!(id, Some("app".into()));
    }

    #[test]
    fn resolving_through_git_never_invents_a_project() {
        let projects = vec![proj("app", &["/Users/dev/app"])];
        // Not a repo at all: git answers nothing and so do we.
        assert!(resolve_project(&projects, "/tmp/elsewhere", |_| None).is_none());
        // A repo, but not one that is open here — the checkout it resolves to
        // still has to be a project, or this would attach research to whatever
        // happened to be first in the list.
        assert!(
            resolve_project(&projects, "/Users/dev/other-wt-x", |_| Some(
                "/Users/dev/other".into()
            ))
            .is_none()
        );
        // git pointing back at the same directory is not a second chance.
        assert!(resolve_project(&projects, "/tmp/elsewhere", |c| Some(c.to_string())).is_none());
    }

    #[test]
    fn a_direct_hit_never_pays_for_the_git_call() {
        // The fallback is a subprocess; it must not run when the cwd already
        // answers, which is the overwhelming majority of calls.
        let projects = vec![proj("app", &["/Users/dev/app"])];
        let id = resolve_project(&projects, "/Users/dev/app/src", |_| {
            panic!("git was consulted for a directory that already resolved")
        })
        .map(|(id, ..)| id);
        assert_eq!(id, Some("app".into()));
    }

    #[test]
    fn a_project_with_no_components_claims_nothing() {
        let projects = vec![proj("empty", &[]), proj("blank", &[""])];
        assert!(pick_project(&projects, "/Users/dev/app").is_none());
        // An empty root must not match every directory on the machine.
        assert!(pick_project(&projects, "/").is_none());
    }
}

//! Speaking MCP to the servers `mcp` discovered, so the panel can show what they
//! actually expose rather than what a config file says about them.
//!
//! `mcp.rs` reads files; this starts processes and opens sockets. That is the
//! whole difference, and it is why the two are separate modules: discovery is
//! cheap and safe to run on every panel open, and this is neither. Nothing here
//! runs until the user opens a server's tab.
//!
//! A hand-written client rather than a crate, for two reasons. The wire format
//! is JSON-RPC 2.0 over a line-delimited pipe or an HTTP POST — a few hundred
//! lines, most of it error handling we would want to write anyway so a failure
//! shows the user *why*. And the SDK crates want to own the async runtime and
//! the process lifecycle, both of which Tauri already owns here.
//!
//! Connections are pooled and reused: `tools/list` costs an `npx` cold start,
//! frequently a package download, and paying that again for every test call
//! would make the panel feel broken. They are reaped after `IDLE_TIMEOUT` so an
//! afternoon of browsing doesn't leave a dozen node processes running.

use std::collections::{BTreeMap, HashMap};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex;

use crate::mcp::{launch_spec, LaunchSpec};
use crate::winproc::NoConsoleWindow;

/// The revision we ask for. Servers answer with their own and we take theirs;
/// this is a preference, not a requirement, and every server in the wild
/// negotiates down rather than refusing.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// Cold starts are the norm — `npx` may fetch a package before the server says
/// anything at all — so the handshake gets room. A hung server still fails in
/// under a minute rather than leaving a spinner forever.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(45);
/// Listing is a local answer from an already-running server.
const LIST_TIMEOUT: Duration = Duration::from_secs(30);
/// A tool call can do real work — fetch a page, run a query, drive a browser.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a connection nobody has used stays alive before it is killed.
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// stderr worth keeping for a diagnostic. Servers that fail on startup say why
/// here and nowhere else; servers that log happily would otherwise grow without
/// bound, so only the tail is kept.
const STDERR_KEEP: usize = 8 * 1024;

// ---------------------------------------------------------------------------
// What crosses into the webview
// ---------------------------------------------------------------------------

/// One tool as the server describes it. `input_schema` is passed through
/// untouched: it is JSON Schema, the UI renders a form from it, and rewriting it
/// on the way would only lose the parts we didn't think to keep.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct McpTool {
    pub name: String,
    /// The server's own display name, when it gave one.
    pub title: Option<String>,
    pub description: Option<String>,
    pub input_schema: Value,
    pub output_schema: Option<Value>,
    /// `readOnlyHint`, `destructiveHint` and friends, verbatim. The panel uses
    /// them to warn before a call, and a hint we don't understand today is
    /// still worth showing.
    pub annotations: Option<Value>,
}

/// A prompt or resource, listed but not driven. Named so the user can see the
/// server's whole surface — a server whose point is its resources looked empty
/// when we only counted tools.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct McpNamed {
    pub name: String,
    pub description: Option<String>,
    /// Resources only: the URI a reader would ask for.
    pub uri: Option<String>,
    pub mime_type: Option<String>,
}

/// The result of connecting: who answered, and what they expose.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct McpSession {
    pub key: String,
    /// Server name from `initialize`, which is frequently not the name any
    /// config gave it — worth showing precisely because it is the server's own.
    pub server_name: Option<String>,
    pub server_version: Option<String>,
    /// What was actually negotiated, not what we asked for.
    pub protocol_version: Option<String>,
    /// Free text some servers send to orient a model. Shown as-is.
    pub instructions: Option<String>,
    pub tools: Vec<McpTool>,
    pub prompts: Vec<McpNamed>,
    pub resources: Vec<McpNamed>,
    /// Capability names the server advertised, for the ones it has that we
    /// don't drive (logging, sampling, completions).
    pub capabilities: Vec<String>,
    /// Milliseconds from spawn to a listed tool set. The honest number: it is
    /// what the user waited, cold start included.
    pub elapsed_ms: u64,
}

/// One `tools/call`, as the panel shows it.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct McpCallResult {
    /// The `content` array verbatim — text, images, embedded resources.
    pub content: Value,
    /// Servers report a *tool's* failure in-band with this flag rather than as
    /// a JSON-RPC error; a protocol error comes back as `Err` instead. The
    /// difference matters: one means the tool ran and said no, the other means
    /// the call never happened.
    pub is_error: bool,
    /// `structuredContent`, when the tool declared an output schema.
    pub structured: Option<Value>,
    pub elapsed_ms: u64,
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// A live server, however we reach it.
enum Transport {
    Stdio(StdioTransport),
    Http(HttpTransport),
}

/// A child process spoken to over its stdin/stdout, one JSON object per line.
struct StdioTransport {
    /// Held, never read: dropping it is what kills the process, so the field
    /// exists for its `Drop` and nothing else.
    #[allow(dead_code)]
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    /// The tail of stderr, shared with the draining task. The only reason a
    /// failed handshake is ever explicable.
    stderr: Arc<std::sync::Mutex<String>>,
}

/// Streamable HTTP: every request is a POST, and the response is either JSON or
/// an SSE stream carrying the same JSON in a `data:` line.
struct HttpTransport {
    url: String,
    client: reqwest::Client,
    /// Config headers — an `Authorization` for a hosted server usually.
    headers: BTreeMap<String, String>,
    /// Handed out by the server at `initialize`; every later request must carry
    /// it or the server treats us as a stranger.
    session_id: Option<String>,
}

/// A connected server plus the bookkeeping the pool needs.
struct Connection {
    transport: Transport,
    next_id: i64,
    last_used: Instant,
}

impl Connection {
    /// One JSON-RPC request/response round trip.
    async fn request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        let body = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        self.last_used = Instant::now();

        let response = match &mut self.transport {
            Transport::Stdio(t) => t.round_trip(id, &body, timeout).await,
            Transport::Http(t) => t.round_trip(id, &body, timeout).await,
        }?;

        if let Some(error) = response.get("error") {
            let message = error
                .get("message")
                .and_then(|m| m.as_str())
                .unwrap_or("unknown error");
            let code = error.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
            return Err(format!("{method} failed: {message} (code {code})"));
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    /// A notification: no id, no reply, and nothing to wait for.
    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        let body = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        match &mut self.transport {
            Transport::Stdio(t) => t.send(&body).await,
            Transport::Http(t) => t.notify(&body).await,
        }
    }

    /// Whatever the server said on stderr, for a message the user can act on.
    fn stderr_tail(&self) -> String {
        match &self.transport {
            Transport::Stdio(t) => t
                .stderr
                .lock()
                .map(|s| s.trim().to_string())
                .unwrap_or_default(),
            Transport::Http(_) => String::new(),
        }
    }
}

impl StdioTransport {
    async fn send(&mut self, body: &Value) -> Result<(), String> {
        let line = format!("{body}\n");
        self.stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("writing to the server failed: {e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("writing to the server failed: {e}"))
    }

    async fn round_trip(
        &mut self,
        id: i64,
        body: &Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        self.send(body).await?;
        tokio::time::timeout(timeout, self.read_reply(id))
            .await
            .map_err(|_| format!("the server did not answer within {}s", timeout.as_secs()))?
    }

    /// Read until the reply to `id` arrives.
    ///
    /// Anything else on the pipe is skipped rather than treated as an error: a
    /// server may log, may send notifications, and — often enough to matter —
    /// may print a banner line that isn't JSON at all before it starts talking
    /// protocol. Only end-of-pipe is fatal.
    async fn read_reply(&mut self, id: i64) -> Result<Value, String> {
        loop {
            let mut line = String::new();
            let read = self
                .stdout
                .read_line(&mut line)
                .await
                .map_err(|e| format!("reading from the server failed: {e}"))?;
            if read == 0 {
                return Err("the server closed its output".into());
            }
            let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            if message.get("id").and_then(|v| v.as_i64()) == Some(id) {
                return Ok(message);
            }
        }
    }
}

impl HttpTransport {
    fn post(&self, body: &Value) -> reqwest::RequestBuilder {
        let mut req = self
            .client
            .post(&self.url)
            .header("content-type", "application/json")
            // Streamable HTTP lets the server answer either way and pick per
            // request; a client that accepts only one gets a 406 from half of
            // them.
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", PROTOCOL_VERSION);
        for (name, value) in &self.headers {
            req = req.header(name, value);
        }
        if let Some(session) = &self.session_id {
            req = req.header("mcp-session-id", session);
        }
        // Serialized here rather than through reqwest's `json` helper, which
        // would mean turning on a feature to do what `to_string` already does.
        req.body(body.to_string())
    }

    async fn notify(&mut self, body: &Value) -> Result<(), String> {
        self.post(body)
            .send()
            .await
            .map(|_| ())
            .map_err(|e| format!("the server could not be reached: {e}"))
    }

    async fn round_trip(
        &mut self,
        id: i64,
        body: &Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let response = tokio::time::timeout(timeout, self.post(body).send())
            .await
            .map_err(|_| format!("the server did not answer within {}s", timeout.as_secs()))?
            .map_err(|e| format!("the server could not be reached: {e}"))?;

        if let Some(session) = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            self.session_id = Some(session.to_string());
        }

        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| format!("reading the response failed: {e}"))?;
        if !status.is_success() {
            // The body is where a hosted server explains a 401, so it goes in
            // the message rather than just the code.
            let detail = text.trim();
            let detail = if detail.len() > 300 {
                &detail[..300]
            } else {
                detail
            };
            return Err(format!("the server answered {status}: {detail}"));
        }
        parse_http_body(&text, id)
    }
}

/// A streamable-HTTP body: either one JSON-RPC object, or an SSE stream whose
/// `data:` lines each carry one.
///
/// Split out and pure so the framing can be tested without a server: this is the
/// part that breaks against a real implementation, and finding out from a
/// failing test beats finding out from an empty tool list.
fn parse_http_body(text: &str, id: i64) -> Result<Value, String> {
    if let Ok(value) = serde_json::from_str::<Value>(text.trim()) {
        // A batch response: find ours.
        if let Some(items) = value.as_array() {
            return items
                .iter()
                .find(|m| m.get("id").and_then(|v| v.as_i64()) == Some(id))
                .cloned()
                .ok_or_else(|| "the server answered without our request in it".to_string());
        }
        return Ok(value);
    }
    // SSE. Only the payload matters; event names and ids are transport detail.
    for line in text.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let Ok(message) = serde_json::from_str::<Value>(data.trim()) else {
            continue;
        };
        if message.get("id").and_then(|v| v.as_i64()) == Some(id) {
            return Ok(message);
        }
    }
    Err("the server's answer could not be read as JSON-RPC".into())
}

// ---------------------------------------------------------------------------
// Starting a server
// ---------------------------------------------------------------------------

use crate::procenv::resolve_command;

fn start_stdio(spec: &LaunchSpec) -> Result<Transport, String> {
    let command = spec
        .command
        .as_deref()
        .ok_or("this server has no command to run")?;
    let resolved = resolve_command(command);

    let mut cmd = tokio::process::Command::new(&resolved);
    cmd.args(&spec.args)
        .envs(&spec.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // The user closing the tab, or quitting Canopy, must not leave a server
        // running. Dropping the connection is how a server is stopped, so drop
        // has to be what kills it.
        .kill_on_drop(true);
    cmd.no_console_window();
    if let Some(cwd) = spec.cwd.as_ref().filter(|c| c.is_dir()) {
        cmd.current_dir(cwd);
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start `{resolved}`: {e}"))?;
    let stdin = child.stdin.take().ok_or("the server has no stdin")?;
    let stdout = child.stdout.take().ok_or("the server has no stdout")?;
    let stderr = child.stderr.take();

    // Drain stderr into a bounded tail. Unread, a full pipe buffer deadlocks a
    // chatty server mid-handshake, so this task has to exist whether or not
    // anyone reads what it collects.
    let collected = Arc::new(std::sync::Mutex::new(String::new()));
    if let Some(stderr) = stderr {
        let sink = collected.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(mut held) = sink.lock() else { return };
                held.push_str(&line);
                held.push('\n');
                if held.len() > STDERR_KEEP {
                    let cut = held.len() - STDERR_KEEP;
                    *held = held[cut..].to_string();
                }
            }
        });
    }

    Ok(Transport::Stdio(StdioTransport {
        child,
        stdin,
        stdout: BufReader::new(stdout),
        stderr: collected,
    }))
}

fn start_http(spec: &LaunchSpec) -> Result<Transport, String> {
    let url = spec.url.clone().ok_or("this server has no URL")?;
    let client = reqwest::Client::builder()
        .timeout(CALL_TIMEOUT)
        .build()
        .map_err(|e| format!("could not build an HTTP client: {e}"))?;
    Ok(Transport::Http(HttpTransport {
        url,
        client,
        headers: spec.env.clone(),
        session_id: None,
    }))
}

/// Connect and run the MCP handshake, leaving a connection ready for requests.
async fn open(spec: &LaunchSpec) -> Result<(Connection, McpSession), String> {
    let started = Instant::now();
    let transport = match spec.transport.as_str() {
        "stdio" => start_stdio(spec)?,
        _ => start_http(spec)?,
    };
    let mut conn = Connection {
        transport,
        next_id: 0,
        last_used: Instant::now(),
    };

    let init = conn
        .request(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                // No capabilities claimed, because none are implemented. A
                // server that would have asked us to sample or elicit is told
                // up front that we can't, rather than left waiting on a reply
                // that never comes.
                "capabilities": {},
                "clientInfo": { "name": "Canopy", "version": env!("CARGO_PKG_VERSION") },
            }),
            CONNECT_TIMEOUT,
        )
        .await
        .map_err(|e| with_stderr(e, &conn))?;

    // Required by the spec before any other request, and servers do enforce it.
    conn.notify("notifications/initialized", json!({})).await?;

    let server_info = init.get("serverInfo");
    let capabilities = init
        .get("capabilities")
        .and_then(|c| c.as_object())
        .map(|c| c.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();

    // Only ask for what the server said it has. A `prompts/list` to a server
    // without prompts is a error message in the UI for no reason.
    let tools = if capabilities.iter().any(|c| c == "tools") {
        list_tools(&mut conn)
            .await
            .map_err(|e| with_stderr(e, &conn))?
    } else {
        Vec::new()
    };
    let prompts = if capabilities.iter().any(|c| c == "prompts") {
        list_named(&mut conn, "prompts/list", "prompts").await
    } else {
        Vec::new()
    };
    let resources = if capabilities.iter().any(|c| c == "resources") {
        list_named(&mut conn, "resources/list", "resources").await
    } else {
        Vec::new()
    };

    let session = McpSession {
        key: spec.key.clone(),
        server_name: string_at(server_info, "name"),
        server_version: string_at(server_info, "version"),
        protocol_version: init
            .get("protocolVersion")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        instructions: init
            .get("instructions")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        tools,
        prompts,
        resources,
        capabilities,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    Ok((conn, session))
}

/// A failure with whatever the server printed before it died. "could not start"
/// on its own is unactionable; the same line followed by the server's own
/// `Error: BROWSERBASE_API_KEY is required` is a fix.
fn with_stderr(error: String, conn: &Connection) -> String {
    let tail = conn.stderr_tail();
    if tail.is_empty() {
        return error;
    }
    let tail = tail.lines().rev().take(6).collect::<Vec<_>>();
    let tail = tail.into_iter().rev().collect::<Vec<_>>().join("\n");
    format!("{error}\n\n{tail}")
}

fn string_at(value: Option<&Value>, key: &str) -> Option<String> {
    value?.get(key)?.as_str().map(str::to_string)
}

/// Every page of `tools/list`. Servers with many tools paginate, and stopping at
/// the first page would silently hide the rest.
async fn list_tools(conn: &mut Connection) -> Result<Vec<McpTool>, String> {
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = match &cursor {
            Some(c) => json!({ "cursor": c }),
            None => json!({}),
        };
        let page = conn.request("tools/list", params, LIST_TIMEOUT).await?;
        for item in page
            .get("tools")
            .and_then(|t| t.as_array())
            .unwrap_or(&vec![])
        {
            let Some(name) = item.get("name").and_then(|n| n.as_str()) else {
                continue;
            };
            tools.push(McpTool {
                name: name.to_string(),
                title: item
                    .get("title")
                    .and_then(|t| t.as_str())
                    .map(str::to_string),
                description: item
                    .get("description")
                    .and_then(|d| d.as_str())
                    .map(str::to_string),
                // An absent schema means "no arguments", which the form
                // renderer should see as an empty object rather than as null.
                input_schema: item
                    .get("inputSchema")
                    .cloned()
                    .unwrap_or_else(|| json!({ "type": "object" })),
                output_schema: item.get("outputSchema").cloned(),
                annotations: item.get("annotations").cloned(),
            });
        }
        cursor = page
            .get("nextCursor")
            .and_then(|c| c.as_str())
            .map(str::to_string);
        // A server that keeps handing back a cursor would loop forever; the
        // page count is a backstop, not a limit anyone should reach.
        if cursor.is_none() || tools.len() > 2000 {
            break;
        }
    }
    Ok(tools)
}

/// Prompts and resources, which are listed for completeness. A failure here is
/// not a failure to connect — the tools are the point — so it yields nothing
/// rather than sinking the whole session.
async fn list_named(conn: &mut Connection, method: &str, field: &str) -> Vec<McpNamed> {
    let Ok(page) = conn.request(method, json!({}), LIST_TIMEOUT).await else {
        return Vec::new();
    };
    page.get(field)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let name = item
                        .get("name")
                        .and_then(|n| n.as_str())
                        .or_else(|| item.get("uri").and_then(|u| u.as_str()))?;
                    Some(McpNamed {
                        name: name.to_string(),
                        description: item
                            .get("description")
                            .and_then(|d| d.as_str())
                            .map(str::to_string),
                        uri: item.get("uri").and_then(|u| u.as_str()).map(str::to_string),
                        mime_type: item
                            .get("mimeType")
                            .and_then(|m| m.as_str())
                            .map(str::to_string),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// The pool
// ---------------------------------------------------------------------------

type Pool = Mutex<HashMap<String, Arc<Mutex<Connection>>>>;

static POOL: std::sync::OnceLock<Pool> = std::sync::OnceLock::new();

fn pool() -> &'static Pool {
    POOL.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Kill connections nobody has touched in `IDLE_TIMEOUT`.
///
/// Started on the first connect rather than at app launch: a user who never
/// opens the panel should not be paying for a timer, and one who does pays for
/// exactly one.
fn ensure_reaper() {
    static STARTED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    STARTED.get_or_init(|| {
        tokio::spawn(async {
            let mut tick = tokio::time::interval(Duration::from_secs(60));
            loop {
                tick.tick().await;
                let mut held = pool().lock().await;
                // `try_lock` skips a connection mid-call, which is right: it is
                // in use by definition, and it will be idle at the next tick.
                held.retain(|_, conn| match conn.try_lock() {
                    Ok(c) => c.last_used.elapsed() < IDLE_TIMEOUT,
                    Err(_) => true,
                });
            }
        });
    });
}

/// The connection for this server, opening one if there isn't a live one.
///
/// Returns the session alongside, but only when this call is what opened it —
/// a reused connection has no fresh handshake to report.
async fn acquire(key: &str) -> Result<(Arc<Mutex<Connection>>, Option<McpSession>), String> {
    if let Some(existing) = pool().lock().await.get(key).cloned() {
        return Ok((existing, None));
    }
    let spec =
        launch_spec(key).ok_or("this server is no longer in any config — refresh the panel")?;
    ensure_reaper();
    let (conn, session) = open(&spec).await?;
    let shared = Arc::new(Mutex::new(conn));
    pool().lock().await.insert(key.to_string(), shared.clone());
    Ok((shared, Some(session)))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Connect to a server and list what it exposes.
///
/// `refresh` throws away a pooled connection first, which is what the reload
/// button in the detail view means: the user has just edited the server and
/// wants to see the new tools, not the ones we cached.
#[tauri::command]
pub async fn mcp_connect(key: String, refresh: Option<bool>) -> Result<McpSession, String> {
    if refresh.unwrap_or(false) {
        pool().lock().await.remove(&key);
    }
    let (conn, opened) = acquire(&key).await?;
    if let Some(session) = opened {
        return Ok(session);
    }
    // Reused: re-list rather than cache a tool set, since a server may add
    // tools while connected and the list is cheap once the process is warm.
    let mut held = conn.lock().await;
    let spec = launch_spec(&key).ok_or("this server is no longer in any config")?;
    let started = Instant::now();
    let tools = match list_tools(&mut held).await {
        Ok(tools) => tools,
        Err(e) => {
            // A connection that has died since we pooled it looks exactly like
            // this. Drop it and let the next call start a fresh one rather than
            // leaving the user with a dead handle they can't clear.
            drop(held);
            pool().lock().await.remove(&key);
            return Err(e);
        }
    };
    Ok(McpSession {
        key: key.clone(),
        server_name: Some(spec.name),
        server_version: None,
        protocol_version: None,
        instructions: None,
        tools,
        prompts: Vec::new(),
        resources: Vec::new(),
        capabilities: vec!["tools".into()],
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Run one tool. The arguments are whatever the user typed, validated by the
/// server against its own schema — which is the only validation that counts.
#[tauri::command]
pub async fn mcp_call_tool(
    key: String,
    tool: String,
    arguments: Option<Value>,
) -> Result<McpCallResult, String> {
    let (conn, _) = acquire(&key).await?;
    let mut held = conn.lock().await;
    let started = Instant::now();
    let result = held
        .request(
            "tools/call",
            json!({ "name": tool, "arguments": arguments.unwrap_or_else(|| json!({})) }),
            CALL_TIMEOUT,
        )
        .await;
    let result = match result {
        Ok(result) => result,
        Err(e) => {
            let message = with_stderr(e, &held);
            drop(held);
            // Same reasoning as above: a transport-level failure means this
            // connection is suspect, so it doesn't get to serve another call.
            pool().lock().await.remove(&key);
            return Err(message);
        }
    };
    Ok(McpCallResult {
        content: result.get("content").cloned().unwrap_or_else(|| json!([])),
        is_error: result
            .get("isError")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        structured: result.get("structuredContent").cloned(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// Stop a server. Dropping the connection kills the child (`kill_on_drop`), so
/// this is the whole implementation.
#[tauri::command]
pub async fn mcp_disconnect(key: String) -> Result<(), String> {
    pool().lock().await.remove(&key);
    Ok(())
}

/// Which servers are connected right now, so the panel can mark them.
#[tauri::command]
pub async fn mcp_connected() -> Result<Vec<String>, String> {
    Ok(pool().lock().await.keys().cloned().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_json_body_is_read_as_the_reply() {
        let body = r#"{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}"#;
        let value = parse_http_body(body, 7).expect("parses");
        assert!(value.get("result").is_some());
    }

    /// The shape hosted servers actually send: the reply arrives as one SSE
    /// event, preceded by fields that are transport bookkeeping.
    #[test]
    fn an_sse_body_is_read_as_the_reply() {
        let body = "event: message\nid: 1\ndata: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}\n\n";
        let value = parse_http_body(body, 7).expect("parses");
        assert_eq!(value["result"]["ok"], true);
    }

    /// A stream can carry notifications before the reply. Taking the first
    /// `data:` line would return a server log line as if it were the answer.
    #[test]
    fn an_sse_body_skips_messages_that_are_not_ours() {
        let body = concat!(
            "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\",\"params\":{}}\n\n",
            "data: {\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"other\":true}}\n\n",
            "data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"mine\":true}}\n\n",
        );
        let value = parse_http_body(body, 7).expect("parses");
        assert_eq!(value["result"]["mine"], true);
    }

    #[test]
    fn a_batch_body_yields_our_entry() {
        let body = r#"[{"jsonrpc":"2.0","id":1,"result":{}},{"jsonrpc":"2.0","id":7,"result":{"mine":true}}]"#;
        let value = parse_http_body(body, 7).expect("parses");
        assert_eq!(value["result"]["mine"], true);
    }

    #[test]
    fn a_body_that_is_not_json_rpc_is_an_error_not_an_empty_list() {
        let err = parse_http_body("<html>gateway timeout</html>", 7).unwrap_err();
        assert!(err.contains("could not be read"), "{err}");
    }

    /// An absolute path is taken as given — resolving it through a login shell
    /// would be a process start per server for no answer.
    #[test]
    fn an_absolute_command_is_not_resolved() {
        assert_eq!(resolve_command("/usr/bin/env"), "/usr/bin/env".to_string());
    }

    // -----------------------------------------------------------------------
    // Against a real process
    // -----------------------------------------------------------------------

    /// A minimal but honest MCP server: reads line-delimited JSON-RPC on stdin,
    /// answers `initialize`, paginates `tools/list`, and runs one tool.
    ///
    /// Written in Python because the framing bugs this is here to catch —
    /// buffering, line endings, a banner before the protocol, a notification
    /// arriving mid-stream — only happen against a separate process. A mocked
    /// transport would pass while the real thing deadlocked.
    const FAKE_SERVER: &str = r#"
import json, sys
# A banner on stdout before any protocol: real servers do this, and a client
# that treats the first line as JSON dies on it.
print("starting up", flush=True)
# And a word on stderr, which must be drained or a full pipe deadlocks us.
print("listening", file=sys.stderr, flush=True)

def send(msg):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    method, rid = req.get("method"), req.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fake", "version": "9.9"},
            "instructions": "be brief",
        }})
    elif method == "notifications/initialized":
        pass
    elif method == "tools/list":
        # An unsolicited notification first, to be skipped.
        send({"jsonrpc": "2.0", "method": "notifications/message", "params": {}})
        if req.get("params", {}).get("cursor") == "page2":
            send({"jsonrpc": "2.0", "id": rid, "result": {"tools": [
                {"name": "second", "inputSchema": {"type": "object"}}]}})
        else:
            send({"jsonrpc": "2.0", "id": rid, "result": {
                "tools": [{"name": "echo", "description": "says it back",
                           "inputSchema": {"type": "object",
                                           "properties": {"text": {"type": "string"}},
                                           "required": ["text"]}}],
                "nextCursor": "page2"}})
    elif method == "tools/call":
        args = req.get("params", {}).get("arguments", {})
        send({"jsonrpc": "2.0", "id": rid, "result": {
            "content": [{"type": "text", "text": args.get("text", "")}],
            "isError": False}})
    else:
        send({"jsonrpc": "2.0", "id": rid,
              "error": {"code": -32601, "message": "no such method"}})
"#;

    fn fake_spec() -> Option<LaunchSpec> {
        // Skipped rather than failed where there is no python3: this covers the
        // transport, and a machine without an interpreter is not evidence the
        // transport is broken.
        let python = resolve_command("python3");
        if !python.contains('/') {
            return None;
        }
        Some(LaunchSpec {
            key: "test:fake".into(),
            name: "fake".into(),
            transport: "stdio".into(),
            command: Some(python),
            args: vec!["-u".into(), "-c".into(), FAKE_SERVER.into()],
            url: None,
            env: BTreeMap::new(),
            cwd: None,
        })
    }

    #[tokio::test]
    async fn a_real_server_is_started_handshaken_and_listed() {
        let Some(spec) = fake_spec() else { return };
        let (mut conn, session) = open(&spec).await.expect("connects");

        assert_eq!(session.server_name.as_deref(), Some("fake"));
        assert_eq!(session.server_version.as_deref(), Some("9.9"));
        assert_eq!(session.protocol_version.as_deref(), Some("2025-06-18"));
        assert_eq!(session.instructions.as_deref(), Some("be brief"));
        assert_eq!(session.capabilities, ["tools"]);
        // Both pages, in order: stopping at `nextCursor` would silently show
        // half a server's tools.
        let names: Vec<&str> = session.tools.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["echo", "second"]);
        assert_eq!(
            session.tools[0].input_schema["properties"]["text"]["type"],
            "string"
        );

        let result = conn
            .request(
                "tools/call",
                json!({ "name": "echo", "arguments": { "text": "hello" } }),
                CALL_TIMEOUT,
            )
            .await
            .expect("calls");
        assert_eq!(result["content"][0]["text"], "hello");
    }

    /// A tool the server rejects must surface as a failed call, not as an empty
    /// result the user reads as success.
    #[tokio::test]
    async fn a_jsonrpc_error_is_reported_rather_than_swallowed() {
        let Some(spec) = fake_spec() else { return };
        let (mut conn, _) = open(&spec).await.expect("connects");
        let err = conn
            .request("nonsense/method", json!({}), CALL_TIMEOUT)
            .await
            .unwrap_err();
        assert!(err.contains("no such method"), "{err}");
        assert!(err.contains("-32601"), "{err}");
    }

    /// The diagnostic that makes a broken server fixable: what it printed
    /// before it gave up.
    #[tokio::test]
    async fn a_server_that_dies_reports_what_it_said_on_stderr() {
        let python = resolve_command("python3");
        if !python.contains('/') {
            return;
        }
        let spec = LaunchSpec {
            key: "test:dies".into(),
            name: "dies".into(),
            transport: "stdio".into(),
            command: Some(python),
            args: vec![
                "-u".into(),
                "-c".into(),
                "import sys; print('BROWSERBASE_API_KEY is required', file=sys.stderr); sys.exit(1)"
                    .into(),
            ],
            url: None,
            env: BTreeMap::new(),
            cwd: None,
        };
        let err = match open(&spec).await {
            Ok(_) => panic!("a server that exits immediately must not connect"),
            Err(e) => e,
        };
        assert!(err.contains("closed its output"), "{err}");
        assert!(err.contains("BROWSERBASE_API_KEY is required"), "{err}");
    }
}

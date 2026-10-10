//! A daemon on temp sockets, a fake runner, and an in-memory relay.
#![allow(dead_code)]

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use canopy_service::harness::CoreHarness;
use canopy_service::http::{unix_open, unix_request};
use canopy_service::relay::crypto::Envelope;
use canopy_service::relay::transport::{DirectoryDevice, PollRow, RelayTransport, TransportError};
use canopy_service::{Config, Running, StartOptions};
use futures_util::future::BoxFuture;
use http_body_util::BodyExt;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const RUNNER_TOKEN: &str = "runner-test-token";

#[derive(Clone, Debug)]
pub struct Write {
    pub at: Instant,
    pub session: u64,
    pub data: String,
    pub expect_pid: Option<u64>,
}

#[derive(Default)]
pub struct RunnerState {
    /// (session id, pid, exited)
    pub sessions: Mutex<Vec<(u64, u32, bool)>>,
    pub writes: Mutex<Vec<Write>>,
    pub browser: Mutex<Vec<serde_json::Value>>,
}

pub struct FakeRunner {
    pub url: String,
    pub state: Arc<RunnerState>,
}

fn authorized(headers: &HeaderMap) -> bool {
    headers.get("authorization").and_then(|v| v.to_str().ok())
        == Some(&format!("Bearer {RUNNER_TOKEN}"))
}

impl FakeRunner {
    pub async fn start() -> Self {
        let state = Arc::new(RunnerState::default());
        let app = Router::new()
            .route(
                "/sessions",
                get(
                    |State(s): State<Arc<RunnerState>>, headers: HeaderMap| async move {
                        if !authorized(&headers) {
                            return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({})));
                        }
                        let list: Vec<serde_json::Value> = s
                            .sessions
                            .lock()
                            .unwrap()
                            .iter()
                            .map(|(id, pid, exited)| {
                                serde_json::json!({
                                    "id": id, "pid": pid,
                                    "exitCode": if *exited { serde_json::json!(0) } else { serde_json::Value::Null }
                                })
                            })
                            .collect();
                        (StatusCode::OK, Json(serde_json::json!(list)))
                    },
                ),
            )
            .route(
                "/sessions/:id/input",
                post(
                    |State(s): State<Arc<RunnerState>>,
                     Path(id): Path<u64>,
                     headers: HeaderMap,
                     Json(body): Json<serde_json::Value>| async move {
                        if !authorized(&headers) {
                            return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error":"Unauthorized"})));
                        }
                        let live = s
                            .sessions
                            .lock()
                            .unwrap()
                            .iter()
                            .find(|(sid, _, exited)| *sid == id && !exited)
                            .map(|(_, pid, _)| *pid);
                        let Some(pid) = live else {
                            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error":"Session not running"})));
                        };
                        let expect = body.get("expectPid").and_then(|v| v.as_u64());
                        if body.get("expectPid").is_some() && expect != Some(pid as u64) {
                            return (StatusCode::CONFLICT, Json(serde_json::json!({"error":"Terminal generation changed","pid":pid})));
                        }
                        s.writes.lock().unwrap().push(Write {
                            at: Instant::now(),
                            session: id,
                            data: body["data"].as_str().unwrap_or_default().to_string(),
                            expect_pid: expect,
                        });
                        (StatusCode::OK, Json(serde_json::json!({"ok": true})))
                    },
                ),
            )
            .route(
                "/browser",
                post(
                    |State(s): State<Arc<RunnerState>>, Json(body): Json<serde_json::Value>| async move {
                        s.browser.lock().unwrap().push(body.clone());
                        Json(serde_json::json!({ "url": "http://localhost:3000/", "title": "ok", "echo": body }))
                    },
                ),
            )
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self { url, state }
    }

    pub fn add_session(&self, id: u64, pid: u32) {
        self.state.sessions.lock().unwrap().push((id, pid, false));
    }

    pub fn writes_to(&self, session: u64) -> Vec<Write> {
        self.state
            .writes
            .lock()
            .unwrap()
            .iter()
            .filter(|w| w.session == session)
            .cloned()
            .collect()
    }
}

#[derive(Default)]
pub struct RelayState {
    pub queue: Mutex<Vec<PollRow>>,
    pub acked: Mutex<Vec<String>>,
    pub directory: Mutex<Vec<DirectoryDevice>>,
    pub relayed: Mutex<Vec<(String, Envelope)>>,
}

#[derive(Clone, Default)]
pub struct FakeRelay(pub Arc<RelayState>);

impl RelayTransport for FakeRelay {
    fn poll<'a>(
        &'a self,
        _workspace: &'a str,
        _device: &'a str,
    ) -> BoxFuture<'a, Result<Vec<PollRow>, TransportError>> {
        Box::pin(async move {
            let acked = self.0.acked.lock().unwrap().clone();
            Ok(self
                .0
                .queue
                .lock()
                .unwrap()
                .iter()
                .filter(|r| !acked.contains(&r.id))
                .cloned()
                .collect())
        })
    }
    fn ack<'a>(
        &'a self,
        _workspace: &'a str,
        _device: &'a str,
        ids: Vec<String>,
    ) -> BoxFuture<'a, Result<(), TransportError>> {
        Box::pin(async move {
            self.0.acked.lock().unwrap().extend(ids);
            Ok(())
        })
    }
    fn directory<'a>(
        &'a self,
        _workspace: &'a str,
        _device: &'a str,
        _team: &'a str,
    ) -> BoxFuture<'a, Result<Vec<DirectoryDevice>, TransportError>> {
        Box::pin(async move { Ok(self.0.directory.lock().unwrap().clone()) })
    }
    fn relay<'a>(
        &'a self,
        _workspace: &'a str,
        _device: &'a str,
        _team: &'a str,
        recipient: &'a str,
        envelope: &'a Envelope,
    ) -> BoxFuture<'a, Result<(), TransportError>> {
        Box::pin(async move {
            self.0
                .relayed
                .lock()
                .unwrap()
                .push((recipient.to_string(), envelope.clone()));
            Ok(())
        })
    }
}

pub struct Daemon {
    pub dir: tempfile::TempDir,
    pub running: Option<Running>,
    pub relay: FakeRelay,
}

pub fn short_tempdir() -> tempfile::TempDir {
    // Unix socket paths are capped near 104 bytes on macOS.
    tempfile::Builder::new()
        .prefix("cs")
        .tempdir_in("/tmp")
        .unwrap()
}

impl Daemon {
    pub async fn start() -> Self {
        let dir = short_tempdir();
        let relay = FakeRelay::default();
        let mut daemon = Self {
            dir,
            running: None,
            relay,
        };
        daemon.boot().await;
        daemon
    }

    pub fn config(&self) -> Config {
        Config::new(self.dir.path().join("state"), self.dir.path().join("run"))
    }

    pub async fn boot(&mut self) {
        let running = canopy_service::start(
            self.config(),
            StartOptions {
                harness: Arc::new(CoreHarness::default()),
                relay: Some(Arc::new(self.relay.clone())),
                relay_loop: false,
            },
        )
        .await
        .unwrap();
        self.running = Some(running);
    }

    pub async fn restart(&mut self) {
        if let Some(running) = self.running.take() {
            running.shutdown().await;
        }
        self.boot().await;
    }

    pub fn service(&self) -> &Arc<canopy_service::Service> {
        &self.running.as_ref().unwrap().service
    }

    pub fn admin_socket(&self) -> PathBuf {
        self.dir.path().join("run/admin.sock")
    }

    pub fn agent_socket(&self, ws: &str) -> PathBuf {
        self.dir.path().join("run/ws").join(ws).join("ctx.sock")
    }

    pub async fn admin(
        &self,
        method: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> (u16, serde_json::Value) {
        call(&self.admin_socket(), method, path, None, body).await
    }

    pub async fn agent(
        &self,
        ws: &str,
        token: &str,
        method: &str,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> (u16, serde_json::Value) {
        call(&self.agent_socket(ws), method, path, Some(token), body).await
    }

    pub async fn register(&self, ws: &str, runner: Option<&FakeRunner>) {
        let (status, body) = self
            .admin(
                "PUT",
                &format!("/admin/workspaces/{ws}"),
                Some(serde_json::json!({
                    "name": "demo",
                    "ownerUserId": "owner",
                    "runnerUrl": runner.map(|r| r.url.clone()),
                    "runnerToken": runner.map(|_| RUNNER_TOKEN),
                })),
            )
            .await;
        assert_eq!(status, 200, "{body}");
    }

    /// Mint and bind a terminal to a fake runner session. Returns the token
    /// and the service's pty id.
    pub async fn terminal(
        &self,
        ws: &str,
        runner: &FakeRunner,
        request: &str,
        name: &str,
        session: u64,
        pid: u32,
    ) -> (String, u32) {
        let (status, minted) = self
            .admin(
                "POST",
                &format!("/admin/workspaces/{ws}/terminals"),
                Some(serde_json::json!({ "requestId": request, "agent": "claude", "name": name })),
            )
            .await;
        assert_eq!(status, 200, "{minted}");
        runner.add_session(session, pid);
        let (status, body) = self
            .admin(
                "POST",
                &format!("/admin/workspaces/{ws}/terminals/{request}/bind"),
                Some(serde_json::json!({ "sessionId": session, "pid": pid })),
            )
            .await;
        assert_eq!(status, 200, "{body}");
        assert_eq!(minted["ptyId"], 0);
        assert_eq!(body["ptyId"], session);
        (
            minted["token"].as_str().unwrap().to_string(),
            body["ptyId"].as_u64().unwrap() as u32,
        )
    }
}

pub async fn call(
    socket: &FsPath,
    method: &str,
    path: &str,
    token: Option<&str>,
    body: Option<serde_json::Value>,
) -> (u16, serde_json::Value) {
    let auth = token.map(|t| format!("Bearer {t}"));
    let mut headers = Vec::new();
    if let Some(auth) = auth.as_deref() {
        headers.push(("authorization", auth));
    }
    let (status, bytes) = unix_request(
        socket,
        method,
        path,
        &headers,
        body.map(|b| b.to_string().into_bytes()),
    )
    .await
    .unwrap();
    let value = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(&bytes).into()));
    (status, value)
}

pub async fn wait_until(what: &str, timeout: Duration, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + timeout;
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// An SSE reader over the admin socket.
pub struct Sse {
    body: hyper::body::Incoming,
    buffer: String,
}

impl Sse {
    pub async fn open(socket: &FsPath, path: &str) -> Self {
        let response = unix_open(socket, "GET", path, &[], None).await.unwrap();
        assert_eq!(response.status().as_u16(), 200);
        Self {
            body: response.into_body(),
            buffer: String::new(),
        }
    }

    /// Next `(event, data)`, skipping keep-alive comments.
    pub async fn next(&mut self) -> (String, serde_json::Value) {
        loop {
            if let Some(end) = self.buffer.find("\n\n") {
                let frame: String = self.buffer[..end].to_string();
                self.buffer.drain(..end + 2);
                let mut event = "message".to_string();
                let mut data = String::new();
                for line in frame.lines() {
                    if let Some(v) = line.strip_prefix("event:") {
                        event = v.trim().to_string();
                    } else if let Some(v) = line.strip_prefix("data:") {
                        data.push_str(v.trim_start());
                    }
                }
                if data.is_empty() {
                    continue;
                }
                return (event, serde_json::from_str(&data).unwrap_or_default());
            }
            let frame = tokio::time::timeout(Duration::from_secs(5), self.body.frame())
                .await
                .expect("an SSE event within 5 s")
                .expect("the stream is open")
                .unwrap();
            if let Ok(data) = frame.into_data() {
                self.buffer.push_str(&String::from_utf8_lossy(&data));
            }
        }
    }
}

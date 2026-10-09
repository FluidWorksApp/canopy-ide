//! The daemon: workspace registry, sockets, recovery and the relay loop.

use crate::agent::{self, AgentState};
use crate::config::Config;
use crate::harness::{Harness, HarnessStore};
use crate::http::{bind_unix, serve, SocketServer};
use crate::relay::device::DeviceKeys;
use crate::relay::transport::{HttpTransport, RelayTransport};
use crate::stream::EventLog;
use crate::terminals::UNBOUND_TTL_MS;
use crate::util::{create_dir_mode, now_ms, random_hex, write_private};
use crate::workspace::{Registration, Workspace};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

pub struct Service {
    pub config: Config,
    pub epoch: String,
    pub device: DeviceKeys,
    pub harness: Arc<dyn Harness>,
    pub http: reqwest::Client,
    pub relay: Option<Arc<dyn RelayTransport>>,
    workspaces: RwLock<HashMap<String, Arc<Workspace>>>,
    /// One event log per workspace id for the life of the process, so a
    /// re-registration keeps subscribers' cursors meaningful.
    logs: Mutex<HashMap<String, Arc<EventLog>>>,
    /// Serialises registration changes (and their socket work).
    registry_lock: tokio::sync::Mutex<()>,
}

pub struct Running {
    pub service: Arc<Service>,
    admin: Option<SocketServer>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Running {
    pub async fn shutdown(mut self) {
        for task in self.tasks.drain(..) {
            task.abort();
        }
        if let Some(admin) = self.admin.take() {
            admin.close().await;
        }
        let all: Vec<Arc<Workspace>> = self
            .service
            .workspaces
            .read()
            .unwrap()
            .values()
            .cloned()
            .collect();
        for ws in all {
            ws.close().await;
        }
    }
}

pub struct StartOptions {
    pub harness: Arc<dyn Harness>,
    /// Overrides the HTTP relay transport (tests inject one; None with no
    /// relay URL configured disables the relay).
    pub relay: Option<Arc<dyn RelayTransport>>,
    /// Run the relay poll loop. Tests drive `relay_once` directly instead.
    pub relay_loop: bool,
}

impl Service {
    pub fn admin_socket(&self) -> std::path::PathBuf {
        self.config.run_dir.join("admin.sock")
    }

    pub fn agent_socket_dir(&self, ws: &str) -> std::path::PathBuf {
        self.config.run_dir.join("ws").join(ws)
    }

    pub fn workspace(&self, id: &str) -> Option<Arc<Workspace>> {
        self.workspaces.read().unwrap().get(id).cloned()
    }

    pub fn workspace_ids(&self) -> Vec<String> {
        self.workspaces.read().unwrap().keys().cloned().collect()
    }

    fn log_for(&self, id: &str) -> Arc<EventLog> {
        self.logs
            .lock()
            .unwrap()
            .entry(id.to_string())
            .or_insert_with(|| Arc::new(EventLog::new(self.epoch.clone())))
            .clone()
    }

    fn persist_registrations(&self) -> Result<(), String> {
        let map: HashMap<String, Registration> = self
            .workspaces
            .read()
            .unwrap()
            .iter()
            .map(|(id, ws)| (id.clone(), ws.registration.read().unwrap().clone()))
            .collect();
        let bytes = serde_json::to_vec_pretty(&map).map_err(|e| e.to_string())?;
        write_private(
            &self.config.state_dir.join("workspaces.json"),
            &bytes,
            0o600,
        )
        .map_err(|e| e.to_string())
    }

    /// Create or update a registration and make sure its socket is open.
    /// Idempotent: the gateway re-PUTs every 30 s to heal a restart.
    pub async fn register(
        self: &Arc<Self>,
        id: &str,
        registration: Registration,
    ) -> Result<std::path::PathBuf, String> {
        let _guard = self.registry_lock.lock().await;
        let existing = self.workspace(id);
        let ws = match existing {
            Some(ws) => {
                if ws.update_registration(registration) {
                    self.spawn_reconcile(&ws);
                    ws.recover_deliveries();
                }
                ws
            }
            None => {
                let ws =
                    Workspace::open(&self.config.state_dir, id, registration, self.log_for(id))?;
                self.workspaces
                    .write()
                    .unwrap()
                    .insert(id.to_string(), ws.clone());
                self.activate(&ws);
                ws
            }
        };
        self.persist_registrations()?;
        self.open_socket(&ws).await?;
        Ok(self.agent_socket_dir(id))
    }

    /// Close the agent socket and forget the registration. Stores and the
    /// socket directory (which containers bind) are kept.
    pub async fn unregister(&self, id: &str) -> Result<bool, String> {
        let _guard = self.registry_lock.lock().await;
        let removed = self.workspaces.write().unwrap().remove(id);
        let Some(ws) = removed else {
            return Ok(false);
        };
        ws.close().await;
        self.persist_registrations()?;
        Ok(true)
    }

    async fn open_socket(self: &Arc<Self>, ws: &Arc<Workspace>) -> Result<(), String> {
        let mut socket = ws.socket.lock().await;
        if socket.is_some() {
            return Ok(());
        }
        let dir = self.agent_socket_dir(&ws.id);
        create_dir_mode(&dir, 0o755).map_err(|e| format!("{}: {e}", dir.display()))?;
        let path = dir.join("ctx.sock");
        let listener = bind_unix(&path, 0o666).map_err(|e| format!("{}: {e}", path.display()))?;
        let router = agent::router(AgentState {
            service: self.clone(),
            workspace: ws.clone(),
        });
        *socket = Some(serve(listener, path, router));
        Ok(())
    }

    /// Background work every open workspace runs: question expiry, runner
    /// reconciliation and recovery of interrupted deliveries.
    fn activate(self: &Arc<Self>, ws: &Arc<Workspace>) {
        let sweeper = {
            let ws = ws.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    ws.attention.expire_due(now_ms());
                }
            })
        };
        ws.spawn_background(sweeper);
        self.spawn_reconcile(ws);
        ws.recover_deliveries();
        crate::relay::resume_admitted(ws);
    }

    fn spawn_reconcile(self: &Arc<Self>, ws: &Arc<Workspace>) {
        let service = self.clone();
        let ws_task = ws.clone();
        ws.spawn_background(tokio::spawn(async move {
            let mut delay = Duration::from_millis(500);
            loop {
                match service.reconcile(&ws_task).await {
                    Ok(()) => return,
                    Err(error) => {
                        eprintln!("canopy-serviced: {}: runner reconcile: {error}", ws_task.id);
                    }
                }
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(30));
            }
        }));
    }

    /// Keep only credentials whose runner session still lives with the same
    /// child pid. Identities are never taken from an agent; the runner's own
    /// session list is the evidence.
    pub async fn reconcile(&self, ws: &Arc<Workspace>) -> Result<(), String> {
        let endpoint = ws.runner.read().unwrap().clone();
        let now = now_ms();
        let Some(url) = endpoint.url else {
            return Ok(());
        };
        let mut request = self
            .http
            .get(format!("{}/sessions", url.trim_end_matches('/')))
            .timeout(Duration::from_secs(5));
        if let Some(token) = endpoint.token.as_deref() {
            request = request.bearer_auth(token);
        }
        let response = request.send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("runner answered {}", response.status()));
        }
        let sessions: Vec<serde_json::Value> = response.json_value().await?;
        for record in ws.terminals.all().into_iter().filter(|t| t.live()) {
            let keep = match (record.session_id, record.pid) {
                (Some(session), Some(pid)) => sessions.iter().any(|s| {
                    s.get("id").and_then(|v| v.as_u64()) == Some(session)
                        && s.get("pid").and_then(|v| v.as_u64()) == Some(pid as u64)
                        && s.get("exitCode").is_none_or(|v| v.is_null())
                }),
                _ => now.saturating_sub(record.minted_ms) < UNBOUND_TTL_MS,
            };
            if !keep {
                ws.revoke_terminal(&record.request_id, "reconcile");
            }
        }
        Ok(())
    }

    /// The stores a stream snapshot carries, in the same item shapes the
    /// query route lists.
    pub fn snapshot_stores(&self, ws: &Workspace) -> serde_json::Value {
        let ctx = ws.harness_context();
        let harness = |store| match self.harness.snapshot(&ctx, store) {
            serde_json::Value::Null => serde_json::json!([]),
            other => other,
        };
        serde_json::json!({
            "mesh": ws.mesh.all(),
            "notes": harness(HarnessStore::Notes),
            "research": harness(HarnessStore::Research),
            "attention": ws.attention.list(),
        })
    }

    pub async fn relay_once(self: &Arc<Self>) {
        let Some(transport) = self.relay.clone() else {
            return;
        };
        for id in self.workspace_ids() {
            if let Some(ws) = self.workspace(&id) {
                crate::relay::poll_workspace(self, &ws, transport.as_ref()).await;
                crate::relay::flush_outbox(self, &ws, transport.as_ref()).await;
            }
        }
    }
}

trait JsonValue {
    async fn json_value(self) -> Result<Vec<serde_json::Value>, String>;
}

impl JsonValue for reqwest::Response {
    async fn json_value(self) -> Result<Vec<serde_json::Value>, String> {
        let bytes = self.bytes().await.map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())
    }
}

/// Start the daemon. The admin socket is created last, once every registered
/// workspace is open, so its appearance means ready (the unit waits for it).
pub async fn start(config: Config, options: StartOptions) -> Result<Running, String> {
    create_dir_mode(&config.state_dir, 0o700)
        .map_err(|e| format!("{}: {e}", config.state_dir.display()))?;
    std::fs::create_dir_all(&config.run_dir)
        .map_err(|e| format!("{}: {e}", config.run_dir.display()))?;
    create_dir_mode(&config.run_dir.join("ws"), 0o755).map_err(|e| e.to_string())?;
    let device = DeviceKeys::load_or_create(&config.state_dir.join("device.json"))?;
    let relay: Option<Arc<dyn RelayTransport>> = match options.relay {
        Some(relay) => Some(relay),
        None => config.relay_url.as_ref().map(|url| {
            Arc::new(HttpTransport::new(url.clone(), config.relay_dir.clone()))
                as Arc<dyn RelayTransport>
        }),
    };
    let service = Arc::new(Service {
        epoch: random_hex(8),
        device,
        harness: options.harness,
        http: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?,
        relay,
        workspaces: RwLock::new(HashMap::new()),
        logs: Mutex::new(HashMap::new()),
        registry_lock: tokio::sync::Mutex::new(()),
        config,
    });
    let saved: HashMap<String, Registration> =
        std::fs::read(service.config.state_dir.join("workspaces.json"))
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default();
    for (id, registration) in saved {
        if !crate::util::valid_workspace_id(&id) {
            continue;
        }
        if let Err(error) = service.register(&id, registration).await {
            eprintln!("canopy-serviced: workspace {id}: {error}");
        }
    }
    let mut tasks = Vec::new();
    if options.relay_loop && service.relay.is_some() {
        let svc = service.clone();
        tasks.push(tokio::spawn(async move {
            loop {
                tokio::time::sleep(svc.config.relay_poll).await;
                svc.relay_once().await;
            }
        }));
    }
    let admin_path = service.admin_socket();
    let listener =
        bind_unix(&admin_path, 0o660).map_err(|e| format!("{}: {e}", admin_path.display()))?;
    let admin = serve(listener, admin_path, crate::admin::router(service.clone()));
    Ok(Running {
        service,
        admin: Some(admin),
        tasks,
    })
}

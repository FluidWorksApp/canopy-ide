//! Terminal credentials and the runner-backed `Terminals` implementation.
//!
//! The gateway mints a credential before it spawns an agent and binds it to
//! the runner's session id and child pid afterwards. The credential is the
//! caller's identity: nothing in a request body can name another terminal.
//! Only a SHA-256 of each credential is stored, so the state file cannot be
//! replayed as a token, yet a restarted service still recognises live agents.

use crate::util::{constant_time_eq, now_ms, random_hex, sha256_hex, write_private};
use canopy_core::terminals::{TerminalTarget, Terminals};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

/// Every cloud agent runs in the workspace container's project root.
pub const WORKSPACE_ROOT: &str = "/workspace";
/// Ended terminals kept for the IDE's history.
const MAX_ENDED: usize = 200;
/// A credential never bound to a session is abandoned after this long.
pub const UNBOUND_TTL_MS: u64 = 10 * 60 * 1000;
pub const RUNNER_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// Prefix on terminal errors that mean "the runner is not registered yet",
/// which callers answer as 503 not-ready rather than a 4xx.
pub const NOT_READY: &str = "not-ready: ";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRecord {
    pub request_id: String,
    #[serde(default)]
    pub token_sha256: String,
    pub pty_id: u32,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub session_id: Option<u64>,
    #[serde(default)]
    pub pid: Option<u32>,
    pub minted_ms: u64,
    #[serde(default)]
    pub bound_ms: Option<u64>,
    #[serde(default)]
    pub revoked_ms: Option<u64>,
    #[serde(default)]
    pub revoked_by: Option<String>,
    /// Live working status from `task_named`: title, description, icon, tags.
    #[serde(default)]
    pub status: Option<serde_json::Value>,
    /// `job_done`'s outcome, for the gateway to settle a micro-task.
    #[serde(default)]
    pub job_done: Option<serde_json::Value>,
    /// `close_session` asked; the gateway owns stopping the session.
    #[serde(default)]
    pub close_requested_ms: Option<u64>,
}

impl TerminalRecord {
    pub fn live(&self) -> bool {
        self.revoked_ms.is_none()
    }

    /// The identity claims and mesh history key on.
    pub fn key(&self, instance: &str) -> String {
        format!("pty:{instance}:{}", self.pty_id)
    }

    /// The record as the IDE and gateway see it: never the credential hash.
    pub fn view(&self) -> serde_json::Value {
        let mut value = serde_json::to_value(self).unwrap_or_default();
        if let Some(object) = value.as_object_mut() {
            object.remove("tokenSha256");
        }
        value
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalFile {
    terminals: Vec<TerminalRecord>,
}

pub struct MintRequest {
    pub request_id: String,
    pub agent: Option<String>,
    pub name: Option<String>,
    pub task: Option<String>,
}

pub fn valid_request_id(id: &str) -> bool {
    (8..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b':' || b == b'-')
}

pub struct TerminalRegistry {
    path: PathBuf,
    inner: Mutex<TerminalFile>,
    pub instance: String,
}

impl TerminalRegistry {
    pub fn open(path: PathBuf, instance: String) -> Self {
        let file = std::fs::read(&path)
            .ok()
            .and_then(|raw| serde_json::from_slice::<TerminalFile>(&raw).ok())
            .unwrap_or_default();
        Self {
            path,
            inner: Mutex::new(file),
            instance,
        }
    }

    fn persist(&self, file: &TerminalFile) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
        write_private(&self.path, &bytes, 0o600).map_err(|e| format!("terminal state: {e}"))
    }

    /// Mint (or, for a retried request id that never bound, re-mint) the
    /// credential a spawn will carry. Its pty id is 0 until bind adopts the
    /// runner's session id, the number the agent's CANOPY_PTY and the IDE use.
    pub fn mint(&self, request: MintRequest) -> Result<(String, TerminalRecord), (u16, String)> {
        if !valid_request_id(&request.request_id) {
            return Err((400, "requestId must be 8-128 of [A-Za-z0-9:-]".into()));
        }
        let token = random_hex(32);
        let hash = sha256_hex(token.as_bytes());
        let mut file = self.inner.lock().unwrap();
        let record = match file
            .terminals
            .iter_mut()
            .find(|t| t.request_id == request.request_id)
        {
            Some(existing) if existing.revoked_ms.is_some() => {
                return Err((409, "that terminal has already exited".into()))
            }
            Some(existing) if existing.session_id.is_some() => {
                return Err((409, "that terminal is already bound to a session".into()))
            }
            Some(existing) => {
                existing.token_sha256 = hash;
                existing.agent = request.agent;
                existing.name = request.name;
                existing.task = request.task;
                existing.clone()
            }
            None => {
                let record = TerminalRecord {
                    request_id: request.request_id,
                    token_sha256: hash,
                    pty_id: 0,
                    agent: request.agent,
                    name: request.name,
                    task: request.task,
                    session_id: None,
                    pid: None,
                    minted_ms: now_ms(),
                    bound_ms: None,
                    revoked_ms: None,
                    revoked_by: None,
                    status: None,
                    job_done: None,
                    close_requested_ms: None,
                };
                file.terminals.push(record.clone());
                record
            }
        };
        self.persist(&file).map_err(|e| (500, e))?;
        Ok((token, record))
    }

    pub fn bind(
        &self,
        request_id: &str,
        session_id: u64,
        pid: u32,
    ) -> Result<TerminalRecord, (u16, String)> {
        let mut file = self.inner.lock().unwrap();
        let record = file
            .terminals
            .iter_mut()
            .find(|t| t.request_id == request_id)
            .ok_or((404, "no terminal credential for that requestId".to_string()))?;
        if record.revoked_ms.is_some() {
            return Err((409, "that terminal credential was revoked".into()));
        }
        match (record.session_id, record.pid) {
            (Some(s), Some(p)) if s == session_id && p == pid => return Ok(record.clone()),
            (Some(_), _) => return Err((409, "that terminal is bound to another session".into())),
            _ => {}
        }
        record.pty_id = u32::try_from(session_id)
            .ok()
            .filter(|id| *id > 0)
            .ok_or((400, "sessionId must be a positive 32-bit id".to_string()))?;
        record.session_id = Some(session_id);
        record.pid = Some(pid);
        record.bound_ms = Some(now_ms());
        let out = record.clone();
        self.persist(&file).map_err(|e| (500, e))?;
        Ok(out)
    }

    /// End a credential. Returns the record when this call ended it.
    pub fn revoke(&self, request_id: &str, how: &str) -> Option<TerminalRecord> {
        let mut file = self.inner.lock().unwrap();
        let record = file
            .terminals
            .iter_mut()
            .find(|t| t.request_id == request_id && t.revoked_ms.is_none())?;
        record.revoked_ms = Some(now_ms());
        record.revoked_by = Some(how.into());
        let out = record.clone();
        let ended = file.terminals.iter().filter(|t| !t.live()).count();
        if ended > MAX_ENDED {
            let mut drop = ended - MAX_ENDED;
            file.terminals.retain(|t| {
                if drop > 0 && !t.live() {
                    drop -= 1;
                    return false;
                }
                true
            });
        }
        if let Err(error) = self.persist(&file) {
            eprintln!("canopy-serviced: {error}");
        }
        Some(out)
    }

    pub fn identify(&self, token: &str) -> Option<TerminalRecord> {
        let hash = sha256_hex(token.as_bytes());
        self.inner
            .lock()
            .unwrap()
            .terminals
            .iter()
            .find(|t| t.live() && constant_time_eq(&t.token_sha256, &hash))
            .cloned()
    }

    pub fn by_pty(&self, pty_id: u32) -> Option<TerminalRecord> {
        self.inner
            .lock()
            .unwrap()
            .terminals
            .iter()
            .find(|t| t.pty_id == pty_id && t.session_id.is_some() && t.live())
            .cloned()
    }

    /// The display name an agent addresses another by, case-insensitively,
    /// among live terminals of this workspace only.
    pub fn by_name(&self, name: &str) -> Result<TerminalRecord, String> {
        let wanted = name.trim();
        let file = self.inner.lock().unwrap();
        let matches: Vec<&TerminalRecord> = file
            .terminals
            .iter()
            .filter(|t| t.live() && t.session_id.is_some())
            .filter(|t| {
                t.name
                    .as_deref()
                    .is_some_and(|n| n.trim().eq_ignore_ascii_case(wanted))
            })
            .collect();
        match matches.as_slice() {
            [one] => Ok((*one).clone()),
            [] => Err(format!(
                "No live agent named \"{wanted}\" in this workspace (see canopy_agents)"
            )),
            _ => Err(format!(
                "More than one live agent is named \"{wanted}\" — address it by ptyId"
            )),
        }
    }

    pub fn all(&self) -> Vec<TerminalRecord> {
        self.inner.lock().unwrap().terminals.clone()
    }

    pub fn update(&self, pty_id: u32, f: impl FnOnce(&mut TerminalRecord)) -> bool {
        let mut file = self.inner.lock().unwrap();
        let Some(record) = file
            .terminals
            .iter_mut()
            .find(|t| t.pty_id == pty_id && t.session_id.is_some() && t.live())
        else {
            return false;
        };
        f(record);
        if let Err(error) = self.persist(&file) {
            eprintln!("canopy-serviced: {error}");
        }
        true
    }
}

/// Where the workspace's runner is, as last registered. `url` is None while the
/// gateway has registered the workspace but not yet started its container.
#[derive(Clone, Debug, Default)]
pub struct RunnerEndpoint {
    pub url: Option<String>,
    pub token: Option<String>,
}

/// `Terminals` over the runner's `POST /sessions/{id}/input {data, expectPid}`.
/// The child pid is the generation: the runner refuses a write with 409 when
/// the live child differs, and the registry refuses one for an ended
/// credential, so a recycled session id never receives the second write.
pub struct RunnerTerminals {
    pub registry: Arc<TerminalRegistry>,
    pub runner: Arc<RwLock<RunnerEndpoint>>,
}

impl Terminals for RunnerTerminals {
    fn resolve(&self, id: u32) -> Result<TerminalTarget, String> {
        if self.runner.read().unwrap().url.is_none() {
            return Err(format!(
                "{NOT_READY}this workspace's container is not running yet"
            ));
        }
        let record = self.registry.by_pty(id).ok_or_else(|| {
            format!("No running Canopy terminal with id {id} (see canopy_agents)")
        })?;
        match record.pid {
            Some(pid) if record.session_id.is_some() => Ok(TerminalTarget {
                id,
                instance: self.registry.instance.clone(),
                generation: pid as u64,
            }),
            _ => Err(format!(
                "Canopy can't yet tell what terminal {id} is running, so it won't type into it. \
                 If it has only just started, try again in a moment."
            )),
        }
    }

    fn write(&self, target: &TerminalTarget, data: &str) -> Result<(), String> {
        if target.instance != self.registry.instance {
            return Err("terminal belongs to another workspace".into());
        }
        let record = self
            .registry
            .by_pty(target.id)
            .filter(|r| r.pid.map(u64::from) == Some(target.generation))
            .ok_or_else(|| format!("terminal {} was replaced or has exited", target.id))?;
        let session = record.session_id.ok_or("terminal is not bound")?;
        let endpoint = self.runner.read().unwrap().clone();
        let url = endpoint
            .url
            .ok_or_else(|| format!("{NOT_READY}this workspace's container is not running"))?;
        let body = serde_json::json!({ "data": data, "expectPid": target.generation });
        let call = || {
            crate::http::blocking_post(
                &url,
                &format!("/sessions/{session}/input"),
                endpoint.token.as_deref(),
                body.to_string().as_bytes(),
                RUNNER_WRITE_TIMEOUT,
            )
        };
        // Core's `finish` calls this from async code. On a runtime worker,
        // hand the worker's queued tasks to others first, or a task parked in
        // its slot (the runner's own connection, in-process) waits on us.
        let on_worker = tokio::runtime::Handle::try_current()
            .is_ok_and(|h| h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread);
        let (status, text) = if on_worker {
            tokio::task::block_in_place(call)?
        } else {
            call()?
        };
        match status {
            200..=299 => Ok(()),
            409 => Err(format!("terminal {} was replaced", target.id)),
            _ => Err(format!(
                "the runner refused the write ({status}): {}",
                text.chars().take(200).collect::<String>()
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mint(registry: &TerminalRegistry, id: &str) -> (String, TerminalRecord) {
        registry
            .mint(MintRequest {
                request_id: id.into(),
                agent: Some("claude".into()),
                name: Some("Ada".into()),
                task: None,
            })
            .ok()
            .unwrap()
    }

    #[test]
    fn credentials_identify_until_revoked_and_survive_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("terminals.json");
        let registry = TerminalRegistry::open(path.clone(), "remote-w".into());
        let (token, record) = mint(&registry, "req-00001");
        let (other, second) = mint(&registry, "req-00002");
        assert_eq!((record.pty_id, second.pty_id), (0, 0));
        assert!(registry.by_pty(0).is_none());
        assert_eq!(
            registry.identify(&token).unwrap().request_id,
            record.request_id
        );
        assert!(registry.identify("not-a-token").is_none());
        assert_eq!(registry.bind("req-00001", 7, 4242).ok().unwrap().pty_id, 7);
        assert_eq!(registry.by_pty(7).unwrap().request_id, "req-00001");
        assert!(registry.bind("req-00001", 8, 1).is_err());
        assert!(!std::fs::read_to_string(&path).unwrap().contains(&token));

        let reopened = TerminalRegistry::open(path, "remote-w".into());
        assert_eq!(reopened.identify(&token).unwrap().session_id, Some(7));
        reopened.revoke("req-00001", "exit").unwrap();
        assert!(reopened.identify(&token).is_none());
        assert!(reopened.identify(&other).is_some());
        assert!(reopened.by_pty(7).is_none());
        assert!(reopened.bind("req-00002", 0, 1).is_err());
    }
}

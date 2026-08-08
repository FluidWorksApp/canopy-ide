//! Native terminal resource accounting and grant policy.
//!
//! This module deliberately stops at measurement and allowance management. It
//! does not itself signal a process or manipulate platform controls. The
//! containment backend may add a verified cgroup soft limit or a Windows job
//! notification threshold without changing this policy state machine.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;
const WARN_NUM: u64 = 75;
const REQUEST_NUM: u64 = 90;
const CLEAR_NUM: u64 = 70;
const INCIDENT_CAP: usize = 256;
const STOP_TOMBSTONE_CAP: usize = 128;
const RELIEF_COOLDOWN_MS: u64 = 10_000;
const GRANT_CHOICES: [u64; 2] = [512 * MIB, GIB];
const DEFAULTS_FILE: &str = "terminal-memory-defaults.json";
const DEFAULTS_ENTRY_CAP: usize = 64;
const DEFAULTS_FILE_MAX: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetState {
    Normal,
    Warned,
    Relief,
    AwaitingGrant,
    OverAllowance,
    Stopping,
    Exited,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GovernorCapability {
    pub platform: String,
    /// Honest until platform containers are implemented and proven.
    pub enforcement: String,
    pub measurement: String,
    pub hard_limit: bool,
    pub pause: bool,
    pub soft_limit: bool,
    pub dynamic_raise: bool,
    pub mechanism: String,
    pub detail: String,
}

impl GovernorCapability {
    pub(crate) fn monitor_only(platform: &str, measurement: &str, detail: &str) -> Self {
        Self {
            platform: platform.into(),
            enforcement: "monitor_only".into(),
            measurement: measurement.into(),
            hard_limit: false,
            pause: false,
            soft_limit: false,
            dynamic_raise: false,
            mechanism: "none".into(),
            detail: detail.into(),
        }
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn soft_limit(
        platform: &str,
        measurement: &str,
        mechanism: &str,
        detail: &str,
    ) -> Self {
        Self {
            platform: platform.into(),
            enforcement: "soft_limit".into(),
            measurement: measurement.into(),
            hard_limit: false,
            pause: false,
            soft_limit: true,
            dynamic_raise: true,
            mechanism: mechanism.into(),
            detail: detail.into(),
        }
    }

    #[cfg(target_os = "windows")]
    pub(crate) fn notification_limit(
        platform: &str,
        measurement: &str,
        mechanism: &str,
        detail: &str,
    ) -> Self {
        Self {
            platform: platform.into(),
            enforcement: "notification_limit".into(),
            measurement: measurement.into(),
            hard_limit: false,
            pause: false,
            soft_limit: false,
            dynamic_raise: true,
            mechanism: mechanism.into(),
            detail: detail.into(),
        }
    }

    fn current() -> Self {
        #[cfg(target_os = "macos")]
        return Self::monitor_only(
            "macos",
            "physical_footprint_sum",
            "no proven platform containment backend is active",
        );
        #[cfg(target_os = "windows")]
        return Self::monitor_only(
            "windows",
            "working_set_sum",
            "no proven platform containment backend is active",
        );
        #[cfg(target_os = "linux")]
        return Self::monitor_only(
            "linux",
            "resident_set_sum",
            "no proven platform containment backend is active",
        );
        #[allow(unreachable_code)]
        Self::monitor_only(
            "other",
            "resident_set_sum",
            "no proven platform containment backend is active",
        )
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct GrantRequest {
    pub request_id: String,
    pub budget_generation: u64,
    pub increments: Vec<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct TerminalBudgetStatus {
    pub id: u32,
    pub budget_generation: u64,
    pub state: BudgetState,
    pub base_allowance_bytes: u64,
    pub granted_bytes: u64,
    pub remembered_default_bytes: u64,
    pub allowance_bytes: u64,
    pub current_bytes: u64,
    pub peak_bytes: u64,
    pub ema_bytes: u64,
    pub growth_bytes_per_second: f64,
    pub samples: u64,
    pub grant_request: Option<GrantRequest>,
    pub stop_request_id: String,
    pub cli_key: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GovernorSnapshot {
    pub capability: GovernorCapability,
    pub host_total_bytes: u64,
    pub host_available_bytes: u64,
    pub protected_reserve_bytes: u64,
    pub aggregate_terminal_bytes: u64,
    pub grantable_headroom_bytes: u64,
    pub fallback_policy: &'static str,
    pub sessions: Vec<TerminalBudgetStatus>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GovernorIncident {
    pub at_ms: u64,
    pub id: u32,
    pub event: &'static str,
    pub from: Option<BudgetState>,
    pub to: Option<BudgetState>,
    pub current_bytes: u64,
    pub allowance_bytes: u64,
    pub detail: &'static str,
}

#[derive(Clone, Debug, Serialize)]
pub struct GovernorEvent {
    pub kind: &'static str,
    pub status: TerminalBudgetStatus,
}

#[derive(Clone, Debug, Serialize)]
pub struct GrantOutcome {
    pub applied: bool,
    pub idempotent: bool,
    pub status: TerminalBudgetStatus,
}

#[derive(Clone, Debug, Serialize)]
pub struct StopOutcome {
    pub requested: bool,
    pub idempotent: bool,
    pub status: TerminalBudgetStatus,
}

#[derive(Clone, Debug, Serialize)]
pub struct RememberDefaultOutcome {
    pub persisted: bool,
    pub idempotent: bool,
    pub cli_key: String,
    pub increment_bytes: u64,
}

#[derive(Clone)]
struct AppliedGrant {
    request_id: String,
    budget_generation: u64,
    increment_bytes: u64,
}

#[derive(Clone)]
struct AppliedStop {
    request_id: String,
    budget_generation: u64,
}

#[derive(Clone)]
struct StopTombstone {
    applied: AppliedStop,
    status: TerminalBudgetStatus,
}

struct SessionBudget {
    id: u32,
    budget_generation: u64,
    state: BudgetState,
    base_allowance_bytes: u64,
    granted_bytes: u64,
    remembered_default_bytes: u64,
    current_bytes: u64,
    peak_bytes: u64,
    ema_bytes: f64,
    growth_bytes_per_second: f64,
    samples: u64,
    warn_streak: u8,
    last_sample_ms: u64,
    pending: Option<GrantRequest>,
    last_grant: Option<AppliedGrant>,
    last_stop: Option<AppliedStop>,
    relief_since_ms: Option<u64>,
    cli_key: Option<String>,
    evaluated_default_cli: Option<String>,
}

impl SessionBudget {
    fn allowance(&self) -> u64 {
        self.base_allowance_bytes
            .saturating_add(self.remembered_default_bytes)
            .saturating_add(self.granted_bytes)
    }

    fn status(&self) -> TerminalBudgetStatus {
        TerminalBudgetStatus {
            id: self.id,
            budget_generation: self.budget_generation,
            state: self.state,
            base_allowance_bytes: self.base_allowance_bytes,
            granted_bytes: self.granted_bytes,
            remembered_default_bytes: self.remembered_default_bytes,
            allowance_bytes: self.allowance(),
            current_bytes: self.current_bytes,
            peak_bytes: self.peak_bytes,
            ema_bytes: self.ema_bytes.max(0.0).round() as u64,
            growth_bytes_per_second: self.growth_bytes_per_second,
            samples: self.samples,
            grant_request: self.pending.clone(),
            stop_request_id: format!("pty-{}-stop-{}", self.id, self.budget_generation),
            cli_key: self.cli_key.clone(),
        }
    }
}

struct GovernorInner {
    sessions: HashMap<u32, SessionBudget>,
    incidents: VecDeque<GovernorIncident>,
    completed_stops: VecDeque<StopTombstone>,
    next_request: u64,
    host_total_bytes: u64,
    host_available_bytes: u64,
    protected_reserve_bytes: u64,
    aggregate_terminal_bytes: u64,
}

impl Default for GovernorInner {
    fn default() -> Self {
        Self {
            sessions: HashMap::new(),
            incidents: VecDeque::new(),
            completed_stops: VecDeque::new(),
            next_request: 0,
            host_total_bytes: 0,
            host_available_bytes: 0,
            protected_reserve_bytes: 0,
            aggregate_terminal_bytes: 0,
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
struct RememberedDefaultsFile {
    #[serde(default)]
    defaults: BTreeMap<String, u64>,
}

struct RememberedDefaults {
    path: Option<PathBuf>,
    values: HashMap<String, u64>,
}

pub struct TerminalGovernor {
    inner: Mutex<GovernorInner>,
    defaults: Mutex<RememberedDefaults>,
}

impl Default for TerminalGovernor {
    fn default() -> Self {
        let path = remembered_defaults_path();
        let values = path
            .as_deref()
            .and_then(|path| load_remembered_defaults(path).ok())
            .unwrap_or_default();
        Self {
            inner: Mutex::new(GovernorInner::default()),
            defaults: Mutex::new(RememberedDefaults { path, values }),
        }
    }
}

pub(crate) fn base_allowance(total_bytes: u64) -> u64 {
    if total_bytes <= 12 * GIB {
        GIB
    } else if total_bytes < 24 * GIB {
        GIB + 512 * MIB
    } else {
        2 * GIB
    }
}

fn protected_reserve(total_bytes: u64) -> u64 {
    (3 * GIB).max(total_bytes / 4).min(total_bytes)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn remembered_defaults_path() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .map(|home| home.join(".canopy").join(DEFAULTS_FILE))
}

fn load_remembered_defaults(path: &Path) -> Result<HashMap<String, u64>, String> {
    let backup = path.with_extension("json.bak");
    let body = match read_defaults_file(path)? {
        Some(body) => body,
        None => match read_defaults_file(&backup)? {
            Some(body) => body,
            None => return Ok(HashMap::new()),
        },
    };
    let parsed: RememberedDefaultsFile =
        serde_json::from_str(&body).map_err(|error| error.to_string())?;
    let values: HashMap<_, _> = parsed
        .defaults
        .into_iter()
        .filter(|(key, value)| valid_cli_key(key) && GRANT_CHOICES.contains(value))
        .collect();
    if values.len() > DEFAULTS_ENTRY_CAP {
        return Err(format!(
            "remembered-default store exceeds {DEFAULTS_ENTRY_CAP} entries"
        ));
    }
    Ok(values)
}

fn read_defaults_file(path: &Path) -> Result<Option<String>, String> {
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let len = file.metadata().map_err(|error| error.to_string())?.len();
    if len > DEFAULTS_FILE_MAX {
        return Err(format!(
            "remembered-default file exceeds {DEFAULTS_FILE_MAX} bytes"
        ));
    }
    let mut bytes = Vec::with_capacity(len as usize);
    file.take(DEFAULTS_FILE_MAX + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > DEFAULTS_FILE_MAX {
        return Err(format!(
            "remembered-default file exceeds {DEFAULTS_FILE_MAX} bytes"
        ));
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "remembered-default file is not UTF-8".to_string())
}

fn persist_remembered_defaults(path: &Path, values: &HashMap<String, u64>) -> Result<(), String> {
    if values.len() > DEFAULTS_ENTRY_CAP {
        return Err(format!(
            "remembered-default store is full ({DEFAULTS_ENTRY_CAP} entries)"
        ));
    }
    let parent = path.parent().ok_or("memory defaults path has no parent")?;
    std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let body = serde_json::to_vec_pretty(&RememberedDefaultsFile {
        defaults: values
            .iter()
            .map(|(key, value)| (key.clone(), *value))
            .collect(),
    })
    .map_err(|error| error.to_string())?;
    if body.len() as u64 > DEFAULTS_FILE_MAX {
        return Err(format!(
            "remembered-default encoding exceeds {DEFAULTS_FILE_MAX} bytes"
        ));
    }
    let tmp = parent.join(format!(
        ".{DEFAULTS_FILE}.tmp-{}-{}",
        std::process::id(),
        now_ms()
    ));
    let backup = path.with_extension("json.bak");
    let write_result = (|| -> Result<(), String> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|error| error.to_string())?;
        file.write_all(&body).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    let _ = std::fs::remove_file(&backup);
    let had_existing = path.is_file();
    if had_existing {
        if let Err(error) = std::fs::rename(path, &backup) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("back up remembered defaults: {error}"));
        }
    }
    if let Err(error) = std::fs::rename(&tmp, path) {
        if had_existing {
            let _ = std::fs::rename(&backup, path);
        }
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("publish remembered defaults: {error}"));
    }
    let _ = std::fs::remove_file(&backup);
    Ok(())
}

fn valid_cli_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 192
        && (key.starts_with("pkg:") || key.starts_with("bin:"))
        && !key.chars().any(char::is_control)
}

pub(crate) fn cli_key(hint: Option<&crate::agentid::AgentHint>) -> Option<String> {
    let hint = hint?;
    let (kind, value) = hint
        .pkg
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| ("pkg", value))
        .unwrap_or(("bin", hint.bin.as_str()));
    let value = value.trim().to_ascii_lowercase();
    let key = format!("{kind}:{value}");
    valid_cli_key(&key).then_some(key)
}

fn push_incident(inner: &mut GovernorInner, incident: GovernorIncident) {
    inner.incidents.push_back(incident);
    while inner.incidents.len() > INCIDENT_CAP {
        inner.incidents.pop_front();
    }
}

/// Headroom that may be promised by a new explicit grant. Unused portions of
/// earlier grants are already promises, so subtract them even though the child
/// has not allocated those bytes yet. Base allowances remain admission-policy
/// defaults, not an OS reservation; capability reporting stays monitor-only.
fn grantable_headroom(inner: &GovernorInner) -> u64 {
    let unused_grants = inner.sessions.values().fold(0_u64, |sum, session| {
        let unused_allowance = session.allowance().saturating_sub(session.current_bytes);
        sum.saturating_add(
            unused_allowance.min(
                session
                    .granted_bytes
                    .saturating_add(session.remembered_default_bytes),
            ),
        )
    });
    inner
        .host_available_bytes
        .saturating_sub(inner.protected_reserve_bytes)
        .saturating_sub(unused_grants)
}

pub(crate) struct TerminalObservation {
    pub id: u32,
    pub bytes: u64,
    pub cli_key: Option<String>,
}

impl TerminalGovernor {
    /// Consume the process-tree totals the existing PTY monitor already paid to
    /// collect. `observations` is the full live set for this tick; absence means
    /// exit and releases the in-memory, one-session allowance.
    #[cfg(test)]
    pub fn observe(
        &self,
        observations: &[(u32, u64)],
        host_total_bytes: u64,
        host_available_bytes: u64,
        at_ms: u64,
    ) -> Vec<GovernorEvent> {
        let detailed: Vec<_> = observations
            .iter()
            .map(|(id, bytes)| TerminalObservation {
                id: *id,
                bytes: *bytes,
                cli_key: None,
            })
            .collect();
        self.observe_detailed(
            &detailed,
            host_total_bytes,
            host_available_bytes,
            at_ms,
            |_, _| Ok(()),
        )
    }

    pub(crate) fn observe_detailed<F>(
        &self,
        observations: &[TerminalObservation],
        host_total_bytes: u64,
        host_available_bytes: u64,
        at_ms: u64,
        mut apply_boundary: F,
    ) -> Vec<GovernorEvent>
    where
        F: FnMut(u32, u64) -> Result<(), String>,
    {
        let remembered = self.defaults.lock().unwrap().values.clone();
        let mut inner = self.inner.lock().unwrap();
        inner.host_total_bytes = host_total_bytes;
        inner.host_available_bytes = host_available_bytes;
        inner.protected_reserve_bytes = protected_reserve(host_total_bytes);
        inner.aggregate_terminal_bytes = observations.iter().fold(0_u64, |sum, observation| {
            sum.saturating_add(observation.bytes)
        });

        let live: std::collections::HashSet<u32> = observations
            .iter()
            .map(|observation| observation.id)
            .collect();
        let ended: Vec<u32> = inner
            .sessions
            .keys()
            .filter(|id| !live.contains(id))
            .copied()
            .collect();
        for id in ended {
            if let Some(mut old) = inner.sessions.remove(&id) {
                let from = old.state;
                old.state = BudgetState::Exited;
                old.pending = None;
                old.budget_generation = old.budget_generation.saturating_add(1);
                let status = old.status();
                push_incident(
                    &mut inner,
                    GovernorIncident {
                        at_ms,
                        id,
                        event: "session_exited",
                        from: Some(from),
                        to: Some(BudgetState::Exited),
                        current_bytes: old.current_bytes,
                        allowance_bytes: old.allowance(),
                        detail: "one-session allowance released; terminal exited",
                    },
                );
                if let Some(applied) = old.last_stop {
                    inner
                        .completed_stops
                        .push_back(StopTombstone { applied, status });
                    while inner.completed_stops.len() > STOP_TOMBSTONE_CAP {
                        inner.completed_stops.pop_front();
                    }
                }
            }
        }

        let mut events = Vec::new();
        for observation in observations {
            let id = observation.id;
            let current = observation.bytes;
            let base = base_allowance(host_total_bytes);
            // Work on an owned session so creating a request and recording an
            // incident cannot alias the sessions map's mutable borrow.
            let mut session = inner.sessions.remove(&id).unwrap_or_else(|| SessionBudget {
                id,
                budget_generation: 1,
                state: BudgetState::Normal,
                base_allowance_bytes: base,
                granted_bytes: 0,
                remembered_default_bytes: 0,
                current_bytes: current,
                peak_bytes: current,
                ema_bytes: current as f64,
                growth_bytes_per_second: 0.0,
                samples: 0,
                warn_streak: 0,
                last_sample_ms: at_ms,
                pending: None,
                last_grant: None,
                last_stop: None,
                relief_since_ms: None,
                cli_key: observation.cli_key.clone(),
                evaluated_default_cli: None,
            });

            if observation.cli_key.is_some() {
                session.cli_key.clone_from(&observation.cli_key);
            }
            if let Some(key) = session.cli_key.clone() {
                if session.evaluated_default_cli.as_deref() != Some(&key) {
                    session.evaluated_default_cli = Some(key.clone());
                    if session.remembered_default_bytes == 0 && session.granted_bytes == 0 {
                        if let Some(increment) = remembered.get(&key).copied() {
                            let headroom = grantable_headroom(&inner);
                            let next_allowance = session.allowance().saturating_add(increment);
                            let applied = if increment > headroom {
                                Err("remembered default would consume the protected host reserve")
                            } else {
                                apply_boundary(id, next_allowance)
                                    .map_err(|_| "remembered default boundary update failed")
                            };
                            match applied {
                                Ok(()) => {
                                    session.remembered_default_bytes = increment;
                                    session.budget_generation =
                                        session.budget_generation.saturating_add(1);
                                    push_incident(
                                        &mut inner,
                                        GovernorIncident {
                                            at_ms,
                                            id,
                                            event: "remembered_default_applied",
                                            from: Some(session.state),
                                            to: Some(session.state),
                                            current_bytes: current,
                                            allowance_bytes: next_allowance,
                                            detail:
                                                "separately confirmed native CLI default applied",
                                        },
                                    );
                                    events.push(GovernorEvent {
                                        kind: "remembered_default_applied",
                                        status: session.status(),
                                    });
                                }
                                Err(detail) => push_incident(
                                    &mut inner,
                                    GovernorIncident {
                                        at_ms,
                                        id,
                                        event: "remembered_default_refused",
                                        from: Some(session.state),
                                        to: Some(session.state),
                                        current_bytes: current,
                                        allowance_bytes: session.allowance(),
                                        detail,
                                    },
                                ),
                            }
                        }
                    }
                }
            }

            let elapsed_ms = at_ms.saturating_sub(session.last_sample_ms);
            if session.samples > 0 && elapsed_ms > 0 {
                session.growth_bytes_per_second =
                    (current as f64 - session.current_bytes as f64) * 1000.0 / elapsed_ms as f64;
                session.ema_bytes = session.ema_bytes * 0.7 + current as f64 * 0.3;
            }
            session.samples = session.samples.saturating_add(1);
            session.current_bytes = current;
            session.peak_bytes = session.peak_bytes.max(current);
            session.last_sample_ms = at_ms;

            let allowance = session.allowance().max(1);
            if current.saturating_mul(100) >= allowance.saturating_mul(WARN_NUM) {
                session.warn_streak = session.warn_streak.saturating_add(1);
            } else if current.saturating_mul(100) < allowance.saturating_mul(CLEAR_NUM) {
                session.warn_streak = 0;
            }

            let target = if session.state == BudgetState::Stopping {
                BudgetState::Stopping
            } else if current >= allowance {
                BudgetState::OverAllowance
            } else if session.warn_streak >= 2
                && current.saturating_mul(100) >= allowance.saturating_mul(REQUEST_NUM)
            {
                BudgetState::AwaitingGrant
            } else if session.warn_streak >= 2
                && current.saturating_mul(100) >= allowance.saturating_mul(WARN_NUM)
            {
                BudgetState::Warned
            } else if current.saturating_mul(100) < allowance.saturating_mul(CLEAR_NUM) {
                if matches!(
                    session.state,
                    BudgetState::Warned | BudgetState::AwaitingGrant | BudgetState::OverAllowance
                ) {
                    BudgetState::Relief
                } else if session.state == BudgetState::Relief
                    && session
                        .relief_since_ms
                        .is_some_and(|since| at_ms.saturating_sub(since) >= RELIEF_COOLDOWN_MS)
                {
                    BudgetState::Normal
                } else {
                    session.state
                }
            } else {
                session.state
            };

            if target != session.state {
                let from = session.state;
                session.state = target;
                session.budget_generation = session.budget_generation.saturating_add(1);
                session.pending = None;
                session.relief_since_ms = (target == BudgetState::Relief).then_some(at_ms);
                if matches!(
                    target,
                    BudgetState::AwaitingGrant | BudgetState::OverAllowance
                ) {
                    inner.next_request = inner.next_request.saturating_add(1);
                    session.pending = Some(GrantRequest {
                        request_id: format!("pty-{id}-grant-{}", inner.next_request),
                        budget_generation: session.budget_generation,
                        increments: GRANT_CHOICES.to_vec(),
                    });
                }
                let status = session.status();
                push_incident(
                    &mut inner,
                    GovernorIncident {
                        at_ms,
                        id,
                        event: "state_changed",
                        from: Some(from),
                        to: Some(target),
                        current_bytes: current,
                        allowance_bytes: allowance,
                        detail: "governor lifecycle transition",
                    },
                );
                events.push(GovernorEvent {
                    kind: "state_changed",
                    status,
                });
            }
            inner.sessions.insert(id, session);
        }
        events
    }

    fn snapshot_locked(inner: &GovernorInner) -> GovernorSnapshot {
        let mut sessions: Vec<_> = inner.sessions.values().map(SessionBudget::status).collect();
        sessions.sort_by_key(|s| s.id);
        GovernorSnapshot {
            capability: GovernorCapability::current(),
            host_total_bytes: inner.host_total_bytes,
            host_available_bytes: inner.host_available_bytes,
            protected_reserve_bytes: inner.protected_reserve_bytes,
            aggregate_terminal_bytes: inner.aggregate_terminal_bytes,
            grantable_headroom_bytes: grantable_headroom(inner),
            fallback_policy: "notify_natively_and_refuse_automatic_grant_pause_or_stop",
            sessions,
        }
    }

    pub fn snapshot(&self) -> GovernorSnapshot {
        Self::snapshot_locked(&self.inner.lock().unwrap())
    }

    pub fn incidents(&self) -> Vec<GovernorIncident> {
        self.inner
            .lock()
            .unwrap()
            .incidents
            .iter()
            .cloned()
            .collect()
    }

    fn grant_with<F>(
        &self,
        id: u32,
        budget_generation: u64,
        request_id: &str,
        increment_bytes: u64,
        at_ms: u64,
        apply_boundary: F,
    ) -> Result<GrantOutcome, String>
    where
        F: FnOnce(u64) -> Result<(), String>,
    {
        let mut inner = self.inner.lock().unwrap();
        let reserve_headroom = grantable_headroom(&inner);
        let Some(session) = inner.sessions.get(&id) else {
            return Err(format!("no monitored terminal {id}"));
        };

        if let Some(applied) = &session.last_grant {
            if applied.request_id == request_id
                && applied.budget_generation == budget_generation
                && applied.increment_bytes == increment_bytes
            {
                let status = session.status();
                push_incident(
                    &mut inner,
                    GovernorIncident {
                        at_ms,
                        id,
                        event: "grant_idempotent_retry",
                        from: Some(status.state),
                        to: Some(status.state),
                        current_bytes: status.current_bytes,
                        allowance_bytes: status.allowance_bytes,
                        detail: "exact grant retry returned the original outcome",
                    },
                );
                return Ok(GrantOutcome {
                    applied: false,
                    idempotent: true,
                    status,
                });
            }
        }

        let refusal = if !GRANT_CHOICES.contains(&increment_bytes) {
            Some("unsupported grant increment")
        } else if increment_bytes > reserve_headroom {
            Some("grant would consume the protected host reserve")
        } else {
            match &session.pending {
                None => Some("terminal is not awaiting a grant"),
                Some(pending) if pending.request_id != request_id => Some("stale grant request"),
                Some(pending) if pending.budget_generation != budget_generation => {
                    Some("stale budget generation")
                }
                Some(_) => None,
            }
        };
        if let Some(detail) = refusal {
            let incident = GovernorIncident {
                at_ms,
                id,
                event: "grant_refused",
                from: Some(session.state),
                to: Some(session.state),
                current_bytes: session.current_bytes,
                allowance_bytes: session.allowance(),
                detail,
            };
            push_incident(&mut inner, incident);
            return Err(detail.to_string());
        }

        let next_allowance = session.allowance().saturating_add(increment_bytes);
        if let Err(error) = apply_boundary(next_allowance) {
            let incident = GovernorIncident {
                at_ms,
                id,
                event: "grant_refused",
                from: Some(session.state),
                to: Some(session.state),
                current_bytes: session.current_bytes,
                allowance_bytes: session.allowance(),
                detail: "platform boundary update failed",
            };
            push_incident(&mut inner, incident);
            return Err(format!(
                "could not raise terminal containment boundary: {error}"
            ));
        }

        let mut session = inner.sessions.remove(&id).expect("checked above");
        session.granted_bytes = session.granted_bytes.saturating_add(increment_bytes);
        session.last_grant = Some(AppliedGrant {
            request_id: request_id.to_string(),
            budget_generation,
            increment_bytes,
        });
        session.pending = None;
        let from = session.state;
        session.warn_streak = 0;
        session.budget_generation = session.budget_generation.saturating_add(1);
        session.state = if session.current_bytes >= session.allowance() {
            // A grant can be smaller than an already-large overage. Do not
            // falsely report NORMAL or require another stats tick before the
            // user may explicitly approve the next bounded increment.
            inner.next_request = inner.next_request.saturating_add(1);
            session.pending = Some(GrantRequest {
                request_id: format!("pty-{id}-grant-{}", inner.next_request),
                budget_generation: session.budget_generation,
                increments: GRANT_CHOICES.to_vec(),
            });
            session.relief_since_ms = None;
            BudgetState::OverAllowance
        } else {
            session.relief_since_ms = Some(at_ms);
            BudgetState::Relief
        };
        let status = session.status();
        inner.sessions.insert(id, session);
        let detail = if status.state == BudgetState::OverAllowance {
            "temporary allowance raised; terminal remains over allowance"
        } else {
            "temporary one-session allowance raised"
        };
        push_incident(
            &mut inner,
            GovernorIncident {
                at_ms,
                id,
                event: "grant_applied",
                from: Some(from),
                to: Some(status.state),
                current_bytes: status.current_bytes,
                allowance_bytes: status.allowance_bytes,
                detail,
            },
        );
        Ok(GrantOutcome {
            applied: true,
            idempotent: false,
            status,
        })
    }

    fn stop_with<F>(
        &self,
        id: u32,
        budget_generation: u64,
        request_id: &str,
        at_ms: u64,
        request_stop: F,
    ) -> Result<StopOutcome, String>
    where
        F: FnOnce() -> Result<(), String>,
    {
        let mut inner = self.inner.lock().unwrap();
        if let Some(tombstone) = inner.completed_stops.iter().rev().find(|tombstone| {
            tombstone.applied.request_id == request_id
                && tombstone.applied.budget_generation == budget_generation
                && tombstone.status.id == id
        }) {
            let status = tombstone.status.clone();
            push_incident(
                &mut inner,
                GovernorIncident {
                    at_ms,
                    id,
                    event: "stop_idempotent_retry",
                    from: Some(BudgetState::Exited),
                    to: Some(BudgetState::Exited),
                    current_bytes: status.current_bytes,
                    allowance_bytes: status.allowance_bytes,
                    detail: "exact stop retry returned the completed outcome",
                },
            );
            return Ok(StopOutcome {
                requested: false,
                idempotent: true,
                status,
            });
        }
        let Some(session) = inner.sessions.get(&id) else {
            return Err(format!("no monitored terminal {id}"));
        };
        if let Some(applied) = &session.last_stop {
            if applied.request_id == request_id && applied.budget_generation == budget_generation {
                let status = session.status();
                push_incident(
                    &mut inner,
                    GovernorIncident {
                        at_ms,
                        id,
                        event: "stop_idempotent_retry",
                        from: Some(status.state),
                        to: Some(status.state),
                        current_bytes: status.current_bytes,
                        allowance_bytes: status.allowance_bytes,
                        detail: "exact stop retry returned the in-flight outcome",
                    },
                );
                return Ok(StopOutcome {
                    requested: false,
                    idempotent: true,
                    status,
                });
            }
        }
        let expected = format!("pty-{id}-stop-{}", session.budget_generation);
        let refusal = if session.state == BudgetState::Stopping {
            Some("terminal is already stopping")
        } else if request_id != expected {
            Some("stale stop request")
        } else if budget_generation != session.budget_generation {
            Some("stale budget generation")
        } else {
            None
        };
        if let Some(detail) = refusal {
            let incident = GovernorIncident {
                at_ms,
                id,
                event: "stop_refused",
                from: Some(session.state),
                to: Some(session.state),
                current_bytes: session.current_bytes,
                allowance_bytes: session.allowance(),
                detail,
            };
            push_incident(&mut inner, incident);
            return Err(detail.into());
        }
        let before = session.status();
        if let Err(error) = request_stop() {
            push_incident(
                &mut inner,
                GovernorIncident {
                    at_ms,
                    id,
                    event: "stop_refused",
                    from: Some(before.state),
                    to: Some(before.state),
                    current_bytes: before.current_bytes,
                    allowance_bytes: before.allowance_bytes,
                    detail: "PTY graceful-stop request failed",
                },
            );
            return Err(format!("could not request graceful terminal stop: {error}"));
        }
        let mut session = inner.sessions.remove(&id).expect("checked above");
        let from = session.state;
        session.state = BudgetState::Stopping;
        session.pending = None;
        session.relief_since_ms = None;
        session.last_stop = Some(AppliedStop {
            request_id: request_id.to_string(),
            budget_generation,
        });
        session.budget_generation = session.budget_generation.saturating_add(1);
        let status = session.status();
        inner.sessions.insert(id, session);
        push_incident(
            &mut inner,
            GovernorIncident {
                at_ms,
                id,
                event: "stop_requested",
                from: Some(from),
                to: Some(BudgetState::Stopping),
                current_bytes: status.current_bytes,
                allowance_bytes: status.allowance_bytes,
                detail: "explicit graceful-stop request accepted",
            },
        );
        Ok(StopOutcome {
            requested: true,
            idempotent: false,
            status,
        })
    }

    fn remember_default(
        &self,
        id: u32,
        grant_request_id: &str,
        grant_budget_generation: u64,
        increment_bytes: u64,
        confirmed: bool,
        at_ms: u64,
    ) -> Result<RememberDefaultOutcome, String> {
        if !confirmed {
            return Err("remembering a CLI default requires separate confirmation".into());
        }
        if !GRANT_CHOICES.contains(&increment_bytes) {
            return Err("unsupported remembered-default increment".into());
        }
        let cli_key = {
            let inner = self.inner.lock().unwrap();
            let session = inner
                .sessions
                .get(&id)
                .ok_or_else(|| format!("no monitored terminal {id}"))?;
            let applied = session
                .last_grant
                .as_ref()
                .ok_or("remembered default requires a successfully applied grant")?;
            if applied.request_id != grant_request_id
                || applied.budget_generation != grant_budget_generation
                || applied.increment_bytes != increment_bytes
            {
                return Err("remembered default does not match the applied grant".into());
            }
            session
                .cli_key
                .clone()
                .ok_or("terminal CLI identity is not known")?
        };

        let mut defaults = self.defaults.lock().unwrap();
        if defaults.values.get(&cli_key) == Some(&increment_bytes) {
            drop(defaults);
            let mut inner = self.inner.lock().unwrap();
            let (state, current, allowance) = inner
                .sessions
                .get(&id)
                .map(|session| (session.state, session.current_bytes, session.allowance()))
                .unwrap_or((BudgetState::Exited, 0, 0));
            push_incident(
                &mut inner,
                GovernorIncident {
                    at_ms,
                    id,
                    event: "remembered_default_idempotent_retry",
                    from: Some(state),
                    to: Some(state),
                    current_bytes: current,
                    allowance_bytes: allowance,
                    detail: "exact remembered-default retry left native storage unchanged",
                },
            );
            return Ok(RememberDefaultOutcome {
                persisted: false,
                idempotent: true,
                cli_key,
                increment_bytes,
            });
        }
        let path = defaults
            .path
            .clone()
            .ok_or("native remembered-default storage is unavailable")?;
        let mut next = defaults.values.clone();
        if !next.contains_key(&cli_key) && next.len() >= DEFAULTS_ENTRY_CAP {
            return Err(format!(
                "remembered-default store is full ({DEFAULTS_ENTRY_CAP} entries)"
            ));
        }
        next.insert(cli_key.clone(), increment_bytes);
        persist_remembered_defaults(&path, &next)?;
        defaults.values = next;
        drop(defaults);
        let mut inner = self.inner.lock().unwrap();
        let (state, current, allowance) = inner
            .sessions
            .get(&id)
            .map(|session| (session.state, session.current_bytes, session.allowance()))
            .unwrap_or((BudgetState::Exited, 0, 0));
        push_incident(
            &mut inner,
            GovernorIncident {
                at_ms,
                id,
                event: "remembered_default_persisted",
                from: Some(state),
                to: Some(state),
                current_bytes: current,
                allowance_bytes: allowance,
                detail: "separate confirmation persisted a content-free CLI default",
            },
        );
        Ok(RememberDefaultOutcome {
            persisted: true,
            idempotent: false,
            cli_key,
            increment_bytes,
        })
    }

    #[cfg(test)]
    fn with_defaults_path(path: PathBuf) -> Self {
        let values = load_remembered_defaults(&path).unwrap_or_default();
        Self {
            inner: Mutex::new(GovernorInner::default()),
            defaults: Mutex::new(RememberedDefaults {
                path: Some(path),
                values,
            }),
        }
    }

    #[cfg(test)]
    fn grant(
        &self,
        id: u32,
        budget_generation: u64,
        request_id: &str,
        increment_bytes: u64,
        at_ms: u64,
    ) -> Result<GrantOutcome, String> {
        self.grant_with(
            id,
            budget_generation,
            request_id,
            increment_bytes,
            at_ms,
            |_| Ok(()),
        )
    }
}

#[tauri::command]
pub fn terminal_governor_status(
    state: State<'_, TerminalGovernor>,
    containment: State<'_, crate::containment::ContainmentManager>,
) -> GovernorSnapshot {
    let mut snapshot = state.snapshot();
    snapshot.capability = containment.capability();
    snapshot
}

#[tauri::command]
pub fn terminal_governor_incidents(state: State<'_, TerminalGovernor>) -> Vec<GovernorIncident> {
    state.incidents()
}

#[tauri::command]
pub fn terminal_governor_grant(
    app: AppHandle,
    state: State<'_, TerminalGovernor>,
    containment: State<'_, crate::containment::ContainmentManager>,
    id: u32,
    budget_generation: u64,
    request_id: String,
    increment_bytes: u64,
) -> Result<GrantOutcome, String> {
    let outcome = state.grant_with(
        id,
        budget_generation,
        &request_id,
        increment_bytes,
        now_ms(),
        |allowance| containment.raise_allowance(id, allowance),
    )?;
    if outcome.applied {
        let _ = app.emit(
            "terminal:governor",
            GovernorEvent {
                kind: "grant_applied",
                status: outcome.status.clone(),
            },
        );
    }
    Ok(outcome)
}

#[tauri::command]
pub fn terminal_governor_stop(
    app: AppHandle,
    state: State<'_, TerminalGovernor>,
    ptys: State<'_, crate::pty::PtyManager>,
    id: u32,
    budget_generation: u64,
    request_id: String,
) -> Result<StopOutcome, String> {
    let outcome = state.stop_with(id, budget_generation, &request_id, now_ms(), || {
        ptys.kill(id)
    })?;
    if outcome.requested {
        let _ = app.emit(
            "terminal:governor",
            GovernorEvent {
                kind: "stop_requested",
                status: outcome.status.clone(),
            },
        );
    }
    Ok(outcome)
}

#[tauri::command]
pub fn terminal_governor_remember_default(
    state: State<'_, TerminalGovernor>,
    id: u32,
    grant_request_id: String,
    grant_budget_generation: u64,
    increment_bytes: u64,
    confirmed: bool,
) -> Result<RememberDefaultOutcome, String> {
    state.remember_default(
        id,
        &grant_request_id,
        grant_budget_generation,
        increment_bytes,
        confirmed,
        now_ms(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gib(n: u64) -> u64 {
        n * GIB
    }

    #[test]
    fn dynamic_defaults_and_reserve_are_bounded() {
        assert_eq!(base_allowance(gib(8)), gib(1));
        assert_eq!(base_allowance(gib(16)), gib(1) + 512 * MIB);
        assert_eq!(base_allowance(gib(32)), gib(2));
        assert_eq!(protected_reserve(gib(8)), gib(3));
        assert_eq!(protected_reserve(gib(32)), gib(8));
        assert_eq!(protected_reserve(gib(2)), gib(2));
    }

    #[test]
    fn metrics_track_peak_ema_and_signed_growth_from_the_existing_tick() {
        let governor = TerminalGovernor::default();
        governor.observe(&[(7, 100)], gib(16), gib(8), 1_000);
        governor.observe(&[(7, 300)], gib(16), gib(8), 3_000);
        governor.observe(&[(7, 200)], gib(16), gib(8), 5_000);
        let status = &governor.snapshot().sessions[0];
        assert_eq!(status.current_bytes, 200);
        assert_eq!(status.peak_bytes, 300);
        assert_eq!(status.ema_bytes, 172);
        assert_eq!(status.growth_bytes_per_second, -50.0);
        assert_eq!(status.samples, 3);
    }

    #[test]
    fn warning_requires_two_samples_and_clear_uses_hysteresis() {
        let governor = TerminalGovernor::default();
        let allowance = base_allowance(gib(8));
        let high = allowance * 80 / 100;
        assert!(governor
            .observe(&[(1, high)], gib(8), gib(6), 1_000)
            .is_empty());
        let events = governor.observe(&[(1, high)], gib(8), gib(6), 3_000);
        assert_eq!(events[0].status.state, BudgetState::Warned);
        assert!(governor
            .observe(&[(1, allowance * 72 / 100)], gib(8), gib(6), 5_000)
            .is_empty());
        let events = governor.observe(&[(1, allowance / 2)], gib(8), gib(6), 7_000);
        assert_eq!(events[0].status.state, BudgetState::Relief);
        assert!(governor
            .observe(&[(1, allowance / 2)], gib(8), gib(6), 15_000)
            .is_empty());
        let events = governor.observe(&[(1, allowance / 2)], gib(8), gib(6), 17_000);
        assert_eq!(events[0].status.state, BudgetState::Normal);
    }

    #[test]
    fn one_terminal_crossing_its_allowance_does_not_limit_its_project_siblings() {
        let governor = TerminalGovernor::default();
        let allowance = base_allowance(gib(8));
        let high = allowance * 95 / 100;
        let low = allowance / 4;

        governor.observe(&[(11, high), (12, low)], gib(8), gib(6), 1_000);
        governor.observe(&[(11, high), (12, low)], gib(8), gib(6), 3_000);

        let snapshot = governor.snapshot();
        let pressured = snapshot
            .sessions
            .iter()
            .find(|session| session.id == 11)
            .unwrap();
        let sibling = snapshot
            .sessions
            .iter()
            .find(|session| session.id == 12)
            .unwrap();
        assert_eq!(pressured.state, BudgetState::AwaitingGrant);
        assert!(pressured.grant_request.is_some());
        assert_eq!(sibling.state, BudgetState::Normal);
        assert!(sibling.grant_request.is_none());
        assert_eq!(sibling.allowance_bytes, allowance);
    }

    fn awaiting(governor: &TerminalGovernor, available: u64) -> GrantRequest {
        let allowance = base_allowance(gib(8));
        let high = allowance * 95 / 100;
        governor.observe(&[(3, high)], gib(8), available, 1_000);
        governor.observe(&[(3, high)], gib(8), available, 3_000);
        governor.snapshot().sessions[0]
            .grant_request
            .clone()
            .expect("grant request")
    }

    #[test]
    fn grant_is_single_use_but_an_exact_retry_is_idempotent() {
        let governor = TerminalGovernor::default();
        let request = awaiting(&governor, gib(6));
        let first = governor
            .grant(
                3,
                request.budget_generation,
                &request.request_id,
                512 * MIB,
                4_000,
            )
            .unwrap();
        assert!(first.applied);
        assert_eq!(first.status.granted_bytes, 512 * MIB);
        let retry = governor
            .grant(
                3,
                request.budget_generation,
                &request.request_id,
                512 * MIB,
                5_000,
            )
            .unwrap();
        assert!(!retry.applied);
        assert!(retry.idempotent);
        assert_eq!(retry.status.granted_bytes, 512 * MIB);
        assert!(governor
            .grant(
                3,
                request.budget_generation,
                &request.request_id,
                GIB,
                6_000,
            )
            .is_err());
    }

    #[test]
    fn stale_generation_cannot_raise_an_allowance() {
        let governor = TerminalGovernor::default();
        let request = awaiting(&governor, gib(6));
        let error = governor
            .grant(
                3,
                request.budget_generation.saturating_sub(1),
                &request.request_id,
                512 * MIB,
                4_000,
            )
            .unwrap_err();
        assert_eq!(error, "stale budget generation");
        assert_eq!(governor.snapshot().sessions[0].granted_bytes, 0);
    }

    #[test]
    fn failed_platform_raise_leaves_the_policy_grant_unspent() {
        let governor = TerminalGovernor::default();
        let request = awaiting(&governor, gib(6));
        let error = governor
            .grant_with(
                3,
                request.budget_generation,
                &request.request_id,
                512 * MIB,
                4_000,
                |_| Err("delegate revoked".into()),
            )
            .unwrap_err();
        assert!(error.contains("delegate revoked"));
        let status = &governor.snapshot().sessions[0];
        assert_eq!(status.granted_bytes, 0);
        assert_eq!(
            status.grant_request.as_ref().unwrap().request_id,
            request.request_id
        );
        assert_eq!(
            governor.incidents().last().unwrap().detail,
            "platform boundary update failed"
        );
    }

    #[test]
    fn insufficient_grant_stays_over_allowance_and_issues_a_fresh_request() {
        let governor = TerminalGovernor::default();
        let current = base_allowance(gib(8)) + gib(2);
        governor.observe(&[(3, current)], gib(8), gib(7), 1_000);
        let request = governor.snapshot().sessions[0]
            .grant_request
            .clone()
            .expect("initial request");
        let result = governor
            .grant(
                3,
                request.budget_generation,
                &request.request_id,
                GIB,
                2_000,
            )
            .unwrap();
        assert_eq!(result.status.state, BudgetState::OverAllowance);
        let next = result.status.grant_request.expect("follow-up request");
        assert_ne!(next.request_id, request.request_id);
        assert!(next.budget_generation > request.budget_generation);
    }

    #[test]
    fn grant_cannot_spend_the_protected_reserve() {
        let governor = TerminalGovernor::default();
        let request = awaiting(&governor, gib(3) + 256 * MIB);
        let error = governor
            .grant(
                3,
                request.budget_generation,
                &request.request_id,
                512 * MIB,
                4_000,
            )
            .unwrap_err();
        assert!(error.contains("protected host reserve"));
        assert_eq!(governor.snapshot().sessions[0].granted_bytes, 0);
    }

    #[test]
    fn unused_prior_grant_is_reserved_before_promising_another() {
        let governor = TerminalGovernor::default();
        let allowance = base_allowance(gib(8));
        let high = allowance * 95 / 100;
        let available = gib(3) + 768 * MIB;
        governor.observe(&[(1, high), (2, high)], gib(8), available, 1_000);
        governor.observe(&[(1, high), (2, high)], gib(8), available, 3_000);
        let snapshot = governor.snapshot();
        let first = snapshot.sessions[0]
            .grant_request
            .clone()
            .expect("first request");
        let second = snapshot.sessions[1]
            .grant_request
            .clone()
            .expect("second request");
        governor
            .grant(
                1,
                first.budget_generation,
                &first.request_id,
                512 * MIB,
                4_000,
            )
            .unwrap();
        let error = governor
            .grant(
                2,
                second.budget_generation,
                &second.request_id,
                512 * MIB,
                5_000,
            )
            .unwrap_err();
        assert!(error.contains("protected host reserve"));
    }

    #[test]
    fn absent_session_releases_temporary_state_and_records_exit() {
        let governor = TerminalGovernor::default();
        governor.observe(&[(9, 100)], gib(16), gib(8), 1_000);
        governor.observe(&[], gib(16), gib(8), 3_000);
        assert!(governor.snapshot().sessions.is_empty());
        let incident = governor.incidents().last().unwrap().clone();
        assert_eq!(incident.event, "session_exited");
        assert_eq!(incident.to, Some(BudgetState::Exited));
    }

    #[test]
    fn incident_history_is_bounded() {
        let governor = TerminalGovernor::default();
        for id in 1..=(INCIDENT_CAP as u32 + 20) {
            governor.observe(&[(id, 1)], gib(16), gib(8), u64::from(id) * 2);
            governor.observe(&[], gib(16), gib(8), u64::from(id) * 2 + 1);
        }
        assert_eq!(governor.incidents().len(), INCIDENT_CAP);
    }

    #[test]
    fn capability_never_claims_unimplemented_enforcement() {
        let capability = GovernorCapability::current();
        assert_eq!(capability.enforcement, "monitor_only");
        assert!(!capability.hard_limit);
        assert!(!capability.pause);
        assert!(!capability.soft_limit);
        assert!(!capability.dynamic_raise);
    }

    #[test]
    fn explicit_stop_is_single_use_audited_and_retryable_after_exit() {
        let governor = TerminalGovernor::default();
        governor.observe(&[(5, 100)], gib(16), gib(8), 1_000);
        let initial = governor.snapshot().sessions[0].clone();
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let first = governor
            .stop_with(
                5,
                initial.budget_generation,
                &initial.stop_request_id,
                2_000,
                || {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                },
            )
            .unwrap();
        assert!(first.requested);
        assert_eq!(first.status.state, BudgetState::Stopping);
        let retry = governor
            .stop_with(
                5,
                initial.budget_generation,
                &initial.stop_request_id,
                2_100,
                || {
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    Ok(())
                },
            )
            .unwrap();
        assert!(retry.idempotent);
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        governor.observe(&[], gib(16), gib(8), 3_000);
        let completed_retry = governor
            .stop_with(
                5,
                initial.budget_generation,
                &initial.stop_request_id,
                3_100,
                || panic!("completed retry must not signal"),
            )
            .unwrap();
        assert!(completed_retry.idempotent);
        assert_eq!(completed_retry.status.state, BudgetState::Exited);
        assert_eq!(
            governor.incidents().last().unwrap().event,
            "stop_idempotent_retry"
        );
    }

    #[test]
    fn failed_stop_request_leaves_the_session_live_and_audits_refusal() {
        let governor = TerminalGovernor::default();
        governor.observe(&[(6, 100)], gib(16), gib(8), 1_000);
        let initial = governor.snapshot().sessions[0].clone();
        let error = governor
            .stop_with(
                6,
                initial.budget_generation,
                &initial.stop_request_id,
                2_000,
                || Err("PTY unavailable".into()),
            )
            .unwrap_err();
        assert!(error.contains("PTY unavailable"));
        assert_eq!(governor.snapshot().sessions[0].state, BudgetState::Normal);
        assert_eq!(governor.incidents().last().unwrap().event, "stop_refused");
    }

    #[test]
    fn completed_stop_idempotency_tombstones_are_bounded() {
        let governor = TerminalGovernor::default();
        for id in 1..=(STOP_TOMBSTONE_CAP as u32 + 7) {
            governor.observe(&[(id, 1)], gib(16), gib(8), u64::from(id) * 3);
            let status = governor.snapshot().sessions[0].clone();
            governor
                .stop_with(
                    id,
                    status.budget_generation,
                    &status.stop_request_id,
                    u64::from(id) * 3 + 1,
                    || Ok(()),
                )
                .unwrap();
            governor.observe(&[], gib(16), gib(8), u64::from(id) * 3 + 2);
        }
        assert_eq!(
            governor.inner.lock().unwrap().completed_stops.len(),
            STOP_TOMBSTONE_CAP
        );
    }

    fn defaults_scratch() -> PathBuf {
        let mut random = [0_u8; 8];
        getrandom::getrandom(&mut random).unwrap();
        std::env::temp_dir().join(format!(
            "canopy-governor-defaults-{}-{}.json",
            std::process::id(),
            hex::encode(random)
        ))
    }

    fn observe_cli(
        governor: &TerminalGovernor,
        id: u32,
        bytes: u64,
        at_ms: u64,
        mut boundary: impl FnMut(u32, u64) -> Result<(), String>,
    ) {
        governor.observe_detailed(
            &[TerminalObservation {
                id,
                bytes,
                cli_key: Some("pkg:npm:@example/agent".into()),
            }],
            gib(16),
            gib(8),
            at_ms,
            &mut boundary,
        );
    }

    #[test]
    fn remembered_cli_default_requires_separate_confirmation_and_applied_grant() {
        let path = defaults_scratch();
        let governor = TerminalGovernor::with_defaults_path(path.clone());
        let allowance = base_allowance(gib(16));
        observe_cli(&governor, 8, allowance * 95 / 100, 1_000, |_, _| Ok(()));
        observe_cli(&governor, 8, allowance * 95 / 100, 3_000, |_, _| Ok(()));
        let request = governor.snapshot().sessions[0]
            .grant_request
            .clone()
            .unwrap();
        governor
            .grant(
                8,
                request.budget_generation,
                &request.request_id,
                512 * MIB,
                4_000,
            )
            .unwrap();
        let refused = governor.remember_default(
            8,
            &request.request_id,
            request.budget_generation,
            512 * MIB,
            false,
            5_000,
        );
        assert!(refused.is_err());
        assert!(!path.exists());
        let saved = governor
            .remember_default(
                8,
                &request.request_id,
                request.budget_generation,
                512 * MIB,
                true,
                6_000,
            )
            .unwrap();
        assert!(saved.persisted);
        let retry = governor
            .remember_default(
                8,
                &request.request_id,
                request.budget_generation,
                512 * MIB,
                true,
                7_000,
            )
            .unwrap();
        assert!(retry.idempotent);

        let next = TerminalGovernor::with_defaults_path(path.clone());
        let calls = std::cell::Cell::new(0);
        observe_cli(&next, 9, 100, 8_000, |id, raised| {
            assert_eq!(id, 9);
            assert_eq!(raised, allowance + 512 * MIB);
            calls.set(calls.get() + 1);
            Ok(())
        });
        let status = &next.snapshot().sessions[0];
        assert_eq!(status.remembered_default_bytes, 512 * MIB);
        assert_eq!(calls.get(), 1);
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("pkg:npm:@example/agent"));
        assert!(!body.contains("/Users/"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn cli_default_identity_prefers_package_and_never_persists_a_path() {
        let hint = crate::agentid::AgentHint {
            bin: "wrapped-agent".into(),
            pkg: Some("npm:@Example/Agent".into()),
            path: Some("/secret/work/wrapped-agent".into()),
            interactive: true,
        };
        assert_eq!(
            cli_key(Some(&hint)).as_deref(),
            Some("pkg:npm:@example/agent")
        );
    }

    #[test]
    fn snapshot_declares_refusal_only_non_renderer_fallback() {
        let snapshot = TerminalGovernor::default().snapshot();
        assert_eq!(
            snapshot.fallback_policy,
            "notify_natively_and_refuse_automatic_grant_pause_or_stop"
        );
    }

    #[test]
    fn remembered_defaults_refuse_oversized_files_before_json_parsing() {
        let path = defaults_scratch();
        std::fs::write(&path, vec![b' '; DEFAULTS_FILE_MAX as usize + 1]).unwrap();
        let error = load_remembered_defaults(&path).unwrap_err();
        assert!(error.contains("exceeds"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn remembered_defaults_refuse_a_new_entry_at_the_deterministic_cap() {
        let path = defaults_scratch();
        let values: HashMap<_, _> = (0..=DEFAULTS_ENTRY_CAP)
            .map(|index| (format!("bin:agent-{index}"), 512 * MIB))
            .collect();
        let error = persist_remembered_defaults(&path, &values).unwrap_err();
        assert!(error.contains("full"));
        assert!(!path.exists());
    }
}

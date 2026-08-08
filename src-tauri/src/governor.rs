//! Native terminal resource accounting and grant policy.
//!
//! This module deliberately stops at measurement and allowance management. It
//! does not signal a process, install a Job Object, or write a cgroup limit. The
//! common state machine can therefore ship before platform containment without
//! implying that an RSS/footprint reading is already a hard OS boundary.

use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

const GIB: u64 = 1024 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;
const WARN_NUM: u64 = 75;
const REQUEST_NUM: u64 = 90;
const CLEAR_NUM: u64 = 70;
const INCIDENT_CAP: usize = 256;
const GRANT_CHOICES: [u64; 2] = [512 * MIB, GIB];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetState {
    Normal,
    Warned,
    AwaitingGrant,
    OverAllowance,
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
    pub allowance_bytes: u64,
    pub current_bytes: u64,
    pub peak_bytes: u64,
    pub ema_bytes: u64,
    pub growth_bytes_per_second: f64,
    pub samples: u64,
    pub grant_request: Option<GrantRequest>,
}

#[derive(Clone, Debug, Serialize)]
pub struct GovernorSnapshot {
    pub capability: GovernorCapability,
    pub host_total_bytes: u64,
    pub host_available_bytes: u64,
    pub protected_reserve_bytes: u64,
    pub aggregate_terminal_bytes: u64,
    pub grantable_headroom_bytes: u64,
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

#[derive(Clone)]
struct AppliedGrant {
    request_id: String,
    budget_generation: u64,
    increment_bytes: u64,
}

struct SessionBudget {
    id: u32,
    budget_generation: u64,
    state: BudgetState,
    base_allowance_bytes: u64,
    granted_bytes: u64,
    current_bytes: u64,
    peak_bytes: u64,
    ema_bytes: f64,
    growth_bytes_per_second: f64,
    samples: u64,
    warn_streak: u8,
    last_sample_ms: u64,
    pending: Option<GrantRequest>,
    last_grant: Option<AppliedGrant>,
}

impl SessionBudget {
    fn allowance(&self) -> u64 {
        self.base_allowance_bytes.saturating_add(self.granted_bytes)
    }

    fn status(&self) -> TerminalBudgetStatus {
        TerminalBudgetStatus {
            id: self.id,
            budget_generation: self.budget_generation,
            state: self.state,
            base_allowance_bytes: self.base_allowance_bytes,
            granted_bytes: self.granted_bytes,
            allowance_bytes: self.allowance(),
            current_bytes: self.current_bytes,
            peak_bytes: self.peak_bytes,
            ema_bytes: self.ema_bytes.max(0.0).round() as u64,
            growth_bytes_per_second: self.growth_bytes_per_second,
            samples: self.samples,
            grant_request: self.pending.clone(),
        }
    }
}

struct GovernorInner {
    sessions: HashMap<u32, SessionBudget>,
    incidents: VecDeque<GovernorIncident>,
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
            next_request: 0,
            host_total_bytes: 0,
            host_available_bytes: 0,
            protected_reserve_bytes: 0,
            aggregate_terminal_bytes: 0,
        }
    }
}

#[derive(Default)]
pub struct TerminalGovernor(Mutex<GovernorInner>);

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

/// Admission is the one host-critical action that cannot corrupt existing
/// work: refuse a new process tree before it exists. Keep the IDE reserve
/// intact and treat the watchdog's critical level as independently decisive.
pub(crate) fn allows_new_terminal(
    total_bytes: u64,
    available_bytes: u64,
    pressure_level: u8,
) -> bool {
    pressure_level < crate::watchdog::MEM_CRIT && available_bytes > protected_reserve(total_bytes)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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
        sum.saturating_add(unused_allowance.min(session.granted_bytes))
    });
    inner
        .host_available_bytes
        .saturating_sub(inner.protected_reserve_bytes)
        .saturating_sub(unused_grants)
}

impl TerminalGovernor {
    /// Consume the process-tree totals the existing PTY monitor already paid to
    /// collect. `observations` is the full live set for this tick; absence means
    /// exit and releases the in-memory, one-session allowance.
    pub fn observe(
        &self,
        observations: &[(u32, u64)],
        host_total_bytes: u64,
        host_available_bytes: u64,
        at_ms: u64,
    ) -> Vec<GovernorEvent> {
        let mut inner = self.0.lock().unwrap();
        inner.host_total_bytes = host_total_bytes;
        inner.host_available_bytes = host_available_bytes;
        inner.protected_reserve_bytes = protected_reserve(host_total_bytes);
        inner.aggregate_terminal_bytes = observations
            .iter()
            .fold(0_u64, |sum, (_, bytes)| sum.saturating_add(*bytes));

        let live: std::collections::HashSet<u32> = observations.iter().map(|(id, _)| *id).collect();
        let ended: Vec<u32> = inner
            .sessions
            .keys()
            .filter(|id| !live.contains(id))
            .copied()
            .collect();
        for id in ended {
            if let Some(old) = inner.sessions.remove(&id) {
                push_incident(
                    &mut inner,
                    GovernorIncident {
                        at_ms,
                        id,
                        event: "session_exited",
                        from: Some(old.state),
                        to: None,
                        current_bytes: old.current_bytes,
                        allowance_bytes: old.allowance(),
                        detail: "one-session allowance released",
                    },
                );
            }
        }

        let mut events = Vec::new();
        for &(id, current) in observations {
            let base = base_allowance(host_total_bytes);
            // Work on an owned session so creating a request and recording an
            // incident cannot alias the sessions map's mutable borrow.
            let mut session = inner.sessions.remove(&id).unwrap_or_else(|| SessionBudget {
                id,
                budget_generation: 1,
                state: BudgetState::Normal,
                base_allowance_bytes: base,
                granted_bytes: 0,
                current_bytes: current,
                peak_bytes: current,
                ema_bytes: current as f64,
                growth_bytes_per_second: 0.0,
                samples: 0,
                warn_streak: 0,
                last_sample_ms: at_ms,
                pending: None,
                last_grant: None,
            });

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

            let target = if current >= allowance {
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
                BudgetState::Normal
            } else {
                session.state
            };

            if target != session.state {
                let from = session.state;
                session.state = target;
                session.budget_generation = session.budget_generation.saturating_add(1);
                session.pending = None;
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
                        detail: "monitor-only transition",
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
            sessions,
        }
    }

    pub fn snapshot(&self) -> GovernorSnapshot {
        Self::snapshot_locked(&self.0.lock().unwrap())
    }

    pub fn incidents(&self) -> Vec<GovernorIncident> {
        self.0.lock().unwrap().incidents.iter().cloned().collect()
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
        let mut inner = self.0.lock().unwrap();
        let reserve_headroom = grantable_headroom(&inner);
        let Some(session) = inner.sessions.get(&id) else {
            return Err(format!("no monitored terminal {id}"));
        };

        if let Some(applied) = &session.last_grant {
            if applied.request_id == request_id
                && applied.budget_generation == budget_generation
                && applied.increment_bytes == increment_bytes
            {
                return Ok(GrantOutcome {
                    applied: false,
                    idempotent: true,
                    status: session.status(),
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
            BudgetState::OverAllowance
        } else {
            BudgetState::Normal
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
    fn admission_preserves_host_reserve_and_refuses_critical_pressure() {
        assert!(allows_new_terminal(gib(16), gib(5), 0));
        assert!(!allows_new_terminal(gib(16), gib(4), 0));
        assert!(!allows_new_terminal(
            gib(16),
            gib(8),
            crate::watchdog::MEM_CRIT
        ));
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
        assert_eq!(events[0].status.state, BudgetState::Normal);
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
        assert_eq!(governor.incidents().last().unwrap().event, "session_exited");
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
}

//! Durable task envelopes and route attempts.
//!
//! A CLI session is an executor, not the task. This store reserves the task and
//! attempt ids before any process exists, so launch failures, retries and later
//! route changes all have one durable identity. SQLite is authoritative here:
//! one mutation maintains an envelope, an attempt and its ordered ledger in one
//! transaction. Large evidence stays in separately capped artifact files.

use crate::change::{self, Store};
use rusqlite::{
    params, types::Type, Connection, OpenFlags, OptionalExtension, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

const SCHEMA_VERSION: i64 = 2;
const ENVELOPE_SCHEMA_VERSION: i64 = 1;
const DEFAULT_ATTEMPT_CAP: i64 = 3;
const MAX_ATTEMPT_CAP: i64 = 8;
const DEFAULT_LIST: usize = 50;
const MAX_LIST: usize = 200;
const MAX_HISTORY_LIST: usize = 1000;
const MAX_GOAL_BYTES: usize = 16 * 1024;
const MAX_CONTEXT_BYTES: usize = 24 * 1024;
const MAX_ACCEPTANCE: usize = 32;
const MAX_ACCEPTANCE_BYTES: usize = 1024;
const MAX_POLICY_BYTES: usize = 16 * 1024;
const MAX_TITLE_BYTES: usize = 256;
const MAX_METADATA_BYTES: usize = 64 * 1024;
const MAX_TRANSCRIPT_BYTES: usize = 16 * 1024;
const MAX_TRANSCRIPT_LIST: usize = 2000;
const MAX_TRANSCRIPT_ENTRIES: i64 = 2000;
const MAX_EVENTS_PER_ATTEMPT: i64 = 1000;
const MAX_RUN_EVENTS: i64 = 1000;
const MAX_EVENT_METADATA_BYTES: usize = 16 * 1024;
const MAX_ARTIFACT_BYTES: usize = 2 * 1024 * 1024;
const MAX_ARTIFACTS_PER_ATTEMPT: i64 = 32;
const MAX_ARTIFACTS_PER_ENVELOPE: i64 = 100;
const MAX_ENVELOPE_ARTIFACT_BYTES: i64 = 100 * 1024 * 1024;
const MAX_GLOBAL_ARTIFACT_BYTES: i64 = 1024 * 1024 * 1024;

#[derive(Default)]
pub struct TaskStore {
    db: Mutex<Option<Connection>>,
    /// Test-only location. Production always uses ~/.canopy/tasks.sqlite.
    root: Option<PathBuf>,
}

/// A task identity already proven against the authoritative store. Only this
/// type may cross into a process spawn; strings from a WebView request cannot
/// become CANOPY_RUN_ID/CANOPY_ATTEMPT_ID without passing `spawn_binding`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AttemptBinding {
    pub run_id: String,
    pub attempt_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRouteSnapshot {
    pub cli: String,
    #[serde(default)]
    pub cli_version: Option<String>,
    #[serde(default)]
    pub executable_fingerprint: Option<String>,
    pub profile_id: String,
    #[serde(default)]
    pub requested_model: Option<String>,
    #[serde(default)]
    pub observed_model: Option<String>,
    pub harness_version: String,
    pub prompt_version: String,
    pub tool_policy_version: String,
    pub execution_mode: String,
    #[serde(default)]
    pub selection: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReserveInput {
    pub kind: String,
    pub project_id: String,
    pub component_id: String,
    pub worktree_path: String,
    pub goal: String,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub task_classes: Value,
    #[serde(default)]
    pub context_summary: String,
    #[serde(default = "default_risk")]
    pub risk_class: String,
    #[serde(default)]
    pub authority_policy: Value,
    #[serde(default)]
    pub failover_policy: Value,
    #[serde(default)]
    pub deadline_at: Option<i64>,
    #[serde(default)]
    pub attempt_cap: Option<i64>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub metadata: Value,
    pub route: TaskRouteSnapshot,
}

fn default_risk() -> String {
    "unknown".into()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttemptReserveInput {
    pub run_id: String,
    pub route: TaskRouteSnapshot,
    #[serde(default)]
    pub recovery_from_attempt_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttemptSettlement {
    pub attempt_id: String,
    pub state: String,
    #[serde(default)]
    pub failure_class: Option<String>,
    #[serde(default)]
    pub failure_code: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEnvelopeSummary {
    pub run_id: String,
    pub project_id: String,
    pub component_id: String,
    pub kind: String,
    pub title: Option<String>,
    pub status: String,
    pub attempt_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub metadata: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEnvelope {
    #[serde(flatten)]
    pub summary: TaskEnvelopeSummary,
    pub schema_version: i64,
    pub worktree_path: String,
    pub goal: String,
    pub acceptance: Vec<String>,
    pub task_classes: Value,
    pub context_summary: String,
    pub risk_class: String,
    pub authority_policy: Value,
    pub failover_policy: Value,
    pub deadline_at: Option<i64>,
    pub attempt_cap: i64,
    pub base_baseline_id: Option<String>,
    pub last_green_baseline_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskAttempt {
    pub attempt_id: String,
    pub run_id: String,
    pub ordinal: i64,
    pub state: String,
    pub route: TaskRouteSnapshot,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub failure_class: Option<String>,
    pub failure_code: Option<String>,
    pub recovery_from_attempt_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEnvelopeDetail {
    pub envelope: TaskEnvelope,
    pub attempts: Vec<TaskAttempt>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskReservation {
    pub envelope: TaskEnvelopeSummary,
    pub attempt: TaskAttempt,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskTranscriptEntry {
    pub seq: i64,
    pub run_id: String,
    pub attempt_id: Option<String>,
    pub kind: String,
    pub body: String,
    pub created_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifact {
    pub id: String,
    pub run_id: String,
    pub attempt_id: Option<String>,
    pub kind: String,
    pub bytes: i64,
    pub created_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEventInput {
    pub run_id: String,
    #[serde(default)]
    pub attempt_id: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub code: Option<String>,
    pub source: String,
    #[serde(default)]
    pub confidence: Option<String>,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default)]
    pub occurred_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub event_id: String,
    pub run_id: String,
    pub attempt_id: Option<String>,
    pub kind: String,
    pub code: Option<String>,
    pub source: String,
    pub confidence: Option<String>,
    pub metadata: Value,
    pub occurred_at: i64,
}

impl TaskStore {
    #[cfg(test)]
    fn at(root: PathBuf) -> Self {
        Self {
            db: Mutex::new(None),
            root: Some(root),
        }
    }

    fn paths(&self) -> Result<(PathBuf, PathBuf), String> {
        let root = match &self.root {
            Some(root) => root.clone(),
            None => PathBuf::from(std::env::var("HOME").map_err(|_| "no home dir".to_string())?)
                .join(".canopy"),
        };
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        Ok((root.join("tasks.sqlite"), root.join("task-artifacts")))
    }

    fn with_conn<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .db
            .lock()
            .map_err(|_| "task store lock poisoned".to_string())?;
        if guard.is_none() {
            let (path, artifacts) = self.paths()?;
            let conn = open_db(&path)?;
            reconcile_artifacts(&conn, &artifacts)?;
            *guard = Some(conn);
        }
        f(guard.as_mut().expect("task database was initialized"))
    }

    /** The native structured runner may start only the current running attempt
     *  in the workspace A2 reserved for it. */
    pub(crate) fn authorize_structured_attempt(
        &self,
        attempt_id: &str,
        cwd: &std::path::Path,
    ) -> Result<AttemptBinding, String> {
        validate_id(attempt_id, "attempt id")?;
        let (state, reserved, run_id): (String, String, String) = self.with_conn(|conn| {
            conn.query_row(
                "SELECT a.state, e.worktree_path, a.run_id FROM task_attempts a
                 JOIN task_envelopes e ON e.run_id = a.run_id
                 WHERE a.attempt_id = ?1",
                [attempt_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|_| "task attempt not found".to_string())
        })?;
        if state != "running" {
            return Err(format!("structured runner attempt is {state}, not running"));
        }
        let actual = cwd
            .canonicalize()
            .map_err(|error| format!("structured runner cwd is invalid: {error}"))?;
        let expected = std::path::Path::new(&reserved)
            .canonicalize()
            .map_err(|error| format!("reserved task workspace is invalid: {error}"))?;
        if actual != expected {
            return Err("structured runner cwd does not match its reserved task workspace".into());
        }
        Ok(AttemptBinding {
            run_id,
            attempt_id: attempt_id.to_string(),
        })
    }

    pub(crate) fn claim_attempt_active(&self, attempt_id: &str) -> Result<bool, String> {
        validate_id(attempt_id, "attempt id")?;
        self.with_conn(|conn| {
            conn.query_row(
                "SELECT state IN ('reserved', 'launching', 'running', 'waiting')
                 FROM task_attempts WHERE attempt_id = ?1",
                [attempt_id],
                |row| row.get(0),
            )
            .optional()
            .map(|active| active.unwrap_or(false))
            .map_err(|error| error.to_string())
        })
    }

    /// The one mutation boundary. Every successful transaction returns the
    /// stored project/run ids it changed; the pulse cannot be forgotten by a
    /// new caller because callers never announce changes themselves.
    fn mutate<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<(String, String, T), String>,
    ) -> Result<T, String> {
        let (scope, id, value) = self.with_conn(f)?;
        change::pulse(Store::Tasks, &scope, &id);
        Ok(value)
    }

    fn reserve(&self, input: TaskReserveInput) -> Result<TaskReservation, String> {
        validate_reserve(&input)?;
        let run_id = random_id("run")?;
        let attempt_id = random_id("attempt")?;
        let now = now_ms();
        let cap = input.attempt_cap.unwrap_or(DEFAULT_ATTEMPT_CAP);
        let acceptance = json(&input.acceptance, "acceptance")?;
        let task_classes = json(&input.task_classes, "task classes")?;
        let authority = json(&input.authority_policy, "authority policy")?;
        let failover = json(&input.failover_policy, "failover policy")?;
        let metadata = json(&input.metadata, "task metadata")?;
        let route_json = json(&input.route, "route")?;
        let project_id = input.project_id.clone();
        let component_id = input.component_id.clone();
        let kind = input.kind.clone();
        let title = input.title.clone();

        self.mutate(move |conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO task_envelopes (
                    run_id, schema_version, kind, project_id, component_id, worktree_path,
                    goal, acceptance_json, task_classes_json, context_summary, risk_class,
                    authority_policy_json, failover_policy_json, deadline_at, attempt_cap,
                    status, title, attempt_count, created_at, updated_at, metadata_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                           ?13, ?14, ?15, 'running', ?16, 1, ?17, ?17, ?18)",
                params![
                    run_id,
                    ENVELOPE_SCHEMA_VERSION,
                    input.kind,
                    input.project_id,
                    input.component_id,
                    input.worktree_path,
                    input.goal,
                    acceptance,
                    task_classes,
                    input.context_summary,
                    input.risk_class,
                    authority,
                    failover,
                    input.deadline_at,
                    cap,
                    input.title,
                    now,
                    metadata
                ],
            )
            .map_err(|e| e.to_string())?;
            insert_attempt(&tx, &attempt_id, &run_id, 1, &route_json, None, now)?;
            tx.commit().map_err(|e| e.to_string())?;

            let summary = TaskEnvelopeSummary {
                run_id: run_id.clone(),
                project_id: project_id.clone(),
                component_id,
                kind,
                title,
                status: "running".into(),
                attempt_count: 1,
                created_at: now,
                updated_at: now,
                metadata: input.metadata,
            };
            let attempt = TaskAttempt {
                attempt_id: attempt_id.clone(),
                run_id: run_id.clone(),
                ordinal: 1,
                state: "reserved".into(),
                route: input.route,
                started_at: None,
                ended_at: None,
                failure_class: None,
                failure_code: None,
                recovery_from_attempt_id: None,
            };
            Ok((
                project_id,
                run_id,
                TaskReservation {
                    envelope: summary,
                    attempt,
                },
            ))
        })
    }

    /// Validate the optional identity on a managed spawn. Both ids or neither:
    /// accepting one alone creates an identity no durable row can represent.
    pub(crate) fn spawn_binding(
        &self,
        run_id: Option<&str>,
        attempt_id: Option<&str>,
    ) -> Result<Option<AttemptBinding>, String> {
        let (run_id, attempt_id) = match (run_id, attempt_id) {
            (None, None) => return Ok(None),
            (Some(run_id), Some(attempt_id)) => (run_id, attempt_id),
            _ => return Err("a task spawn needs both runId and attemptId".into()),
        };
        validate_id(run_id, "run id")?;
        validate_id(attempt_id, "attempt id")?;
        let run_id = run_id.to_string();
        let attempt_id = attempt_id.to_string();
        self.mutate(move |conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            let project_id: Option<String> = tx
                .query_row(
                    "SELECT e.project_id FROM task_attempts a
                     JOIN task_envelopes e ON e.run_id = a.run_id
                     WHERE a.run_id = ?1 AND a.attempt_id = ?2
                       AND a.state = 'reserved'
                       AND a.ordinal = e.attempt_count
                       AND e.status = 'running'",
                    params![run_id, attempt_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            let Some(project_id) = project_id else {
                return Err("task attempt is not the current reserved attempt".into());
            };
            let changed = tx
                .execute(
                    "UPDATE task_attempts SET state = 'launching'
                     WHERE run_id = ?1 AND attempt_id = ?2 AND state = 'reserved'",
                    params![run_id, attempt_id],
                )
                .map_err(|e| e.to_string())?;
            if changed != 1 {
                return Err("task attempt was claimed by another launch".into());
            }
            tx.commit().map_err(|e| e.to_string())?;
            let binding = AttemptBinding {
                run_id: run_id.clone(),
                attempt_id,
            };
            Ok((project_id, run_id, Some(binding)))
        })
    }

    pub(crate) fn mark_spawned(&self, binding: &AttemptBinding) -> Result<(), String> {
        self.start_attempt(&binding.attempt_id).map(|_| ())
    }

    pub(crate) fn mark_launch_failed(&self, binding: &AttemptBinding) -> Result<(), String> {
        self.settle_attempt(TaskAttemptSettlement {
            attempt_id: binding.attempt_id.clone(),
            state: "failed".into(),
            failure_class: Some("route".into()),
            failure_code: Some("process-launch".into()),
        })
        .map(|_| ())
    }

    fn wait_attempt(&self, attempt_id: String) -> Result<TaskAttempt, String> {
        validate_id(&attempt_id, "attempt id")?;
        let now = now_ms();
        self.mutate(move |conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            let (run_id, project_id, state, ordinal, current): (String, String, String, i64, i64) =
                tx.query_row(
                    "SELECT a.run_id, e.project_id, a.state, a.ordinal, e.attempt_count
                     FROM task_attempts a JOIN task_envelopes e ON e.run_id = a.run_id
                     WHERE a.attempt_id = ?1",
                    [&attempt_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .map_err(|_| "task attempt not found".to_string())?;
            if state != "running" || ordinal != current {
                return Err("only the current running attempt can wait".into());
            }
            tx.execute(
                "UPDATE task_attempts SET state = 'waiting' WHERE attempt_id = ?1",
                [&attempt_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE task_envelopes SET status = 'blocked', updated_at = ?1 WHERE run_id = ?2",
                params![now, run_id],
            )
            .map_err(|e| e.to_string())?;
            let attempt = read_attempt(&tx, &attempt_id)?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok((project_id, run_id, attempt))
        })
    }

    fn reserve_attempt(&self, input: TaskAttemptReserveInput) -> Result<TaskAttempt, String> {
        validate_id(&input.run_id, "run id")?;
        validate_route(&input.route)?;
        if let Some(id) = &input.recovery_from_attempt_id {
            validate_id(id, "recovery attempt id")?;
        }
        let attempt_id = random_id("attempt")?;
        let route_json = json(&input.route, "route")?;
        let now = now_ms();
        self.mutate(move |conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            let (project_id, count, cap, status): (String, i64, i64, String) = tx
                .query_row(
                    "SELECT project_id, attempt_count, attempt_cap, status
                     FROM task_envelopes WHERE run_id = ?1",
                    [&input.run_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .map_err(|_| "task envelope not found".to_string())?;
            if matches!(status.as_str(), "completed" | "cancelled") {
                return Err(format!("task is already {status}"));
            }
            if count >= cap {
                return Err(format!("task attempt cap ({cap}) reached"));
            }
            let active: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM task_attempts
                     WHERE run_id = ?1 AND state IN ('reserved','launching','running','waiting'))",
                    [&input.run_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if active {
                return Err("task already has an active attempt".into());
            }
            if let Some(parent) = &input.recovery_from_attempt_id {
                let belongs: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM task_attempts WHERE attempt_id = ?1 AND run_id = ?2)",
                        params![parent, input.run_id],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if !belongs {
                    return Err("recovery attempt does not belong to this task".into());
                }
            }
            let ordinal = count + 1;
            insert_attempt(
                &tx,
                &attempt_id,
                &input.run_id,
                ordinal,
                &route_json,
                input.recovery_from_attempt_id.as_deref(),
                now,
            )?;
            tx.execute(
                "UPDATE task_envelopes SET attempt_count = ?1, status = 'running', updated_at = ?2
                 WHERE run_id = ?3",
                params![ordinal, now, input.run_id],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            let attempt = TaskAttempt {
                attempt_id: attempt_id.clone(),
                run_id: input.run_id.clone(),
                ordinal,
                state: "reserved".into(),
                route: input.route,
                started_at: None,
                ended_at: None,
                failure_class: None,
                failure_code: None,
                recovery_from_attempt_id: input.recovery_from_attempt_id,
            };
            Ok((project_id, input.run_id, attempt))
        })
    }

    fn start_attempt(&self, attempt_id: &str) -> Result<TaskAttempt, String> {
        validate_id(attempt_id, "attempt id")?;
        let attempt_id = attempt_id.to_string();
        let now = now_ms();
        self.mutate(move |conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            let (run_id, project_id, state, ordinal, current_ordinal, envelope_state): (
                String,
                String,
                String,
                i64,
                i64,
                String,
            ) = tx
                .query_row(
                    "SELECT a.run_id, e.project_id, a.state, a.ordinal,
                            e.attempt_count, e.status FROM task_attempts a
                     JOIN task_envelopes e ON e.run_id = a.run_id WHERE a.attempt_id = ?1",
                    [&attempt_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                        ))
                    },
                )
                .map_err(|_| "task attempt not found".to_string())?;
            if !matches!(state.as_str(), "reserved" | "launching") {
                return Err(format!("cannot start an attempt in state {state}"));
            }
            if ordinal != current_ordinal {
                return Err("cannot start a stale task attempt".into());
            }
            if matches!(
                envelope_state.as_str(),
                "completed" | "failed" | "cancelled"
            ) {
                return Err(format!("task is already {envelope_state}"));
            }
            tx.execute(
                "UPDATE task_attempts SET state = 'running', started_at = ?1 WHERE attempt_id = ?2",
                params![now, attempt_id],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE task_envelopes SET status = 'running', updated_at = ?1 WHERE run_id = ?2",
                params![now, run_id],
            )
            .map_err(|e| e.to_string())?;
            let attempt = read_attempt(&tx, &attempt_id)?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok((project_id, run_id, attempt))
        })
    }

    fn settle_attempt(&self, input: TaskAttemptSettlement) -> Result<TaskAttempt, String> {
        validate_id(&input.attempt_id, "attempt id")?;
        if !matches!(
            input.state.as_str(),
            "completed" | "failed" | "blocked" | "interrupted" | "cancelled"
        ) {
            return Err("attempt settlement state is not terminal".into());
        }
        bounded_opt(&input.failure_class, 128, "failure class")?;
        bounded_opt(&input.failure_code, 256, "failure code")?;
        let now = now_ms();
        self.mutate(move |conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            let (run_id, project_id, current, ordinal, count, cap, envelope_state): (
                String,
                String,
                String,
                i64,
                i64,
                i64,
                String,
            ) = tx
                .query_row(
                    "SELECT a.run_id, e.project_id, a.state, a.ordinal,
                            e.attempt_count, e.attempt_cap, e.status
                     FROM task_attempts a JOIN task_envelopes e ON e.run_id = a.run_id
                     WHERE a.attempt_id = ?1",
                    [&input.attempt_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                            row.get(5)?,
                            row.get(6)?,
                        ))
                    },
                )
                .map_err(|_| "task attempt not found".to_string())?;
            if current == input.state {
                let attempt = read_attempt(&tx, &input.attempt_id)?;
                tx.commit().map_err(|error| error.to_string())?;
                return Ok((project_id, run_id, attempt));
            }
            if !matches!(
                current.as_str(),
                "reserved" | "launching" | "running" | "waiting"
            ) {
                return Err(format!("attempt is already {current}"));
            }
            if ordinal != count {
                return Err("cannot settle a stale task attempt".into());
            }
            if matches!(envelope_state.as_str(), "completed" | "failed" | "cancelled") {
                return Err(format!("task is already {envelope_state}"));
            }
            tx.execute(
                "UPDATE task_attempts SET state = ?1, ended_at = ?2,
                    failure_class = ?3, failure_code = ?4 WHERE attempt_id = ?5",
                params![
                    input.state,
                    now,
                    input.failure_class,
                    input.failure_code,
                    input.attempt_id
                ],
            )
            .map_err(|e| e.to_string())?;
            let envelope_state = match input.state.as_str() {
                "completed" => "completed",
                "blocked" => "blocked",
                "cancelled" => "cancelled",
                _ if count >= cap => "failed",
                _ => "ready",
            };
            tx.execute(
                "UPDATE task_envelopes SET status = ?1, updated_at = ?2,
                    settled_at = CASE WHEN ?1 IN ('completed','failed','cancelled') THEN ?2 ELSE NULL END
                 WHERE run_id = ?3",
                params![envelope_state, now, run_id],
            )
            .map_err(|e| e.to_string())?;
            let attempt = read_attempt(&tx, &input.attempt_id)?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok((project_id, run_id, attempt))
        })
    }

    fn list(&self, project_id: &str, limit: usize) -> Result<Vec<TaskEnvelopeSummary>, String> {
        validate_text(project_id, 256, "project id", false)?;
        let limit = limit.clamp(1, MAX_LIST) as i64;
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT run_id, project_id, component_id, kind, title, status,
                            attempt_count, created_at, updated_at, metadata_json
                     FROM task_envelopes WHERE project_id = ?1
                     ORDER BY updated_at DESC LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map(params![project_id, limit], read_summary_row)
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        })
    }

    fn get(&self, run_id: &str) -> Result<Option<TaskEnvelopeDetail>, String> {
        validate_id(run_id, "run id")?;
        self.with_conn(|conn| read_detail(conn, run_id))
    }

    fn list_all(&self, limit: usize) -> Result<Vec<TaskEnvelopeSummary>, String> {
        let limit = limit.clamp(1, MAX_LIST) as i64;
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT run_id, project_id, component_id, kind, title, status,
                            attempt_count, created_at, updated_at, metadata_json
                     FROM task_envelopes ORDER BY updated_at DESC LIMIT ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([limit], read_summary_row)
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        })
    }

    fn list_history(&self, limit: usize) -> Result<Vec<TaskEnvelopeSummary>, String> {
        let limit = limit.clamp(1, MAX_HISTORY_LIST) as i64;
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT run_id, project_id, component_id, kind, title, status,
                            attempt_count, created_at, updated_at, metadata_json
                     FROM task_envelopes
                     WHERE json_extract(metadata_json, '$.history') = 1
                     ORDER BY updated_at DESC LIMIT ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([limit], read_summary_row)
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        })
    }

    fn update_metadata(
        &self,
        run_id: String,
        metadata: Value,
    ) -> Result<TaskEnvelopeSummary, String> {
        validate_id(&run_id, "run id")?;
        let encoded = json(&metadata, "task metadata")?;
        if encoded.len() > MAX_METADATA_BYTES {
            return Err(format!("task metadata exceeds {MAX_METADATA_BYTES} bytes"));
        }
        let now = now_ms();
        self.mutate(move |conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            let project_id: String = tx
                .query_row(
                    "SELECT project_id FROM task_envelopes WHERE run_id = ?1",
                    [&run_id],
                    |row| row.get(0),
                )
                .map_err(|_| "task envelope not found".to_string())?;
            tx.execute(
                "UPDATE task_envelopes SET metadata_json = ?1, updated_at = ?2 WHERE run_id = ?3",
                params![encoded, now, run_id],
            )
            .map_err(|e| e.to_string())?;
            let summary = tx
                .query_row(
                    "SELECT run_id, project_id, component_id, kind, title, status,
                            attempt_count, created_at, updated_at, metadata_json
                     FROM task_envelopes WHERE run_id = ?1",
                    [&run_id],
                    read_summary_row,
                )
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok((project_id, run_id, summary))
        })
    }

    fn interrupt_stale(&self, current_instance: &str) -> Result<usize, String> {
        validate_text(current_instance, 256, "app instance", false)?;
        let attempts = self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT a.attempt_id, a.state FROM task_attempts a
                     JOIN task_envelopes e ON e.run_id = a.run_id
                     WHERE a.state IN ('reserved','launching','running','waiting')
                       AND json_extract(e.metadata_json, '$.history') = 1
                       AND COALESCE(json_extract(e.metadata_json, '$.appInstance'), '') != ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([current_instance], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(rows)
        })?;
        let mut settled = 0;
        for (attempt_id, state) in attempts {
            if self
                .settle_attempt(TaskAttemptSettlement {
                    attempt_id,
                    state: if state == "waiting" {
                        "blocked".into()
                    } else {
                        "interrupted".into()
                    },
                    failure_class: Some(if state == "waiting" {
                        "human_required".into()
                    } else {
                        "route".into()
                    }),
                    failure_code: Some("previous-app-ended".into()),
                })
                .is_ok()
            {
                settled += 1;
            }
        }
        Ok(settled)
    }

    fn delete(&self, run_id: String) -> Result<(), String> {
        validate_id(&run_id, "run id")?;
        let (_, artifact_root) = self.paths()?;
        let deleted_run = run_id.clone();
        self.mutate(move |conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            let (project_id, status): (String, String) = tx
                .query_row(
                    "SELECT project_id, status FROM task_envelopes WHERE run_id = ?1",
                    [&run_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|_| "task envelope not found".to_string())?;
            if matches!(status.as_str(), "running" | "blocked") {
                return Err("a live task cannot be removed from history".into());
            }
            tx.execute("DELETE FROM task_envelopes WHERE run_id = ?1", [&run_id])
                .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok((project_id, run_id, ()))
        })?;
        let dir = artifact_root.join(deleted_run);
        if dir.exists() {
            let _ = std::fs::remove_dir_all(dir);
        }
        Ok(())
    }

    fn clear_history(&self) -> Result<usize, String> {
        let run_ids = self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT run_id FROM task_envelopes
                     WHERE json_extract(metadata_json, '$.history') = 1
                       AND status NOT IN ('running','blocked')",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(rows)
        })?;
        let mut deleted = 0;
        for run_id in run_ids {
            if self.delete(run_id).is_ok() {
                deleted += 1;
            }
        }
        Ok(deleted)
    }

    fn append_transcript(
        &self,
        run_id: String,
        attempt_id: Option<String>,
        kind: String,
        body: String,
    ) -> Result<TaskTranscriptEntry, String> {
        validate_id(&run_id, "run id")?;
        if let Some(id) = &attempt_id {
            validate_id(id, "attempt id")?;
        }
        if !matches!(
            kind.as_str(),
            "user" | "assistant" | "activity" | "question" | "error" | "route-switch" | "system"
        ) {
            return Err("unknown transcript entry kind".into());
        }
        validate_text(&body, MAX_TRANSCRIPT_BYTES, "transcript entry", true)?;
        let now = now_ms();
        self.mutate(move |conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            let project_id: String = tx
                .query_row(
                    "SELECT project_id FROM task_envelopes WHERE run_id = ?1",
                    [&run_id],
                    |row| row.get(0),
                )
                .map_err(|_| "task envelope not found".to_string())?;
            if let Some(id) = &attempt_id {
                let belongs: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM task_attempts WHERE attempt_id = ?1 AND run_id = ?2)",
                        params![id, run_id],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if !belongs {
                    return Err("transcript attempt does not belong to this task".into());
                }
            }
            let count: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM task_transcript WHERE run_id = ?1",
                    [&run_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if count >= MAX_TRANSCRIPT_ENTRIES {
                return Err("task transcript entry cap reached".into());
            }
            let seq: i64 = tx
                .query_row(
                    "SELECT COALESCE(MAX(seq), 0) + 1 FROM task_transcript WHERE run_id = ?1",
                    [&run_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO task_transcript (run_id, seq, attempt_id, kind, body, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![run_id, seq, attempt_id, kind, body, now],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE task_envelopes SET updated_at = ?1 WHERE run_id = ?2",
                params![now, run_id],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            let entry = TaskTranscriptEntry {
                seq,
                run_id: run_id.clone(),
                attempt_id,
                kind,
                body,
                created_at: now,
            };
            Ok((project_id, run_id, entry))
        })
    }

    fn transcript(&self, run_id: &str, limit: usize) -> Result<Vec<TaskTranscriptEntry>, String> {
        validate_id(run_id, "run id")?;
        let limit = limit.clamp(1, MAX_TRANSCRIPT_LIST) as i64;
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT seq, run_id, attempt_id, kind, body, created_at FROM (
                         SELECT seq, run_id, attempt_id, kind, body, created_at
                         FROM task_transcript WHERE run_id = ?1 ORDER BY seq DESC LIMIT ?2
                     ) ORDER BY seq ASC",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map(params![run_id, limit], |row| {
                    Ok(TaskTranscriptEntry {
                        seq: row.get(0)?,
                        run_id: row.get(1)?,
                        attempt_id: row.get(2)?,
                        kind: row.get(3)?,
                        body: row.get(4)?,
                        created_at: row.get(5)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        })
    }

    fn append_event(&self, input: TaskEventInput) -> Result<TaskEvent, String> {
        validate_id(&input.run_id, "run id")?;
        if let Some(id) = &input.attempt_id {
            validate_id(id, "attempt id")?;
        }
        validate_text(&input.kind, 128, "event kind", false)?;
        validate_text(&input.source, 128, "event source", false)?;
        bounded_opt(&input.code, 256, "event code")?;
        bounded_opt(&input.confidence, 64, "event confidence")?;
        let metadata_json = json(&input.metadata, "event metadata")?;
        if metadata_json.len() > MAX_EVENT_METADATA_BYTES {
            return Err(format!(
                "event metadata exceeds {MAX_EVENT_METADATA_BYTES} bytes"
            ));
        }
        let event_id = random_id("event")?;
        let at = input.occurred_at.unwrap_or_else(now_ms);
        self.mutate(move |conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            let project_id: String = tx
                .query_row(
                    "SELECT project_id FROM task_envelopes WHERE run_id = ?1",
                    [&input.run_id],
                    |row| row.get(0),
                )
                .map_err(|_| "task envelope not found".to_string())?;
            if let Some(id) = &input.attempt_id {
                let belongs: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM task_attempts WHERE attempt_id = ?1 AND run_id = ?2)",
                        params![id, input.run_id],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if !belongs {
                    return Err("event attempt does not belong to this task".into());
                }
                let count: i64 = tx
                    .query_row(
                        "SELECT COUNT(*) FROM task_events WHERE attempt_id = ?1",
                        [id],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if count >= MAX_EVENTS_PER_ATTEMPT {
                    return Err("task attempt event cap reached".into());
                }
            } else {
                let count: i64 = tx
                    .query_row(
                        "SELECT COUNT(*) FROM task_events
                         WHERE run_id = ?1 AND attempt_id IS NULL",
                        [&input.run_id],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if count >= MAX_RUN_EVENTS {
                    return Err("task run event cap reached".into());
                }
            }
            tx.execute(
                "INSERT INTO task_events (
                    event_id, run_id, attempt_id, kind, code, source, confidence, metadata_json, occurred_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    event_id,
                    input.run_id,
                    input.attempt_id,
                    input.kind,
                    input.code,
                    input.source,
                    input.confidence,
                    metadata_json,
                    at
                ],
            )
            .map_err(|e| e.to_string())?;
            tx.commit().map_err(|e| e.to_string())?;
            let event = TaskEvent {
                event_id,
                run_id: input.run_id.clone(),
                attempt_id: input.attempt_id,
                kind: input.kind,
                code: input.code,
                source: input.source,
                confidence: input.confidence,
                metadata: input.metadata,
                occurred_at: at,
            };
            Ok((project_id, input.run_id, event))
        })
    }

    fn events(&self, run_id: &str, limit: usize) -> Result<Vec<TaskEvent>, String> {
        validate_id(run_id, "run id")?;
        let limit = limit.clamp(1, MAX_TRANSCRIPT_LIST) as i64;
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT event_id, run_id, attempt_id, kind, code, source, confidence,
                            metadata_json, occurred_at FROM (
                         SELECT rowid AS event_rowid, event_id, run_id, attempt_id, kind,
                                code, source, confidence, metadata_json, occurred_at
                         FROM task_events WHERE run_id = ?1 ORDER BY event_rowid DESC LIMIT ?2
                     ) ORDER BY event_rowid ASC",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map(params![run_id, limit], |row| {
                    let metadata: String = row.get(7)?;
                    Ok(TaskEvent {
                        event_id: row.get(0)?,
                        run_id: row.get(1)?,
                        attempt_id: row.get(2)?,
                        kind: row.get(3)?,
                        code: row.get(4)?,
                        source: row.get(5)?,
                        confidence: row.get(6)?,
                        metadata: from_json(&metadata, 7)?,
                        occurred_at: row.get(8)?,
                    })
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())
        })
    }

    fn write_artifact(
        &self,
        run_id: String,
        attempt_id: Option<String>,
        kind: String,
        content: String,
    ) -> Result<TaskArtifact, String> {
        validate_id(&run_id, "run id")?;
        if let Some(id) = &attempt_id {
            validate_id(id, "attempt id")?;
        }
        validate_text(&kind, 64, "artifact kind", false)?;
        if content.len() > MAX_ARTIFACT_BYTES {
            return Err(format!("artifact exceeds {MAX_ARTIFACT_BYTES} bytes"));
        }
        let (_, artifact_root) = self.paths()?;
        let artifact_root = prepare_artifact_root(&artifact_root)?;
        let artifact_id = random_id("artifact")?;
        let bytes = content.len() as i64;
        let now = now_ms();
        self.mutate(move |conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|e| e.to_string())?;
            let project_id: String = tx
                .query_row(
                    "SELECT project_id FROM task_envelopes WHERE run_id = ?1",
                    [&run_id],
                    |row| row.get(0),
                )
                .map_err(|_| "task envelope not found".to_string())?;
            let total_count: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM task_artifacts WHERE run_id = ?1",
                    [&run_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if total_count >= MAX_ARTIFACTS_PER_ENVELOPE {
                return Err("task envelope artifact count cap reached".into());
            }
            if let Some(id) = &attempt_id {
                let count: i64 = tx
                    .query_row(
                        "SELECT COUNT(*) FROM task_artifacts WHERE attempt_id = ?1",
                        [id],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if count >= MAX_ARTIFACTS_PER_ATTEMPT {
                    return Err("task attempt artifact cap reached".into());
                }
                let belongs: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM task_attempts WHERE attempt_id = ?1 AND run_id = ?2)",
                        params![id, run_id],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                if !belongs {
                    return Err("artifact attempt does not belong to this task".into());
                }
            }
            let envelope_bytes: i64 = tx
                .query_row(
                    "SELECT COALESCE(SUM(bytes), 0) FROM task_artifacts WHERE run_id = ?1",
                    [&run_id],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if envelope_bytes + bytes > MAX_ENVELOPE_ARTIFACT_BYTES {
                return Err("task envelope artifact budget reached".into());
            }
            let global_bytes: i64 = tx
                .query_row("SELECT COALESCE(SUM(bytes), 0) FROM task_artifacts", [], |row| {
                    row.get(0)
                })
                .map_err(|e| e.to_string())?;
            if global_bytes + bytes > MAX_GLOBAL_ARTIFACT_BYTES {
                return Err("global task artifact budget reached".into());
            }

            let leaf = attempt_id.as_deref().unwrap_or("envelope");
            let dir = ensure_artifact_dir(&artifact_root, &run_id, leaf)?;
            let path = dir.join(&artifact_id);
            atomic_write(&path, content.as_bytes())?;
            let relative = path
                .strip_prefix(&artifact_root)
                .map_err(|_| "artifact path escaped its root".to_string())?
                .to_string_lossy()
                .to_string();
            if let Err(error) = tx.execute(
                "INSERT INTO task_artifacts (id, run_id, attempt_id, kind, path, bytes, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![artifact_id, run_id, attempt_id, kind, relative, bytes, now],
            ) {
                let _ = std::fs::remove_file(&path);
                return Err(error.to_string());
            }
            if let Err(error) = tx.commit() {
                let _ = std::fs::remove_file(&path);
                return Err(error.to_string());
            }
            let artifact = TaskArtifact {
                id: artifact_id,
                run_id: run_id.clone(),
                attempt_id,
                kind,
                bytes,
                created_at: now,
            };
            Ok((project_id, run_id, artifact))
        })
    }

    fn read_artifact(&self, id: &str) -> Result<String, String> {
        validate_id(id, "artifact id")?;
        let (_, artifact_root) = self.paths()?;
        let artifact_root = prepare_artifact_root(&artifact_root)?;
        self.with_conn(|conn| {
            let relative: String = conn
                .query_row(
                    "SELECT path FROM task_artifacts WHERE id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .map_err(|_| "task artifact not found".to_string())?;
            let path = contained_artifact_path(&artifact_root, &relative)?;
            std::fs::read_to_string(path).map_err(|e| e.to_string())
        })
    }
}

fn open_db(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if path.exists() {
        let probe = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string())?;
        let version: i64 = probe
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if version > SCHEMA_VERSION {
            return Err(format!(
                "task history was written by a newer Canopy (schema {version}); this version won't touch it"
            ));
        }
    }
    let mut conn = Connection::open(path).map_err(|e| e.to_string())?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if version > SCHEMA_VERSION {
        return Err(format!(
            "task history was written by a newer Canopy (schema {version}); this version won't touch it"
        ));
    }
    restrict(path);
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
        .map_err(|e| e.to_string())?;
    if version < 1 {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        create_schema(&tx)?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    } else if version < 2 {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            "ALTER TABLE task_envelopes
             ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';",
        )
        .map_err(|e| e.to_string())?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(conn)
}

fn create_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE task_envelopes (
             run_id TEXT PRIMARY KEY,
             schema_version INTEGER NOT NULL,
             kind TEXT NOT NULL,
             project_id TEXT NOT NULL,
             component_id TEXT NOT NULL,
             worktree_path TEXT NOT NULL,
             goal TEXT NOT NULL,
             acceptance_json TEXT NOT NULL,
             task_classes_json TEXT NOT NULL,
             context_summary TEXT NOT NULL,
             risk_class TEXT NOT NULL,
             authority_policy_json TEXT NOT NULL,
             failover_policy_json TEXT NOT NULL,
             deadline_at INTEGER,
             attempt_cap INTEGER NOT NULL,
             status TEXT NOT NULL,
             title TEXT,
             attempt_count INTEGER NOT NULL DEFAULT 0,
             base_baseline_id TEXT,
             last_green_baseline_id TEXT,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL,
             settled_at INTEGER
             ,metadata_json TEXT NOT NULL DEFAULT '{}'
         );
         CREATE INDEX task_envelopes_project_updated
             ON task_envelopes(project_id, updated_at DESC);
         CREATE TABLE task_attempts (
             attempt_id TEXT PRIMARY KEY,
             run_id TEXT NOT NULL REFERENCES task_envelopes(run_id) ON DELETE CASCADE,
             ordinal INTEGER NOT NULL,
             state TEXT NOT NULL,
             route_json TEXT NOT NULL,
             started_at INTEGER,
             ended_at INTEGER,
             failure_class TEXT,
             failure_code TEXT,
             recovery_from_attempt_id TEXT REFERENCES task_attempts(attempt_id),
             created_at INTEGER NOT NULL,
             UNIQUE(run_id, ordinal)
         );
         CREATE INDEX task_attempts_run ON task_attempts(run_id, ordinal);
         CREATE TABLE task_transcript (
             run_id TEXT NOT NULL REFERENCES task_envelopes(run_id) ON DELETE CASCADE,
             seq INTEGER NOT NULL,
             attempt_id TEXT REFERENCES task_attempts(attempt_id),
             kind TEXT NOT NULL,
             body TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             PRIMARY KEY(run_id, seq)
         );
         CREATE TABLE task_artifacts (
             id TEXT PRIMARY KEY,
             run_id TEXT NOT NULL REFERENCES task_envelopes(run_id) ON DELETE CASCADE,
             attempt_id TEXT REFERENCES task_attempts(attempt_id),
             kind TEXT NOT NULL,
             path TEXT NOT NULL,
             bytes INTEGER NOT NULL,
             created_at INTEGER NOT NULL
         );
         CREATE INDEX task_artifacts_run ON task_artifacts(run_id, attempt_id);
         CREATE TABLE task_events (
             event_id TEXT PRIMARY KEY,
             run_id TEXT NOT NULL REFERENCES task_envelopes(run_id) ON DELETE CASCADE,
             attempt_id TEXT REFERENCES task_attempts(attempt_id),
             kind TEXT NOT NULL,
             code TEXT,
             source TEXT NOT NULL,
             confidence TEXT,
             metadata_json TEXT NOT NULL,
             occurred_at INTEGER NOT NULL
         );
         CREATE INDEX task_events_run ON task_events(run_id, occurred_at);",
    )
    .map_err(|e| e.to_string())
}

/// Artifact files and their rows cannot share SQLite's commit boundary. Repair
/// both crash windows on open: drop rows whose file never landed, and remove
/// files whose row never committed. Symlinks are never followed.
fn reconcile_artifacts(conn: &Connection, root: &Path) -> Result<(), String> {
    let canonical_root = prepare_artifact_root(root)?;
    let rows = {
        let mut statement = conn
            .prepare("SELECT id, path FROM task_artifacts")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    let mut expected = HashSet::new();
    for (id, relative) in rows {
        match contained_artifact_path(&canonical_root, &relative) {
            Ok(_) => {
                expected.insert(relative);
            }
            Err(_) => {
                conn.execute("DELETE FROM task_artifacts WHERE id = ?1", [&id])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    remove_orphan_artifacts(&canonical_root, &canonical_root, &expected)?;
    Ok(())
}

fn remove_orphan_artifacts(
    root: &Path,
    dir: &Path,
    expected: &HashSet<String>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
            continue;
        }
        if meta.is_dir() {
            remove_orphan_artifacts(root, &path, expected)?;
            if std::fs::read_dir(&path)
                .map_err(|e| e.to_string())?
                .next()
                .is_none()
            {
                std::fs::remove_dir(path).map_err(|e| e.to_string())?;
            }
            continue;
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| "artifact path escaped its root".to_string())?
            .to_string_lossy()
            .to_string();
        if !expected.contains(&relative) {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn insert_attempt(
    conn: &Connection,
    attempt_id: &str,
    run_id: &str,
    ordinal: i64,
    route_json: &str,
    recovery_from: Option<&str>,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO task_attempts (
            attempt_id, run_id, ordinal, state, route_json, recovery_from_attempt_id, created_at
         ) VALUES (?1, ?2, ?3, 'reserved', ?4, ?5, ?6)",
        params![attempt_id, run_id, ordinal, route_json, recovery_from, now],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn read_summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskEnvelopeSummary> {
    Ok(TaskEnvelopeSummary {
        run_id: row.get(0)?,
        project_id: row.get(1)?,
        component_id: row.get(2)?,
        kind: row.get(3)?,
        title: row.get(4)?,
        status: row.get(5)?,
        attempt_count: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        metadata: {
            let raw: String = row.get(9)?;
            from_json(&raw, 9)?
        },
    })
}

fn read_attempt(conn: &Connection, attempt_id: &str) -> Result<TaskAttempt, String> {
    conn.query_row(
        "SELECT attempt_id, run_id, ordinal, state, route_json, started_at, ended_at,
                failure_class, failure_code, recovery_from_attempt_id
         FROM task_attempts WHERE attempt_id = ?1",
        [attempt_id],
        |row| {
            let route_json: String = row.get(4)?;
            Ok(TaskAttempt {
                attempt_id: row.get(0)?,
                run_id: row.get(1)?,
                ordinal: row.get(2)?,
                state: row.get(3)?,
                route: from_json(&route_json, 4)?,
                started_at: row.get(5)?,
                ended_at: row.get(6)?,
                failure_class: row.get(7)?,
                failure_code: row.get(8)?,
                recovery_from_attempt_id: row.get(9)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

fn read_detail(conn: &Connection, run_id: &str) -> Result<Option<TaskEnvelopeDetail>, String> {
    let row: Option<(
        String,
        i64,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        Option<i64>,
        i64,
        Option<String>,
        Option<String>,
        i64,
        Option<String>,
        Option<i64>,
        i64,
        i64,
        String,
    )> = conn
        .query_row(
            "SELECT run_id, schema_version, kind, project_id, component_id, worktree_path,
                    goal, acceptance_json, task_classes_json, context_summary, risk_class,
                    authority_policy_json, failover_policy_json, status, deadline_at, attempt_cap,
                    title, base_baseline_id, attempt_count, last_green_baseline_id, settled_at,
                    created_at, updated_at, metadata_json
             FROM task_envelopes WHERE run_id = ?1",
            [run_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                    row.get(8)?,
                    row.get(9)?,
                    row.get(10)?,
                    row.get(11)?,
                    row.get(12)?,
                    row.get(13)?,
                    row.get(14)?,
                    row.get(15)?,
                    row.get(16)?,
                    row.get(17)?,
                    row.get(18)?,
                    row.get(19)?,
                    row.get(20)?,
                    row.get(21)?,
                    row.get(22)?,
                    row.get(23)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(row) = row else { return Ok(None) };
    let summary = TaskEnvelopeSummary {
        run_id: row.0.clone(),
        project_id: row.3,
        component_id: row.4,
        kind: row.2,
        title: row.16,
        status: row.13,
        attempt_count: row.18,
        created_at: row.21,
        updated_at: row.22,
        metadata: serde_json::from_str(&row.23).map_err(|e| e.to_string())?,
    };
    let envelope = TaskEnvelope {
        summary,
        schema_version: row.1,
        worktree_path: row.5,
        goal: row.6,
        acceptance: serde_json::from_str(&row.7).map_err(|e| e.to_string())?,
        task_classes: serde_json::from_str(&row.8).map_err(|e| e.to_string())?,
        context_summary: row.9,
        risk_class: row.10,
        authority_policy: serde_json::from_str(&row.11).map_err(|e| e.to_string())?,
        failover_policy: serde_json::from_str(&row.12).map_err(|e| e.to_string())?,
        deadline_at: row.14,
        attempt_cap: row.15,
        base_baseline_id: row.17,
        last_green_baseline_id: row.19,
    };
    let mut statement = conn
        .prepare("SELECT attempt_id FROM task_attempts WHERE run_id = ?1 ORDER BY ordinal ASC")
        .map_err(|e| e.to_string())?;
    let ids = statement
        .query_map([run_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let attempts = ids
        .iter()
        .map(|id| read_attempt(conn, id))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(TaskEnvelopeDetail { envelope, attempts }))
}

fn validate_reserve(input: &TaskReserveInput) -> Result<(), String> {
    validate_text(&input.kind, 64, "task kind", false)?;
    validate_text(&input.project_id, 256, "project id", false)?;
    validate_text(&input.component_id, 256, "component id", false)?;
    validate_text(&input.worktree_path, 4096, "worktree path", false)?;
    validate_text(&input.goal, MAX_GOAL_BYTES, "goal", false)?;
    validate_text(
        &input.context_summary,
        MAX_CONTEXT_BYTES,
        "context summary",
        true,
    )?;
    validate_text(&input.risk_class, 128, "risk class", false)?;
    bounded_opt(&input.title, MAX_TITLE_BYTES, "title")?;
    if input.acceptance.len() > MAX_ACCEPTANCE {
        return Err(format!("acceptance criteria exceed {MAX_ACCEPTANCE} items"));
    }
    for criterion in &input.acceptance {
        validate_text(
            criterion,
            MAX_ACCEPTANCE_BYTES,
            "acceptance criterion",
            false,
        )?;
    }
    let cap = input.attempt_cap.unwrap_or(DEFAULT_ATTEMPT_CAP);
    if !(1..=MAX_ATTEMPT_CAP).contains(&cap) {
        return Err(format!(
            "attempt cap must be between 1 and {MAX_ATTEMPT_CAP}"
        ));
    }
    for (value, label) in [
        (&input.task_classes, "task classes"),
        (&input.authority_policy, "authority policy"),
        (&input.failover_policy, "failover policy"),
    ] {
        if json(value, label)?.len() > MAX_POLICY_BYTES {
            return Err(format!("{label} exceeds {MAX_POLICY_BYTES} bytes"));
        }
    }
    if json(&input.metadata, "task metadata")?.len() > MAX_METADATA_BYTES {
        return Err(format!("task metadata exceeds {MAX_METADATA_BYTES} bytes"));
    }
    validate_route(&input.route)
}

fn validate_route(route: &TaskRouteSnapshot) -> Result<(), String> {
    validate_text(&route.cli, 128, "route cli", false)?;
    validate_text(&route.profile_id, 256, "route profile", false)?;
    validate_text(&route.harness_version, 128, "harness version", false)?;
    validate_text(&route.prompt_version, 128, "prompt version", false)?;
    validate_text(
        &route.tool_policy_version,
        128,
        "tool policy version",
        false,
    )?;
    if !matches!(
        route.execution_mode.as_str(),
        "structured" | "oneshot" | "pty"
    ) {
        return Err("route execution mode must be structured, oneshot, or pty".into());
    }
    for (value, label) in [
        (&route.cli_version, "cli version"),
        (&route.executable_fingerprint, "executable fingerprint"),
        (&route.requested_model, "requested model"),
        (&route.observed_model, "observed model"),
    ] {
        bounded_opt(value, 512, label)?;
    }
    if json(&route.selection, "route selection")?.len() > MAX_POLICY_BYTES {
        return Err(format!("route selection exceeds {MAX_POLICY_BYTES} bytes"));
    }
    Ok(())
}

fn validate_id(id: &str, label: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(format!("invalid {label}"));
    }
    Ok(())
}

fn validate_text(value: &str, max: usize, label: &str, empty_ok: bool) -> Result<(), String> {
    if !empty_ok && value.trim().is_empty() {
        return Err(format!("{label} is required"));
    }
    if value.len() > max {
        return Err(format!("{label} exceeds {max} bytes"));
    }
    Ok(())
}

fn bounded_opt(value: &Option<String>, max: usize, label: &str) -> Result<(), String> {
    if let Some(value) = value {
        validate_text(value, max, label, true)?;
    }
    Ok(())
}

fn json<T: Serialize>(value: &T, label: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("could not encode {label}: {e}"))
}

fn from_json<T: serde::de::DeserializeOwned>(raw: &str, column: usize) -> rusqlite::Result<T> {
    serde_json::from_str(raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, Type::Text, Box::new(error))
    })
}

fn random_id(prefix: &str) -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|e| e.to_string())?;
    Ok(format!("{prefix}_{}", hex::encode(bytes)))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temp = path.with_extension(format!("tmp-{}", random_id("write")?));
    if let Err(error) = std::fs::write(&temp, bytes) {
        let _ = std::fs::remove_file(&temp);
        return Err(error.to_string());
    }
    restrict(&temp);
    if let Err(error) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(error.to_string());
    }
    restrict(path);
    Ok(())
}

fn ensure_artifact_dir(root: &Path, run_id: &str, leaf: &str) -> Result<PathBuf, String> {
    let canonical_root = prepare_artifact_root(root)?;
    let mut current = canonical_root.clone();
    for segment in [run_id, leaf] {
        validate_id(segment, "artifact directory")?;
        current.push(segment);
        match std::fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("artifact directory may not be a symlink".into())
            }
            Ok(meta) if !meta.is_dir() => {
                return Err("artifact directory is not a directory".into())
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&current).map_err(|e| e.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
        let canonical = current.canonicalize().map_err(|e| e.to_string())?;
        if !canonical.starts_with(&canonical_root) {
            return Err("artifact directory escaped its root".into());
        }
        current = canonical;
    }
    Ok(current)
}

fn prepare_artifact_root(root: &Path) -> Result<PathBuf, String> {
    match std::fs::symlink_metadata(root) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err("task artifact root may not be a symlink".into())
        }
        Ok(meta) if !meta.is_dir() => return Err("task artifact root is not a directory".into()),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    root.canonicalize().map_err(|e| e.to_string())
}

fn contained_artifact_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("artifact path escaped its root".into());
    }
    let canonical_root = root.canonicalize().map_err(|e| e.to_string())?;
    let path = canonical_root.join(relative);
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.starts_with(&canonical_root) {
        return Err("artifact path escaped its root".into());
    }
    Ok(canonical)
}

#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {}

#[tauri::command]
pub fn task_reserve(
    input: TaskReserveInput,
    store: State<'_, TaskStore>,
) -> Result<TaskReservation, String> {
    store.reserve(input)
}

#[tauri::command]
pub fn task_attempt_reserve(
    input: TaskAttemptReserveInput,
    store: State<'_, TaskStore>,
) -> Result<TaskAttempt, String> {
    store.reserve_attempt(input)
}

#[tauri::command]
pub fn task_attempt_start(
    attempt_id: String,
    store: State<'_, TaskStore>,
) -> Result<TaskAttempt, String> {
    store.start_attempt(&attempt_id)
}

#[tauri::command]
pub fn task_attempt_settle(
    app: tauri::AppHandle,
    input: TaskAttemptSettlement,
    store: State<'_, TaskStore>,
) -> Result<TaskAttempt, String> {
    let attempt_id = input.attempt_id.clone();
    let attempt = store.settle_attempt(input)?;
    crate::context::release_claims_for_attempt(&app, &attempt_id, "settled")?;
    Ok(attempt)
}

#[tauri::command]
pub fn task_attempt_wait(
    attempt_id: String,
    store: State<'_, TaskStore>,
) -> Result<TaskAttempt, String> {
    store.wait_attempt(attempt_id)
}

#[tauri::command]
pub fn task_list(
    project_id: String,
    limit: Option<usize>,
    store: State<'_, TaskStore>,
) -> Result<Vec<TaskEnvelopeSummary>, String> {
    store.list(&project_id, limit.unwrap_or(DEFAULT_LIST))
}

#[tauri::command]
pub fn task_get(
    run_id: String,
    store: State<'_, TaskStore>,
) -> Result<Option<TaskEnvelopeDetail>, String> {
    store.get(&run_id)
}

#[tauri::command]
pub fn task_list_all(
    limit: Option<usize>,
    store: State<'_, TaskStore>,
) -> Result<Vec<TaskEnvelopeSummary>, String> {
    store.list_all(limit.unwrap_or(DEFAULT_LIST))
}

#[tauri::command]
pub fn task_list_history(
    limit: Option<usize>,
    store: State<'_, TaskStore>,
) -> Result<Vec<TaskEnvelopeSummary>, String> {
    store.list_history(limit.unwrap_or(DEFAULT_LIST))
}

#[tauri::command]
pub fn task_update_metadata(
    run_id: String,
    metadata: Value,
    store: State<'_, TaskStore>,
) -> Result<TaskEnvelopeSummary, String> {
    store.update_metadata(run_id, metadata)
}

#[tauri::command]
pub fn task_interrupt_stale(
    current_instance: String,
    store: State<'_, TaskStore>,
) -> Result<usize, String> {
    store.interrupt_stale(&current_instance)
}

#[tauri::command]
pub fn task_delete(run_id: String, store: State<'_, TaskStore>) -> Result<(), String> {
    store.delete(run_id)
}

#[tauri::command]
pub fn task_clear_history(store: State<'_, TaskStore>) -> Result<usize, String> {
    store.clear_history()
}

#[tauri::command]
pub fn task_transcript_append(
    run_id: String,
    attempt_id: Option<String>,
    kind: String,
    body: String,
    store: State<'_, TaskStore>,
) -> Result<TaskTranscriptEntry, String> {
    store.append_transcript(run_id, attempt_id, kind, body)
}

#[tauri::command]
pub fn task_transcript_list(
    run_id: String,
    limit: Option<usize>,
    store: State<'_, TaskStore>,
) -> Result<Vec<TaskTranscriptEntry>, String> {
    store.transcript(&run_id, limit.unwrap_or(200))
}

#[tauri::command]
pub fn task_event_append(
    input: TaskEventInput,
    store: State<'_, TaskStore>,
) -> Result<TaskEvent, String> {
    store.append_event(input)
}

#[tauri::command]
pub fn task_event_list(
    run_id: String,
    limit: Option<usize>,
    store: State<'_, TaskStore>,
) -> Result<Vec<TaskEvent>, String> {
    store.events(&run_id, limit.unwrap_or(200))
}

#[tauri::command]
pub fn task_artifact_write(
    run_id: String,
    attempt_id: Option<String>,
    kind: String,
    content: String,
    store: State<'_, TaskStore>,
) -> Result<TaskArtifact, String> {
    store.write_artifact(run_id, attempt_id, kind, content)
}

#[tauri::command]
pub fn task_artifact_read(id: String, store: State<'_, TaskStore>) -> Result<String, String> {
    store.read_artifact(&id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        std::env::temp_dir().join(random_id("canopy-task-test").unwrap())
    }

    fn route(cli: &str) -> TaskRouteSnapshot {
        TaskRouteSnapshot {
            cli: cli.into(),
            cli_version: Some("1.0".into()),
            executable_fingerprint: Some("bin-1".into()),
            profile_id: "default".into(),
            requested_model: Some("frontier".into()),
            observed_model: None,
            harness_version: "1".into(),
            prompt_version: "1".into(),
            tool_policy_version: "1".into(),
            execution_mode: "structured".into(),
            selection: serde_json::json!({"eligible": [cli]}),
        }
    }

    fn input() -> TaskReserveInput {
        TaskReserveInput {
            kind: "vibe-turn".into(),
            project_id: "p1".into(),
            component_id: "web".into(),
            worktree_path: "/repo".into(),
            goal: "Fix checkout".into(),
            acceptance: vec!["payment succeeds".into()],
            task_classes: serde_json::json!({"localized_repair": 1.0}),
            context_summary: "Stripe sandbox".into(),
            risk_class: "reversible".into(),
            authority_policy: serde_json::json!({}),
            failover_policy: serde_json::json!({"automatic": false}),
            deadline_at: None,
            attempt_cap: Some(2),
            title: Some("Checkout".into()),
            metadata: serde_json::json!({"label": "Checkout"}),
            route: route("claude"),
        }
    }

    #[test]
    fn reserves_envelope_and_attempt_before_a_process_exists() {
        let root = root();
        let store = TaskStore::at(root.clone());
        let reservation = store.reserve(input()).unwrap();
        assert!(reservation.envelope.run_id.starts_with("run_"));
        assert!(reservation.attempt.attempt_id.starts_with("attempt_"));
        assert_eq!(reservation.attempt.state, "reserved");
        assert!(reservation.attempt.started_at.is_none());
        assert_eq!(store.list("p1", 50).unwrap().len(), 1);
        assert_eq!(reservation.envelope.metadata["label"], "Checkout");
        let binding = store
            .spawn_binding(
                Some(&reservation.envelope.run_id),
                Some(&reservation.attempt.attempt_id),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            binding,
            AttemptBinding {
                run_id: reservation.envelope.run_id.clone(),
                attempt_id: reservation.attempt.attempt_id.clone(),
            }
        );
        assert!(store
            .spawn_binding(
                Some(&reservation.envelope.run_id),
                Some(&reservation.attempt.attempt_id)
            )
            .unwrap_err()
            .contains("not the current reserved attempt"));
        store.mark_spawned(&binding).unwrap();
        assert_eq!(
            store
                .get(&reservation.envelope.run_id)
                .unwrap()
                .unwrap()
                .attempts[0]
                .state,
            "running"
        );
        drop(store);

        let reopened = TaskStore::at(root.clone());
        let detail = reopened.get(&reservation.envelope.run_id).unwrap().unwrap();
        assert_eq!(
            detail.attempts[0].attempt_id,
            reservation.attempt.attempt_id
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn structured_runner_authority_binds_running_attempt_to_reserved_workspace() {
        let root = root();
        let workspace = root.join("workspace");
        let other = root.join("other");
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let store = TaskStore::at(root.clone());
        let mut reserve = input();
        reserve.worktree_path = workspace.to_string_lossy().to_string();
        let reservation = store.reserve(reserve).unwrap();
        assert!(store
            .authorize_structured_attempt(&reservation.attempt.attempt_id, &workspace)
            .unwrap_err()
            .contains("not running"));
        store
            .start_attempt(&reservation.attempt.attempt_id)
            .unwrap();
        store
            .authorize_structured_attempt(&reservation.attempt.attempt_id, &workspace)
            .unwrap();
        assert!(store
            .authorize_structured_attempt(&reservation.attempt.attempt_id, &other)
            .unwrap_err()
            .contains("does not match"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn settled_attempts_cannot_take_new_claims() {
        let root = root();
        let store = TaskStore::at(root.clone());
        let reservation = store.reserve(input()).unwrap();
        store
            .start_attempt(&reservation.attempt.attempt_id)
            .unwrap();
        assert!(store
            .claim_attempt_active(&reservation.attempt.attempt_id)
            .unwrap());
        store
            .settle_attempt(TaskAttemptSettlement {
                attempt_id: reservation.attempt.attempt_id.clone(),
                state: "completed".into(),
                failure_class: None,
                failure_code: None,
            })
            .unwrap();
        assert!(!store
            .claim_attempt_active(&reservation.attempt.attempt_id)
            .unwrap());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn enforces_attempt_cap_and_recovery_parent() {
        let root = root();
        let store = TaskStore::at(root.clone());
        let first = store.reserve(input()).unwrap();
        assert!(store
            .reserve_attempt(TaskAttemptReserveInput {
                run_id: first.envelope.run_id.clone(),
                route: route("codex"),
                recovery_from_attempt_id: Some(first.attempt.attempt_id.clone()),
            })
            .unwrap_err()
            .contains("active attempt"));
        store
            .settle_attempt(TaskAttemptSettlement {
                attempt_id: first.attempt.attempt_id.clone(),
                state: "failed".into(),
                failure_class: Some("route".into()),
                failure_code: Some("quota-exhausted".into()),
            })
            .unwrap();
        let second = store
            .reserve_attempt(TaskAttemptReserveInput {
                run_id: first.envelope.run_id.clone(),
                route: route("codex"),
                recovery_from_attempt_id: Some(first.attempt.attempt_id.clone()),
            })
            .unwrap();
        assert_eq!(second.ordinal, 2);
        assert_eq!(
            second.recovery_from_attempt_id,
            Some(first.attempt.attempt_id)
        );
        let error = store
            .reserve_attempt(TaskAttemptReserveInput {
                run_id: first.envelope.run_id,
                route: route("claude"),
                recovery_from_attempt_id: None,
            })
            .unwrap_err();
        assert!(error.contains("attempt cap"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn terminal_settlement_is_idempotently_accepted() {
        let root = root();
        let store = TaskStore::at(root.clone());
        let reserved = store.reserve(input()).unwrap();
        store.start_attempt(&reserved.attempt.attempt_id).unwrap();
        let settlement = TaskAttemptSettlement {
            attempt_id: reserved.attempt.attempt_id,
            state: "completed".into(),
            failure_class: None,
            failure_code: None,
        };
        assert_eq!(
            store.settle_attempt(settlement.clone()).unwrap().state,
            "completed"
        );
        assert_eq!(store.settle_attempt(settlement).unwrap().state, "completed");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn launch_failure_settles_the_reserved_attempt() {
        let root = root();
        let store = TaskStore::at(root.clone());
        let reserved = store.reserve(input()).unwrap();
        let binding = store
            .spawn_binding(
                Some(&reserved.envelope.run_id),
                Some(&reserved.attempt.attempt_id),
            )
            .unwrap()
            .unwrap();
        store.mark_launch_failed(&binding).unwrap();
        let detail = store.get(&binding.run_id).unwrap().unwrap();
        assert_eq!(detail.attempts[0].state, "failed");
        assert_eq!(
            detail.attempts[0].failure_code.as_deref(),
            Some("process-launch")
        );
        assert!(store
            .spawn_binding(Some(&binding.run_id), Some(&binding.attempt_id))
            .unwrap_err()
            .contains("not the current reserved attempt"));
        assert!(store
            .spawn_binding(Some(&binding.run_id), None)
            .unwrap_err()
            .contains("both runId and attemptId"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn metadata_stale_sweep_and_history_delete_are_authoritative() {
        let root = root();
        let store = TaskStore::at(root.clone());
        let reserved = store.reserve(input()).unwrap();
        let binding = store
            .spawn_binding(
                Some(&reserved.envelope.run_id),
                Some(&reserved.attempt.attempt_id),
            )
            .unwrap()
            .unwrap();
        store.mark_spawned(&binding).unwrap();
        assert!(store
            .delete(binding.run_id.clone())
            .unwrap_err()
            .contains("live task"));
        let summary = store
            .update_metadata(
                binding.run_id.clone(),
                serde_json::json!({
                    "history": true,
                    "label": "Imported",
                    "appInstance": "old-instance"
                }),
            )
            .unwrap();
        assert_eq!(summary.metadata["label"], "Imported");
        assert_eq!(store.list_all(10).unwrap().len(), 1);
        assert_eq!(store.interrupt_stale("old-instance").unwrap(), 0);
        assert_eq!(store.interrupt_stale("current-instance").unwrap(), 1);
        assert_eq!(
            store.get(&binding.run_id).unwrap().unwrap().attempts[0].state,
            "interrupted"
        );
        store.delete(binding.run_id.clone()).unwrap();
        assert!(store.get(&binding.run_id).unwrap().is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_waiting_attempt_can_later_complete() {
        let root = root();
        let store = TaskStore::at(root.clone());
        let reserved = store.reserve(input()).unwrap();
        let binding = store
            .spawn_binding(
                Some(&reserved.envelope.run_id),
                Some(&reserved.attempt.attempt_id),
            )
            .unwrap()
            .unwrap();
        store.mark_spawned(&binding).unwrap();
        assert_eq!(
            store
                .wait_attempt(binding.attempt_id.clone())
                .unwrap()
                .state,
            "waiting"
        );
        assert_eq!(
            store
                .get(&binding.run_id)
                .unwrap()
                .unwrap()
                .envelope
                .summary
                .status,
            "blocked"
        );
        assert!(store
            .delete(binding.run_id.clone())
            .unwrap_err()
            .contains("live task"));
        assert_eq!(
            store
                .settle_attempt(TaskAttemptSettlement {
                    attempt_id: binding.attempt_id,
                    state: "completed".into(),
                    failure_class: None,
                    failure_code: None,
                })
                .unwrap()
                .state,
            "completed"
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn schema_one_migrates_metadata_without_rebuilding() {
        let root = root();
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("tasks.sqlite");
        let conn = Connection::open(&path).unwrap();
        create_schema(&conn).unwrap();
        conn.execute_batch(
            "ALTER TABLE task_envelopes DROP COLUMN metadata_json;
             PRAGMA user_version = 1;",
        )
        .unwrap();
        drop(conn);

        let store = TaskStore::at(root.clone());
        assert!(store.list_all(10).unwrap().is_empty());
        let conn = Connection::open(path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let has_metadata: bool = conn
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM pragma_table_info('task_envelopes')
                    WHERE name = 'metadata_json'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(has_metadata);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn transcript_and_artifacts_are_task_scoped_and_bounded() {
        let root = root();
        let store = TaskStore::at(root.clone());
        let reserved = store.reserve(input()).unwrap();
        let entry = store
            .append_transcript(
                reserved.envelope.run_id.clone(),
                Some(reserved.attempt.attempt_id.clone()),
                "user".into(),
                "Fix it".into(),
            )
            .unwrap();
        assert_eq!(entry.seq, 1);
        assert_eq!(
            store
                .transcript(&reserved.envelope.run_id, 20)
                .unwrap()
                .len(),
            1
        );
        let event = store
            .append_event(TaskEventInput {
                run_id: reserved.envelope.run_id.clone(),
                attempt_id: Some(reserved.attempt.attempt_id.clone()),
                kind: "watchdog-incident".into(),
                code: Some("W1".into()),
                source: "agent-watchdog".into(),
                confidence: Some("observed".into()),
                metadata: serde_json::json!({"since": 10, "at": 20}),
                occurred_at: Some(20),
            })
            .unwrap();
        assert_eq!(event.code.as_deref(), Some("W1"));
        assert_eq!(
            store.events(&reserved.envelope.run_id, 20).unwrap().len(),
            1
        );
        let artifact = store
            .write_artifact(
                reserved.envelope.run_id,
                Some(reserved.attempt.attempt_id),
                "output".into(),
                "bounded evidence".into(),
            )
            .unwrap();
        assert_eq!(
            store.read_artifact(&artifact.id).unwrap(),
            "bounded evidence"
        );
        let orphan = root.join("task-artifacts").join("orphan");
        std::fs::write(&orphan, "uncommitted").unwrap();
        drop(store);
        let reopened = TaskStore::at(root.clone());
        reopened.list("p1", 1).unwrap();
        assert!(!orphan.exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn bounded_reads_return_the_newest_window_in_order() {
        let root = root();
        let store = TaskStore::at(root.clone());
        let reserved = store.reserve(input()).unwrap();
        for body in ["one", "two", "three"] {
            store
                .append_transcript(
                    reserved.envelope.run_id.clone(),
                    Some(reserved.attempt.attempt_id.clone()),
                    "activity".into(),
                    body.into(),
                )
                .unwrap();
            store
                .append_event(TaskEventInput {
                    run_id: reserved.envelope.run_id.clone(),
                    attempt_id: Some(reserved.attempt.attempt_id.clone()),
                    kind: "activity".into(),
                    code: Some(body.into()),
                    source: "test".into(),
                    confidence: None,
                    metadata: Value::Null,
                    occurred_at: Some(1),
                })
                .unwrap();
        }
        assert_eq!(
            store
                .transcript(&reserved.envelope.run_id, 2)
                .unwrap()
                .into_iter()
                .map(|entry| entry.body)
                .collect::<Vec<_>>(),
            vec!["two", "three"]
        );
        assert_eq!(
            store
                .events(&reserved.envelope.run_id, 2)
                .unwrap()
                .into_iter()
                .map(|event| event.code.unwrap())
                .collect::<Vec<_>>(),
            vec!["two", "three"]
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn refuses_newer_authoritative_schemas() {
        let root = root();
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("tasks.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA user_version = 99").unwrap();
        drop(conn);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        let store = TaskStore::at(root.clone());
        let error = store.list("p1", 1).unwrap_err();
        assert!(error.contains("newer Canopy"));
        let conn = Connection::open(path).unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 99);
        assert!(!root.join("tasks.sqlite-wal").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(root.join("tasks.sqlite"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o644
            );
        }
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn envelope_artifact_count_is_bounded() {
        let root = root();
        let store = TaskStore::at(root.clone());
        let reserved = store.reserve(input()).unwrap();
        for _ in 0..MAX_ARTIFACTS_PER_ENVELOPE {
            store
                .write_artifact(
                    reserved.envelope.run_id.clone(),
                    None,
                    "checkpoint".into(),
                    String::new(),
                )
                .unwrap();
        }
        assert!(store
            .write_artifact(
                reserved.envelope.run_id,
                None,
                "checkpoint".into(),
                String::new(),
            )
            .unwrap_err()
            .contains("artifact count cap"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn artifact_root_symlink_is_rejected_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let root = root();
        let target = root.with_extension("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        let victim = target.join("keep-me");
        std::fs::write(&victim, "safe").unwrap();
        symlink(&target, root.join("task-artifacts")).unwrap();

        let store = TaskStore::at(root.clone());
        assert!(store
            .reserve(input())
            .unwrap_err()
            .contains("root may not be a symlink"));
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "safe");
        let _ = std::fs::remove_dir_all(root);
        let _ = std::fs::remove_dir_all(target);
    }

    #[test]
    fn rejects_oversized_and_path_like_inputs() {
        let root = root();
        let store = TaskStore::at(root.clone());
        let mut oversized = input();
        oversized.goal = "x".repeat(MAX_GOAL_BYTES + 1);
        assert!(store
            .reserve(oversized)
            .unwrap_err()
            .contains("goal exceeds"));
        assert!(store
            .read_artifact("../secret")
            .unwrap_err()
            .contains("invalid artifact id"));
        assert!(contained_artifact_path(Path::new("/safe"), "../secret").is_err());
        assert!(contained_artifact_path(Path::new("/safe"), "/secret").is_err());

        let reserved = store.reserve(input()).unwrap();
        assert!(store
            .append_transcript(
                reserved.envelope.run_id.clone(),
                None,
                "system".into(),
                "x".repeat(MAX_TRANSCRIPT_BYTES + 1),
            )
            .unwrap_err()
            .contains("transcript entry exceeds"));
        assert!(store
            .write_artifact(
                reserved.envelope.run_id.clone(),
                Some(reserved.attempt.attempt_id.clone()),
                "output".into(),
                "x".repeat(MAX_ARTIFACT_BYTES + 1),
            )
            .unwrap_err()
            .contains("artifact exceeds"));
        assert!(store
            .append_event(TaskEventInput {
                run_id: reserved.envelope.run_id,
                attempt_id: Some(reserved.attempt.attempt_id),
                kind: "failure".into(),
                code: Some("route.rate_limit".into()),
                source: "failure-classifier".into(),
                confidence: Some("inferred".into()),
                metadata: serde_json::json!({"raw": "x".repeat(MAX_EVENT_METADATA_BYTES + 1)}),
                occurred_at: None,
            })
            .unwrap_err()
            .contains("event metadata exceeds"));
        let _ = std::fs::remove_dir_all(root);
    }
}

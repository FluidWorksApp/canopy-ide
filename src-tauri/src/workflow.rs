//! Durable workflow-run authority.
//!
//! Definitions are validated in the frontend against the same project facts
//! used by Build setup. This store owns only execution state: the exact
//! definition snapshot and trigger provenance that created a run, the current
//! step, edges taken, and references to TaskEnvelope attempts. Attempt output
//! and verification evidence remain in the task ledger.

use crate::change::{self, Store};
use rusqlite::{
    params, types::Type, Connection, OpenFlags, OptionalExtension, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

const SCHEMA_VERSION: i64 = 1;
const RUN_SCHEMA_VERSION: i64 = 1;
const DEFAULT_LIST: usize = 50;
const MAX_LIST: usize = 200;
const MAX_STEPS: usize = 128;
const MAX_DEFINITION_BYTES: usize = 256 * 1024;
const MAX_TRIGGER_BYTES: usize = 32 * 1024;

#[derive(Default)]
pub struct WorkflowStore {
    db: Mutex<Option<Connection>>,
    /// Test-only location. Production uses ~/.canopy/workflows.sqlite.
    root: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStepSeed {
    pub id: String,
    pub kind: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunCreateInput {
    pub project_id: String,
    pub definition_id: String,
    pub definition_version: String,
    pub definition_hash: String,
    pub definition: Value,
    pub trigger_kind: String,
    pub trigger: Value,
    pub start_step_id: String,
    pub steps: Vec<WorkflowStepSeed>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStepRecordInput {
    pub run_id: String,
    pub step_id: String,
    pub state: String,
    #[serde(default)]
    pub attempt_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunAdvanceInput {
    pub run_id: String,
    pub step_id: String,
    pub step_state: String,
    pub outcome: String,
    pub target: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunSummary {
    pub run_id: String,
    pub project_id: String,
    pub definition_id: String,
    pub definition_version: String,
    pub definition_hash: String,
    pub trigger_kind: String,
    pub status: String,
    pub current_step_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStepState {
    pub id: String,
    pub kind: String,
    pub state: String,
    pub attempt_ids: Vec<String>,
    pub round: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEdgeTaken {
    pub seq: i64,
    pub from_step_id: String,
    pub outcome: String,
    pub target: String,
    pub taken_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunDetail {
    #[serde(flatten)]
    pub summary: WorkflowRunSummary,
    pub definition: Value,
    pub trigger: Value,
    pub steps: Vec<WorkflowStepState>,
    pub edges: Vec<WorkflowEdgeTaken>,
}

impl WorkflowStore {
    #[cfg(test)]
    fn at(root: PathBuf) -> Self {
        Self {
            db: Mutex::new(None),
            root: Some(root),
        }
    }

    fn path(&self) -> Result<PathBuf, String> {
        let root = match &self.root {
            Some(root) => root.clone(),
            None => PathBuf::from(std::env::var("HOME").map_err(|_| "no home dir".to_string())?)
                .join(".canopy"),
        };
        std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        Ok(root.join("workflows.sqlite"))
    }

    fn with_conn<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .db
            .lock()
            .map_err(|_| "workflow store lock poisoned".to_string())?;
        if guard.is_none() {
            let mut conn = open_db(&self.path()?)?;
            reconcile_interrupted(&mut conn)?;
            *guard = Some(conn);
        }
        f(guard.as_mut().expect("workflow database was initialized"))
    }

    /// The one write boundary. Any author that mutates workflow state inherits
    /// the store pulse; reads can never accidentally create a refresh loop.
    fn mutate<T>(
        &self,
        f: impl FnOnce(&mut Connection) -> Result<(String, String, T), String>,
    ) -> Result<T, String> {
        let (scope, id, value) = self.with_conn(f)?;
        change::pulse(Store::Workflows, &scope, &id);
        Ok(value)
    }

    fn create(&self, input: WorkflowRunCreateInput) -> Result<WorkflowRunDetail, String> {
        validate_create(&input)?;
        let run_id = random_id("workflow")?;
        let now = now_ms();
        let definition_json = encode(&input.definition, "workflow definition")?;
        let trigger_json = encode(&input.trigger, "workflow trigger")?;
        let project_id = input.project_id.clone();
        let changed_id = run_id.clone();
        self.mutate(move |conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT INTO workflow_runs (
                    run_id, schema_version, project_id, definition_id, definition_version,
                    definition_hash, definition_json, trigger_kind, trigger_json, status,
                    current_step_id, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'running', ?10, ?11, ?11)",
                params![
                    run_id,
                    RUN_SCHEMA_VERSION,
                    input.project_id,
                    input.definition_id,
                    input.definition_version,
                    input.definition_hash,
                    definition_json,
                    input.trigger_kind,
                    trigger_json,
                    input.start_step_id,
                    now,
                ],
            )
            .map_err(|error| error.to_string())?;
            for (ordinal, step) in input.steps.iter().enumerate() {
                let state = if step.id == input.start_step_id {
                    "running"
                } else {
                    "pending"
                };
                tx.execute(
                    "INSERT INTO workflow_steps (
                        run_id, step_id, ordinal, kind, state, round, created_at, updated_at
                     ) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)",
                    params![run_id, step.id, ordinal as i64, step.kind, state, now],
                )
                .map_err(|error| error.to_string())?;
            }
            tx.commit().map_err(|error| error.to_string())?;
            let detail = read_detail(conn, &run_id)?
                .ok_or_else(|| "workflow run disappeared".to_string())?;
            Ok((project_id, changed_id, detail))
        })
    }

    fn record_step(&self, input: WorkflowStepRecordInput) -> Result<WorkflowRunDetail, String> {
        validate_id(&input.run_id, "workflow run id")?;
        validate_id(&input.step_id, "workflow step id")?;
        if !matches!(input.state.as_str(), "running" | "waiting") {
            return Err("workflow step record state must be running or waiting".into());
        }
        if let Some(id) = &input.attempt_id {
            validate_id(id, "task attempt id")?;
        }
        let changed_id = input.run_id.clone();
        self.mutate(move |conn| {
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let project_id = current_project(&tx, &input.run_id, &input.step_id)?;
            if let Some(attempt_id) = &input.attempt_id {
                let ordinal: i64 = tx
                    .query_row(
                        "SELECT COALESCE(MAX(ordinal), 0) + 1 FROM workflow_step_attempts
                     WHERE run_id = ?1 AND step_id = ?2",
                        params![input.run_id, input.step_id],
                        |row| row.get(0),
                    )
                    .map_err(|error| error.to_string())?;
                tx.execute(
                    "INSERT INTO workflow_step_attempts (run_id, step_id, ordinal, attempt_id)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![input.run_id, input.step_id, ordinal, attempt_id],
                )
                .map_err(|error| error.to_string())?;
            }
            let now = now_ms();
            tx.execute(
                "UPDATE workflow_steps SET state = ?1, updated_at = ?2
                 WHERE run_id = ?3 AND step_id = ?4",
                params![input.state, now, input.run_id, input.step_id],
            )
            .map_err(|error| error.to_string())?;
            tx.execute(
                "UPDATE workflow_runs SET status = ?1, updated_at = ?2 WHERE run_id = ?3",
                params![
                    if input.state == "waiting" {
                        "waiting"
                    } else {
                        "running"
                    },
                    now,
                    input.run_id
                ],
            )
            .map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())?;
            let detail = read_detail(conn, &input.run_id)?
                .ok_or_else(|| "workflow run disappeared".to_string())?;
            Ok((project_id, changed_id, detail))
        })
    }

    fn advance(&self, input: WorkflowRunAdvanceInput) -> Result<WorkflowRunDetail, String> {
        validate_id(&input.run_id, "workflow run id")?;
        validate_id(&input.step_id, "workflow step id")?;
        validate_text(&input.outcome, 128, "workflow outcome")?;
        if !matches!(input.step_state.as_str(), "completed" | "failed") {
            return Err("workflow step must settle completed or failed".into());
        }
        let terminal = matches!(
            input.target.as_str(),
            "$completed" | "$failed" | "$cancelled"
        );
        if !terminal {
            validate_id(&input.target, "workflow edge target")?;
        }
        let changed_id = input.run_id.clone();
        self.mutate(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let project_id = current_project(&tx, &input.run_id, &input.step_id)?;
            if !terminal {
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM workflow_steps WHERE run_id = ?1 AND step_id = ?2)",
                    params![input.run_id, input.target],
                    |row| row.get(0),
                ).map_err(|error| error.to_string())?;
                if !exists { return Err("workflow edge target does not exist".into()); }
            }
            let now = now_ms();
            tx.execute(
                "UPDATE workflow_steps SET state = ?1, updated_at = ?2 WHERE run_id = ?3 AND step_id = ?4",
                params![input.step_state, now, input.run_id, input.step_id],
            ).map_err(|error| error.to_string())?;
            let seq: i64 = tx.query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM workflow_edges WHERE run_id = ?1",
                [&input.run_id],
                |row| row.get(0),
            ).map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT INTO workflow_edges (run_id, seq, from_step_id, outcome, target, taken_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![input.run_id, seq, input.step_id, input.outcome, input.target, now],
            ).map_err(|error| error.to_string())?;
            if terminal {
                tx.execute(
                    "UPDATE workflow_runs SET status = ?1, current_step_id = NULL, updated_at = ?2 WHERE run_id = ?3",
                    params![input.target.trim_start_matches('$'), now, input.run_id],
                ).map_err(|error| error.to_string())?;
            } else {
                tx.execute(
                    "UPDATE workflow_steps SET state = 'running',
                        round = round + 1, updated_at = ?1 WHERE run_id = ?2 AND step_id = ?3",
                    params![now, input.run_id, input.target],
                ).map_err(|error| error.to_string())?;
                tx.execute(
                    "UPDATE workflow_runs SET status = 'running', current_step_id = ?1, updated_at = ?2
                     WHERE run_id = ?3",
                    params![input.target, now, input.run_id],
                ).map_err(|error| error.to_string())?;
            }
            tx.commit().map_err(|error| error.to_string())?;
            let detail = read_detail(conn, &input.run_id)?.ok_or_else(|| "workflow run disappeared".to_string())?;
            Ok((project_id, changed_id, detail))
        })
    }

    fn resume(&self, run_id: String) -> Result<WorkflowRunDetail, String> {
        validate_id(&run_id, "workflow run id")?;
        let changed_id = run_id.clone();
        self.mutate(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|error| error.to_string())?;
            let (project_id, current, status): (String, Option<String>, String) = tx.query_row(
                "SELECT project_id, current_step_id, status FROM workflow_runs WHERE run_id = ?1",
                [&run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).map_err(|_| "workflow run not found".to_string())?;
            if status != "interrupted" { return Err("only an interrupted workflow can resume".into()); }
            let current = current.ok_or_else(|| "interrupted workflow has no current step".to_string())?;
            let now = now_ms();
            tx.execute(
                "UPDATE workflow_steps SET state = 'running', updated_at = ?1 WHERE run_id = ?2 AND step_id = ?3",
                params![now, run_id, current],
            ).map_err(|error| error.to_string())?;
            tx.execute(
                "UPDATE workflow_runs SET status = 'running', updated_at = ?1 WHERE run_id = ?2",
                params![now, run_id],
            ).map_err(|error| error.to_string())?;
            tx.commit().map_err(|error| error.to_string())?;
            let detail = read_detail(conn, &run_id)?.ok_or_else(|| "workflow run disappeared".to_string())?;
            Ok((project_id, changed_id, detail))
        })
    }

    fn list(&self, project_id: &str, limit: usize) -> Result<Vec<WorkflowRunSummary>, String> {
        validate_text(project_id, 256, "project id")?;
        let limit = limit.clamp(1, MAX_LIST) as i64;
        self.with_conn(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT run_id, project_id, definition_id, definition_version, definition_hash,
                        trigger_kind, status, current_step_id, created_at, updated_at
                 FROM workflow_runs WHERE project_id = ?1 ORDER BY updated_at DESC LIMIT ?2",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![project_id, limit], read_summary_row)
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            Ok(rows)
        })
    }

    fn get(&self, run_id: &str) -> Result<Option<WorkflowRunDetail>, String> {
        validate_id(run_id, "workflow run id")?;
        self.with_conn(|conn| read_detail(conn, run_id))
    }
}

fn current_project(conn: &Connection, run_id: &str, step_id: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT project_id FROM workflow_runs
         WHERE run_id = ?1 AND current_step_id = ?2 AND status IN ('running', 'waiting')",
        params![run_id, step_id],
        |row| row.get(0),
    )
    .map_err(|_| "workflow step is not the current active step".to_string())
}

fn validate_create(input: &WorkflowRunCreateInput) -> Result<(), String> {
    validate_text(&input.project_id, 256, "project id")?;
    validate_id(&input.definition_id, "workflow definition id")?;
    validate_text(
        &input.definition_version,
        128,
        "workflow definition version",
    )?;
    validate_text(&input.definition_hash, 128, "workflow definition hash")?;
    validate_text(&input.trigger_kind, 128, "workflow trigger kind")?;
    validate_id(&input.start_step_id, "workflow start step id")?;
    if input.steps.is_empty() || input.steps.len() > MAX_STEPS {
        return Err(format!(
            "workflow must contain between 1 and {MAX_STEPS} steps"
        ));
    }
    let definition = encode(&input.definition, "workflow definition")?;
    if definition.len() > MAX_DEFINITION_BYTES {
        return Err("workflow definition is too large".into());
    }
    let trigger = encode(&input.trigger, "workflow trigger")?;
    if trigger.len() > MAX_TRIGGER_BYTES {
        return Err("workflow trigger provenance is too large".into());
    }
    let mut ids = HashSet::new();
    for step in &input.steps {
        validate_id(&step.id, "workflow step id")?;
        validate_text(&step.kind, 64, "workflow step kind")?;
        if !ids.insert(&step.id) {
            return Err("workflow step ids must be unique".into());
        }
    }
    if !ids.contains(&input.start_step_id) {
        return Err("workflow start step does not exist".into());
    }
    Ok(())
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
        .map_err(|error| error.to_string())?;
        let version: i64 = probe
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if version > SCHEMA_VERSION {
            return Err(format!("workflow history was written by a newer Canopy (schema {version}); this version won't touch it"));
        }
    }
    let mut conn = Connection::open(path).map_err(|error| error.to_string())?;
    restrict(path);
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")
        .map_err(|error| error.to_string())?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version < 1 {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        tx.execute_batch(
            "CREATE TABLE workflow_runs (
                 run_id TEXT PRIMARY KEY,
                 schema_version INTEGER NOT NULL,
                 project_id TEXT NOT NULL,
                 definition_id TEXT NOT NULL,
                 definition_version TEXT NOT NULL,
                 definition_hash TEXT NOT NULL,
                 definition_json TEXT NOT NULL,
                 trigger_kind TEXT NOT NULL,
                 trigger_json TEXT NOT NULL,
                 status TEXT NOT NULL,
                 current_step_id TEXT,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
             );
             CREATE INDEX workflow_runs_project_updated
                 ON workflow_runs(project_id, updated_at DESC);
             CREATE TABLE workflow_steps (
                 run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
                 step_id TEXT NOT NULL,
                 ordinal INTEGER NOT NULL,
                 kind TEXT NOT NULL,
                 state TEXT NOT NULL,
                 round INTEGER NOT NULL DEFAULT 0,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL,
                 PRIMARY KEY(run_id, step_id),
                 UNIQUE(run_id, ordinal)
             );
             CREATE TABLE workflow_step_attempts (
                 run_id TEXT NOT NULL,
                 step_id TEXT NOT NULL,
                 ordinal INTEGER NOT NULL,
                 attempt_id TEXT NOT NULL,
                 PRIMARY KEY(run_id, step_id, ordinal),
                 UNIQUE(attempt_id),
                 FOREIGN KEY(run_id, step_id) REFERENCES workflow_steps(run_id, step_id) ON DELETE CASCADE
             );
             CREATE TABLE workflow_edges (
                 run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
                 seq INTEGER NOT NULL,
                 from_step_id TEXT NOT NULL,
                 outcome TEXT NOT NULL,
                 target TEXT NOT NULL,
                 taken_at INTEGER NOT NULL,
                 PRIMARY KEY(run_id, seq)
             );",
        ).map_err(|error| error.to_string())?;
        tx.pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
    }
    Ok(conn)
}

fn reconcile_interrupted(conn: &mut Connection) -> Result<(), String> {
    let now = now_ms();
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE workflow_steps SET state = 'interrupted', updated_at = ?1
         WHERE state = 'running' AND EXISTS (
             SELECT 1 FROM workflow_runs r
             WHERE r.run_id = workflow_steps.run_id
               AND r.current_step_id = workflow_steps.step_id
               AND r.status = 'running'
         )",
        [now],
    )
    .map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE workflow_runs SET status = 'interrupted', updated_at = ?1 WHERE status = 'running'",
        [now],
    )
    .map_err(|error| error.to_string())?;
    tx.commit().map_err(|error| error.to_string())
}

fn read_summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkflowRunSummary> {
    Ok(WorkflowRunSummary {
        run_id: row.get(0)?,
        project_id: row.get(1)?,
        definition_id: row.get(2)?,
        definition_version: row.get(3)?,
        definition_hash: row.get(4)?,
        trigger_kind: row.get(5)?,
        status: row.get(6)?,
        current_step_id: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn read_detail(conn: &Connection, run_id: &str) -> Result<Option<WorkflowRunDetail>, String> {
    let row: Option<(WorkflowRunSummary, String, String)> = conn
        .query_row(
            "SELECT run_id, project_id, definition_id, definition_version, definition_hash,
                trigger_kind, status, current_step_id, created_at, updated_at,
                definition_json, trigger_json
         FROM workflow_runs WHERE run_id = ?1",
            [run_id],
            |row| Ok((read_summary_row(row)?, row.get(10)?, row.get(11)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((summary, definition_json, trigger_json)) = row else {
        return Ok(None);
    };
    let mut step_query = conn
        .prepare(
            "SELECT step_id, kind, state, round, updated_at
         FROM workflow_steps WHERE run_id = ?1 ORDER BY ordinal",
        )
        .map_err(|error| error.to_string())?;
    let seeds = step_query
        .query_map([run_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut steps = Vec::with_capacity(seeds.len());
    for (id, kind, state, round, updated_at) in seeds {
        let mut attempts = conn
            .prepare(
                "SELECT attempt_id FROM workflow_step_attempts
             WHERE run_id = ?1 AND step_id = ?2 ORDER BY ordinal",
            )
            .map_err(|error| error.to_string())?;
        let attempt_ids = attempts
            .query_map(params![run_id, id], |row| row.get(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        steps.push(WorkflowStepState {
            id,
            kind,
            state,
            attempt_ids,
            round,
            updated_at,
        });
    }
    let mut edge_query = conn
        .prepare(
            "SELECT seq, from_step_id, outcome, target, taken_at
         FROM workflow_edges WHERE run_id = ?1 ORDER BY seq",
        )
        .map_err(|error| error.to_string())?;
    let edges = edge_query
        .query_map([run_id], |row| {
            Ok(WorkflowEdgeTaken {
                seq: row.get(0)?,
                from_step_id: row.get(1)?,
                outcome: row.get(2)?,
                target: row.get(3)?,
                taken_at: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(Some(WorkflowRunDetail {
        summary,
        definition: decode(&definition_json, 10).map_err(|error| error.to_string())?,
        trigger: decode(&trigger_json, 11).map_err(|error| error.to_string())?,
        steps,
        edges,
    }))
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 96
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(format!("invalid {label}"));
    }
    Ok(())
}

fn validate_text(value: &str, max: usize, label: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return Err(format!("{label} is required"));
    }
    if value.len() > max {
        return Err(format!("{label} exceeds {max} bytes"));
    }
    Ok(())
}

fn encode<T: Serialize>(value: &T, label: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|error| format!("could not encode {label}: {error}"))
}

fn decode<T: serde::de::DeserializeOwned>(raw: &str, column: usize) -> rusqlite::Result<T> {
    serde_json::from_str(raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(column, Type::Text, Box::new(error))
    })
}

fn random_id(prefix: &str) -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|error| error.to_string())?;
    Ok(format!("{prefix}_{}", hex::encode(bytes)))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn restrict(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &Path) {}

#[tauri::command]
pub fn workflow_run_create(
    input: WorkflowRunCreateInput,
    store: State<'_, WorkflowStore>,
) -> Result<WorkflowRunDetail, String> {
    store.create(input)
}

#[tauri::command]
pub fn workflow_step_record(
    input: WorkflowStepRecordInput,
    store: State<'_, WorkflowStore>,
) -> Result<WorkflowRunDetail, String> {
    store.record_step(input)
}

#[tauri::command]
pub fn workflow_run_advance(
    input: WorkflowRunAdvanceInput,
    store: State<'_, WorkflowStore>,
) -> Result<WorkflowRunDetail, String> {
    store.advance(input)
}

#[tauri::command]
pub fn workflow_run_resume(
    run_id: String,
    store: State<'_, WorkflowStore>,
) -> Result<WorkflowRunDetail, String> {
    store.resume(run_id)
}

#[tauri::command]
pub fn workflow_run_list(
    project_id: String,
    limit: Option<usize>,
    store: State<'_, WorkflowStore>,
) -> Result<Vec<WorkflowRunSummary>, String> {
    store.list(&project_id, limit.unwrap_or(DEFAULT_LIST))
}

#[tauri::command]
pub fn workflow_run_get(
    run_id: String,
    store: State<'_, WorkflowStore>,
) -> Result<Option<WorkflowRunDetail>, String> {
    store.get(&run_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "canopy-workflow-{label}-{}",
            random_id("test").unwrap()
        ))
    }

    fn create(store: &WorkflowStore) -> WorkflowRunDetail {
        store
            .create(WorkflowRunCreateInput {
                project_id: "project-1".into(),
                definition_id: "review".into(),
                definition_version: "1".into(),
                definition_hash: "hash-1".into(),
                definition: serde_json::json!({"id": "review", "version": "1"}),
                trigger_kind: "manual".into(),
                trigger: serde_json::json!({"kind": "manual", "requestedBy": "user"}),
                start_step_id: "agent".into(),
                steps: vec![
                    WorkflowStepSeed {
                        id: "agent".into(),
                        kind: "agent".into(),
                    },
                    WorkflowStepSeed {
                        id: "gate".into(),
                        kind: "gate".into(),
                    },
                ],
            })
            .unwrap()
    }

    #[test]
    fn run_survives_restart_and_reconciles_inflight_work() {
        let dir = root("restart");
        let store = WorkflowStore::at(dir.clone());
        let run = create(&store);
        let run_id = run.summary.run_id.clone();
        store
            .record_step(WorkflowStepRecordInput {
                run_id: run_id.clone(),
                step_id: "agent".into(),
                state: "running".into(),
                attempt_id: Some("attempt_reserved".into()),
            })
            .unwrap();
        drop(store);

        let reopened = WorkflowStore::at(dir.clone());
        let restored = reopened.get(&run_id).unwrap().unwrap();
        assert_eq!(restored.summary.status, "interrupted");
        assert_eq!(restored.summary.definition_version, "1");
        assert_eq!(restored.trigger["kind"], "manual");
        assert_eq!(restored.steps[0].attempt_ids, vec!["attempt_reserved"]);
        assert_eq!(restored.steps[0].state, "interrupted");

        let resumed = reopened.resume(run_id.clone()).unwrap();
        assert_eq!(resumed.summary.status, "running");
        let gate = reopened
            .advance(WorkflowRunAdvanceInput {
                run_id: run_id.clone(),
                step_id: "agent".into(),
                step_state: "completed".into(),
                outcome: "success".into(),
                target: "gate".into(),
            })
            .unwrap();
        assert_eq!(gate.summary.current_step_id.as_deref(), Some("gate"));
        let done = reopened
            .advance(WorkflowRunAdvanceInput {
                run_id,
                step_id: "gate".into(),
                step_state: "completed".into(),
                outcome: "pass".into(),
                target: "$completed".into(),
            })
            .unwrap();
        assert_eq!(done.summary.status, "completed");
        assert!(done.summary.current_step_id.is_none());
        assert_eq!(done.edges.len(), 2);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn attempt_retries_are_referenced_and_evidence_is_not_copied() {
        let dir = root("attempt");
        let store = WorkflowStore::at(dir.clone());
        let run = create(&store);
        let input = WorkflowStepRecordInput {
            run_id: run.summary.run_id.clone(),
            step_id: "agent".into(),
            state: "running".into(),
            attempt_id: Some("attempt_one".into()),
        };
        store.record_step(input).unwrap();
        let updated = store
            .record_step(WorkflowStepRecordInput {
                run_id: run.summary.run_id,
                step_id: "agent".into(),
                state: "running".into(),
                attempt_id: Some("attempt_two".into()),
            })
            .unwrap();
        assert_eq!(
            updated.steps[0].attempt_ids,
            vec!["attempt_one", "attempt_two"]
        );
        let duplicate = store.record_step(WorkflowStepRecordInput {
            run_id: updated.summary.run_id.clone(),
            step_id: "agent".into(),
            state: "running".into(),
            attempt_id: Some("attempt_two".into()),
        });
        assert!(duplicate.is_err(), "an attempt may only be referenced once");
        let columns: Vec<String> = store
            .with_conn(|conn| {
                let mut statement = conn
                    .prepare("PRAGMA table_info(workflow_steps)")
                    .map_err(|e| e.to_string())?;
                let columns = statement
                    .query_map([], |row| row.get(1))
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                Ok(columns)
            })
            .unwrap();
        assert!(!columns
            .iter()
            .any(|column| column.contains("evidence") || column.contains("output")));
        let _ = std::fs::remove_dir_all(dir);
    }
}

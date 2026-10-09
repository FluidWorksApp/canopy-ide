//! The workspace's durable delivery ledger: terminal deliveries, the relay
//! inbox (dedupe + authorization decision), job state and the status outbox,
//! in one SQLite file so admission, job state and outbox rows commit together.
//!
//! A delivery's state moves queued → writing → written → submitted. `writing`
//! is recorded before the first PTY byte; a crash leaves `writing` or
//! `written`, which recovery turns into `uncertain` and reports — it never
//! types the line again, because the agent may already have acted on it.

use crate::util::now_ms;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use std::path::Path;
use std::sync::Mutex;

/// Inbox rows outlive the envelope they dedupe by this much.
const INBOX_GRACE_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_DELIVERIES: i64 = 2000;

#[derive(Clone, Debug, PartialEq)]
pub struct DeliveryRow {
    pub id: String,
    pub message_id: String,
    pub pty_id: u32,
    pub line: String,
    pub state: String,
    pub job_key: Option<String>,
}

#[derive(Clone, Debug)]
pub struct OutboxRow {
    pub id: i64,
    pub team: String,
    pub to_user: String,
    pub to_device: String,
    pub kind: String,
    pub payload: String,
    pub expires_ms: u64,
}

#[derive(Clone, Debug)]
pub struct InboxRow {
    pub replay_id: String,
    pub kind: String,
    pub team: String,
    pub sender_user: String,
    pub sender_device: String,
    pub state: String,
    pub payload: String,
}

pub struct NewOutbox<'a> {
    pub team: &'a str,
    pub to_user: &'a str,
    pub to_device: &'a str,
    pub kind: &'a str,
    pub payload: &'a serde_json::Value,
    pub expires_ms: u64,
}

pub struct Ledger {
    db: Mutex<Connection>,
}

impl Ledger {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        let _ = crate::util::set_mode(path, 0o600);
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = FULL;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS deliveries (
                 id TEXT PRIMARY KEY, message_id TEXT NOT NULL, pty_id INTEGER NOT NULL,
                 line TEXT NOT NULL, state TEXT NOT NULL, detail TEXT,
                 job_key TEXT, inbox_id TEXT,
                 created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
             CREATE INDEX IF NOT EXISTS deliveries_state ON deliveries(state);
             CREATE TABLE IF NOT EXISTS inbox (
                 replay_id TEXT PRIMARY KEY, envelope_id TEXT NOT NULL, relay_row TEXT,
                 kind TEXT NOT NULL, team TEXT NOT NULL, sender_user TEXT NOT NULL,
                 sender_device TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT,
                 state TEXT NOT NULL, payload TEXT NOT NULL,
                 expires_ms INTEGER NOT NULL, at_ms INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS jobs (
                 key TEXT PRIMARY KEY, job_id TEXT NOT NULL, team TEXT NOT NULL,
                 sender_user TEXT NOT NULL, sender_device TEXT NOT NULL,
                 title TEXT NOT NULL, brief TEXT NOT NULL, target_pty INTEGER,
                 state TEXT NOT NULL, detail TEXT, message_id TEXT,
                 created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS outbox (
                 id INTEGER PRIMARY KEY AUTOINCREMENT, team TEXT NOT NULL,
                 to_user TEXT NOT NULL, to_device TEXT NOT NULL, kind TEXT NOT NULL,
                 payload TEXT NOT NULL, created_ms INTEGER NOT NULL,
                 expires_ms INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
                 sent_ms INTEGER, last_error TEXT);",
        )
        .map_err(|e| e.to_string())?;
        let ledger = Self { db: Mutex::new(db) };
        ledger.prune(now_ms())?;
        Ok(ledger)
    }

    fn prune(&self, now: u64) -> Result<(), String> {
        let db = self.db.lock().unwrap();
        db.execute(
            "DELETE FROM inbox WHERE expires_ms < ?1",
            [now.saturating_sub(INBOX_GRACE_MS) as i64],
        )
        .map_err(|e| e.to_string())?;
        db.execute(
            "DELETE FROM outbox WHERE (sent_ms IS NOT NULL AND sent_ms < ?1) OR expires_ms < ?1",
            [now.saturating_sub(INBOX_GRACE_MS) as i64],
        )
        .map_err(|e| e.to_string())?;
        db.execute(
            "DELETE FROM deliveries WHERE id IN (SELECT id FROM deliveries
                 WHERE state IN ('submitted','failed','uncertain')
                 ORDER BY created_ms DESC LIMIT -1 OFFSET ?1)",
            [MAX_DELIVERIES],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn transaction<T>(
        &self,
        f: impl FnOnce(&Transaction) -> rusqlite::Result<T>,
    ) -> Result<T, String> {
        let mut db = self.db.lock().unwrap();
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let out = f(&tx).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(out)
    }

    pub fn insert_delivery(
        tx: &Transaction,
        row: &DeliveryRow,
        inbox_id: Option<&str>,
    ) -> rusqlite::Result<()> {
        let now = now_ms() as i64;
        tx.execute(
            "INSERT INTO deliveries(id, message_id, pty_id, line, state, job_key, inbox_id, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?7, ?7)",
            params![row.id, row.message_id, row.pty_id, row.line, row.job_key, inbox_id, now],
        )?;
        Ok(())
    }

    pub fn set_delivery(&self, id: &str, state: &str, detail: Option<&str>) -> Result<(), String> {
        self.transaction(|tx| {
            tx.execute(
                "UPDATE deliveries SET state = ?2, detail = ?3, updated_ms = ?4 WHERE id = ?1",
                params![id, state, detail, now_ms() as i64],
            )
            .map(|_| ())
        })
    }

    pub fn unfinished_deliveries(&self) -> Result<Vec<DeliveryRow>, String> {
        let db = self.db.lock().unwrap();
        let mut statement = db
            .prepare(
                "SELECT id, message_id, pty_id, line, state, job_key FROM deliveries
                 WHERE state IN ('queued','writing','written') ORDER BY created_ms, rowid",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(DeliveryRow {
                    id: row.get(0)?,
                    message_id: row.get(1)?,
                    pty_id: row.get(2)?,
                    line: row.get(3)?,
                    state: row.get(4)?,
                    job_key: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    pub fn list(&self, table: &str, limit: usize) -> Result<Vec<serde_json::Value>, String> {
        let (sql, columns): (&str, &[&str]) = match table {
            "deliveries" => (
                "SELECT id, message_id, pty_id, state, detail, job_key, created_ms, updated_ms
                 FROM deliveries ORDER BY created_ms DESC, rowid DESC LIMIT ?1",
                &[
                    "id",
                    "messageId",
                    "ptyId",
                    "state",
                    "detail",
                    "jobKey",
                    "createdMs",
                    "updatedMs",
                ],
            ),
            "jobs" => (
                "SELECT key, job_id, sender_user, sender_device, title, target_pty, state, detail,
                        message_id, created_ms, updated_ms
                 FROM jobs ORDER BY created_ms DESC, rowid DESC LIMIT ?1",
                &[
                    "key",
                    "jobId",
                    "senderUser",
                    "senderDevice",
                    "title",
                    "targetPty",
                    "state",
                    "detail",
                    "messageId",
                    "createdMs",
                    "updatedMs",
                ],
            ),
            "inbox" => (
                "SELECT replay_id, envelope_id, kind, sender_user, sender_device, decision, reason,
                        state, at_ms
                 FROM inbox ORDER BY at_ms DESC, rowid DESC LIMIT ?1",
                &[
                    "replayId",
                    "envelopeId",
                    "kind",
                    "senderUser",
                    "senderDevice",
                    "decision",
                    "reason",
                    "state",
                    "atMs",
                ],
            ),
            "outbox" => (
                "SELECT id, to_user, to_device, kind, attempts, sent_ms, last_error, created_ms
                 FROM outbox ORDER BY id DESC LIMIT ?1",
                &[
                    "id",
                    "toUser",
                    "toDevice",
                    "kind",
                    "attempts",
                    "sentMs",
                    "lastError",
                    "createdMs",
                ],
            ),
            other => return Err(format!("unknown ledger table {other}")),
        };
        let db = self.db.lock().unwrap();
        let mut statement = db.prepare(sql).map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([limit as i64], |row| {
                let mut object = serde_json::Map::new();
                for (i, name) in columns.iter().enumerate() {
                    let value = match row.get_ref(i)? {
                        rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                        rusqlite::types::ValueRef::Integer(n) => n.into(),
                        rusqlite::types::ValueRef::Real(f) => f.into(),
                        rusqlite::types::ValueRef::Text(t) => {
                            String::from_utf8_lossy(t).into_owned().into()
                        }
                        rusqlite::types::ValueRef::Blob(_) => serde_json::Value::Null,
                    };
                    object.insert((*name).to_string(), value);
                }
                Ok(serde_json::Value::Object(object))
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    pub fn inbox_state(&self, replay_id: &str) -> Result<Option<String>, String> {
        let db = self.db.lock().unwrap();
        db.query_row(
            "SELECT state FROM inbox WHERE replay_id = ?1",
            [replay_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert_inbox(
        tx: &Transaction,
        replay_id: &str,
        envelope_id: &str,
        relay_row: &str,
        kind: &str,
        team: &str,
        sender_user: &str,
        sender_device: &str,
        decision: &str,
        reason: Option<&str>,
        state: &str,
        payload: &str,
        expires_ms: u64,
    ) -> rusqlite::Result<()> {
        tx.execute(
            "INSERT INTO inbox(replay_id, envelope_id, relay_row, kind, team, sender_user,
                 sender_device, decision, reason, state, payload, expires_ms, at_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                replay_id,
                envelope_id,
                relay_row,
                kind,
                team,
                sender_user,
                sender_device,
                decision,
                reason,
                state,
                payload,
                expires_ms as i64,
                now_ms() as i64
            ],
        )?;
        Ok(())
    }

    pub fn set_inbox_state(
        tx: &Transaction,
        replay_id: &str,
        state: &str,
        reason: Option<&str>,
    ) -> rusqlite::Result<()> {
        tx.execute(
            "UPDATE inbox SET state = ?2, reason = COALESCE(?3, reason) WHERE replay_id = ?1",
            params![replay_id, state, reason],
        )?;
        Ok(())
    }

    /// Admitted inbox rows not yet handed to delivery: a crash landed between
    /// the admission commit and the hand-off. Nothing was typed, so these are
    /// safe to hand off now.
    pub fn accepted_inbox(&self) -> Result<Vec<InboxRow>, String> {
        let db = self.db.lock().unwrap();
        let mut statement = db
            .prepare(
                "SELECT replay_id, kind, team, sender_user, sender_device, state, payload
                 FROM inbox WHERE state = 'accepted' ORDER BY at_ms, rowid",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(InboxRow {
                    replay_id: row.get(0)?,
                    kind: row.get(1)?,
                    team: row.get(2)?,
                    sender_user: row.get(3)?,
                    sender_device: row.get(4)?,
                    state: row.get(5)?,
                    payload: row.get(6)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    #[allow(clippy::too_many_arguments)]
    pub fn insert_job(
        tx: &Transaction,
        key: &str,
        job_id: &str,
        team: &str,
        sender_user: &str,
        sender_device: &str,
        title: &str,
        brief: &str,
    ) -> rusqlite::Result<()> {
        let now = now_ms() as i64;
        tx.execute(
            "INSERT OR IGNORE INTO jobs(key, job_id, team, sender_user, sender_device, title, brief,
                 state, created_ms, updated_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'accepted', ?8, ?8)",
            params![key, job_id, team, sender_user, sender_device, title, brief, now],
        )?;
        Ok(())
    }

    pub fn set_job(
        tx: &Transaction,
        key: &str,
        state: &str,
        detail: Option<&str>,
        target_pty: Option<u32>,
        message_id: Option<&str>,
    ) -> rusqlite::Result<()> {
        tx.execute(
            "UPDATE jobs SET state = ?2, detail = COALESCE(?3, detail),
                 target_pty = COALESCE(?4, target_pty), message_id = COALESCE(?5, message_id),
                 updated_ms = ?6 WHERE key = ?1",
            params![key, state, detail, target_pty, message_id, now_ms() as i64],
        )?;
        Ok(())
    }

    /// `(key, job_id, team, sender_user, sender_device)` for a job.
    pub fn job_route(
        tx: &Transaction,
        key: &str,
    ) -> rusqlite::Result<Option<(String, String, String, String, String)>> {
        tx.query_row(
            "SELECT key, job_id, team, sender_user, sender_device FROM jobs WHERE key = ?1",
            [key],
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
        .optional()
    }

    /// The newest job delivered into a terminal that has not settled yet —
    /// what that terminal's `job_done` reports on.
    pub fn open_job_for_pty(&self, pty_id: u32) -> Result<Option<String>, String> {
        let db = self.db.lock().unwrap();
        db.query_row(
            "SELECT key FROM jobs WHERE target_pty = ?1 AND state IN ('accepted','started')
             ORDER BY created_ms DESC LIMIT 1",
            [pty_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn job_state(&self, key: &str) -> Result<Option<String>, String> {
        let db = self.db.lock().unwrap();
        db.query_row("SELECT state FROM jobs WHERE key = ?1", [key], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())
    }

    pub fn push_outbox(tx: &Transaction, row: NewOutbox) -> rusqlite::Result<()> {
        tx.execute(
            "INSERT INTO outbox(team, to_user, to_device, kind, payload, created_ms, expires_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                row.team,
                row.to_user,
                row.to_device,
                row.kind,
                row.payload.to_string(),
                now_ms() as i64,
                row.expires_ms as i64
            ],
        )?;
        Ok(())
    }

    pub fn pending_outbox(&self, now: u64) -> Result<Vec<OutboxRow>, String> {
        let db = self.db.lock().unwrap();
        let mut statement = db
            .prepare(
                "SELECT id, team, to_user, to_device, kind, payload, expires_ms FROM outbox
                 WHERE sent_ms IS NULL AND expires_ms > ?1 ORDER BY id LIMIT 100",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([now as i64], |row| {
                Ok(OutboxRow {
                    id: row.get(0)?,
                    team: row.get(1)?,
                    to_user: row.get(2)?,
                    to_device: row.get(3)?,
                    kind: row.get(4)?,
                    payload: row.get(5)?,
                    expires_ms: row.get::<_, i64>(6)? as u64,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())
    }

    pub fn outbox_result(&self, id: i64, error: Option<&str>) -> Result<(), String> {
        self.transaction(|tx| {
            match error {
                None => tx.execute(
                    "UPDATE outbox SET sent_ms = ?2, attempts = attempts + 1 WHERE id = ?1",
                    params![id, now_ms() as i64],
                ),
                Some(error) => tx.execute(
                    "UPDATE outbox SET last_error = ?2, attempts = attempts + 1 WHERE id = ?1",
                    params![id, error],
                ),
            }
            .map(|_| ())
        })
    }
}

// SpotSearch's persistent half: a SQLite FTS5 index over the two sources too
// big to scan per keystroke — agent conversation transcripts and live terminal
// scrollback. Everything else the palette shows (files, tabs, tickets,
// servers…) is queried live by the frontend; this module holds only what would
// otherwise mean re-reading tens of megabytes on every keystroke.
//
// Transcripts come from every agent CLI that keeps a readable store (see
// stores.rs), not just claude — a conversation you can find is a conversation
// you can reopen, and the two lists are built from the same enumeration.
//
// Ingestion is incremental and budgeted. Append-only stores (claude, codex,
// omp) are read from a per-file byte offset, so each call parses only what grew
// since the last one; stores that are rewritten in place (gemini's JSON docs,
// opencode's and Antigravity's SQLite) are re-read whole when their size or
// mtime moves, and not otherwise. A call that exhausts its byte budget reports
// `more: true` and the frontend simply calls again. Scrollback is a bounded
// ring per live PTY (pty::SCROLLBACK_CAP), re-indexed whole when its length
// moves and dropped when its PTY is gone — the terminal section of the index
// only ever describes terminals that still exist.
//
// Staleness is the thing an index of derived data gets wrong. Everything here
// is derived, so the rule is that the index may lag but must never claim what
// is gone: a file that shrank is re-read from zero, a file that vanished takes
// its documents with it, an agent switched off in Settings is purged rather
// than merely skipped, and anything past the retention window is dropped. The
// schema carries a version, and a mismatch rebuilds rather than migrates —
// there is nothing in here that cannot be read again from its source.

use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

use crate::fsx::{check_scope, WorkspaceManager};
use crate::pty::PtyManager;
use crate::stores::{self, Layout};

#[derive(Default)]
pub struct SpotIndex(Mutex<Option<Connection>>);

/// Bump when the schema below changes. A mismatch drops and rebuilds: every row
/// is derived from a file that still exists, so a rebuild costs one ingest.
const SCHEMA_VERSION: i64 = 2;

/// Transcript bytes parsed per ingest call. Keeps the palette-open call quick;
/// a cold index (every transcript unread) catches up over a few calls instead
/// of stalling the first one for seconds.
const INGEST_BUDGET: u64 = 4 * 1024 * 1024;
/// How much of a terminal's ring to index. The ring itself is capped at 256KB
/// of raw bytes; stripped of escape codes it shrinks further.
const MAX_SCROLLBACK: usize = 256 * 1024;
/// Messages one whole-file store may contribute per read. A single opencode
/// database or Antigravity conversation can be enormous; this keeps one store
/// from owning the index.
const MAX_WHOLE_BODIES: usize = 4000;

fn db_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let dir = PathBuf::from(home).join(".canopy");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("spot-index.sqlite"))
}

/// The schema. `title` and `body` are the only searchable columns: a path in a
/// searchable column made every message of a session match its own directory
/// name, which buried real hits under whole conversations.
fn create(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sources (
             path TEXT PRIMARY KEY,
             agent TEXT NOT NULL DEFAULT '',
             offset INTEGER NOT NULL DEFAULT 0,
             stamp INTEGER NOT NULL DEFAULT 0
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
             kind UNINDEXED, key UNINDEXED, agent UNINDEXED, cwd UNINDEXED,
             title, body, meta UNINDEXED, ts UNINDEXED
         );",
    )
    .map_err(|e| e.to_string())
}

fn open_db() -> Result<Connection, String> {
    let conn = Connection::open(db_path()?).map_err(|e| e.to_string())?;
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if version != SCHEMA_VERSION {
        // Not a migration: the index is a cache of files on disk, and the
        // cheapest correct answer to "the shape changed" is to read them again.
        conn.execute_batch("DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS sources;")
            .map_err(|e| e.to_string())?;
        create(&conn)?;
        conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
            .map_err(|e| e.to_string())?;
    } else {
        create(&conn)?;
    }
    Ok(conn)
}

/// Run `f` against the connection, opening it on first use. A corrupt or
/// unopenable index is reported, never fatal — SpotSearch's live sources still
/// work without it.
fn with_db<T>(
    state: &State<'_, SpotIndex>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let mut guard = state.0.lock().unwrap();
    if guard.is_none() {
        *guard = Some(open_db()?);
    }
    f(guard.as_ref().unwrap())
}

/// Terminal output with the escape codes taken out. A replay-through-xterm
/// render (what the frontend's ptyText.ts does) would be more faithful to TUI
/// overdraw, but there is no xterm on this side; for search recall, dropping
/// CSI/OSC sequences and treating carriage returns as line breaks is enough —
/// an overdrawn status line indexes as several lines instead of one, and all
/// of them match.
fn strip_ansi(bytes: &[u8]) -> String {
    let s = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            match chars.next() {
                // CSI: parameters then one final byte in @..~.
                Some('[') => {
                    for n in chars.by_ref() {
                        if ('@'..='~').contains(&n) {
                            break;
                        }
                    }
                }
                // OSC: runs to BEL or ESC-backslash.
                Some(']') => {
                    while let Some(n) = chars.next() {
                        if n == '\u{7}' {
                            break;
                        }
                        if n == '\u{1b}' {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if c == '\r' {
            out.push('\n');
        } else if c == '\n' || c == '\t' || !c.is_control() {
            out.push(c);
        }
    }
    out
}

/// User input as an FTS5 MATCH expression: each word a quoted prefix term, so
/// `spo sea` finds "SpotSearch" and a stray `"` or `-` can't break the query
/// syntax.
fn fts_query(q: &str) -> String {
    q.split_whitespace()
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ")
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Is `cwd` inside one of `roots`? Empty roots means "don't scope" — a caller
/// that knows no directories must get everything rather than nothing.
fn under_roots(cwd: &str, roots: &[String]) -> bool {
    if roots.is_empty() {
        return true;
    }
    roots.iter().any(|r| {
        let r = r.trim_end_matches('/');
        cwd == r || cwd.starts_with(&format!("{r}/"))
    })
}

/// How much worse an old hit ranks than a new one. FTS5's `rank` is bm25 —
/// negative, and more negative is better — so age is added as a penalty. A
/// month of age is worth about as much as a mediocre text match, which is the
/// tradeoff someone searching their own history actually wants: yesterday's
/// terminal beats a perfect match from March.
fn age_penalty(ts: i64, now: i64) -> f64 {
    if ts <= 0 {
        return 0.0;
    }
    let days = ((now - ts).max(0) as f64) / 86_400.0;
    // Flattens out: the difference between one and two years is not meaningful.
    (1.0 + days).ln() * 0.35
}

#[derive(Serialize)]
pub struct SpotIngestReport {
    /// The transcript budget ran out with files still unread — call again.
    pub more: bool,
    /// Transcript messages added this call.
    pub messages: usize,
    /// Terminals whose scrollback was (re)indexed this call.
    pub terminals: usize,
    /// Documents dropped: vanished files, disabled agents, retention.
    pub pruned: usize,
}

/// Bring the index up to date. Called by the frontend when the palette opens
/// (and again while `more`), never on a timer — an index nobody is about to
/// search is not worth a disk walk.
///
/// `agents` is the list the user left switched on in Settings → SpotSearch, and
/// an agent missing from it is purged rather than skipped: "stop indexing my
/// conversations with X" has to mean the ones already in there too. `roots` are
/// the open project's directories, needed to find the stores that file
/// themselves by project (gemini hashes the path; aider writes into the repo).
#[tauri::command]
pub async fn spot_ingest(
    state: State<'_, SpotIndex>,
    ptys: State<'_, PtyManager>,
    agents: Option<Vec<String>>,
    terminals: Option<bool>,
    roots: Option<Vec<String>>,
    retention_days: Option<i64>,
) -> Result<SpotIngestReport, String> {
    let want_agents: Vec<String> =
        agents.unwrap_or_else(|| stores::STORE_AGENTS.iter().map(|s| s.to_string()).collect());
    let want_terminals = terminals.unwrap_or(true);
    let roots = roots.unwrap_or_default();
    let retention = retention_days.unwrap_or(0).max(0);
    let wanted = |a: &str| want_agents.iter().any(|w| w == a);

    // Snapshot the live terminals before taking the db lock: id, title, cwd,
    // and the ring's tail. Brief per-session locks, nothing held across the db
    // work.
    let live: Vec<(u32, String, String)> = if want_terminals {
        let sessions = ptys.sessions();
        let map = sessions.lock().unwrap();
        map.values()
            .map(|s| (s.id, s.title.lock().unwrap().clone(), s.cwd.clone()))
            .collect()
    } else {
        Vec::new()
    };
    let tails: Vec<(u32, String, String, Vec<u8>)> = live
        .into_iter()
        .filter_map(|(id, title, cwd)| {
            ptys.scrollback_tail(id, MAX_SCROLLBACK)
                .map(|t| (id, title, cwd, t))
        })
        .collect();

    // The disk walk happens outside the db lock: it stats every transcript the
    // machine has, and the palette is waiting on this call.
    let files = stores::source_files(&roots, &wanted);

    with_db(&state, |conn| {
        let mut messages = 0usize;
        let mut terminals = 0usize;
        let mut pruned = 0usize;
        let mut more = false;
        let mut budget = INGEST_BUDGET;
        let now = now_secs();

        // ---- purges, before anything is read ----
        // An agent the user switched off, and everything it ever contributed.
        {
            let mut stmt = conn
                .prepare("SELECT DISTINCT agent FROM docs WHERE kind = 'transcript'")
                .map_err(|e| e.to_string())?;
            let indexed: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .collect();
            drop(stmt);
            for agent in indexed {
                if wanted(&agent) {
                    continue;
                }
                pruned += conn
                    .execute(
                        "DELETE FROM docs WHERE kind = 'transcript' AND agent = ?1",
                        [&agent],
                    )
                    .map_err(|e| e.to_string())?;
                conn.execute("DELETE FROM sources WHERE agent = ?1", [&agent])
                    .map_err(|e| e.to_string())?;
            }
        }
        if !want_terminals {
            pruned += conn
                .execute("DELETE FROM docs WHERE kind = 'terminal'", [])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM sources WHERE agent = 'terminal'", [])
                .map_err(|e| e.to_string())?;
        }
        // Files that have since been deleted — a cleared conversation, a wiped
        // store. Nothing else drops these: ingestion is driven by a per-file
        // bookmark, so a file that stops existing simply stops being read, and
        // its messages would sit in the index (and in its ranking) forever.
        {
            let mut stmt = conn
                .prepare("SELECT path FROM sources WHERE agent <> 'terminal'")
                .map_err(|e| e.to_string())?;
            let known: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .collect();
            drop(stmt);
            for path in known {
                if std::path::Path::new(&path).exists() {
                    continue;
                }
                pruned += conn
                    .execute("DELETE FROM docs WHERE meta = ?1", [&path])
                    .map_err(|e| e.to_string())?;
                conn.execute("DELETE FROM sources WHERE path = ?1", [&path])
                    .map_err(|e| e.to_string())?;
            }
        }
        // Retention: 0 means keep everything, which is the default — this is a
        // search index over the user's own work, not a log to be rotated.
        if retention > 0 {
            let cutoff = now - retention * 86_400;
            pruned += conn
                .execute(
                    "DELETE FROM docs WHERE kind = 'transcript' AND ts > 0 AND ts < ?1",
                    [cutoff],
                )
                .map_err(|e| e.to_string())?;
        }

        // ---- transcripts ----
        // `title` is left empty for transcripts on purpose: it is a searchable
        // column, and putting the cwd there made every message of a session
        // match its own directory name.
        const INSERT_DOC: &str = "INSERT INTO docs (kind, key, agent, cwd, title, body, meta, ts)
             VALUES ('transcript', ?1, ?2, ?3, '', ?4, ?5, ?6)";

        for f in files {
            let path_str = f.path.to_string_lossy().to_string();
            let Ok(md) = std::fs::metadata(&f.path) else {
                continue;
            };
            let len = md.len();
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);

            match f.layout {
                Layout::Whole => {
                    // Rewritten in place, so there is no offset to trust: the
                    // bookmark is (size, mtime) and a change re-reads the file.
                    let stamp = (len as i64) ^ (mtime << 20);
                    let seen: i64 = conn
                        .query_row(
                            "SELECT stamp FROM sources WHERE path = ?1",
                            [&path_str],
                            |r| r.get(0),
                        )
                        .unwrap_or(-1);
                    if seen == stamp {
                        continue;
                    }
                    if budget == 0 {
                        more = true;
                        break;
                    }
                    budget = budget.saturating_sub(len.min(budget));
                    conn.execute("DELETE FROM docs WHERE meta = ?1", [&path_str])
                        .map_err(|e| e.to_string())?;
                    let mut written = 0usize;
                    for session in stores::whole_sessions(f.agent, &f.path, &roots) {
                        let mut stmt =
                            conn.prepare_cached(INSERT_DOC).map_err(|e| e.to_string())?;
                        for body in session.bodies {
                            if written >= MAX_WHOLE_BODIES {
                                break;
                            }
                            stmt.execute(rusqlite::params![
                                session.session_id,
                                f.agent,
                                session.cwd,
                                body,
                                path_str,
                                if session.updated > 0 {
                                    session.updated
                                } else {
                                    mtime
                                },
                            ])
                            .map_err(|e| e.to_string())?;
                            written += 1;
                            messages += 1;
                        }
                    }
                    conn.execute(
                        "INSERT INTO sources (path, agent, offset, stamp) VALUES (?1, ?2, 0, ?3)
                         ON CONFLICT(path) DO UPDATE SET agent = ?2, stamp = ?3",
                        rusqlite::params![path_str, f.agent, stamp],
                    )
                    .map_err(|e| e.to_string())?;
                }
                Layout::Append => {
                    let mut offset: u64 = conn
                        .query_row(
                            "SELECT offset FROM sources WHERE path = ?1",
                            [&path_str],
                            |r| r.get::<_, i64>(0),
                        )
                        .map(|v| v as u64)
                        .unwrap_or(0);
                    if len < offset {
                        // Truncated or rewritten (compaction) — drop what we
                        // had and start the file over.
                        conn.execute("DELETE FROM docs WHERE meta = ?1", [&path_str])
                            .map_err(|e| e.to_string())?;
                        offset = 0;
                    }
                    if len == offset {
                        continue;
                    }
                    if budget == 0 {
                        more = true;
                        break;
                    }
                    use std::io::{Read, Seek, SeekFrom};
                    let Ok(mut fh) = std::fs::File::open(&f.path) else {
                        continue;
                    };
                    if fh.seek(SeekFrom::Start(offset)).is_err() {
                        continue;
                    }
                    let want = (len - offset).min(budget);
                    let mut raw = vec![0u8; want as usize];
                    let Ok(read) = fh.read(&mut raw) else {
                        continue;
                    };
                    raw.truncate(read);
                    budget = budget.saturating_sub(read as u64);
                    if (read as u64) < len - offset {
                        more = true;
                    }
                    let text = String::from_utf8_lossy(&raw);
                    // Only complete lines: the writer may be mid-append, and a
                    // half line parsed now would be lost to the offset bump.
                    let consumed = match text.rfind('\n') {
                        Some(i) => i + 1,
                        None => 0,
                    };
                    if consumed == 0 {
                        continue;
                    }
                    let (session_id, cwd) = stores::append_meta(f.agent, &f.path);
                    if session_id.is_empty() {
                        continue;
                    }
                    let mut stmt = conn.prepare_cached(INSERT_DOC).map_err(|e| e.to_string())?;
                    for line in text[..consumed].lines() {
                        let Some(body) = stores::append_line_text(f.agent, line) else {
                            continue;
                        };
                        stmt.execute(rusqlite::params![
                            session_id, f.agent, cwd, body, path_str, mtime
                        ])
                        .map_err(|e| e.to_string())?;
                        messages += 1;
                    }
                    drop(stmt);
                    conn.execute(
                        "INSERT INTO sources (path, agent, offset, stamp)
                         VALUES (?1, ?2, ?3, 0)
                         ON CONFLICT(path) DO UPDATE SET agent = ?2, offset = ?3",
                        rusqlite::params![path_str, f.agent, (offset + consumed as u64) as i64],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }

        // ---- terminal scrollback ----
        // The set of terminal docs mirrors the set of live PTYs exactly: dead
        // ones go (their pty id means nothing after a relaunch, and a result
        // that can't be opened is a dead row), changed ones are replaced whole.
        if want_terminals {
            let live_keys: Vec<String> = tails.iter().map(|(id, ..)| format!("pty:{id}")).collect();
            let mut stale = conn
                .prepare("SELECT key FROM docs WHERE kind = 'terminal'")
                .map_err(|e| e.to_string())?;
            let existing: Vec<String> = stale
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .filter_map(Result::ok)
                .collect();
            drop(stale);
            for key in existing {
                if !live_keys.contains(&key) {
                    conn.execute(
                        "DELETE FROM docs WHERE kind = 'terminal' AND key = ?1",
                        [&key],
                    )
                    .map_err(|e| e.to_string())?;
                    conn.execute("DELETE FROM sources WHERE path = ?1", [&key])
                        .map_err(|e| e.to_string())?;
                    pruned += 1;
                }
            }
            for (id, title, cwd, tail) in tails {
                let key = format!("pty:{id}");
                let seen: i64 = conn
                    .query_row("SELECT offset FROM sources WHERE path = ?1", [&key], |r| {
                        r.get(0)
                    })
                    .unwrap_or(-1);
                if seen == tail.len() as i64 {
                    continue;
                }
                let body: String = strip_ansi(&tail).chars().take(MAX_SCROLLBACK).collect();
                conn.execute(
                    "DELETE FROM docs WHERE kind = 'terminal' AND key = ?1",
                    [&key],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO docs (kind, key, agent, cwd, title, body, meta, ts)
                     VALUES ('terminal', ?1, 'terminal', ?2, ?3, ?4, ?2, ?5)",
                    rusqlite::params![key, cwd, title, body, now],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO sources (path, agent, offset, stamp)
                     VALUES (?1, 'terminal', ?2, 0)
                     ON CONFLICT(path) DO UPDATE SET agent = 'terminal', offset = ?2",
                    rusqlite::params![key, tail.len() as i64],
                )
                .map_err(|e| e.to_string())?;
                terminals += 1;
            }
        }

        Ok(SpotIngestReport {
            more,
            messages,
            terminals,
            pruned,
        })
    })
}

#[derive(Serialize)]
pub struct SpotHit {
    /// "transcript" | "terminal".
    pub kind: String,
    /// Session id for a transcript, "pty:<id>" for a terminal.
    pub key: String,
    /// Registry id of the CLI that wrote it, or "terminal".
    pub agent: String,
    /// Where the conversation was running — what scopes it to a project, and
    /// what a resume has to run in.
    pub cwd: String,
    /// Tab title for a terminal; empty for a transcript, whose row is named
    /// from its session digest.
    pub title: String,
    /// The matched text, trimmed to the match by FTS5.
    pub snippet: String,
    /// The file the hit came from — a transcript path, or the terminal's cwd.
    pub meta: String,
    pub ts: i64,
}

/// Search the persistent index. Hits come back deduplicated to one per
/// container (a session, a terminal) — the palette opens containers, and five
/// rows for five messages of one conversation would drown everything else.
///
/// `roots` scopes to the open project. Without it a query answers from every
/// project on the machine, and the frontend throws most of it away after the
/// round trip — a filter here is both faster and the only version that can
/// honestly say it searched what you were looking at.
#[tauri::command]
pub async fn spot_search(
    state: State<'_, SpotIndex>,
    query: String,
    limit: Option<u32>,
    roots: Option<Vec<String>>,
    all_projects: Option<bool>,
) -> Result<Vec<SpotHit>, String> {
    let match_q = fts_query(&query);
    if match_q.is_empty() {
        return Ok(Vec::new());
    }
    let cap = limit.unwrap_or(20) as usize;
    let roots = if all_projects.unwrap_or(false) {
        Vec::new()
    } else {
        roots.unwrap_or_default()
    };
    let now = now_secs();
    with_db(&state, |conn| {
        let mut stmt = conn
            .prepare_cached(
                "SELECT kind, key, agent, cwd, title, snippet(docs, 5, '', '', ' … ', 14),
                        meta, ts, rank
                 FROM docs WHERE docs MATCH ?1 ORDER BY rank LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        // Wider than the cap because scoping, dedup and the recency re-rank all
        // happen on this side: the best row for a project can sit behind
        // another project's better text match.
        let rows = stmt
            .query_map(
                rusqlite::params![match_q, (cap * 20).max(200) as i64],
                |r| {
                    Ok((
                        SpotHit {
                            kind: r.get(0)?,
                            key: r.get(1)?,
                            agent: r.get(2)?,
                            cwd: r.get(3)?,
                            title: r.get(4)?,
                            snippet: r.get(5)?,
                            meta: r.get(6)?,
                            ts: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
                        },
                        r.get::<_, f64>(8)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;
        let mut scored: Vec<(SpotHit, f64)> = Vec::new();
        for (hit, rank) in rows.filter_map(Result::ok) {
            if !under_roots(&hit.cwd, &roots) {
                continue;
            }
            let score = rank + age_penalty(hit.ts, now);
            match scored
                .iter_mut()
                .find(|(h, _)| h.kind == hit.kind && h.key == hit.key)
            {
                // One row per container, and it should be the container's best
                // line — not whichever message FTS5 happened to return first.
                Some((_, best)) if *best > score => *best = score,
                Some(_) => {}
                None => scored.push((hit, score)),
            }
        }
        scored.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        Ok(scored.into_iter().take(cap).map(|(h, _)| h).collect())
    })
}

#[derive(Serialize)]
pub struct SpotIndexStats {
    /// Indexed transcript messages.
    pub messages: usize,
    /// Conversations those messages came from.
    pub sessions: usize,
    /// Terminals whose scrollback is indexed.
    pub terminals: usize,
    /// Size of the database file on disk.
    pub bytes: u64,
    /// Messages per agent, registry id -> count.
    pub by_agent: Vec<(String, usize)>,
}

/// What the index currently holds — for Settings → SpotSearch, which is the
/// only place anyone can see that this database exists at all.
#[tauri::command]
pub async fn spot_index_stats(state: State<'_, SpotIndex>) -> Result<SpotIndexStats, String> {
    let bytes = db_path()
        .ok()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0);
    with_db(&state, |conn| {
        let count = |sql: &str| -> Result<usize, String> {
            conn.query_row(sql, [], |r| r.get::<_, i64>(0))
                .map(|v| v as usize)
                .map_err(|e| e.to_string())
        };
        let mut stmt = conn
            .prepare(
                "SELECT agent, count(*) FROM docs WHERE kind = 'transcript'
                 GROUP BY agent ORDER BY count(*) DESC",
            )
            .map_err(|e| e.to_string())?;
        let by_agent: Vec<(String, usize)> = stmt
            .query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
            })
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect();
        drop(stmt);
        Ok(SpotIndexStats {
            messages: count("SELECT count(*) FROM docs WHERE kind = 'transcript'")?,
            sessions: count("SELECT count(DISTINCT key) FROM docs WHERE kind = 'transcript'")?,
            terminals: count("SELECT count(*) FROM docs WHERE kind = 'terminal'")?,
            bytes,
            by_agent,
        })
    })
}

/// Empty the index. Everything in it is derived — transcripts on disk, live
/// scrollback — so this costs recall until the next ingest and nothing else.
/// VACUUM because the point of the button is usually to get the disk back.
#[tauri::command]
pub async fn spot_index_clear(state: State<'_, SpotIndex>) -> Result<(), String> {
    with_db(&state, |conn| {
        conn.execute_batch("DELETE FROM docs; DELETE FROM sources; VACUUM;")
            .map_err(|e| e.to_string())
    })
}

/// Write a captured page screenshot where a micro-task brief can point at it:
/// `<dir>/.canopy/spot/ctx-<stamp>.png`, inside a registered workspace root so
/// the agent's own file tools can read it back. Returns the absolute path.
///
/// Never overwrites: the preview's Screenshot button can take several in a row,
/// and a second-resolution stamp alone would hand the second shot the first
/// one's name — the brief would then point two entries at the same picture.
#[tauri::command]
pub async fn spot_save_context_image(
    ws: State<'_, WorkspaceManager>,
    dir: String,
    base64_png: String,
) -> Result<String, String> {
    use base64::Engine;
    let target = PathBuf::from(&dir).join(".canopy/spot");
    check_scope(&ws, &target)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_png.trim())
        .map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let path = free_path(&target, now_secs());
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// `ctx-<stamp>.png`, then `ctx-<stamp>-2.png`, … until one is free. Bounded so
/// a directory that cannot be written to fails at the write rather than here.
fn free_path(dir: &std::path::Path, stamp: i64) -> PathBuf {
    let first = dir.join(format!("ctx-{stamp}.png"));
    if !first.exists() {
        return first;
    }
    for n in 2..1000 {
        let candidate = dir.join(format!("ctx-{stamp}-{n}.png"));
        if !candidate.exists() {
            return candidate;
        }
    }
    first
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_path_never_reuses_a_name_within_the_same_second() {
        let dir = std::env::temp_dir().join(format!("canopy-freepath-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = free_path(&dir, 1700);
        std::fs::write(&a, b"a").unwrap();
        let b = free_path(&dir, 1700);
        assert_ne!(a, b);
        std::fs::write(&b, b"b").unwrap();
        assert_ne!(free_path(&dir, 1700), b);
        // A different second starts clean again.
        assert_eq!(free_path(&dir, 1701), dir.join("ctx-1701.png"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn strip_ansi_drops_csi_and_osc() {
        let raw = b"\x1b[31mred\x1b[0m line\r\x1b]0;title\x07tail";
        assert_eq!(strip_ansi(raw), "red line\ntail");
    }

    #[test]
    fn fts_query_quotes_and_prefixes() {
        assert_eq!(fts_query("spo sea"), "\"spo\"* \"sea\"*");
        assert_eq!(fts_query("a\"b"), "\"a\"\"b\"*");
        assert_eq!(fts_query("  "), "");
    }

    #[test]
    fn scoping_is_by_directory_not_by_string_prefix() {
        let roots = vec!["/Users/dev/app".to_string()];
        assert!(under_roots("/Users/dev/app", &roots));
        assert!(under_roots("/Users/dev/app/src", &roots));
        // The sibling shares a prefix but is a different project.
        assert!(!under_roots("/Users/dev/app-old", &roots));
        assert!(!under_roots("/Users/dev/other", &roots));
        // No roots is "everything", not "nothing".
        assert!(under_roots("/anywhere", &[]));
    }

    #[test]
    fn age_costs_a_hit_something_but_never_everything() {
        let now = 1_800_000_000;
        let day = 86_400;
        assert_eq!(age_penalty(0, now), 0.0, "no timestamp, no penalty");
        let fresh = age_penalty(now - day, now);
        let month = age_penalty(now - 30 * day, now);
        let year = age_penalty(now - 365 * day, now);
        assert!(fresh < month && month < year);
        // Flattening: a year is not twelve times worse than a month.
        assert!(year < month * 2.0);
    }
}

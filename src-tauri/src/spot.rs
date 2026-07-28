// SpotSearch's persistent half: a SQLite FTS5 index over the two sources too
// big to scan per keystroke — agent conversation transcripts
// (~/.claude/projects/**/*.jsonl) and live terminal scrollback. Everything else
// the palette shows (files, tabs, tickets, servers…) is queried live by the
// frontend; this module holds only what would otherwise mean re-reading tens of
// megabytes on every keystroke.
//
// Ingestion is incremental and budgeted. Transcripts are append-only JSONL, so
// a per-file byte offset (the same pattern as agents::fold_usage) means each
// call parses only what grew since the last one; a call that exhausts its byte
// budget reports `more: true` and the frontend simply calls again. Scrollback
// is a bounded ring per live PTY (pty::SCROLLBACK_CAP), re-indexed whole when
// its length moves and dropped when its PTY is gone — the terminal section of
// the index only ever describes terminals that still exist.

use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

use crate::fsx::{check_scope, WorkspaceManager};
use crate::pty::PtyManager;

#[derive(Default)]
pub struct SpotIndex(Mutex<Option<Connection>>);

/// Transcript bytes parsed per ingest call. Keeps the palette-open call quick;
/// a cold index (every transcript unread) catches up over a few calls instead
/// of stalling the first one for seconds.
const INGEST_BUDGET: u64 = 4 * 1024 * 1024;
/// Longest message body worth indexing — search shows a snippet, and a paste
/// of a whole log file into a prompt should not own the index.
const MAX_BODY: usize = 4000;
/// How much of a terminal's ring to index. The ring itself is capped at 256KB
/// of raw bytes; stripped of escape codes it shrinks further.
const MAX_SCROLLBACK: usize = 256 * 1024;

fn db_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let dir = PathBuf::from(home).join(".canopy");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("spot-index.sqlite"))
}

fn open_db() -> Result<Connection, String> {
    let conn = Connection::open(db_path()?).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sources (
             path TEXT PRIMARY KEY,
             offset INTEGER NOT NULL
         );
         CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
             kind UNINDEXED, key UNINDEXED, title, body, meta UNINDEXED, ts UNINDEXED
         );",
    )
    .map_err(|e| e.to_string())?;
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

/// The searchable text of one transcript line: user and assistant turns only.
/// Tool calls and results are skipped — they are volume without recall value
/// (their interesting parts end up quoted in the assistant's own text).
fn message_text(entry: &serde_json::Value) -> Option<String> {
    let ty = entry["type"].as_str()?;
    if ty != "user" && ty != "assistant" {
        return None;
    }
    let content = &entry["message"]["content"];
    let text = if let Some(s) = content.as_str() {
        s.to_string()
    } else if let Some(items) = content.as_array() {
        items
            .iter()
            .filter_map(|i| {
                if i["type"] == "text" {
                    i["text"].as_str()
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        return None;
    };
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    Some(t.chars().take(MAX_BODY).collect())
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

#[derive(Serialize)]
pub struct SpotIngestReport {
    /// The transcript budget ran out with files still unread — call again.
    pub more: bool,
    /// Transcript messages added this call.
    pub messages: usize,
    /// Terminals whose scrollback was (re)indexed this call.
    pub terminals: usize,
}

/// Bring the index up to date. Called by the frontend when the palette opens
/// (and again while `more`), never on a timer — an index nobody is about to
/// search is not worth a disk walk.
#[tauri::command]
pub async fn spot_ingest(
    state: State<'_, SpotIndex>,
    ptys: State<'_, PtyManager>,
) -> Result<SpotIngestReport, String> {
    // Snapshot the live terminals before taking the db lock: id, title, cwd,
    // and the ring's tail. Brief per-session locks, nothing held across the db
    // work.
    let live: Vec<(u32, String, String)> = {
        let sessions = ptys.sessions();
        let map = sessions.lock().unwrap();
        map.values()
            .map(|s| (s.id, s.title.lock().unwrap().clone(), s.cwd.clone()))
            .collect()
    };
    let tails: Vec<(u32, String, String, Vec<u8>)> = live
        .into_iter()
        .filter_map(|(id, title, cwd)| {
            ptys.scrollback_tail(id, MAX_SCROLLBACK)
                .map(|t| (id, title, cwd, t))
        })
        .collect();

    with_db(&state, |conn| {
        let mut messages = 0usize;
        let mut terminals = 0usize;
        let mut more = false;
        let mut budget = INGEST_BUDGET;

        // ---- transcripts ----
        let home = std::env::var("HOME").unwrap_or_default();
        let root = PathBuf::from(home).join(".claude/projects");
        let mut files: Vec<PathBuf> = Vec::new();
        if let Ok(buckets) = std::fs::read_dir(&root) {
            for bucket in buckets.flatten() {
                if let Ok(entries) = std::fs::read_dir(bucket.path()) {
                    for e in entries.flatten() {
                        let p = e.path();
                        if p.extension().and_then(|x| x.to_str()) == Some("jsonl") {
                            files.push(p);
                        }
                    }
                }
            }
        }
        for path in files {
            let Ok(md) = std::fs::metadata(&path) else {
                continue;
            };
            let len = md.len();
            let path_str = path.to_string_lossy().to_string();
            let mut offset: u64 = conn
                .query_row(
                    "SELECT offset FROM sources WHERE path = ?1",
                    [&path_str],
                    |r| r.get::<_, i64>(0),
                )
                .map(|v| v as u64)
                .unwrap_or(0);
            if len < offset {
                // Truncated or rewritten (compaction) — drop what we had and
                // start the file over.
                conn.execute(
                    "DELETE FROM docs WHERE kind = 'transcript' AND meta = ?1",
                    [&path_str],
                )
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
            let Ok(mut f) = std::fs::File::open(&path) else {
                continue;
            };
            if f.seek(SeekFrom::Start(offset)).is_err() {
                continue;
            }
            let want = (len - offset).min(budget);
            let mut raw = vec![0u8; want as usize];
            let Ok(read) = f.read(&mut raw) else {
                continue;
            };
            raw.truncate(read);
            budget = budget.saturating_sub(read as u64);
            if (read as u64) < len - offset {
                more = true;
            }
            let text = String::from_utf8_lossy(&raw);
            // Only complete lines: the writer may be mid-append, and a half
            // line parsed now would be lost to the offset bump.
            let consumed = match text.rfind('\n') {
                Some(i) => i + 1,
                None => 0,
            };
            if consumed == 0 {
                continue;
            }
            let session_id = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let mtime = md
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let mut insert = conn
                .prepare_cached(
                    "INSERT INTO docs (kind, key, title, body, meta, ts)
                     VALUES ('transcript', ?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(|e| e.to_string())?;
            for line in text[..consumed].lines() {
                let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
                    continue;
                };
                let Some(body) = message_text(&entry) else {
                    continue;
                };
                let title = entry["cwd"].as_str().unwrap_or("");
                insert
                    .execute(rusqlite::params![session_id, title, body, path_str, mtime])
                    .map_err(|e| e.to_string())?;
                messages += 1;
            }
            drop(insert);
            conn.execute(
                "INSERT INTO sources (path, offset) VALUES (?1, ?2)
                 ON CONFLICT(path) DO UPDATE SET offset = ?2",
                rusqlite::params![path_str, (offset + consumed as u64) as i64],
            )
            .map_err(|e| e.to_string())?;
        }

        // ---- terminal scrollback ----
        // The set of terminal docs mirrors the set of live PTYs exactly: dead
        // ones go (their pty id means nothing after a relaunch, and a result
        // that can't be opened is a dead row), changed ones are replaced whole.
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
            let body = strip_ansi(&tail);
            conn.execute(
                "DELETE FROM docs WHERE kind = 'terminal' AND key = ?1",
                [&key],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO docs (kind, key, title, body, meta, ts)
                 VALUES ('terminal', ?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![key, title, body, cwd, now_secs()],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO sources (path, offset) VALUES (?1, ?2)
                 ON CONFLICT(path) DO UPDATE SET offset = ?2",
                rusqlite::params![key, tail.len() as i64],
            )
            .map_err(|e| e.to_string())?;
            terminals += 1;
        }

        Ok(SpotIngestReport {
            more,
            messages,
            terminals,
        })
    })
}

#[derive(Serialize)]
pub struct SpotHit {
    /// "transcript" | "terminal".
    pub kind: String,
    /// Session id for a transcript, "pty:<id>" for a terminal.
    pub key: String,
    /// Cwd (transcript) or tab title (terminal) — whatever names the container.
    pub title: String,
    /// The matched text, trimmed to the match by FTS5.
    pub snippet: String,
    /// Transcript path (transcript) or cwd (terminal).
    pub meta: String,
    pub ts: i64,
}

/// Search the persistent index. Hits come back deduplicated to one per
/// container (a session, a terminal) — the palette opens containers, and five
/// rows for five messages of one conversation would drown everything else.
#[tauri::command]
pub async fn spot_search(
    state: State<'_, SpotIndex>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<SpotHit>, String> {
    let match_q = fts_query(&query);
    if match_q.is_empty() {
        return Ok(Vec::new());
    }
    let cap = limit.unwrap_or(20) as usize;
    with_db(&state, |conn| {
        let mut stmt = conn
            .prepare_cached(
                "SELECT kind, key, title, snippet(docs, 3, '', '', ' … ', 14), meta, ts
                 FROM docs WHERE docs MATCH ?1 ORDER BY rank LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![match_q, (cap * 5) as i64], |r| {
                Ok(SpotHit {
                    kind: r.get(0)?,
                    key: r.get(1)?,
                    title: r.get(2)?,
                    snippet: r.get(3)?,
                    meta: r.get(4)?,
                    ts: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out: Vec<SpotHit> = Vec::new();
        for hit in rows.filter_map(Result::ok) {
            if out.len() >= cap {
                break;
            }
            if out.iter().any(|h| h.kind == hit.kind && h.key == hit.key) {
                continue;
            }
            out.push(hit);
        }
        Ok(out)
    })
}

/// Write a captured page screenshot where a micro-task brief can point at it:
/// `<dir>/.canopy/spot/ctx-<stamp>.png`, inside a registered workspace root so
/// the agent's own file tools can read it back. Returns the absolute path.
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
    let path = target.join(format!("ctx-{}.png", now_secs()));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn message_text_reads_both_shapes() {
        let s: serde_json::Value = serde_json::json!({
            "type": "user", "message": { "content": "hello" }
        });
        assert_eq!(message_text(&s).as_deref(), Some("hello"));
        let a: serde_json::Value = serde_json::json!({
            "type": "assistant",
            "message": { "content": [
                { "type": "text", "text": "one" },
                { "type": "tool_use", "name": "x" },
                { "type": "text", "text": "two" }
            ]}
        });
        assert_eq!(message_text(&a).as_deref(), Some("one\ntwo"));
        let t: serde_json::Value = serde_json::json!({ "type": "progress" });
        assert_eq!(message_text(&t), None);
    }
}

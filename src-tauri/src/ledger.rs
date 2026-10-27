//! The ledger: one durable, append-only record of what the brain and the
//! agents produced for a project — plans, proof receipts, memories, awareness
//! notes, handoffs, review verdicts, spend.
//!
//! Ten features write here, so it is deliberately one store with one shape
//! rather than ten little stores that each invent their own file, their own
//! idea of "latest", and their own way of being read by agents. Each feature
//! owns its `kind` and the shape of `data`; the ledger owns identity, time,
//! attribution, scope and supersession.
//!
//! Layout: `~/.canopy/ledger/<hash>.jsonl`, one file per repository, where the
//! hash is of the repo's canonical root (its *main* checkout — see
//! `canonical_root`). JSONL like provenance.rs, for the same reasons: entries
//! have no body to revise, and a line is the unit of atomic append.
//!
//! Append-only, including status changes. `update_status` appends a copy that
//! names the entry it `supersedes`; `query` folds every chain so callers see
//! only the head. Nothing is ever rewritten in place, which is what lets two
//! Canopy windows (and, later, the context server) write the same file without
//! a lock file: each write is a single `write_all` on an O_APPEND handle.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::Emitter;

/// Tauri event carrying each newly appended entry (supersede records included).
pub const LEDGER_APPENDED: &str = "ledger-appended";

/// The kinds the ledger accepts. Closed on purpose: a typo'd kind would be a
/// silent second store nobody queries.
pub const KINDS: &[&str] = &[
    "plan",
    "receipt",
    "memory",
    "awareness",
    "handoff",
    "rule",
    "spend",
    "review",
    "outcome",
];
const SCOPES: &[&str] = &["personal", "project", "team"];
const AUTHOR_KINDS: &[&str] = &["agent", "human", "brain", "workspace"];

/// Largest single entry accepted. An entry is a judgment, not a transcript;
/// anything bigger belongs in notes/research with a ref here.
const ENTRY_MAX: usize = 256 * 1024;
const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 5000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerAuthor {
    pub kind: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pty_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LedgerRef {
    pub kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    /// Assigned on append when empty. Sortable: zero-padded ms then random.
    #[serde(default)]
    pub id: String,
    pub kind: String,
    /// Unix ms. Assigned on append when 0.
    #[serde(default)]
    pub ts: u64,
    /// The canonical root the entry is filed under — always overwritten on
    /// append, so every reader sees the key the store actually used.
    #[serde(default)]
    pub root: String,
    pub author: LedgerAuthor,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub reference: Option<LedgerRef>,
    #[serde(default)]
    pub data: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supersedes: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerQuery {
    #[serde(default)]
    pub kinds: Option<Vec<String>>,
    #[serde(default)]
    pub ref_kind: Option<String>,
    #[serde(default)]
    pub ref_id: Option<String>,
    #[serde(default)]
    pub since_ts: Option<u64>,
    #[serde(default)]
    pub limit: Option<usize>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_id(ts: u64) -> String {
    let mut bytes = [0u8; 6];
    // A failed RNG still yields a unique-enough id within one ms per process;
    // the counter covers the burst case.
    let _ = getrandom::getrandom(&mut bytes);
    static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) & 0xffff;
    format!("{ts:013}-{}{seq:04x}", hex::encode(bytes))
}

/// The one name a repository has here: its main checkout's directory.
///
/// Same rule as provenance.rs `repo_key`, for the same reason: an agent works
/// in a linked worktree while the person's panel stands in the main checkout,
/// and both must land in one file. `--git-common-dir` is shared by every
/// worktree, so its parent is the answer they agree on. A directory git
/// cannot speak for is canonicalized instead, so `foo/` and `foo` and a
/// symlink to it still agree. Memoised: it is a subprocess, and queries are
/// frequent.
pub fn canonical_root(path: &str) -> String {
    static SEEN: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    let seen = SEEN.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = seen.lock().ok().and_then(|m| m.get(path).cloned()) {
        return hit;
    }
    let dir = Path::new(path);
    let key = crate::git::common_dir(dir)
        .and_then(|d| d.parent().map(Path::to_path_buf))
        .or_else(|| dir.canonicalize().ok())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| path.trim_end_matches(['/', '\\']).to_string());
    if let Ok(mut m) = seen.lock() {
        m.insert(path.to_string(), key.clone());
    }
    key
}

/// Stable file stem for a canonical root. SHA-256 rather than a std hasher:
/// `DefaultHasher` is explicitly not stable across Rust releases, and a
/// toolchain bump must not orphan every ledger.
pub fn root_hash(canonical: &str) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(&Sha256::digest(canonical.as_bytes())[..16])
}

/// `CANOPY_LEDGER_HOME` points straight at the store (tests, sandboxes);
/// otherwise `~/.canopy/ledger`, beside notes and provenance.
pub fn store_dir() -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("CANOPY_LEDGER_HOME") {
        return Ok(PathBuf::from(dir));
    }
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    Ok(PathBuf::from(home).join(".canopy").join("ledger"))
}

fn file_for(dir: &Path, canonical: &str) -> PathBuf {
    dir.join(format!("{}.jsonl", root_hash(canonical)))
}

/// Serialises this process's appends. O_APPEND already keeps one write whole;
/// the lock keeps `update_status`'s read-then-append from racing itself.
fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn validate(entry: &LedgerEntry) -> Result<(), String> {
    if !KINDS.contains(&entry.kind.as_str()) {
        return Err(format!("unknown ledger kind: {}", entry.kind));
    }
    if !SCOPES.contains(&entry.scope.as_str()) {
        return Err(format!("unknown ledger scope: {}", entry.scope));
    }
    if !AUTHOR_KINDS.contains(&entry.author.kind.as_str()) {
        return Err(format!("unknown ledger author kind: {}", entry.author.kind));
    }
    if entry.author.name.trim().is_empty() {
        return Err("a ledger entry needs an author name".into());
    }
    Ok(())
}

/// Append to the ledger stored in `dir`, filed under an already-canonical
/// root. The pure core of `append`; tests call it with a temp dir.
pub fn append_in(
    dir: &Path,
    canonical: &str,
    mut entry: LedgerEntry,
) -> Result<LedgerEntry, String> {
    validate(&entry)?;
    if entry.ts == 0 {
        entry.ts = now_ms();
    }
    if entry.id.is_empty() {
        entry.id = new_id(entry.ts);
    }
    entry.root = canonical.to_string();
    let mut line = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    if line.len() > ENTRY_MAX {
        return Err(format!(
            "ledger entry is {} bytes; the limit is {ENTRY_MAX}",
            line.len()
        ));
    }
    line.push('\n');
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file_for(dir, canonical))
        .map_err(|e| e.to_string())?;
    // One write per line: the whole line or none of it reaches the file.
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    Ok(entry)
}

/// Every entry on disk, oldest first, unfolded. An unparseable line (a torn
/// write from a crash) is skipped, not fatal.
fn read_all(dir: &Path, canonical: &str) -> Vec<LedgerEntry> {
    let Ok(raw) = std::fs::read_to_string(file_for(dir, canonical)) else {
        return Vec::new();
    };
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// Drop every entry some later entry supersedes, leaving only chain heads.
fn fold(entries: Vec<LedgerEntry>) -> Vec<LedgerEntry> {
    let superseded: HashSet<String> = entries
        .iter()
        .filter_map(|e| e.supersedes.clone())
        .collect();
    entries
        .into_iter()
        .filter(|e| !superseded.contains(&e.id))
        .collect()
}

/// Query the ledger stored in `dir`. Newest first, folded, unexpired.
pub fn query_in(dir: &Path, canonical: &str, q: &LedgerQuery) -> Vec<LedgerEntry> {
    let now = now_ms();
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let mut out: Vec<LedgerEntry> = fold(read_all(dir, canonical))
        .into_iter()
        .filter(|e| e.expires_at.is_none_or(|t| t > now))
        .filter(|e| {
            q.kinds
                .as_ref()
                .is_none_or(|ks| ks.is_empty() || ks.iter().any(|k| *k == e.kind))
        })
        .filter(|e| q.since_ts.is_none_or(|s| e.ts >= s))
        .filter(|e| {
            q.ref_kind
                .as_ref()
                .is_none_or(|k| e.reference.as_ref().is_some_and(|r| r.kind == *k))
        })
        .filter(|e| {
            q.ref_id
                .as_ref()
                .is_none_or(|id| e.reference.as_ref().is_some_and(|r| r.id == *id))
        })
        .collect();
    // Stable sort on ts, newest first; file order breaks ties (later wins).
    out.reverse();
    out.sort_by(|a, b| b.ts.cmp(&a.ts));
    out.truncate(limit);
    out
}

/// Change an entry's status by appending its successor. `id` may name any
/// entry in the chain — callers holding an id from before an earlier status
/// change still reach the head.
pub fn update_status_in(
    dir: &Path,
    canonical: &str,
    id: &str,
    status: &str,
) -> Result<LedgerEntry, String> {
    let _held = write_lock().lock().map_err(|_| "ledger lock poisoned")?;
    let all = read_all(dir, canonical);
    let successor: HashMap<&str, &str> = all
        .iter()
        .filter_map(|e| e.supersedes.as_deref().map(|s| (s, e.id.as_str())))
        .collect();
    let mut head = id;
    let mut hops = 0;
    while let Some(next) = successor.get(head) {
        head = next;
        hops += 1;
        if hops > all.len() {
            return Err("ledger supersede chain loops".into());
        }
    }
    let current = all
        .iter()
        .rev()
        .find(|e| e.id == head)
        .ok_or_else(|| format!("no ledger entry {id}"))?;
    let mut next = current.clone();
    next.id = String::new();
    next.ts = 0;
    next.supersedes = Some(current.id.clone());
    next.status = Some(status.to_string());
    append_in(dir, canonical, next)
}

// ------------------------------------------------------------ plain API
//
// For any Rust caller — the Tauri commands below, and the context server
// (context.rs), which can expose the ledger to agents as an MCP tool.

pub fn append(root: &str, entry: LedgerEntry) -> Result<LedgerEntry, String> {
    let _held = write_lock().lock().map_err(|_| "ledger lock poisoned")?;
    append_in(&store_dir()?, &canonical_root(root), entry)
}

pub fn query(root: &str, q: &LedgerQuery) -> Result<Vec<LedgerEntry>, String> {
    Ok(query_in(&store_dir()?, &canonical_root(root), q))
}

pub fn update_status(root: &str, id: &str, status: &str) -> Result<LedgerEntry, String> {
    update_status_in(&store_dir()?, &canonical_root(root), id, status)
}

/// Append and tell every window. What a non-command writer (the context
/// server) should call, so subscribed panels hear about agent-written entries.
pub fn append_and_emit(
    app: &tauri::AppHandle,
    root: &str,
    entry: LedgerEntry,
) -> Result<LedgerEntry, String> {
    let entry = append(root, entry)?;
    let _ = app.emit(LEDGER_APPENDED, &entry);
    Ok(entry)
}

// ------------------------------------------------------------ commands

#[tauri::command]
pub async fn ledger_append(
    app: tauri::AppHandle,
    root: String,
    entry: LedgerEntry,
) -> Result<LedgerEntry, String> {
    // canonical_root may shell out to git; keep it off the async workers.
    tauri::async_runtime::spawn_blocking(move || append_and_emit(&app, &root, entry))
        .await
        .map_err(|e| e.to_string())?
}

/// The canonical root `path` files under — what every entry's `root` will
/// say. Lets the frontend key per-repo state the same way the ledger does.
#[tauri::command]
pub async fn ledger_root(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || canonical_root(&path))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ledger_query(root: String, query: LedgerQuery) -> Result<Vec<LedgerEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || self::query(&root, &query))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn ledger_update_status(
    app: tauri::AppHandle,
    root: String,
    id: String,
    status: String,
) -> Result<LedgerEntry, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let entry = update_status(&root, &id, &status)?;
        let _ = app.emit(LEDGER_APPENDED, &entry);
        Ok(entry)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "canopy-ledger-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn entry(kind: &str, ref_id: Option<&str>) -> LedgerEntry {
        LedgerEntry {
            id: String::new(),
            kind: kind.into(),
            ts: 0,
            root: String::new(),
            author: LedgerAuthor {
                kind: "brain".into(),
                name: "receipt".into(),
                session_id: None,
                cli: None,
                pty_id: None,
            },
            scope: "project".into(),
            subject: None,
            reference: ref_id.map(|id| LedgerRef {
                kind: "turn".into(),
                id: id.into(),
            }),
            data: serde_json::json!({ "n": 1 }),
            expires_at: None,
            supersedes: None,
            status: None,
        }
    }

    #[test]
    fn append_assigns_identity_and_files_under_the_root() {
        let dir = temp("append");
        let out = append_in(&dir, "/repo", entry("receipt", None)).unwrap();
        assert!(!out.id.is_empty());
        assert!(out.ts > 0);
        assert_eq!(out.root, "/repo");
        assert!(file_for(&dir, "/repo").is_file());
        // A different root is a different file.
        assert!(query_in(&dir, "/other", &LedgerQuery::default()).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_rejects_unknown_kinds_and_scopes() {
        let dir = temp("reject");
        assert!(append_in(&dir, "/r", entry("diary", None)).is_err());
        let mut bad = entry("plan", None);
        bad.scope = "world".into();
        assert!(append_in(&dir, "/r", bad).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn query_filters_and_orders_newest_first() {
        let dir = temp("query");
        for (i, (kind, r)) in [("plan", "a"), ("receipt", "a"), ("receipt", "b")]
            .iter()
            .enumerate()
        {
            let mut e = entry(kind, Some(r));
            e.ts = 1000 + i as u64;
            append_in(&dir, "/r", e).unwrap();
        }
        let all = query_in(&dir, "/r", &LedgerQuery::default());
        assert_eq!(
            all.iter().map(|e| e.ts).collect::<Vec<_>>(),
            [1002, 1001, 1000]
        );
        let receipts = query_in(
            &dir,
            "/r",
            &LedgerQuery {
                kinds: Some(vec!["receipt".into()]),
                ..Default::default()
            },
        );
        assert_eq!(receipts.len(), 2);
        let about_a = query_in(
            &dir,
            "/r",
            &LedgerQuery {
                ref_kind: Some("turn".into()),
                ref_id: Some("a".into()),
                since_ts: Some(1001),
                ..Default::default()
            },
        );
        assert_eq!(about_a.len(), 1);
        assert_eq!(about_a[0].kind, "receipt");
        let one = query_in(
            &dir,
            "/r",
            &LedgerQuery {
                limit: Some(1),
                ..Default::default()
            },
        );
        assert_eq!(one[0].ts, 1002);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_updates_append_and_fold_to_the_head() {
        let dir = temp("fold");
        let first = append_in(&dir, "/r", entry("plan", Some("p1"))).unwrap();
        let second = update_status_in(&dir, "/r", &first.id, "approved").unwrap();
        assert_eq!(second.supersedes.as_deref(), Some(first.id.as_str()));
        // The original id still reaches the head of the chain.
        let third = update_status_in(&dir, "/r", &first.id, "done").unwrap();
        assert_eq!(third.supersedes.as_deref(), Some(second.id.as_str()));
        let seen = query_in(&dir, "/r", &LedgerQuery::default());
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].id, third.id);
        assert_eq!(seen[0].status.as_deref(), Some("done"));
        assert_eq!(seen[0].data, first.data);
        // Nothing was rewritten: three lines on disk.
        let raw = std::fs::read_to_string(file_for(&dir, "/r")).unwrap();
        assert_eq!(raw.lines().count(), 3);
        assert!(update_status_in(&dir, "/r", "missing", "x").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn expired_entries_and_torn_lines_are_skipped() {
        let dir = temp("expire");
        let mut gone = entry("awareness", None);
        gone.expires_at = Some(1);
        append_in(&dir, "/r", gone).unwrap();
        append_in(&dir, "/r", entry("awareness", None)).unwrap();
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(file_for(&dir, "/r"))
            .unwrap();
        f.write_all(b"{\"id\":\"torn").unwrap();
        assert_eq!(query_in(&dir, "/r", &LedgerQuery::default()).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn root_hash_is_stable_and_roots_canonicalize() {
        assert_eq!(root_hash("/repo"), root_hash("/repo"));
        assert_ne!(root_hash("/repo"), root_hash("/repo2"));
        assert_eq!(root_hash("/repo").len(), 32);
        // A non-git directory canonicalizes, so a trailing slash or `.` hop
        // lands in the same file.
        let dir = temp("root");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let plain = canonical_root(&dir.to_string_lossy());
        let hop = canonical_root(&format!("{}/sub/..", dir.to_string_lossy()));
        assert_eq!(plain, hop);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn entries_round_trip_the_typescript_shape() {
        let raw = r#"{"kind":"receipt","author":{"kind":"agent","name":"Ash","sessionId":"s1","ptyId":3},
            "scope":"team","ref":{"kind":"turn","id":"t1"},"data":{"ok":true},"expiresAt":5}"#;
        let e: LedgerEntry = serde_json::from_str(raw).unwrap();
        assert_eq!(e.author.session_id.as_deref(), Some("s1"));
        assert_eq!(e.author.pty_id, Some(3));
        assert_eq!(e.reference.as_ref().unwrap().id, "t1");
        let back = serde_json::to_value(&e).unwrap();
        assert_eq!(back["ref"]["kind"], "turn");
        assert_eq!(back["expiresAt"], 5);
        assert_eq!(back["author"]["sessionId"], "s1");
    }
}

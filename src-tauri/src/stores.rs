// Every agent CLI's own on-disk session store, in one place.
//
// Two surfaces need to read these and must never disagree: SpotSearch's index
// (spot.rs) wants the message text, and the restore/agents lists (agents.rs)
// want one digest per conversation. Both come from here, so an agent supported
// in search is an agent you can also reopen.
//
// Canopy's hook writes ~/.canopy/sessions for any CLI that will run it; this
// module is for what the CLIs write themselves, which is the only thing that
// exists for a session started outside Canopy — or by a CLI whose plugin API
// never fired.
//
// What each agent keeps, verified against real files on disk:
//
//   claude    ~/.claude/projects/<bucket>/<uuid>.jsonl        append-only JSONL
//   codex     ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl    append-only JSONL
//   omp       ~/.omp/agent/sessions/<dir>/<ts>_<id>.jsonl     append-only JSONL
//   gemini    ~/.gemini/tmp/<sha256(root)>/chats/session-*.json   one JSON doc
//   agy       ~/.gemini/antigravity-cli/conversations/<id>.db     SQLite (proto)
//   opencode  ~/.local/share/opencode/opencode.db                 SQLite
//   aider     <project>/.aider.chat.history.md                    markdown
//
// Amp is deliberately absent: its threads live on Sourcegraph's servers, and
// ~/.config/amp holds plugins and a device id, nothing conversational. There is
// nothing on this machine to index — better stated here than silently missing.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// Longest message body worth indexing — search shows a snippet, and a paste of
/// a whole log file into a prompt should not own the index.
pub const MAX_BODY: usize = 4000;

/// How a store's file has to be read.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Layout {
    /// Append-only: a byte offset is enough, each call parses only what grew.
    Append,
    /// Rewritten in place (JSON docs, SQLite): re-read whole when it changes,
    /// and one file may hold many conversations.
    Whole,
}

/// One file that holds conversations.
#[derive(Clone, Debug)]
pub struct SourceFile {
    pub agent: &'static str,
    pub path: PathBuf,
    pub layout: Layout,
}

/// One conversation, however its store spells that.
#[derive(Clone, Debug, Default)]
pub struct StoreSession {
    pub agent: String,
    pub session_id: String,
    /// Where the agent was working — what a resume has to run in, and what
    /// scopes a search to the project you have open.
    pub cwd: String,
    /// Recognisable label: the first thing the human actually asked for.
    pub title: String,
    /// Unix seconds, from the store's own timestamp or the file's mtime.
    pub updated: i64,
    /// Message bodies, oldest first. Empty for a metadata-only read.
    pub bodies: Vec<String>,
}

/// Agents this module can read, in registry-id form. `amp` is not one of them
/// (see the header) — nor is claude, whose transcripts spot.rs reads through
/// this same door but whose digests come from the hook.
pub const STORE_AGENTS: &[&str] = &[
    "claude", "codex", "omp", "gemini", "agy", "opencode", "aider",
];

fn home() -> String {
    std::env::var("HOME").unwrap_or_default()
}

fn mtime_secs(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn clip(s: &str) -> String {
    s.chars().take(MAX_BODY).collect()
}

/// Text that is context injected around the human's words rather than the words
/// themselves — every CLI wraps its own in angle brackets, and indexing them
/// makes every session match every other one.
fn is_injected(text: &str) -> bool {
    text.trim_start().starts_with('<')
}

/// Files under `root` matching `pred`, walked to `depth` levels. Missing
/// directories are simply no files — every store here is optional.
fn walk(root: &Path, depth: usize, pred: &dyn Fn(&Path) -> bool, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if depth > 0 {
                walk(&p, depth - 1, pred, out);
            }
        } else if pred(&p) {
            out.push(p);
        }
    }
}

fn has_ext(p: &Path, ext: &str) -> bool {
    p.extension().and_then(|x| x.to_str()) == Some(ext)
}

/// Every transcript file on disk for the agents `wanted` says yes to.
///
/// `roots` are the open project's directories: gemini files them under a hash
/// of the project path, and aider writes into the project itself, so neither
/// store can be enumerated without knowing where to look.
pub fn source_files(roots: &[String], wanted: &dyn Fn(&str) -> bool) -> Vec<SourceFile> {
    let home = PathBuf::from(home());
    let mut out: Vec<SourceFile> = Vec::new();
    let mut push = |agent: &'static str, path: PathBuf, layout: Layout| {
        out.push(SourceFile {
            agent,
            path,
            layout,
        });
    };

    // Claude and Codex both file their transcripts inside the config directory
    // the session ran under, so every account profile is its own store. Scanning
    // only `$HOME` would leave a second login's sessions out of search and out
    // of the digests entirely — invisible rather than merely unlabelled.
    let cfg_roots: Vec<PathBuf> = crate::profiles::roots(&home.to_string_lossy())
        .into_iter()
        .map(|(_, root)| root)
        .collect();
    if wanted("claude") {
        let mut files = Vec::new();
        for root in &cfg_roots {
            walk(
                &root.join(".claude/projects"),
                1,
                &|p| has_ext(p, "jsonl"),
                &mut files,
            );
        }
        for f in files {
            push("claude", f, Layout::Append);
        }
    }
    if wanted("codex") {
        // Bucketed YYYY/MM/DD, so three levels below the root.
        let mut files = Vec::new();
        for root in &cfg_roots {
            walk(
                &root.join(".codex/sessions"),
                3,
                &|p| has_ext(p, "jsonl"),
                &mut files,
            );
        }
        for f in files {
            push("codex", f, Layout::Append);
        }
    }
    if wanted("omp") {
        // Two deep: `<dir>/<ts>_<id>.jsonl` is a conversation, and
        // `<dir>/<ts>_<id>/<SubAgent>.jsonl` is a sub-agent of that
        // conversation — worth searching, and attributed to its parent so a hit
        // opens the session that spawned it (see append_meta).
        let mut files = Vec::new();
        walk(
            &home.join(".omp/agent/sessions"),
            2,
            &|p| has_ext(p, "jsonl"),
            &mut files,
        );
        for f in files {
            push("omp", f, Layout::Append);
        }
    }
    if wanted("gemini") {
        // Only the buckets that belong to a directory we know: the bucket name
        // is a hash, and there is no way back from it to a path.
        for root in project_hashes(roots) {
            let bucket = home.join(".gemini/tmp").join(&root);
            let mut files = Vec::new();
            walk(
                &bucket.join("chats"),
                0,
                &|p| has_ext(p, "json"),
                &mut files,
            );
            // Saved chats are the sessions the user chose to keep; logs.json is
            // every prompt typed in that project, including the sessions that
            // were never saved. Both, or half the history is missing.
            let log = bucket.join("logs.json");
            if log.exists() {
                files.push(log);
            }
            for f in files {
                push("gemini", f, Layout::Whole);
            }
        }
    }
    if wanted("agy") {
        let mut files = Vec::new();
        walk(
            &home.join(".gemini/antigravity-cli/conversations"),
            0,
            &|p| has_ext(p, "db"),
            &mut files,
        );
        for f in files {
            push("agy", f, Layout::Whole);
        }
    }
    if wanted("opencode") {
        let db = home.join(".local/share/opencode/opencode.db");
        if db.exists() {
            push("opencode", db, Layout::Whole);
        }
    }
    if wanted("aider") {
        // Aider keeps its history in the repo it was run in, one file, no ids.
        for root in roots {
            let p = PathBuf::from(root).join(".aider.chat.history.md");
            if p.exists() {
                push("aider", p, Layout::Whole);
            }
        }
    }
    out
}

/// sha256 of each project path — the name gemini files that project's chats
/// under. Verified against real buckets in ~/.gemini/tmp.
fn project_hashes(roots: &[String]) -> Vec<String> {
    roots
        .iter()
        .map(|r| sha256_hex(r.trim_end_matches('/').as_bytes()))
        .collect()
}

/// Minimal SHA-256. A dependency would do, but this crate has none that exposes
/// one and the whole use is naming a directory.
fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut msg = data.to_vec();
    let bits = (data.len() as u64) * 8;
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for (i, word) in chunk.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (i, v) in [a, b, c, d, e, f, g, hh].iter().enumerate() {
            h[i] = h[i].wrapping_add(*v);
        }
    }
    h.iter().map(|v| format!("{v:08x}")).collect()
}

// ---------- append-only stores ----------

/// The session id and cwd an append-only file names, from its first lines.
/// Reads a bounded head: these are always in the opening records, and the file
/// may be tens of megabytes.
pub fn append_meta(agent: &str, path: &Path) -> (String, String) {
    use std::io::Read;
    let mut head = vec![0u8; 64 * 1024];
    let read = std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut head))
        .unwrap_or(0);
    head.truncate(read);
    let text = String::from_utf8_lossy(&head);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut id = String::new();
    let mut cwd = String::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match agent {
            "claude" => {
                // The file is named for the session; cwd is on every entry.
                if let Some(c) = v["cwd"].as_str() {
                    cwd = c.to_string();
                }
                id = stem.clone();
            }
            "codex" => {
                if v["type"] == "session_meta" {
                    let p = &v["payload"];
                    id = p["session_id"].as_str().unwrap_or_default().to_string();
                    cwd = p["cwd"].as_str().unwrap_or_default().to_string();
                }
            }
            "omp" => {
                if v["type"] == "session" {
                    id = v["id"].as_str().unwrap_or_default().to_string();
                    cwd = v["cwd"].as_str().unwrap_or_default().to_string();
                }
            }
            _ => {}
        }
        if !id.is_empty() && !cwd.is_empty() {
            break;
        }
    }
    if id.is_empty() {
        // A sub-agent transcript carries no session record of its own — it sits
        // in a directory named for the conversation that spawned it
        // (`<ts>_<uuid>/<SubAgent>.jsonl`), and that conversation is what a hit
        // should open. Falling back to the file's own stem would key it to a
        // name no CLI can resume.
        let parent = path
            .parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        id = uuid_tail(&parent)
            .or_else(|| uuid_tail(&stem))
            .unwrap_or(stem.clone());
        if cwd.is_empty() {
            // omp buckets by a mangled path; the session record in the parent's
            // own transcript is the reliable source, so look there.
            if let Some(sibling) = path.parent().map(|p| p.with_extension("jsonl")) {
                if sibling.exists() {
                    cwd = append_meta(agent, &sibling).1;
                }
            }
        }
    }
    (id, cwd)
}

/// The uuid at the end of a name like `2026-07-19T23-41-29-912Z_019f7cc1-…` or
/// `rollout-2026-07-29T07-21-13-019fab3f-…`. None when there isn't one, which
/// is how a sub-agent's own filename is told from a session's.
fn uuid_tail(name: &str) -> Option<String> {
    let tail = name.rsplit(['_', '/']).next().unwrap_or(name);
    let looks_uuid = tail.len() >= 32
        && tail.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
        && tail.contains('-');
    if looks_uuid {
        Some(tail.to_string())
    } else {
        None
    }
}

/// Human- and agent-authored text from one line of an append-only transcript.
/// Tool calls, tool results and injected context are skipped — they are volume
/// without recall value (their interesting parts end up quoted in the agent's
/// own words).
pub fn append_line_text(agent: &str, line: &str) -> Option<String> {
    let v = serde_json::from_str::<Value>(line).ok()?;
    let text = match agent {
        "claude" | "omp" => {
            let ty = v["type"].as_str()?;
            if ty != "user" && ty != "assistant" && ty != "message" {
                return None;
            }
            let msg = &v["message"];
            // omp wraps the same shape one level down and names the role there.
            if ty == "message" {
                let role = msg["role"].as_str().unwrap_or("");
                if role != "user" && role != "assistant" {
                    return None;
                }
            }
            content_text(&msg["content"])?
        }
        "codex" => {
            if v["type"] != "response_item" {
                return None;
            }
            let p = &v["payload"];
            if p["type"] != "message" {
                return None;
            }
            // "developer" is codex's own instruction channel, not the user's.
            let role = p["role"].as_str().unwrap_or("");
            if role != "user" && role != "assistant" {
                return None;
            }
            content_text(&p["content"])?
        }
        _ => return None,
    };
    let t = text.trim();
    if t.is_empty() || is_injected(t) {
        return None;
    }
    Some(clip(t))
}

/// A message body from either shape every one of these CLIs uses: a bare
/// string, or a list of parts of which only the text ones matter.
fn content_text(content: &Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    let items = content.as_array()?;
    let joined = items
        .iter()
        .filter_map(|i| {
            let ty = i["type"].as_str().unwrap_or("");
            // input_text/output_text is codex; text is everyone else.
            if ty == "text" || ty == "input_text" || ty == "output_text" {
                i["text"].as_str()
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if joined.is_empty() {
        None
    } else {
        Some(joined)
    }
}

// ---------- whole-file stores ----------

/// Every conversation in a file that has to be read whole.
pub fn whole_sessions(agent: &str, path: &Path, roots: &[String]) -> Vec<StoreSession> {
    match agent {
        "gemini" => gemini_sessions(path, roots),
        "agy" => agy_sessions(path),
        "opencode" => opencode_sessions(path),
        "aider" => aider_sessions(path),
        _ => Vec::new(),
    }
}

/// gemini: one JSON document per session, `messages[].content` with `type`
/// "user" or "gemini". The directory it sits in is sha256 of the project path,
/// which is the only record of where the session ran.
fn gemini_sessions(path: &Path, roots: &[String]) -> Vec<StoreSession> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let is_log = path.file_name().map(|n| n == "logs.json").unwrap_or(false);
    // chats/<file> is two levels under the bucket; logs.json is one.
    let bucket_dir = if is_log {
        path.parent()
    } else {
        path.parent().and_then(|p| p.parent())
    };
    let bucket = bucket_dir
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let cwd = roots
        .iter()
        .find(|r| sha256_hex(r.trim_end_matches('/').as_bytes()) == bucket)
        .cloned()
        .unwrap_or_default();
    if is_log {
        return gemini_log_sessions(&v, &cwd, mtime_secs(path));
    }
    let mut s = StoreSession {
        agent: "gemini".into(),
        session_id: v["sessionId"].as_str().unwrap_or_default().to_string(),
        cwd,
        updated: mtime_secs(path),
        ..Default::default()
    };
    for m in v["messages"].as_array().into_iter().flatten() {
        let ty = m["type"].as_str().unwrap_or("");
        if ty != "user" && ty != "gemini" {
            continue;
        }
        let Some(text) = m["content"].as_str() else {
            continue;
        };
        let t = text.trim();
        if t.is_empty() || is_injected(t) {
            continue;
        }
        if s.title.is_empty() && ty == "user" {
            s.title = t.chars().take(120).collect();
        }
        s.bodies.push(clip(t));
    }
    if s.session_id.is_empty() || s.bodies.is_empty() {
        return Vec::new();
    }
    vec![s]
}

/// gemini's `logs.json`: a flat list of every prompt typed in that project,
/// tagged with the session it belonged to. Grouped back into sessions here, so
/// a run that was never saved as a chat is still findable by what was asked.
fn gemini_log_sessions(v: &Value, cwd: &str, updated: i64) -> Vec<StoreSession> {
    let mut by_session: Vec<StoreSession> = Vec::new();
    for entry in v.as_array().into_iter().flatten() {
        if entry["type"].as_str() != Some("user") {
            continue;
        }
        let Some(id) = entry["sessionId"].as_str() else {
            continue;
        };
        let Some(text) = entry["message"].as_str() else {
            continue;
        };
        let t = text.trim();
        if t.is_empty() || is_injected(t) {
            continue;
        }
        match by_session.iter_mut().find(|s| s.session_id == id) {
            Some(s) => s.bodies.push(clip(t)),
            None => by_session.push(StoreSession {
                agent: "gemini".into(),
                session_id: id.to_string(),
                cwd: cwd.to_string(),
                title: t.chars().take(120).collect(),
                updated,
                bodies: vec![clip(t)],
            }),
        }
    }
    by_session
}

/// A read-only connection to a store another program owns and may be writing.
fn open_ro(path: &Path) -> Option<rusqlite::Connection> {
    rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
}

/// opencode: one SQLite store for every project, `session` rows joined to
/// `part` rows whose `data` JSON carries the text.
fn opencode_sessions(path: &Path) -> Vec<StoreSession> {
    let Some(conn) = open_ro(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let Ok(mut stmt) = conn
        .prepare("SELECT id, directory, COALESCE(title,''), COALESCE(time_updated,0) FROM session")
    else {
        return out;
    };
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
        ))
    });
    let Ok(rows) = rows else { return out };
    for (id, cwd, title, updated) in rows.flatten() {
        let mut s = StoreSession {
            agent: "opencode".into(),
            session_id: id.clone(),
            cwd,
            title,
            // opencode stores milliseconds.
            updated: updated / 1000,
            bodies: Vec::new(),
        };
        if let Ok(mut parts) = conn
            .prepare("SELECT data FROM part WHERE session_id = ?1 ORDER BY time_created LIMIT 2000")
        {
            if let Ok(rows) = parts.query_map([&id], |r| r.get::<_, String>(0)) {
                for data in rows.flatten() {
                    let Ok(v) = serde_json::from_str::<Value>(&data) else {
                        continue;
                    };
                    // Only the text parts: the rest is tool traffic.
                    let Some(text) = v["text"].as_str() else {
                        continue;
                    };
                    let t = text.trim();
                    if t.is_empty() || is_injected(t) {
                        continue;
                    }
                    s.bodies.push(clip(t));
                }
            }
        }
        if !s.bodies.is_empty() {
            out.push(s);
        }
    }
    out
}

/// Antigravity: one SQLite file per conversation whose payloads are protobuf.
///
/// There is no schema to decode against, so this pulls the printable runs out
/// of the blobs — the prompts and replies are plain UTF-8 inside them. Recall
/// is real; the text is not a faithful transcript, which is why these are only
/// ever shown as a snippet under a row that opens the conversation itself.
fn agy_sessions(path: &Path) -> Vec<StoreSession> {
    let Some(conn) = open_ro(path) else {
        return Vec::new();
    };
    let id = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    // The metadata blob opens with the workspace as a file:// URL.
    let cwd = conn
        .query_row(
            "SELECT data FROM trajectory_metadata_blob LIMIT 1",
            [],
            |r| r.get::<_, Vec<u8>>(0),
        )
        .ok()
        .and_then(|b| first_file_url(&b))
        .unwrap_or_default();
    let mut s = StoreSession {
        agent: "agy".into(),
        session_id: id,
        cwd,
        updated: mtime_secs(path),
        ..Default::default()
    };
    if let Ok(mut stmt) = conn.prepare("SELECT step_payload FROM steps ORDER BY idx LIMIT 500") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, Option<Vec<u8>>>(0)) {
            for blob in rows.flatten().flatten() {
                for run in printable_runs(&blob, 24) {
                    if is_injected(&run) {
                        continue;
                    }
                    if s.title.is_empty() {
                        s.title = run.chars().take(120).collect();
                    }
                    s.bodies.push(clip(&run));
                }
            }
        }
    }
    if s.bodies.is_empty() {
        return Vec::new();
    }
    vec![s]
}

/// The first `file:///…` path in a blob, as a plain path.
fn first_file_url(blob: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(blob);
    let at = text.find("file:///")?;
    let rest = &text[at + "file://".len()..];
    let end = rest
        .find(|c: char| c.is_control() || c == '"')
        .unwrap_or(rest.len());
    let path = rest[..end].trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
}

/// Runs of printable text at least `min` characters long. The protobuf framing
/// bytes are control characters, so this cuts cleanly at field boundaries.
fn printable_runs(blob: &[u8], min: usize) -> Vec<String> {
    let text = String::from_utf8_lossy(blob);
    let mut out = Vec::new();
    let mut cur = String::new();
    for c in text.chars() {
        if c == '\n' || c == '\t' || (!c.is_control() && c != '\u{fffd}') {
            cur.push(c);
        } else {
            if cur.trim().chars().count() >= min {
                out.push(cur.trim().to_string());
            }
            cur.clear();
        }
    }
    if cur.trim().chars().count() >= min {
        out.push(cur.trim().to_string());
    }
    out
}

/// aider: a markdown log in the repo, `#### ` for what the human typed, `> `
/// for tool chatter, everything else the reply. No session ids and no
/// resume-by-id, so each run is keyed by the file and the timestamp its header
/// carries — which is exactly what "open this history" needs.
fn aider_sessions(path: &Path) -> Vec<StoreSession> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let cwd = path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let updated = mtime_secs(path);
    let mut out: Vec<StoreSession> = Vec::new();
    let mut cur: Option<StoreSession> = None;
    for line in raw.lines() {
        if let Some(started) = line.strip_prefix("# aider chat started at ") {
            if let Some(s) = cur.take() {
                if !s.bodies.is_empty() {
                    out.push(s);
                }
            }
            cur = Some(StoreSession {
                agent: "aider".into(),
                session_id: format!(
                    "{}#{}",
                    path.to_string_lossy(),
                    started.trim().replace(' ', "T")
                ),
                cwd: cwd.clone(),
                updated,
                ..Default::default()
            });
            continue;
        }
        let Some(s) = cur.as_mut() else { continue };
        // `> ` is aider narrating itself — versions, retries, git chatter.
        if line.starts_with('>') || line.trim().is_empty() {
            continue;
        }
        let text = line.strip_prefix("#### ").unwrap_or(line).trim();
        if text.is_empty() {
            continue;
        }
        if s.title.is_empty() && line.starts_with("#### ") {
            s.title = text.chars().take(120).collect();
        }
        s.bodies.push(clip(text));
    }
    if let Some(s) = cur {
        if !s.bodies.is_empty() {
            out.push(s);
        }
    }
    out
}

// ---------- digests ----------

/// Digests already read, by file, with the (size, mtime) they were read at.
///
/// session_digests runs every four seconds while a project is on screen, and
/// this walk covers every conversation on the machine — re-parsing them all at
/// that cadence would be a background CPU burn nobody asked for. Stat-and-skip
/// keeps a steady call to a few hundred `stat`s.
/// Path -> (the stamp it was read at, what came out of it).
type DigestsByFile = std::collections::HashMap<String, (i64, Vec<Value>)>;

static DIGEST_CACHE: std::sync::Mutex<Option<DigestsByFile>> = std::sync::Mutex::new(None);

fn stamp_of(path: &Path) -> i64 {
    std::fs::metadata(path)
        .map(|m| {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            (m.len() as i64) ^ (mtime << 20)
        })
        .unwrap_or(-1)
}

/// One digest per conversation these stores hold, in the shape session_digests
/// hands the frontend. Metadata only — the bodies stay in the search index.
///
/// `skip` is for conversations another source already describes better: a
/// claude session Canopy's hook recorded knows which terminal it ran in, which
/// the file on disk cannot say.
pub fn digests(
    roots: &[String],
    wanted: &dyn Fn(&str) -> bool,
    skip: &dyn Fn(&str) -> bool,
) -> Vec<Value> {
    let files = source_files(roots, wanted);
    let mut guard = DIGEST_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = guard.get_or_insert_with(Default::default);
    let mut fresh: DigestsByFile = Default::default();
    let mut out = Vec::new();
    for f in files {
        let key = f.path.to_string_lossy().to_string();
        let stamp = stamp_of(&f.path);
        let parsed = match cache.get(&key) {
            Some((seen, digests)) if *seen == stamp => digests.clone(),
            _ => match f.layout {
                Layout::Append => {
                    let (id, cwd) = append_meta(f.agent, &f.path);
                    if id.is_empty() {
                        Vec::new()
                    } else {
                        vec![digest_json(&StoreSession {
                            agent: f.agent.into(),
                            session_id: id,
                            cwd,
                            title: first_prompt(f.agent, &f.path),
                            updated: mtime_secs(&f.path),
                            bodies: Vec::new(),
                        })]
                    }
                }
                Layout::Whole => whole_sessions(f.agent, &f.path, roots)
                    .into_iter()
                    .filter(|s| !s.session_id.is_empty())
                    .map(|s| {
                        digest_json(&StoreSession {
                            bodies: Vec::new(),
                            ..s
                        })
                    })
                    .collect(),
            },
        };
        for d in &parsed {
            let id = d["session_id"].as_str().unwrap_or("");
            if !id.is_empty() && !skip(id) {
                out.push(d.clone());
            }
        }
        fresh.insert(key, (stamp, parsed));
    }
    // Replaced wholesale, so a deleted file's entry doesn't live forever.
    *cache = fresh;
    out
}

/// The first human turn in an append-only transcript, for the row's label.
/// Bounded like append_meta: the opening prompt is at the top of the file.
fn first_prompt(agent: &str, path: &Path) -> String {
    use std::io::Read;
    let mut head = vec![0u8; 128 * 1024];
    let read = std::fs::File::open(path)
        .and_then(|mut f| f.read(&mut head))
        .unwrap_or(0);
    head.truncate(read);
    String::from_utf8_lossy(&head)
        .lines()
        .find_map(|l| append_line_text(agent, l))
        .map(|t| t.chars().take(120).collect())
        .unwrap_or_default()
}

fn digest_json(s: &StoreSession) -> Value {
    serde_json::json!({
        "session_id": s.session_id,
        "agent": s.agent,
        "cwd": s.cwd,
        "launch_cwd": s.cwd,
        "resume_cwd": s.cwd,
        "updated": s.updated,
        "prompts": if s.title.is_empty() { vec![] } else { vec![s.title.clone()] },
        // Read straight from the CLI's own store, so the conversation provably
        // exists; whether the CLI can reopen it by id is the registry's call.
        "resumable": true,
        "store": true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_geminis_bucket_names() {
        // Verified against a real ~/.gemini/tmp bucket: the name is sha256 of
        // the absolute project path with no trailing slash.
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn claude_and_codex_lines_read_the_same_way() {
        let claude = r#"{"type":"user","cwd":"/repo","message":{"content":"fix the test"}}"#;
        assert_eq!(
            append_line_text("claude", claude).as_deref(),
            Some("fix the test")
        );

        let codex = r#"{"type":"response_item","payload":{"type":"message","role":"user",
            "content":[{"type":"input_text","text":"add a flag"}]}}"#;
        assert_eq!(
            append_line_text("codex", codex).as_deref(),
            Some("add a flag")
        );

        // codex's own instruction channel is not the conversation.
        let dev = r#"{"type":"response_item","payload":{"type":"message","role":"developer",
            "content":[{"type":"input_text","text":"You are codex"}]}}"#;
        assert_eq!(append_line_text("codex", dev), None);

        // Injected context — every CLI wraps its own in angle brackets.
        let injected =
            r#"{"type":"user","message":{"content":"<system-reminder>hi</system-reminder>"}}"#;
        assert_eq!(append_line_text("claude", injected), None);
    }

    #[test]
    fn omp_messages_carry_their_role_one_level_down() {
        let line = r#"{"type":"message","message":{"role":"user","content":[{"type":"text","text":"ship it"}]}}"#;
        assert_eq!(append_line_text("omp", line).as_deref(), Some("ship it"));
        let tool = r#"{"type":"custom","customType":"tool_execution_start","data":{}}"#;
        assert_eq!(append_line_text("omp", tool), None);
    }

    #[test]
    fn printable_runs_pull_prose_out_of_protobuf() {
        let mut blob = vec![0x0a, 0x0c, 0x08, 0x01];
        blob.extend_from_slice(b"Fix the mascot on the dashboard page");
        blob.extend_from_slice(&[0x12, 0x02]);
        blob.extend_from_slice(b"short");
        let runs = printable_runs(&blob, 24);
        assert_eq!(runs, vec!["Fix the mascot on the dashboard page"]);
    }

    #[test]
    fn file_url_gives_the_workspace_back() {
        let blob = b"\n6\n2file:///Users/dev/Projects/app\x1a\x00\x12\x0c";
        assert_eq!(
            first_file_url(blob).as_deref(),
            Some("/Users/dev/Projects/app")
        );
    }

    #[test]
    fn aider_history_splits_into_runs_and_keeps_the_prompts() {
        let dir = std::env::temp_dir().join("canopy-aider-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(".aider.chat.history.md");
        std::fs::write(
            &path,
            "# aider chat started at 2026-07-23 04:30:16\n\
             > Aider v0.86.2  \n\
             #### add a retry\n\
             Sure — adding a retry to the client.\n\
             # aider chat started at 2026-07-24 09:00:00\n\
             #### now log it\n",
        )
        .unwrap();
        let sessions = aider_sessions(&path);
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions[0].title, "add a retry");
        // The `>` line is aider narrating itself, not conversation.
        assert_eq!(sessions[0].bodies.len(), 2);
        assert_eq!(sessions[1].title, "now log it");
        assert!(sessions[0].session_id.ends_with("#2026-07-23T04:30:16"));
        std::fs::remove_file(&path).ok();
    }
}

#[cfg(test)]
mod live {
    //! Smoke checks against the stores actually installed on this machine.
    //! Ignored by default: they assert nothing about a CI box, where none of
    //! these directories exist. Run with `cargo test --lib live -- --ignored
    //! --nocapture` after touching a parser.
    use super::*;

    #[test]
    #[ignore]
    fn what_this_machine_holds() {
        let roots: Vec<String> = std::env::var("CANOPY_TEST_ROOTS")
            .unwrap_or_default()
            .split(':')
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect();
        let files = source_files(&roots, &|_| true);
        let mut per_agent: std::collections::BTreeMap<&str, (usize, usize)> = Default::default();
        for f in &files {
            let e = per_agent.entry(f.agent).or_default();
            e.0 += 1;
            let bodies = match f.layout {
                Layout::Append => {
                    let raw = std::fs::read(&f.path).unwrap_or_default();
                    String::from_utf8_lossy(&raw)
                        .lines()
                        .filter_map(|l| append_line_text(f.agent, l))
                        .count()
                }
                Layout::Whole => whole_sessions(f.agent, &f.path, &roots)
                    .iter()
                    .map(|s| s.bodies.len())
                    .sum(),
            };
            e.1 += bodies;
        }
        for (agent, (files, bodies)) in &per_agent {
            println!("{agent:10} files={files:<5} messages={bodies}");
        }
        let digests = digests(&roots, &|_| true, &|_| false);
        println!("digests: {}", digests.len());
        for d in digests.iter().take(4) {
            println!("  {} {} {}", d["agent"], d["cwd"], d["prompts"][0]);
        }
    }
}

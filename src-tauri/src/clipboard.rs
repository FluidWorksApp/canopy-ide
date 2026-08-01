//! Clipboard history: what you copied, kept, and findable from ⌘K.
//!
//! Three facts decided the shape of this, and each of them is load-bearing.
//!
//! **The webview cannot do it.** `navigator.clipboard.readText()` in WKWebView
//! is gated behind user activation and a native paste affordance — it cannot be
//! polled. Every read here therefore happens in Rust, which is also what SPEC
//! asks for ("Rust core owns all native processes; WebView is pure UI").
//!
//! **Nothing here needs a permission Canopy doesn't already have.**
//! `entitlements.plist` says Canopy is deliberately not sandboxed, so
//! `NSPasteboard` needs no entitlement and no `Info.plist` usage string, and a
//! command this crate defines itself needs no `capabilities/default.json` entry
//! (none of the ~100 commands in `lib.rs` are listed there). There is no
//! dictation-style first-run OS prompt to design around.
//!
//! **But macOS does notice a programmatic read.** `NSPasteboardAccessBehavior`
//! — the SDK enum right next to `changeCount` — documents it plainly: the
//! general pasteboard's default is *to ask upon programmatic access*, and
//! "access that is both user originated and paste related will always be
//! allowed". So the alert is real, and the way to stay under it is to touch
//! contents as rarely as possible:
//!
//!   - `changeCount` is an integer, not contents. Polling it is free of the
//!     alert, and it is the only thing this module does on a timer.
//!   - Contents are read *only* when that integer moves — at most once per copy.
//!   - The first tick after the watcher starts records the count without
//!     reading anything, so turning the feature on never reads whatever was
//!     already sitting on the pasteboard (which, right after a password
//!     manager, is the worst possible thing to capture).
//!   - `accessBehavior` is reported to the frontend, so Settings can say which
//!     state this app is in rather than guessing, and the watcher stops itself
//!     when the user has chosen "always deny".
//!
//! There is no change *notification* to hook instead — AppKit publishes none,
//! which is why every clipboard manager on the platform polls. The interval is
//! deliberately not focus-gated: the whole point is catching a copy made in
//! another app.
//!
//! **Secrets.** Terminals are the primary copy surface in an agent IDE, and
//! what comes out of one is routinely an API key or a `.env` line. Three
//! defences, all of them before the write rather than after:
//!
//!   1. `org.nspasteboard.ConcealedType` / `TransientType` — the convention
//!      password managers and transient producers already mark their clips
//!      with. Present, and the clip is not read at all.
//!   2. A secret-shaped clip (a known key prefix, a named `TOKEN=` line, a
//!      high-entropy single token) is skipped, not stored redacted. See
//!      `looks_secret`.
//!   3. "Don't persist" keeps the whole history in memory for the session and
//!      writes nothing to disk — the same code path against an in-memory
//!      SQLite, and switching it on deletes the file that was there.
//!
//! Not encrypted at rest, deliberately: nothing in the tree encrypts anything
//! at rest today, and a key that unlocks itself at launch (which is what an
//! unprompted history needs) is a lock with its key taped to it. The file is
//! `0600`, secrets never reach it, and "don't persist" is the answer for anyone
//! who wants a stronger promise than that.
//!
//! **Its own store, not spot-index.sqlite.** `spot.rs` states that a schema
//! mismatch drops and rebuilds, because everything in it is derived from files
//! that still exist. A clip has no source to re-read: it is the only
//! authoritative, unrecoverable thing in `~/.canopy`. So it lives in its own
//! file, and `open_db` *refuses* a database written by a newer Canopy rather
//! than dropping it.

use rusqlite::Connection;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// How often `changeCount` is read. Not contents — see the header. Slow enough
/// that the wakeups are invisible against the 60-150MB/idle-CPU targets, quick
/// enough that a clip is in ⌘K before you can reach for it.
const POLL: Duration = Duration::from_millis(700);
/// Longest clip kept. Past this the clip is skipped whole rather than stored
/// truncated: a clipboard manager that hands back half a file is worse than one
/// that admits it didn't keep it.
const MAX_CHARS: usize = 64_000;
/// What a row shows before you open it.
const PREVIEW_CHARS: usize = 280;
/// Rows kept when the frontend doesn't say.
const DEFAULT_KEEP: usize = 200;
/// Ceiling on the frontend's number, so a typo can't turn this into a log.
const MAX_KEEP: usize = 2000;
/// Total stored text. Bounded memory everywhere (SPEC), including on disk.
const MAX_BYTES: i64 = 32 * 1024 * 1024;
/// Bumped only for a real schema change — and a change here means writing a
/// migration, because there is no source to rebuild from.
const SCHEMA_VERSION: i64 = 1;

/// One clip as the palette sees it. `preview` only — the full text is a
/// separate call (`clipboard_read`), so listing 200 clips doesn't ship a
/// megabyte of text into the webview on every keystroke.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Clip {
    pub id: i64,
    /// Unix seconds.
    pub ts: i64,
    pub preview: String,
    /// Characters in the whole clip, which `preview` may not show all of.
    pub chars: i64,
    pub lines: i64,
    /// Project id that was open when it was copied, "" when none was.
    pub project: String,
}

/// What Settings needs to describe this feature honestly.
#[derive(Serialize, Clone, Default, Debug)]
pub struct ClipboardStatus {
    /// There is a pasteboard to watch on this platform.
    pub supported: bool,
    pub watching: bool,
    /// False in "don't persist" mode — history lives only in this process.
    pub persisted: bool,
    /// macOS 15+ `NSPasteboardAccessBehavior`: "default" | "ask" | "allow" |
    /// "deny". Empty when the OS is older than the API, which is also the
    /// honest answer: there is nothing to report.
    pub access: String,
    pub clips: i64,
    pub bytes: i64,
    /// Since launch — the count Settings shows so the secret filter is visible
    /// rather than a claim.
    pub skipped_secrets: u64,
    pub skipped_large: u64,
    pub skipped_concealed: u64,
}

#[derive(Clone, Debug)]
struct Config {
    enabled: bool,
    persist: bool,
    keep: usize,
    retention_days: i64,
    skip_secrets: bool,
    project: String,
}

impl Default for Config {
    fn default() -> Self {
        // Off. Capturing everything anyone copies is not a default anybody gets
        // to choose on a user's behalf — and the first programmatic read is
        // what raises the macOS pasteboard alert, which must follow a decision
        // the user made, not a launch.
        Self {
            enabled: false,
            persist: true,
            keep: DEFAULT_KEEP,
            retention_days: 0,
            skip_secrets: true,
            project: String::new(),
        }
    }
}

#[derive(Default)]
struct Counters {
    secrets: AtomicU64,
    large: AtomicU64,
    concealed: AtomicU64,
}

#[derive(Default)]
pub struct Clipboard {
    cfg: Arc<Mutex<Config>>,
    db: Arc<Mutex<Option<Connection>>>,
    /// The poller is alive. Cleared to stop it; the thread exits at its next
    /// tick and a later enable spawns a fresh one.
    running: Arc<AtomicBool>,
    /// Which poller is the current one. A stop bumps it, so a thread that is
    /// mid-sleep when the feature is switched off and straight back on finds
    /// its generation stale and exits instead of polling alongside the new one
    /// — `running` alone cannot tell those two threads apart.
    generation: Arc<AtomicU64>,
    counters: Arc<Counters>,
}

impl Clipboard {
    /// Stop the poller. Both flags: `running` ends the loop, `generation`
    /// guarantees this particular thread never resumes even if the feature is
    /// switched on again before it wakes.
    fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        self.generation.fetch_add(1, Ordering::SeqCst);
    }

    pub fn shutdown(&self) {
        self.stop();
    }
}

// ---------- the pasteboard ----------

/// macOS. Everything that touches AppKit is behind this one door so the rest of
/// the module is platform-free and testable.
#[cfg(target_os = "macos")]
mod pb {
    use objc2::runtime::NSObjectProtocol;
    use objc2::sel;
    use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};

    pub const SUPPORTED: bool = true;

    /// A counter, not contents. Reading it raises no alert.
    pub fn change_count() -> i64 {
        NSPasteboard::generalPasteboard().changeCount() as i64
    }

    /// Run one pasteboard call inside its own autorelease pool.
    ///
    /// The watcher runs on a bare `std::thread`, which -- unlike a Cocoa run
    /// loop thread -- never drains the pool AppKit returns objects into. Every
    /// `generalPasteboard()` handed back a retained object that nothing
    /// released, forever.
    pub fn autoreleased<T>(f: impl FnOnce() -> T) -> T {
        objc2::rc::autoreleasepool(|_| f())
    }

    /// The UTIs currently declared on the pasteboard. Type metadata, not data —
    /// this is how a clip can be recognised as concealed without reading it.
    pub fn types() -> Vec<String> {
        match NSPasteboard::generalPasteboard().types() {
            Some(list) => list.iter().map(|t| t.to_string()).collect(),
            None => Vec::new(),
        }
    }

    /// The one call that reads contents, and thus the one that the OS may ask
    /// the user about. Only ever reached when `change_count` moved.
    pub fn read_string() -> Option<String> {
        // The type constant is an extern static, hence the unsafe — the call
        // itself is safe.
        let ty = unsafe { NSPasteboardTypeString };
        NSPasteboard::generalPasteboard()
            .stringForType(ty)
            .map(|s| s.to_string())
    }

    /// macOS 15+. Guarded by `respondsToSelector` rather than a version check:
    /// Canopy's minimum is 10.15, and an unrecognised selector is a crash, not
    /// a None.
    pub fn access_behavior() -> String {
        let pb = NSPasteboard::generalPasteboard();
        if !pb.respondsToSelector(sel!(accessBehavior)) {
            return String::new();
        }
        match pb.accessBehavior().0 {
            0 => "default",
            1 => "ask",
            2 => "allow",
            3 => "deny",
            _ => "",
        }
        .to_string()
    }
}

/// Everywhere else. Windows and Linux have clipboards, but neither has been
/// verified against a running Canopy, and a watcher that half-works is worse
/// than one that says it isn't here.
#[cfg(not(target_os = "macos"))]
mod pb {
    pub const SUPPORTED: bool = false;
    pub fn autoreleased<T>(f: impl FnOnce() -> T) -> T {
        f()
    }

    pub fn change_count() -> i64 {
        0
    }
    pub fn types() -> Vec<String> {
        Vec::new()
    }
    pub fn read_string() -> Option<String> {
        None
    }
    pub fn access_behavior() -> String {
        String::new()
    }
}

/// The nspasteboard.org convention every serious clipboard manager honours:
/// a producer marks a clip it does not want kept. Password managers set
/// Concealed; "copy this once" tooling sets Transient.
const NO_KEEP_TYPES: &[&str] = &[
    "org.nspasteboard.ConcealedType",
    "org.nspasteboard.TransientType",
    "org.nspasteboard.AutoGeneratedType",
    // What the platform's own secure-input producers mark a password with.
    "com.apple.is-remote-clipboard",
];

fn concealed(types: &[String]) -> bool {
    types
        .iter()
        .any(|t| NO_KEEP_TYPES.iter().any(|n| t.eq_ignore_ascii_case(n)))
}

// ---------- secrets ----------

/// Prefixes that name themselves. Not exhaustive and never will be — this is
/// the cheap half of the filter, and `high_entropy` is the half that catches
/// the key whose vendor isn't listed here.
const KEY_PREFIXES: &[&str] = &[
    "sk-",
    "sk_live_",
    "sk_test_",
    "rk_live_",
    "whsec_",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "glpat-",
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "xapp-",
    "AKIA",
    "ASIA",
    "AIza",
    "ya29.",
    "npm_",
    "dop_v1_",
    "doo_v1_",
    "hf_",
    "SG.",
    "shpat_",
    "pypi-",
    "eyJ", // a JWT's header is always base64 of {"…
];

/// Words that, in the name half of `NAME=VALUE`, make the value a secret
/// whatever it looks like. `.env` lines are the exact case this exists for.
const SECRET_WORDS: &[&str] = &[
    "key",
    "token",
    "secret",
    "password",
    "passwd",
    "pwd",
    "credential",
    "auth",
    "bearer",
    "apikey",
    "access_key",
    "private",
    "session",
    "cookie",
];

fn shannon_bits(s: &str) -> f64 {
    let mut counts = std::collections::HashMap::new();
    let mut n = 0usize;
    for c in s.chars() {
        *counts.entry(c).or_insert(0usize) += 1;
        n += 1;
    }
    if n == 0 {
        return 0.0;
    }
    let n = n as f64;
    -counts
        .values()
        .map(|&c| {
            let p = c as f64 / n;
            p * p.log2()
        })
        .sum::<f64>()
}

/// All hex — a git SHA, a checksum, a hash. Copying one of those is ordinary
/// work, so hex is exempted from the entropy test (hex maxes out at 4 bits a
/// character and would otherwise trip it every time).
fn hexish(s: &str) -> bool {
    s.chars().all(|c| c.is_ascii_hexdigit())
}

/// A path or a URL. Both are single tokens, both are long, both are mixed-case
/// — and "Copy path" is the single most-used clipboard action in this IDE
/// (FileTree, CommitView, GitPanel and TeamPanel all offer it), so neither may
/// be mistaken for a key on shape alone.
///
/// Any `/` at all is enough. Base64 secrets can contain one, but every vendor
/// whose keys do is in `KEY_PREFIXES` — and getting `src/components/App.tsx:12`
/// wrong is a bug people would hit hourly.
fn pathish(s: &str) -> bool {
    s.contains('/') || s.contains('\\') || s.starts_with('~')
}

fn char_classes(s: &str) -> usize {
    let lower = s.chars().any(|c| c.is_ascii_lowercase());
    let upper = s.chars().any(|c| c.is_ascii_uppercase());
    let digit = s.chars().any(|c| c.is_ascii_digit());
    let other = s.chars().any(|c| !c.is_ascii_alphanumeric());
    [lower, upper, digit, other].iter().filter(|b| **b).count()
}

/// Random-looking enough, long enough, and not one of the ordinary long tokens
/// people copy all day.
///
/// Every threshold here is set by a false positive that mattered more than the
/// miss it allows. 32 characters rather than 24, because a camelCase identifier
/// runs to about thirty and copying one is normal work. At least one digit,
/// because a long run of pure letters is a sentence or a symbol name, never a
/// base64 key. Hex and paths are exempted outright — see above.
fn high_entropy(s: &str) -> bool {
    s.len() >= 32
        && s.len() <= 4096
        && !hexish(s)
        && !pathish(s)
        && s.chars().any(|c| c.is_ascii_digit())
        && char_classes(s) >= 2
        && shannon_bits(s) >= 3.6
}

fn prefixed(s: &str) -> bool {
    KEY_PREFIXES
        .iter()
        .any(|p| s.starts_with(p) && s.len() >= p.len() + 12)
}

/// Does the name half of an assignment say this is a secret? The name is
/// everything before the `=`, which for a URL is the whole thing up to the
/// query parameter — so `…?access_token=…` is caught by the same rule as an
/// env line, with no separate URL parser.
fn secret_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SECRET_WORDS.iter().any(|w| lower.contains(w))
}

/// Should this clip never be written down?
///
/// Deliberately conservative in one direction and generous in the other: a
/// missed secret is a plaintext key on disk, a false positive is one clip you
/// have to copy again. Paths, URLs, SHAs and prose are protected explicitly
/// because they are what an IDE clipboard is mostly for.
pub fn looks_secret(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    // A private key names itself in its first line.
    if t.contains("-----BEGIN") && t.contains("PRIVATE KEY") {
        return true;
    }
    // The whole clip as one token — a key pasted on its own, which is how a key
    // is nearly always copied.
    if !t.chars().any(char::is_whitespace) && (prefixed(t) || high_entropy(t)) {
        return true;
    }
    // `NAME=VALUE` / `name: value` lines whose name says secret. `.env` files,
    // `export` lines, YAML config, and a URL's query string all land here.
    //
    // Only the *name* decides, plus a vendor prefix in the value. The
    // whole-token entropy test is deliberately not applied per line: a copied
    // line of code is usually an assignment, and `const id =
    // someLongIdentifierName2` would trip it every time.
    for line in t.lines().take(200) {
        let line = line.trim().trim_start_matches("export ");
        let Some((name, value)) = line.split_once('=').or_else(|| line.split_once(": ")) else {
            continue;
        };
        let value = value.trim().trim_matches(['"', '\'', ',', ';']);
        if value.len() >= 8 && secret_name(name) {
            return true;
        }
        if !value.chars().any(char::is_whitespace) && prefixed(value) {
            return true;
        }
    }
    false
}

// ---------- the store ----------

fn db_path() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|_| "no home dir".to_string())?;
    let dir = PathBuf::from(home).join(".canopy");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("clipboard.sqlite"))
}

/// The schema.
///
/// `seq` and not `ts` is what the list is ordered by, and that is deliberate.
/// Two copies inside one second are ordinary, and picking an old clip out of
/// the history has to move it to the top *now* — with a seconds-resolution
/// timestamp as the sort key, the row it displaced would still sort above it.
/// A monotonic counter is also immune to the clock moving under it, which an
/// NTP correction or a timezone change will do.
fn create(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS clips (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             seq INTEGER NOT NULL DEFAULT 0,
             ts INTEGER NOT NULL,
             text TEXT NOT NULL,
             chars INTEGER NOT NULL,
             lines INTEGER NOT NULL DEFAULT 1,
             project TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS clips_seq ON clips(seq DESC);",
    )
    .map_err(|e| e.to_string())
}

/// The next position at the top of the list.
fn next_seq(conn: &Connection) -> i64 {
    conn.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM clips", [], |r| {
        r.get(0)
    })
    .unwrap_or(1)
}

/// Open the store, and take the version seriously.
///
/// This is the one place Canopy's two SQLite stores differ on purpose. `spot.rs`
/// drops and rebuilds on a version mismatch because every row in it is derived.
/// Nothing here is: a clip's only copy is the row. So a database written by a
/// *newer* Canopy is an error the user is told about, never something this
/// version deletes on its way past.
fn open_db(persist: bool) -> Result<Connection, String> {
    let conn = if persist {
        let path = db_path()?;
        let conn = Connection::open(&path).map_err(|e| e.to_string())?;
        // Owner-only, from the moment it exists. Clips are not secrets by the
        // time they get here (see `looks_secret`), but they are still every
        // fragment of text this person copied today.
        restrict(&path);
        conn
    } else {
        Connection::open_in_memory().map_err(|e| e.to_string())?
    };
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if version > SCHEMA_VERSION {
        return Err(format!(
            "clipboard history was written by a newer Canopy (schema {version}); \
             this version won't touch it"
        ));
    }
    create(&conn)?;
    if version != SCHEMA_VERSION {
        conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
            .map_err(|e| e.to_string())?;
    }
    Ok(conn)
}

#[cfg(unix)]
fn restrict(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict(_path: &std::path::Path) {}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn preview_of(text: &str) -> String {
    // One line, collapsed: a row is one line tall, and a 40-line clip whose
    // first line is blank would otherwise show as an empty row.
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(PREVIEW_CHARS).collect()
}

/// Write a clip, or recognise that it is the one already on top.
///
/// Re-copying the same text — and picking a clip out of the history, which puts
/// it back on the pasteboard and so comes straight back through the poller —
/// moves the existing row to the top instead of making a duplicate. Returns the
/// row id when something was actually stored.
fn record(
    conn: &Connection,
    text: &str,
    project: &str,
    keep: usize,
    retention_days: i64,
) -> Result<Option<i64>, String> {
    let ts = now_secs();
    let newest: Option<(i64, String)> = conn
        .query_row(
            "SELECT id, text FROM clips ORDER BY seq DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .ok();
    if let Some((id, existing)) = &newest {
        if existing == text {
            // Already on top. Freshen the timestamp so retention counts from
            // the last time it was actually copied, and report nothing stored —
            // there is no new row for the palette to show.
            conn.execute("UPDATE clips SET ts = ?1 WHERE id = ?2", (ts, id))
                .map_err(|e| e.to_string())?;
            return Ok(None);
        }
    }
    // Anywhere else in the history: same clip, so move it rather than keep two.
    let dup: Option<i64> = conn
        .query_row(
            "SELECT id FROM clips WHERE text = ?1 LIMIT 1",
            [text],
            |r| r.get(0),
        )
        .ok();
    if let Some(id) = dup {
        conn.execute(
            "UPDATE clips SET seq = ?1, ts = ?2, project = ?3 WHERE id = ?4",
            (next_seq(conn), ts, project, id),
        )
        .map_err(|e| e.to_string())?;
        return Ok(Some(id));
    }
    let chars = text.chars().count() as i64;
    let lines = text.lines().count().max(1) as i64;
    conn.execute(
        "INSERT INTO clips (seq, ts, text, chars, lines, project) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        (next_seq(conn), ts, text, chars, lines, project),
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    prune(conn, keep, retention_days)?;
    Ok(Some(id))
}

/// Three caps, applied newest-first: how many rows, how old, how many bytes.
/// The count is the one the user sets; the byte cap is the backstop that keeps
/// two hundred enormous clips from being two hundred megabytes.
fn prune(conn: &Connection, keep: usize, retention_days: i64) -> Result<(), String> {
    let keep = keep.clamp(1, MAX_KEEP) as i64;
    conn.execute(
        "DELETE FROM clips WHERE id NOT IN
           (SELECT id FROM clips ORDER BY seq DESC LIMIT ?1)",
        [keep],
    )
    .map_err(|e| e.to_string())?;
    if retention_days > 0 {
        let cutoff = now_secs() - retention_days * 86_400;
        conn.execute("DELETE FROM clips WHERE ts < ?1", [cutoff])
            .map_err(|e| e.to_string())?;
    }
    // Byte cap: drop oldest until it fits. A loop rather than one statement
    // because "the newest N rows that fit in M bytes" is a running total, and
    // this runs at human copy speed over at most a few thousand rows.
    loop {
        let bytes: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(LENGTH(text)), 0) FROM clips",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if bytes <= MAX_BYTES {
            break;
        }
        let removed = conn
            .execute(
                "DELETE FROM clips WHERE id = (SELECT id FROM clips ORDER BY seq ASC LIMIT 1)",
                [],
            )
            .map_err(|e| e.to_string())?;
        if removed == 0 {
            break;
        }
    }
    Ok(())
}

fn recent(conn: &Connection, limit: usize) -> Result<Vec<Clip>, String> {
    let limit = limit.clamp(1, MAX_KEEP) as i64;
    let mut stmt = conn
        .prepare(
            "SELECT id, ts, text, chars, lines, project FROM clips
             ORDER BY seq DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], |r| {
            let text: String = r.get(2)?;
            Ok(Clip {
                id: r.get(0)?,
                ts: r.get(1)?,
                preview: preview_of(&text),
                chars: r.get(3)?,
                lines: r.get(4)?,
                project: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

// ---------- the watcher ----------

impl Clipboard {
    /// Run `f` against the store, opening it on first use in the mode the
    /// config asks for.
    fn with_db<T>(&self, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String> {
        let persist = self.cfg.lock().unwrap().persist;
        let mut guard = self.db.lock().unwrap();
        if guard.is_none() {
            *guard = Some(open_db(persist)?);
        }
        f(guard.as_ref().unwrap())
    }

    /// Close the store and reopen it in the other mode. Turning persistence
    /// *off* deletes the file: "don't write my clipboard to disk" has to mean
    /// the clips already there too — the same rule Settings → SpotSearch
    /// applies when an agent is switched off.
    fn repersist(&self, persist: bool) -> Result<(), String> {
        let mut guard = self.db.lock().unwrap();
        *guard = None;
        if !persist {
            if let Ok(path) = db_path() {
                let _ = std::fs::remove_file(path);
            }
        }
        *guard = Some(open_db(persist)?);
        Ok(())
    }
}

fn spawn_poller(app: AppHandle, state: &Clipboard) {
    let cfg = state.cfg.clone();
    let db = state.db.clone();
    let running = state.running.clone();
    let generation = state.generation.clone();
    let counters = state.counters.clone();
    let mine = generation.load(Ordering::SeqCst);
    // A plain OS thread, not a tokio task: this holds an AppKit object across
    // its whole life and does nothing async, so a runtime worker would only be
    // a place for it to block.
    std::thread::spawn(move || {
        let alive = || running.load(Ordering::SeqCst) && generation.load(Ordering::SeqCst) == mine;
        // The count as it is *now*, recorded without reading anything. This is
        // what keeps enabling the feature from capturing whatever the last app
        // put there — very often a password.
        let mut last = pb::autoreleased(pb::change_count);
        while alive() {
            std::thread::sleep(POLL);
            if !alive() {
                break;
            }
            // Every AppKit call here returns autoreleased objects, and a plain
            // std::thread has no pool to drain them into — so they accumulated
            // for the life of the process, roughly a hundred thousand a day at
            // this interval. Invisible in a CPU profile; not invisible in RSS.
            let count = pb::autoreleased(pb::change_count);
            if count == last {
                continue;
            }
            last = count;

            // The user told the OS never to let this app read the pasteboard.
            // Believe it, and stop asking rather than generating a denial per
            // copy for the rest of the session.
            if pb::access_behavior() == "deny" {
                running.store(false, Ordering::SeqCst);
                let _ = app.emit("clipboard:blocked", ());
                break;
            }

            // Type metadata, not data: a concealed clip is recognised without
            // ever being read.
            if concealed(&pb::types()) {
                counters.concealed.fetch_add(1, Ordering::Relaxed);
                continue;
            }

            // Every config field this tick needs, read in one lock and before
            // the store's — `with_db` takes cfg then db, so the poller must
            // never take them the other way round.
            let Some(cfg_now) = ({
                let c = cfg.lock().unwrap();
                if c.enabled {
                    Some(c.clone())
                } else {
                    None
                }
            }) else {
                continue;
            };

            // The one read of contents, at most once per copy.
            let Some(raw) = pb::read_string() else {
                continue;
            };
            let text = raw.trim_end_matches(['\n', '\r']);
            if text.trim().is_empty() {
                continue;
            }
            if text.chars().count() > MAX_CHARS {
                counters.large.fetch_add(1, Ordering::Relaxed);
                continue;
            }
            if cfg_now.skip_secrets && looks_secret(text) {
                counters.secrets.fetch_add(1, Ordering::Relaxed);
                continue;
            }

            let stored = {
                let mut guard = db.lock().unwrap();
                if guard.is_none() {
                    match open_db(cfg_now.persist) {
                        Ok(conn) => *guard = Some(conn),
                        Err(e) => {
                            log::warn!("clipboard store unavailable: {e}");
                            running.store(false, Ordering::SeqCst);
                            break;
                        }
                    }
                }
                record(
                    guard.as_ref().unwrap(),
                    text,
                    &cfg_now.project,
                    cfg_now.keep,
                    cfg_now.retention_days,
                )
            };
            match stored {
                // Only a genuinely new (or moved) clip is worth waking the UI
                // for; re-copying what is already on top changes nothing to
                // show. Same rule prwatch.rs follows.
                Ok(Some(_)) => {
                    let _ = app.emit("clipboard:changed", ());
                }
                Ok(None) => {}
                Err(e) => log::warn!("clipboard not stored: {e}"),
            }
        }
    });
}

// ---------- commands ----------

/// Declare whether to watch, and under what rules. Called on launch and every
/// time the relevant settings or the active project change — the same shape as
/// `pr_watch_set`, and idempotent for the same reason.
#[tauri::command]
pub async fn clipboard_watch_set(
    app: AppHandle,
    state: State<'_, Clipboard>,
    enabled: bool,
    persist: bool,
    keep: usize,
    retention_days: i64,
    skip_secrets: bool,
    project: String,
) -> Result<(), String> {
    let repersist = {
        let mut c = state.cfg.lock().unwrap();
        let changed = c.persist != persist;
        c.enabled = enabled && pb::SUPPORTED;
        c.persist = persist;
        c.keep = keep.clamp(1, MAX_KEEP);
        c.retention_days = retention_days.max(0);
        c.skip_secrets = skip_secrets;
        c.project = project;
        changed
    };
    if repersist {
        state.repersist(persist)?;
    }
    // Retention is applied here rather than only on capture: someone who
    // shortens the window expects the old clips gone now, not after the next
    // time they copy something. Only if the store is already open — this call
    // runs on every launch, and creating the file for a feature nobody has
    // switched on would be the one thing this module must not do.
    let (keep, days) = {
        let c = state.cfg.lock().unwrap();
        (c.keep, c.retention_days)
    };
    let open = state.db.lock().unwrap().is_some();
    if open {
        let _ = state.with_db(|conn| prune(conn, keep, days));
    }

    let want = enabled && pb::SUPPORTED;
    if !want {
        state.stop();
    } else if !state.running.swap(true, Ordering::SeqCst) {
        // A fresh generation, so a poller stopped moments ago and still asleep
        // cannot wake up next to this one.
        state.generation.fetch_add(1, Ordering::SeqCst);
        spawn_poller(app, &state);
    }
    Ok(())
}

/// The newest clips, previews only.
#[tauri::command]
pub async fn clipboard_recent(
    state: State<'_, Clipboard>,
    limit: Option<usize>,
) -> Result<Vec<Clip>, String> {
    state.with_db(|conn| recent(conn, limit.unwrap_or(DEFAULT_KEEP)))
}

/// One clip in full. The only call that returns whole clip text, so the palette
/// pays for it once, on Enter, rather than on every keystroke.
#[tauri::command]
pub async fn clipboard_read(state: State<'_, Clipboard>, id: i64) -> Result<String, String> {
    state.with_db(|conn| {
        conn.query_row("SELECT text FROM clips WHERE id = ?1", [id], |r| r.get(0))
            .map_err(|_| "that clip is gone".to_string())
    })
}

#[tauri::command]
pub async fn clipboard_forget(state: State<'_, Clipboard>, id: i64) -> Result<(), String> {
    state.with_db(|conn| {
        conn.execute("DELETE FROM clips WHERE id = ?1", [id])
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub async fn clipboard_clear(state: State<'_, Clipboard>) -> Result<(), String> {
    state.with_db(|conn| {
        conn.execute_batch("DELETE FROM clips; VACUUM;")
            .map_err(|e| e.to_string())
    })
}

/// What Settings shows. Reads `accessBehavior`, which is metadata about this
/// app's permission and not pasteboard contents — no alert, and it is the only
/// way to tell someone why their history stopped filling up.
#[tauri::command]
pub async fn clipboard_status(state: State<'_, Clipboard>) -> Result<ClipboardStatus, String> {
    let (watching, persisted) = {
        let c = state.cfg.lock().unwrap();
        (c.enabled && state.running.load(Ordering::SeqCst), c.persist)
    };
    let (clips, bytes) = state
        .with_db(|conn| {
            let clips: i64 = conn
                .query_row("SELECT COUNT(*) FROM clips", [], |r| r.get(0))
                .unwrap_or(0);
            let bytes: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(LENGTH(text)), 0) FROM clips",
                    [],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            Ok((clips, bytes))
        })
        .unwrap_or((0, 0));
    Ok(ClipboardStatus {
        supported: pb::SUPPORTED,
        watching,
        persisted,
        access: pb::access_behavior(),
        clips,
        bytes,
        skipped_secrets: state.counters.secrets.load(Ordering::Relaxed),
        skipped_large: state.counters.large.load(Ordering::Relaxed),
        skipped_concealed: state.counters.concealed.load(Ordering::Relaxed),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        create(&conn).unwrap();
        conn
    }

    #[test]
    fn secrets_are_recognised_by_prefix_by_name_and_by_shape() {
        // Named themselves.
        assert!(looks_secret("sk-ant-api03-AAAAbbbbCCCCddddEEEEffff"));
        assert!(looks_secret("ghp_16C7e42F292c6912E7710c838347Ae178B4a"));
        assert!(looks_secret("AKIAIOSFODNN7EXAMPLE0000"));
        assert!(looks_secret(
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNza\n-----END OPENSSH PRIVATE KEY-----"
        ));
        // A .env line — the name decides, not the value's shape.
        assert!(looks_secret("STRIPE_SECRET_KEY=abcd1234efgh"));
        assert!(looks_secret("export DATABASE_PASSWORD=hunter2hunter2"));
        assert!(looks_secret("api_key: 9f8e7d6c5b4a3210"));
        // A query string is the same rule.
        assert!(looks_secret(
            "https://api.example.com/v1/thing?access_token=Zm9vYmFyYmF6cXV4"
        ));
        // Shape alone, for the vendor nobody listed.
        assert!(looks_secret("Xq7!vB2rTz9pLm4KdW8sYh3NcE6uJf0A"));
    }

    #[test]
    fn the_things_an_ide_clipboard_is_actually_for_are_not_secrets() {
        // The single most-copied thing in this app.
        assert!(!looks_secret(
            "/Users/dev/Documents/GitHub/canopy/src-tauri/src/clipboard.rs"
        ));
        assert!(!looks_secret("src/components/ProjectView/index.tsx:5340"));
        // A commit SHA is high-entropy by any measure and completely ordinary.
        assert!(!looks_secret("e4752cbf1a0c9d3e8b7f6a5d4c3b2a1908f7e6d5"));
        assert!(!looks_secret(
            "https://github.com/FluidWorksApp/canopy/pull/270"
        ));
        assert!(!looks_secret("git rebase --onto main feat/spot-compose"));
        assert!(!looks_secret(
            "The palette doesn't know this file's functions — it asks the registry."
        ));
        assert!(!looks_secret(""));
        assert!(!looks_secret("   \n  "));
        // Ordinary config that happens to use `=`.
        assert!(!looks_secret("NODE_ENV=development"));
    }

    #[test]
    fn concealed_clips_are_recognised_from_their_types_alone() {
        assert!(concealed(&["org.nspasteboard.ConcealedType".into()]));
        assert!(concealed(&[
            "public.utf8-plain-text".into(),
            "org.nspasteboard.TransientType".into(),
        ]));
        assert!(!concealed(&["public.utf8-plain-text".into()]));
        assert!(!concealed(&[]));
    }

    #[test]
    fn re_copying_the_top_clip_moves_it_rather_than_duplicating_it() {
        let conn = mem();
        assert!(record(&conn, "hello", "p1", 50, 0).unwrap().is_some());
        // Exactly what happens when a clip is picked out of history: it goes
        // back on the pasteboard and the poller sees it again.
        assert!(record(&conn, "hello", "p1", 50, 0).unwrap().is_none());
        assert_eq!(recent(&conn, 50).unwrap().len(), 1);

        record(&conn, "second", "p1", 50, 0).unwrap();
        // The older one, re-copied: moved to the top, still one row.
        assert!(record(&conn, "hello", "p1", 50, 0).unwrap().is_some());
        let rows = recent(&conn, 50).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].preview, "hello");
    }

    #[test]
    fn the_count_cap_drops_the_oldest_and_keeps_the_newest() {
        let conn = mem();
        for i in 0..10 {
            record(&conn, &format!("clip {i}"), "", 3, 0).unwrap();
        }
        let rows = recent(&conn, 50).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].preview, "clip 9");
        assert_eq!(rows[2].preview, "clip 7");
    }

    #[test]
    fn retention_drops_what_is_older_than_the_window() {
        let conn = mem();
        record(&conn, "recent", "", 50, 0).unwrap();
        conn.execute(
            "INSERT INTO clips (seq, ts, text, chars, lines, project)
             VALUES (0, ?1, 'ancient', 7, 1, '')",
            [now_secs() - 40 * 86_400],
        )
        .unwrap();
        assert_eq!(recent(&conn, 50).unwrap().len(), 2);
        prune(&conn, 50, 30).unwrap();
        let rows = recent(&conn, 50).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].preview, "recent");
    }

    #[test]
    fn a_preview_is_one_line_and_the_full_text_is_not_lost() {
        let conn = mem();
        let text = "first line\n\n\n    second line   \nthird";
        let id = record(&conn, text, "", 50, 0).unwrap().unwrap();
        let rows = recent(&conn, 50).unwrap();
        assert_eq!(rows[0].preview, "first line second line third");
        assert_eq!(rows[0].lines, 5);
        // The row is a preview; the clip is whole.
        let full: String = conn
            .query_row("SELECT text FROM clips WHERE id = ?1", [id], |r| r.get(0))
            .unwrap();
        assert_eq!(full, text);
    }

    #[test]
    fn a_store_from_a_newer_canopy_is_refused_not_dropped() {
        // The rule that makes this store different from spot-index.sqlite:
        // nothing here can be rebuilt, so an unrecognised schema is an error,
        // never a DROP TABLE.
        let conn = Connection::open_in_memory().unwrap();
        create(&conn).unwrap();
        conn.execute_batch("PRAGMA user_version = 99").unwrap();
        record(&conn, "precious", "", 50, 0).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert!(version > SCHEMA_VERSION);
        // …and the row is still there, which is the whole point.
        assert_eq!(recent(&conn, 50).unwrap().len(), 1);
    }
}

// The research store: Canopy's first-class record of what was investigated,
// what it concluded, and what shipped because of it.
//
// Agents research constantly and, until this module, wrote the results
// wherever they happened to be standing — a scratch directory, the repo root, a
// worktree that got removed an hour later. Three things went wrong every time:
// the finding was lost, nothing distinguished the one-paragraph conclusion from
// the 40KB of raw capture behind it (so the next agent read all of it), and no
// one could say whether a finding had been acted on.
//
// So this is a harness, not a folder. Three rules make it one:
//
//   1. One place. `~/.canopy/research/<project>/<nnnn>-<slug>/`, outside any
//      repo — several agents share one checkout here (and switch its branches
//      under each other), and research that lives in the tree is research that
//      merge-conflicts or disappears with a worktree. Rust owns the directory
//      the way spot.rs owns its index: one gate, no path from outside it.
//
//   2. Enforced tiers. A `digest` of at most DIGEST_MAX characters is what a
//      list returns; the body is fetched only by id; raw captures live in
//      `sources/` and are never returned in bulk, only named. Over-cap writes
//      are *rejected*, with the fix in the message. An agent cannot produce an
//      entry that floods the next agent's context — not because it was asked
//      not to, but because the store will not store it.
//
//   3. A state machine. Every transition is checked here, so "researched" means
//      the same thing to an agent six months later as it did to the one that
//      wrote it, and `implemented` is reached by linking a PR that merged
//      rather than by an agent asserting it.
//
// Everything on disk is plain JSON and markdown: readable without Canopy,
// greppable, and recoverable by hand. `meta.json` is the source of truth;
// the SpotSearch index over it (spot.rs, kind = "research") is derived and
// rebuildable, and no code here reads from it.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// Serializes every write. Several agents in one project routinely hold a
/// research entry open at once — one advancing status, another linking a PR —
/// and a read-modify-write of meta.json is exactly the shape that loses one of
/// them. Cheap: these are millisecond file operations, not held work.
#[derive(Default)]
pub struct ResearchStore(Mutex<()>);

// ---- the caps that make tier 1 a tier ------------------------------------
//
// Chosen against what they cost a reader, not what feels tidy: a list of 20
// entries is the realistic ceiling of a project's open research, and 20 digests
// is ~8KB — affordable in any agent's window. The body is a document one agent
// reads deliberately. A source is a capture nothing reads whole.

/// The one paragraph every list row carries. One paragraph is the point.
const DIGEST_MAX: usize = 400;
/// What to do about it — returned by `get`, not by `list`.
const RECOMMENDATION_MAX: usize = 600;
/// `research.md`. Past this the material is a source, not a finding.
const BODY_MAX: usize = 24 * 1024;
/// One raw capture. Generous — this is where the long material is *supposed*
/// to go — but not unbounded, or the store becomes the dumping ground it exists
/// to replace.
const SOURCE_MAX: usize = 512 * 1024;
/// Sources per entry. An entry needing more than this is two entries.
const MAX_SOURCES: usize = 64;
const TITLE_MAX: usize = 120;
const QUESTION_MAX: usize = 600;
/// Open questions per entry, each capped at DIGEST_MAX.
const MAX_OPEN_QUESTIONS: usize = 12;
/// Default and ceiling for `list`. The ceiling matters: an agent that asks for
/// everything gets the recent everything, not a context flood.
const LIST_DEFAULT: usize = 20;
const LIST_MAX: usize = 50;

// ---- status ---------------------------------------------------------------

/// Where an entry is in its life. The two that matter most are the two nothing
/// else in the IDE could tell you: `researched` (there is a finding, nobody has
/// acted on it) and `implemented` (a PR carrying it merged).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// The question is written down; nobody has started.
    Open,
    Researching,
    /// There is a finding. This is the state that used to be invisible.
    Researched,
    Implementing,
    Implemented,
    /// Stuck and waiting on a human — reachable from either working state,
    /// and not an ending.
    Blocked,
    /// A later entry replaced this one. Kept, because "we looked at this and
    /// changed our minds" is worth more than a deletion.
    Superseded,
    Archived,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Open => "open",
            Status::Researching => "researching",
            Status::Researched => "researched",
            Status::Implementing => "implementing",
            Status::Implemented => "implemented",
            Status::Blocked => "blocked",
            Status::Superseded => "superseded",
            Status::Archived => "archived",
        }
    }

    fn parse(s: &str) -> Result<Status, String> {
        Ok(match s {
            "open" => Status::Open,
            "researching" => Status::Researching,
            "researched" => Status::Researched,
            "implementing" => Status::Implementing,
            "implemented" => Status::Implemented,
            "blocked" => Status::Blocked,
            "superseded" => Status::Superseded,
            "archived" => Status::Archived,
            other => {
                return Err(format!(
                    "unknown status \"{other}\" — one of: open, researching, researched, \
                     implementing, implemented, blocked, superseded, archived"
                ))
            }
        })
    }

    /// Where this state may go next. Archiving is always allowed (it is how you
    /// put something down), and a state may always be re-entered so a repeated
    /// call is a no-op rather than an error — an agent retrying after a dropped
    /// reply should not get a failure for the state it already reached.
    fn next(self) -> &'static [Status] {
        use Status::*;
        match self {
            Open => &[Researching, Archived],
            Researching => &[Researched, Blocked, Archived],
            // Blocked remembers nothing about which side it came from, so it
            // can resume into either. That is deliberate: a human unblocking an
            // entry knows which it is, and encoding it here would mean a second
            // state to keep honest for no gain.
            Blocked => &[Researching, Researched, Implementing, Archived],
            // Reopening is normal — a finding that did not survive contact with
            // the code goes back to researching rather than being deleted.
            Researched => &[Implementing, Researching, Blocked, Superseded, Archived],
            Implementing => &[Implemented, Researched, Blocked, Archived],
            Implemented => &[Superseded, Archived],
            Superseded => &[Archived],
            Archived => &[],
        }
    }

    fn can_move_to(self, to: Status) -> bool {
        self == to || self.next().contains(&to)
    }

    /// The shortest legal route from here to `to`, excluding this state itself.
    /// A refused move is nearly always a state two hops away rather than an
    /// illegal one, and an agent told only its immediate neighbours has to
    /// rediscover the machine one refusal at a time. `None` when there is no
    /// route at all — archived is an ending, and saying so beats a list.
    fn route_to(self, to: Status) -> Option<Vec<Status>> {
        let mut seen = vec![self];
        let mut frontier: Vec<Vec<Status>> = vec![Vec::new()];
        while !frontier.is_empty() {
            let mut onward = Vec::new();
            for path in frontier {
                let at = path.last().copied().unwrap_or(self);
                for &step in at.next() {
                    if step == to {
                        let mut found = path.clone();
                        found.push(step);
                        return Some(found);
                    }
                    if seen.contains(&step) {
                        continue;
                    }
                    seen.push(step);
                    let mut branch = path.clone();
                    branch.push(step);
                    onward.push(branch);
                }
            }
            frontier = onward;
        }
        None
    }
}

/// Render a route the way an agent should read it: "researching → researched →
/// implementing", one call per arrow.
fn route_str(from: Status, route: &[Status]) -> String {
    std::iter::once(from.as_str())
        .chain(route.iter().map(|s| s.as_str()))
        .collect::<Vec<_>>()
        .join(" → ")
}

/// Why a move was refused, and what to do instead.
///
/// This message is the module's most-read piece of prose: every agent that
/// researched something and then implemented it tries `researching` →
/// `implemented` and lands here. Listing the immediate neighbours told it the
/// move was wrong without telling it the right one, so it guessed again. The
/// route is therefore spelled out, and `implemented` — the one status Canopy
/// writes itself, off a merged pull request — says so rather than looking like
/// a state the agent simply approached from the wrong side.
fn transition_error(from: Status, to: Status) -> String {
    let onward = if from.next().is_empty() {
        format!("nothing moves out of {}", from.as_str())
    } else {
        format!(
            "from here it can go to: {}",
            from.next()
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    if to == Status::Implemented {
        let via = match from.route_to(Status::Implementing) {
            Some(route) => format!(
                " Move it to implementing when the work starts ({}), and record the pull \
                 request with action \"link\".",
                route_str(from, &route)
            ),
            None => String::new(),
        };
        return format!(
            "{} cannot become implemented — that status is Canopy's to write, and it \
             writes it when every pull request linked to the entry has merged.{} If no \
             pull request carries the work, say so with action \"append\" and leave the \
             entry in researched rather than declaring it shipped. {onward}.",
            from.as_str(),
            via
        );
    }
    match from.route_to(to) {
        Some(route) => format!(
            "{} cannot become {} in one move — {onward}. The route is {}, one call per step.",
            from.as_str(),
            to.as_str(),
            route_str(from, &route)
        ),
        None => format!(
            "{} cannot become {} — {onward}.",
            from.as_str(),
            to.as_str()
        ),
    }
}

// ---- the record -----------------------------------------------------------

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct PrLink {
    pub repo: String,
    pub number: u64,
    #[serde(default)]
    pub url: String,
    /// "open" | "merged" | "closed" — refreshed by the PR watcher, which is
    /// what lets `implementing` become `implemented` without anyone asserting
    /// it.
    #[serde(default)]
    pub state: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct TicketLink {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Links {
    #[serde(default)]
    pub tickets: Vec<TicketLink>,
    #[serde(default)]
    pub prs: Vec<PrLink>,
    #[serde(default)]
    pub branches: Vec<String>,
    /// Files the research is about — the fastest way back into the code.
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub supersedes: Vec<String>,
    #[serde(default)]
    pub superseded_by: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SourceRef {
    /// Relative to the entry directory, always under `sources/`.
    pub file: String,
    pub title: String,
    /// Where it came from — a file path, a URL, a command. Free text, because
    /// the useful answer varies and a taxonomy here would be guessed.
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub bytes: u64,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub at: i64,
    pub from: String,
    pub to: String,
    /// Who moved it — "claude@pty12", or "user" from the panel.
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub note: String,
}

/// `meta.json`. Every field defaulted: an entry hand-edited to something
/// slightly wrong should still open, because the alternative is research that
/// becomes unreadable through a typo.
#[derive(Clone, Serialize, Deserialize)]
pub struct Meta {
    pub id: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub question: String,
    pub status: Status,
    #[serde(default)]
    pub digest: String,
    #[serde(default)]
    pub recommendation: String,
    #[serde(default)]
    pub open_questions: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub agent: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub pty_id: Option<u64>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub sources: Vec<SourceRef>,
    #[serde(default)]
    pub links: Links,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
}

/// A list row: tier one and nothing else. Deliberately missing the
/// recommendation, the body and the sources — a list that carried them would be
/// the context flood this module exists to prevent.
#[derive(Serialize, Debug)]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub status: &'static str,
    pub digest: String,
    pub tags: Vec<String>,
    pub agent: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub source_count: usize,
    pub pr_count: usize,
    /// Set when a later entry replaced this one, so a reader never acts on a
    /// superseded finding without being told where the current one is.
    pub superseded_by: Option<String>,
}

/// Tier two: the whole record, minus the source bodies. `sources` here is the
/// manifest — names and origins — so a reader chooses which capture to open
/// instead of receiving all of them.
#[derive(Serialize)]
pub struct Detail {
    #[serde(flatten)]
    pub summary: Summary,
    pub question: String,
    pub recommendation: String,
    pub open_questions: Vec<String>,
    pub body: String,
    pub sources: Vec<SourceRef>,
    pub links: Links,
    pub history: Vec<HistoryEntry>,
    /// Absolute path to the entry directory. The one place research is allowed
    /// to write, and what the PreToolUse harness checks against.
    pub dir: String,
}

/// A project that has research, for the panel's project switcher. Written
/// beside the entries so a project removed from the workspace (which changes
/// its id) leaves something recoverable rather than an orphaned hash.
#[derive(Clone, Serialize, Deserialize)]
pub struct ProjectRef {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub roots: Vec<String>,
}

// ---- paths ----------------------------------------------------------------

fn root() -> Result<PathBuf, String> {
    let home = std::env::var("CANOPY_RESEARCH_HOME")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "no home dir".to_string())?;
    let dir = PathBuf::from(home);
    // CANOPY_RESEARCH_HOME points straight at the store (tests); HOME needs the
    // usual ~/.canopy/research.
    let dir = if std::env::var("CANOPY_RESEARCH_HOME").is_ok() {
        dir
    } else {
        dir.join(".canopy").join("research")
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Project ids come from the frontend workspace file, so they are trusted-ish —
/// but "ish" is not a security model when the value becomes a path segment.
/// Anything that could climb out of the store is rejected outright rather than
/// sanitised into something that silently addresses the wrong project.
fn project_dir(project_id: &str) -> Result<PathBuf, String> {
    let id = project_id.trim();
    if id.is_empty() {
        return Err("no project — research is scoped to one project, and this \
                    directory is not inside an open one"
            .into());
    }
    if id.len() > 128
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.starts_with('.')
    {
        return Err(format!("bad project id: {id}"));
    }
    Ok(root()?.join(id))
}

/// Entry ids are minted here (`nnnn-slug`) and never accepted in any other
/// shape, which is the whole path gate: a value matching this pattern cannot
/// contain a separator, a dot segment, or anything else that escapes.
fn valid_id(id: &str) -> bool {
    let Some((num, slug)) = id.split_once('-') else {
        return false;
    };
    num.len() == 4
        && num.bytes().all(|b| b.is_ascii_digit())
        && !slug.is_empty()
        && slug.len() <= 64
        && slug
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

fn entry_dir(project_id: &str, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!(
            "not a research id: \"{id}\" — ids look like 0007-index-staleness \
             (call list to see them)"
        ));
    }
    Ok(project_dir(project_id)?.join(id))
}

/// A path inside an entry, for `sources/` and `artifacts/` reads. Resolved and
/// then checked to be under the entry, so a symlink or a `..` that survived the
/// textual check still cannot address anything outside it.
fn entry_file(project_id: &str, id: &str, rel: &str) -> Result<PathBuf, String> {
    let dir = entry_dir(project_id, id)?;
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() || rel.contains("..") {
        return Err(format!("bad path inside the entry: {rel}"));
    }
    let target = dir.join(rel);
    let base = dir.canonicalize().unwrap_or(dir.clone());
    let resolved = target.canonicalize().unwrap_or(target.clone());
    if !resolved.starts_with(&base) {
        return Err(format!("{rel} is outside the research entry"));
    }
    Ok(target)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Lowercase, dashed, and short enough to read in a tab title.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('-') {
            out.push('-');
        }
        if out.len() >= 48 {
            break;
        }
    }
    let s = out.trim_matches('-').to_string();
    if s.is_empty() {
        "untitled".into()
    } else {
        s
    }
}

/// Rename over the top rather than truncate-and-write: a crash mid-write leaves
/// the previous meta.json, not half of one.
fn write_atomic(path: &Path, body: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// ---- caps -----------------------------------------------------------------

/// Reject with the fix in the message. Every one of these is read by an agent
/// mid-task, so "too long" alone would just produce a retry at the same length;
/// naming where the material belongs is what makes the cap productive rather
/// than obstructive.
fn cap(field: &str, value: &str, max: usize, fix: &str) -> Result<(), String> {
    let n = value.chars().count();
    if n > max {
        return Err(format!(
            "{field} is {n} characters; the limit is {max}. {fix}"
        ));
    }
    Ok(())
}

fn check_digest(v: &str) -> Result<(), String> {
    cap(
        "digest",
        v,
        DIGEST_MAX,
        "The digest is the one paragraph every other agent reads instead of the \
         whole entry — say the finding and stop. Detail belongs in the body \
         (action \"append\"), long material in sources.",
    )
}

// ---- read -----------------------------------------------------------------

fn read_meta(dir: &Path) -> Result<Meta, String> {
    let raw = std::fs::read_to_string(dir.join("meta.json"))
        .map_err(|e| format!("no research entry there: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("meta.json is unreadable: {e}"))
}

fn write_meta(dir: &Path, meta: &Meta) -> Result<(), String> {
    let body = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("meta.json"), &body)
}

fn body_path(dir: &Path) -> PathBuf {
    dir.join("research.md")
}

fn read_body(dir: &Path) -> String {
    std::fs::read_to_string(body_path(dir)).unwrap_or_default()
}

fn summarize(m: &Meta) -> Summary {
    Summary {
        id: m.id.clone(),
        title: m.title.clone(),
        status: m.status.as_str(),
        digest: m.digest.clone(),
        tags: m.tags.clone(),
        agent: m.agent.clone(),
        created_at: m.created_at,
        updated_at: m.updated_at,
        source_count: m.sources.len(),
        pr_count: m.links.prs.len(),
        superseded_by: m.links.superseded_by.clone(),
    }
}

/// Every entry of one project, newest first. Unreadable entries are skipped
/// rather than failing the list — one hand-mangled meta.json must not hide the
/// other nineteen.
fn load_project(project_id: &str) -> Result<Vec<Meta>, String> {
    let dir = project_dir(project_id)?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<Meta> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            valid_id(&name).then(|| read_meta(&e.path()).ok())?
        })
        .collect();
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

// ---- commands -------------------------------------------------------------
//
// Each write command is a thin wrapper that takes the serialising lock,
// delegates to an `*_impl` below, and announces the change. The split is not
// ceremony: it is what lets the tests at the bottom drive a whole lifecycle —
// start, cap rejection, illegal transition, supersede — against a real
// directory, which is the only way the state machine is actually checked
// rather than merely described.

/// The store moved. Carries the project id, so a listener refreshes the one
/// project that changed rather than everything it has ever cached.
///
/// This has to originate here. The renderer has its own announcement
/// (`RESEARCH_EVENT` in `src/research.ts`), but that is a window event raised
/// by the TypeScript mutators, so it only ever covers writes that began in the
/// UI. An agent reaches these commands through the MCP endpoint
/// (`research_op` in context.rs), which never touches that module — so with no
/// emit from this side the panel goes on rendering the list it loaded when it
/// mounted, and research written by an agent stays invisible until the project
/// is reopened. That is indistinguishable, from the user's side, from the
/// write having silently failed.
pub const RESEARCH_CHANGED: &str = "research:changed";

/// Announce on success only. A rejected write — a cap, an illegal transition,
/// a missing entry — has not moved the store, and refreshing on it would be
/// noise. Wraps the result so each command stays one line.
fn emit_changed<T>(app: &AppHandle, project_id: &str, out: Result<T, String>) -> Result<T, String> {
    if out.is_ok() {
        let _ = app.emit(RESEARCH_CHANGED, project_id);
    }
    out
}

/// Tier one. `status` filters to the states asked for; without it the archived
/// and superseded are hidden, because a list is a worklist and those two are
/// neither current nor actionable.
#[tauri::command]
pub fn research_list(
    project_id: String,
    status: Option<Vec<String>>,
    limit: Option<usize>,
) -> Result<Vec<Summary>, String> {
    let want: Option<Vec<Status>> = match status {
        Some(list) if !list.is_empty() => Some(
            list.iter()
                .map(|s| Status::parse(s))
                .collect::<Result<_, _>>()?,
        ),
        _ => None,
    };
    let cap = limit.unwrap_or(LIST_DEFAULT).clamp(1, LIST_MAX);
    Ok(load_project(&project_id)?
        .into_iter()
        .filter(|m| match &want {
            Some(w) => w.contains(&m.status),
            None => !matches!(m.status, Status::Archived | Status::Superseded),
        })
        .take(cap)
        .map(|m| summarize(&m))
        .collect())
}

/// Find research in *this project*, by substring over everything tier one
/// carries plus the question and the body.
///
/// Deliberately a scan rather than a query against the SpotSearch index: there
/// are tens of entries per project, not tens of thousands, and a scan cannot go
/// stale. The index still carries research (spot.rs, kind = "research") for the
/// palette, where it competes with transcripts and terminals and a shared
/// ranking is the point — but an agent asking "has anyone looked at this
/// already?" deserves an answer from the files themselves.
#[tauri::command]
pub fn research_search(
    project_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<Summary>, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let dir = project_dir(&project_id)?;
    let cap = limit.unwrap_or(LIST_DEFAULT).clamp(1, LIST_MAX);
    let mut hits: Vec<(u8, Meta)> = Vec::new();
    for m in load_project(&project_id)? {
        // Ranked by where the match landed: a title hit is a different kind of
        // answer than a mention buried in the body.
        let rank = if m.title.to_lowercase().contains(&needle) {
            0
        } else if m.digest.to_lowercase().contains(&needle)
            || m.recommendation.to_lowercase().contains(&needle)
            || m.tags.iter().any(|t| t.contains(&needle))
        {
            1
        } else if m.question.to_lowercase().contains(&needle) {
            2
        } else if read_body(&dir.join(&m.id)).to_lowercase().contains(&needle) {
            3
        } else {
            continue;
        };
        hits.push((rank, m));
    }
    hits.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.updated_at.cmp(&a.1.updated_at)));
    Ok(hits
        .into_iter()
        .take(cap)
        .map(|(_, m)| summarize(&m))
        .collect())
}

/// Tier two: one entry, whole, by explicit id. `sources` is the manifest only.
#[tauri::command]
pub fn research_get(project_id: String, id: String) -> Result<Detail, String> {
    let dir = entry_dir(&project_id, &id)?;
    let meta = read_meta(&dir)?;
    Ok(Detail {
        summary: summarize(&meta),
        question: meta.question.clone(),
        recommendation: meta.recommendation.clone(),
        open_questions: meta.open_questions.clone(),
        body: read_body(&dir),
        sources: meta.sources.clone(),
        links: meta.links.clone(),
        history: meta.history.clone(),
        dir: dir.to_string_lossy().to_string(),
    })
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn research_start(
    app: AppHandle,
    store: State<'_, ResearchStore>,
    project_id: String,
    project_name: Option<String>,
    roots: Option<Vec<String>>,
    title: String,
    question: Option<String>,
    agent: Option<String>,
    cwd: Option<String>,
    pty_id: Option<u64>,
    tags: Option<Vec<String>>,
    instance: Option<String>,
) -> Result<Summary, String> {
    let _guard = store.0.lock().unwrap();
    let pid = project_id.clone();
    emit_changed(
        &app,
        &pid,
        start_impl(
            project_id,
            project_name,
            roots,
            title,
            question,
            agent,
            cwd,
            pty_id,
            tags,
            instance,
        ),
    )
}

#[allow(clippy::too_many_arguments)]
fn start_impl(
    project_id: String,
    project_name: Option<String>,
    roots: Option<Vec<String>>,
    title: String,
    question: Option<String>,
    agent: Option<String>,
    cwd: Option<String>,
    pty_id: Option<u64>,
    tags: Option<Vec<String>>,
    instance: Option<String>,
) -> Result<Summary, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("a research entry needs a title — the question in a few words".into());
    }
    cap(
        "title",
        &title,
        TITLE_MAX,
        "Put the detail in the question.",
    )?;
    let question = question.unwrap_or_default();
    cap(
        "question",
        &question,
        QUESTION_MAX,
        "State what is being investigated; the material goes in the body.",
    )?;

    let pdir = project_dir(&project_id)?;
    std::fs::create_dir_all(&pdir).map_err(|e| e.to_string())?;
    // Written every time rather than once: a project renamed or re-rooted
    // should be recognisable from its research directory, and this is the only
    // record of what the id meant.
    let pref = ProjectRef {
        id: project_id.clone(),
        name: project_name.unwrap_or_default(),
        roots: roots.unwrap_or_default(),
    };
    if let Ok(body) = serde_json::to_string_pretty(&pref) {
        let _ = write_atomic(&pdir.join("project.json"), &body);
    }

    // Next number is max+1 over what is on disk, including archived entries —
    // ids are permanent references (a PR body may cite one), so a number is
    // never reused even after a delete.
    let next = std::fs::read_dir(&pdir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    name.split_once('-')
                        .and_then(|(n, _)| n.parse::<u32>().ok())
                })
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0)
        + 1;
    let id = format!("{next:04}-{}", slugify(&title));
    let dir = pdir.join(&id);
    std::fs::create_dir_all(dir.join("sources")).map_err(|e| e.to_string())?;

    let now = now_secs();
    let meta = Meta {
        id: id.clone(),
        project_id,
        title,
        question,
        status: Status::Researching,
        digest: String::new(),
        recommendation: String::new(),
        open_questions: Vec::new(),
        tags: tags.unwrap_or_default(),
        agent: agent.unwrap_or_default(),
        cwd: cwd.unwrap_or_default(),
        pty_id,
        created_at: now,
        updated_at: now,
        sources: Vec::new(),
        links: Links::default(),
        history: vec![HistoryEntry {
            at: now,
            from: Status::Open.as_str().into(),
            to: Status::Researching.as_str().into(),
            by: String::new(),
            note: "started".into(),
        }],
    };
    write_meta(&dir, &meta)?;
    write_atomic(&body_path(&dir), &format!("# {}\n\n", meta.title))?;
    // From here on this terminal is doing research, whoever launched it. A run
    // Canopy started already had the env; this is what brings the harness to
    // one that opened an entry on its own initiative.
    bind_session(
        instance.as_deref(),
        pty_id.map(|p| p.to_string()).as_deref(),
        &dir,
    );
    Ok(summarize(&meta))
}

/// Edit the parts of an entry that are prose. `append` adds to the body (the
/// common case while research is in flight); `body` replaces it outright.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn research_update(
    app: AppHandle,
    store: State<'_, ResearchStore>,
    project_id: String,
    id: String,
    title: Option<String>,
    digest: Option<String>,
    recommendation: Option<String>,
    open_questions: Option<Vec<String>>,
    tags: Option<Vec<String>>,
    append: Option<String>,
    body: Option<String>,
) -> Result<Summary, String> {
    let _guard = store.0.lock().unwrap();
    let pid = project_id.clone();
    emit_changed(
        &app,
        &pid,
        update_impl(
            project_id,
            id,
            title,
            digest,
            recommendation,
            open_questions,
            tags,
            append,
            body,
        ),
    )
}

#[allow(clippy::too_many_arguments)]
fn update_impl(
    project_id: String,
    id: String,
    title: Option<String>,
    digest: Option<String>,
    recommendation: Option<String>,
    open_questions: Option<Vec<String>>,
    tags: Option<Vec<String>>,
    append: Option<String>,
    body: Option<String>,
) -> Result<Summary, String> {
    let dir = entry_dir(&project_id, &id)?;
    let mut meta = read_meta(&dir)?;

    if let Some(v) = title {
        let v = v.trim().to_string();
        if !v.is_empty() {
            cap("title", &v, TITLE_MAX, "Put the detail in the question.")?;
            meta.title = v;
        }
    }
    if let Some(v) = digest {
        check_digest(&v)?;
        meta.digest = v.trim().to_string();
    }
    if let Some(v) = recommendation {
        cap(
            "recommendation",
            &v,
            RECOMMENDATION_MAX,
            "Say what to do, not why — the reasoning is the body's job.",
        )?;
        meta.recommendation = v.trim().to_string();
    }
    if let Some(v) = open_questions {
        if v.len() > MAX_OPEN_QUESTIONS {
            return Err(format!(
                "{} open questions; the limit is {MAX_OPEN_QUESTIONS}. Keep the ones \
                 that block a decision.",
                v.len()
            ));
        }
        for q in &v {
            cap("an open question", q, DIGEST_MAX, "One line each.")?;
        }
        meta.open_questions = v;
    }
    if let Some(v) = tags {
        meta.tags = v.into_iter().map(|t| t.trim().to_lowercase()).collect();
    }

    if append.is_some() || body.is_some() {
        let next = match (append, body) {
            (Some(add), _) => {
                let cur = read_body(&dir);
                if cur.is_empty() {
                    add
                } else {
                    format!("{}\n\n{}", cur.trim_end(), add.trim())
                }
            }
            (None, Some(replacement)) => replacement,
            _ => unreachable!(),
        };
        if next.len() > BODY_MAX {
            return Err(format!(
                "the body would be {} bytes; the limit is {BODY_MAX}. This is the \
                 signal that the material is a source, not a finding: write the long \
                 text with action \"source\" and keep the body to what you concluded.",
                next.len()
            ));
        }
        write_atomic(&body_path(&dir), &next)?;
    }

    meta.updated_at = now_secs();
    write_meta(&dir, &meta)?;
    Ok(summarize(&meta))
}

/// Add a raw capture. This is the pressure valve that makes the body cap
/// livable — anything long has somewhere to go, and it goes there named.
#[tauri::command]
pub fn research_add_source(
    app: AppHandle,
    store: State<'_, ResearchStore>,
    project_id: String,
    id: String,
    title: String,
    body: String,
    origin: Option<String>,
) -> Result<SourceRef, String> {
    let _guard = store.0.lock().unwrap();
    let pid = project_id.clone();
    emit_changed(
        &app,
        &pid,
        add_source_impl(project_id, id, title, body, origin),
    )
}

fn add_source_impl(
    project_id: String,
    id: String,
    title: String,
    body: String,
    origin: Option<String>,
) -> Result<SourceRef, String> {
    let dir = entry_dir(&project_id, &id)?;
    let mut meta = read_meta(&dir)?;
    if meta.sources.len() >= MAX_SOURCES {
        return Err(format!(
            "this entry already has {MAX_SOURCES} sources — that is enough material \
             for a second research entry rather than more of this one"
        ));
    }
    if body.len() > SOURCE_MAX {
        return Err(format!(
            "that source is {} bytes; the limit is {SOURCE_MAX}. Trim it to the part \
             that matters, or split it across sources.",
            body.len()
        ));
    }
    let title = title.trim().to_string();
    let title = if title.is_empty() {
        "capture".to_string()
    } else {
        title
    };
    let file = format!(
        "sources/{:02}-{}.md",
        meta.sources.len() + 1,
        slugify(&title)
    );
    write_atomic(&dir.join(&file), &body)?;
    let source = SourceRef {
        file,
        title,
        origin: origin.unwrap_or_default(),
        bytes: body.len() as u64,
    };
    meta.sources.push(source.clone());
    meta.updated_at = now_secs();
    write_meta(&dir, &meta)?;
    Ok(source)
}

/// Move the entry along. The transition is checked, so an agent cannot declare
/// something implemented that was never researched.
#[tauri::command]
pub fn research_set_status(
    app: AppHandle,
    store: State<'_, ResearchStore>,
    project_id: String,
    id: String,
    status: String,
    by: Option<String>,
    note: Option<String>,
) -> Result<Summary, String> {
    let _guard = store.0.lock().unwrap();
    let pid = project_id.clone();
    emit_changed(
        &app,
        &pid,
        set_status_impl(project_id, id, status, by, note),
    )
}

fn set_status_impl(
    project_id: String,
    id: String,
    status: String,
    by: Option<String>,
    note: Option<String>,
) -> Result<Summary, String> {
    let to = Status::parse(&status)?;
    let dir = entry_dir(&project_id, &id)?;
    let mut meta = read_meta(&dir)?;
    let from = meta.status;
    if !from.can_move_to(to) {
        return Err(transition_error(from, to));
    }
    if from != to {
        meta.status = to;
        meta.history.push(HistoryEntry {
            at: now_secs(),
            from: from.as_str().into(),
            to: to.as_str().into(),
            by: by.unwrap_or_default(),
            note: note.unwrap_or_default(),
        });
        meta.updated_at = now_secs();
        write_meta(&dir, &meta)?;
    }
    Ok(summarize(&meta))
}

/// Tie the entry to the work. A PR linked here is what later flips the entry to
/// `implemented` when it merges (see the reconciler in the frontend), and what
/// answers "what shipped because of this?" months later.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn research_link(
    app: AppHandle,
    store: State<'_, ResearchStore>,
    project_id: String,
    id: String,
    pr: Option<PrLink>,
    ticket: Option<TicketLink>,
    branch: Option<String>,
    files: Option<Vec<String>>,
    supersedes: Option<String>,
) -> Result<Detail, String> {
    let _guard = store.0.lock().unwrap();
    let pid = project_id.clone();
    emit_changed(
        &app,
        &pid,
        link_impl(project_id, id, pr, ticket, branch, files, supersedes),
    )
}

#[allow(clippy::too_many_arguments)]
fn link_impl(
    project_id: String,
    id: String,
    pr: Option<PrLink>,
    ticket: Option<TicketLink>,
    branch: Option<String>,
    files: Option<Vec<String>>,
    supersedes: Option<String>,
) -> Result<Detail, String> {
    let dir = entry_dir(&project_id, &id)?;
    let mut meta = read_meta(&dir)?;

    if let Some(pr) = pr {
        match meta
            .links
            .prs
            .iter_mut()
            .find(|p| p.repo == pr.repo && p.number == pr.number)
        {
            // Re-linking is how the watcher reports a merge, so an existing
            // link updates rather than duplicating.
            Some(existing) => *existing = pr,
            None => meta.links.prs.push(pr),
        }
    }
    if let Some(t) = ticket {
        if !meta.links.tickets.iter().any(|x| x.id == t.id) {
            meta.links.tickets.push(t);
        }
    }
    if let Some(b) = branch {
        let b = b.trim().to_string();
        if !b.is_empty() && !meta.links.branches.contains(&b) {
            meta.links.branches.push(b);
        }
    }
    if let Some(list) = files {
        for f in list {
            if !f.is_empty() && !meta.links.files.contains(&f) {
                meta.links.files.push(f);
            }
        }
    }
    if let Some(other) = supersedes {
        if !valid_id(&other) {
            return Err(format!("not a research id: {other}"));
        }
        if other == id {
            return Err("an entry cannot supersede itself".into());
        }
        if !meta.links.supersedes.contains(&other) {
            meta.links.supersedes.push(other.clone());
        }
        // Both sides, so the superseded entry can warn its own readers rather
        // than relying on them to search for a successor.
        let other_dir = entry_dir(&project_id, &other)?;
        if let Ok(mut om) = read_meta(&other_dir) {
            om.links.superseded_by = Some(id.clone());
            if om.status.can_move_to(Status::Superseded) {
                om.history.push(HistoryEntry {
                    at: now_secs(),
                    from: om.status.as_str().into(),
                    to: Status::Superseded.as_str().into(),
                    by: String::new(),
                    note: format!("superseded by {id}"),
                });
                om.status = Status::Superseded;
            }
            om.updated_at = now_secs();
            let _ = write_meta(&other_dir, &om);
        }
    }

    meta.updated_at = now_secs();
    write_meta(&dir, &meta)?;
    research_get(project_id, id)
}

/// Read one file inside an entry — a source, an artifact. The store lives
/// outside every registered workspace root, so `fsx::check_scope` cannot reach
/// it and this is the only reader the UI has for these paths.
#[tauri::command]
pub fn research_read_file(project_id: String, id: String, path: String) -> Result<String, String> {
    let file = entry_file(&project_id, &id, &path)?;
    crate::bounded_file::read_string(&file, SOURCE_MAX)
}

// ---- importing a markdown file --------------------------------------------
//
// Research existed before this module did, and it is sitting in the repo as
// loose markdown — a NOTES.md, a docs/spike.md, the file an agent wrote before
// the harness stopped it. Those are findings; they are simply not findable,
// which is the whole complaint the store answers. Importing one is therefore
// not a conversion so much as an adoption: the document keeps its text, gains
// the fields that make it show up in a list, and points back at the file it
// came from.
//
// Deliberately mechanical, with no agent involved. An import is instant and
// free, and the derived digest is honest about being derived — the user can
// put an agent on it afterwards with Continue research, which is the tool that
// already exists for making an entry better.

/// Cut to a length rather than refuse it. `cap` is right for text an agent
/// authored, where the limit is the message; a digest lifted out of someone
/// else's file is derived, and refusing the import over it would help nobody.
fn clip(s: &str, max: usize) -> String {
    let s = s.trim();
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max.saturating_sub(1)).collect();
    // Prefer a word boundary, so the ellipsis lands after a word and not
    // mid-syllable.
    match cut.rfind(char::is_whitespace) {
        Some(i) if i > max / 2 => format!("{}…", cut[..i].trim_end()),
        _ => format!("{}…", cut.trim_end()),
    }
}

/// The document's own title, or its filename made readable. A markdown file
/// that opens with a heading has already named itself, and using anything else
/// would rename someone's document on import.
fn imported_title(body: &str, path: &Path) -> String {
    for line in body.lines().take(40) {
        if let Some(rest) = line.trim().strip_prefix("# ") {
            if !rest.trim().is_empty() {
                return clip(rest, TITLE_MAX);
            }
        }
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Imported note".into());
    clip(&stem.replace(['-', '_'], " "), TITLE_MAX)
}

/// The first real paragraph — what the document leads with, which is the
/// closest thing a hand-written note has to a digest. Headings, list bullets
/// and code fences are skipped: none of them read as a summary on their own.
fn imported_digest(body: &str) -> String {
    let mut para = String::new();
    let mut in_fence = false;
    for line in body.lines() {
        let t = line.trim();
        if t.starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if t.is_empty() {
            if !para.is_empty() {
                break;
            }
            continue;
        }
        if t.starts_with('#') || t.starts_with('>') || t.starts_with("---") {
            continue;
        }
        if para.is_empty() && (t.starts_with("- ") || t.starts_with("* ")) {
            continue;
        }
        if !para.is_empty() {
            para.push(' ');
        }
        para.push_str(t);
    }
    clip(&para, DIGEST_MAX)
}

fn canonical_path(path: &str) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .to_string()
}

fn links_file(meta: &Meta, path: &str) -> bool {
    let canonical = canonical_path(path);
    meta.links
        .files
        .iter()
        .any(|linked| canonical_path(linked) == canonical)
}

/// Is this file already an entry? Import is a button the user can press twice,
/// and the second press should take them to what the first one made rather
/// than making a duplicate of it.
#[tauri::command]
pub fn research_for_file(project_id: String, path: String) -> Result<Option<String>, String> {
    Ok(load_project(&project_id)?
        .into_iter()
        .find(|m| links_file(m, &path))
        .map(|m| m.id))
}

/// Adopt a markdown file as a research entry.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn research_import(
    app: AppHandle,
    store: State<'_, ResearchStore>,
    project_id: String,
    project_name: Option<String>,
    roots: Option<Vec<String>>,
    path: String,
    instance: Option<String>,
) -> Result<Summary, String> {
    let _guard = store.0.lock().unwrap();
    let pid = project_id.clone();
    emit_changed(
        &app,
        &pid,
        import_impl(project_id, project_name, roots, path, instance),
    )
}

fn import_impl(
    project_id: String,
    project_name: Option<String>,
    roots: Option<Vec<String>>,
    path: String,
    instance: Option<String>,
) -> Result<Summary, String> {
    import_impl_inner(project_id, project_name, roots, path, instance, true)
}

fn import_impl_inner(
    project_id: String,
    project_name: Option<String>,
    roots: Option<Vec<String>>,
    path: String,
    instance: Option<String>,
    check_existing: bool,
) -> Result<Summary, String> {
    let path = canonical_path(&path);
    let file = PathBuf::from(&path);
    let roots = roots.unwrap_or_default();
    // Only files belonging to this project. The store is otherwise reachable
    // with any path at all, and "import" is not a licence to read the disk.
    if !roots.iter().any(|root| {
        let root = canonical_path(root);
        file.starts_with(Path::new(&root)) && file != Path::new(&root)
    }) {
        return Err(format!("{path} is not inside this project"));
    }

    // The file path is the identity. A repeated import resolves to the entry
    // already carrying it; the Markdown is not kept in sync because an agent or
    // person may have improved the imported body after adoption.
    if check_existing {
        let existing = load_project(&project_id)?
            .into_iter()
            .find(|meta| links_file(meta, &path));
        if let Some(meta) = existing {
            return Ok(summarize(&meta));
        }
    }

    let text = crate::bounded_file::read_string(&file, SOURCE_MAX)
        .map_err(|error| format!("cannot read {path}: {error}"))?;
    if text.trim().is_empty() {
        return Err(format!("{path} is empty — there is nothing to import yet."));
    }

    let title = imported_title(&text, &file);
    let summary = start_impl(
        project_id.clone(),
        project_name,
        Some(roots),
        title,
        Some(clip(&format!("Imported from {path}"), QUESTION_MAX)),
        None,
        file.parent().map(|p| p.to_string_lossy().to_string()),
        None,
        None,
        instance,
    )?;
    let dir = entry_dir(&project_id, &summary.id)?;
    let mut meta = read_meta(&dir)?;

    write_imported_content(&dir, &mut meta, &file, &path, &text)?;

    meta.digest = imported_digest(&text);
    meta.tags.push("imported".into());
    meta.links.files.push(path.clone());
    // Researched, not researching: someone already did this work, and the entry
    // is a record of it rather than a run waiting to finish. Nothing is going
    // to arrive later to move it.
    meta.history.push(HistoryEntry {
        at: now_secs(),
        from: Status::Researching.as_str().into(),
        to: Status::Researched.as_str().into(),
        by: "you".into(),
        note: format!("imported from {path}"),
    });
    meta.status = Status::Researched;
    meta.updated_at = now_secs();
    write_meta(&dir, &meta)?;
    Ok(summarize(&meta))
}

fn write_imported_content(
    dir: &Path,
    meta: &mut Meta,
    file: &Path,
    path: &str,
    text: &str,
) -> Result<(), String> {
    // The text goes in the body when it fits and in a source when it does not,
    // never both — a duplicated document is two things to keep in step.
    if text.len() <= BODY_MAX {
        return write_atomic(&body_path(dir), text);
    }

    let name = file
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "imported.md".into());
    let rel = format!("sources/imported-{}", slugify(&name));
    write_atomic(&dir.join(&rel), text)?;
    meta.sources.push(SourceRef {
        file: rel,
        title: name,
        origin: format!("imported from {path}"),
        bytes: text.len() as u64,
    });
    write_atomic(
        &body_path(dir),
        &format!(
            "# {}\n\nImported from `{path}`. The document was too long for the \
             write-up, so it is kept whole as a source.\n",
            meta.title
        ),
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepSummary {
    imported: usize,
    matched: usize,
    skipped: usize,
}

fn normalized_name(path: &Path) -> Option<String> {
    Some(
        path.file_stem()?
            .to_string_lossy()
            .to_ascii_lowercase()
            .replace(['.', '_'], "-"),
    )
}

fn is_auto_import_noise_dir(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        // Git hosts, editor/agent instructions, and release machinery.
        ".github"
            | ".gitlab"
            | ".gitea"
            | ".circleci"
            | ".claude"
            | ".agents"
            | ".cursor"
            | ".opencode"
            | ".continue"
            | ".cline"
            | ".clinerules"
            | ".roo"
            | ".devin"
            | ".windsurf"
            | ".vscode"
            | ".idea"
            | ".devcontainer"
            | ".changeset"
            | ".husky"
            | ".canopy"
            | "issue_template"
            | "pull_request_template"
            // Dependencies, generated output, and non-source fixtures.
            | "node_modules"
            | ".pnpm"
            | ".yarn"
            | ".venv"
            | ".tox"
            | ".nox"
            | "site-packages"
            | "target"
            | "dist"
            | "dist-ssr"
            | "build"
            | "out"
            | "coverage"
            | "generated"
            | "fixtures"
            | "fixture"
            | "testdata"
            | "demo"
    )
}

fn is_auto_import_candidate(relative: &Path) -> bool {
    // These trees contain repository plumbing, generated material, or agent
    // configuration rather than findings. Explicit import remains available.
    if relative
        .components()
        .any(|part| is_auto_import_noise_dir(part.as_os_str().to_string_lossy().as_ref()))
    {
        return false;
    }

    let Some(stem) = normalized_name(relative) else {
        return false;
    };
    const EXACT_HOUSEKEEPING: &[&str] = &[
        "authors",
        "bug-report-template",
        "changes",
        "cla",
        "code-of-conduct",
        "copilot-instructions",
        "contributing",
        "contributors",
        "copying",
        "copyright",
        "dco",
        "feature-request-template",
        "governance",
        "history",
        "issue-template",
        "licence",
        "license",
        "maintainers",
        "news",
        "notice",
        "patents",
        "pull-request-template",
        "release-process",
        "releases",
        "releasing",
        "security",
        "skill",
        "support",
        "third-party-notices",
        "trademarks",
    ];
    const PREFIX_HOUSEKEEPING: &[&str] = &[
        // Locale/tool variants are conventional: README.fr, CLAUDE.local,
        // AGENTS.override, LICENSE-MIT, and versioned changelogs/release notes.
        "agents",
        "changelog",
        "claude",
        "gemini",
        "readme",
        "release-notes",
    ];

    let legal_variant = ["copying", "licence", "license"].iter().any(|base| {
        stem.strip_prefix(&format!("{base}-")).is_some_and(|kind| {
            matches!(
                kind,
                "0bsd"
                    | "agpl"
                    | "agpl-3"
                    | "agpl-3-0"
                    | "apache"
                    | "apache-2"
                    | "apache-2-0"
                    | "bsd"
                    | "bsd-2-clause"
                    | "bsd-3-clause"
                    | "cc0"
                    | "gpl"
                    | "gpl-2"
                    | "gpl-2-0"
                    | "gpl-3"
                    | "gpl-3-0"
                    | "isc"
                    | "lgpl"
                    | "lgpl-2-1"
                    | "lgpl-3"
                    | "lgpl-3-0"
                    | "mit"
                    | "mpl"
                    | "mpl-2"
                    | "mpl-2-0"
                    | "ofl"
                    | "unlicense"
            )
        })
    });

    if EXACT_HOUSEKEEPING.contains(&stem.as_str())
        || legal_variant
        || PREFIX_HOUSEKEEPING
            .iter()
            .any(|base| stem == *base || stem.starts_with(&format!("{base}-")))
    {
        return false;
    }

    // Generated conversations and repository forms also occur outside their
    // usual hidden directories.
    !stem.ends_with("-chat-history")
        && !stem.ends_with("-conversation-history")
        && !stem.ends_with("-session-transcript")
        && stem != "chat-history"
        && stem != "conversation-history"
        && stem != "session-transcript"
        && stem != "transcript"
}

fn markdown_files(roots: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    for root in roots {
        let root = canonical_path(root);
        let root_path = PathBuf::from(&root);
        let mut builder = ignore::WalkBuilder::new(&root_path);
        builder
            .hidden(false)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .parents(true)
            .require_git(false)
            .follow_links(false)
            .filter_entry(|entry| {
                let name = entry.file_name().to_string_lossy();
                !entry.file_type().is_some_and(|kind| kind.is_dir())
                    || (name != ".git" && !is_auto_import_noise_dir(name.as_ref()))
            });
        for entry in builder.build().flatten() {
            let path = entry.path();
            if entry.file_type().is_some_and(|kind| kind.is_file())
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
                && path
                    .strip_prefix(&root_path)
                    .is_ok_and(is_auto_import_candidate)
            {
                seen.insert(canonical_path(&path.to_string_lossy()));
            }
        }
    }
    let mut files: Vec<_> = seen.into_iter().collect();
    files.sort();
    files
}

/// Adopt research-like git-visible Markdown under the project's roots. Common
/// repository housekeeping and agent instruction files are left alone. The import
/// itself is path-keyed and idempotent, so opening a project repeatedly or a watcher
/// delivering the same write twice cannot create duplicate entries.
#[tauri::command]
pub fn research_sweep(
    app: AppHandle,
    store: State<'_, ResearchStore>,
    project_id: String,
    project_name: Option<String>,
    roots: Vec<String>,
) -> Result<SweepSummary, String> {
    // Traversal can be the expensive part in a large monorepo. Do it before
    // taking the research write lock so unrelated entries remain responsive.
    let files = markdown_files(&roots);
    let matched = files.len();
    let _guard = store.0.lock().unwrap();
    let mut before: HashSet<String> = load_project(&project_id)?
        .into_iter()
        .flat_map(|meta| meta.links.files)
        .map(|path| canonical_path(&path))
        .collect();
    let mut imported = 0;
    let mut skipped = 0;

    for path in files {
        if before.contains(&path) {
            continue;
        }
        match import_impl_inner(
            project_id.clone(),
            project_name.clone(),
            Some(roots.clone()),
            path.clone(),
            None,
            false,
        ) {
            Ok(_) => {
                imported += 1;
                before.insert(path);
            }
            Err(_) => skipped += 1,
        }
    }

    let summary = SweepSummary {
        imported,
        matched,
        skipped,
    };
    if imported > 0 {
        let _ = app.emit(RESEARCH_CHANGED, &project_id);
    }
    Ok(summary)
}

/// Where an entry lives on disk. The launcher exports this to a research
/// session as `CANOPY_RESEARCH_DIR`, which is what the PreToolUse gate compares
/// against — so the gate is string work on every tool call rather than a bridge
/// round trip.
#[tauri::command]
pub fn research_dir(project_id: String, id: String) -> Result<String, String> {
    entry_dir(&project_id, &id).map(|d| d.to_string_lossy().to_string())
}

// ---- self-binding ---------------------------------------------------------
//
// Research does not only happen in runs Canopy launched. An agent asked "work
// out how our auth works" does research too, and the MCP instructions already
// tell it to record that here — so it opens an entry mid-session, with no
// CANOPY_RESEARCH_DIR on its environment because nothing knew at spawn time
// that this would become research.
//
// Such a session got the tools and none of the harness: it could still scatter
// findings into files the gate never saw. Env cannot be set on a process that
// is already running, so the binding is a file instead — written when an entry
// is started or appended to, and read by the PreToolUse gate, which knows its
// own terminal from CANOPY_PTY. One small local read on write tools only,
// which is affordable where a bridge round trip on every tool call was not.

/// Keyed by instance *and* terminal, not terminal alone. Pty ids restart from
/// zero with the app, so a binding left behind by a crash would otherwise
/// attach to whatever session inherited the number next launch — and refuse
/// its writes for an entry it has never heard of. The instance token is unique
/// per launch, so a stale file simply never matches again.
///
/// The name is built the same way on both sides; canopy_hook reads it straight
/// from its own env rather than calling back, because this sits in front of
/// write tools and a round trip there is what the env fast path exists to
/// avoid.
pub fn binding_file(instance: &str, pty: &str) -> Option<String> {
    let safe = |s: &str| {
        !s.is_empty()
            && s.len() <= 64
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    (safe(instance) && safe(pty)).then(|| format!("{instance}-{pty}.json"))
}

/// Bind a terminal to an entry, so the harness starts applying to a session
/// that talked its way into research rather than being launched into it.
fn bind_session(instance: Option<&str>, pty: Option<&str>, dir: &Path) {
    let (Some(instance), Some(pty)) = (instance, pty) else {
        return;
    };
    let Some(name) = binding_file(instance, pty) else {
        return;
    };
    let Ok(sessions) = root().map(|r| r.join("sessions")) else {
        return;
    };
    if std::fs::create_dir_all(&sessions).is_err() {
        return;
    }
    let body = serde_json::json!({ "dir": dir.to_string_lossy(), "at": now_secs() });
    let _ = write_atomic(&sessions.join(name), &body.to_string());
}

/// Remove an entry and everything under it. Deliberately real: the whole point
/// of a research list is that the user can throw things out of it.
#[tauri::command]
pub fn research_delete(
    app: AppHandle,
    store: State<'_, ResearchStore>,
    project_id: String,
    id: String,
) -> Result<(), String> {
    let _guard = store.0.lock().unwrap();
    let dir = entry_dir(&project_id, &id)?;
    if !dir.join("meta.json").exists() {
        return Err("no research entry there".into());
    }
    emit_changed(
        &app,
        &project_id,
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string()),
    )
}

// ---- the harness's view ---------------------------------------------------

/// One indexable document per entry, for spot.rs. `cwd` is where the research
/// was done, which is what scopes a hit to a project in the existing index —
/// research inherits SpotSearch's project scoping rather than inventing its own.
pub struct IndexDoc {
    pub project_id: String,
    pub id: String,
    pub title: String,
    pub body: String,
    pub cwd: String,
    pub agent: String,
    pub dir: String,
    pub ts: i64,
}

/// Everything indexable, across projects. The index scopes by cwd at query
/// time; nothing here decides who may see what.
pub fn index_docs() -> Vec<IndexDoc> {
    let Ok(dir) = root() else {
        return Vec::new();
    };
    let Ok(projects) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for p in projects
        .filter_map(Result::ok)
        .filter(|p| p.path().is_dir())
    {
        let project_id = p.file_name().to_string_lossy().to_string();
        // The project's own roots are the honest cwd for an entry whose agent
        // never recorded one (created from the panel, say).
        let fallback: String = std::fs::read_to_string(p.path().join("project.json"))
            .ok()
            .and_then(|raw| serde_json::from_str::<ProjectRef>(&raw).ok())
            .and_then(|r| r.roots.first().cloned())
            .unwrap_or_default();
        let Ok(entries) = std::fs::read_dir(p.path()) else {
            continue;
        };
        for e in entries.filter_map(Result::ok).filter(|e| e.path().is_dir()) {
            let id = e.file_name().to_string_lossy().to_string();
            if !valid_id(&id) {
                continue;
            }
            let Ok(meta) = read_meta(&e.path()) else {
                continue;
            };
            // Titles of sources, not their contents: the index points at the
            // entry, and the entry names its captures. Indexing the captures
            // whole would put back exactly the volume this module removes.
            let sources = meta
                .sources
                .iter()
                .map(|s| s.title.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let body = [
                meta.question.as_str(),
                meta.digest.as_str(),
                meta.recommendation.as_str(),
                &read_body(&e.path()),
                &sources,
                &meta.tags.join(" "),
            ]
            .join("\n");
            out.push(IndexDoc {
                project_id: project_id.clone(),
                id: id.clone(),
                title: format!("{} · {}", meta.title, meta.status.as_str()),
                body,
                cwd: if meta.cwd.is_empty() {
                    fallback.clone()
                } else {
                    meta.cwd.clone()
                },
                agent: meta.agent.clone(),
                dir: e.path().to_string_lossy().to_string(),
                ts: meta.updated_at,
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_the_path_gate() {
        assert!(valid_id("0007-index-staleness"));
        assert!(valid_id("0001-a"));
        // Anything that could address something else is simply not an id.
        assert!(!valid_id("../../etc/passwd"));
        assert!(!valid_id("0007-Index"));
        assert!(!valid_id("7-short-number"));
        assert!(!valid_id("0007"));
        assert!(!valid_id("0007-"));
        assert!(!valid_id("0007-a/b"));
    }

    #[test]
    fn project_ids_that_could_climb_out_are_refused() {
        assert!(project_dir("..").is_err());
        assert!(project_dir("a/b").is_err());
        assert!(project_dir(".hidden").is_err());
        assert!(project_dir("").is_err());
        assert!(project_dir("p-123").is_ok());
    }

    #[test]
    fn slugs_are_short_lowercase_and_never_empty() {
        assert_eq!(
            slugify("SpotSearch index staleness"),
            "spotsearch-index-staleness"
        );
        assert_eq!(slugify("  !!!  "), "untitled");
        assert!(slugify(&"x".repeat(200)).len() <= 48);
    }

    #[test]
    fn the_state_machine_refuses_the_shortcut_that_matters() {
        // The whole reason for a machine: nothing may claim it shipped without
        // having been researched and implemented first.
        assert!(!Status::Open.can_move_to(Status::Implemented));
        assert!(!Status::Researching.can_move_to(Status::Implementing));
        assert!(Status::Researched.can_move_to(Status::Implementing));
        assert!(Status::Implementing.can_move_to(Status::Implemented));
        // Re-entering a state is a no-op, not a failure — a retried call after
        // a dropped reply must not look like an error.
        assert!(Status::Researched.can_move_to(Status::Researched));
        // Blocked resumes into either side.
        assert!(Status::Blocked.can_move_to(Status::Researching));
        assert!(Status::Blocked.can_move_to(Status::Implementing));
        // Archiving is always available; nothing comes back out.
        for s in [
            Status::Open,
            Status::Researching,
            Status::Researched,
            Status::Implementing,
            Status::Implemented,
        ] {
            assert!(s.can_move_to(Status::Archived));
        }
        assert_eq!(Status::Archived.next(), &[]);
    }

    #[test]
    fn a_refusal_names_the_route_rather_than_only_the_neighbours() {
        // The refusal every agent hits: researched the thing, built the thing,
        // tried to say so. The answer has to be the rule, not a list.
        let err = transition_error(Status::Researching, Status::Implemented);
        assert!(err.contains("merged"), "{err}");
        assert!(err.contains("action \"link\""), "{err}");
        assert!(
            err.contains("researching → researched → implementing"),
            "{err}"
        );
        // A move that is merely two hops away gets the walk, one call per step.
        let err = transition_error(Status::Open, Status::Implementing);
        assert!(
            err.contains("open → researching → researched → implementing"),
            "{err}"
        );
        assert!(err.contains("one call per step"), "{err}");
        // And where there is no route, saying so beats offering a list of one.
        let err = transition_error(Status::Archived, Status::Researching);
        assert!(err.contains("nothing moves out of archived"), "{err}");
        assert!(!err.contains("→"), "{err}");
        assert_eq!(Status::Archived.route_to(Status::Researching), None);
        assert_eq!(
            Status::Blocked.route_to(Status::Implemented),
            Some(vec![Status::Implementing, Status::Implemented])
        );
    }

    #[test]
    fn status_round_trips_through_its_wire_name() {
        for s in [
            Status::Open,
            Status::Researching,
            Status::Researched,
            Status::Implementing,
            Status::Implemented,
            Status::Blocked,
            Status::Superseded,
            Status::Archived,
        ] {
            assert_eq!(Status::parse(s.as_str()).unwrap(), s);
        }
        assert!(Status::parse("done").is_err());
    }

    #[test]
    fn caps_reject_and_say_where_the_material_goes() {
        let long = "x".repeat(DIGEST_MAX + 1);
        let err = check_digest(&long).unwrap_err();
        assert!(err.contains(&DIGEST_MAX.to_string()));
        // The message has to name the alternative, or the agent just retries at
        // the same length.
        assert!(err.contains("sources"));
        assert!(check_digest(&"x".repeat(DIGEST_MAX)).is_ok());
    }

    #[test]
    fn caps_count_characters_not_bytes() {
        // A digest of emoji is not four times shorter than one of ASCII.
        let s = "é".repeat(DIGEST_MAX);
        assert!(check_digest(&s).is_ok());
        assert!(check_digest(&"é".repeat(DIGEST_MAX + 1)).is_err());
    }

    // ---- lifecycle, against a real directory ------------------------------
    //
    // CANOPY_RESEARCH_HOME points the store somewhere disposable. The env var
    // is process-wide, so these run under one lock and one temp root rather
    // than as separate #[test]s racing each other's HOME.

    use std::sync::Mutex as StdMutex;
    static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    struct TempHome(PathBuf);

    impl TempHome {
        fn new(tag: &str) -> TempHome {
            let dir = std::env::temp_dir()
                .join(format!("canopy-research-test-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::env::set_var("CANOPY_RESEARCH_HOME", &dir);
            TempHome(dir)
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
            std::env::remove_var("CANOPY_RESEARCH_HOME");
        }
    }

    fn start(project: &str, title: &str) -> Summary {
        start_impl(
            project.into(),
            Some("Canopy".into()),
            Some(vec!["/repo".into()]),
            title.into(),
            Some("why?".into()),
            Some("claude".into()),
            Some("/repo".into()),
            Some(12),
            None,
            Some("inst1".into()),
        )
        .unwrap()
    }

    #[test]
    fn an_entry_goes_from_question_to_shipped() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = TempHome::new("lifecycle");

        let s = start("p1", "SpotSearch index staleness");
        assert_eq!(s.id, "0001-spotsearch-index-staleness");
        assert_eq!(s.status, "researching");

        // Numbers keep climbing, so an id is a permanent reference.
        assert_eq!(start("p1", "Second question").id, "0002-second-question");

        update_impl(
            "p1".into(),
            s.id.clone(),
            None,
            Some("The index lags because ingest is manual.".into()),
            Some("Ingest on palette open.".into()),
            None,
            Some(vec!["Spot".into()]),
            Some("## Detail\n\nLong-form findings.".into()),
            None,
        )
        .unwrap();

        // Researching cannot jump the queue to implemented.
        let err = set_status_impl("p1".into(), s.id.clone(), "implemented".into(), None, None)
            .unwrap_err();
        assert!(err.contains("cannot become"), "{err}");
        // And the error says where it *can* go, so the agent can correct itself.
        assert!(err.contains("researched"), "{err}");
        // It also says why this one in particular is refused, and names the route
        // to implementing — the refusal every agent that researched-then-built
        // hits, and the one they used to answer by guessing statuses.
        assert!(err.contains("merged"), "{err}");
        assert!(
            err.contains("researching → researched → implementing"),
            "{err}"
        );

        set_status_impl("p1".into(), s.id.clone(), "researched".into(), None, None).unwrap();
        set_status_impl("p1".into(), s.id.clone(), "implementing".into(), None, None).unwrap();

        let detail = link_impl(
            "p1".into(),
            s.id.clone(),
            Some(PrLink {
                repo: "/repo".into(),
                number: 217,
                url: "https://example/pr/217".into(),
                state: "open".into(),
            }),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(detail.links.prs.len(), 1);
        // The body starts as a title heading, so an append lands under it
        // rather than replacing it.
        assert_eq!(
            detail.body,
            "# SpotSearch index staleness\n\n## Detail\n\nLong-form findings."
        );

        // Re-linking the same PR updates it rather than duplicating — this is
        // the path the merge watcher takes.
        let detail = link_impl(
            "p1".into(),
            s.id.clone(),
            Some(PrLink {
                repo: "/repo".into(),
                number: 217,
                url: "https://example/pr/217".into(),
                state: "merged".into(),
            }),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(detail.links.prs.len(), 1);
        assert_eq!(detail.links.prs[0].state, "merged");

        let done =
            set_status_impl("p1".into(), s.id.clone(), "implemented".into(), None, None).unwrap();
        assert_eq!(done.status, "implemented");
        // Every move is on the record, including the one that started it.
        let detail = research_get("p1".into(), s.id.clone()).unwrap();
        assert_eq!(detail.history.len(), 4);
    }

    #[test]
    fn the_list_is_a_worklist_and_carries_only_tier_one() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = TempHome::new("list");

        let a = start("p1", "Alpha");
        let b = start("p1", "Beta");
        update_impl(
            "p1".into(),
            a.id.clone(),
            None,
            Some("alpha digest".into()),
            None,
            None,
            None,
            Some("a body nobody asked for".into()),
            None,
        )
        .unwrap();
        set_status_impl("p1".into(), b.id.clone(), "archived".into(), None, None).unwrap();

        let rows = research_list("p1".into(), None, None).unwrap();
        // Archived is not current work, so it is not in the default list.
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, a.id);
        assert_eq!(rows[0].digest, "alpha digest");
        // Asking for it explicitly still finds it.
        let archived = research_list("p1".into(), Some(vec!["archived".into()]), None).unwrap();
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].id, b.id);

        // Another project sees none of it — scoping is by directory, and there
        // is no argument that crosses it.
        assert!(research_list("p2".into(), None, None).unwrap().is_empty());
    }

    #[test]
    fn an_over_long_body_is_refused_and_the_source_path_accepts_it() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = TempHome::new("caps");

        let s = start("p1", "Big");
        let huge = "x".repeat(BODY_MAX + 1);
        let err = update_impl(
            "p1".into(),
            s.id.clone(),
            None,
            None,
            None,
            None,
            None,
            None,
            Some(huge.clone()),
        )
        .unwrap_err();
        assert!(err.contains("source"), "{err}");

        // The material has somewhere to go, which is what makes the cap fair.
        let src = add_source_impl(
            "p1".into(),
            s.id.clone(),
            "Raw capture".into(),
            huge,
            Some("file:/repo/src/spot.rs".into()),
        )
        .unwrap();
        assert_eq!(src.file, "sources/01-raw-capture.md");

        // `get` names the source but does not hand over its contents.
        let detail = research_get("p1".into(), s.id.clone()).unwrap();
        assert_eq!(detail.sources.len(), 1);
        assert!(detail.body.len() < BODY_MAX);
        // Reading it is a separate, explicit act.
        let body = research_read_file("p1".into(), s.id.clone(), src.file).unwrap();
        assert_eq!(body.len(), BODY_MAX + 1);
    }

    #[test]
    fn superseding_marks_both_sides() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = TempHome::new("supersede");

        let old = start("p1", "First attempt");
        let new = start("p1", "Better attempt");
        set_status_impl("p1".into(), old.id.clone(), "researched".into(), None, None).unwrap();

        link_impl(
            "p1".into(),
            new.id.clone(),
            None,
            None,
            None,
            None,
            Some(old.id.clone()),
        )
        .unwrap();

        let old_detail = research_get("p1".into(), old.id.clone()).unwrap();
        // The superseded entry warns its own readers rather than relying on
        // them to go looking for a successor.
        assert_eq!(old_detail.summary.status, "superseded");
        assert_eq!(old_detail.summary.superseded_by, Some(new.id.clone()));
        let new_detail = research_get("p1".into(), new.id).unwrap();
        assert_eq!(new_detail.links.supersedes, vec![old.id]);
    }

    #[test]
    fn reads_cannot_escape_the_entry() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = TempHome::new("escape");

        let s = start("p1", "Scoped");
        for bad in ["../../../etc/passwd", "sources/../../../etc/passwd", ""] {
            assert!(
                research_read_file("p1".into(), s.id.clone(), bad.into()).is_err(),
                "{bad} should not be readable"
            );
        }
        // A project that never existed is an error, not an empty read.
        assert!(research_read_file("..".into(), s.id, "research.md".into()).is_err());
    }

    #[test]
    fn the_index_sees_entries_with_the_cwd_that_scopes_them() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = TempHome::new("index");

        let s = start("p1", "Indexed thing");
        update_impl(
            "p1".into(),
            s.id.clone(),
            None,
            Some("findable digest".into()),
            None,
            None,
            None,
            Some("body text".into()),
            None,
        )
        .unwrap();

        let docs = index_docs();
        let doc = docs.iter().find(|d| d.id == s.id).expect("entry indexed");
        assert_eq!(doc.cwd, "/repo", "cwd is what scopes a hit to a project");
        assert!(doc.body.contains("findable digest"));
        assert!(doc.body.contains("body text"));
        assert!(doc.title.contains("researching"));
    }

    #[test]
    fn starting_an_entry_binds_the_terminal_that_started_it() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = TempHome::new("binding");

        let s = start("p1", "Something an agent chose to research");
        // The point: a session that talked its way into research — rather than
        // being launched into it — has no CANOPY_RESEARCH_DIR on its
        // environment, and an environment cannot be changed after the fact. The
        // binding file is what brings the harness to it.
        let name = binding_file("inst1", "12").expect("a valid binding name");
        let path = home.0.join("sessions").join(&name);
        let raw = std::fs::read_to_string(&path).expect("binding written");
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(value["dir"].as_str().unwrap().ends_with(&s.id));
    }

    #[test]
    fn a_binding_is_keyed_by_launch_as_well_as_terminal() {
        // Pty ids restart with the app, so a binding keyed by terminal alone
        // would attach to whatever session inherited the number next launch
        // and refuse its writes for an entry it never heard of.
        assert_ne!(binding_file("instA", "12"), binding_file("instB", "12"));
        assert_eq!(binding_file("instA", "12").unwrap(), "instA-12.json");
        // And nothing that could climb out of the sessions directory.
        assert!(binding_file("../evil", "12").is_none());
        assert!(binding_file("inst", "12/../..").is_none());
        assert!(binding_file("", "12").is_none());
    }

    #[test]
    fn an_imported_file_keeps_its_own_title_and_leads_with_its_own_words() {
        // A markdown file that opens with a heading has already named itself,
        // and using anything else would rename someone's document on import.
        let body = "# Donation tiers\n\nGitHub Sponsors has no transaction API, so\nStripe must stay the ledger.\n\nMore detail here.";
        assert_eq!(
            imported_title(body, Path::new("/repo/notes/spike.md")),
            "Donation tiers"
        );
        // The first real paragraph is the closest thing a hand-written note has
        // to a digest — and it is one paragraph, not the whole file.
        let d = imported_digest(body);
        assert!(d.starts_with("GitHub Sponsors has no transaction API"));
        assert!(!d.contains("More detail here"));
    }

    #[test]
    fn a_file_with_no_heading_is_named_after_itself() {
        assert_eq!(
            imported_title(
                "just some prose",
                Path::new("/repo/api-capability_notes.md")
            ),
            "api capability notes"
        );
    }

    #[test]
    fn the_derived_digest_skips_what_never_reads_as_a_summary() {
        // Headings, quotes, rules, bullets and fenced code are all things a
        // note can open with that say nothing on their own.
        let body =
            "# T\n\n---\n\n> a quote\n\n- a bullet\n\n```\ncode here\n```\n\nThe actual point.";
        assert_eq!(imported_digest(body), "The actual point.");
        // Nothing quotable at all is an empty digest, not a wrong one.
        assert_eq!(imported_digest("# Only a heading\n"), "");
    }

    #[test]
    fn derived_text_is_cut_rather_than_refused() {
        // `cap` is right for text an agent authored, where the limit is the
        // message. A digest lifted out of someone else's file is derived, and
        // refusing the import over its length would help nobody.
        let long = "word ".repeat(400);
        let d = imported_digest(&long);
        assert!(d.chars().count() <= DIGEST_MAX);
        assert!(d.ends_with('…'));
        // Cut at a word boundary, not mid-syllable.
        assert!(!d.contains("wor…"));
    }

    #[test]
    fn importing_adopts_the_file_without_moving_it() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = TempHome::new("import");
        let repo = home.0.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let md = repo.join("NOTES.md");
        std::fs::write(&md, "# Tiered donations\n\nStripe stays the ledger.\n").unwrap();
        let path = md.to_string_lossy().to_string();
        let roots = vec![repo.to_string_lossy().to_string()];

        let s = import_impl(
            "p1".into(),
            Some("Canopy".into()),
            Some(roots.clone()),
            path.clone(),
            None,
        )
        .unwrap();
        assert_eq!(s.title, "Tiered donations");
        assert_eq!(s.digest, "Stripe stays the ledger.");
        // Researched, not researching: someone already did this work, and
        // nothing is going to arrive later to move it along.
        assert_eq!(s.status, "researched");

        let d = research_get("p1".into(), s.id.clone()).unwrap();
        // It points back at the file, and the file is still there.
        assert_eq!(d.links.files, vec![canonical_path(&path)]);
        assert!(md.exists(), "import must not move or delete the original");
        assert!(d.body.contains("Stripe stays the ledger"));

        // Twice is not two entries. The path resolves to the first entry, and a
        // changed source does not overwrite improvements made after import.
        std::fs::write(&md, "# Tiered donations\n\nStripe is still the ledger.\n").unwrap();
        let again = import_impl("p1".into(), None, Some(roots), path.clone(), None).unwrap();
        assert_eq!(again.id, s.id);
        assert_eq!(again.digest, "Stripe stays the ledger.");
        assert_eq!(load_project("p1").unwrap().len(), 1);
        assert_eq!(research_for_file("p1".into(), path).unwrap(), Some(s.id));
    }

    #[test]
    fn import_paths_are_canonical_deduplication_keys() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = TempHome::new("import-canonical");
        let repo = home.0.join("repo");
        std::fs::create_dir_all(repo.join("docs")).unwrap();
        let md = repo.join("docs").join("finding.md");
        std::fs::write(&md, "# Finding\n\nOne answer.\n").unwrap();
        let roots = vec![repo.to_string_lossy().to_string()];

        let direct = md.to_string_lossy().to_string();
        let dotted = repo
            .join("docs")
            .join("..")
            .join("docs")
            .join("finding.md")
            .to_string_lossy()
            .to_string();
        let first =
            import_impl("p1".into(), None, Some(roots.clone()), direct.clone(), None).unwrap();
        let second = import_impl("p1".into(), None, Some(roots), dotted.clone(), None).unwrap();

        assert_eq!(second.id, first.id);
        assert_eq!(load_project("p1").unwrap().len(), 1);
        assert_eq!(
            research_for_file("p1".into(), dotted).unwrap(),
            Some(first.id)
        );
    }

    #[test]
    fn markdown_sweep_honors_ignores_noise_filters_and_overlapping_roots() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = TempHome::new("markdown-sweep");
        let repo = home.0.join("repo");
        std::fs::create_dir_all(repo.join("docs")).unwrap();
        std::fs::create_dir_all(repo.join("node_modules/pkg")).unwrap();
        std::fs::write(repo.join(".gitignore"), "ignored.md\n").unwrap();
        std::fs::write(repo.join("README.md"), "# Read me\n").unwrap();
        std::fs::write(repo.join("README.fr.md"), "# Lisez-moi\n").unwrap();
        std::fs::write(repo.join("CLAUDE.md"), "# Agent instructions\n").unwrap();
        std::fs::write(repo.join("AGENTS.md"), "# Agent instructions\n").unwrap();
        std::fs::write(repo.join("SECURITY.md"), "# Security policy\n").unwrap();
        std::fs::write(repo.join("ignored.md"), "# Ignored\n").unwrap();
        std::fs::write(repo.join("docs/finding.MD"), "# Finding\n").unwrap();
        std::fs::write(repo.join("node_modules/pkg/notes.md"), "# Dependency\n").unwrap();
        std::fs::create_dir_all(repo.join(".github")).unwrap();
        std::fs::write(
            repo.join(".github/PULL_REQUEST_TEMPLATE.md"),
            "# Pull request\n",
        )
        .unwrap();

        let files = markdown_files(&[
            repo.to_string_lossy().to_string(),
            repo.join("docs").to_string_lossy().to_string(),
        ]);
        assert_eq!(files.len(), 1);
        assert!(files.iter().any(|path| path.ends_with("finding.MD")));
    }

    #[test]
    fn automatic_import_covers_housekeeping_without_hiding_findings() {
        let excluded = [
            "README.md",
            "docs/README.fr.md",
            "AGENTS.override.md",
            "CLAUDE.local.md",
            "LICENSE-MIT.md",
            "THIRD_PARTY_NOTICES.md",
            "RELEASING.md",
            "docs/release-notes-v0.2.8.md",
            "CHANGELOG-next.md",
            ".github/ISSUE_TEMPLATE/bug.md",
            ".claude/rules/testing.md",
            ".opencode/agents/reviewer.md",
            ".changeset/quiet-dogs.md",
            "demo/notes.md",
            "fixtures/research.md",
            "docs/session-transcript.md",
            ".aider.chat.history.md",
        ];
        for path in excluded {
            assert!(
                !is_auto_import_candidate(Path::new(path)),
                "{path} is housekeeping"
            );
        }

        let retained = [
            "docs/agent-parity.md",
            "docs/persistent-remote-links.md",
            "docs/security-model-investigation.md",
            "docs/history-of-index-corruption.md",
            "docs/license-analysis.md",
            "docs/collab-editing.md",
            "SPEC.md",
            "notes.md",
        ];
        for path in retained {
            assert!(
                is_auto_import_candidate(Path::new(path)),
                "{path} may contain genuine research"
            );
        }
    }

    #[test]
    fn a_long_import_is_kept_whole_as_a_source_and_not_duplicated() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = TempHome::new("import-big");
        let repo = home.0.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let md = repo.join("big.md");
        let text = format!("# Big\n\nThe point.\n\n{}", "x".repeat(BODY_MAX));
        std::fs::write(&md, &text).unwrap();

        let s = import_impl(
            "p1".into(),
            None,
            Some(vec![repo.to_string_lossy().to_string()]),
            md.to_string_lossy().to_string(),
            None,
        )
        .unwrap();
        let d = research_get("p1".into(), s.id).unwrap();
        assert_eq!(d.sources.len(), 1);
        // Kept whole in the source, and the body says where it went rather
        // than holding a second copy of it.
        assert!(d.body.len() < BODY_MAX);
        assert!(d.body.contains("kept whole as a source"));
        assert!(!d.body.contains(&"x".repeat(1000)));
    }

    #[test]
    fn import_refuses_what_it_should_not_read_or_cannot_use() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = TempHome::new("import-refuse");
        let repo = home.0.join("repo");
        std::fs::create_dir_all(&repo).unwrap();
        let roots = vec![repo.to_string_lossy().to_string()];

        // Outside the project: "import" is not a licence to read the disk.
        assert!(import_impl(
            "p1".into(),
            None,
            Some(roots.clone()),
            "/etc/hosts".into(),
            None
        )
        .is_err());

        // Empty: there is nothing to adopt yet, and an entry with no content
        // is a row that says nothing.
        let empty = repo.join("empty.md");
        std::fs::write(&empty, "   \n\n").unwrap();
        let err = import_impl(
            "p1".into(),
            None,
            Some(roots),
            empty.to_string_lossy().to_string(),
            None,
        )
        .unwrap_err();
        assert!(err.contains("empty"), "{err}");
    }

    #[test]
    fn the_directory_the_harness_gates_on_is_the_entrys_own() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = TempHome::new("harness");

        let s = start("p1", "Real one");
        let dir = research_dir("p1".into(), s.id.clone()).unwrap();
        assert!(dir.ends_with(&format!("p1/{}", s.id)));
        // The same value `get` reports, because the launcher exports one and
        // the detail view shows the other and they must not drift.
        assert_eq!(research_get("p1".into(), s.id).unwrap().dir, dir);
        // An id that isn't one never becomes a path.
        assert!(research_dir("p1".into(), "garbage".into()).is_err());
    }
}

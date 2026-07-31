// The scratchpad: thoughts captured before they are work.
//
// The gap this fills is narrow and specific. Canopy could already *dispatch* an
// idea — ⌘K composes a sentence and runs it as a one-shot agent task, or sends
// it off as research — but it could not *park* one. A thought you are not ready
// to act on had nowhere to go, so it went into a comment, a terminal scrollback,
// or nowhere at all. This is the parking state, and everything else here exists
// to make a parked thought worth coming back to.
//
// It borrows research.rs's shape deliberately — same directory discipline, same
// atomic writes, same id-as-path-gate, same state machine checked in Rust — and
// differs from it in three ways that matter:
//
//   1. The store is the spine, not the output. A research entry is a finding an
//      agent produced. A note is the user's own sentence, and the research
//      runs, tasks and PRs that come out of it hang off it as evidence
//      (`links`). One thought lives in one place; you always know where to look.
//
//   2. Attachments are first-class, because the capture is the point. An image
//      pasted into ⌘K, a selection lifted out of an editor, a file at the commit
//      you were looking at — a note that loses those is a note that reads as
//      "fix the thing" three weeks later.
//
//   3. Archiving is reversible. Research treats archived as terminal, which is
//      right for a finding somebody deliberately put down. A scratchpad whose
//      archive is a one-way door is a scratchpad people stop archiving into,
//      and then the list rots instead.
//
// Everything on disk is plain JSON, markdown and the attachment bytes as they
// arrived: readable without Canopy, greppable, recoverable by hand. `meta.json`
// is the source of truth; the SpotSearch index over it (spot.rs, kind = "note")
// is derived and rebuildable, and nothing here reads from it.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

/// Serializes every write, for the same reason research.rs does: a note can be
/// open in the panel, in a detail tab, and in an agent's hands at once, and a
/// read-modify-write of meta.json is exactly the shape that loses one of them.
#[derive(Default)]
pub struct NotesStore(Mutex<()>);

// ---- caps -----------------------------------------------------------------
//
// Looser than research's, and for the opposite reason. Research caps exist to
// protect the *next agent's* context window — a digest is a tier because
// something will read twenty of them at once. A note is read by one human, one
// at a time, so these caps are only here to keep a scratchpad from becoming a
// document store by accident.

const TITLE_MAX: usize = 200;
/// `note.md`. Past this you are writing a document, and a document with a
/// lifecycle is what research.rs is for.
const BODY_MAX: usize = 32 * 1024;
/// One pasted image. Generous — a retina screenshot of a wide editor is a few
/// megabytes and refusing it would break the single most valuable capture path.
const IMAGE_MAX: usize = 16 * 1024 * 1024;
/// One text artifact: a stack trace, a log slice, a chunk of a file.
const ARTIFACT_MAX: usize = 512 * 1024;
/// Attachments per note. A note needing more than this is a research entry.
const MAX_ATTACHMENTS: usize = 32;
/// What a list row carries of the body.
const PREVIEW_MAX: usize = 240;
/// The panel shows the user's whole scratchpad, so this is far higher than
/// research's — that list is read by agents, this one by a person scrolling.
const LIST_DEFAULT: usize = 200;
const LIST_MAX: usize = 1000;

// ---- status ---------------------------------------------------------------

/// Where a thought is between having it and being done with it.
///
/// The two that earn their place are `Ideation` and `Ready`. Without the split
/// there is one bucket holding both the two hundred raw thoughts and the five
/// you actually decided were worth doing — which is the pile this module exists
/// to replace, reproduced inside it.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Captured, raw, untriaged. The default, and where most notes live.
    #[default]
    Ideation,
    /// Triaged: you decided this is worth doing. Nobody has started.
    Ready,
    /// An agent or the user is on it now.
    Doing,
    /// It landed. When an agent did it, `links.prs` says which PR — which is
    /// why there is no separate "implemented": the evidence distinguishes them
    /// better than a second terminal state would.
    Done,
    /// Deliberately not now, but still real. Distinct from archived: parked
    /// says "come back to this", archived says "stop showing me this".
    Parked,
    /// Filed away, out of the default list. Reversible — see `next`.
    Archived,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Ideation => "ideation",
            Status::Ready => "ready",
            Status::Doing => "doing",
            Status::Done => "done",
            Status::Parked => "parked",
            Status::Archived => "archived",
        }
    }

    fn parse(s: &str) -> Result<Status, String> {
        Ok(match s {
            "ideation" => Status::Ideation,
            "ready" => Status::Ready,
            "doing" => Status::Doing,
            "done" => Status::Done,
            "parked" => Status::Parked,
            "archived" => Status::Archived,
            other => {
                return Err(format!(
                    "unknown status \"{other}\" — one of: ideation, ready, doing, \
                     done, parked, archived"
                ))
            }
        })
    }

    /// Where this state may go next.
    ///
    /// Three rules shape this list, and each is a departure from research.rs
    /// made on purpose:
    ///
    /// - **Ideation may skip straight to Doing.** The triage state is there to
    ///   make a pile legible, not to be a tollgate: a thought you have and
    ///   immediately hand to an agent should not need two clicks to get there.
    /// - **Everything may be reopened.** `Done` goes back to `Doing`, because
    ///   "done" here is one person's judgement and it is routinely wrong.
    /// - **Archived is a door, not a wall.** It returns to `Ideation` — the
    ///   state it can honestly claim, since anything else would be asserting a
    ///   triage decision nobody made. An archive you cannot pull out of is one
    ///   people stop putting things into.
    fn next(self) -> &'static [Status] {
        use Status::*;
        match self {
            Ideation => &[Ready, Doing, Parked, Archived],
            Ready => &[Doing, Ideation, Parked, Archived],
            Doing => &[Done, Ready, Parked, Archived],
            Done => &[Doing, Archived],
            Parked => &[Ideation, Ready, Doing, Archived],
            Archived => &[Ideation],
        }
    }

    /// Re-entering a state is always allowed, so a repeated call is a no-op
    /// rather than an error — an agent retrying after a dropped reply should
    /// not get a failure for the state it already reached.
    fn can_move_to(self, to: Status) -> bool {
        self == to || self.next().contains(&to)
    }
}

// ---- the record -----------------------------------------------------------

/// A pull request that came out of this note. Its `state` is refreshed by the
/// frontend reconciler, and a linked PR reaching "merged" is the one thing that
/// moves a note to `Done` without a human asserting it.
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct PrLink {
    pub repo: String,
    pub number: u64,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub state: String,
}

/// A file the note is about.
///
/// Both halves are deliberate. `rev` is the commit the note was written
/// against, so the UI can say "captured 12 commits ago, this file has moved"
/// instead of quietly showing you something else. `snapshot` freezes only the
/// lines that were selected — a whole-file copy goes stale, takes space, and
/// misleads, while the selected lines are exactly the thing the thought was
/// about and are worth keeping verbatim.
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct FileRef {
    pub path: String,
    #[serde(default)]
    pub start_line: Option<u32>,
    #[serde(default)]
    pub end_line: Option<u32>,
    /// Short commit hash at capture time; empty when the file was not in a repo
    /// or git could not be read.
    #[serde(default)]
    pub rev: String,
    /// Relative path under `attachments/` holding the frozen lines, when any
    /// were taken.
    #[serde(default)]
    pub snapshot: Option<String>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct Links {
    #[serde(default)]
    pub prs: Vec<PrLink>,
    /// Research entries started from this note — ids in the research store of
    /// the same project.
    #[serde(default)]
    pub research: Vec<String>,
    /// `TaskRun` ids from the frontend's task history.
    #[serde(default)]
    pub task_runs: Vec<String>,
    #[serde(default)]
    pub branches: Vec<String>,
    #[serde(default)]
    pub files: Vec<FileRef>,
}

/// A blob kept with the note: a pasted image, or a lifted chunk of text.
#[derive(Clone, Serialize, Deserialize)]
pub struct Attachment {
    /// Relative to the note directory, always under `attachments/`.
    pub file: String,
    /// "image" | "artifact". Free-form on disk so an unknown kind written by a
    /// future version still opens rather than failing the whole note.
    pub kind: String,
    pub title: String,
    /// Where it came from — a path, a URL, "pasted". Free text, because the
    /// useful answer varies and a taxonomy here would be guessed.
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
    /// Who moved it — "you" from the panel, "Canopy" for a move the app made on
    /// its own (a merged PR), an agent's name otherwise.
    #[serde(default)]
    pub by: String,
    #[serde(default)]
    pub note: String,
}

/// `meta.json`. Every field defaulted: a note hand-edited to something slightly
/// wrong should still open, because the alternative is losing a thought to a
/// typo — which is the failure this whole module exists to prevent.
#[derive(Clone, Serialize, Deserialize)]
pub struct Meta {
    pub id: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: Status,
    #[serde(default)]
    pub tags: Vec<String>,
    /// What the user was looking at when they captured it — the active tab,
    /// caret, selection, terminal tail, as `capturePageContext` composed it.
    /// Kept verbatim and never re-derived: it describes a moment that has
    /// passed.
    #[serde(default)]
    pub context: String,
    /// Which surface captured it: "spot", "menu", "panel". Not shown anywhere
    /// yet; recorded because "where do my notes actually come from" is the
    /// question that decides which capture path is worth improving.
    #[serde(default)]
    pub origin: String,
    /// Where the note was taken, for the SpotSearch index's project scoping.
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    #[serde(default)]
    pub links: Links,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
}

/// A list row. Carries a preview rather than the body — the panel renders
/// hundreds of these and the body can be 32KB.
#[derive(Serialize, Debug)]
pub struct Summary {
    pub id: String,
    pub title: String,
    pub status: &'static str,
    pub preview: String,
    pub tags: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub attachment_count: usize,
    pub image_count: usize,
    pub file_count: usize,
    pub pr_count: usize,
    pub research_count: usize,
}

#[derive(Serialize)]
pub struct Detail {
    #[serde(flatten)]
    pub summary: Summary,
    pub body: String,
    pub context: String,
    pub origin: String,
    pub attachments: Vec<Attachment>,
    pub links: Links,
    pub history: Vec<HistoryEntry>,
    /// Absolute path to the note directory.
    pub dir: String,
}

/// Written beside the notes so a project removed from the workspace (which
/// changes its id) leaves something recoverable rather than an orphaned hash.
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct ProjectRef {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub roots: Vec<String>,
    /// The highest note number ever issued for this project.
    ///
    /// Kept here rather than derived from the directory listing because a
    /// delete removes the directory: derived alone, throwing away note 7 hands
    /// the number 7 to the next note written, and every reference to the old
    /// one — a PR body, another note's `links`, a message to a teammate — now
    /// silently points at something else. Ids are permanent references, so the
    /// counter has to outlive the thing it named.
    #[serde(default)]
    pub last_seq: u32,
}

// ---- paths ----------------------------------------------------------------
//
// Outside every repo, exactly as research.rs is and for the same reasons:
// several agents share one checkout here and switch its branches under each
// other, worktrees are created and removed hourly, and `.canopy/` inside a tree
// is a directory that merge-conflicts or vanishes. A scratchpad that disappears
// with a worktree is worse than no scratchpad, because you trusted it.

fn root() -> Result<PathBuf, String> {
    let home = std::env::var("CANOPY_NOTES_HOME")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "no home dir".to_string())?;
    let dir = PathBuf::from(home);
    // CANOPY_NOTES_HOME points straight at the store (tests); HOME needs the
    // usual ~/.canopy/notes.
    let dir = if std::env::var("CANOPY_NOTES_HOME").is_ok() {
        dir
    } else {
        dir.join(".canopy").join("notes")
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Project ids come from the frontend workspace file, so they are trusted-ish —
/// but "ish" is not a security model when the value becomes a path segment.
fn project_dir(project_id: &str) -> Result<PathBuf, String> {
    let id = project_id.trim();
    if id.is_empty() {
        return Err("no project — notes are scoped to the project they were \
                    written in, and this directory is not inside an open one"
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

/// Ids are minted here (`nnnn-slug`) and never accepted in any other shape,
/// which is the whole path gate: a value matching this pattern cannot contain a
/// separator, a dot segment, or anything else that escapes.
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

fn note_dir(project_id: &str, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!(
            "not a note id: \"{id}\" — ids look like 0007-tiered-donations \
             (call list to see them)"
        ));
    }
    Ok(project_dir(project_id)?.join(id))
}

/// A path inside a note, for attachment reads. Resolved and then checked to be
/// under the note, so a symlink or a `..` that survived the textual check still
/// cannot address anything outside it.
fn note_file(project_id: &str, id: &str, rel: &str) -> Result<PathBuf, String> {
    let dir = note_dir(project_id, id)?;
    let rel = rel.trim_start_matches('/');
    if rel.is_empty() || rel.contains("..") {
        return Err(format!("bad path inside the note: {rel}"));
    }
    let target = dir.join(rel);
    let base = dir.canonicalize().unwrap_or(dir.clone());
    let resolved = target.canonicalize().unwrap_or(target.clone());
    if !resolved.starts_with(&base) {
        return Err(format!("{rel} is outside the note"));
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
fn write_atomic(path: &Path, body: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn cap(field: &str, value: &str, max: usize, fix: &str) -> Result<(), String> {
    let n = value.chars().count();
    if n > max {
        return Err(format!(
            "{field} is {n} characters; the limit is {max}. {fix}"
        ));
    }
    Ok(())
}

// ---- read -----------------------------------------------------------------

fn read_meta(dir: &Path) -> Result<Meta, String> {
    let raw = std::fs::read_to_string(dir.join("meta.json"))
        .map_err(|e| format!("no note there: {e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("meta.json is unreadable: {e}"))
}

fn write_meta(dir: &Path, meta: &Meta) -> Result<(), String> {
    let body = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("meta.json"), body.as_bytes())
}

fn body_path(dir: &Path) -> PathBuf {
    dir.join("note.md")
}

fn read_body(dir: &Path) -> String {
    std::fs::read_to_string(body_path(dir)).unwrap_or_default()
}

/// The first stretch of the body, on one line, for a list row.
///
/// A note's body routinely opens with a markdown heading repeating the title,
/// or with the pasted thing the thought was about. Neither says anything in a
/// row next to the title, so headings and blank lines are skipped and the
/// preview starts at the first line that carries prose.
fn preview_of(body: &str) -> String {
    let text = body
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect::<Vec<_>>()
        .join(" ");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= PREVIEW_MAX {
        return text;
    }
    let cut: String = text.chars().take(PREVIEW_MAX).collect();
    match cut.rfind(' ') {
        Some(at) if at > PREVIEW_MAX / 2 => format!("{}…", &cut[..at]),
        _ => format!("{cut}…"),
    }
}

fn summarize(m: &Meta, body: &str) -> Summary {
    Summary {
        id: m.id.clone(),
        title: m.title.clone(),
        status: m.status.as_str(),
        preview: preview_of(body),
        tags: m.tags.clone(),
        created_at: m.created_at,
        updated_at: m.updated_at,
        attachment_count: m.attachments.len(),
        image_count: m.attachments.iter().filter(|a| a.kind == "image").count(),
        file_count: m.links.files.len(),
        pr_count: m.links.prs.len(),
        research_count: m.links.research.len(),
    }
}

/// Every note of one project, newest first. Unreadable notes are skipped rather
/// than failing the list — one hand-mangled meta.json must not hide the rest.
fn load_project(project_id: &str) -> Result<Vec<(Meta, PathBuf)>, String> {
    let dir = project_dir(project_id)?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<(Meta, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if !valid_id(&name) {
                return None;
            }
            read_meta(&e.path()).ok().map(|m| (m, e.path()))
        })
        .collect();
    out.sort_by(|a, b| b.0.updated_at.cmp(&a.0.updated_at));
    Ok(out)
}

// ---- commands -------------------------------------------------------------
//
// Each write command is a thin wrapper that takes the serialising lock and
// delegates to an `*_impl` below. The split is what lets the tests at the
// bottom drive a whole lifecycle against a real directory, which is the only
// way the state machine is actually checked rather than merely described.

/// The panel's list. Without `status` the archived are hidden — a scratchpad is
/// a worklist, and the archive is what you put things in to get them out of it.
#[tauri::command]
pub fn notes_list(
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
        .filter(|(m, _)| match &want {
            Some(w) => w.contains(&m.status),
            None => m.status != Status::Archived,
        })
        .take(cap)
        .map(|(m, dir)| {
            let body = read_body(&dir);
            summarize(&m, &body)
        })
        .collect())
}

/// Find notes matching `query`.
///
/// Exists mainly for the agents. "Has this already been noticed?" is the
/// question worth asking before adding the two hundred and first thought to a
/// scratchpad, and without it an agent's only option is to list everything and
/// read it — which is how a context window gets spent on a duplicate.
///
/// Ranked by where the match landed: a title hit is a different kind of answer
/// than a word buried in the body.
#[tauri::command]
pub fn notes_search(
    project_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<Summary>, String> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let cap = limit.unwrap_or(LIST_DEFAULT).clamp(1, LIST_MAX);
    let mut hits: Vec<(u8, Summary)> = Vec::new();
    for (m, dir) in load_project(&project_id)? {
        let body = read_body(&dir);
        let rank = if m.title.to_lowercase().contains(&needle) {
            0
        } else if m.tags.iter().any(|t| t.to_lowercase().contains(&needle)) {
            1
        } else if body.to_lowercase().contains(&needle) {
            2
        } else if m.context.to_lowercase().contains(&needle)
            || m.links
                .files
                .iter()
                .any(|f| f.path.to_lowercase().contains(&needle))
        {
            3
        } else {
            continue;
        };
        hits.push((rank, summarize(&m, &body)));
    }
    // Stable within a rank, so the newest-first order load_project established
    // survives — two title hits should come back most-recent first.
    hits.sort_by_key(|(rank, _)| *rank);
    Ok(hits.into_iter().take(cap).map(|(_, s)| s).collect())
}

#[tauri::command]
pub fn notes_get(project_id: String, id: String) -> Result<Detail, String> {
    let dir = note_dir(&project_id, &id)?;
    let meta = read_meta(&dir)?;
    let body = read_body(&dir);
    Ok(Detail {
        summary: summarize(&meta, &body),
        body,
        context: meta.context.clone(),
        origin: meta.origin.clone(),
        attachments: meta.attachments.clone(),
        links: meta.links.clone(),
        history: meta.history.clone(),
        dir: dir.to_string_lossy().to_string(),
    })
}

/// Capture a thought.
///
/// `title` is the only required field, and it is allowed to be the whole
/// thought — the capture path that matters most is one line typed into ⌘K and
/// nothing else, so a note with a title and an empty body is the normal case,
/// not a degenerate one.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn notes_create(
    store: State<'_, NotesStore>,
    project_id: String,
    project_name: Option<String>,
    roots: Option<Vec<String>>,
    title: String,
    body: Option<String>,
    tags: Option<Vec<String>>,
    context: Option<String>,
    origin: Option<String>,
    cwd: Option<String>,
) -> Result<Summary, String> {
    let _guard = store.0.lock().unwrap();
    create_impl(
        project_id,
        project_name,
        roots,
        title,
        body,
        tags,
        context,
        origin,
        cwd,
    )
}

#[allow(clippy::too_many_arguments)]
fn create_impl(
    project_id: String,
    project_name: Option<String>,
    roots: Option<Vec<String>>,
    title: String,
    body: Option<String>,
    tags: Option<Vec<String>>,
    context: Option<String>,
    origin: Option<String>,
    cwd: Option<String>,
) -> Result<Summary, String> {
    // A long first line is a thought, not a mistake: someone typed a paragraph
    // into the omnibox and hit save. Rather than refusing it — which loses the
    // thought, the one outcome this module may never produce — the title takes
    // the head of it and the whole thing goes in the body.
    let raw = title.trim().to_string();
    if raw.is_empty() {
        return Err("a note needs something in it".into());
    }
    let mut body = body.unwrap_or_default();
    let title = if raw.chars().count() > TITLE_MAX {
        if body.trim().is_empty() {
            body = raw.clone();
        }
        clip_words(&raw, TITLE_MAX)
    } else {
        raw
    };
    if body.len() > BODY_MAX {
        return Err(format!(
            "that note is {} bytes; the limit is {BODY_MAX}. Anything this long is \
             a document rather than a note — attach it instead, or make it a \
             research entry.",
            body.len()
        ));
    }

    let pdir = project_dir(&project_id)?;
    std::fs::create_dir_all(&pdir).map_err(|e| e.to_string())?;
    let pfile = pdir.join("project.json");
    let previous: ProjectRef = std::fs::read_to_string(&pfile)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();

    // The highest number ever issued, taken as the greater of what the counter
    // remembers and what is actually on disk. Both halves are load-bearing: the
    // counter survives a delete, and the directory listing survives a
    // project.json that was lost, hand-edited, or never written by an older
    // build. Archived notes are included — they are hidden, not gone.
    let on_disk = std::fs::read_dir(&pdir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter_map(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    valid_id(&name)
                        .then(|| {
                            name.split_once('-')
                                .and_then(|(n, _)| n.parse::<u32>().ok())
                        })
                        .flatten()
                })
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0);
    let next = on_disk.max(previous.last_seq) + 1;

    // Written every time rather than once: a project renamed or re-rooted
    // should be recognisable from its notes directory, this is the only record
    // of what the id meant, and it carries the counter above.
    let pref = ProjectRef {
        id: project_id.clone(),
        name: project_name.unwrap_or_default(),
        roots: roots.clone().unwrap_or_default(),
        last_seq: next,
    };
    if let Ok(json) = serde_json::to_string_pretty(&pref) {
        let _ = write_atomic(&pfile, json.as_bytes());
    }

    let id = format!("{next:04}-{}", slugify(&title));
    let dir = pdir.join(&id);
    std::fs::create_dir_all(dir.join("attachments")).map_err(|e| e.to_string())?;

    let now = now_secs();
    let meta = Meta {
        id: id.clone(),
        project_id,
        title,
        status: Status::Ideation,
        tags: tags.unwrap_or_default(),
        context: context.unwrap_or_default(),
        origin: origin.unwrap_or_default(),
        cwd: cwd
            .or_else(|| roots.and_then(|r| r.first().cloned()))
            .unwrap_or_default(),
        created_at: now,
        updated_at: now,
        attachments: Vec::new(),
        links: Links::default(),
        history: Vec::new(),
    };
    write_meta(&dir, &meta)?;
    write_atomic(&body_path(&dir), body.as_bytes())?;
    Ok(summarize(&meta, &body))
}

/// Cut to a word boundary, so a title taken from a paragraph reads as a phrase
/// rather than as a sentence that ran out of room.
fn clip_words(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let cut: String = s.chars().take(max).collect();
    match cut.rfind(' ') {
        Some(at) if at > max / 2 => format!("{}…", &cut[..at]),
        _ => format!("{cut}…"),
    }
}

/// Edit the note. `append` adds to the body (what an agent picking the note up
/// does); `body` replaces it outright (what the detail tab's editor does).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn notes_update(
    store: State<'_, NotesStore>,
    project_id: String,
    id: String,
    title: Option<String>,
    body: Option<String>,
    append: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Summary, String> {
    let _guard = store.0.lock().unwrap();
    update_impl(project_id, id, title, body, append, tags)
}

fn update_impl(
    project_id: String,
    id: String,
    title: Option<String>,
    body: Option<String>,
    append: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Summary, String> {
    let dir = note_dir(&project_id, &id)?;
    let mut meta = read_meta(&dir)?;

    if let Some(t) = title {
        let t = t.trim().to_string();
        // Empty is refused rather than stored: a row with no name is worse than
        // a clumsy one, and the panel has nothing else to render.
        if !t.is_empty() {
            cap("title", &t, TITLE_MAX, "Put the detail in the note itself.")?;
            meta.title = t;
        }
    }
    if let Some(list) = tags {
        meta.tags = list.into_iter().filter(|t| !t.trim().is_empty()).collect();
    }

    let mut current = read_body(&dir);
    let mut touched = false;
    if let Some(next) = body {
        current = next;
        touched = true;
    }
    if let Some(extra) = append {
        if !extra.trim().is_empty() {
            if !current.is_empty() && !current.ends_with('\n') {
                current.push('\n');
            }
            current.push_str(&extra);
            if !current.ends_with('\n') {
                current.push('\n');
            }
            touched = true;
        }
    }
    if touched {
        if current.len() > BODY_MAX {
            return Err(format!(
                "that note would be {} bytes; the limit is {BODY_MAX}. Attach the \
                 long material instead of pasting it into the note.",
                current.len()
            ));
        }
        write_atomic(&body_path(&dir), current.as_bytes())?;
    }

    meta.updated_at = now_secs();
    write_meta(&dir, &meta)?;
    Ok(summarize(&meta, &current))
}

/// Keep a blob with the note: a pasted image, or a lifted chunk of text.
///
/// `data` is base64 for `kind = "image"` and plain text for everything else.
/// Two encodings rather than one because the image path is the hot one — a
/// screenshot is already base64 by the time the webview has it, and forcing the
/// text path through base64 too would mean every stack trace round-trips
/// through an encoder for no reason.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn notes_add_attachment(
    store: State<'_, NotesStore>,
    project_id: String,
    id: String,
    kind: String,
    title: String,
    data: String,
    origin: Option<String>,
    ext: Option<String>,
) -> Result<Attachment, String> {
    let _guard = store.0.lock().unwrap();
    add_attachment_impl(project_id, id, kind, title, data, origin, ext)
}

#[allow(clippy::too_many_arguments)]
fn add_attachment_impl(
    project_id: String,
    id: String,
    kind: String,
    title: String,
    data: String,
    origin: Option<String>,
    ext: Option<String>,
) -> Result<Attachment, String> {
    use base64::Engine;

    let dir = note_dir(&project_id, &id)?;
    let mut meta = read_meta(&dir)?;
    if meta.attachments.len() >= MAX_ATTACHMENTS {
        return Err(format!(
            "this note already has {MAX_ATTACHMENTS} attachments — that is enough \
             material for a research entry rather than more of one note"
        ));
    }

    let is_image = kind == "image";
    let bytes: Vec<u8> = if is_image {
        base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .map_err(|e| format!("that image did not decode: {e}"))?
    } else {
        data.into_bytes()
    };
    let limit = if is_image { IMAGE_MAX } else { ARTIFACT_MAX };
    if bytes.len() > limit {
        return Err(format!(
            "that attachment is {} bytes; the limit is {limit}",
            bytes.len()
        ));
    }

    let title = {
        let t = title.trim();
        if t.is_empty() {
            if is_image {
                "image".to_string()
            } else {
                "capture".to_string()
            }
        } else {
            t.to_string()
        }
    };
    // The extension is the caller's, sanitised — it decides how the detail tab
    // renders the thing, and an attacker-controlled one would only ever be
    // writing inside the note's own directory anyway.
    let ext = ext
        .map(|e| {
            e.trim_start_matches('.')
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .take(8)
                .collect::<String>()
        })
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| if is_image { "png".into() } else { "txt".into() });
    let file = format!(
        "attachments/{:02}-{}.{ext}",
        meta.attachments.len() + 1,
        slugify(&title)
    );
    write_atomic(&dir.join(&file), &bytes)?;

    let attachment = Attachment {
        file,
        kind,
        title,
        origin: origin.unwrap_or_default(),
        bytes: bytes.len() as u64,
    };
    meta.attachments.push(attachment.clone());
    meta.updated_at = now_secs();
    write_meta(&dir, &meta)?;
    Ok(attachment)
}

/// Copy a file that is already on disk into the note.
///
/// Two paths need this and they look unrelated until you notice both start
/// with bytes somewhere else. An image pasted into ⌘K is written under
/// `.canopy/spot/` before there is a note to put it in — the palette
/// deliberately does not hold the base64 in React state, because a 4K
/// screenshot re-encoded on every keystroke is megabytes of churn. And
/// attaching a file the user is looking at is the same operation with a
/// different source.
///
/// Copied rather than moved, and copied *into the note*, because the source is
/// inside the repo: `.canopy/spot/` dies with a worktree removal, and a
/// scratchpad whose attachments vanish when a branch is cleaned up is a
/// scratchpad you stop trusting. The note's own directory is outside every
/// repo precisely so this cannot happen.
#[tauri::command]
pub fn notes_attach_file(
    store: State<'_, NotesStore>,
    ws: State<'_, crate::fsx::WorkspaceManager>,
    project_id: String,
    id: String,
    path: String,
    title: Option<String>,
    kind: Option<String>,
) -> Result<Attachment, String> {
    let _guard = store.0.lock().unwrap();
    let src = PathBuf::from(&path);
    // The source is arbitrary user-supplied text, so it is held to the same
    // scope rule every other read in the app is: inside a registered workspace
    // root, or refused.
    crate::fsx::check_scope(&ws, &src)?;

    let dir = note_dir(&project_id, &id)?;
    let mut meta = read_meta(&dir)?;
    if meta.attachments.len() >= MAX_ATTACHMENTS {
        return Err(format!(
            "this note already has {MAX_ATTACHMENTS} attachments — that is enough \
             material for a research entry rather than more of one note"
        ));
    }

    let ext = src
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    // The kind decides how the detail tab renders it, and the extension is the
    // only honest signal available for a file nobody labelled.
    let kind = kind.unwrap_or_else(|| {
        if matches!(
            ext.as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
        ) {
            "image".into()
        } else {
            "artifact".into()
        }
    });
    let is_image = kind == "image";
    let limit = if is_image { IMAGE_MAX } else { ARTIFACT_MAX };
    let bytes = std::fs::read(&src).map_err(|e| format!("could not read {path}: {e}"))?;
    if bytes.len() > limit {
        return Err(format!(
            "{path} is {} bytes; the limit is {limit}",
            bytes.len()
        ));
    }

    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .or_else(|| {
            src.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_else(|| {
            if is_image {
                "image".into()
            } else {
                "capture".into()
            }
        });
    let ext = if ext.is_empty() {
        if is_image {
            "png".to_string()
        } else {
            "txt".to_string()
        }
    } else {
        ext.chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(8)
            .collect()
    };
    let file = format!(
        "attachments/{:02}-{}.{ext}",
        meta.attachments.len() + 1,
        slugify(&title)
    );
    write_atomic(&dir.join(&file), &bytes)?;

    let attachment = Attachment {
        file,
        kind,
        title,
        // The path it came from, which is the thing you want to know months
        // later when the note says "the dropdown" and shows you a picture.
        origin: path,
        bytes: bytes.len() as u64,
    };
    meta.attachments.push(attachment.clone());
    meta.updated_at = now_secs();
    write_meta(&dir, &meta)?;
    Ok(attachment)
}

/// Move the note along. The transition is checked, so nothing can declare a
/// note done that was never started.
#[tauri::command]
pub fn notes_set_status(
    store: State<'_, NotesStore>,
    project_id: String,
    id: String,
    status: String,
    by: Option<String>,
    note: Option<String>,
) -> Result<Summary, String> {
    let _guard = store.0.lock().unwrap();
    set_status_impl(project_id, id, status, by, note)
}

fn set_status_impl(
    project_id: String,
    id: String,
    status: String,
    by: Option<String>,
    note: Option<String>,
) -> Result<Summary, String> {
    let to = Status::parse(&status)?;
    let dir = note_dir(&project_id, &id)?;
    let mut meta = read_meta(&dir)?;
    let from = meta.status;
    if !from.can_move_to(to) {
        return Err(format!(
            "{} cannot become {} — from here it can go to: {}",
            from.as_str(),
            to.as_str(),
            from.next()
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
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
    let body = read_body(&dir);
    Ok(summarize(&meta, &body))
}

/// Tie the note to what came out of it.
///
/// This is what makes the note the spine rather than a duplicate: a research
/// run, a task, a PR and a file all hang off the one thought, so "what happened
/// to that idea" has a single answer.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn notes_link(
    store: State<'_, NotesStore>,
    project_id: String,
    id: String,
    pr: Option<PrLink>,
    research: Option<String>,
    task_run: Option<String>,
    branch: Option<String>,
    file: Option<FileRef>,
) -> Result<Detail, String> {
    let _guard = store.0.lock().unwrap();
    link_impl(project_id, id, pr, research, task_run, branch, file)
}

#[allow(clippy::too_many_arguments)]
fn link_impl(
    project_id: String,
    id: String,
    pr: Option<PrLink>,
    research: Option<String>,
    task_run: Option<String>,
    branch: Option<String>,
    file: Option<FileRef>,
) -> Result<Detail, String> {
    let dir = note_dir(&project_id, &id)?;
    let mut meta = read_meta(&dir)?;

    if let Some(pr) = pr {
        match meta
            .links
            .prs
            .iter_mut()
            .find(|p| p.repo == pr.repo && p.number == pr.number)
        {
            // Re-linking is how the reconciler reports a merge, so an existing
            // link updates rather than duplicating.
            Some(existing) => *existing = pr,
            None => meta.links.prs.push(pr),
        }
    }
    if let Some(r) = research {
        let r = r.trim().to_string();
        if !r.is_empty() && !meta.links.research.contains(&r) {
            meta.links.research.push(r);
        }
    }
    if let Some(t) = task_run {
        let t = t.trim().to_string();
        if !t.is_empty() && !meta.links.task_runs.contains(&t) {
            meta.links.task_runs.push(t);
        }
    }
    if let Some(b) = branch {
        let b = b.trim().to_string();
        if !b.is_empty() && !meta.links.branches.contains(&b) {
            meta.links.branches.push(b);
        }
    }
    if let Some(f) = file {
        if !f.path.trim().is_empty() {
            // Keyed by path and line range together: the same file noted twice
            // about two different functions is two references, not one.
            match meta.links.files.iter_mut().find(|x| {
                x.path == f.path && x.start_line == f.start_line && x.end_line == f.end_line
            }) {
                Some(existing) => *existing = f,
                None => meta.links.files.push(f),
            }
        }
    }

    meta.updated_at = now_secs();
    write_meta(&dir, &meta)?;
    notes_get(project_id, id)
}

/// Read a text attachment. The store lives outside every registered workspace
/// root, so `fsx::check_scope` cannot reach it and this is the only reader the
/// UI has for these paths.
#[tauri::command]
pub fn notes_read_file(project_id: String, id: String, path: String) -> Result<String, String> {
    let file = note_file(&project_id, &id, &path)?;
    let bytes = std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0);
    if bytes as usize > ARTIFACT_MAX {
        return Err(format!("{path} is {bytes} bytes — too large to open here"));
    }
    std::fs::read_to_string(&file).map_err(|e| e.to_string())
}

/// Read an image attachment, base64, for an `<img src="data:…">` in the detail
/// tab. Separate from `notes_read_file` because the bytes are not text and
/// reading them as such would mangle them.
#[tauri::command]
pub fn notes_read_image(project_id: String, id: String, path: String) -> Result<String, String> {
    use base64::Engine;
    let file = note_file(&project_id, &id, &path)?;
    let bytes = std::fs::read(&file).map_err(|e| e.to_string())?;
    if bytes.len() > IMAGE_MAX {
        return Err(format!(
            "{path} is {} bytes — too large to open here",
            bytes.len()
        ));
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// The note's directory, for an agent that has been handed the note and needs
/// to read its attachments with its own file tools.
#[tauri::command]
pub fn notes_dir(project_id: String, id: String) -> Result<String, String> {
    Ok(note_dir(&project_id, &id)?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn notes_delete(
    store: State<'_, NotesStore>,
    project_id: String,
    id: String,
) -> Result<(), String> {
    let _guard = store.0.lock().unwrap();
    let dir = note_dir(&project_id, &id)?;
    if !dir.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

// ---- the index's view -----------------------------------------------------

/// One indexable document per note, for spot.rs. `cwd` is where the note was
/// taken, which is what scopes a hit to a project in the existing index — notes
/// inherit SpotSearch's project scoping rather than inventing their own.
pub struct IndexDoc {
    pub project_id: String,
    pub id: String,
    pub title: String,
    pub body: String,
    pub cwd: String,
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
        // The project's own roots are the honest cwd for a note whose capture
        // never recorded one.
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
            // Attachment titles and the referenced file paths, not their
            // contents: "the note with the screenshot of the broken dropdown"
            // and "the note about PrView.tsx" are both real searches, and
            // indexing the blobs themselves would put megabytes into an index
            // that exists to stay small.
            let attachments = meta
                .attachments
                .iter()
                .map(|a| a.title.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let files = meta
                .links
                .files
                .iter()
                .map(|f| f.path.as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let body = [
                read_body(&e.path()),
                meta.context.clone(),
                attachments,
                files,
                meta.tags.join(" "),
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
        assert!(valid_id("0001-a"));
        assert!(valid_id("0042-tiered-donations"));
        assert!(!valid_id("1-short-number"));
        assert!(!valid_id("0001-Upper"));
        assert!(!valid_id("0001-with/slash"));
        assert!(!valid_id("0001-.."));
        assert!(!valid_id("../etc"));
        assert!(!valid_id("0001"));
    }

    #[test]
    fn project_ids_that_could_climb_out_are_refused() {
        assert!(project_dir("../../etc").is_err());
        assert!(project_dir("a/b").is_err());
        assert!(project_dir(".hidden").is_err());
        assert!(project_dir("").is_err());
        assert!(project_dir("proj-1").is_ok());
    }

    #[test]
    fn status_round_trips_through_its_wire_name() {
        for s in [
            Status::Ideation,
            Status::Ready,
            Status::Doing,
            Status::Done,
            Status::Parked,
            Status::Archived,
        ] {
            assert_eq!(Status::parse(s.as_str()).unwrap(), s);
        }
        assert!(Status::parse("completed").is_err());
    }

    /// The three departures from research.rs's machine, asserted rather than
    /// merely commented — each is a decision someone could "tidy up" later
    /// without realising it changes how the feature feels.
    #[test]
    fn the_machine_allows_the_three_moves_a_scratchpad_needs() {
        // Skipping triage: a thought you act on immediately.
        assert!(Status::Ideation.can_move_to(Status::Doing));
        // Reopening: "done" is one person's judgement and is routinely wrong.
        assert!(Status::Done.can_move_to(Status::Doing));
        // Un-archiving, or the archive becomes a place nobody puts anything.
        assert!(Status::Archived.can_move_to(Status::Ideation));
    }

    #[test]
    fn the_machine_still_refuses_the_shortcut_that_matters() {
        // Nothing becomes done without having been worked on: the status has to
        // mean something, or the list is decoration.
        assert!(!Status::Ideation.can_move_to(Status::Done));
        assert!(!Status::Ready.can_move_to(Status::Done));
        assert!(!Status::Parked.can_move_to(Status::Done));
        // An archived note comes back as untriaged, never as decided or done —
        // un-archiving must not silently assert a judgement nobody made.
        assert!(!Status::Archived.can_move_to(Status::Ready));
        assert!(!Status::Archived.can_move_to(Status::Done));
    }

    #[test]
    fn re_entering_a_state_is_a_no_op_not_an_error() {
        for s in [
            Status::Ideation,
            Status::Doing,
            Status::Done,
            Status::Archived,
        ] {
            assert!(s.can_move_to(s));
        }
    }

    #[test]
    fn slugs_are_short_lowercase_and_never_empty() {
        assert_eq!(slugify("Tiered Donations!"), "tiered-donations");
        assert_eq!(slugify("   "), "untitled");
        assert_eq!(slugify("///"), "untitled");
        assert!(slugify(&"x".repeat(200)).len() <= 48);
    }

    #[test]
    fn a_preview_skips_the_heading_and_stops_on_a_word() {
        assert_eq!(
            preview_of("# Tiered donations\n\nWe should tier these by amount."),
            "We should tier these by amount."
        );
        assert_eq!(preview_of("\n\n#only a heading\n"), "");
        let long = preview_of(&"word ".repeat(200));
        assert!(long.chars().count() <= PREVIEW_MAX + 1);
        assert!(long.ends_with('…'));
        assert!(!long.contains("wor…"));
    }

    // ---- lifecycle against a real directory --------------------------------

    // The store root comes from an env var, and an env var is process-wide —
    // so these serialise on one lock rather than racing each other's HOME, the
    // same arrangement research.rs's tests use.
    use std::sync::Mutex as StdMutex;
    static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    struct Home(PathBuf);

    impl Home {
        fn new(name: &str) -> Home {
            let dir = std::env::temp_dir()
                .join(format!("canopy-notes-test-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::env::set_var("CANOPY_NOTES_HOME", &dir);
            Home(dir)
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
            std::env::remove_var("CANOPY_NOTES_HOME");
        }
    }

    fn create(project: &str, title: &str) -> Summary {
        create_impl(
            project.into(),
            Some("Canopy".into()),
            Some(vec!["/tmp/canopy".into()]),
            title.into(),
            None,
            None,
            None,
            Some("spot".into()),
            None,
        )
        .unwrap()
    }

    // These share one process-wide env var, so they run under one test rather
    // than racing each other for it.
    #[test]
    fn a_note_goes_from_thought_to_shipped() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = Home::new("lifecycle");
        let p = "proj";

        let note = create(p, "Tier donations by amount");
        assert_eq!(note.status, "ideation");
        assert_eq!(note.id, "0001-tier-donations-by-amount");

        // Triage, then hand it off.
        set_status_impl(
            p.into(),
            note.id.clone(),
            "ready".into(),
            Some("you".into()),
            None,
        )
        .unwrap();
        let doing = set_status_impl(
            p.into(),
            note.id.clone(),
            "doing".into(),
            Some("you".into()),
            None,
        )
        .unwrap();
        assert_eq!(doing.status, "doing");

        // The agent raises a PR and links it back.
        link_impl(
            p.into(),
            note.id.clone(),
            Some(PrLink {
                repo: "/tmp/canopy".into(),
                number: 281,
                url: "https://example.test/281".into(),
                state: "open".into(),
            }),
            None,
            None,
            None,
            None,
        )
        .unwrap();

        // That PR merges, and the reconciler settles the note.
        link_impl(
            p.into(),
            note.id.clone(),
            Some(PrLink {
                repo: "/tmp/canopy".into(),
                number: 281,
                url: "https://example.test/281".into(),
                state: "merged".into(),
            }),
            None,
            None,
            None,
            None,
        )
        .unwrap();
        let done = set_status_impl(
            p.into(),
            note.id.clone(),
            "done".into(),
            Some("Canopy".into()),
            Some("the linked pull request merged".into()),
        )
        .unwrap();
        assert_eq!(done.status, "done");
        // Re-linking updated in place rather than duplicating.
        assert_eq!(done.pr_count, 1);

        let detail = notes_get(p.into(), note.id.clone()).unwrap();
        assert_eq!(detail.links.prs[0].state, "merged");
        // Every move is on the record, with who made it.
        let moves: Vec<_> = detail
            .history
            .iter()
            .map(|h| (h.from.as_str(), h.to.as_str(), h.by.as_str()))
            .collect();
        assert_eq!(
            moves,
            vec![
                ("ideation", "ready", "you"),
                ("ready", "doing", "you"),
                ("doing", "done", "Canopy"),
            ]
        );
    }

    #[test]
    fn the_default_list_is_a_worklist_and_hides_the_archive() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = Home::new("worklist");
        let p = "proj";
        let keep = create(p, "Keep this one");
        let gone = create(p, "Archive this one");
        set_status_impl(p.into(), gone.id.clone(), "archived".into(), None, None).unwrap();

        let rows = notes_list(p.into(), None, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, keep.id);

        // Asked for explicitly, it is still there — archiving hides, never
        // deletes.
        let archived = notes_list(p.into(), Some(vec!["archived".into()]), None).unwrap();
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].id, gone.id);

        // And it can come back out.
        let back =
            set_status_impl(p.into(), gone.id.clone(), "ideation".into(), None, None).unwrap();
        assert_eq!(back.status, "ideation");
        assert_eq!(notes_list(p.into(), None, None).unwrap().len(), 2);
    }

    #[test]
    fn a_paragraph_typed_into_the_omnibox_is_kept_whole() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = Home::new("paragraph");
        let p = "proj";
        let long = "we should tier donations by amount and tag the github users who \
                    gave, then show the tier on their profile badge, and also let \
                    maintainers opt out of the badge entirely because some of them \
                    will hate it, and none of this should touch the checkout flow"
            .to_string();
        let note = create_impl(
            p.into(),
            None,
            None,
            long.clone(),
            None,
            None,
            None,
            None,
            None,
        )
        .unwrap();
        // The title is cut to something that fits a row…
        assert!(note.title.chars().count() <= TITLE_MAX + 1);
        assert!(note.title.ends_with('…'));
        // …and the thought itself is not lost, which is the whole point.
        let detail = notes_get(p.into(), note.id).unwrap();
        assert_eq!(detail.body, long);
    }

    #[test]
    fn an_empty_note_is_refused_and_an_over_long_body_says_where_it_goes() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = Home::new("caps");
        let p = "proj";
        assert!(create_impl(
            p.into(),
            None,
            None,
            "   ".into(),
            None,
            None,
            None,
            None,
            None
        )
        .is_err());

        let note = create(p, "Fine");
        let err = update_impl(
            p.into(),
            note.id,
            None,
            Some("x".repeat(BODY_MAX + 1)),
            None,
            None,
        )
        .unwrap_err();
        assert!(
            err.to_lowercase().contains("attach"),
            "should say where it goes: {err}"
        );
    }

    #[test]
    fn attachments_land_in_the_note_and_are_read_back() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = Home::new("attach");
        let p = "proj";
        let note = create(p, "Dropdown looks wrong");

        // A 1x1 PNG, as the webview would hand it over.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let img = add_attachment_impl(
            p.into(),
            note.id.clone(),
            "image".into(),
            "the broken dropdown".into(),
            png.into(),
            Some("pasted".into()),
            None,
        )
        .unwrap();
        assert_eq!(img.file, "attachments/01-the-broken-dropdown.png");
        assert_eq!(
            notes_read_image(p.into(), note.id.clone(), img.file.clone()).unwrap(),
            png
        );

        let text = add_attachment_impl(
            p.into(),
            note.id.clone(),
            "artifact".into(),
            "stack trace".into(),
            "TypeError: x is not a function".into(),
            None,
            Some(".log".into()),
        )
        .unwrap();
        assert_eq!(text.file, "attachments/02-stack-trace.log");
        assert_eq!(
            notes_read_file(p.into(), note.id.clone(), text.file).unwrap(),
            "TypeError: x is not a function"
        );

        let summary = notes_list(p.into(), None, None).unwrap();
        assert_eq!(summary[0].attachment_count, 2);
        assert_eq!(summary[0].image_count, 1);
    }

    #[test]
    fn a_file_reference_keeps_the_commit_it_was_taken_at() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = Home::new("fileref");
        let p = "proj";
        let note = create(p, "This memo is wrong");
        let detail = link_impl(
            p.into(),
            note.id.clone(),
            None,
            None,
            None,
            None,
            Some(FileRef {
                path: "src/spotSources.ts".into(),
                start_line: Some(560),
                end_line: Some(581),
                rev: "58777d9".into(),
                snapshot: None,
            }),
        )
        .unwrap();
        assert_eq!(detail.links.files.len(), 1);
        assert_eq!(detail.links.files[0].rev, "58777d9");

        // The same file at a different range is a second reference, not an
        // overwrite of the first.
        let detail = link_impl(
            p.into(),
            note.id.clone(),
            None,
            None,
            None,
            None,
            Some(FileRef {
                path: "src/spotSources.ts".into(),
                start_line: Some(24),
                end_line: Some(51),
                rev: "58777d9".into(),
                snapshot: None,
            }),
        )
        .unwrap();
        assert_eq!(detail.links.files.len(), 2);
    }

    #[test]
    fn reads_cannot_escape_the_note() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = Home::new("escape");
        let p = "proj";
        let note = create(p, "Anything");
        assert!(notes_read_file(p.into(), note.id.clone(), "../../etc/passwd".into()).is_err());
        assert!(notes_read_file(p.into(), note.id.clone(), "/etc/passwd".into()).is_err());
        assert!(notes_read_file(p.into(), "../../../etc".into(), "passwd".into()).is_err());
    }

    #[test]
    fn ids_are_never_reused_after_a_delete() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = Home::new("ids");
        let p = "proj";
        let first = create(p, "First");
        assert_eq!(first.id, "0001-first");
        notes_delete_impl(p, &first.id).unwrap();
        // 0002, not 0001 — an id may be cited from a PR body or another note,
        // and reuse would silently repoint it. Nothing is left on disk to
        // derive that from, so this is the persisted counter doing the work.
        let second = create(p, "Second");
        assert_eq!(second.id, "0002-second");

        // The other half: with the counter gone (an older build, a lost or
        // hand-mangled project.json) the listing still has to hold the line.
        std::fs::remove_file(project_dir(p).unwrap().join("project.json")).unwrap();
        let third = create(p, "Third");
        assert_eq!(third.id, "0003-third");
    }

    #[test]
    fn search_ranks_a_title_hit_above_one_buried_in_the_body() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = Home::new("search");
        let p = "proj";
        let buried = create(p, "Something else entirely");
        update_impl(
            p.into(),
            buried.id.clone(),
            None,
            Some("we should tier donations eventually".into()),
            None,
            None,
        )
        .unwrap();
        let titled = create(p, "Tier donations by amount");

        let hits = notes_search(p.into(), "tier donations".into(), None).unwrap();
        assert_eq!(hits.len(), 2);
        // The title hit answers the question; the body mention is a lead.
        assert_eq!(hits[0].id, titled.id);
        assert_eq!(hits[1].id, buried.id);
    }

    #[test]
    fn search_is_empty_rather_than_everything_for_an_empty_query() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = Home::new("search-empty");
        let p = "proj";
        create(p, "Anything");
        assert!(notes_search(p.into(), "   ".into(), None)
            .unwrap()
            .is_empty());
        assert!(notes_search(p.into(), "nothing matches this".into(), None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn the_index_sees_notes_with_the_cwd_that_scopes_them() {
        let _lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = Home::new("index");
        let p = "proj";
        let note = create(p, "Tier donations");
        update_impl(
            p.into(),
            note.id.clone(),
            None,
            Some("badge on the profile".into()),
            None,
            None,
        )
        .unwrap();

        let docs = index_docs();
        let doc = docs.iter().find(|d| d.id == note.id).expect("indexed");
        assert_eq!(doc.project_id, p);
        assert!(doc.title.contains("ideation"));
        assert!(doc.body.contains("badge on the profile"));
        // The cwd fell back to the project's root, which is what scopes a hit.
        assert_eq!(doc.cwd, "/tmp/canopy");
    }

    /// The command takes `State`, which a unit test has no way to build, so the
    /// delete path is exercised through the same directory removal it performs.
    fn notes_delete_impl(project_id: &str, id: &str) -> Result<(), String> {
        let dir = note_dir(project_id, id)?;
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

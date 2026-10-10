//! Desktop configuration for the scratchpad store in canopy-core.
//! Keep the legacy location, the launchd reminder hook and the workspace file
//! scope here; the store itself has no environment discovery.

pub use canopy_core::notes::*;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

/// `CANOPY_NOTES_HOME` points straight at the store (tests); HOME needs the
/// usual `~/.canopy/notes`. Changing this hides every existing note.
fn root_from(notes_home: Option<String>, home: Option<String>) -> Option<PathBuf> {
    if let Some(dir) = notes_home {
        return Some(PathBuf::from(dir));
    }
    Some(PathBuf::from(home?).join(".canopy").join("notes"))
}

fn root() -> Option<PathBuf> {
    root_from(
        std::env::var("CANOPY_NOTES_HOME").ok(),
        std::env::var("HOME").ok(),
    )
}

/// Reminders go to launchd where it exists; see remind.rs.
struct LaunchdReminders;

impl Reminders for LaunchdReminders {
    fn schedule(&self, job: &ReminderJob) -> bool {
        crate::remind::schedule(job).is_system()
    }

    fn unschedule(&self, project_id: &str, note_id: &str) {
        crate::remind::unschedule(project_id, note_id);
    }
}

fn at(root: Option<PathBuf>) -> NotesStore {
    NotesStore::new(
        root,
        Arc::new(crate::change::DesktopEvents),
        Arc::new(LaunchdReminders),
    )
}

pub fn load() -> NotesStore {
    at(root())
}

#[tauri::command]
pub fn notes_list(
    store: State<'_, NotesStore>,
    project_id: String,
    status: Option<Vec<String>>,
    limit: Option<usize>,
) -> Result<Vec<Summary>, String> {
    store.list(project_id, status, limit)
}

#[tauri::command]
pub fn notes_search(
    store: State<'_, NotesStore>,
    project_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<Summary>, String> {
    store.search(project_id, query, limit)
}

#[tauri::command]
pub fn notes_get(
    store: State<'_, NotesStore>,
    project_id: String,
    id: String,
) -> Result<Detail, String> {
    store.get(project_id, id)
}

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
    store.create(
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
    store.update(project_id, id, title, body, append, tags)
}

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
    store.add_attachment(project_id, id, kind, title, data, origin, ext)
}

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
    store.attach_file(
        &|src| crate::fsx::check_scope(&ws, src),
        project_id,
        id,
        path,
        title,
        kind,
    )
}

#[tauri::command]
pub fn notes_set_status(
    store: State<'_, NotesStore>,
    project_id: String,
    id: String,
    status: String,
    by: Option<String>,
    note: Option<String>,
) -> Result<Summary, String> {
    store.set_status(project_id, id, status, by, note)
}

#[tauri::command]
pub fn notes_remind(
    store: State<'_, NotesStore>,
    project_id: String,
    id: String,
    at: Option<i64>,
    note: Option<String>,
    by: Option<String>,
) -> Result<Summary, String> {
    store.remind(project_id, id, at, note, by)
}

/// `async` is load-bearing: Tauri runs a non-async command on the **main
/// thread**, and this sweeps every note's meta.json in every project every 30
/// seconds. That was hundreds of file reads and JSON parses blocking the UI
/// event loop, twice a minute, whether or not any reminder existed.
#[tauri::command(async)]
pub fn notes_due(store: State<'_, NotesStore>, before: i64) -> Result<Vec<Due>, String> {
    store.due(before)
}

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
    store.link(project_id, id, pr, research, task_run, branch, file)
}

#[tauri::command]
pub fn notes_read_file(
    store: State<'_, NotesStore>,
    project_id: String,
    id: String,
    path: String,
) -> Result<String, String> {
    store.read_file(project_id, id, path)
}

#[tauri::command]
pub fn notes_read_image(
    store: State<'_, NotesStore>,
    project_id: String,
    id: String,
    path: String,
) -> Result<String, String> {
    store.read_image(project_id, id, path)
}

#[tauri::command]
pub fn notes_dir(
    store: State<'_, NotesStore>,
    project_id: String,
    id: String,
) -> Result<String, String> {
    store.dir(project_id, id)
}

#[tauri::command]
pub fn notes_delete(
    store: State<'_, NotesStore>,
    project_id: String,
    id: String,
) -> Result<(), String> {
    store.delete(project_id, id)
}

/// Everything indexable, across projects, for spot.rs.
pub fn index_docs() -> Vec<IndexDoc> {
    load().index_docs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_keeps_the_legacy_locations() {
        assert_eq!(
            root_from(Some("/override".into()), Some("/home/u".into())),
            Some(PathBuf::from("/override"))
        );
        assert_eq!(
            root_from(None, Some("/home/u".into())),
            Some(PathBuf::from("/home/u/.canopy/notes"))
        );
        assert_eq!(root_from(None, None), None);
    }

    /// An existing install's notes must be found where they already are.
    #[test]
    fn existing_notes_are_read_back() {
        let dir = std::env::temp_dir().join(format!("canopy-desktop-notes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let note = dir.join("p1").join("0007-kept");
        std::fs::create_dir_all(&note).unwrap();
        std::fs::write(
            note.join("meta.json"),
            "{\"id\":\"0007-kept\",\"project_id\":\"p1\",\"title\":\"Kept\",\"status\":\"ready\"}",
        )
        .unwrap();
        std::fs::write(note.join("note.md"), "still here").unwrap();

        let detail = at(Some(dir.clone()))
            .get("p1".into(), "0007-kept".into())
            .unwrap();
        assert_eq!(detail.summary.title, "Kept");
        assert_eq!(detail.summary.status, "ready");
        assert_eq!(detail.body, "still here");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

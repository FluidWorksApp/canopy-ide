//! Desktop configuration for the research store in canopy-core.
//! Keep the legacy location and the panel's event name here; the store itself
//! has no environment discovery.

pub use canopy_core::research::*;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

/// What the research panel listens for (`onResearchChanged` in ipc.ts), with
/// the project id as its payload. `change::DesktopEvents` emits it for every
/// change the store announces.
pub const RESEARCH_CHANGED: &str = "research:changed";

/// `CANOPY_RESEARCH_HOME` points straight at the store (tests); HOME needs the
/// usual `~/.canopy/research`. canopy_hook reads session bindings from the
/// HOME location, so changing this strands them.
fn root_from(research_home: Option<String>, home: Option<String>) -> Option<PathBuf> {
    if let Some(dir) = research_home {
        return Some(PathBuf::from(dir));
    }
    Some(PathBuf::from(home?).join(".canopy").join("research"))
}

fn root() -> Option<PathBuf> {
    root_from(
        std::env::var("CANOPY_RESEARCH_HOME").ok(),
        std::env::var("HOME").ok(),
    )
}

fn at(root: Option<PathBuf>) -> ResearchStore {
    ResearchStore::new(root, Arc::new(crate::change::DesktopEvents))
}

pub fn load() -> ResearchStore {
    at(root())
}

#[tauri::command]
pub fn research_list(
    store: State<'_, ResearchStore>,
    project_id: String,
    status: Option<Vec<String>>,
    limit: Option<usize>,
) -> Result<Vec<Summary>, String> {
    store.list(project_id, status, limit)
}

#[tauri::command]
pub fn research_search(
    store: State<'_, ResearchStore>,
    project_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<Summary>, String> {
    store.search(project_id, query, limit)
}

#[tauri::command]
pub fn research_get(
    store: State<'_, ResearchStore>,
    project_id: String,
    id: String,
) -> Result<Detail, String> {
    store.get(project_id, id)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn research_start(
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
    body: Option<String>,
    instance: Option<String>,
) -> Result<Summary, String> {
    store.start(
        project_id,
        project_name,
        roots,
        title,
        question,
        agent,
        cwd,
        pty_id,
        tags,
        body,
        instance,
    )
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn research_update(
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
    store.update(
        project_id,
        id,
        title,
        digest,
        recommendation,
        open_questions,
        tags,
        append,
        body,
    )
}

#[tauri::command]
pub fn research_add_source(
    store: State<'_, ResearchStore>,
    project_id: String,
    id: String,
    title: String,
    body: String,
    origin: Option<String>,
) -> Result<SourceRef, String> {
    store.add_source(project_id, id, title, body, origin)
}

#[tauri::command]
pub fn research_set_status(
    store: State<'_, ResearchStore>,
    project_id: String,
    id: String,
    status: String,
    by: Option<String>,
    note: Option<String>,
) -> Result<Summary, String> {
    store.set_status(project_id, id, status, by, note)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn research_link(
    store: State<'_, ResearchStore>,
    project_id: String,
    id: String,
    pr: Option<PrLink>,
    ticket: Option<TicketLink>,
    branch: Option<String>,
    files: Option<Vec<String>>,
    supersedes: Option<String>,
) -> Result<Detail, String> {
    store.link(project_id, id, pr, ticket, branch, files, supersedes)
}

#[tauri::command]
pub fn research_read_file(
    store: State<'_, ResearchStore>,
    project_id: String,
    id: String,
    path: String,
) -> Result<String, String> {
    store.read_file(project_id, id, path)
}

#[tauri::command]
pub fn research_for_file(
    store: State<'_, ResearchStore>,
    project_id: String,
    path: String,
) -> Result<Option<String>, String> {
    store.for_file(project_id, path)
}

#[tauri::command]
pub fn research_import(
    store: State<'_, ResearchStore>,
    project_id: String,
    project_name: Option<String>,
    roots: Option<Vec<String>>,
    path: String,
    instance: Option<String>,
) -> Result<Summary, String> {
    store.import(project_id, project_name, roots, path, instance)
}

#[tauri::command]
pub fn research_sweep(
    store: State<'_, ResearchStore>,
    project_id: String,
    project_name: Option<String>,
    roots: Vec<String>,
) -> Result<SweepSummary, String> {
    store.sweep(project_id, project_name, roots)
}

#[tauri::command]
pub fn research_dir(
    store: State<'_, ResearchStore>,
    project_id: String,
    id: String,
) -> Result<String, String> {
    store.dir(project_id, id)
}

#[tauri::command]
pub fn research_delete(
    store: State<'_, ResearchStore>,
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
            Some(PathBuf::from("/home/u/.canopy/research"))
        );
        assert_eq!(root_from(None, None), None);
    }

    /// An existing install's entries must be found where they already are.
    #[test]
    fn existing_entries_are_read_back() {
        let dir =
            std::env::temp_dir().join(format!("canopy-desktop-research-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let entry = dir.join("p1").join("0003-kept");
        std::fs::create_dir_all(&entry).unwrap();
        std::fs::write(
            entry.join("meta.json"),
            "{\"id\":\"0003-kept\",\"project_id\":\"p1\",\"title\":\"Kept\",\
             \"status\":\"researched\",\"digest\":\"still here\"}",
        )
        .unwrap();

        let rows = at(Some(dir.clone())).list("p1".into(), None, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "researched");
        assert_eq!(rows[0].digest, "still here");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

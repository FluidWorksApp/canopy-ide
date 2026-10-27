//! Churn for hotspot inference (src/awareness/hotspots.ts).
//!
//! A hotspot is a file many changes pass through — a route table, a registry,
//! a config — where two agents writing at once is how work collides. The
//! cheapest honest signal for "many changes pass through it" is how often git
//! has seen it change lately, so this is one `git log --name-only` over the
//! window, counted per path. Everything else (heuristics, claim refusals, the
//! person's own override) is combined on the TypeScript side.

use std::collections::HashMap;

use serde::Serialize;
use tauri::State;

use crate::fsx::WorkspaceManager;
use crate::git::{git, repo_path, run};

/// How many paths come back at most: hotspots are the head of the
/// distribution, and a monorepo's long tail is noise the frontend would drop.
const MAX_PATHS: usize = 200;

#[derive(Serialize, Debug, PartialEq)]
pub struct ChurnRow {
    /// Repo-relative, as git prints it.
    pub path: String,
    /// Commits in the window that changed it.
    pub commits: u32,
}

/// Count, per path, the commits in `git log --name-only` output. Commit
/// separators are blank lines and the `--pretty=format:` header is empty, so
/// every non-empty line is a path.
fn count_churn(out: &str) -> Vec<ChurnRow> {
    let mut counts: HashMap<&str, u32> = HashMap::new();
    for line in out.lines() {
        let path = line.trim();
        if !path.is_empty() {
            *counts.entry(path).or_default() += 1;
        }
    }
    let mut rows: Vec<ChurnRow> = counts
        .into_iter()
        .map(|(path, commits)| ChurnRow {
            path: path.to_string(),
            commits,
        })
        .collect();
    rows.sort_by(|a, b| b.commits.cmp(&a.commits).then_with(|| a.path.cmp(&b.path)));
    rows.truncate(MAX_PATHS);
    rows
}

/// Files by how often they changed in the last `days` days (default 30),
/// most-changed first. Merges are skipped: they repeat their parents' paths.
#[tauri::command]
pub async fn git_churn(
    state: State<'_, WorkspaceManager>,
    repo: String,
    days: Option<u32>,
) -> Result<Vec<ChurnRow>, String> {
    let top = repo_path(&state, &repo)?;
    let days = days.unwrap_or(30).clamp(1, 365);
    let out = run(git(&top).args([
        "log",
        &format!("--since={days}.days"),
        "--no-merges",
        "--name-only",
        "--pretty=format:",
        "-n",
        "2000",
    ]))?;
    Ok(count_churn(&out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_paths_across_commits_most_changed_first() {
        let out = "src/routes.ts\nsrc/a.ts\n\nsrc/routes.ts\n\n\nsrc/routes.ts\nsrc/b.ts\n";
        let rows = count_churn(out);
        assert_eq!(
            rows[0],
            ChurnRow {
                path: "src/routes.ts".into(),
                commits: 3
            }
        );
        assert_eq!(rows.len(), 3);
        // Ties break by path so the order is stable between calls.
        assert_eq!(rows[1].path, "src/a.ts");
    }

    #[test]
    fn empty_log_is_no_churn() {
        assert!(count_churn("").is_empty());
    }
}

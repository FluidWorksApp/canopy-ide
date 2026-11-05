//! "Set up from this Mac": the local half of mirroring projects into the
//! selected remote workspace.
//!
//! The renderer never names a local path here. Both commands read the
//! project store themselves and address a component by its store ids, so the
//! remote-mode renderer still has no general reader for local files (see
//! remote_upload.rs). For one component the send command produces:
//!   commits.bundle  commits not on origin (none when everything is pushed)
//!   staged.patch    `git diff --cached --binary`
//!   unstaged.patch  `git diff --binary`
//!   files.tgz       untracked, non-ignored files; ignored env files only when
//!                   the person opted in
//! and uploads them to /workspace/.canopy-mirror/<id>/, where the workspace's
//! mirror job (packages/remote-host/mirror-apply.mjs) applies them.
use crate::client_mode::{execution_remote_get, RemoteConnectionState};
use crate::git::{git, run};
use crate::remote_upload::{claim_upload, remote, send_file};
use crate::winproc::NoConsoleWindow;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const FILES_MAX_BYTES: u64 = 200 * 1024 * 1024;
const FILES_MAX: usize = 5000;
const BUNDLE_MAX_BYTES: u64 = 1024 * 1024 * 1024;
const ENV_MAX_BYTES: u64 = 1024 * 1024;
const ENV_MAX_COUNT: usize = 50;
const ARTIFACTS: [&str; 4] = [
    "commits.bundle",
    "staged.patch",
    "unstaged.patch",
    "files.tgz",
];

#[derive(Clone, Debug)]
struct StoreComponent {
    project_id: String,
    project_name: String,
    component_id: String,
    label: String,
    path: String,
}

fn store_components(body: &str) -> Vec<StoreComponent> {
    let value: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let text = |v: &serde_json::Value, key: &str| v[key].as_str().unwrap_or_default().to_string();
    value["projects"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|project| {
            project["components"]
                .as_array()
                .into_iter()
                .flatten()
                .map(move |component| StoreComponent {
                    project_id: text(project, "id"),
                    project_name: text(project, "name"),
                    component_id: text(component, "id"),
                    label: text(component, "label"),
                    path: text(component, "path"),
                })
        })
        .filter(|c| !c.project_id.is_empty() && !c.component_id.is_empty() && !c.path.is_empty())
        .collect()
}

/// Everything about one repository that decides what the workspace receives.
#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RepoState {
    top: PathBuf,
    relative: String,
    origin: String,
    head: String,
    branch: Option<String>,
    upstream: Option<String>,
    unpushed: usize,
    staged: usize,
    unstaged: usize,
    stashes: usize,
}

fn inspect_repo(component: &Path) -> Result<RepoState, String> {
    if !component.is_dir() {
        return Err("Saved folder no longer exists on this device".into());
    }
    let top = PathBuf::from(
        run(git(component).args(["rev-parse", "--show-toplevel"]))
            .map_err(|_| "This folder is not a Git repository")?
            .trim(),
    );
    let canonical_top = std::fs::canonicalize(&top).map_err(|_| "Repository unavailable")?;
    let canonical = std::fs::canonicalize(component).map_err(|_| "Folder unavailable")?;
    let relative = canonical
        .strip_prefix(&canonical_top)
        .map_err(|_| "Folder is outside its repository")?
        .to_str()
        .ok_or("Folder name is not valid UTF-8")?
        .to_string();
    let origin = run(git(&top).args(["remote", "get-url", "origin"]))
        .map_err(|_| "No Git origin is configured")?
        .trim()
        .to_string();
    let head = run(git(&top).args(["rev-parse", "--verify", "HEAD"]))
        .map_err(|_| "This repository has no commits yet")?
        .trim()
        .to_string();
    let branch = run(git(&top).args(["symbolic-ref", "--quiet", "--short", "HEAD"]))
        .ok()
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty());
    let upstream = run(git(&top).args([
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
    ]))
    .ok()
    .map(|u| u.trim().to_string())
    .filter(|u| u.starts_with("origin/"));
    let count = |args: &[&str]| -> usize {
        run(git(&top).args(args))
            .map(|out| out.split('\0').filter(|s| !s.is_empty()).count())
            .unwrap_or(0)
    };
    let unpushed =
        run(git(&top).args(["rev-list", "--count", "HEAD", "--not", "--remotes=origin"]))
            .ok()
            .and_then(|n| n.trim().parse().ok())
            .unwrap_or(0);
    Ok(RepoState {
        relative,
        origin,
        head,
        branch,
        upstream,
        unpushed,
        staged: count(&["diff", "--cached", "--name-only", "-z"]),
        unstaged: count(&["diff", "--name-only", "-z"]),
        stashes: run(git(&top).args(["stash", "list"]))
            .map(|out| out.lines().count())
            .unwrap_or(0),
        top,
    })
}

/// Regular files only (no symlinks, devices or folders), relative to `top`.
fn regular_files(top: &Path, names: &str) -> Vec<(String, u64)> {
    names
        .split('\0')
        .filter(|name| !name.is_empty() && !name.ends_with('/') && !name.contains('\n'))
        .filter_map(|name| {
            let meta = std::fs::symlink_metadata(top.join(name)).ok()?;
            meta.file_type()
                .is_file()
                .then(|| (name.to_string(), meta.len()))
        })
        .collect()
}

/// File names that usually hold credentials. Templates (`.env.example`) are
/// meant to be committed and are not treated as secrets.
fn looks_secret(name: &str) -> bool {
    let base = name.rsplit('/').next().unwrap_or(name).to_ascii_lowercase();
    if [".env.example", ".env.sample", ".env.template", ".env.dist"].contains(&base.as_str()) {
        return false;
    }
    base == ".env"
        || base.starts_with(".env.")
        || base == ".npmrc"
        || base == ".netrc"
        || ["id_rsa", "id_ed25519", "id_ecdsa", "id_dsa"]
            .iter()
            .any(|key| base.starts_with(key))
        || [".pem", ".key", ".p12", ".pfx"]
            .iter()
            .any(|ext| base.ends_with(ext))
}

struct Untracked {
    /// Sent regardless of the env opt-in.
    included: Vec<(String, u64)>,
    /// Untracked, not ignored, and credential-shaped: sent only on opt-in.
    secrets: Vec<(String, u64)>,
    /// Over the size or count caps.
    skipped: usize,
}

/// New files git would show as untracked, smallest first up to the caps.
/// A `.env` that was simply never gitignored is untracked too, so credential-
/// shaped names are held back here rather than riding along with ordinary files.
fn untracked_files(top: &Path) -> Untracked {
    let names = run(git(top).args(["ls-files", "--others", "--exclude-standard", "-z"]))
        .unwrap_or_default();
    let (secrets, mut files): (Vec<_>, Vec<_>) = regular_files(top, &names)
        .into_iter()
        .partition(|(name, _)| looks_secret(name));
    files.sort_by_key(|(name, size)| (*size, name.clone()));
    let (mut total, mut included) = (0u64, Vec::new());
    for file in &files {
        if included.len() >= FILES_MAX || total + file.1 > FILES_MAX_BYTES {
            break;
        }
        total += file.1;
        included.push(file.clone());
    }
    let skipped = files.len() - included.len();
    Untracked {
        included,
        secrets,
        skipped,
    }
}

/// `https://user:token@host/x` -> `https://host/x`: the renderer is shown the
/// origin, and a token embedded in it has no business there.
fn redact_origin(url: &str) -> String {
    for scheme in ["https://", "http://"] {
        if let Some(rest) = url.strip_prefix(scheme) {
            let authority_end = rest.find('/').unwrap_or(rest.len());
            if let Some(at) = rest[..authority_end].rfind('@') {
                return format!("{scheme}{}", &rest[at + 1..]);
            }
        }
    }
    url.to_string()
}

/// Ignored `.env` / `.env.*` files outside ignored folders (`--directory`
/// stops git listing every file under node_modules).
fn env_files(top: &Path) -> Vec<(String, u64)> {
    let names = run(git(top).args([
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
    ]))
    .unwrap_or_default();
    regular_files(top, &names)
        .into_iter()
        .filter(|(name, size)| {
            let base = name.rsplit('/').next().unwrap_or(name);
            (base == ".env" || base.starts_with(".env.")) && *size <= ENV_MAX_BYTES
        })
        .collect()
}

fn to_file(mut cmd: Command, out: &Path) -> Result<bool, String> {
    let file = std::fs::File::create(out).map_err(|_| "Cannot prepare setup files")?;
    let status = cmd
        .stdout(Stdio::from(file))
        .stderr(Stdio::null())
        .status()
        .map_err(|_| "Git is unavailable on this Mac")?;
    Ok(status.success())
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Prepared {
    commits: bool,
    staged: bool,
    unstaged: bool,
    files: usize,
    env_files: usize,
    skipped: Vec<String>,
    /// Name -> size of each artifact written, so the workspace can refuse to
    /// apply a setup whose upload went elsewhere or was cut short.
    artifacts: std::collections::BTreeMap<String, u64>,
}

/// Write the artifacts for `state` into `dir`; empty ones are removed.
fn prepare(state: &RepoState, include_env: bool, dir: &Path) -> Result<Prepared, String> {
    let top = &state.top;
    let mut prepared = Prepared::default();
    if state.unpushed > 0 {
        let bundle = dir.join("commits.bundle");
        let mut cmd = git(top);
        cmd.args(["bundle", "create"])
            .arg(&bundle)
            .args(["HEAD", "--not", "--remotes=origin"]);
        if !to_file(cmd, &dir.join("bundle.log"))? {
            return Err("Could not package this repository's unpushed commits".into());
        }
        let size = std::fs::metadata(&bundle).map(|m| m.len()).unwrap_or(0);
        if size > BUNDLE_MAX_BYTES {
            return Err("Unpushed commits exceed 1 GB. Push them, then set up again.".into());
        }
        prepared.commits = true;
    }
    for (name, cached) in [("staged.patch", true), ("unstaged.patch", false)] {
        let mut cmd = git(top);
        cmd.args([
            "diff",
            "--binary",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
        ]);
        if cached {
            cmd.arg("--cached");
        }
        if !to_file(cmd, &dir.join(name))? {
            return Err("Could not read this repository's changes".into());
        }
        let has = std::fs::metadata(dir.join(name))
            .map(|m| m.len() > 0)
            .unwrap_or(false);
        if cached {
            prepared.staged = has;
        } else {
            prepared.unstaged = has;
        }
    }
    let found = untracked_files(top);
    let (mut files, skipped) = (found.included, found.skipped);
    prepared.files = files.len();
    if skipped > 0 {
        prepared.skipped.push(format!(
            "{skipped} new {} over the 200 MB / {FILES_MAX}-file limit stayed on this Mac",
            if skipped == 1 { "file" } else { "files" }
        ));
    }
    if include_env {
        let mut env = env_files(top);
        env.extend(
            found
                .secrets
                .iter()
                .filter(|(_, size)| *size <= ENV_MAX_BYTES)
                .cloned(),
        );
        env.truncate(ENV_MAX_COUNT);
        prepared.env_files = env.len();
        files.extend(env);
    } else if !found.secrets.is_empty() {
        prepared.skipped.push(format!(
            "{} untracked {} that look like credentials stayed on this Mac (include env files to send them)",
            found.secrets.len(),
            if found.secrets.len() == 1 { "file" } else { "files" }
        ));
    }
    if !files.is_empty() {
        let mut cmd = Command::new(crate::procenv::resolve_command("tar"));
        cmd.no_console_window();
        // macOS tar would otherwise add AppleDouble `._` files and xattrs.
        cmd.current_dir(top).env("COPYFILE_DISABLE", "1");
        #[cfg(target_os = "macos")]
        cmd.arg("--no-xattrs");
        cmd.args(["--no-recursion", "--null", "-czf"])
            .arg(dir.join("files.tgz"))
            .args(["-T", "-"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|_| "tar is unavailable on this Mac")?;
        let list: Vec<u8> = files
            .iter()
            .flat_map(|(name, _)| name.bytes().chain(std::iter::once(0)))
            .collect();
        child
            .stdin
            .take()
            .ok_or("Cannot package new files")?
            .write_all(&list)
            .map_err(|_| "Cannot package new files")?;
        if !child
            .wait()
            .map_err(|_| "Cannot package new files")?
            .success()
        {
            return Err("Could not package this repository's new files".into());
        }
    }
    for name in ARTIFACTS {
        let path = dir.join(name);
        if std::fs::metadata(&path)
            .map(|m| m.len() == 0)
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(path);
        }
    }
    for name in ARTIFACTS {
        if let Ok(meta) = std::fs::metadata(dir.join(name)) {
            prepared.artifacts.insert(name.to_string(), meta.len());
        }
    }
    if state.stashes > 0 {
        prepared.skipped.push(format!(
            "{} stash entries stayed on this Mac",
            state.stashes
        ));
    }
    Ok(prepared)
}

fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

async fn local_components() -> Result<Vec<StoreComponent>, String> {
    Ok(store_components(&crate::fsx::store_load().await?))
}

/// What each local project component would carry, without any file content.
#[tauri::command]
pub async fn execution_mirror_inspect() -> Result<Vec<serde_json::Value>, String> {
    let components = local_components().await?;
    tauri::async_runtime::spawn_blocking(move || {
        components
            .into_iter()
            .take(256)
            .map(|c| {
                let mut row = serde_json::json!({
                    "projectId": c.project_id, "projectName": c.project_name,
                    "componentId": c.component_id, "label": c.label, "path": c.path,
                });
                match inspect_repo(Path::new(&c.path)) {
                    Ok(state) => {
                        let found = untracked_files(&state.top);
                        let (files, skipped) = (found.included, found.skipped);
                        // Credential-shaped files that would go up on opt-in, so the
                        // person is told about them whether or not git ignores them.
                        let mut env = env_files(&state.top);
                        env.extend(found.secrets);
                        row["repo"] = serde_json::json!(state.top.to_string_lossy());
                        for (key, value) in [
                            ("relative", serde_json::json!(state.relative)),
                            ("origin", serde_json::json!(redact_origin(&state.origin))),
                            ("head", serde_json::json!(state.head)),
                            ("branch", serde_json::json!(state.branch)),
                            ("unpushed", serde_json::json!(state.unpushed)),
                            ("staged", serde_json::json!(state.staged)),
                            ("unstaged", serde_json::json!(state.unstaged)),
                            ("untracked", serde_json::json!(files.len() + skipped)),
                            ("stashes", serde_json::json!(state.stashes)),
                            (
                                "envFiles",
                                serde_json::json!(env.iter().map(|(n, _)| n).collect::<Vec<_>>()),
                            ),
                        ] {
                            row[key] = value;
                        }
                    }
                    Err(error) => row["error"] = serde_json::json!(error),
                }
                row
            })
            .collect()
    })
    .await
    .map_err(|_| "Local project inspection failed".to_string())
}

/// Package one component's repository state and upload it for the
/// workspace's `mirror_apply_start`. `id` names the remote staging folder.
#[tauri::command]
pub async fn execution_mirror_send(
    app: tauri::AppHandle,
    state: tauri::State<'_, RemoteConnectionState>,
    id: String,
    project_id: String,
    component_id: String,
    include_env: bool,
) -> Result<serde_json::Value, String> {
    if !valid_id(&id) {
        return Err("Invalid setup identifier".into());
    }
    let connection = execution_remote_get(app, state)?.ok_or("Select a remote workspace first")?;
    if connection.scope.as_deref() == Some("view") {
        return Err("This workspace connection is view-only".into());
    }
    let component = local_components()
        .await?
        .into_iter()
        .find(|c| c.project_id == project_id && c.component_id == component_id)
        .ok_or("This project is no longer on this Mac")?;
    let claim = claim_upload(&id)?;
    let dir = std::env::temp_dir().join(format!("canopy-mirror-{id}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|_| "Cannot prepare setup files")?;
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(dir.clone());
    let work = dir.clone();
    let (repo, prepared) = tauri::async_runtime::spawn_blocking(move || -> Result<_, String> {
        let repo = inspect_repo(Path::new(&component.path))?;
        let prepared = prepare(&repo, include_env, &work)?;
        Ok((repo, prepared))
    })
    .await
    .map_err(|_| "Local project inspection failed")??;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Upload connection unavailable")?;
    let staging = format!("/workspace/.canopy-mirror/{id}");
    remote(
        &client,
        &connection,
        "fs_upload_dir",
        serde_json::json!({"path":staging}),
    )
    .await?;
    let mut bytes = 0u64;
    for name in ARTIFACTS {
        let local = dir.join(name);
        if local.is_file() {
            bytes += send_file(
                &client,
                &connection,
                &local,
                &format!("{staging}/{name}"),
                &claim.cancel,
            )
            .await?;
        }
    }
    Ok(serde_json::json!({
        "head": repo.head, "branch": repo.branch, "upstream": repo.upstream,
        "relative": repo.relative, "origin": redact_origin(&repo.origin), "bytes": bytes,
        "sent": prepared,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "T")
            .env("GIT_AUTHOR_EMAIL", "t@e")
            .env("GIT_COMMITTER_NAME", "T")
            .env("GIT_COMMITTER_EMAIL", "t@e")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn fixture(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "canopy-mirror-test-{name}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        sh(&base, &["init", "--bare", "-b", "main", "origin.git"]);
        sh(&base, &["clone", "origin.git", "mac"]);
        let mac = base.join("mac");
        std::fs::write(mac.join("app.js"), "one\n").unwrap();
        std::fs::write(mac.join(".gitignore"), ".env\nnode_modules\n").unwrap();
        sh(&mac, &["add", "."]);
        sh(&mac, &["commit", "-m", "first"]);
        sh(&mac, &["push", "origin", "main"]);
        base
    }

    #[test]
    fn store_components_keep_ids_and_paths() {
        let body = r#"{"projects":[{"id":"p1","name":"Shop","components":[{"id":"c1","label":"web","path":"/w/shop/web"},{"id":"","label":"x","path":"/x"}]}]}"#;
        let found = store_components(body);
        assert_eq!(found.len(), 1);
        assert_eq!(
            (found[0].project_name.as_str(), found[0].path.as_str()),
            ("Shop", "/w/shop/web")
        );
        assert!(store_components("null").is_empty());
    }

    #[test]
    fn clean_pushed_repository_sends_nothing() {
        let base = fixture("clean");
        let mac = base.join("mac");
        let state = inspect_repo(&mac).unwrap();
        assert_eq!((state.unpushed, state.staged, state.unstaged), (0, 0, 0));
        assert_eq!(state.branch.as_deref(), Some("main"));
        assert_eq!(state.upstream.as_deref(), Some("origin/main"));
        let out = base.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let prepared = prepare(&state, true, &out).unwrap();
        assert!(!prepared.commits && !prepared.staged && !prepared.unstaged);
        for name in ARTIFACTS {
            assert!(!out.join(name).exists(), "{name} should not exist");
        }
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn work_in_progress_becomes_artifacts() {
        let base = fixture("wip");
        let mac = base.join("mac");
        sh(&mac, &["switch", "-c", "feature"]);
        std::fs::write(mac.join("feature.js"), "local\n").unwrap();
        sh(&mac, &["add", "."]);
        sh(&mac, &["commit", "-m", "unpushed"]);
        std::fs::write(mac.join("app.js"), "one\nstaged\n").unwrap();
        sh(&mac, &["add", "app.js"]);
        std::fs::write(mac.join("app.js"), "one\nstaged\nunstaged\n").unwrap();
        std::fs::create_dir_all(mac.join("notes")).unwrap();
        std::fs::write(mac.join("notes/todo.md"), "new\n").unwrap();
        std::fs::write(mac.join(".env"), "SECRET=1\n").unwrap();
        std::fs::create_dir_all(mac.join("node_modules/pkg")).unwrap();
        std::fs::write(mac.join("node_modules/pkg/.env"), "ignored dir\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hosts", mac.join("link")).unwrap();
        let state = inspect_repo(&mac.join("notes")).unwrap();
        assert_eq!(state.relative, "notes");
        assert_eq!((state.unpushed, state.staged, state.unstaged), (1, 1, 1));
        assert_eq!(state.branch.as_deref(), Some("feature"));
        assert_eq!(state.upstream, None);
        assert_eq!(env_files(&state.top), vec![(".env".to_string(), 9)]);

        let out = base.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let without_env = prepare(&state, false, &out).unwrap();
        assert!(without_env.commits && without_env.staged && without_env.unstaged);
        assert_eq!((without_env.files, without_env.env_files), (1, 0));
        let listing = |dir: &Path| {
            let out = Command::new(crate::procenv::resolve_command("tar"))
                .arg("-tzf")
                .arg(dir.join("files.tgz"))
                .output()
                .unwrap();
            let mut names: Vec<String> = String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(String::from)
                .collect();
            names.sort();
            names
        };
        assert_eq!(listing(&out), vec!["notes/todo.md"]);
        assert!(sh(
            &state.top,
            &[
                "bundle",
                "list-heads",
                out.join("commits.bundle").to_str().unwrap()
            ]
        )
        .contains("HEAD"));
        assert!(std::fs::read_to_string(out.join("staged.patch"))
            .unwrap()
            .contains("+staged"));
        assert!(std::fs::read_to_string(out.join("unstaged.patch"))
            .unwrap()
            .contains("+unstaged"));

        let with_env = base.join("with-env");
        std::fs::create_dir_all(&with_env).unwrap();
        let prepared = prepare(&state, true, &with_env).unwrap();
        assert_eq!(prepared.env_files, 1);
        assert_eq!(listing(&with_env), vec![".env", "notes/todo.md"]);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn credential_shaped_files_need_the_opt_in_even_when_not_ignored() {
        let base = fixture("secrets");
        let mac = base.join("mac");
        std::fs::write(mac.join(".env.local"), "TOKEN=1\n").unwrap();
        std::fs::write(mac.join("server.pem"), "key\n").unwrap();
        std::fs::write(mac.join(".env.example"), "TOKEN=\n").unwrap();
        std::fs::write(mac.join("readme.md"), "hi\n").unwrap();
        let state = inspect_repo(&mac).unwrap();
        let found = untracked_files(&state.top);
        let mut kept: Vec<_> = found.included.iter().map(|(n, _)| n.as_str()).collect();
        kept.sort();
        assert_eq!(kept, vec![".env.example", "readme.md"]);
        let mut held: Vec<_> = found.secrets.iter().map(|(n, _)| n.as_str()).collect();
        held.sort();
        assert_eq!(held, vec![".env.local", "server.pem"]);

        let listing = |dir: &Path| {
            let out = Command::new(crate::procenv::resolve_command("tar"))
                .arg("-tzf")
                .arg(dir.join("files.tgz"))
                .output()
                .unwrap();
            let mut names: Vec<String> = String::from_utf8_lossy(&out.stdout)
                .lines()
                .map(String::from)
                .collect();
            names.sort();
            names
        };
        let without = base.join("without");
        std::fs::create_dir_all(&without).unwrap();
        let prepared = prepare(&state, false, &without).unwrap();
        assert_eq!(listing(&without), vec![".env.example", "readme.md"]);
        assert_eq!(prepared.env_files, 0);
        assert!(prepared.skipped.iter().any(|s| s.contains("2 untracked files")));
        assert_eq!(
            prepared.artifacts.get("files.tgz").copied(),
            Some(std::fs::metadata(without.join("files.tgz")).unwrap().len())
        );

        let with = base.join("with");
        std::fs::create_dir_all(&with).unwrap();
        let prepared = prepare(&state, true, &with).unwrap();
        assert_eq!(prepared.env_files, 2);
        assert_eq!(
            listing(&with),
            vec![".env.example", ".env.local", "readme.md", "server.pem"]
        );
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn tokens_in_an_origin_url_are_not_shown() {
        assert_eq!(
            redact_origin("https://user:ghp_x@github.com/o/r.git"),
            "https://github.com/o/r.git"
        );
        assert_eq!(
            redact_origin("https://github.com/o/r.git"),
            "https://github.com/o/r.git"
        );
        assert_eq!(
            redact_origin("git@github.com:o/r.git"),
            "git@github.com:o/r.git"
        );
        assert_eq!(
            redact_origin("https://github.com/o/r@v2"),
            "https://github.com/o/r@v2"
        );
    }

    #[test]
    fn repositories_that_cannot_be_mirrored_say_why() {
        let base = fixture("errors");
        assert_eq!(
            inspect_repo(&base.join("missing")).unwrap_err(),
            "Saved folder no longer exists on this device"
        );
        let plain = base.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        sh(&plain, &["init"]);
        assert_eq!(
            inspect_repo(&plain).unwrap_err(),
            "No Git origin is configured"
        );
        assert!(valid_id("0b4cbd0e-7f0d-4a49-9a3c-63b8b5e6d2a1"));
        assert!(!valid_id("../../etc"));
        std::fs::remove_dir_all(base).unwrap();
    }
}

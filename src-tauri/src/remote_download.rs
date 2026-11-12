//! Save a file or folder of a remote workspace onto this computer.
//!
//! The mirror image of remote_upload.rs, and it needs no host change: it walks
//! the workspace with the read-only `fs_read_dir`/`fs_stat_many` commands and
//! copies each file with `fs_read_range`, so it works on a running workspace.
//!
//! Names come from the remote, so none of them is trusted: every path part is
//! checked before it is joined, nothing is written outside the chosen folder,
//! existing local files are kept, symbolic links are skipped, and a file is only
//! given its real name once all of it has arrived.

use crate::client_mode::{execution_remote_get, RemoteConnection, RemoteConnectionState};
use crate::remote_upload::claim_upload;
use base64::Engine;
use std::{
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncWriteExt;

const RANGE: u64 = 256 * 1024;
const MAX_FILES: usize = 20_000;
const MAX_DEPTH: usize = 32;
const MAX_REPLY: usize = 4 * 1024 * 1024;

#[derive(Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    id: String,
    destination: String,
    name: String,
    bytes: u64,
    total_bytes: u64,
    files: usize,
    total_files: usize,
    skipped: usize,
    cancelled: bool,
}

struct Item {
    /// Remote absolute path, built only from checked parts.
    remote: String,
    /// Path below the saved folder, parts joined with `/`.
    relative: String,
    directory: bool,
    size: u64,
}

/// One part of a remote path that is safe to use as a local file name.
fn safe_part(name: &str) -> Option<&str> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.len() > 255
        || name.contains(['/', '\\', '\0', ':'])
    {
        return None;
    }
    Some(name)
}

async fn call(
    client: &reqwest::Client,
    c: &RemoteConnection,
    command: &str,
    args: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut response = client
        .post(format!(
            "{}/v1/workspaces/{}/native",
            c.endpoint.trim_end_matches('/'),
            c.workspace_id
        ))
        .bearer_auth(&c.token)
        .header("content-type", "application/json")
        .body(serde_json::json!({"command":command,"args":args}).to_string())
        .send()
        .await
        .map_err(|_| "Download connection failed. Completed files were kept.")?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Download response unavailable")?
    {
        if bytes.len() + chunk.len() > MAX_REPLY {
            return Err("Invalid download response".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid download response")?;
    if !status.is_success() {
        return Err(match value.get("error").and_then(|v| v.as_str()) {
            Some("Unauthorized" | "Forbidden") => {
                "This workspace connection does not allow downloads."
            }
            _ => "Remote download failed. Completed files were kept.",
        }
        .into());
    }
    Ok(value
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}

/// Every file and folder below `root` (or just `root` when it is a file).
async fn plan(
    client: &reqwest::Client,
    c: &RemoteConnection,
    root: &str,
    base: &str,
    is_dir: bool,
    cancel: &AtomicBool,
) -> Result<(Vec<Item>, usize), String> {
    let mut items = Vec::new();
    let mut skipped = 0usize;
    if !is_dir {
        let stat = call(client, c, "fs_stat", serde_json::json!({"path":root})).await?;
        let size = stat.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
        items.push(Item {
            remote: root.to_string(),
            relative: base.to_string(),
            directory: false,
            size,
        });
        return Ok((items, skipped));
    }
    items.push(Item {
        remote: root.to_string(),
        relative: base.to_string(),
        directory: true,
        size: 0,
    });
    let mut stack = vec![(root.to_string(), base.to_string(), 1usize)];
    while let Some((dir, relative, depth)) = stack.pop() {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let entries = call(client, c, "fs_read_dir", serde_json::json!({"path":dir})).await?;
        let mut files: Vec<(String, String)> = Vec::new();
        for entry in entries.as_array().map(|a| a.as_slice()).unwrap_or(&[]) {
            let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let Some(part) = safe_part(name) else {
                skipped += 1;
                continue;
            };
            if entry
                .get("is_symlink")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                skipped += 1;
                continue;
            }
            let remote = format!("{}/{}", dir.trim_end_matches('/'), part);
            let child = format!("{relative}/{part}");
            if items.len() + files.len() >= MAX_FILES {
                return Err("This folder has too many files to download at once.".into());
            }
            if entry
                .get("is_dir")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                if depth >= MAX_DEPTH {
                    skipped += 1;
                    continue;
                }
                items.push(Item {
                    remote: remote.clone(),
                    relative: child.clone(),
                    directory: true,
                    size: 0,
                });
                stack.push((remote, child, depth + 1));
            } else {
                files.push((remote, child));
            }
        }
        for batch in files.chunks(512) {
            let stats = call(
                client,
                c,
                "fs_stat_many",
                serde_json::json!({"paths":batch.iter().map(|(r, _)| r).collect::<Vec<_>>()}),
            )
            .await
            // Sizes only feed the progress bar: one unreadable file must not
            // stop the rest, and its own read reports the real error.
            .unwrap_or(serde_json::Value::Null);
            let sizes = stats.as_array().map(|a| a.as_slice()).unwrap_or(&[]);
            for (index, (remote, child)) in batch.iter().enumerate() {
                let size = sizes
                    .get(index)
                    .and_then(|s| s.get("size"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                items.push(Item {
                    remote: remote.clone(),
                    relative: child.clone(),
                    directory: false,
                    size,
                });
            }
        }
    }
    Ok((items, skipped))
}

/// A directory below the saved folder: created if missing, never a symlink.
async fn ensure_dir(path: &Path) -> Result<(), String> {
    match tokio::fs::create_dir(path).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err("Cannot create a folder in the chosen location".into()),
    }
    let meta = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|_| "Cannot create a folder in the chosen location")?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err("A folder in the chosen location is a link or a file".into());
    }
    Ok(())
}

/// Copy one remote file to `target`, through a temporary name. Returns the bytes
/// written, or None when the file already existed and was kept.
async fn fetch_file(
    client: &reqwest::Client,
    c: &RemoteConnection,
    item: &Item,
    target: &Path,
    cancel: &AtomicBool,
    progress: &mut DownloadProgress,
    app: &tauri::AppHandle,
) -> Result<Option<()>, String> {
    if tokio::fs::symlink_metadata(target).await.is_ok() {
        return Ok(None);
    }
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("Invalid local name")?;
    let temp = target.with_file_name(format!(".{name}.canopy-part"));
    let _ = tokio::fs::remove_file(&temp).await;
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .await
        .map_err(|_| "Cannot write to the chosen location")?;
    let result: Result<(), String> = async {
        let mut offset = 0u64;
        let mut last_event = std::time::Instant::now();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            let reply = call(
                client,
                c,
                "fs_read_range",
                serde_json::json!({"path":item.remote,"offset":offset,"length":RANGE}),
            )
            .await?;
            let data = base64::engine::general_purpose::STANDARD
                .decode(reply.get("b64").and_then(|v| v.as_str()).unwrap_or(""))
                .map_err(|_| "Invalid download response")?;
            if data.is_empty() {
                break;
            }
            file.write_all(&data)
                .await
                .map_err(|_| "Cannot write to the chosen location")?;
            offset += data.len() as u64;
            progress.bytes += data.len() as u64;
            if last_event.elapsed() >= std::time::Duration::from_millis(100) {
                let _ = app.emit("remote:download-progress", &*progress);
                last_event = std::time::Instant::now();
            }
            if offset >= reply.get("size").and_then(|v| v.as_u64()).unwrap_or(0) {
                break;
            }
        }
        file.flush()
            .await
            .map_err(|_| "Cannot write to the chosen location")?;
        Ok(())
    }
    .await;
    drop(file);
    if let Err(e) = result {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(e);
    }
    if tokio::fs::symlink_metadata(target).await.is_ok() {
        let _ = tokio::fs::remove_file(&temp).await;
        return Ok(None);
    }
    tokio::fs::rename(&temp, target)
        .await
        .map_err(|_| "Cannot write to the chosen location")?;
    Ok(Some(()))
}

#[tauri::command]
pub async fn execution_remote_download(
    app: tauri::AppHandle,
    state: tauri::State<'_, RemoteConnectionState>,
    id: String,
    source: String,
    kind: String,
    workspace_id: String,
    endpoint: String,
) -> Result<DownloadProgress, String> {
    if id.is_empty() || id.len() > 64 || !matches!(kind.as_str(), "file" | "folder") {
        return Err("Invalid download selection".into());
    }
    let c = execution_remote_get(app.clone(), state)?.ok_or("Select a remote workspace first")?;
    if c.workspace_id != workspace_id
        || c.endpoint.trim_end_matches('/') != endpoint.trim_end_matches('/')
    {
        return Err("Workspace changed. Choose the download again.".into());
    }
    let claim = claim_upload(&id)?;
    let cancel = claim.cancel.clone();
    let trimmed = source.trim_end_matches('/');
    let base = safe_part(trimmed.rsplit('/').next().unwrap_or(""))
        .ok_or("This item cannot be downloaded")?
        .to_string();
    let picker = app.clone();
    let saved: Option<PathBuf> = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .set_title("Save to this computer")
            .blocking_pick_folder()
            .and_then(|p| p.into_path().ok())
    })
    .await
    .map_err(|_| "Disk chooser unavailable")?;
    let mut progress = DownloadProgress {
        id,
        destination: String::new(),
        ..Default::default()
    };
    let Some(saved) = saved else {
        progress.cancelled = true;
        return Ok(progress);
    };
    progress.destination = saved.display().to_string();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Download connection unavailable")?;
    progress.name = "Reading the workspace…".into();
    let _ = app.emit("remote:download-progress", &progress);
    let (items, skipped) = plan(&client, &c, trimmed, &base, kind == "folder", &cancel).await?;
    progress.skipped = skipped;
    progress.total_files = items.iter().filter(|i| !i.directory).count();
    progress.total_bytes = items.iter().map(|i| i.size).sum();
    for item in &items {
        if cancel.load(Ordering::Relaxed) {
            progress.cancelled = true;
            break;
        }
        let mut target = saved.clone();
        for part in item.relative.split('/') {
            target.push(safe_part(part).ok_or("Invalid name in the workspace")?);
        }
        progress.name = item.relative.clone();
        let _ = app.emit("remote:download-progress", &progress);
        if item.directory {
            ensure_dir(&target).await?;
            continue;
        }
        if let Some(parent) = target.parent() {
            ensure_dir(parent).await?;
        }
        match fetch_file(&client, &c, item, &target, &cancel, &mut progress, &app).await {
            Ok(Some(())) => progress.files += 1,
            Ok(None) => progress.skipped += 1,
            Err(e) if e == "cancelled" => {
                progress.cancelled = true;
                break;
            }
            Err(e) => return Err(e),
        }
    }
    Ok(progress)
}

#[cfg(test)]
mod tests {
    use super::safe_part;

    #[test]
    fn remote_names_cannot_leave_the_chosen_folder() {
        for bad in [
            "", ".", "..", "a/b", "a\\b", "../x", "/etc", "a\0b", "C:evil",
        ] {
            assert!(safe_part(bad).is_none(), "{bad:?} must be refused");
        }
        assert!(safe_part(&"x".repeat(256)).is_none());
        assert_eq!(safe_part("report v2.pdf"), Some("report v2.pdf"));
        assert_eq!(safe_part(".env"), Some(".env"));
    }
}

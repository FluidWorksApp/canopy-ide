use crate::client_mode::{execution_remote_get, RemoteConnection, RemoteConnectionState};
use base64::Engine;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;
use tokio::io::AsyncReadExt;

const CHUNK: usize = 256 * 1024;
static JOB: OnceLock<Mutex<Option<(String, Arc<AtomicBool>)>>> = OnceLock::new();
struct JobGuard;
impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Ok(mut job) = JOB.get().unwrap().lock() {
            *job = None;
        }
    }
}
#[derive(Clone, serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UploadProgress {
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
struct Entry {
    local: PathBuf,
    relative: String,
    directory: bool,
    size: u64,
    mode: u32,
    metadata: std::fs::Metadata,
}
struct Plan {
    entries: Vec<Entry>,
    bytes: u64,
    files: usize,
    skipped: usize,
}
fn relative_name(path: &Path, base: &Path) -> Result<String, String> {
    let value = path
        .strip_prefix(base)
        .map_err(|_| "Upload selection changed")?
        .to_str()
        .ok_or("Filename is not valid UTF-8")?;
    if value.is_empty()
        || value
            .split('/')
            .any(|s| s == ".." || s == "." || s.contains('\0'))
    {
        return Err("Invalid upload filename".into());
    }
    Ok(value.into())
}
fn same_file(expected: &std::fs::Metadata, actual: &std::fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if expected.dev() != actual.dev() || expected.ino() != actual.ino() {
            return false;
        }
    }
    expected.len() == actual.len() && expected.modified().ok() == actual.modified().ok()
}
fn plan(paths: Vec<PathBuf>, cancel: &AtomicBool) -> Result<Plan, String> {
    let mut result = Plan {
        entries: vec![],
        bytes: 0,
        files: 0,
        skipped: 0,
    };
    for selected in paths {
        let parent = selected
            .parent()
            .ok_or("Cannot upload the disk root")?
            .to_path_buf();
        let mut pending = vec![selected];
        while let Some(local) = pending.pop() {
            if cancel.load(Ordering::Relaxed) {
                return Err("Upload cancelled".into());
            }
            let meta = std::fs::symlink_metadata(&local)
                .map_err(|_| "Cannot inspect a selected local file")?;
            if meta.file_type().is_symlink() || (!meta.is_dir() && !meta.is_file()) {
                result.skipped += 1;
                continue;
            }
            if result.entries.len() >= 20000 {
                return Err("Choose a folder with at most 20,000 files and folders".into());
            }
            if meta.is_file() && meta.len() > 16 * 1024 * 1024 * 1024 {
                return Err("A selected file exceeds the 16 GiB upload limit".into());
            }
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                meta.permissions().mode() & 0o777
            };
            #[cfg(not(unix))]
            let mode = 0o600;
            let relative = relative_name(&local, &parent)?;
            result.entries.push(Entry {
                local: local.clone(),
                relative,
                directory: meta.is_dir(),
                size: meta.len(),
                mode,
                metadata: meta.clone(),
            });
            if meta.is_dir() {
                for child in std::fs::read_dir(&local)
                    .map_err(|_| "Cannot browse a selected local folder")?
                {
                    if pending.len() + result.entries.len() >= 20000 {
                        return Err("Choose a folder with at most 20,000 files and folders".into());
                    }
                    pending.push(
                        child
                            .map_err(|_| "Cannot browse a selected local folder")?
                            .path(),
                    );
                }
            } else {
                result.files += 1;
                result.bytes = result
                    .bytes
                    .checked_add(meta.len())
                    .ok_or("Upload too large")?;
            }
        }
    }
    Ok(result)
}
async fn remote(
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
        .map_err(|_| {
            "Upload connection failed. Completed files were kept; retry the remaining files."
        })?;
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Upload response unavailable")?
    {
        if bytes.len() + chunk.len() > 16384 {
            return Err("Invalid upload response".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid upload response")?;
    if !status.is_success() {
        return Err(match value.get("error").and_then(|v|v.as_str()){
            Some("File already exists; existing file was kept")=>"A file with this name already exists. Existing files were kept.",
            Some("Upload path must not be a symlink"|"Upload directory must not be a symlink")=>"Choose a remote folder without symbolic links.",
            Some("Upload integrity check failed")=>"Upload integrity check failed. The incomplete file was removed.",
            Some("Unauthorized"|"Forbidden")=>"This workspace connection does not allow uploads.",
            _=>"Remote upload failed. Completed files were kept; check the destination and free disk space.",
        }.into());
    }
    Ok(value
        .get("result")
        .cloned()
        .unwrap_or(serde_json::Value::Null))
}
#[tauri::command]
pub fn execution_remote_upload_cancel(id: String) -> Result<(), String> {
    if let Some((current, cancel)) = JOB
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Upload state unavailable")?
        .as_ref()
    {
        if current == &id {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn execution_remote_upload(
    app: tauri::AppHandle,
    state: tauri::State<'_, RemoteConnectionState>,
    id: String,
    destination: String,
    kind: String,
    workspace_id: String,
    endpoint: String,
) -> Result<UploadProgress, String> {
    if id.len() > 64 || id.is_empty() || !matches!(kind.as_str(), "files" | "folder") {
        return Err("Invalid upload selection".into());
    }
    let c = execution_remote_get(app.clone(), state)?.ok_or("Select a remote workspace first")?;
    if c.workspace_id != workspace_id
        || c.endpoint.trim_end_matches('/') != endpoint.trim_end_matches('/')
    {
        return Err("Workspace changed. Choose the upload destination again.".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut job = JOB
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| "Upload state unavailable")?;
        if job.is_some() {
            return Err("Another upload is already running".into());
        }
        *job = Some((id.clone(), cancel.clone()));
    }
    let _guard = JobGuard;
    // Only a native user selection can supply source paths. The renderer never
    // gets a general reader for arbitrary local files while execution is remote.
    let picker = app.clone();
    let paths = tauri::async_runtime::spawn_blocking(move || {
        let dialog = picker.dialog().file().set_title(if kind == "folder" {
            "Upload folder to remote workspace"
        } else {
            "Upload files to remote workspace"
        });
        let selected = if kind == "folder" {
            dialog.blocking_pick_folder().map(|p| vec![p])
        } else {
            dialog.blocking_pick_files()
        };
        selected
            .unwrap_or_default()
            .into_iter()
            .map(|p| {
                p.into_path()
                    .map_err(|_| "Local selection unavailable".to_string())
            })
            .collect::<Result<Vec<_>, _>>()
    })
    .await
    .map_err(|_| "Disk chooser unavailable")??;
    let mut progress = UploadProgress {
        id,
        destination: destination.clone(),
        ..Default::default()
    };
    if paths.is_empty() || cancel.load(Ordering::Relaxed) {
        progress.cancelled = true;
        return Ok(progress);
    }
    let cancellation = cancel.clone();
    let plan = tauri::async_runtime::spawn_blocking(move || plan(paths, &cancellation))
        .await
        .map_err(|_| "Local folder inspection failed")??;
    progress.total_bytes = plan.bytes;
    progress.total_files = plan.files;
    progress.skipped = plan.skipped;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "Upload connection unavailable")?;
    let mut buffer = vec![0u8; CHUNK];
    let mut last_event = std::time::Instant::now();
    for entry in plan.entries {
        if cancel.load(Ordering::Relaxed) {
            progress.cancelled = true;
            break;
        }
        progress.name = entry.relative.clone();
        let _ = app.emit("remote:upload-progress", &progress);
        let target = format!("{}/{}", destination.trim_end_matches('/'), entry.relative);
        if entry.directory {
            remote(
                &client,
                &c,
                "fs_upload_dir",
                serde_json::json!({"path":target}),
            )
            .await?;
            continue;
        }
        let mut options = tokio::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        options.custom_flags(libc::O_NOFOLLOW);
        let mut file = options
            .open(&entry.local)
            .await
            .map_err(|_| format!("Cannot read selected file: {}", entry.relative))?;
        let original = file
            .metadata()
            .await
            .map_err(|_| "Local file unavailable")?;
        if !original.is_file() || !same_file(&entry.metadata, &original) {
            return Err(format!(
                "Local file changed: {}. Retry upload.",
                entry.relative
            ));
        }
        let start = remote(
            &client,
            &c,
            "fs_upload_begin",
            serde_json::json!({"path":target,"size":entry.size,"mode":entry.mode}),
        )
        .await?;
        let upload_id = start
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Invalid upload response")?
            .to_string();
        let result:Result<(),String>=async{
            let mut offset=0u64;let mut hash=Sha256::new();
            loop{
                if cancel.load(Ordering::Relaxed){return Err("Upload cancelled".into());}
                let count=file.read(&mut buffer).await.map_err(|_|"Cannot read selected local file")?;if count==0{break;}
                hash.update(&buffer[..count]);
                let ack=remote(&client,&c,"fs_upload_chunk",serde_json::json!({"id":upload_id,"offset":offset,"b64":base64::engine::general_purpose::STANDARD.encode(&buffer[..count])})).await?;
                offset+=count as u64;if ack.get("written").and_then(|v|v.as_u64())!=Some(offset){return Err("Upload acknowledgement mismatch".into());}
                progress.bytes+=count as u64;
                if last_event.elapsed().as_millis()>=150{let _=app.emit("remote:upload-progress",&progress);last_event=std::time::Instant::now();}
            }
            let current=file.metadata().await.map_err(|_|"Local file unavailable")?;
            if offset!=entry.size||original.modified().ok()!=current.modified().ok(){return Err("Local file changed during upload. Retry upload.".into());}
            if cancel.load(Ordering::Relaxed){return Err("Upload cancelled".into());}
            remote(&client,&c,"fs_upload_finish",serde_json::json!({"id":upload_id,"sha256":format!("{:x}",hash.finalize())})).await?;
            Ok(())
        }.await;
        if let Err(error) = result {
            let _ = remote(
                &client,
                &c,
                "fs_upload_abort",
                serde_json::json!({"id":upload_id}),
            )
            .await;
            if cancel.load(Ordering::Relaxed) {
                progress.cancelled = true;
                break;
            }
            return Err(format!("{}: {error}", entry.relative));
        }
        progress.files += 1;
    }
    let _ = app.emit("remote:upload-progress", &progress);
    Ok(progress)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn folder_plan_keeps_dotfiles_empty_folders_and_skips_links() {
        let root = std::env::temp_dir().join(format!(
            "canopy-upload-plan-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("photos/empty")).unwrap();
        std::fs::write(root.join("photos/.env"), "synthetic").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/outside", root.join("photos/link")).unwrap();
        let p = plan(vec![root.join("photos")], &AtomicBool::new(false)).unwrap();
        let names: Vec<_> = p.entries.iter().map(|e| e.relative.as_str()).collect();
        assert!(names.contains(&"photos"));
        assert!(names.contains(&"photos/empty"));
        assert!(names.contains(&"photos/.env"));
        assert_eq!(p.files, 1);
        assert_eq!(p.bytes, 9);
        #[cfg(unix)]
        assert_eq!(p.skipped, 1);
        let before = std::fs::metadata(root.join("photos/.env")).unwrap();
        std::fs::remove_file(root.join("photos/.env")).unwrap();
        std::fs::write(root.join("photos/.env"), "replacement").unwrap();
        assert!(!same_file(
            &before,
            &std::fs::metadata(root.join("photos/.env")).unwrap()
        ));
        assert!(plan(vec![root.join("photos")], &AtomicBool::new(true)).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn relative_paths_preserve_the_selected_folder() {
        assert_eq!(
            relative_name(Path::new("/tmp/photo/pic.jpg"), Path::new("/tmp")).unwrap(),
            "photo/pic.jpg"
        );
        assert!(relative_name(Path::new("/outside/file"), Path::new("/tmp")).is_err());
    }
}

/// Stage explicitly dropped images on the selected workspace, never send Mac paths to Linux.
#[tauri::command]
pub async fn execution_remote_stage_images(
    app: tauri::AppHandle,
    state: tauri::State<'_, RemoteConnectionState>,
    workspace_id: String,
    endpoint: String,
    dir: String,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    if paths.is_empty() || paths.len() > 16 {
        return Err("Drop up to 16 images at a time".into());
    }
    let c = execution_remote_get(app, state)?.ok_or("Select a remote workspace first")?;
    if c.workspace_id != workspace_id
        || c.endpoint.trim_end_matches('/') != endpoint.trim_end_matches('/')
    {
        return Err("Workspace changed; drop the images again".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|_| "Upload unavailable")?;
    let destination = format!("{}/.canopy/attachments", dir.trim_end_matches('/'));
    let mut sources = Vec::new();
    for path in paths {
        let source = PathBuf::from(path);
        let ext = source
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"].contains(&ext.as_str()) {
            return Err("Drop an image here. Use Upload files for other file types.".into());
        }
        let meta = std::fs::symlink_metadata(&source)
            .map_err(|_| "Dropped image is no longer available")?;
        if !meta.is_file() || meta.len() > 25 * 1024 * 1024 {
            return Err("Each dropped image must be a regular file under 25 MB".into());
        }
        sources.push((source, ext, meta));
    }
    remote(
        &client,
        &c,
        "fs_upload_dir",
        serde_json::json!({"path":destination}),
    )
    .await?;
    let mut staged = Vec::new();
    for (source, ext, expected) in sources {
        let mut file = tokio::fs::File::open(&source)
            .await
            .map_err(|_| "Cannot open dropped image")?;
        let actual = file
            .metadata()
            .await
            .map_err(|_| "Cannot inspect dropped image")?;
        if !same_file(&expected, &actual) {
            return Err("Dropped image changed; try again".into());
        }
        let mut random = [0u8; 16];
        getrandom::getrandom(&mut random).map_err(|_| "Cannot create attachment name")?;
        let unique = random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let target = format!("{}/{}.{}", destination, unique, ext);
        let start = remote(
            &client,
            &c,
            "fs_upload_begin",
            serde_json::json!({"path":target,"size":expected.len(),"mode":384}),
        )
        .await?;
        let id = start
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("Invalid upload response")?
            .to_string();
        let uploaded:Result<(),String>=async {
            let mut offset=0u64;let mut hash=Sha256::new();let mut buffer=vec![0;CHUNK];
            loop {
                let count=file.read(&mut buffer).await.map_err(|_|"Cannot read dropped image")?;if count==0{break;}
                if offset+count as u64>expected.len(){return Err("Dropped image changed; try again".into());}
                hash.update(&buffer[..count]);
                let ack=remote(&client,&c,"fs_upload_chunk",serde_json::json!({"id":id,"offset":offset,"b64":base64::engine::general_purpose::STANDARD.encode(&buffer[..count])})).await?;
                offset+=count as u64;if ack.get("written").and_then(|v|v.as_u64())!=Some(offset){return Err("Upload acknowledgement mismatch".into());}
            }
            if offset!=expected.len() || !same_file(&expected,&file.metadata().await.map_err(|_|"Cannot inspect image")?){return Err("Dropped image changed; try again".into());}
            remote(&client,&c,"fs_upload_finish",serde_json::json!({"id":id,"sha256":format!("{:x}",hash.finalize())})).await?;
            Ok(())
        }.await;
        if let Err(error) = uploaded {
            let _ = remote(&client, &c, "fs_upload_abort", serde_json::json!({"id":id})).await;
            return Err(error);
        }
        staged.push(target);
    }
    Ok(staged)
}

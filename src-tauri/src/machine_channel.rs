//! The machine channel's desktop half: read and write a file a slice at a time.
//!
//! The channel (src/machines/channel.ts) moves build artifacts and git bundles
//! between this computer and the person's other machines, streamed through the
//! window. A workspace host already serves a range read and a chunked upload;
//! the desktop had neither for binary files (`fs_read_file` is bounded text
//! for the editor, `android_stage_file` writes only APKs into a temp folder).
//! Running commands needs nothing new: the channel uses `receipt_run_check`.
//!
//! Every path is `root` plus a relative `path`, and the file must still be
//! inside `root` once symbolic links are resolved. The window passes a
//! checkout's top (or its git directory, for what is staged there) as the
//! root, so a path an agent names can never read or write anything outside
//! the repository it is working in.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};

use base64::Engine;
use serde::Serialize;

/// One slice. Larger than a workspace's 1 MB so a copy from this computer to
/// itself (two checkouts) is not needlessly chatty; small enough for IPC.
const MAX_SLICE: u64 = 4 * 1024 * 1024;
/// A partly written file older than this was abandoned (the window closed
/// mid-copy); it is removed the next time something is written beside it.
const PART_KEEP_SECS: u64 = 24 * 60 * 60;
const PART_SUFFIX: &str = ".canopy-part";

#[derive(Debug, Serialize, PartialEq)]
pub struct FileSlice {
    pub b64: String,
    /// The whole file's size, so the reader knows when it is done.
    pub size: u64,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Written {
    /// Bytes the file holds so far.
    pub written: u64,
}

/// `rel` as a path that can only go down from where it starts.
fn relative(rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() || rel.contains('\0') {
        return Err("a path is needed".into());
    }
    let path = Path::new(rel);
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::Normal(name) => out.push(name),
            Component::CurDir => {}
            _ => return Err(format!("path leaves its folder: {rel}")),
        }
    }
    if out.as_os_str().is_empty() {
        return Err("a path is needed".into());
    }
    Ok(out)
}

fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let path = Path::new(root);
    if !path.is_absolute() {
        return Err(format!("not an absolute folder: {root}"));
    }
    let real = std::fs::canonicalize(path).map_err(|e| format!("{root}: {e}"))?;
    if !real.is_dir() {
        return Err(format!("not a folder: {root}"));
    }
    Ok(real)
}

/// `root/rel`, refused unless its folder is inside `root` after links are
/// resolved. With `create`, missing folders on the way are made first.
fn contained(root: &str, rel: &str, create: bool) -> Result<PathBuf, String> {
    let base = canonical_root(root)?;
    let target = base.join(relative(rel)?);
    let parent = target.parent().ok_or("a path is needed")?.to_path_buf();
    if create {
        std::fs::create_dir_all(&parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let real = std::fs::canonicalize(&parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    if !real.starts_with(&base) {
        return Err(format!("path leaves its folder: {rel}"));
    }
    let name = target.file_name().ok_or("a path is needed")?;
    Ok(real.join(name))
}

pub fn read_slice(root: &str, rel: &str, offset: u64, length: u64) -> Result<FileSlice, String> {
    let path = contained(root, rel, false)?;
    // The file itself may be a link (a build tool's "latest" pointer); what it
    // points at must be inside the root too.
    let real = std::fs::canonicalize(&path).map_err(|e| format!("{rel}: {e}"))?;
    if !real.starts_with(canonical_root(root)?) {
        return Err(format!("path leaves its folder: {rel}"));
    }
    let mut file = std::fs::File::open(&real).map_err(|e| format!("{rel}: {e}"))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err(format!("not a file: {rel}"));
    }
    let size = meta.len();
    let want = length.min(MAX_SLICE).min(size.saturating_sub(offset)) as usize;
    let mut bytes = vec![0_u8; want];
    if want > 0 {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        file.read_exact(&mut bytes)
            .map_err(|e| format!("{rel}: {e}"))?;
    }
    Ok(FileSlice {
        b64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        size,
    })
}

fn part_of(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(PART_SUFFIX);
    path.with_file_name(name)
}

/// Remove parts left beside `path` by copies that never finished.
fn sweep_parts(path: &Path) {
    let Some(dir) = path.parent() else { return };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten().take(4096) {
        let name = entry.file_name();
        if !name.to_string_lossy().ends_with(PART_SUFFIX) {
            continue;
        }
        let old = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() > PART_KEEP_SECS);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Write one slice of `root/rel`. Slices land in a part file beside the
/// destination: offset 0 starts it afresh, each later slice must begin exactly
/// where the last ended, and `done` moves the finished file into place, so the
/// destination is never seen half written. `abort` drops the part.
pub fn write_slice(
    root: &str,
    rel: &str,
    offset: u64,
    bytes: &[u8],
    done: bool,
    mode: Option<u32>,
    abort: bool,
) -> Result<Written, String> {
    if bytes.len() as u64 > MAX_SLICE {
        return Err("slice is too large".into());
    }
    let path = contained(root, rel, !abort)?;
    let part = part_of(&path);
    if abort {
        let _ = std::fs::remove_file(&part);
        return Ok(Written { written: 0 });
    }
    if path.is_dir() {
        return Err(format!("{rel} is a folder"));
    }
    if offset == 0 {
        sweep_parts(&path);
        let _ = std::fs::remove_file(&part);
        std::fs::File::create(&part).map_err(|e| format!("{rel}: {e}"))?;
    }
    // Never follow a link someone put where the part goes.
    let meta = std::fs::symlink_metadata(&part).map_err(|e| format!("{rel}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{rel}: copy target is not a plain file"));
    }
    if meta.len() != offset {
        return Err(format!(
            "copying {rel} lost its place (have {} bytes, slice starts at {offset})",
            meta.len()
        ));
    }
    if !bytes.is_empty() {
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&part)
            .map_err(|e| format!("{rel}: {e}"))?;
        file.write_all(bytes).map_err(|e| format!("{rel}: {e}"))?;
    }
    let written = offset + bytes.len() as u64;
    if done {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let bits = mode.unwrap_or(0o644) & 0o777;
            std::fs::set_permissions(&part, std::fs::Permissions::from_mode(bits))
                .map_err(|e| format!("{rel}: {e}"))?;
        }
        #[cfg(not(unix))]
        let _ = mode;
        std::fs::rename(&part, &path).map_err(|e| format!("{rel}: {e}"))?;
    }
    Ok(Written { written })
}

/// Bytes `offset .. offset+length` of `root/path`, and the file's size.
#[tauri::command]
pub async fn machine_file_read(
    root: String,
    path: String,
    offset: Option<u64>,
    length: Option<u64>,
) -> Result<FileSlice, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_slice(
            &root,
            &path,
            offset.unwrap_or(0),
            length.unwrap_or(MAX_SLICE),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One slice of `root/path` (see `write_slice`).
#[tauri::command]
pub async fn machine_file_write(
    root: String,
    path: String,
    offset: u64,
    b64: String,
    done: bool,
    mode: Option<u32>,
    abort: Option<bool>,
) -> Result<Written, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64.as_bytes())
            .map_err(|e| format!("invalid slice: {e}"))?;
        write_slice(
            &root,
            &path,
            offset,
            &bytes,
            done,
            mode,
            abort.unwrap_or(false),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "canopy-machine-channel-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::canonicalize(dir).unwrap()
    }

    fn decode(slice: &FileSlice) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode(slice.b64.as_bytes())
            .unwrap()
    }

    #[test]
    fn reads_a_file_in_slices_and_reports_its_size() {
        let dir = temp("read");
        let data: Vec<u8> = (0..10_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::create_dir_all(dir.join("build")).unwrap();
        std::fs::write(dir.join("build/out.bin"), &data).unwrap();
        let root = dir.to_string_lossy().to_string();

        let probe = read_slice(&root, "build/out.bin", 0, 0).unwrap();
        assert_eq!((probe.b64.as_str(), probe.size), ("", 10_000));
        let mut got = Vec::new();
        let mut offset = 0;
        while offset < probe.size {
            let slice = read_slice(&root, "build/out.bin", offset, 4096).unwrap();
            let bytes = decode(&slice);
            assert!(!bytes.is_empty());
            offset += bytes.len() as u64;
            got.extend(bytes);
        }
        assert_eq!(got, data);
        // Past the end is an empty slice, not an error.
        assert_eq!(
            read_slice(&root, "build/out.bin", 20_000, 10).unwrap().b64,
            ""
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn writes_in_slices_and_only_shows_the_finished_file() {
        let dir = temp("write");
        let root = dir.to_string_lossy().to_string();
        std::fs::create_dir_all(dir.join("out")).unwrap();
        std::fs::write(dir.join("out/app.bin"), b"previous build").unwrap();

        assert_eq!(
            write_slice(&root, "out/app.bin", 0, b"hello ", false, None, false)
                .unwrap()
                .written,
            6
        );
        // The old file is still what a reader sees.
        assert_eq!(
            std::fs::read(dir.join("out/app.bin")).unwrap(),
            b"previous build"
        );
        assert_eq!(
            write_slice(&root, "out/app.bin", 6, b"world", false, None, false)
                .unwrap()
                .written,
            11
        );
        assert_eq!(
            write_slice(&root, "out/app.bin", 11, b"", true, Some(0o755), false)
                .unwrap()
                .written,
            11
        );
        assert_eq!(
            std::fs::read(dir.join("out/app.bin")).unwrap(),
            b"hello world"
        );
        assert!(!dir.join("out/app.bin.canopy-part").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join("out/app.bin"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn makes_missing_folders_and_writes_an_empty_file() {
        let dir = temp("mkdir");
        let root = dir.to_string_lossy().to_string();
        write_slice(&root, "a/b/c/empty", 0, b"", true, None, false).unwrap();
        assert_eq!(std::fs::read(dir.join("a/b/c/empty")).unwrap(), b"");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_slice_out_of_order_is_refused_and_a_restart_begins_again() {
        let dir = temp("order");
        let root = dir.to_string_lossy().to_string();
        write_slice(&root, "f", 0, b"abc", false, None, false).unwrap();
        let err = write_slice(&root, "f", 5, b"zz", false, None, false).unwrap_err();
        assert!(err.contains("lost its place"), "{err}");
        // Starting over from 0 discards the partial copy.
        write_slice(&root, "f", 0, b"xy", false, None, false).unwrap();
        write_slice(&root, "f", 2, b"", true, None, false).unwrap();
        assert_eq!(std::fs::read(dir.join("f")).unwrap(), b"xy");
        // An abort leaves no part and no file.
        write_slice(&root, "g", 0, b"abc", false, None, false).unwrap();
        write_slice(&root, "g", 0, b"", false, None, true).unwrap();
        assert!(!dir.join("g").exists() && !dir.join("g.canopy-part").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn nothing_outside_the_root_is_read_or_written() {
        let dir = temp("scope");
        let root_dir = dir.join("repo");
        std::fs::create_dir_all(&root_dir).unwrap();
        std::fs::write(dir.join("secret"), b"outside").unwrap();
        let root = root_dir.to_string_lossy().to_string();

        for bad in ["../secret", "/etc/hosts", "a/../../secret", ""] {
            assert!(read_slice(&root, bad, 0, 10).is_err(), "{bad}");
            assert!(
                write_slice(&root, bad, 0, b"x", true, None, false).is_err(),
                "{bad}"
            );
        }
        assert_eq!(std::fs::read(dir.join("secret")).unwrap(), b"outside");
        assert!(read_slice("relative/root", "x", 0, 1).is_err());

        #[cfg(unix)]
        {
            // A link inside the repository that points out of it.
            std::os::unix::fs::symlink(&dir, root_dir.join("up")).unwrap();
            std::os::unix::fs::symlink(dir.join("secret"), root_dir.join("link")).unwrap();
            assert!(read_slice(&root, "up/secret", 0, 10).is_err());
            assert!(read_slice(&root, "link", 0, 10).is_err());
            assert!(write_slice(&root, "up/planted", 0, b"x", true, None, false).is_err());
            assert!(!dir.join("planted").exists());
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_folder_is_neither_read_nor_replaced() {
        let dir = temp("folder");
        let root = dir.to_string_lossy().to_string();
        std::fs::create_dir_all(dir.join("build")).unwrap();
        assert!(read_slice(&root, "build", 0, 10).is_err());
        assert!(write_slice(&root, "build", 0, b"x", true, None, false).is_err());
        assert!(dir.join("build").is_dir());
        let _ = std::fs::remove_dir_all(dir);
    }
}

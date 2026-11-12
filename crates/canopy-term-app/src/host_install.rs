//! Where the host binary this program starts runs from. Canopy Terminal ships
//! `canopy-pty-host` beside its own executable, but a host must never run from
//! there: the app may be in Downloads, on a read-only or translocated mount, or
//! be replaced by an update while the host keeps running. So the bytes beside
//! this program are installed once into
//! `<socket dir>/term-app-bin/<app version>-<digest>/canopy-pty-host` (per user,
//! mode 0700) and the host is started from that copy.
//!
//! It is a different directory from the Canopy IDE's own `bin/`, whose pruning
//! deletes every directory of that shape it does not use: neither program ever
//! deletes the other's copy. Both name their directory `<version>-<digest>`, so
//! the version that started a host can be read from its path (see `skew`).
//!
//! The copy is written beside its final name and renamed into place, never
//! rewritten in place (macOS kills a signed process whose file changes), from
//! bytes read here, so it carries no quarantine attribute from a download. The
//! code signature is inside the Mach-O and travels with the bytes. The result
//! is read back and compared byte for byte before use.

use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use crate::skew::{dir_name, version_of_dir, DIGEST_LEN, HOST_BIN};

/// Next to the socket, away from the IDE's `bin/`.
pub const DIR: &str = "term-app-bin";

/// FNV-1a, 64 bit, as 16 hex digits. Only names a build (two builds that share
/// a version get different directories); integrity is the byte comparison.
pub fn digest_hex(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    let s = format!("{h:016x}");
    debug_assert_eq!(s.len(), DIGEST_LEN);
    s
}

/// `<socket dir>/term-app-bin`.
pub fn bin_dir(socket: &Path) -> Option<PathBuf> {
    Some(socket.parent()?.join(DIR))
}

fn private_dir(path: &Path) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    // A symlink or file in its place would run a program from elsewhere.
    let meta = fs::symlink_metadata(path)?;
    if !meta.is_dir() {
        return Err(io::Error::other(format!(
            "{} is not a plain directory",
            path.display()
        )));
    }
    if meta.permissions().mode() & 0o022 != 0 {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Installs the host found at `source` for `version` under `bin`, and returns
/// the path to start it from. Reuses a copy that is already there and
/// identical.
pub fn install(source: &Path, version: &str, bin: &Path) -> io::Result<PathBuf> {
    let bytes = fs::read(source)
        .map_err(|e| io::Error::new(e.kind(), format!("cannot read {}: {e}", source.display())))?;
    if bytes.is_empty() {
        return Err(io::Error::other(format!("{} is empty", source.display())));
    }
    private_dir(bin)?;
    let dir = bin.join(dir_name(version, &digest_hex(&bytes)));
    let dest = dir.join(HOST_BIN);
    if fs::read(&dest).is_ok_and(|have| have == bytes) {
        return Ok(dest);
    }
    private_dir(&dir)?;
    let tmp = dir.join(format!(".{HOST_BIN}.{}.tmp", std::process::id()));
    let _ = fs::remove_file(&tmp);
    let written = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&tmp)?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        drop(f);
        if fs::read(&tmp)? != bytes {
            return Err(io::Error::other(
                "the installed host copy did not read back",
            ));
        }
        fs::rename(&tmp, &dest)
    })();
    if let Err(e) = written {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(dest)
}

/// Directories under `bin` to delete: ours by shape, neither `current` nor the
/// one a running host was started from (`live`). Nothing when it is not known
/// whether a host is running (`live_known` false).
pub fn plan_prune(
    entries: &[String],
    current: &str,
    live: Option<&str>,
    live_known: bool,
) -> Vec<String> {
    if !live_known {
        return Vec::new();
    }
    let mut doomed: Vec<String> = entries
        .iter()
        .filter(|n| {
            version_of_dir(n).is_some() && n.as_str() != current && Some(n.as_str()) != live
        })
        .cloned()
        .collect();
    doomed.sort();
    doomed
}

/// Best effort: removes what `plan_prune` says.
pub fn prune(bin: &Path, installed: &Path, live_exe: Option<&str>, live_known: bool) {
    let Some(current) = installed
        .parent()
        .and_then(Path::file_name)
        .and_then(|n| n.to_str())
    else {
        return;
    };
    let live = live_exe
        .map(Path::new)
        .filter(|p| p.file_name().is_some_and(|n| n == HOST_BIN))
        .and_then(Path::parent)
        .and_then(Path::file_name)
        .and_then(|n| n.to_str());
    let Ok(read) = fs::read_dir(bin) else {
        return;
    };
    let entries: Vec<String> = read
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    for name in plan_prune(&entries, current, live, live_known) {
        let _ = fs::remove_dir_all(bin.join(name));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn scratch() -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "cta-install-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn installs_a_copy_named_by_version_and_content() {
        let root = scratch();
        let src = root.join("canopy-pty-host");
        fs::write(&src, b"host bytes").unwrap();
        let bin = root.join("sock-dir").join(DIR);
        let dest = install(&src, "0.5.15", &bin).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"host bytes");
        assert!(dest.starts_with(&bin));
        let dir_name = dest
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap();
        assert_eq!(version_of_dir(dir_name), Some("0.5.15"));
        assert_eq!(
            fs::metadata(&dest).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert_eq!(
            fs::metadata(&bin).unwrap().permissions().mode() & 0o777,
            0o700
        );
        // The skew check reads the version back out of the path it installed.
        assert_eq!(
            crate::skew::host_app_version(dest.to_str().unwrap()).as_deref(),
            Some("0.5.15")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn an_identical_copy_is_reused_and_a_changed_host_gets_a_new_directory() {
        let root = scratch();
        let src = root.join("canopy-pty-host");
        fs::write(&src, b"one").unwrap();
        let bin = root.join(DIR);
        let first = install(&src, "0.5.15", &bin).unwrap();
        let inode = fs::metadata(&first).unwrap().ino();
        assert_eq!(install(&src, "0.5.15", &bin).unwrap(), first);
        assert_eq!(
            fs::metadata(&first).unwrap().ino(),
            inode,
            "rewritten in place"
        );
        fs::write(&src, b"two").unwrap();
        let second = install(&src, "0.5.15", &bin).unwrap();
        assert_ne!(second, first);
        assert_eq!(
            fs::read(&first).unwrap(),
            b"one",
            "the old copy is left for its host"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_damaged_copy_is_replaced_by_rename() {
        let root = scratch();
        let src = root.join("canopy-pty-host");
        fs::write(&src, b"good").unwrap();
        let bin = root.join(DIR);
        let dest = install(&src, "1.0.0", &bin).unwrap();
        fs::write(&dest, b"bad!").unwrap();
        assert_eq!(install(&src, "1.0.0", &bin).unwrap(), dest);
        assert_eq!(fs::read(&dest).unwrap(), b"good");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_missing_or_empty_source_is_an_error_naming_it() {
        let root = scratch();
        let bin = root.join(DIR);
        let gone = root.join("nope");
        let err = install(&gone, "1", &bin).unwrap_err();
        assert!(err.to_string().contains("nope"), "{err}");
        let empty = root.join("empty");
        fs::write(&empty, b"").unwrap();
        assert!(install(&empty, "1", &bin)
            .unwrap_err()
            .to_string()
            .contains("empty"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn prune_keeps_the_current_and_the_live_directory_and_foreign_names() {
        let entries: Vec<String> = [
            "0.5.14-aaaaaaaaaaaaaaaa",
            "0.5.15-bbbbbbbbbbbbbbbb",
            "0.5.16-cccccccccccccccc",
            "not-ours",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            plan_prune(
                &entries,
                "0.5.16-cccccccccccccccc",
                Some("0.5.15-bbbbbbbbbbbbbbbb"),
                true
            ),
            vec!["0.5.14-aaaaaaaaaaaaaaaa".to_string()]
        );
        assert!(plan_prune(&entries, "0.5.16-cccccccccccccccc", None, false).is_empty());
    }
}

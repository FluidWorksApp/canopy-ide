//! Where the host binary runs from. The app bundle ships `canopy-pty-host` next
//! to the app binary, but a host must never run from there: an update replaces
//! the bundle while the host keeps running, a translocated or AppImage bundle is
//! a mount that goes away when the app quits, and a later launch must never try
//! to exec a path the update removed. So the bundled bytes are installed into
//! `<socket dir>/bin/<app version>-<sha256 prefix>/canopy-pty-host` (per user,
//! mode 0700, beside the socket) and the host is started from that copy.
//!
//! Invariants:
//! - A file under `bin/` is only ever created whole beside its final name and
//!   renamed into place, never rewritten in place. macOS kills a signed process
//!   whose executable file is modified, and a rename leaves a running host on
//!   its old inode.
//! - The copy is written from the bytes read and hashed here, not with a file
//!   copy, so it carries no extended attributes (no quarantine flag from a
//!   downloaded app). The code signature is inside the Mach-O and travels with
//!   the bytes. The copy is read back and must hash the same before it is used.
//! - Older directories are kept while the host they started is alive (the host
//!   reports its own path in `hello`) or while any app holds their lock, and
//!   pruned on a later launch. When it is not certain which directory is live,
//!   nothing is pruned.
//! - Every directory here must be a real directory owned by this user.
//! - The copy is hashed again right before each start (`verify`), since it is
//!   executed long after it was installed.

use canopy_pty_host::protocol::Response;
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};

pub(super) const HOST_BIN: &str = "canopy-pty-host";

/// In `bin/`: held exclusively by one install or one prune at a time.
const BIN_LOCK: &str = ".lock";
/// In `bin/`: the last bundle's identity and hash.
const CACHE: &str = ".bundled-cache";
/// In each install dir: held shared by every app that uses it.
pub(super) const DIR_LOCK: &str = ".lock";

/// Hex digits of the content hash in a directory name.
const DIGEST_LEN: usize = 16;

/// `<socket dir>/bin`.
pub(super) fn bin_dir(socket: &Path) -> Option<PathBuf> {
    Some(socket.parent()?.join("bin"))
}

fn version_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '_' | '-')
}

/// `<version>-<first 16 hex digits of the sha256>`. The hash keeps two builds
/// that share a version (dev builds, a re-cut release) apart; any character a
/// version should not have becomes `_`.
pub(super) fn dir_name(version: &str, digest_hex: &str) -> String {
    let version: String = version
        .chars()
        .map(|c| if version_char(c) { c } else { '_' })
        .collect();
    let version = if version.is_empty() {
        "0".to_string()
    } else {
        version
    };
    let digest: String = digest_hex.chars().take(DIGEST_LEN).collect();
    format!("{version}-{digest}")
}

/// Whether `name` has the shape `dir_name` produces, so pruning never touches
/// anything it did not create.
pub(super) fn is_install_dir(name: &str) -> bool {
    let Some((version, digest)) = name.rsplit_once('-') else {
        return false;
    };
    !version.is_empty()
        && version.chars().all(version_char)
        && digest.len() == DIGEST_LEN
        && digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The install directory a host executable lives in, by name: the leaf dir of
/// `.../<name>/canopy-pty-host` when `<name>` is one of ours. Matching by name,
/// not by comparing full paths, means a symlinked home or a resolved
/// `current_exe` can never make the live directory look foreign; the worst a
/// coincidental name can do is keep one directory longer.
pub(super) fn install_dir_of(exe: &Path) -> Option<String> {
    if exe.file_name()? != HOST_BIN {
        return None;
    }
    let name = exe.parent()?.file_name()?.to_str()?;
    is_install_dir(name).then(|| name.to_owned())
}

/// What is known about the directory the running host was started from.
#[derive(Debug, PartialEq)]
pub(super) enum Liveness {
    /// Certain: `Some(dir)` is in use, `None` means no install dir is in use
    /// (no host, or one started from elsewhere or by an older app).
    Known(Option<String>),
    /// A host may be running from any of them: prune nothing.
    Unknown,
}

/// Reads liveness from a `hello` answer. Only "no socket" and "nobody
/// listening" prove there is no host; any other failure is unknown.
pub(super) fn liveness(hello: &std::io::Result<Response>) -> Liveness {
    match hello {
        Ok(reply) => Liveness::Known(
            reply
                .exe
                .as_deref()
                .and_then(|exe| install_dir_of(Path::new(exe))),
        ),
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) =>
        {
            Liveness::Known(None)
        }
        Err(_) => Liveness::Unknown,
    }
}

/// The directories to delete: ours, and neither the current one nor the live
/// one. None at all when liveness is unknown.
pub(super) fn plan_prune(entries: &[String], current: &str, live: &Liveness) -> Vec<String> {
    let live = match live {
        Liveness::Known(live) => live.as_deref(),
        Liveness::Unknown => return Vec::new(),
    };
    let mut doomed: Vec<String> = entries
        .iter()
        .filter(|name| {
            is_install_dir(name) && name.as_str() != current && Some(name.as_str()) != live
        })
        .cloned()
        .collect();
    doomed.sort();
    doomed
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn hashes_to(path: &Path, digest: &str) -> bool {
    std::fs::read(path).is_ok_and(|bytes| sha256_hex(&bytes) == digest)
}

/// Run right before the host is started from `exe` (first start and every
/// restart): the copy must still hash to what was installed, because it is
/// executed long after `install` checked it.
pub(super) fn verify(exe: &Path, digest: &str) -> std::io::Result<()> {
    if hashes_to(exe, digest) {
        Ok(())
    } else {
        Err(std::io::Error::other(format!(
            "{} no longer matches the installed PTY host",
            exe.display()
        )))
    }
}

/// Create `dir` if needed and make it 0700. Refused if it is a symlink or
/// belongs to another user (checked before the chmod, which follows
/// symlinks), since then its mode says nothing about who can replace the
/// binary inside. The same rule as the context bridge's socket directory.
fn private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let meta = std::fs::symlink_metadata(dir)?;
    if !meta.file_type().is_dir() {
        return Err(std::io::Error::other(format!(
            "{} is not a directory",
            dir.display()
        )));
    }
    // SAFETY: geteuid has no preconditions and cannot fail.
    if meta.uid() != unsafe { libc::geteuid() } {
        return Err(std::io::Error::other(format!(
            "{} belongs to another user",
            dir.display()
        )));
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

fn flock(file: &File, op: libc::c_int) -> std::io::Result<()> {
    // SAFETY: flock on a descriptor we own; released when `file` is closed.
    if unsafe { libc::flock(file.as_raw_fd(), op) } == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// `<bin>/.lock`, held exclusively for the length of one install or one
/// prune, so a directory is never claimed while a pruner is deciding to
/// delete it.
fn lock_bin(bin: &Path) -> std::io::Result<File> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(bin.join(BIN_LOCK))?;
    flock(&file, libc::LOCK_EX)?;
    Ok(file)
}

/// Creates the install dir for `name` and takes a shared lock on its `.lock`.
/// Every app using that copy holds it for its whole run, so a prune by
/// another app (debug builds in several worktrees share `pty-host-dev`)
/// never deletes it. Call with the bin lock held.
fn claim(bin: &Path, name: &str) -> std::io::Result<(PathBuf, File)> {
    let dir = bin.join(name);
    private_dir(&dir)?;
    let hold = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(DIR_LOCK))?;
    flock(&hold, libc::LOCK_SH)?;
    Ok((dir, hold))
}

/// Whether no app holds `dir`. A missing lock file means it was never
/// claimed (an older build); anything but a clean acquire means keep it.
fn unclaimed(dir: &Path) -> bool {
    match File::open(dir.join(DIR_LOCK)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
        Err(_) => false,
        Ok(file) => flock(&file, libc::LOCK_EX | libc::LOCK_NB).is_ok(),
    }
}

/// The bundled file's identity, so an unchanged bundle is not re-read and
/// re-hashed on every launch. An update writes a new file: a new inode and
/// mtime at least.
#[derive(Debug, PartialEq)]
struct BundleKey {
    len: u64,
    mtime: i64,
    mtime_nsec: i64,
    ino: u64,
    dev: u64,
    path: String,
}

impl BundleKey {
    fn of(path: &Path, meta: &std::fs::Metadata) -> Self {
        BundleKey {
            len: meta.len(),
            mtime: meta.mtime(),
            mtime_nsec: meta.mtime_nsec(),
            ino: meta.ino(),
            dev: meta.dev(),
            path: path.to_string_lossy().into_owned(),
        }
    }
}

/// One line: `len mtime mtime_nsec ino dev sha256 path`.
fn cache_line(key: &BundleKey, digest: &str) -> String {
    format!(
        "{} {} {} {} {} {digest} {}",
        key.len, key.mtime, key.mtime_nsec, key.ino, key.dev, key.path
    )
}

/// The digest the cache holds for `key`; anything unparseable is a miss.
fn cached_digest(line: &str, key: &BundleKey) -> Option<String> {
    let mut parts = line.trim_end_matches('\n').splitn(7, ' ');
    let mut next = || parts.next();
    let found = BundleKey {
        len: next()?.parse().ok()?,
        mtime: next()?.parse().ok()?,
        mtime_nsec: next()?.parse().ok()?,
        ino: next()?.parse().ok()?,
        dev: next()?.parse().ok()?,
        path: String::new(),
    };
    let digest = next()?.to_string();
    let path = next()?.to_string();
    let found = BundleKey { path, ..found };
    let hex = digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit());
    (found == *key && hex).then_some(digest)
}

/// Best effort, through a temporary file and a rename.
fn write_cache(bin: &Path, key: &BundleKey, digest: &str) {
    let tmp = bin.join(format!("{CACHE}.tmp-{}", std::process::id()));
    if std::fs::write(&tmp, cache_line(key, digest)).is_ok() {
        if std::fs::rename(&tmp, bin.join(CACHE)).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
    }
}

/// The installed host: the path to start it from, the hash it must have, and
/// the shared lock that keeps its directory from being pruned (hold it for as
/// long as the app runs).
#[derive(Debug)]
pub(super) struct Installed {
    pub exe: PathBuf,
    pub digest: String,
    pub hold: File,
}

/// Installs `bundled` under `bin` for `version`. An existing copy with the
/// right hash is reused as is; a missing or damaged one is replaced through a
/// temporary file and a rename. An unchanged bundle (same size, mtime, inode)
/// is not re-read: its hash comes from a cache, but the installed copy is
/// always hashed. An empty bundled file (CI builds stage a zero-byte
/// placeholder) is refused before anything is created.
pub(super) fn install(bundled: &Path, bin: &Path, version: &str) -> Result<Installed, String> {
    let meta = std::fs::metadata(bundled)
        .map_err(|e| format!("reading bundled host {}: {e}", bundled.display()))?;
    if meta.len() == 0 {
        return Err(format!("bundled host {} is empty", bundled.display()));
    }
    let io = |e: std::io::Error| e.to_string();
    // The socket directory is the host's own and must stay private; the host
    // and the launcher chmod it too, but this runs before either.
    if let Some(parent) = bin.parent() {
        private_dir(parent).map_err(io)?;
    }
    private_dir(bin).map_err(io)?;
    let _bin_lock = lock_bin(bin).map_err(io)?;
    let key = BundleKey::of(bundled, &meta);

    let cached = std::fs::read_to_string(bin.join(CACHE))
        .ok()
        .and_then(|line| cached_digest(&line, &key));
    if let Some(digest) = cached {
        let (dir, hold) = claim(bin, &dir_name(version, &digest)).map_err(io)?;
        let exe = dir.join(HOST_BIN);
        if hashes_to(&exe, &digest) {
            return Ok(Installed { exe, digest, hold });
        }
        // Missing or damaged: install it again from the bundle below.
    }

    let bytes = std::fs::read(bundled)
        .map_err(|e| format!("reading bundled host {}: {e}", bundled.display()))?;
    if bytes.is_empty() {
        return Err(format!("bundled host {} is empty", bundled.display()));
    }
    let digest = sha256_hex(&bytes);
    write_cache(bin, &key, &digest);
    let (dir, hold) = claim(bin, &dir_name(version, &digest)).map_err(io)?;
    let exe = dir.join(HOST_BIN);
    if hashes_to(&exe, &digest) {
        return Ok(Installed { exe, digest, hold });
    }
    let tmp = dir.join(format!(".{HOST_BIN}.tmp-{}", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        // `mode` above is masked by the umask; this is not.
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("writing {}: {e}", tmp.display()));
    }
    if !hashes_to(&tmp, &digest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("{} did not read back intact", tmp.display()));
    }
    std::fs::rename(&tmp, &exe).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("installing {}: {e}", exe.display())
    })?;
    Ok(Installed { exe, digest, hold })
}

/// Deletes stale install directories under `bin`: ours by name, neither the
/// current nor the live host's, and claimed by no running app. Only real
/// directories are considered (a symlink is never followed into), and
/// failures are ignored: pruning is housekeeping.
pub(super) fn prune(bin: &Path, current: &str, live: &Liveness) {
    let Ok(_bin_lock) = lock_bin(bin) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(bin) else {
        return;
    };
    let names: Vec<String> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect();
    for name in plan_prune(&names, current, live) {
        let dir = bin.join(name);
        if unclaimed(&dir) {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::MetadataExt;

    const D: &str = "0123456789abcdef0123456789abcdef";

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cphi{}{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_dir_name_is_the_version_and_a_hash_prefix() {
        assert_eq!(dir_name("0.5.15", D), "0.5.15-0123456789abcdef");
        assert_eq!(dir_name("1.0.0-beta.1", D), "1.0.0-beta.1-0123456789abcdef");
        // Nothing that could leave the bin directory.
        assert_eq!(dir_name("../x", D), ".._x-0123456789abcdef");
        assert_eq!(dir_name("", D), "0-0123456789abcdef");
        for name in [dir_name("0.5.15", D), dir_name("1.0.0-beta.1", D)] {
            assert!(is_install_dir(&name), "{name}");
        }
    }

    #[test]
    fn only_names_of_that_shape_are_ours() {
        for foreign in [
            "",
            "host.sock",
            "0.5.15",
            "0.5.15-0123456789ABCDEF", // upper case is not what we write
            "0.5.15-0123456789abcde",  // short
            "-0123456789abcdef",
            "a/b-0123456789abcdef",
            ".canopy-pty-host.tmp-1",
        ] {
            assert!(!is_install_dir(foreign), "{foreign:?}");
        }
    }

    #[test]
    fn the_live_dir_is_read_from_the_hosts_exe_by_name() {
        let exe = Path::new("/home/u/.canopy/pty-host/bin/0.5.15-0123456789abcdef/canopy-pty-host");
        assert_eq!(
            install_dir_of(exe).as_deref(),
            Some("0.5.15-0123456789abcdef")
        );
        // A resolved or symlinked home does not change the answer.
        let resolved = Path::new(
            "/private/var/u/.canopy/pty-host/bin/0.5.15-0123456789abcdef/canopy-pty-host",
        );
        assert_eq!(
            install_dir_of(resolved).as_deref(),
            Some("0.5.15-0123456789abcdef")
        );
        // Started from the bundle or from CANOPY_PTY_HOST_EXE: no install dir.
        assert_eq!(
            install_dir_of(Path::new(
                "/Applications/Canopy.app/Contents/MacOS/canopy-pty-host"
            )),
            None
        );
        assert_eq!(
            install_dir_of(Path::new("/tmp/0.5.15-0123456789abcdef/other-binary")),
            None
        );
    }

    #[test]
    fn liveness_is_certain_only_from_an_answer_or_no_host_at_all() {
        let answered = |exe: Option<&str>| -> std::io::Result<Response> {
            Ok(Response {
                ok: true,
                exe: exe.map(str::to_owned),
                ..Default::default()
            })
        };
        assert_eq!(
            liveness(&answered(Some(
                "/x/bin/0.5.14-0123456789abcdef/canopy-pty-host"
            ))),
            Liveness::Known(Some("0.5.14-0123456789abcdef".into()))
        );
        // An older host does not say: it was not started from an install dir.
        assert_eq!(liveness(&answered(None)), Liveness::Known(None));
        let err = |kind: std::io::ErrorKind| -> std::io::Result<Response> {
            Err(std::io::Error::from(kind))
        };
        assert_eq!(
            liveness(&err(std::io::ErrorKind::NotFound)),
            Liveness::Known(None)
        );
        assert_eq!(
            liveness(&err(std::io::ErrorKind::ConnectionRefused)),
            Liveness::Known(None)
        );
        for kind in [
            std::io::ErrorKind::TimedOut,
            std::io::ErrorKind::WouldBlock,
            std::io::ErrorKind::ConnectionReset,
            std::io::ErrorKind::Other,
        ] {
            assert_eq!(liveness(&err(kind)), Liveness::Unknown, "{kind:?}");
        }
    }

    #[test]
    fn pruning_keeps_the_current_and_the_live_dir_and_nothing_foreign_is_touched() {
        let names: Vec<String> = [
            "0.5.13-aaaaaaaaaaaaaaaa",
            "0.5.14-bbbbbbbbbbbbbbbb",
            "0.5.15-cccccccccccccccc",
            "0.5.15-dddddddddddddddd",
            "notes",
        ]
        .map(String::from)
        .to_vec();
        let current = "0.5.15-cccccccccccccccc";
        let live = Liveness::Known(Some("0.5.14-bbbbbbbbbbbbbbbb".into()));
        assert_eq!(
            plan_prune(&names, current, &live),
            vec!["0.5.13-aaaaaaaaaaaaaaaa", "0.5.15-dddddddddddddddd"]
        );
        assert_eq!(
            plan_prune(&names, current, &Liveness::Known(None)),
            vec![
                "0.5.13-aaaaaaaaaaaaaaaa",
                "0.5.14-bbbbbbbbbbbbbbbb",
                "0.5.15-dddddddddddddddd"
            ]
        );
        assert!(plan_prune(&names, current, &Liveness::Unknown).is_empty());
    }

    #[test]
    fn install_writes_a_private_verified_executable_copy_and_reuses_it() {
        let root = scratch("inst");
        let bundled = root.join("bundled");
        std::fs::write(&bundled, b"#!/bin/sh\necho host\n").unwrap();
        let bin = root.join("pty-host").join("bin");
        let first_install = install(&bundled, &bin, "0.5.15").unwrap();
        let first = first_install.exe.clone();
        assert_eq!(
            std::fs::read(&first).unwrap(),
            std::fs::read(&bundled).unwrap()
        );
        assert_eq!(first.file_name().unwrap(), HOST_BIN);
        assert_eq!(first.parent().unwrap().parent().unwrap(), bin);
        assert!(is_install_dir(
            first
                .parent()
                .unwrap()
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
        ));
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&first), 0o755);
        assert_eq!(mode(&bin), 0o700);
        assert_eq!(mode(first.parent().unwrap()), 0o700);
        assert_eq!(mode(bin.parent().unwrap()), 0o700);
        // No temporary file is left beside it.
        let leftovers: Vec<_> = std::fs::read_dir(first.parent().unwrap())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        let mut leftovers = leftovers;
        leftovers.sort();
        assert_eq!(
            leftovers,
            vec![
                std::ffi::OsString::from(DIR_LOCK),
                std::ffi::OsString::from(HOST_BIN)
            ]
        );
        assert!(verify(&first, &first_install.digest).is_ok());

        // Same bytes: the same file, untouched (a running host keeps its inode).
        let inode = std::fs::metadata(&first).unwrap().ino();
        let again = install(&bundled, &bin, "0.5.15").unwrap().exe;
        assert_eq!(again, first);
        assert_eq!(std::fs::metadata(&again).unwrap().ino(), inode);

        // New bytes (an update): a new directory, the old one left alone.
        std::fs::write(&bundled, b"#!/bin/sh\necho newer host\n").unwrap();
        let updated = install(&bundled, &bin, "0.5.16").unwrap().exe;
        assert_ne!(updated.parent(), first.parent());
        assert!(first.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_damaged_copy_is_replaced_by_rename_not_rewritten_in_place() {
        let root = scratch("dmg");
        let bundled = root.join("bundled");
        std::fs::write(&bundled, b"the real host").unwrap();
        let bin = root.join("bin");
        let target = install(&bundled, &bin, "1.0.0").unwrap().exe;
        let old_inode = std::fs::metadata(&target).unwrap().ino();
        // Hard-link the old inode so we can see it was never written to.
        let witness = root.join("witness");
        std::fs::hard_link(&target, &witness).unwrap();
        std::fs::remove_file(&target).unwrap();
        std::fs::write(&target, b"truncated").unwrap();
        let damaged_inode = std::fs::metadata(&target).unwrap().ino();

        let fixed = install(&bundled, &bin, "1.0.0").unwrap().exe;
        assert_eq!(fixed, target);
        assert_eq!(std::fs::read(&fixed).unwrap(), b"the real host");
        let new_inode = std::fs::metadata(&fixed).unwrap().ino();
        assert_ne!(
            new_inode, damaged_inode,
            "the damaged file was rewritten in place"
        );
        assert_eq!(std::fs::metadata(&witness).unwrap().ino(), old_inode);
        assert_eq!(std::fs::read(&witness).unwrap(), b"the real host");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_or_missing_bundled_host_is_refused() {
        let root = scratch("empty");
        let bundled = root.join("bundled");
        std::fs::write(&bundled, b"").unwrap();
        assert!(install(&bundled, &root.join("bin"), "1.0.0")
            .unwrap_err()
            .contains("empty"));
        assert!(install(&root.join("absent"), &root.join("bin"), "1.0.0").is_err());
        assert!(!root.join("bin").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_deletes_only_stale_install_dirs() {
        let root = scratch("prune");
        let bin = root.join("bin");
        for name in [
            "0.5.13-aaaaaaaaaaaaaaaa",
            "0.5.14-bbbbbbbbbbbbbbbb",
            "0.5.15-cccccccccccccccc",
            "keep-me",
        ] {
            std::fs::create_dir_all(bin.join(name)).unwrap();
            std::fs::write(bin.join(name).join(HOST_BIN), b"x").unwrap();
        }
        // A symlink with our shape is never followed into or removed.
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("precious"), b"x").unwrap();
        std::os::unix::fs::symlink(&outside, bin.join("0.5.12-eeeeeeeeeeeeeeee")).unwrap();

        prune(&bin, "0.5.15-cccccccccccccccc", &Liveness::Unknown);
        assert!(bin.join("0.5.13-aaaaaaaaaaaaaaaa").exists());

        prune(
            &bin,
            "0.5.15-cccccccccccccccc",
            &Liveness::Known(Some("0.5.14-bbbbbbbbbbbbbbbb".into())),
        );
        assert!(!bin.join("0.5.13-aaaaaaaaaaaaaaaa").exists());
        assert!(bin.join("0.5.14-bbbbbbbbbbbbbbbb").exists());
        assert!(bin.join("0.5.15-cccccccccccccccc").exists());
        assert!(bin.join("keep-me").exists());
        assert!(outside.join("precious").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn verify_refuses_a_copy_that_changed_after_install() {
        let root = scratch("ver");
        let bundled = root.join("bundled");
        std::fs::write(&bundled, b"the real host").unwrap();
        let installed = install(&bundled, &root.join("bin"), "1.0.0").unwrap();
        assert!(verify(&installed.exe, &installed.digest).is_ok());
        std::fs::remove_file(&installed.exe).unwrap();
        std::fs::write(&installed.exe, b"swapped").unwrap();
        assert!(verify(&installed.exe, &installed.digest)
            .unwrap_err()
            .to_string()
            .contains("no longer matches"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_unchanged_bundle_is_not_hashed_again_but_a_changed_one_is() {
        let root = scratch("cache");
        let bundled = root.join("bundled");
        std::fs::write(&bundled, b"one").unwrap();
        let bin = root.join("bin");
        let a = install(&bundled, &bin, "1.0.0").unwrap();
        assert!(bin.join(CACHE).exists());
        let b = install(&bundled, &bin, "1.0.0").unwrap();
        assert_eq!(a.digest, b.digest);
        // Same size, new content, new file: the key differs, so the hash does.
        std::fs::remove_file(&bundled).unwrap();
        std::fs::write(&bundled, b"two").unwrap();
        let c = install(&bundled, &bin, "1.0.0").unwrap();
        assert_ne!(a.digest, c.digest);
        // A damaged cache is a miss, not an error.
        std::fs::write(bin.join(CACHE), b"garbage").unwrap();
        assert_eq!(install(&bundled, &bin, "1.0.0").unwrap().digest, c.digest);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn prune_leaves_a_directory_another_app_holds() {
        let root = scratch("held");
        let bundled = root.join("bundled");
        std::fs::write(&bundled, b"old").unwrap();
        let bin = root.join("bin");
        let old = install(&bundled, &bin, "0.5.14").unwrap();
        let old_dir = old.exe.parent().unwrap().to_path_buf();
        let old_name = old_dir.file_name().unwrap().to_str().unwrap().to_owned();
        std::fs::write(&bundled, b"new").unwrap();
        let new = install(&bundled, &bin, "0.5.15").unwrap();
        let current = new
            .exe
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let live = Liveness::Known(None);

        // `old.hold` is still open: another app is using that copy.
        prune(&bin, &current, &live);
        assert!(old_dir.exists());

        drop(old);
        prune(&bin, &current, &live);
        assert!(!old_dir.exists(), "{old_name} should have been pruned");
        assert!(new.exe.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_symlinked_or_foreign_directory_is_refused() {
        let root = scratch("priv");
        let real = root.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(private_dir(&link)
            .unwrap_err()
            .to_string()
            .contains("not a directory"));
        // The target was not chmodded through the link.
        let mode = std::fs::metadata(&real).unwrap().permissions().mode() & 0o777;
        assert_ne!(mode, 0o700);
        let file = root.join("file");
        std::fs::write(&file, b"x").unwrap();
        assert!(private_dir(&file).is_err());
        assert!(private_dir(&root.join("fresh")).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }
}

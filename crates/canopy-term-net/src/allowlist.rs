//! The set of device keys this side will serve. Shared (`Clone` is a handle to
//! the same set) so pairing can add a key while a transport is accepting, and a
//! removal takes effect at once for new streams and, on the iroh transport,
//! ends live links within `REVOCATION_INTERVAL` (not only at the next restart).
//!
//! Keys are one canonical string everywhere: 64 lowercase hex characters (an
//! ed25519 public key). Transports, pairing and the file format all go through
//! [`canonical_key`], so `PeerIdentity::Device` values compare equal.

use std::collections::BTreeSet;
use std::io::{self, Write};
use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};

#[derive(Debug, PartialEq, Eq)]
pub struct InvalidKey;

/// Normalise a device key, or `None` if it is not 64 hex characters.
pub fn canonical_key(raw: &str) -> Option<String> {
    let k = raw.trim().to_ascii_lowercase();
    if k.len() == 64 && k.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(k)
    } else {
        None
    }
}

#[derive(Default, Debug)]
struct Inner {
    set: RwLock<BTreeSet<String>>,
    /// Serialises saves, so two writers never race on the file.
    save: Mutex<()>,
}

#[derive(Clone, Default, Debug)]
pub struct Allowlist(Arc<Inner>);

/// Pure trust rule for the allowlist file on unix: owned by the current user or
/// root, and not writable by group or others.
pub fn file_trusted(uid: u32, mode: u32, our_uid: u32) -> bool {
    (uid == our_uid || uid == 0) && mode & 0o022 == 0
}

fn render(set: &BTreeSet<String>) -> String {
    let mut out = String::from("# canopy device allowlist: one public key per line\n");
    for k in set {
        out.push_str(k);
        out.push('\n');
    }
    out
}

/// A poisoned lock (a thread panicked while holding it) fails closed: reads
/// say "not allowed" and "empty", `add` is an error, and `save` refuses so an
/// empty view is never written over the real file. The poison is not cleared;
/// a poisoned list refuses until the process restarts.
impl Allowlist {
    pub fn new() -> Self {
        Self::default()
    }

    /// True if a thread panicked while holding the list.
    pub fn is_poisoned(&self) -> bool {
        self.0.set.is_poisoned()
    }

    /// Add a key. Returns whether it was new. Errors on an invalid key, and on
    /// a poisoned list (never `Ok`).
    pub fn add(&self, key: &str) -> Result<bool, InvalidKey> {
        let k = canonical_key(key).ok_or(InvalidKey)?;
        let mut set = self.0.set.write().map_err(|_| InvalidKey)?;
        Ok(set.insert(k))
    }

    pub fn remove(&self, key: &str) -> bool {
        match (canonical_key(key), self.0.set.write()) {
            (Some(k), Ok(mut set)) => set.remove(&k),
            _ => false,
        }
    }

    pub fn contains(&self, key: &str) -> bool {
        match (canonical_key(key), self.0.set.read()) {
            (Some(k), Ok(set)) => set.contains(&k),
            _ => false,
        }
    }

    pub fn keys(&self) -> Vec<String> {
        match self.0.set.read() {
            Ok(set) => set.iter().cloned().collect(),
            Err(_) => Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.0.set.read().map(|set| set.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// One key per line; blank lines and `#` comments are ignored. A bad line
    /// is an error rather than skipped: silently dropping an entry would hide
    /// a typo that locks a device out.
    pub fn from_text(text: &str) -> Result<Self, InvalidKey> {
        let list = Self::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            list.add(line)?;
        }
        Ok(list)
    }

    pub fn to_text(&self) -> String {
        match self.0.set.read() {
            Ok(set) => render(&set),
            Err(_) => render(&BTreeSet::new()),
        }
    }

    /// Test helper: poison the lock the way a panicking holder would.
    #[cfg(test)]
    pub(crate) fn poison_for_test(&self) {
        let h = self.clone();
        let _ = std::thread::spawn(move || {
            let _guard = h.0.set.write().unwrap();
            panic!("poison the allowlist (test)");
        })
        .join();
    }

    /// Read the list from `path`. On unix the file must be a regular file
    /// owned by this user (or root) and not writable by group or others: the
    /// file is the access policy, so one anyone else can edit is refused, not
    /// trusted. The check is on the open handle, so it cannot be raced by a
    /// swap between the check and the read.
    pub fn load(path: &Path) -> io::Result<Self> {
        use std::io::Read;
        let mut file = std::fs::File::open(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let m = file.metadata()?;
            if !m.is_file() || !file_trusted(m.uid(), m.mode(), crate::local_unix::current_uid()) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "allowlist file must be owned by this user and not writable by others",
                ));
            }
        }
        let mut text = String::new();
        file.read_to_string(&mut text)?;
        Self::from_text(&text).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "invalid key in allowlist file")
        })
    }

    /// Write the list to `path` safely. The temp file is created beside the
    /// target with an unpredictable name, `create_new` (so it never follows a
    /// planted symlink or reuses a file), mode 0600 from the start on unix (no
    /// window under the default umask), then written, fsynced and renamed. The
    /// directory is fsynced best-effort on unix. Public keys are not secret,
    /// but who may connect is the access policy: not world writable. A
    /// poisoned list refuses to save.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        // One save at a time, and the text comes from a single read of the
        // list: a poisoned list is an error, never an empty file.
        let _serial = self
            .0
            .save
            .lock()
            .map_err(|_| io::Error::other("allowlist save lock poisoned"))?;
        let text = {
            let set = self
                .0
                .set
                .read()
                .map_err(|_| io::Error::other("allowlist is poisoned; not saving"))?;
            render(&set)
        };
        let dir = match path.parent() {
            Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
            _ => std::path::PathBuf::from("."),
        };
        let name = path
            .file_name()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "no file name"))?
            .to_string_lossy()
            .into_owned();
        for _ in 0..8 {
            let mut rnd = [0u8; 8];
            getrandom::getrandom(&mut rnd).map_err(|e| io::Error::other(e.to_string()))?;
            let suffix: String = rnd.iter().map(|b| format!("{b:02x}")).collect();
            let tmp = dir.join(format!(".{name}.{suffix}.tmp"));
            let mut opts = std::fs::OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut file = match opts.open(&tmp) {
                Ok(f) => f,
                // Only a name clash is retried, with a new suffix.
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            };
            let written = file
                .write_all(text.as_bytes())
                .and_then(|_| file.sync_all());
            drop(file);
            let result = written.and_then(|_| std::fs::rename(&tmp, path));
            if result.is_err() {
                let _ = std::fs::remove_file(&tmp);
                return result;
            }
            #[cfg(unix)]
            {
                if let Ok(d) = std::fs::File::open(&dir) {
                    let _ = d.sync_all();
                }
            }
            return Ok(());
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not create a unique temp file",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn keys_are_canonical() {
        let l = Allowlist::new();
        assert_eq!(l.add(&A.to_uppercase()), Ok(true));
        assert_eq!(l.add(A), Ok(false));
        assert!(l.contains(&format!("  {A}\n")));
        assert!(!l.contains(B));
        assert_eq!(l.add("short"), Err(InvalidKey));
        assert_eq!(l.add(&"g".repeat(64)), Err(InvalidKey));
    }

    #[test]
    fn clones_share_one_set() {
        let l = Allowlist::new();
        let h = l.clone();
        h.add(B).unwrap();
        assert!(l.contains(B));
        assert!(l.remove(B));
        assert!(!h.contains(B));
    }

    #[test]
    fn text_round_trip_and_strictness() {
        let l = Allowlist::new();
        l.add(A).unwrap();
        l.add(B).unwrap();
        let back = Allowlist::from_text(&l.to_text()).unwrap();
        assert_eq!(back.keys(), l.keys());
        assert!(Allowlist::from_text("# c\n\nnot-a-key\n").is_err());
    }

    #[test]
    fn file_round_trip() {
        let dir = std::env::temp_dir().join(format!("ctn-al-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("allow.txt");
        let l = Allowlist::new();
        l.add(A).unwrap();
        l.save(&path).unwrap();
        assert_eq!(Allowlist::load(&path).unwrap().keys(), l.keys());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_file_trust_rule() {
        assert!(file_trusted(501, 0o100600, 501));
        assert!(file_trusted(501, 0o100644, 501));
        assert!(file_trusted(0, 0o100644, 501));
        assert!(!file_trusted(502, 0o100600, 501));
        assert!(!file_trusted(501, 0o100664, 501));
        assert!(!file_trusted(501, 0o100666, 501));
        assert!(!file_trusted(501, 0o100602, 501));
    }

    #[cfg(unix)]
    #[test]
    fn load_refuses_a_file_others_can_write() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("ctn-al-mode-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("allow.txt");
        let l = Allowlist::new();
        l.add(A).unwrap();
        l.save(&path).unwrap();
        assert_eq!(Allowlist::load(&path).unwrap().keys(), l.keys());
        for mode in [0o666, 0o664, 0o620] {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
            let err = Allowlist::load(&path).unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::PermissionDenied, "{mode:o}");
        }
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(Allowlist::load(&path).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn save_is_0600_and_ignores_a_planted_symlink() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("ctn-al-sym-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let victim = dir.join("victim.txt");
        std::fs::write(&victim, "keep me").unwrap();
        // The old fixed temp name, planted as a symlink to a file we must not touch.
        std::os::unix::fs::symlink(&victim, dir.join("allow.tmp")).unwrap();
        let path = dir.join("allow.txt");
        let l = Allowlist::new();
        l.add(A).unwrap();
        l.save(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep me");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        // No temp file is left behind, and saving again works.
        l.add(B).unwrap();
        l.save(&path).unwrap();
        assert_eq!(Allowlist::load(&path).unwrap().keys(), l.keys());
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .count();
        // Only the planted symlink remains.
        assert_eq!(leftovers, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_poisoned_list_fails_closed_and_never_saves() {
        let l = Allowlist::new();
        l.add(A).unwrap();
        l.poison_for_test();
        assert!(l.is_poisoned());
        assert!(!l.contains(A));
        assert!(l.keys().is_empty());
        assert_eq!(l.len(), 0);
        assert!(l.is_empty());
        assert!(!l.remove(A));
        assert_eq!(l.add(B), Err(InvalidKey));
        let dir = std::env::temp_dir().join(format!("ctn-al-poison-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("allow.txt");
        std::fs::write(&path, "real contents").unwrap();
        assert!(l.save(&path).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "real contents");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

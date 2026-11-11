//! The set of device keys this side will serve. Shared (`Clone` is a handle to
//! the same set) so pairing can add a key while a transport is accepting, and a
//! removal takes effect on the next stream, not only the next restart.
//!
//! Keys are one canonical string everywhere: 64 lowercase hex characters (an
//! ed25519 public key). Transports, pairing and the file format all go through
//! [`canonical_key`], so `PeerIdentity::Device` values compare equal.

use std::collections::BTreeSet;
use std::io;
use std::path::Path;
use std::sync::{Arc, RwLock};

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

#[derive(Clone, Default, Debug)]
pub struct Allowlist(Arc<RwLock<BTreeSet<String>>>);

impl Allowlist {
    pub fn new() -> Self {
        Self::default()
    }

    /// Add a key. Returns whether it was new.
    pub fn add(&self, key: &str) -> Result<bool, InvalidKey> {
        let k = canonical_key(key).ok_or(InvalidKey)?;
        Ok(self.0.write().unwrap().insert(k))
    }

    pub fn remove(&self, key: &str) -> bool {
        match canonical_key(key) {
            Some(k) => self.0.write().unwrap().remove(&k),
            None => false,
        }
    }

    pub fn contains(&self, key: &str) -> bool {
        match canonical_key(key) {
            Some(k) => self.0.read().unwrap().contains(&k),
            None => false,
        }
    }

    pub fn keys(&self) -> Vec<String> {
        self.0.read().unwrap().iter().cloned().collect()
    }

    pub fn len(&self) -> usize {
        self.0.read().unwrap().len()
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
        let mut out = String::from("# canopy device allowlist: one public key per line\n");
        for k in self.keys() {
            out.push_str(&k);
            out.push('\n');
        }
        out
    }

    pub fn load(path: &Path) -> io::Result<Self> {
        let text = std::fs::read_to_string(path)?;
        Self::from_text(&text).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidData, "invalid key in allowlist file")
        })
    }

    /// Write via a temp file then rename, mode 0600 on unix. Public keys are
    /// not secret, but who may connect is the access policy: not world
    /// writable.
    pub fn save(&self, path: &Path) -> io::Result<()> {
        let tmp = path.with_extension("tmp");
        std::fs::write(&tmp, self.to_text())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
        }
        std::fs::rename(&tmp, path)
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
}

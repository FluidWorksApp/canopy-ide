//! The set of device keys this side will serve. Shared (`Clone` is a handle to
//! the same set) so pairing can add a key while a transport is accepting, and a
//! removal takes effect on the next stream, not only the next restart.
//!
//! Keys are one canonical string everywhere: 64 lowercase hex characters (an
//! ed25519 public key). Transports, pairing and the file format all go through
//! [`canonical_key`], so `PeerIdentity::Device` values compare equal. Tailnet
//! identities use a second, namespaced entry form ([`canonical_tailnet_entry`]).

use std::collections::BTreeSet;
use std::io;
use std::path::Path;
use std::sync::{Arc, RwLock};

#[derive(Debug, PartialEq, Eq)]
pub struct InvalidKey;

/// A tailnet stable node id: letters, digits, `-` and `_`, short.
pub fn valid_stable_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A tailnet ACL tag such as `tag:server`. No `/` or `,`, which the entry
/// grammar uses as separators.
pub fn valid_tag(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b':')
}

/// A tailnet identity entry, in one of two namespaced forms that can never be
/// mistaken for a 64 hex device key:
///
/// - `tailnet:user/<stable node id>/<numeric user id>`
/// - `tailnet:tagged/<stable node id>/<tag>[,<tag>...]` (tags sorted, unique)
///
/// Keyed on the stable node id and user id, never on node or login names,
/// which are display values that can be renamed. The entry says which kind it
/// is, so a tagged node (no real user) can never match a user entry.
pub fn canonical_tailnet_entry(raw: &str) -> Option<String> {
    let rest = raw.trim().strip_prefix("tailnet:")?;
    let (kind, rest) = rest.split_once('/')?;
    let (stable, last) = rest.split_once('/')?;
    if !valid_stable_id(stable) {
        return None;
    }
    match kind {
        "user" => {
            let ok = !last.is_empty()
                && last.len() <= 20
                && last.bytes().all(|b| b.is_ascii_digit())
                && last != "0";
            ok.then(|| format!("tailnet:user/{stable}/{last}"))
        }
        "tagged" => {
            let mut tags: Vec<&str> = last.split(',').collect();
            if tags.iter().any(|t| !valid_tag(t)) {
                return None;
            }
            tags.sort_unstable();
            tags.dedup();
            Some(format!("tailnet:tagged/{stable}/{}", tags.join(",")))
        }
        _ => None,
    }
}

/// Any allowlist entry: a device key (hex path unchanged) or a tailnet identity.
pub fn canonical_entry(raw: &str) -> Option<String> {
    canonical_key(raw).or_else(|| canonical_tailnet_entry(raw))
}

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
        let k = canonical_entry(key).ok_or(InvalidKey)?;
        Ok(self.0.write().unwrap().insert(k))
    }

    pub fn remove(&self, key: &str) -> bool {
        match canonical_entry(key) {
            Some(k) => self.0.write().unwrap().remove(&k),
            None => false,
        }
    }

    pub fn contains(&self, key: &str) -> bool {
        match canonical_entry(key) {
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
    fn tailnet_entries_are_namespaced_and_canonical() {
        assert_eq!(
            canonical_entry("tailnet:user/nTEST1CNTRL/42").as_deref(),
            Some("tailnet:user/nTEST1CNTRL/42")
        );
        // Tags are sorted and de-duplicated; the entry names its kind.
        assert_eq!(
            canonical_entry("tailnet:tagged/nTEST1CNTRL/tag:b,tag:a,tag:b").as_deref(),
            Some("tailnet:tagged/nTEST1CNTRL/tag:a,tag:b")
        );
        // A stable id is case sensitive: no lowercasing.
        assert!(canonical_entry("tailnet:user/nTEST1CNTRL/42")
            .unwrap()
            .contains("nTEST"));
        for bad in [
            "tailnet:user/nTEST1CNTRL/",
            "tailnet:user/nTEST1CNTRL/0",
            "tailnet:user/nTEST1CNTRL/-1",
            "tailnet:user//42",
            "tailnet:user/bad id/42",
            "tailnet:tagged/nTEST1CNTRL/",
            "tailnet:tagged/nTEST1CNTRL/tag:a,,tag:b",
            "tailnet:tagged/nTEST1CNTRL/tag:a/x",
            "tailnet:other/nTEST1CNTRL/42",
            "tailnet:nTEST1CNTRL",
            "node-a.example.ts.net",
        ] {
            assert_eq!(canonical_entry(bad), None, "{bad}");
        }
        // The two namespaces never collide: a hex key is not a tailnet entry.
        assert_eq!(canonical_tailnet_entry(A), None);
        assert_eq!(canonical_key("tailnet:user/nTEST1CNTRL/42"), None);
    }

    #[test]
    fn tailnet_entries_live_in_the_same_list() {
        let l = Allowlist::new();
        l.add("tailnet:user/nTEST1CNTRL/42").unwrap();
        l.add(A).unwrap();
        assert!(l.contains("tailnet:user/nTEST1CNTRL/42"));
        assert!(!l.contains("tailnet:user/nTEST1CNTRL/43"));
        assert!(!l.contains("tailnet:tagged/nTEST1CNTRL/tag:a"));
        let back = Allowlist::from_text(&l.to_text()).unwrap();
        assert_eq!(back.keys(), l.keys());
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

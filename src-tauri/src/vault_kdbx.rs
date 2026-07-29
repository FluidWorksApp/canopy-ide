// Bringing an existing password set in from a .kdbx file.
//
// KDBX is what every other manager exports — KeePassXC writes it natively, and
// Bitwarden, 1Password and Strongbox all export to it — so this is the
// difference between "type your logins in again" and "bring them over". Reading
// only: the crate's KDBX writing is experimental, and the file holding
// someone's passwords is not where you find out what that means. The export
// stays theirs; ours is the vault.
//
// The mapping is the interesting part, because a KDBX entry is freer than a
// vault entry. It has a title, which may be a site or may be "Mum's Netflix";
// a URL, which may be missing, may be a bare host, or may be an app scheme; and
// a password, which may be empty because the entry is really a secure note.
// Anything we cannot place is reported as skipped with a reason rather than
// guessed at — an entry filed under the wrong domain would be offered on the
// wrong site, which is how a password ends up typed somewhere it should not be.
//
// Imported entries are always fill-only. `readable` is the user's decision to
// make per entry, and inheriting it from a file would make it a decision nobody
// made.

use crate::vault::{host_of, VaultEntry};

/// One row we could not take, and why — shown as a list rather than a count,
/// because "12 skipped" tells nobody which twelve.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct SkippedEntry {
    pub title: String,
    pub why: String,
}

#[derive(Debug, Default, serde::Serialize)]
pub struct ImportReport {
    /// Entries added to the vault.
    pub imported: usize,
    /// Already in the vault under the same site and username.
    pub duplicates: usize,
    pub skipped: Vec<SkippedEntry>,
}

/// The site an entry belongs to.
///
/// A URL is the reliable source. Failing that a title is worth trying, because
/// people do name entries "github.com" — but only when it looks like a host,
/// never when it is prose. "Mum's Netflix" must not become the domain
/// "mum's netflix", which would match nothing and sit in the list looking real.
pub fn domain_for(url: &str, title: &str) -> Option<String> {
    let from_url = host_of(url.trim());
    if let Some(host) = from_url {
        // Skip the schemes KeePass uses for non-web entries: an app or a file
        // is not something the browser can log in to.
        if !host.contains(' ') && host.contains('.') || host == "localhost" {
            return Some(host);
        }
    }
    let candidate = title.trim().to_ascii_lowercase();
    let looks_like_host = candidate.contains('.')
        && !candidate.contains(' ')
        && !candidate.starts_with('.')
        && !candidate.ends_with('.')
        && candidate
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
    looks_like_host.then_some(candidate)
}

/// A KDBX row, reduced to what the vault stores. Kept separate from the file
/// parsing so the mapping rules can be tested without a database.
pub fn to_entry(
    title: &str,
    username: &str,
    password: &str,
    url: &str,
    notes: &str,
    now: i64,
    seq: usize,
) -> Result<VaultEntry, SkippedEntry> {
    let name = || {
        if title.trim().is_empty() {
            "(untitled)".to_string()
        } else {
            title.trim().to_string()
        }
    };
    if password.is_empty() {
        return Err(SkippedEntry {
            title: name(),
            why: "no password — a note or a card rather than a login".into(),
        });
    }
    let Some(domain) = domain_for(url, title) else {
        return Err(SkippedEntry {
            title: name(),
            why: "no web address to match a page against".into(),
        });
    };
    Ok(VaultEntry {
        id: format!("k{now}{seq}"),
        label: name(),
        domain,
        username: username.trim().to_string(),
        password: password.to_string(),
        // Never inherited from the file: whether an agent may read a password
        // in plain text is a decision the user makes, one entry at a time.
        readable: false,
        notes: notes.trim().to_string(),
        updated: now,
    })
}

/// Read a .kdbx file and turn it into vault entries. Nothing is written and
/// nothing is decided here — the caller merges, dedupes against what it already
/// holds, and persists.
pub fn read_kdbx(
    path: &std::path::Path,
    password: &str,
    now: i64,
) -> Result<(Vec<VaultEntry>, Vec<SkippedEntry>), String> {
    use keepass::{Database, DatabaseKey};

    let mut file = std::fs::File::open(path).map_err(|e| format!("could not open it: {e}"))?;
    let db =
        Database::open(&mut file, DatabaseKey::new().with_password(password)).map_err(|e| {
            // The user only needs to know which of the two things to go and fix.
            let text = e.to_string().to_lowercase();
            if text.contains("key") || text.contains("hmac") || text.contains("integrity") {
                "wrong password for that file".to_string()
            } else {
                format!("could not read it as a KeePass database: {e}")
            }
        })?;

    // Deleted entries are deleted. Importing them would put passwords the user
    // threw away back in front of them — and back into a browser that fills.
    // Walked by id rather than by reference: each GroupRef borrows the database
    // for as long as it lives, and a parent chain held as references cannot
    // outlive the step that produced it.
    let bin = db.recycle_bin().map(|g| g.id());
    let in_bin = |entry: &keepass::db::EntryRef<'_>| {
        let Some(bin) = bin else { return false };
        let mut id = Some(entry.parent().id());
        while let Some(current) = id {
            if current == bin {
                return true;
            }
            id = db.group(current).and_then(|g| g.parent().map(|p| p.id()));
        }
        false
    };

    let mut entries = Vec::new();
    let mut skipped = Vec::new();
    for (seq, entry) in db.iter_all_entries().enumerate() {
        if in_bin(&entry) {
            continue;
        }
        match to_entry(
            entry.get_title().unwrap_or(""),
            entry.get_username().unwrap_or(""),
            entry.get_password().unwrap_or(""),
            entry.get_url().unwrap_or(""),
            entry.get("Notes").unwrap_or(""),
            now,
            seq,
        ) {
            Ok(e) => entries.push(e),
            Err(s) => skipped.push(s),
        }
    }
    Ok((entries, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `unwrap_err` would need Debug on the success type, and that type holds a
    /// plaintext password — see the same helper in vault.rs.
    fn err_of(r: Result<VaultEntry, SkippedEntry>) -> SkippedEntry {
        match r {
            Ok(_) => panic!("expected the entry to be skipped"),
            Err(e) => e,
        }
    }

    #[test]
    fn a_url_names_the_site_and_a_title_only_does_when_it_looks_like_one() {
        assert_eq!(
            domain_for("https://github.com/login", "GitHub").as_deref(),
            Some("github.com")
        );
        assert_eq!(domain_for("", "github.com").as_deref(), Some("github.com"));
        assert_eq!(domain_for("", "GitHub.COM").as_deref(), Some("github.com"));
        assert_eq!(
            domain_for("https://localhost:8080/", "dev").as_deref(),
            Some("localhost")
        );
        // Prose is not a domain. An entry filed under a made-up host would be
        // offered on a site it has nothing to do with.
        assert_eq!(domain_for("", "Mum's Netflix"), None);
        assert_eq!(domain_for("", "Work laptop PIN"), None);
        assert_eq!(domain_for("", ""), None);
        // Non-web entries KeePass carries happily.
        assert_eq!(
            domain_for("ssh://box.internal", "box").as_deref(),
            Some("box.internal")
        );
    }

    #[test]
    fn an_entry_with_no_password_is_a_note_and_is_reported_as_skipped() {
        let err = err_of(to_entry("Passport number", "", "", "", "", 100, 1));
        assert_eq!(err.title, "Passport number");
        assert!(err.why.contains("no password"), "{}", err.why);
    }

    #[test]
    fn an_entry_with_nowhere_to_match_is_skipped_with_its_name() {
        let err = err_of(to_entry("Alarm code", "", "1234", "", "", 100, 1));
        assert!(err.why.contains("no web address"), "{}", err.why);
        assert_eq!(err.title, "Alarm code");
    }

    #[test]
    fn an_imported_entry_is_fill_only_whatever_the_file_said() {
        let entry = match to_entry(
            "GitHub",
            " sam ",
            "hunter2",
            "https://github.com",
            " note ",
            100,
            3,
        ) {
            Ok(e) => e,
            Err(s) => panic!("should have imported: {}", s.why),
        };
        assert_eq!(entry.domain, "github.com");
        assert_eq!(entry.label, "GitHub");
        assert_eq!(entry.username, "sam");
        assert_eq!(entry.notes, "note");
        assert!(!entry.readable, "import must never grant plain-text reads");
    }

    /// Build a real database with the crate's own writer, then read it back
    /// through the importer. The fixture is generated rather than checked in:
    /// an opaque binary in the tree is a thing nobody can review.
    #[test]
    fn a_real_kdbx_file_round_trips_through_the_importer() {
        use keepass::{Database, DatabaseKey};

        let mut db = Database::new();
        {
            let mut root = db.root_mut();
            let mut add = |title: &str, user: &str, pass: &str, url: &str| {
                let mut entry = root.add_entry();
                entry.set_unprotected("Title", title);
                entry.set_unprotected("UserName", user);
                entry.set_protected("Password", pass);
                entry.set_unprotected("URL", url);
            };
            add("GitHub", "sam", "hunter2", "https://github.com");
            add("Alarm code", "", "1234", "");
            add("Passport", "", "", "https://gov.uk");
        }

        // A deleted entry, in a group the database's own metadata marks as the
        // recycle bin — which is how KeePass identifies it, not by its name.
        // Without this the skip-the-bin branch never runs in a test.
        let bin_uuid = {
            let mut root = db.root_mut();
            let mut bin = root.add_group();
            bin.name = "Recycle Bin".to_string();
            let uuid = bin.as_ref().id().uuid();
            let mut deleted = bin.add_entry();
            deleted.set_unprotected("Title", "Old bank");
            deleted.set_unprotected("UserName", "sam");
            deleted.set_protected("Password", "oldpw");
            deleted.set_unprotected("URL", "https://bank.example");
            uuid
        };
        db.meta.recyclebin_uuid = Some(bin_uuid);
        db.meta.recyclebin_enabled = Some(true);

        let dir = std::env::temp_dir().join(format!("canopy-kdbx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.kdbx");
        let mut out = std::fs::File::create(&path).unwrap();
        db.save(&mut out, DatabaseKey::new().with_password("opensesame"))
            .unwrap();
        drop(out);

        let (entries, skipped) = read_kdbx(&path, "opensesame", 100).unwrap();
        let labels: Vec<&str> = entries.iter().map(|e| e.label.as_str()).collect();
        assert_eq!(
            labels,
            vec!["GitHub"],
            "only the entry that can be matched to a site"
        );
        assert_eq!(entries[0].password, "hunter2");
        assert_eq!(entries[0].domain, "github.com");
        assert!(!entries[0].readable);
        // The other two are reported rather than silently dropped.
        assert_eq!(skipped.len(), 2);
        assert!(skipped.iter().any(|s| s.title == "Alarm code"));
        assert!(skipped.iter().any(|s| s.title == "Passport"));

        // Nothing from the recycle bin comes back, in either list: importing a
        // password the user threw away would put it back in front of them, and
        // back into a browser that fills it.
        assert!(!entries.iter().any(|e| e.label == "Old bank"));
        assert!(!skipped.iter().any(|s| s.title == "Old bank"));

        // A wrong password is reported as a wrong password.
        let err = match read_kdbx(&path, "wrong", 100) {
            Ok(_) => panic!("a wrong password must not open the file"),
            Err(e) => e,
        };
        assert!(err.contains("wrong password"), "{err}");

        std::fs::remove_dir_all(&dir).ok();
    }
}

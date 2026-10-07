//! Move conversation availability between one user's CLI profiles without
//! copying credentials or modifying the source transcript.
use std::{
    fs,
    path::{Path, PathBuf},
};

fn find(
    root: &Path,
    id: &str,
    agent: &str,
    depth: usize,
    budget: &mut usize,
) -> Result<Option<PathBuf>, String> {
    if depth == 0 || *budget == 0 || !root.exists() {
        return Ok(None);
    }
    if fs::symlink_metadata(root)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Session directory is a symlink".into());
    }
    for item in fs::read_dir(root).map_err(|e| e.to_string())? {
        if *budget == 0 {
            return Err("Session inventory limit reached".into());
        }
        *budget -= 1;
        let item = item.map_err(|e| e.to_string())?;
        let kind = item.file_type().map_err(|e| e.to_string())?;
        if kind.is_dir() && item.file_name() != "subagents" {
            if let Some(found) = find(&item.path(), id, agent, depth - 1, budget)? {
                return Ok(Some(found));
            }
        } else if kind.is_file() {
            let name = item.file_name().to_string_lossy().into_owned();
            if crate::profiles::conversation_file_matches(agent, &name, id) {
                return Ok(Some(item.path()));
            }
        }
    }
    Ok(None)
}

pub(crate) fn prepare(
    home: &str,
    agent: &str,
    session_id: &str,
    source_profile: &str,
    target_profile: &str,
) -> Result<(), String> {
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Invalid session id".into());
    }
    let sub =
        crate::profiles::conversation_store(agent).ok_or("Unsupported conversation transfer")?;
    let profiles = crate::profiles::list(home);
    let root = |id: &str| -> Result<PathBuf, String> {
        let profile = profiles
            .iter()
            .find(|p| p.id == id)
            .ok_or("Account profile not found")?;
        let path = PathBuf::from(&profile.root);
        if fs::canonicalize(&path).map_err(|e| e.to_string())? != path {
            return Err("Profile directory is a symlink".into());
        }
        Ok(path)
    };
    let source = root(source_profile)?;
    let target = root(target_profile)?;
    let file = find(&source.join(sub), session_id, agent, 6, &mut 10000)?
        .ok_or("Saved conversation not found")?;
    if source == target {
        return Ok(());
    }
    let destination = target.join(file.strip_prefix(&source).map_err(|e| e.to_string())?);
    let mut parent = target.clone();
    for component in destination
        .parent()
        .unwrap()
        .strip_prefix(&target)
        .unwrap()
        .components()
    {
        parent.push(component);
        fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        if fs::canonicalize(&parent).map_err(|e| e.to_string())? != parent {
            return Err("Conversation directory is a symlink".into());
        }
    }
    let before = fs::metadata(&file).map_err(|e| e.to_string())?;
    if before.len() > 128 * 1024 * 1024 {
        return Err("Conversation too large to transfer safely".into());
    }
    let mut nonce = [0u8; 16];
    getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let temporary = destination.with_extension(format!("{suffix}.transfer"));
    let result = (|| {
        fs::copy(&file, &temporary).map_err(|e| e.to_string())?;
        let after = fs::metadata(&file).map_err(|e| e.to_string())?;
        if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
            return Err("Conversation is still changing; stop the agent before switching".into());
        }
        match fs::hard_link(&temporary, &destination) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let info = fs::symlink_metadata(&destination).map_err(|e| e.to_string())?;
                if !info.is_file() || info.len() > 128 * 1024 * 1024 {
                    return Err("Target conversation differs; it was preserved".into());
                }
                let copied = fs::read(&temporary).map_err(|e| e.to_string())?;
                let existing = fs::read(&destination).map_err(|e| e.to_string())?;
                if copied != existing {
                    if existing.last() != Some(&b'\n') || !copied.starts_with(&existing) {
                        return Err("Target conversation differs; it was preserved".into());
                    }
                    let latest = fs::symlink_metadata(&destination).map_err(|e| e.to_string())?;
                    if !latest.is_file()
                        || latest.len() != info.len()
                        || latest.modified().ok() != info.modified().ok()
                    {
                        return Err(
                            "Target conversation is still changing; it was preserved".into()
                        );
                    }
                    fs::rename(&temporary, &destination).map_err(|e| e.to_string())?;
                }
                Ok(())
            }
            Err(e) => Err(e.to_string()),
        }
    })();
    let _ = fs::remove_file(temporary);
    result
}

#[tauri::command]
pub async fn profile_prepare_session(
    agent: String,
    session_id: String,
    source_profile: String,
    target_profile: String,
) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    prepare(&home, &agent, &session_id, &source_profile, &target_profile)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn returning_to_an_account_advances_only_its_older_transcript() {
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce).unwrap();
        let base = std::env::temp_dir().join(format!("canopy-return-{:x?}", nonce));
        fs::create_dir_all(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let home = base.to_str().unwrap();
        let work = crate::profiles::create(home, "Work").unwrap();
        let source = base.join(".claude/projects/app/id.jsonl");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"first turn\n").unwrap();
        prepare(home, "claude", "id", "default", "work").unwrap();
        let destination = PathBuf::from(&work.root).join(".claude/projects/app/id.jsonl");
        fs::write(&destination, b"first turn\nsecond turn\n").unwrap();
        prepare(home, "claude", "id", "work", "default").unwrap();
        assert_eq!(fs::read(&source).unwrap(), b"first turn\nsecond turn\n");
        fs::write(&source, b"divergent branch\n").unwrap();
        assert!(prepare(home, "claude", "id", "work", "default").is_err());
        assert_eq!(fs::read(&source).unwrap(), b"divergent branch\n");
        fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn transfers_transcript_preserves_credentials_and_conflicts() {
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce).unwrap();
        let base = std::env::temp_dir().join(format!("canopy-transfer-{:x?}", nonce));
        fs::create_dir_all(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let home = base.to_str().unwrap();
        let work = crate::profiles::create(home, "Work").unwrap();
        let source = base.join(".claude/projects/app/id.jsonl");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, b"conversation").unwrap();
        let secret = PathBuf::from(&work.root).join(".claude/.credentials.json");
        fs::write(&secret, b"work-secret").unwrap();
        prepare(home, "claude", "id", "default", "work").unwrap();
        let destination = PathBuf::from(&work.root).join(".claude/projects/app/id.jsonl");
        assert_eq!(fs::read(&destination).unwrap(), b"conversation");
        assert_eq!(fs::read(&secret).unwrap(), b"work-secret");
        prepare(home, "claude", "id", "default", "work").unwrap();
        fs::write(&destination, b"other history").unwrap();
        assert!(prepare(home, "claude", "id", "default", "work").is_err());
        assert_eq!(fs::read(&source).unwrap(), b"conversation");
        assert_eq!(fs::read(&destination).unwrap(), b"other history");
        assert!(prepare(home, "claude", "../id", "default", "work").is_err());
        fs::remove_dir_all(base).unwrap();
    }
}

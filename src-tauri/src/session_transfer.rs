//! Move conversation availability between one user's CLI profiles without
//! copying credentials or modifying the source transcript.
use std::{
    fs,
    path::{Path, PathBuf},
};

/// The sessions that reach a limit are the long ones, and real transcripts have
/// passed 120 MiB. Both copies are held in memory only when they are compared.
const MAX_CONVERSATION: u64 = 512 * 1024 * 1024;

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
    if before.len() > MAX_CONVERSATION {
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
                if !info.is_file() || info.len() > MAX_CONVERSATION {
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

fn profile_root(home: &str, id: &str) -> Result<PathBuf, String> {
    crate::profiles::list(home)
        .into_iter()
        .find(|p| p.id == id)
        .map(|p| PathBuf::from(p.root))
        .ok_or_else(|| "Account profile not found".to_string())
}

/// Replace a file the CLI owns without a window where it is half written, and
/// keep its permissions: Claude's state file is private to the user.
fn replace(path: &Path, text: &str) -> Result<(), String> {
    let info = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !info.is_file() {
        return Err("Account state is not a regular file".into());
    }
    let mut nonce = [0u8; 8];
    getrandom::getrandom(&mut nonce).map_err(|e| e.to_string())?;
    let suffix: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let temporary = path.with_extension(format!("{suffix}.trust"));
    let result = fs::write(&temporary, text)
        .and_then(|()| fs::set_permissions(&temporary, info.permissions()))
        .and_then(|()| fs::rename(&temporary, path))
        .map_err(|e| e.to_string());
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn carry_claude_trust(home: &str, source: &Path, target: &Path, cwd: &Path) -> Result<(), String> {
    let read = |root: &Path| -> Result<(PathBuf, serde_json::Value), String> {
        let path = crate::profiles::claude_state_file(home, root);
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        Ok((
            path,
            serde_json::from_str(&text).map_err(|e| e.to_string())?,
        ))
    };
    let (_, from) = read(source)?;
    let trusted = |state: &serde_json::Value, path: &Path| {
        path.to_str()
            .and_then(|key| state["projects"][key]["hasTrustDialogAccepted"].as_bool())
            == Some(true)
    };
    if !cwd.ancestors().any(|path| trusted(&from, path)) {
        return Ok(());
    }
    let (path, mut state) = read(target)?;
    if cwd.ancestors().any(|path| trusted(&state, path)) {
        return Ok(());
    }
    let key = cwd.to_str().ok_or("Folder path is not text")?;
    let root = state
        .as_object_mut()
        .ok_or("Account state is not an object")?;
    let projects = root
        .entry("projects")
        .or_insert_with(|| serde_json::json!({}));
    let project = projects
        .as_object_mut()
        .ok_or("Account state is not an object")?
        .entry(key)
        .or_insert_with(|| serde_json::json!({}));
    project
        .as_object_mut()
        .ok_or("Account state is not an object")?
        .insert("hasTrustDialogAccepted".into(), serde_json::json!(true));
    let text = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    replace(&path, &text)
}

fn carry_codex_trust(source: &Path, target: &Path, cwd: &Path) -> Result<(), String> {
    let header = |path: &Path| format!("[projects.\"{}\"]", path.display());
    let trusts = |text: &str, path: &Path| {
        let wanted = header(path);
        let mut lines = text
            .lines()
            .map(str::trim)
            .skip_while(|line| *line != wanted);
        lines.next().is_some()
            && lines
                .take_while(|line| !line.starts_with('['))
                .any(|line| line.replace(' ', "") == "trust_level=\"trusted\"")
    };
    let from = fs::read_to_string(source.join(".codex/config.toml")).unwrap_or_default();
    if !cwd.ancestors().any(|path| trusts(&from, path)) {
        return Ok(());
    }
    let wanted = header(cwd);
    if wanted[11..].contains('\\') || wanted[11..wanted.len() - 2].contains('"') {
        return Ok(());
    }
    let path = target.join(".codex/config.toml");
    let text = fs::read_to_string(&path).unwrap_or_default();
    if text.lines().any(|line| line.trim() == wanted) {
        return Ok(());
    }
    if !path.exists() {
        fs::write(&path, "").map_err(|e| e.to_string())?;
    }
    replace(
        &path,
        &format!("{}\n{wanted}\ntrust_level = \"trusted\"\n", text.trim_end()),
    )
}

/// Folder trust is stored per account, and a CLI that has not seen a folder
/// stops at a prompt whose default answer exits. The same person already
/// accepted this folder on the account being left, so that answer comes along.
/// A folder the source account never trusted stays untrusted.
pub(crate) fn carry_trust(
    home: &str,
    agent: &str,
    cwd: &str,
    source_profile: &str,
    target_profile: &str,
) -> Result<(), String> {
    let source = profile_root(home, source_profile)?;
    let target = profile_root(home, target_profile)?;
    if source == target {
        return Ok(());
    }
    use crate::profiles::TrustStore;
    match crate::profiles::trust_store(agent) {
        Some(TrustStore::ClaudeState) => carry_claude_trust(home, &source, &target, Path::new(cwd)),
        Some(TrustStore::CodexConfig) => carry_codex_trust(&source, &target, Path::new(cwd)),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn profile_carry_trust(
    agent: String,
    cwd: String,
    source_profile: String,
    target_profile: String,
) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    carry_trust(&home, &agent, &cwd, &source_profile, &target_profile)
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
    fn accounts() -> (PathBuf, String, PathBuf) {
        let mut nonce = [0u8; 16];
        getrandom::getrandom(&mut nonce).unwrap();
        let base = std::env::temp_dir().join(format!("canopy-trust-{:x?}", nonce));
        fs::create_dir_all(&base).unwrap();
        let base = fs::canonicalize(base).unwrap();
        let home = base.to_str().unwrap().to_string();
        let work = PathBuf::from(crate::profiles::create(&home, "Work").unwrap().root);
        (base, home, work)
    }

    #[test]
    fn claude_trust_follows_only_what_the_source_trusted() {
        let (base, home, work) = accounts();
        let state = crate::profiles::claude_state_file(&home, &work);
        fs::create_dir_all(state.parent().unwrap()).unwrap();
        fs::write(
            &state,
            r#"{"oauthAccount":{"keep":1},"projects":{"/other":{"x":2}}}"#,
        )
        .unwrap();
        fs::write(
            crate::profiles::claude_state_file(&home, &base),
            r#"{"projects":{"/repo":{"hasTrustDialogAccepted":true},"/no":{"hasTrustDialogAccepted":false}}}"#,
        )
        .unwrap();
        carry_trust(&home, "claude", "/no", "default", "work").unwrap();
        carry_trust(&home, "claude", "/never", "default", "work").unwrap();
        let unchanged: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&state).unwrap()).unwrap();
        assert_eq!(unchanged["projects"].as_object().unwrap().len(), 1);
        carry_trust(&home, "claude", "/repo/sub", "default", "work").unwrap();
        let after: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&state).unwrap()).unwrap();
        assert_eq!(
            after["projects"]["/repo/sub"]["hasTrustDialogAccepted"],
            true
        );
        assert_eq!(after["projects"]["/other"]["x"], 2);
        assert_eq!(after["oauthAccount"]["keep"], 1);
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn a_broken_account_state_is_left_alone() {
        let (base, home, work) = accounts();
        let state = crate::profiles::claude_state_file(&home, &work);
        fs::create_dir_all(state.parent().unwrap()).unwrap();
        fs::write(&state, "{ not json").unwrap();
        fs::write(
            crate::profiles::claude_state_file(&home, &base),
            r#"{"projects":{"/repo":{"hasTrustDialogAccepted":true}}}"#,
        )
        .unwrap();
        assert!(carry_trust(&home, "claude", "/repo", "default", "work").is_err());
        assert_eq!(fs::read_to_string(&state).unwrap(), "{ not json");
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn codex_trust_is_added_once_and_keeps_the_config() {
        let (base, home, work) = accounts();
        fs::create_dir_all(base.join(".codex")).unwrap();
        fs::create_dir_all(work.join(".codex")).unwrap();
        fs::write(base.join(".codex/config.toml"), "[projects.\"/repo\"]\ntrust_level = \"trusted\"\n\n[projects.\"/no\"]\ntrust_level = \"untrusted\"\n").unwrap();
        fs::write(work.join(".codex/config.toml"), "model = \"x\"\n").unwrap();
        carry_trust(&home, "codex", "/no", "default", "work").unwrap();
        assert_eq!(
            fs::read_to_string(work.join(".codex/config.toml")).unwrap(),
            "model = \"x\"\n"
        );
        carry_trust(&home, "codex", "/repo", "default", "work").unwrap();
        carry_trust(&home, "codex", "/repo", "default", "work").unwrap();
        let text = fs::read_to_string(work.join(".codex/config.toml")).unwrap();
        assert!(text.starts_with("model = \"x\""));
        assert_eq!(text.matches("[projects.\"/repo\"]").count(), 1);
        assert!(text.parse::<toml::Table>().is_ok());
        let _ = fs::remove_dir_all(base);
    }

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

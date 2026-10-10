//! Desktop configuration for the shared harness stores.
//! Keep legacy paths and runtime identity here; canopy-core has no environment
//! discovery or dependency on the desktop process.

pub use canopy_core::mesh::*;
use std::path::PathBuf;
use std::sync::Arc;

/// `CANOPY_MESH_HOME`, else `~/.canopy/mesh`: where every existing install
/// keeps `messages.jsonl` and `claims.sqlite`. Changing this hides history.
fn root_from(mesh_home: Option<String>, home: Option<String>) -> Option<PathBuf> {
    if let Some(dir) = mesh_home {
        return Some(PathBuf::from(dir));
    }
    Some(PathBuf::from(home?).join(".canopy").join("mesh"))
}

fn root() -> Option<PathBuf> {
    root_from(
        std::env::var("CANOPY_MESH_HOME").ok(),
        std::env::var("HOME").ok(),
    )
}

fn messages_at(root: Option<PathBuf>) -> MeshStore {
    MeshStore::with_events(
        root.map(|root| root.join("messages.jsonl")),
        Arc::new(crate::change::DesktopEvents),
    )
}

fn claims_at(root: Option<PathBuf>) -> ClaimStore {
    ClaimStore::load(
        root.map(|root| root.join("claims.sqlite")),
        crate::pty::instance_token().to_string(),
    )
}

pub fn load_messages() -> MeshStore {
    messages_at(root())
}

pub fn load_claims() -> ClaimStore {
    claims_at(root())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_keeps_the_legacy_locations() {
        assert_eq!(
            root_from(Some("/override".into()), Some("/home/u".into())),
            Some(PathBuf::from("/override"))
        );
        assert_eq!(
            root_from(None, Some("/home/u".into())),
            Some(PathBuf::from("/home/u/.canopy/mesh"))
        );
        assert_eq!(root_from(None, None), None);
    }

    /// An existing install's files must be found where they already are.
    #[test]
    fn existing_store_files_are_read_back() {
        let dir = std::env::temp_dir().join(format!("canopy-desktop-mesh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("messages.jsonl"),
            "{\"id\":\"m7\",\"to_pty_id\":2,\"text\":\"kept\",\"at_ms\":1,\"submitted\":true}\n",
        )
        .unwrap();

        let messages = messages_at(Some(dir.clone()));
        assert_eq!(messages.get("m7").map(|m| m.text), Some("kept".into()));
        let claims = claims_at(Some(dir.clone()));
        assert!(claims.all_newest().is_ok());
        assert!(dir.join("claims.sqlite").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

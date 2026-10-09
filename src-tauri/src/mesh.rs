//! Desktop configuration for the shared harness stores.
//! Keep legacy paths and runtime identity here; canopy-core has no environment
//! discovery or dependency on the desktop process.

use canopy_core::events::{EventSink, StoreChange};
pub use canopy_core::mesh::*;
use std::path::PathBuf;
use std::sync::Arc;

struct DesktopStoreEvents;
impl EventSink for DesktopStoreEvents {
    fn publish(&self, change: StoreChange) {
        // The desktop keeps its existing coalescing and store:change wire shape.
        crate::change::pulse(crate::change::Store::Mesh, &change.scope, &change.id);
    }
}

fn root() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CANOPY_MESH_HOME") {
        return Some(PathBuf::from(dir));
    }
    Some(
        PathBuf::from(std::env::var("HOME").ok()?)
            .join(".canopy")
            .join("mesh"),
    )
}

pub fn load_messages() -> MeshStore {
    MeshStore::with_events(
        root().map(|root| root.join("messages.jsonl")),
        Arc::new(DesktopStoreEvents),
    )
}

pub fn load_claims() -> ClaimStore {
    ClaimStore::load(
        root().map(|root| root.join("claims.sqlite")),
        crate::pty::instance_token().to_string(),
    )
}

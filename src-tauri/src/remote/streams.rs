//! Stream providers: the second registry.
//!
//! A stream is live bytes attached to a node. The wire carries `attach` /
//! `frame` / `detach` and names no feature, so a new live surface — a preview
//! proxy, a device screencap, a browser frame grabber — arrives as a provider
//! registered here and changes nothing in the portal or the protocol.
//!
//! `pty` is the one that exists today, and it is deliberately thin: the
//! scrollback ring and broadcast fan-out already live in `PtyManager::attach`,
//! built so a remote viewer never touches the WebView's backpressure.

use tauri::{AppHandle, Manager};
use tokio::sync::broadcast;

use crate::pty::{PtyEvent, PtyManager};

/// Kinds with a provider behind them. A manifest declaring anything else fails
/// validation before it reaches the server.
pub const KINDS: &[&str] = &["pty"];

pub fn has_kind(kind: &str) -> bool {
    KINDS.contains(&kind)
}

/// What a client gets on attach: the size to render at, the catch-up bytes, and
/// the live tail.
pub struct Attached {
    pub cols: u16,
    pub rows: u16,
    pub snapshot: Vec<u8>,
    pub rx: broadcast::Receiver<PtyEvent>,
}

/// Open a stream by kind. Fail-closed: an unknown kind is an error, never a
/// silently dead subscription the client waits on forever.
pub fn attach(app: &AppHandle, kind: &str, id: &str) -> Result<Attached, String> {
    if !has_kind(kind) {
        return Err(format!("no stream provider for kind: {kind}"));
    }
    match kind {
        "pty" => {
            let id: u32 = id.parse().map_err(|_| format!("bad pty id: {id}"))?;
            let (cols, rows, snapshot, rx) = app
                .state::<PtyManager>()
                .attach(id)
                .ok_or_else(|| format!("no pty session {id}"))?;
            Ok(Attached {
                cols,
                rows,
                snapshot,
                rx,
            })
        }
        _ => Err(format!("no stream provider for kind: {kind}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_registered_kinds_are_known() {
        assert!(has_kind("pty"));
        assert!(!has_kind("browser-frame"));
        assert!(!has_kind(""));
    }
}

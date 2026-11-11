//! TEMPORARY adapter. The frame-source boundary is owned by
//! `canopy-term-session` (Track L, `feat/term-session`, not pushed yet), which
//! will expose a `FrameSource` (`frame_since(seq) -> FrameUpdate`) and input
//! entry points taking canopy-term-input's event types. Until it lands, the
//! window pulls frames through this minimal trait, kept in this one module.
//! When it lands this module is deleted and `window::run` takes the session's
//! type instead; nothing else in the crate depends on this trait.

use std::sync::Arc;

use canopy_term_core::event::Event;
use canopy_term_core::frame::Frame;

/// Called from any thread when a new frame is ready; the window then pulls it.
pub type Waker = Arc<dyn Fn() + Send + Sync>;

/// TEMPORARY: replaced by canopy-term-session's `FrameSource`.
pub trait FrameSource {
    /// The newest frame, with damage relative to `since` (the sequence this
    /// window last drew; 0 means "none", which must give full damage).
    /// `None` when nothing is newer than `since`.
    fn frame_since(&mut self, since: u64) -> Option<Frame>;

    /// The grid size changed (window resize or zoom).
    fn resize(&mut self, cols: u16, rows: u16);

    /// Bytes for the program, already encoded by canopy-term-input.
    fn write(&mut self, bytes: &[u8]);

    /// Installs the callback that wakes the window's event loop.
    fn set_waker(&mut self, waker: Waker);

    /// The program exited: the window closes.
    fn closed(&self) -> bool {
        false
    }

    /// Events the program raised since the last call, oldest first: prompt
    /// marks and, when the source's policy allows, clipboard requests. Never
    /// act on a clipboard request without the user's say-so. Nothing in the
    /// window calls this yet; the data is here for the UI that will.
    fn take_events(&mut self) -> Vec<Event> {
        Vec::new()
    }
}

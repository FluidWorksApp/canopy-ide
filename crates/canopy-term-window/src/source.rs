//! The window's boundary with whatever produces frames (the emulator, a
//! remote session, the demo). Kept small so the window does not wait on the
//! emulator track: anything that can hand out `Frame`s and take bytes fits.

use std::sync::Arc;

use canopy_term_core::frame::Frame;

/// Called from any thread when a new frame is ready; the window then pulls it.
pub type Waker = Arc<dyn Fn() + Send + Sync>;

pub trait FrameSource {
    /// The newest frame, with damage relative to `since` (the sequence this
    /// window last drew; 0 means "none", which must give full damage).
    /// `None` when nothing is newer than `since`.
    fn frame_since(&mut self, since: u64) -> Option<Frame>;

    /// The grid size changed (window resize or zoom).
    fn resize(&mut self, cols: u16, rows: u16);

    /// Bytes for the program: encoded keys, pasted or committed text.
    fn write(&mut self, bytes: &[u8]);

    /// Installs the callback that wakes the window's event loop.
    fn set_waker(&mut self, waker: Waker);

    /// The program exited: the window closes.
    fn closed(&self) -> bool {
        false
    }
}

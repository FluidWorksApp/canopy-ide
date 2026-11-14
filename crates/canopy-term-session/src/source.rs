//! The frame source: what a window (or any other viewer) pulls frames from and
//! sends input to.
//!
//! The first five methods are exactly the shape of the trait the window crate
//! started with, so moving it onto this one is an import change. The rest have
//! defaults. [`Session`](crate::Session) overrides all of them.

use std::sync::Arc;
use std::time::Instant;

use canopy_term_core::frame::{Frame, Modes};
use canopy_term_core::Row;
use canopy_term_input::{
    encode_focus, encode_key, encode_mouse, encode_paste, encode_text, KeyEvent, MouseEvent,
};

/// Called from any thread when there is something to pull; the viewer then
/// calls [`FrameSource::frame_since`] on its own thread.
pub type Waker = Arc<dyn Fn() + Send + Sync>;

pub trait FrameSource {
    /// The newest frame, with damage relative to `since` (the sequence this
    /// viewer last drew; 0 means "none", which gives full damage). `None` when
    /// nothing is newer than `since`. Each viewer keeps its own `since`.
    ///
    /// This is also the source's tick: a [`Session`](crate::Session) reads and
    /// parses output here, at most one batch per call, so call it on every
    /// wake (and at [`FrameSource::deadline`]).
    fn frame_since(&mut self, since: u64) -> Option<Frame>;

    /// [`FrameSource::frame_since`] into a frame the viewer already owns,
    /// reusing its buffers so a steady viewer allocates nothing per frame.
    /// True when `out` was overwritten with a newer frame; false leaves it
    /// alone. The default allocates (it moves `frame_since`'s frame in);
    /// [`Session`](crate::Session) copies in place.
    fn frame_into(&mut self, since: u64, out: &mut Frame) -> bool {
        match self.frame_since(since) {
            Some(frame) => {
                *out = frame;
                true
            }
            None => false,
        }
    }

    /// The grid size changed (window resize or zoom).
    fn resize(&mut self, cols: u16, rows: u16);

    /// Raw bytes for the program, already encoded.
    fn write(&mut self, bytes: &[u8]);

    /// Installs the callback that wakes the viewer's event loop.
    fn set_waker(&mut self, waker: Waker);

    /// The program exited: the viewer closes.
    fn closed(&self) -> bool {
        false
    }

    /// When to call [`FrameSource::frame_since`] again even if no wake comes:
    /// the end of a synchronized-output hold. `None` when nothing is pending.
    fn deadline(&self) -> Option<Instant> {
        None
    }

    /// The program's current input modes. These can be newer than the last
    /// frame (a frame held by synchronized output), so encode with these.
    fn modes(&self) -> Modes {
        Modes::default()
    }

    /// Lines of scrollback behind the live screen (0 on the alternate screen,
    /// and for a source that keeps none).
    fn scrollback_len(&self) -> usize {
        0
    }

    /// Up to `count` scrollback lines from index `start` (0 is the oldest).
    /// Fewer when the history ends first.
    fn scrollback_rows(&self, start: usize, count: usize) -> Vec<Row> {
        let _ = (start, count);
        Vec::new()
    }

    /// A key event, encoded with [`FrameSource::modes`]. True if bytes were
    /// sent.
    fn key(&mut self, ev: &KeyEvent<'_>) -> bool {
        encode_with(self, |modes, out| encode_key(ev, modes, out))
    }

    /// Committed text (IME, or text not tied to one key).
    fn text(&mut self, text: &str) -> bool {
        encode_with(self, |modes, out| encode_text(text, modes, out))
    }

    /// A paste, bracketed when the program asked for it.
    fn paste(&mut self, text: &str) -> bool {
        encode_with(self, |modes, out| encode_paste(text, modes, out).written)
    }

    /// A mouse event; sends nothing unless the program asked for mouse
    /// reports.
    fn mouse(&mut self, ev: &MouseEvent) -> bool {
        encode_with(self, |modes, out| encode_mouse(ev, modes, out))
    }

    /// The target of the OSC 8 hyperlink on a visible cell, if any. It is the
    /// raw URI the program printed: the viewer decides whether to open it, and
    /// must check it first (`frame::is_safe_link`). The default has no links.
    fn hyperlink_at(&self, _row: u16, _col: u16) -> Option<String> {
        None
    }

    /// Focus gained or lost; sends nothing unless the program asked (1004).
    fn focus(&mut self, focused: bool) -> bool {
        encode_with(self, |modes, out| encode_focus(focused, modes, out))
    }
}

/// The default input path: encode into a fresh buffer and `write` it.
/// `Session` overrides every input method with a reused buffer instead.
fn encode_with<S: FrameSource + ?Sized>(
    source: &mut S,
    encode: impl FnOnce(Modes, &mut Vec<u8>) -> bool,
) -> bool {
    let mut out = Vec::new();
    if encode(source.modes(), &mut out) {
        source.write(&out);
        true
    } else {
        false
    }
}

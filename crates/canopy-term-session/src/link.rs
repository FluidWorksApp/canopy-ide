//! The session link: the byte pipe between a [`Session`](crate::Session) and
//! the program it shows.
//!
//! Defined here, not in the PTY host crate, so this crate depends only on the
//! emulator and the input encoders. Adapters live with the transports: the PTY
//! host client (unix socket), the Windows pipe, the network transports, and
//! [`MemoryLink`](crate::MemoryLink) for tests.
//!
//! Every call is **non-blocking**: the session runs on the window's thread,
//! and a blocking read or write there freezes the window (and a blocking write
//! while output is not being read is the classic PTY deadlock). An adapter
//! over a blocking stream runs its own reader thread into a **bounded** queue
//! and calls the waker when bytes arrive; when the queue is full the reader
//! stops reading, so backpressure reaches the program.

use std::io;

use crate::source::Waker;

/// The result of one [`SessionLink::try_read`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkRead {
    /// `n` bytes of live output were copied into the buffer.
    Data(usize),
    /// `n` bytes of history were copied into the buffer: output the program
    /// produced before this attach (the host's ring), replayed so the screen
    /// matches. Terminal query replies these bytes produce are dropped, never
    /// written back: they answer questions asked long ago, and the shell
    /// would read them as typed input.
    Replay(usize),
    /// The history is complete; what follows is live. Live data also ends a
    /// replay implicitly, but a link with history must send this so an idle
    /// program's screen is published without waiting for new output.
    ReplayEnd,
    /// Nothing available right now. The link calls the waker when there is.
    Empty,
    /// The program exited or the link broke. Sticky: every later read
    /// returns `Closed` too.
    Closed,
}

/// A non-blocking byte pipe to a terminal program.
pub trait SessionLink {
    /// Copies available output into `buf` (never more than `buf.len()`).
    /// `Data(0)` and `Replay(0)` are read as `Empty`. An error closes the
    /// session, except `WouldBlock` and `Interrupted`, which are `Empty`.
    fn try_read(&mut self, buf: &mut [u8]) -> io::Result<LinkRead>;

    /// Accepts as many bytes as it can without blocking and returns how many
    /// (0 when full). The session keeps the rest and offers them again on its
    /// next tick. An error closes the session, except `WouldBlock` and
    /// `Interrupted`, which are 0.
    fn try_write(&mut self, bytes: &[u8]) -> io::Result<usize>;

    /// The grid size changed; the far end resizes the PTY (`TIOCSWINSZ`).
    fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()>;

    /// The session is done with the link.
    fn close(&mut self);

    /// Installs the callback to run (from any thread) when output becomes
    /// readable or the link closes. Optional for links that are polled.
    fn set_waker(&mut self, waker: Waker) {
        let _ = waker;
    }
}

impl<L: SessionLink + ?Sized> SessionLink for Box<L> {
    fn try_read(&mut self, buf: &mut [u8]) -> io::Result<LinkRead> {
        (**self).try_read(buf)
    }

    fn try_write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        (**self).try_write(bytes)
    }

    fn resize(&mut self, cols: u16, rows: u16) -> io::Result<()> {
        (**self).resize(cols, rows)
    }

    fn close(&mut self) {
        (**self).close()
    }

    fn set_waker(&mut self, waker: Waker) {
        (**self).set_waker(waker)
    }
}

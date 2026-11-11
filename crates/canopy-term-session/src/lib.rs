//! The headless core of the terminal app: bytes from a session link become
//! screen frames, and input events become bytes for the program. No window,
//! no GPU.
//!
//! * [`SessionLink`]: the non-blocking byte pipe to the program (PTY host
//!   socket, Windows pipe, network transport; [`MemoryLink`] for tests).
//!   Defined here so this crate depends only on `canopy-term-core` and
//!   `canopy-term-input`.
//! * [`Session`]: owns a `Screen` and a link. Each tick drains the link up to
//!   a byte budget into one reused buffer, advances the screen once, writes
//!   terminal query replies back, and publishes at most one frame, held while
//!   the program has synchronized output (2026) set. History replayed on
//!   attach is parsed with its replies dropped.
//! * [`FrameSource`]: what the window pulls frames from and sends input to.
//!   `Session` implements it.
//!
//! Typical use from a window's event loop:
//!
//! ```text
//! session.set_waker(wake_event_loop);         // link has output
//! on wake or at session.deadline():
//!     if let Some(frame) = session.frame_since(last_drawn_seq) { draw(frame) }
//! on key:    session.key(&event)              // encoded with current modes
//! on resize: session.resize(cols, rows)       // screen and PTY
//! ```

#![forbid(unsafe_code)]

mod link;
mod memory;
mod session;
mod source;

pub use link::{LinkRead, SessionLink};
pub use memory::{MemoryLink, MemoryPeer};
pub use session::{
    Session, SessionConfig, Stats, Tick, DEFAULT_MAX_PENDING_WRITE, DEFAULT_SYNC_TIMEOUT,
    DEFAULT_TICK_BUDGET, MIN_TICK_BUDGET,
};
pub use source::{FrameSource, Waker};

pub use canopy_term_core::frame;
pub use canopy_term_core::Screen;
pub use canopy_term_input as input;

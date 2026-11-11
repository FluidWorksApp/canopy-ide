//! The frame contract: what an emulator produces and a renderer draws.
//!
//! `frame` is deliberately plain data with no dependencies, so the screen-state
//! track and the renderer track can build against it independently. Extend it
//! by adding fields with defaults, never by changing the meaning of existing
//! ones. `screen` is the headless emulator behind a small `Screen` type; no
//! emulator types leak through its API.

pub mod frame;
#[cfg(feature = "screen")]
pub mod screen;

#[cfg(feature = "screen")]
pub use screen::Screen;

//! The frame contract and the headless terminal behind it.
//!
//! `frame` is deliberately plain data with no dependencies, so the screen-state
//! track and the renderer track can build against it independently. Extend it
//! by adding fields with defaults, never by changing the meaning of existing
//! ones.
//!
//! [`Screen`] is the headless emulator, built on libghostty-vt (MIT OR
//! Apache-2.0), the only engine. No libghostty-vt type leaks through its API.
//! The crate needs Zig 0.15.2 and Rust 1.90 to build: see `README.md`.
//!
//! The engine lives in [`ghostty`]. Everything public in it is re-exported at
//! the crate root, and under the older path [`screen`], so
//! `canopy_term_core::Screen` and `canopy_term_core::screen::DEFAULT_SCROLLBACK`
//! both keep working.

pub mod frame;
pub mod ghostty;
mod shared;

pub use ghostty::*;

/// The path the engine's types had before libghostty-vt became the only engine.
pub mod screen {
    pub use crate::ghostty::*;
}

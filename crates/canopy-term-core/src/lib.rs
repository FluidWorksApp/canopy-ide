//! The frame contract: what an emulator produces and a renderer draws.
//!
//! Deliberately plain data with no dependencies, so the screen-state track and
//! the renderer track can build against it independently. Extend it by adding
//! fields with defaults, never by changing the meaning of existing ones.

pub mod frame;

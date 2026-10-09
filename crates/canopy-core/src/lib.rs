//! Harness logic shared by the desktop and the future host service.
//!
//! Store locations, instance identity and event delivery are injected by the
//! embedding process. This crate never discovers a desktop or reads HOME.

pub mod bounded_file;
pub mod claims;
pub mod events;
pub mod mesh;
pub mod notes;
pub mod project;
pub mod research;
pub mod terminals;
pub mod when;

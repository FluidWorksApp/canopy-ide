//! A small detached process that owns terminal PTYs so they survive the Canopy
//! app quitting, updating or crashing. The app talks to it over a Unix socket,
//! or on Windows a per-user named pipe (`windows.rs`), with the same protocol.
//!
//! On any other platform the crate is just the wire types, and the binary is a
//! stub so sidecar packaging still has a file to ship.

pub mod protocol;

#[cfg(any(unix, windows))]
pub mod client;
#[cfg(any(unix, windows))]
pub mod server;
#[cfg(windows)]
pub mod windows;

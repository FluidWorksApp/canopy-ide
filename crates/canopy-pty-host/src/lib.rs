//! A small detached process that owns terminal PTYs so they survive the Canopy
//! app quitting, updating or crashing. The app talks to it over a Unix socket.
//!
//! Unix only: on other platforms the crate is just the wire types, and the
//! binary is a stub so sidecar packaging still has a file to ship.

pub mod protocol;

#[cfg(unix)]
pub mod client;
#[cfg(unix)]
pub mod server;

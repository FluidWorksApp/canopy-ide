//! Canopy's own terminal, end to end: a native window (`canopy-term-window`)
//! driven by a headless session (`canopy-term-session`) whose bytes come from
//! a session of the persistent PTY host (`canopy-pty-host`).
//!
//! ```text
//! window (winit, wgpu, IME, AccessKit)
//!   | frames (damage-driven)          ^ key, text, paste, mouse, focus
//!   v                                 |
//! Session  (screen, replies, sync hold)         canopy-term-session
//!   | SessionLink                     ^
//!   v                                 |
//! StreamLink (reader, writer, resizer threads)  this crate: link
//!   | unix socket                     ^
//!   v                                 |
//! canopy-pty-host session (attach, ring replay) this crate: host
//! ```
//!
//! * [`args`], [`config`] and [`paths`]: the command line, the config file and
//!   the socket location, pure.
//! * [`link`]: [`link::StreamLink`], a non-blocking [`SessionLink`] over any
//!   blocking stream, with bounded queues, coalesced wakeups and no
//!   allocation in steady state. Tested on every OS with fake streams.
//! * `host` (unix): spawn or attach through the host's client and wrap the data
//!   connection in a `StreamLink`. Tested against a stand-in host that speaks
//!   the real wire format.
//! * [`app`]: wires the three together and runs the window.
//!
//! [`SessionLink`]: canopy_term_session::SessionLink

#![forbid(unsafe_code)]

pub mod app;
pub mod args;
pub mod config;
#[cfg(unix)]
pub mod host;
pub mod link;
pub mod paths;

pub use app::run;

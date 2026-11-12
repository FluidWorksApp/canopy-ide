//! The frame contract: what an emulator produces and a renderer draws.
//!
//! `frame` is deliberately plain data with no dependencies, so the screen-state
//! track and the renderer track can build against it independently. Extend it
//! by adding fields with defaults, never by changing the meaning of existing
//! ones. `screen` is the headless emulator behind a small `Screen` type; no
//! emulator types leak through its API.
//!
//! There are two engines behind that API. `screen` (feature `screen`, the
//! default for consumers today) is built on `alacritty_terminal`. `ghostty`
//! (feature `ghostty`, off by default) is the same `Screen` on libghostty-vt,
//! the engine the project is moving to; it is exported as [`GhosttyScreen`] so
//! both can be built and tested side by side until it matches.

#[cfg(feature = "screen")]
mod filter;
pub mod frame;
#[cfg(feature = "screen")]
pub mod screen;
#[cfg(any(feature = "screen", feature = "ghostty"))]
mod shared;

#[cfg(feature = "ghostty")]
pub mod ghostty;

#[cfg(feature = "screen")]
pub use screen::Screen;

#[cfg(feature = "ghostty")]
pub use ghostty::Screen as GhosttyScreen;

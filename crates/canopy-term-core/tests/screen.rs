//! Must-prove behaviour of `Screen`, run against each engine. Synthetic fixtures
//! only. The suite itself lives in `tests/suite/mod.rs`.

mod suite;

suite::define!(alacritty, canopy_term_core::Screen, false);

#[cfg(feature = "ghostty")]
suite::define!(ghostty, canopy_term_core::GhosttyScreen, true);

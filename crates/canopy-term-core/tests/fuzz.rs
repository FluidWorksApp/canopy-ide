//! Seeded robustness tests for `Screen`, run on each engine. The tests live in
//! `tests/suite/fuzz.rs`.

mod suite;

suite::fuzz::define!(alacritty, canopy_term_core::Screen, false);

#[cfg(feature = "ghostty")]
suite::fuzz::define!(ghostty, canopy_term_core::GhosttyScreen, true);

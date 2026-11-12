//! The 18 conformance fixtures, run through `Screen` on each engine. The
//! fixtures live in `tests/suite/conformance.rs`.

mod suite;

suite::conformance::define!(alacritty, canopy_term_core::Screen);

#[cfg(feature = "ghostty")]
suite::conformance::define!(ghostty, canopy_term_core::GhosttyScreen);

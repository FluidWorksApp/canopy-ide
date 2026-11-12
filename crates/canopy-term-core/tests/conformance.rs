//! The 18 conformance fixtures, run through `Screen`. The fixtures live in
//! `tests/suite/conformance.rs`.

mod suite;

suite::conformance::define!(screen, canopy_term_core::Screen);

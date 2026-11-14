//! Seeded robustness tests for `Screen`. The tests live in `tests/suite/fuzz.rs`.

mod suite;

suite::fuzz::define!(screen, canopy_term_core::Screen, true);

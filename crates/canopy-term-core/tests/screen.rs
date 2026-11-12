//! Must-prove behaviour of `Screen`. Synthetic fixtures only. The suite itself
//! lives in `tests/suite/mod.rs`.

mod suite;

suite::define!(screen, canopy_term_core::Screen, true);

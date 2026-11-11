# cargo-fuzz targets for canopy-term-core

Optional, manual, and not run by CI. The deterministic seeded tests in
`../tests/fuzz.rs` are what CI runs; these targets let a coverage-guided
fuzzer look for what those do not reach.

```sh
cargo install cargo-fuzz        # once
rustup toolchain install nightly # cargo-fuzz needs nightly
cd crates/canopy-term-core
cargo +nightly fuzz run screen                       # runs until stopped
cargo +nightly fuzz run screen -- -max_total_time=300 -max_len=65536
```

`screen` takes `cols, rows, chunk size, scrollback` from the first four bytes
and the rest as the PTY stream. It asserts that `Screen::advance` does not
panic, that the frame is consistent (cell count, cursor inside the grid,
cluster table), that feeding the stream in chunks gives the same screen as one
`advance`, and that `snapshot -> restore -> snapshot` is stable.

A crash is saved under `fuzz/artifacts/screen/`. Reproduce it with
`cargo +nightly fuzz run screen fuzz/artifacts/screen/<file>`, then turn the
bytes into a case in `tests/fuzz.rs` (the corpus in `corpus()`), so CI keeps
covering it. The corpus and artifacts directories are git-ignored; use only
synthetic input, never real session output.

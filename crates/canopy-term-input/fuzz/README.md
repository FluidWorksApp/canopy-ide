# cargo-fuzz targets for canopy-term-input

Optional, manual, and not run by CI (CI runs `../tests/fuzz.rs`).

```sh
cargo install cargo-fuzz        # once
rustup toolchain install nightly # cargo-fuzz needs nightly
cd crates/canopy-term-input
cargo +nightly fuzz run encode -- -max_total_time=300
```

`encode` builds a key, mouse, paste or focus event and a `Modes` value from the
input bytes (the tail becomes event text) and asserts that no encoder panics,
that each only appends to the buffer, and that the return value says whether
anything was written. A crash is saved under `fuzz/artifacts/encode/`; add the
event to `tests/fuzz.rs` so CI keeps covering it. Use only synthetic input.

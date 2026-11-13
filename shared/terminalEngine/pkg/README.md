# Prebuilt terminal engine

`canopy-term-core` (libghostty-vt) compiled to WebAssembly by the
`Terminal engine (wasm)` job in `.github/workflows/ci.yml`, with the
wasm-bindgen glue for the `web` target. It is committed so that building the
frontend needs neither Rust nor Zig, and so the terminal tests run the real
engine.

Do not edit these files. `SOURCE_HASH` records the sources they were built
from; CI fails when the sources change without a rebuild. To refresh them
after changing `crates/canopy-term-core`, `crates/canopy-term-input` or
`crates/canopy-term-wasm`:

    scripts/update-terminal-engine.sh <id of the CI run on that commit>

# Vendored libghostty-vt-sys 0.2.2

A copy of `libghostty-vt-sys` 0.2.2 from crates.io (MIT OR Apache-2.0, the
same licence as the published crate; upstream:
https://github.com/Uzaaft/libghostty-rs). It is used only by the
`canopy-term-wasm` workspace, through `[patch.crates-io]`, so the native
crates (`canopy-term-core`, `canopy-term-app`, ...) keep the published crate.

One change, in `build.rs` `zig_target`: the Rust target
`wasm32-unknown-unknown` maps to Zig's `wasm32-freestanding`. Upstream panics
on any target outside its list. Everything else, including the pinned ghostty
commit (a887df42), is unchanged. Drop this copy when upstream maps the target.

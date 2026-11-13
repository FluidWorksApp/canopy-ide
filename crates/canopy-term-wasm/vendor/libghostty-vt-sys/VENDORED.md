# Vendored libghostty-vt-sys 0.2.2

A copy of `libghostty-vt-sys` 0.2.2 from crates.io (MIT OR Apache-2.0, the
same licence as the published crate; upstream:
https://github.com/Uzaaft/libghostty-rs). It is used only by the
`canopy-term-wasm` workspace, through `[patch.crates-io]`, so the native
crates (`canopy-term-core`, `canopy-term-app`, ...) keep the published crate.

Two changes in `build.rs`, both only for wasm32:

- `zig_target`: the Rust target `wasm32-unknown-unknown` maps to Zig's
  `wasm32-freestanding`. Upstream panics on any target outside its list.
- The include directory is the source tree's `include/`: ghostty's wasm32
  build installs the static archive but not the headers.

And one in `src/bindings.rs`: the 46 generated layout assertions (sizes and
offsets computed by bindgen on a 64-bit host) are compiled only where
`target_pointer_width = "64"`. The structs use `usize`, pointers and the
headers' own fixed-width fields, so their layout follows the target; on
wasm32 the parity test (native and wasm screens must hash the same) is what
catches a layout mistake. Everything else, including the pinned ghostty
commit (a887df42), is unchanged. Drop this copy when upstream maps the target.

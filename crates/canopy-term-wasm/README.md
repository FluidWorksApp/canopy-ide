# canopy-term-wasm

`canopy-term-core` (the libghostty-vt engine the native window uses) built for
`wasm32-unknown-unknown`, so the same engine runs in every terminal tab: the
desktop webview on macOS, Linux and Windows, the browser portal, and the remote
host's Node server. The page keeps its byte transport, feeds PTY output to
`Terminal.advance`, and draws the packed cells it reads back (layout in
`src/lib.rs`).

On wasm32 the engine runs on the caller's thread (`canopy-term-core`'s
single-threaded path); natively it keeps its engine thread.

## Building

Same requirements as `canopy-term-core` (Zig 0.15.2, Rust 1.90), plus the
`wasm32-unknown-unknown` target and `wasm-bindgen-cli` at the crate's exact
pin. CI (`Terminal engine (wasm)` in `.github/workflows/ci.yml`) is the
reference:

```
cargo build --release --lib --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/canopy_term_wasm.wasm
```

The published `libghostty-vt-sys` has no wasm target mapping; this workspace
patches in a vendored copy with one added line (`vendor/libghostty-vt-sys/VENDORED.md`).

## Checks

- `cargo test`: packing, split independence, events (native).
- `js/smoke.mjs`: the wasm build under Node (text, colours, replies, title,
  events, scrollback cap, resize, snapshot restore, memory for 20 terminals).
- `js/parity.mjs` with `examples/digest.rs`: five generated streams
  (`js/streams.mjs`) must give the same screen digest natively and in wasm.

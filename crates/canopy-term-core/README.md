# canopy-term-core

The frame contract (`frame`: plain data a renderer draws) and `Screen`, the
headless terminal that turns PTY bytes into frames. The engine behind `Screen`
is **libghostty-vt** (the VT core of Ghostty, MIT; the `libghostty-vt` Rust
crate is MIT OR Apache-2.0). It is the only engine: the earlier
`alacritty_terminal` based `Screen`, its byte filter and the engine comparison
harness are gone. `Screen`'s public API and the names consumers use
(`canopy_term_core::Screen`, `canopy_term_core::screen::*`, `frame::*`) did not
change. No libghostty-vt type appears in the public API.

Design notes, threading model, replies, events, snapshot and what the engine
does not carry are in the module docs of `src/ghostty/mod.rs`. Measured cost is
in `PERF.md`.

## Building

Building this crate, and every crate that depends on it, needs:

| requirement | value | why |
| --- | --- | --- |
| Zig | **0.15.2** exactly (major.minor must match) | `libghostty-vt-sys`'s build script runs `zig build` on ghostty's `build.zig` |
| Rust | **1.90** or newer | `libghostty-vt` is edition 2024 |
| libghostty-vt | `=0.2.2` (pinned exactly, pre-1.0) | it pins ghostty `a887df42c56f6de86c0fe6da9c4eeca37931e083`, so the engine version moves only with this line |

The crates that need Zig are the ones with `canopy-term-core` in their
dependency graph (from `cargo metadata`): `canopy-term-core`,
`canopy-term-input`, `canopy-term-render`, `canopy-term-session` and
`canopy-term-window`. `canopy-term-cli` and `canopy-term-net` do not.

Zig comes from the official release archive on <https://ziglang.org/download/>,
checked against these sha256 values (from `https://ziglang.org/download/index.json`;
the same values are in `.github/workflows/ci.yml`):

| archive | sha256 |
| --- | --- |
| `zig-x86_64-linux-0.15.2.tar.xz` | `02aa270f183da276e5b5920b1dac44a63f1a49e55050ebde3aecc9eb82f93239` |
| `zig-aarch64-macos-0.15.2.tar.xz` | `3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b` |
| `zig-x86_64-windows-0.15.2.zip` | `3a0ed1e8799a2f8ce2a6e6290a9ff22e6906f8227865911fb7ddedc3cc14cb0c` |

A plain `cargo build` / `cargo test` then works, on Linux, macOS and Windows
(native MSVC, no extra environment or flags: proven in PR #809). It needs network:
the build script `git clone`s ghostty at the pinned commit and Zig fetches its
packages from `deps.files.ghostty.org`. A cold build adds roughly 90 to 145 s
(91 s Linux musl, 111 s macOS cross, 143 s Windows in the PR #809 runs; they
vary about 2x).

Zig's optimize mode follows the Cargo profile: debug info on means a Zig Debug
build (slow, with safety checks that abort); off gives ReleaseFast. Profiles of
path dependencies are ignored, so every crate that depends on this one and is
its own workspace root sets `debug = false` for `libghostty-vt-sys` (core sets
it for all dependencies) in its own `[profile.dev]`.

### Rust version

The floor of every crate that builds the engine is 1.90 (it was 1.82 to 1.89):
`canopy-term-core`, `-input`, `-render`, `-session`, `-window`. CI uses the
stable toolchain. `canopy-term-cli` (1.82) and the Tauri app are unaffected;
they do not depend on this crate.

### Offline or vendored build

Verified in PR #809 (branch `spike/ghostty-build-proof`, `SPIKE.md`, "Build
proof"), CI run 43127243847, on ubuntu with the network namespace emptied: exit 0,
117 s, no clone, no fetch. Three inputs are vendored, plus the pinned Zig
compiler:

1. Crates: `cargo fetch --locked` (or `cargo vendor`), then `cargo build --offline --locked`.
2. ghostty source at the sys crate's `GHOSTTY_COMMIT`, without `.git` (103 MB):

   ```sh
   git init ghostty-src && cd ghostty-src
   git fetch --depth 1 https://github.com/ghostty-org/ghostty.git a887df42c56f6de86c0fe6da9c4eeca37931e083
   git checkout FETCH_HEAD && rm -rf .git
   ```

   Pin: `git archive --format=tar HEAD | sha256sum` of that tree was
   `c06531802ab5d241c730f66b99880edb39b2aa43d5b87b868298d431547d3c82`.
3. Zig package cache (565 MB, 36 package dirs): in the ghostty source dir run
   `zig build --fetch=all --global-cache-dir <vendor>/zig-global-cache`, and use its
   `p` subdirectory. Pin: `tar --sort=name --mtime=@0 --owner=0 --group=0
   --numeric-owner -cf - -C p . | sha256sum` was
   `658eb131516e85bbb01a64e3da337d1d16df7828d1fbe482703a9f90cbb1538c` (a second
   independent fetch gave the same value).

Then build with:

```sh
GHOSTTY_SOURCE_DIR=<vendor>/ghostty-src \
GHOSTTY_ZIG_SYSTEM_DIR=<vendor>/zig-global-cache/p \
cargo build --locked --offline
```

The checksums above belong to libghostty-vt-sys 0.2.2 / ghostty `a887df42`.
Bumping the crate changes the commit and therefore all of them. Not verified:
whether 565 MB is the minimum needed, a read-only vendor dir, an offline build
on macOS or Windows, aarch64 targets.

## Tests

`cargo test --locked` in this directory runs the unit tests, the behaviour suite
(`tests/screen.rs`), the 18 conformance fixtures (`tests/conformance.rs`), the
seeded fuzz tests (`tests/fuzz.rs`), the engine-specific tests
(`tests/ghostty.rs`: events, OSC 8 links, OSC 52 policy, prompt marks, threading)
and the report-only `perf` target. The suites are written once in
`tests/suite/` and instantiated for `Screen`.

Rules the tests keep:

- OSC 8: `frame::is_safe_link` accepts only `http`, `https` and `mailto`
  URIs; `file:`, `javascript:`, custom schemes and empty hosts are refused.
  `Screen::hyperlink_at` returns the raw URI and leaves the decision to the
  application, which must call `is_safe_link` before opening one.
- OSC 52: clipboard writes are events only (never applied by the core) and are
  capped; reads are denied by default and never answered, even when the host
  opts in to read-request events.
- Snapshot and restore: a restored screen continues identically, and a replayed
  history raises no events.

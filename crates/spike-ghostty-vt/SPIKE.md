# SPIKE: libghostty-vt vs the current engine (throwaway, never merge)

Numbers below were printed by CI run 43123352245 (head f75584cb) unless marked
otherwise. Runners are shared and noisy; read them as orders of magnitude.
libghostty-vt 0.2.2 (pins ghostty a887df42), Zig 0.15.2, rustc 1.99.1.

## Results

| metric | ubuntu x86_64 | macOS arm64 |
| --- | --- | --- |
| conformance, 18 fixtures, libghostty-vt | 18/18, none differ | 18/18, none differ |
| conformance, current engine | 16/18 (PERF.md, not re-run here) | same, not re-run |
| split at every byte, libghostty-vt | identical | identical |
| throughput 80x24, 4 KiB reads: libghostty-vt / current | 78.9 / 43.1 MiB/s | 62.5 / 39.6 MiB/s |
| throughput 80x24, 64 KiB reads: libghostty-vt / current | 76.7 / 59.8 MiB/s | 71.6 / 34.0 MiB/s |
| peak RSS idle: libghostty-vt / current | 3556 / 2584 KiB | 1840 / 1744 KiB |
| peak RSS, 10k scrollback lines at 80 cols: libghostty-vt / current | 10252 / 21824 KiB | 8736 / 22928 KiB |
| cold build, bench only: libghostty-vt (with Zig) / current | 124 / 20 s | 102 / 21 s |
| `unsafe {` blocks in our spike code (safe wrapper) | 0 | 0 |
| `unsafe {` blocks inside upstream wrapper / sys crate | 327 / 31 | 327 / 31 |

Notes on the numbers:

- Run 43121783026 (first push) had a cold libghostty-vt build of 122 s (ubuntu)
  and 193 s (macOS), so build time varies by about 2x between runs.
- Throughput is NOT like for like. `Screen::advance` also does the filter, frame
  rebuild and row diff; libghostty-vt's `vt_write` is the bare parser and grid.
  A fair comparison needs the RenderState API behind a `Screen` shim (not done).
- `max_scrollback` in libghostty-vt is bytes, not lines, despite the docs saying
  lines: 10_000 held 976 lines (ubuntu) and 748 (macOS) in the first run. The
  runs above use a calibrated cap of 8388608 bytes, which held 10001 lines.
- RSS is the process peak (VmHWM on Linux, `time -l` on macOS), one process per
  measurement, so it includes the runtime; the engines are in separate binaries.
- Resize: libghostty-vt reflows a wrapped line (`0123456789ABCDE`).

## Binding ergonomics

- `unsafe` we would own: 0 if we use the safe `libghostty-vt` crate (verified
  in the spike). Upstream carries 327 + 31 blocks that we would depend on.
- `!Send` / `!Sync`: all handle types, per the crate docs (read in source, not
  measured). `Screen` consumers would need a dedicated emulator thread and
  channels, or a pinned thread per session.
- Zig pin: 0.15.2 (major.minor must match exactly, per PACKAGING-LIBGHOSTTY.md;
  from `build.zig.zon`). Rust floor of the crate is 1.90, edition 2024; ours is 1.85.
- Build time added: see the table (about 80 to 100 s cold in the latest run).
- Offline / vendoring: see "Build proof" below (now verified in CI). Original note: the default build does
  `git clone` of ghostty at a pinned commit and lets Zig fetch packages from
  deps.files.ghostty.org during `cargo build`. Offline needs `GHOSTTY_SOURCE_DIR`
  plus `GHOSTTY_ZIG_SYSTEM_DIR` pointing at the deps tarball from
  PACKAGING-LIBGHOSTTY.md. Not tried.
- Cross-compile (unverified; not run): `build.rs` maps x86_64/aarch64 apple-darwin,
  x86_64/aarch64 linux gnu and musl to Zig targets; ghostty docs list macOS 13+
  and Linux glibc/musl as tier 1.
- Windows (docs only): x86_64 gnu is tier 1, aarch64 gnu is tier 2 (built, not
  tested). `build.rs` also maps msvc targets. Static archive is
  `ghostty-vt-static.lib`. Not run.
- API status: the crate says it is pre-1.0 and breaking changes are expected.

## Recommendation: NO-GO for replacing the engine now; worth a follow-up spike

For: 18/18 conformance (including X10 mouse, mode 2026 readable, sync text
reaching the grid, all of which our filter works around), reflow, about 2x lower
memory at 10k lines, and bare-parser throughput at or above ours.

Against:

1. Pre-1.0 API with expected breaking changes; exact version pin required.
2. A Zig 0.15.2 toolchain becomes a build requirement on every dev and release
   machine, a Rust 1.90 floor (ours is 1.85), and the default build needs network
   (git clone plus Zig fetches); build time rises by about 80 to 100 s cold.
3. The `!Send` constraint changes `Screen` threading.
4. The throughput gain is not proven at the `Screen` level: frame rebuild, damage,
   snapshot and the filter would still have to be rebuilt on RenderState.
5. Windows is unverified; we ship there.

Follow-up if wanted: a `Screen` shim on RenderState with damage tracking, an
offline vendored build in CI, and a Windows CI run.

## Not verified

(Superseded by "Build proof" for builds.) Throughput at the
`Screen` level; the current engine's conformance in this job; anything about
scrollback bytes per line beyond the 80 column case.

## Build proof (CI run 43127243847, head d4c9b4b2, PR #809)

Everything below is copied from RESULT lines in that run. Same pins as above:
libghostty-vt 0.2.2, ghostty a887df42c56f6de86c0fe6da9c4eeca37931e083, Zig 0.15.2
(official ziglang.org archives, sha256 checked), rustc 1.99.1.

| target | runner | build | cold build time | conformance (18 fixtures) |
| --- | --- | --- | --- | --- |
| x86_64-pc-windows-msvc (native) | windows-2022 | pass, no extra env or flags | 143 s | 18/18, split identical, exit 0 |
| x86_64-unknown-linux-musl (cross) | ubuntu-latest | pass | 91 s | 18/18, split identical (static-pie binary, ran natively) |
| x86_64-apple-darwin (cross) | macos-15 (arm64) | pass | 111 s | 18/18, split identical (run under Rosetta, which was present) |
| offline vendored, x86_64-linux-gnu | ubuntu-latest | pass | 117 s | 18/18, split identical |

Windows notes: Zig installed from the official zip (sha256
3a0ed1e8799a2f8ce2a6e6290a9ff22e6906f8227865911fb7ddedc3cc14cb0c); git
core.longpaths was unset and was not needed; no env vars, flags or MSVC setup
beyond the stock runner. Not recorded by CI: which Zig ABI the native build used
(build.rs passes no -Dtarget when host == target) and whether the resulting
binary depends on any DLL. Treat those as unverified.

### Offline build, exactly what was done (job "offline")

1. Online prefetch: `cargo fetch --locked` (crates, 202M registry for the spike
   graph); `git init` + `git fetch --depth 1 origin a887df42...` + checkout of
   https://github.com/ghostty-org/ghostty.git into `$VENDOR/ghostty-src`, `.git`
   removed (the commit was read from the -sys crate's build.rs in CI); then, in
   that source dir, `zig build --fetch=all --global-cache-dir $VENDOR/zig-global-cache`.
2. Network block: `sudo unshare --net -- setpriv --reuid=<runner> ... env ... bash -c '...'`.
   The new network namespace has only `lo` (not up), no addresses, no routes. CI
   printed that github.com, deps.files.ghostty.org and index.crates.io fail to
   resolve inside it, and again inside the build step itself.
3. Build inside that namespace with a fresh `CARGO_TARGET_DIR`:
   `GHOSTTY_SOURCE_DIR=$VENDOR/ghostty-src GHOSTTY_ZIG_SYSTEM_DIR=$VENDOR/zig-global-cache/p
   cargo build --release --locked --offline --features ghostty --bin ghostty`.
   Result: exit 0, 117 s, conformance 18/18. OUT_DIR had no `ghostty-src` (no
   clone) and the build script never printed "Fetching ghostty".

### What to vendor, sizes, how to pin

| dir | what | size (CI) | pin |
| --- | --- | --- | --- |
| `~/.cargo/registry` (or `cargo vendor`) | crates for the spike graph | 202M (registry incl. unpacked sources) | `Cargo.lock` (sha256 of the spike lock: 7de0772a69bcbab944e0427fb4fc8a346de44ca3c1bb020b587fd3adf599c601) |
| `ghostty-src` | ghostty tree at the -sys crate's `GHOSTTY_COMMIT`, no `.git` | 103M | commit a887df42c56f6de86c0fe6da9c4eeca37931e083; `git archive --format=tar HEAD \| sha256sum` = c06531802ab5d241c730f66b99880edb39b2aa43d5b87b868298d431547d3c82 |
| `zig-global-cache/p` | Zig package cache, passed as `GHOSTTY_ZIG_SYSTEM_DIR` | 565M, 36 package dirs, 29991 files | dir names are Zig content hashes taken from ghostty's build.zig.zon; `tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - -C p . \| sha256sum` = 658eb131516e85bbb01a64e3da337d1d16df7828d1fbe482703a9f90cbb1538c; per-file `sha256sum` manifest sha256 = 1586a0d54a3d83ae4ceb4811f9721fc1645730cb29fc919225ba353b9dcfec9a |

A second independent `zig build --fetch=all` into another directory produced the
same tar sha256 and the same package list, so the Zig cache is reproducible.
The `zig-global-cache` dir also holds an empty-ish `tmp`; only `p` is used. The
Zig compiler itself is a fourth pinned input (sha256 values are in the workflow).
Bumping libghostty-vt-sys changes the commit and therefore all three checksums.

Not verified: that the 565M is the minimum needed (it is everything
`--fetch=all` pulls, including packages for non-VT targets, and no trimming was
tried); building with a read-only vendor dir; offline on macOS or Windows;
aarch64 targets; Windows ABI and DLL dependency of the built binary; musl
binaries on a real musl host (it ran on glibc Ubuntu); x86_64 macOS on real
Intel hardware (Rosetta only); build times beyond this one run (they vary about
2x run to run).

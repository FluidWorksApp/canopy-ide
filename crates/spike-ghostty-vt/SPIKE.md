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
- Offline / vendoring (docs and source, unverified in CI): the default build does
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

macOS x86_64, Linux musl and Windows builds; the offline build; throughput at the
`Screen` level; the current engine's conformance in this job; anything about
scrollback bytes per line beyond the 80 column case.

# Performance numbers (report only)

Nothing asserts on timing. Numbers come from the `PERF` lines printed by
`tests/perf_report.rs` in a real CI run.

* Source run: CI run 42993771225, commit `953b710a` (jobs `Terminal crates`).
* Profile: `cargo test` (dev profile, no `--release`): this crate is unoptimised
  and debug-asserted. Only the text dependencies (rustybuzz, ttf-parser, swash,
  zeno, yazi, skrifa, read-fonts) are built at `opt-level = 3` through
  `[profile.dev.package.*]`. Shipping numbers will be better.
* Grid: 120 x 40 synthetic code-like text, 14 px bundled JetBrains Mono, cell
  8 x 18 px, 3377 visible quads for a full frame. Runners are shared virtual
  machines; expect noise.

| | ubuntu-latest (x86_64) | macos-15 (aarch64) | windows-2022 (x86_64) |
|---|---|---|---|
| Full frame build, per frame | 15.7 ms | 21.4 ms | 16.7 ms |
| Full frame, quads per second | 215,000 | 158,000 | 202,000 |
| One-row damage build, per frame | 0.39 ms | 0.54 ms | 0.43 ms |
| One-row damage, quads per second | 211,000 | 153,000 | 192,000 |
| Quads: full frame / one row | 3377 / 83 | 3377 / 83 | 3377 / 83 |
| Unchanged frame build | about 0 us (zero quads) | about 1 us | about 0 us |
| Glyph atlas: shape + rasterise + pack 91 ASCII glyphs, cold | 1.5 ms | 1.8 ms | 2.1 ms |
| Same 91 shaped again (all atlas hits) | 0.30 ms | 0.25 ms | 0.27 ms |
| Allocator alone: pack 4000 8x16 bitmaps into 1024 x 1024 | 8.6 ms | 6.4 ms | 6.8 ms |
| Parse one font face (done once per face) | 40 us | 63 us | 205 us |

One-row damage costs about 2.5% of a full frame build (83 of 3377 quads).

## Bytes sent to the GPU

CPU-side counts for the 120 x 40 grid (identical on all runners):

| | bytes |
|---|---|
| Instance (one quad) | 32 |
| Instance buffer (120 x 40 x 6 slots x 32) | 921,600 |
| Full-frame rebuild upload (used instances only, per-row ranges) | 108,064 |
| One-row rebuild upload | 2,656 |
| Cold ASCII glyphs added to the atlas | 27,232 |

Measured on the real GPU in the golden test (24 x 5 grid, `Rgba8Unorm` target),
macOS Metal and Windows WARP:

| | bytes |
|---|---|
| First sync, instances (buffer created and fully written) | 23,040 |
| First sync, atlas (whole 512 x 512 texture, once per renderer) | 1,048,576 |
| One row changed, instances | 256 |
| One row changed, atlas (new glyphs for the changed text only) | 864 |

The first sync uploads the whole atlas because a renderer created after glyphs
were packed has not seen the earlier dirty rectangles; steady state uploads only
new glyphs.

## What changed from the first measurement

The first CI run with the perf target (run 42989818351, same code except the
change below, text dependencies unoptimised) showed full frames at about
2.5 s and one row at about 60 ms on all three runners. Two causes, both fixed in
this run's commit:

1. A `rustybuzz::Face` was parsed for every shaped run; each face is now parsed
   once and kept.
2. Dependencies compiled unoptimised under `cargo test`; the text crates are now
   optimised through the dev profile override.

Both together gave roughly a 150x improvement; the split between them was not
measured separately.

## Not measured

* GPU frame time: runners offer a software or paravirtual adapter, so GPU
  timings would say nothing about real hardware. Linux has no adapter.
* Memory use, scrolling throughput, and very large grids.
* Fallback fonts and colour emoji.

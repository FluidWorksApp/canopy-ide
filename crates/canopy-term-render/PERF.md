# Performance numbers

Nothing asserts on timing. Two allocation budgets are enforced (see below).
Numbers come from the `PERF` lines printed by `tests/perf_report.rs` in a real
CI run.

* Source run: CI run 43005045932, commit `849e3a50` (jobs `Terminal crates`).
  Later commits only add a branch on the measured path that is skipped at the
  default grid origin.
* Profile: `cargo test` (dev profile, no `--release`): this crate is unoptimised
  and debug-asserted. Only the text dependencies (rustybuzz, ttf-parser, swash,
  zeno, yazi, skrifa, read-fonts) are built at `opt-level = 3` through
  `[profile.dev.package.*]`. Shipping numbers will be better.
* Grid: 120 x 40 synthetic code-like text, 14 px bundled JetBrains Mono, cell
  8 x 18 px, 3377 visible quads for a full frame. Runners are shared virtual
  machines; expect noise.

| | ubuntu-latest (x86_64) | macos-15 (aarch64) | windows-2022 (x86_64) |
|---|---|---|---|
| Full frame build, per frame | 9.8 ms | 17.0 ms | 9.7 ms |
| Full frame, quads per second | 344,000 | 198,000 | 349,000 |
| One-row damage build, per frame | 0.25 ms | 0.42 ms | 0.24 ms |
| One-row damage, quads per second | 337,000 | 200,000 | 341,000 |
| Quads: full frame / one row | 3377 / 83 | 3377 / 83 | 3377 / 83 |
| Unchanged frame build | about 1 us (zero quads) | about 1 us | about 0 us |
| Glyph atlas: shape + rasterise + pack 91 ASCII glyphs, cold | 4.1 ms | 5.0 ms | 4.8 ms |
| Same 91 shaped again (all atlas hits) | 0.33 ms | 0.25 ms | 0.26 ms |
| Allocator alone: pack 4000 8x16 bitmaps into 1024 x 1024 | 8.0 ms | 8.3 ms | 6.9 ms |
| Parse one font face (done once per face) | 57 us | 79 us | 125 us |

One-row damage costs about 2.5% of a full frame build (83 of 3377 quads). The
cold glyph number includes building the first shaping plan.

## Heap allocations per frame

Counted by a counting global allocator in `tests/perf_report.rs`; identical on
all three runners.

| | allocations | bytes |
|---|---|---|
| Unchanged frame (5000 frames) | 0 in total | 0 |
| One row changed, steady state (`build_one_row_steady`) | 36 | 2,160 |
| Full frame rebuild | 1,354 | 85,728 |

Enforced: an unchanged frame allocates nothing, and a steady one-row build
stays within 72 allocations (twice the measured count).

Before shaping plans were cached (run 43002883748, commit `a1b0405e`) the same
builds made 682 allocations (324,208 bytes) per changed row and 26,966
(12.9 MB) per full frame: rustybuzz built a new shaping plan for every run.
Caching plans per (face, script, ligature setting) also cut full-frame time
on Linux and Windows from about 16.5 ms to about 9.7 ms.

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
macOS Metal and Windows WARP (the GPU golden is skipped on Linux, which has no
adapter):

| | bytes |
|---|---|
| First sync, instances (buffer created and fully written) | 23,040 |
| First sync, atlas (whole 512 x 512 texture, once per renderer) | 1,048,576 |
| One row changed, instances | 256 |
| One row changed, atlas (new glyphs for the changed text only) | 864 |

The first sync uploads the whole atlas because a renderer created after glyphs
were packed has not seen the earlier dirty rectangles; steady state uploads only
new glyphs.

## Earlier fixes

The first CI run with the perf target (run 42989818351) showed full frames at
about 2.5 s and one row at about 60 ms on all three runners. Two causes, fixed
in commit `953b710a`:

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
* Fallback fonts and colour emoji; `FontBook::index_fallbacks` on a real font
  set.

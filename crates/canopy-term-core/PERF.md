# canopy-term-core: emulator choice and measured cost

Report only. Nothing in the test suite asserts on timing. Numbers come from CI
run 42988596108 (`Terminal crates` job on GitHub-hosted runners), built with the
`dev` profile at `opt-level = 3` and dependency debug assertions off (set in
`Cargo.toml`, because `cargo test` is otherwise unoptimised). Runners are shared
and noisy: read these as orders of magnitude, not as benchmarks. Reproduce with
`cargo test --locked --test compare --test perf` (both targets have
`harness = false`, so they print without `--nocapture`).

## Emulator choice

| candidate | licence | result |
| --- | --- | --- |
| `alacritty_terminal` 0.26 | Apache-2.0 | **chosen.** Builds headless on ubuntu, macOS and windows. Reflows on resize, per-cell strikethrough and hidden, combining marks kept per cell, kitty keyboard flags and focus events readable, scrollback readable through `&self`. 2x vt100 throughput. |
| `vt100` 0.18 | MIT | dropped. No strikethrough or hidden attribute (SGR 8 and 9 are discarded, no accessor), no reflow on resize (truncates), scrollback readable only through `&mut`. Mode gaps (1004, 2026, kitty) can be tracked through its callbacks, but a reset (`ESC c`) does not reach them. |
| `wezterm-term` | MIT | dropped without a CI run. Not published on crates.io (git dependency only), and its tree pulls `terminfo`, which is WTFPL (not MIT/Apache/BSD). 272 packages in the lock against 51 now. |

Conformance on 18 synthetic fixtures (`tests/compare.rs`), identical on all
three operating systems:

| engine | fixtures passed | what fails |
| --- | --- | --- |
| vt100 | 16 / 18 | mode state stale after `ESC c`; SGR 8 (hidden) and 9 (strike) not exposed |
| alacritty_terminal, default sync timer | 15 / 18 | text sent after `CSI ? 2026 h` is held in the processor behind a 150 ms wall-clock timer (never reaches the grid, and is in no snapshot); X10 mouse (mode 9) and mode 2026 not readable |
| alacritty_terminal, pass-through sync | 16 / 18 | X10 mouse (mode 9) and mode 2026 not readable |

`Screen` uses the pass-through variant (a `Timeout` that never defers) and
tracks 2026 and mode 9 itself with a small second parse of the same stream, so
the screen never depends on time and a snapshot taken mid-update is complete.
Both engines are byte-split safe (identical screen at every split point).

Resize of a line wrapped at 10 columns, widened to 20: alacritty gives
`0123456789ABCDE` (reflow), vt100 gives `0123456789` / `ABCDE`.

## Screen numbers

Throughput is `Screen::advance` (parse plus frame rebuild plus row diff) over a
32 MiB deterministic mixed stream (prose, 16/256/truecolour SGR, cursor
addressing, erases, scroll regions, wide and combining text). Engine-only
throughput (no frame rebuild) from `tests/compare.rs` is shown for scale; it
runs at 120x40, a different grid from the two `Screen` sizes above it.

| metric | ubuntu | macOS (arm64) | windows |
| --- | --- | --- | --- |
| parse 80x24, 4 KiB reads | 44.3 MiB/s | 51.6 MiB/s | 53.5 MiB/s |
| parse 200x50, 4 KiB reads | 19.1 MiB/s | 29.6 MiB/s | 24.8 MiB/s |
| parse 80x24, 256 KiB reads | 64.2 MiB/s | 76.2 MiB/s | 74.1 MiB/s |
| engine only (alacritty, pass-through), 120x40 | 82.1 MiB/s | 104.1 MiB/s | 94.1 MiB/s |
| engine only (vt100), 120x40 | 38.5 MiB/s | 34.5 MiB/s | 54.3 MiB/s |
| advance with a one-line update, 80x24 | 27.5 us | 14.1 us | 19.8 us |
| advance with a one-line update, 200x50 | 141.2 us | 68.2 us | 100.4 us |
| `frame()` clone, 80x24 / 200x50 | 0.9 / 4.8 us | 1.3 / 3.7 us | 0.9 / 4.0 us |
| `snapshot()` of a sparse screen, 80x24 (523 B) / 200x50 (1018 B) | 4.7 / 16.6 us | 5.1 / 15.1 us | 3.9 / 13.1 us |
| `damage_since()` | 0.04 to 0.11 us | 0.04 to 0.10 us | 0.06 us |

Memory per session (heap bytes requested and still live, from a counting global
allocator, so not resident pages; the scrollback was actually filled to its
10,000-line limit; identical to within 1 KiB on all three operating systems):

| session | idle, empty | scrollback filled | per scrollback line |
| --- | --- | --- | --- |
| 80x24, 10k scrollback | 2.1 MiB | 20.9 MiB | 1972 B (24 B per cell) |
| 200x50, 10k scrollback | 2.7 MiB | 48.9 MiB | 4853 B (24 B per cell) |

Reading these:

* About 2,048 KiB of every idle figure is a 2 MiB buffer the engine's default
  synchronized-output handling allocates up front (`SYNC_BUFFER_SIZE` in vte,
  allocated for any `Processor`, including the pass-through one `Screen` uses).
  `Screen` never writes to it, so it is address space the OS need not back with
  pages, but the allocator counts it. Without it an idle session is about
  130 KiB at 80x24 and 670 KiB at 200x50.
* The snapshot timings are for nearly blank screens (a few lines of text); a
  full screen of styled text produces a larger snapshot and takes longer.

* The per-call frame rebuild is the cost to watch. At 4 KiB reads it lowers
  throughput well below the bare engine (82 to 104 MiB/s at 120x40 against 44 to
  54 MiB/s at 80x24, different grid sizes, so only roughly comparable) and costs
  more at 200x50, because `advance` converts the whole grid and diffs it on
  every call. Larger
  reads amortise it (64 to 76 MiB/s at 256 KiB). If it matters, the engine's
  own damage tracking can limit the rebuild to changed lines; not done here.
* Scrollback dominates memory: 24 bytes per cell, so a 10k-line scrollback is
  about 20 MiB at 80 columns and 49 MiB at 200 columns per session.

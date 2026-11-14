# canopy-term-core: engine and measured cost

The terminal engine is **libghostty-vt** 0.2.2 (ghostty `a887df42`). Build
requirements, the Zig pin and the offline recipe are in `README.md`.

Report only: nothing in the test suite asserts on timing. Reproduce the
`Screen` numbers with `cargo test --locked --test perf`; the target has
`harness = false`, so it prints without `--nocapture`. The `dev` profile is
`opt-level = 3` with dependency debug assertions off (set in `Cargo.toml`),
because `cargo test` is otherwise unoptimised and, with debug info on, would
build libghostty-vt in Zig's Debug mode.

## Screen on libghostty-vt: what CI printed

Copied from CI run 43160936234 (PR #830, commit 92dbb04b), GitHub-hosted
runners, so noisy (the old engine's own numbers moved by 1.7x between runs).
One run each, no repeats; nothing here was measured anywhere else.

`cargo test --locked --test perf` in the "Terminal crates" job (dev profile,
`opt-level = 3`). The `snapshot()` rows are the snapshot with tab stops, which
every snapshot now carries.

| metric | ubuntu | macos (aarch64) | windows |
| --- | --- | --- | --- |
| idle session 80x24, 10k scrollback allowed, empty | 79 KiB | 78 KiB | 78 KiB |
| 80x24 with scrollback filled (10000 lines held) | 79 KiB | 79 KiB | 79 KiB |
| idle session 200x50, empty | 394 KiB | 395 KiB | 394 KiB |
| 200x50 with scrollback filled (10000 lines held) | 394 KiB | 395 KiB | 394 KiB |
| parse throughput 80x24 (4 KiB reads, 32 MiB mixed stream) | 108.1 MiB/s | 78.4 MiB/s | 130.5 MiB/s |
| parse throughput 200x50 (4 KiB reads) | 90.4 MiB/s | 65.3 MiB/s | 113.9 MiB/s |
| parse throughput 80x24 (256 KiB reads) | 108.2 MiB/s | 76.5 MiB/s | 130.7 MiB/s |
| 80x24 advance with one-line update | 0.1 us | 0.1 us | 0.1 us |
| 80x24 frame() clone (1920 cells) | 36.6 us | 20.9 us | 6.9 us |
| 80x24 snapshot() (611 bytes) | 41.3 us | 24.6 us | 31.7 us |
| 80x24 damage_since() (2 damaged rows) | 36.54 us | 8.42 us | 1.63 us |
| 200x50 frame() clone (10000 cells) | 39.1 us | 22.2 us | 31.4 us |
| 200x50 snapshot() (1223 bytes) | 55.5 us | 35.3 us | 34.6 us |
| 200x50 damage_since() (2 damaged rows) | 28.82 us | 12.18 us | 1.24 us |

The test also prints "per scrollback line: 0 B" and idle and filled sizes that
are equal; that probe does not show a scrollback cost (why was not
investigated), so do not read it as a cost of zero. The peak process RSS from
the perf-compare workflow below does show one.

perf-compare workflow (`crates/perf-compare`, same stream and read sizes,
interleaved, 5 runs, median with min..max and the ratio to bare `vt_write`).
The last column is headed "old Screen" by `summarize.py`, but it times
`canopy_term_core::Screen::advance` (`src/main.rs` uses the current `Screen`),
which is the current engine behind its worker thread. The label is stale.

| os | reads | bare vt_write | GhosttyScreen end-barrier | GhosttyScreen seq() per read | GhosttyScreen frame() per read | `Screen::advance` ("old Screen") |
| --- | --- | --- | --- | --- | --- | --- |
| ubuntu | 4 KiB | 81.0 (80.9..81.4) | 68.9 (68.4..69.3) (0.85) | 13.0 (13.0..13.2) (0.16) | 12.7 (12.6..12.8) (0.16) | 78.4 (77.3..78.5) (0.97) |
| ubuntu | 64 KiB | 80.4 (79.0..81.5) | 68.5 (68.2..68.9) (0.85) | 53.7 (53.4..54.0) (0.67) | 53.5 (53.3..53.6) (0.67) | 78.3 (76.7..78.5) (0.97) |
| macos | 4 KiB | 78.8 (74.8..86.5) | 69.2 (66.3..78.3) (0.88) | 21.6 (17.6..24.1) (0.27) | 22.0 (20.5..23.4) (0.28) | 69.4 (65.2..90.6) (0.88) |
| macos | 64 KiB | 86.2 (81.0..93.2) | 63.5 (59.5..78.5) (0.74) | 59.3 (57.5..73.8) (0.69) | 68.6 (60.0..68.9) (0.80) | 84.3 (71.8..88.3) (0.98) |

Peak RSS, one process each, 10k scrollback lines (KiB): bare ghostty idle /
filled, `GhosttyScreen`, `Screen`.

| os | bare idle | bare filled | GhosttyScreen idle | GhosttyScreen filled | Screen idle | Screen filled |
| --- | --- | --- | --- | --- | --- | --- |
| ubuntu (VmHWM) | 3488 | 10148 | 4128 | 13000 | 3796 | 12448 |
| macos (time -l) | 1840 | 8736 | 2512 | 11552 | 2400 | 11264 |

Not measured: windows in perf-compare (the workflow does not run there), CPU
profile of this change, the cost of the larger snapshot against the previous
one (no baseline was run on this commit's parent).

Costs of the new engine that do not depend on a benchmark: one OS thread per
`Screen` (the engine's handles are `!Send`, see `src/ghostty/mod.rs`), a cold
build that is 90 to 145 s longer, and a 565 MB Zig package cache for an offline
build.

---

# History: the previous engine (removed)

The numbers below come from CI run 43002266592 (commit 297673bf) on
GitHub-hosted runners, noisy: the same unchanged engine measured 79 MiB/s in
that run and 138 MiB/s in an earlier run on ubuntu. `tests/compare.rs`, the
`alacritty_terminal` adapter, `src/filter.rs` and `vt100` are deleted.

## Emulator choice

| candidate | licence | result |
| --- | --- | --- |
| `alacritty_terminal` 0.26 | Apache-2.0 | **chosen.** Builds headless on ubuntu, macOS and windows. Reflows on resize, keeps strikethrough and hidden per cell, keeps combining marks per cell, makes focus events readable, and reads scrollback through `&self`. About 2x the vt100 throughput. |
| `vt100` 0.18 | MIT | dropped. No strikethrough or hidden attribute (it discards SGR 8 and 9 and has no accessor). No reflow on resize: it truncates. Scrollback is readable only through `&mut`. |
| `wezterm-term` | MIT | dropped without a CI run. Not published on crates.io (git dependency only), and its tree pulls `terminfo`, which is WTFPL (not MIT/Apache/BSD). 272 packages against 51 now. |

The choice rests on the grid gaps, which a wrapper cannot fix. Mode gaps can be
tracked outside either engine, and `Screen` does so.

Kitty keyboard tracking was a point in alacritty's favour at first. It is now
switched off in the engine, because `push_keyboard_mode` at its 4096 depth limit
removes from the title stack instead and can panic (an upstream bug). The filter
in front of the engine (`src/filter.rs`) tracks the kitty stacks of both
screens, along with sync output (2026), X10 mouse and the scroll region.

Conformance on 18 synthetic fixtures (`tests/compare.rs`), identical on all
three operating systems:

| engine | fixtures passed | what fails |
| --- | --- | --- |
| vt100 | 16 / 18 | mode state stale after `ESC c`; SGR 8 (hidden) and 9 (strike) not exposed |
| alacritty_terminal, default sync timer | 15 / 18 | text sent after `CSI ? 2026 h` is held in the processor behind a 150 ms wall-clock timer, so it never reaches the grid and is in no snapshot; X10 mouse (mode 9) and mode 2026 not readable |
| alacritty_terminal, pass-through sync (what `Screen` uses) | 16 / 18 | X10 mouse and mode 2026 not readable (tracked by the filter) |

Both engines give an identical screen at every split point of the input.

Resize of a line wrapped at 10 columns, widened to 20: alacritty gives
`0123456789ABCDE` (reflow), and vt100 gives `0123456789` / `ABCDE`.

## Screen numbers

Throughput is `Screen::advance` (filter, parse, combining-mark trim, frame
rebuild and row diff) over a 32 MiB deterministic mixed stream. The stream has
prose, 16/256/truecolour SGR, cursor addressing, erases, scroll regions, and
wide and combining text. The engine-only rows come from `tests/compare.rs`,
which runs at 120x40, a different grid from the `Screen` rows.

| metric | ubuntu | macOS (arm64) | windows |
| --- | --- | --- | --- |
| parse 80x24, 4 KiB reads | 40.2 MiB/s | 47.6 MiB/s | 52.9 MiB/s |
| parse 200x50, 4 KiB reads | 17.0 MiB/s | 19.8 MiB/s | 22.7 MiB/s |
| parse 80x24, 256 KiB reads | 59.3 MiB/s | 66.1 MiB/s | 70.4 MiB/s |
| engine only (alacritty, pass-through), 120x40 | 79.0 MiB/s | 71.5 MiB/s | 93.8 MiB/s |
| engine only (vt100), 120x40 | 38.5 MiB/s | 43.9 MiB/s | 54.2 MiB/s |
| advance with a one-line update, 80x24 | 30.7 us | 27.8 us | 21.5 us |
| advance with a one-line update, 200x50 | 156.2 us | 109.8 us | 108.3 us |
| `frame()` clone, 80x24 / 200x50 | 0.9 / 5.0 us | 1.1 / 3.3 us | 0.9 / 4.2 us |
| `snapshot()` of a sparse screen, 80x24 (523 B) / 200x50 (1018 B) | 4.9 / 15.8 us | 4.1 / 15.1 us | 3.9 / 12.4 us |
| `damage_since()` | 0.04 us | 0.03 to 0.04 us | 0.06 us |

Memory per session is heap bytes requested and still live, from a counting
global allocator, so it is not resident pages. The scrollback was filled to its
10,000-line limit, and the figures match to within 1 KiB on all three operating
systems:

| session | idle, empty | scrollback filled | per scrollback line |
| --- | --- | --- | --- |
| 80x24, 10k scrollback | 2.1 MiB | 20.9 MiB | 1972 B (24 B per cell) |
| 200x50, 10k scrollback | 2.7 MiB | 48.9 MiB | 4853 B (24 B per cell) |

Reading these:

- **Idle memory.** About 2,048 KiB of every idle figure is a 2 MiB buffer that
  the engine's synchronized-output handling allocates up front
  (`SYNC_BUFFER_SIZE` in vte). It is allocated for any `Processor`, including
  the pass-through one `Screen` uses. `Screen` never writes to it, so the OS
  need not back it with pages, but the allocator counts it. Without it an idle
  session is about 130 KiB at 80x24 and 670 KiB at 200x50.
- **Snapshot timings** are for nearly blank screens (a few lines of text). A
  full screen of styled text gives a larger snapshot and takes longer.
- **Per-call frame rebuild.** This is the cost to watch: `advance` converts the
  whole grid, trims it and diffs it on every call. At 4 KiB reads that halves
  throughput against the bare engine, and the cost is higher at 200x50. Larger
  reads amortise it (59 to 70 MiB/s at 256 KiB). If it matters, the engine's
  own damage tracking can limit the rebuild to changed lines; that is not done
  here.
- **Scrollback dominates memory.** At 24 bytes per cell, a 10k-line scrollback
  is about 20 MiB at 80 columns and 49 MiB at 200 columns per session.

# canopy-term-core: emulator choice and measured cost

Report only: nothing in the test suite asserts on timing. The numbers come from
CI run 43002266592 (commit 297673bf), from the `Terminal crates` job on
GitHub-hosted runners.

- **Build.** The `dev` profile at `opt-level = 3`, with dependency debug
  assertions off. Both are set in `Cargo.toml`, because `cargo test` is
  otherwise unoptimised.
- **Noise.** Runners are shared and noisy. The same unchanged engine measured
  79 MiB/s in this run and 138 MiB/s in an earlier run on ubuntu, so read these
  as orders of magnitude, not as benchmarks.
- **Reproduce.** Run `cargo test --locked --test compare --test perf`. Both
  targets have `harness = false`, so they print without `--nocapture`.

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

The tables below were measured before the damage-driven update described in the
next section, so `advance` there includes a whole-grid rebuild and diff on every
call. Throughput is `Screen::advance` (filter, parse, combining-mark trim, frame
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
- **Per-call frame rebuild.** This was the cost to watch: `advance` converted
  the whole grid, trimmed it and diffed it on every call. At 4 KiB reads that
  halved throughput against the bare engine, and the cost was higher at
  200x50. Larger reads amortise it (59 to 70 MiB/s at 256 KiB). The next
  section describes the change that limits the work to damaged rows.
- **Scrollback dominates memory.** At 24 bytes per cell, a 10k-line scrollback
  is about 20 MiB at 80 columns and 49 MiB at 200 columns per session.

## Damage-driven frame update

`Screen::advance` no longer converts and diffs the whole grid per call. After
the bytes are fed, `refresh` asks the engine (`Term::damage`, then
`Term::reset_damage`) which lines it touched.

- **Partial damage** (same size, no forced redraw): only the damaged rows are
  converted into scratch, compared with the row already in the `Frame`, and
  copied in only if they differ. The rows that differ are what `row_seq` and
  `damage_since` report, so damage stays exact, not the engine's superset (the
  engine always damages the cursor line). The cursor, modes, title and pen are
  recomputed on every call as before, and the old and new cursor rows are still
  damaged when the cursor moves.
- **Full damage**, a resize, the first frame, or an engine that reports `Full`
  takes the previous path: convert every row and diff every row. The engine
  reports `Full` for any scroll, clear of the screen, alternate-screen switch,
  `ESC c`, DECALN, colour change, and every call while insert mode is on, so a
  stream that scrolls on most calls (ordinary command output) sees little
  change. Cursor-addressed repaints (status lines, TUIs that redraw rows in
  place) are where it helps.
- **Cluster table.** `Cell::cluster` indexes a table that a full rebuild fills
  in row-major order. When any cluster exists in the frame or in a changed row,
  the table is renumbered over the whole frame so it is byte-identical to a full
  rebuild; frames without clusters (the common case) pay nothing for this.
- **Unchanged.** `snapshot`, `frame`, `damage_since`, sequence numbers and the
  full-redraw rules (resize, alternate screen, restore) behave as before. The
  combining-mark trim still scans the visible grid after each 4 KiB slice; it
  was left alone because it is cheap next to conversion.
- **No selection.** `Screen` exposes no selection, so there is nothing to
  redraw on a selection change.

Correctness is checked by `tests/damage.rs`. It feeds two screens the same
input, one normal and one in the hidden reference mode (`set_full_rebuild`,
which rebuilds the whole grid each call) and compares the whole `Frame`
including `seq`, `damage_since` for the last 12 baselines, snapshots and
replies after every step. It also checks, without the reference, that every row
whose content differs from a remembered baseline is inside the damage reported
for that baseline. Inputs: the conformance-style fixtures whole and one byte at
a time, resize, alternate screen and snapshot restore after each fixture, the
synthetic stream at three sizes and read sizes, and seeded pseudo-random
streams (escape sequences, wide and combining text, resizes, snapshot restores,
random split points).

`cargo test --locked --test perf` prints, besides the rows above, the mixed
stream and a no-scroll cursor-addressed repaint workload for both paths
(`REFERENCE full rebuild` against incremental). Numbers from CI are recorded
below once a run has printed them.

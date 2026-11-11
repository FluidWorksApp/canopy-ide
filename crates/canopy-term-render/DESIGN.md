# canopy-term-render: design

Renders `canopy_term_core::frame::Frame`s. Everything above the GPU call is pure
CPU code with unit tests; the wgpu layer is thin and checked against a CPU
reference of the same shader.

No window and no window chrome (tabs, splits, title bar) are in this crate.
Chrome needs a mockup from the user first.

## Layers

| Module | Job | Needs GPU or fonts |
|---|---|---|
| `metrics` | Font metrics to an integer `CellLayout`; HiDPI and rounding rules | bundled font in one test |
| `atlas` | Shelf-packed glyph atlas, whole-shelf eviction, dirty rectangles, eviction epoch | no |
| `procedural` | Box drawing, blocks, Powerline drawn from the cell size | no |
| `color` | `Color` against a `Theme`; inverse, dim, hidden, bold-bright | no |
| `geometry` | Cell, underline, strike, cursor rectangles; selection ranges | no |
| `fonts` | Primary family per style, fallback faces, synthetic bold/italic | bundled font |
| `text` | Shaping (rustybuzz), rasterising (swash), atlas packing; implements `GlyphSource` | bundled font |
| `builder` | Frame + damage to the instance buffer, only changed rows | no (stub glyph source in tests) |
| `reference` | CPU compositor that does what `shader.wgsl` does | no |
| `renderer` + `shader.wgsl` | wgpu pipeline, uploads, one draw call, offscreen readback | adapter (skipped without) |
| `gpu` | Adapter probe and headless device | adapter |

## Public API a window layer needs

Everything is `pub` for testing, but a window layer only needs:

* `metrics::{FontMetrics::from_font_data, layout, Scale, CellLayout}`: cell size
  from a font and the window scale factor.
* `fonts::FontBook` (`bundled()`, `with_primary`, `add_font_data`,
  `load_system_fonts`) and `text::TextEngine::new(book, layout, atlas_size)` with
  `set_layout`.
* `color::Theme` and `builder::{QuadBuilder, RenderState}`:
  `QuadBuilder::build(&frame, &state, &mut engine) -> BuildReport`.
* `renderer::Renderer::{new, sync, render}` and, for tests,
  `renderer::Offscreen`.
* `geometry::{cursor_rect, Selection}` for IME placement and selection.

The loop is `build` -> (skip when `report.held` or nothing changed) -> `sync` ->
`render` -> present; see "Winit integration point".

## Dependencies and licences

| Crate | Use | Licence |
|---|---|---|
| wgpu 25 (and naga, ash, etc.) | GPU | MIT OR Apache-2.0 |
| fontdb | Font discovery | MIT |
| rustybuzz | Shaping (HarfBuzz port) | MIT |
| ttf-parser | Metrics, coverage | MIT OR Apache-2.0 |
| swash (with zeno) | Rasterising, colour bitmaps/outlines | MIT OR Apache-2.0 |
| bytemuck | Instance casts | Zlib OR Apache-2.0 OR MIT |
| pollster | Block on wgpu futures | Apache-2.0 OR MIT |
| png (dev only), naga (dev only) | Golden images, WGSL validation | MIT OR Apache-2.0 |
| JetBrains Mono Regular (test font, bundled) | Tests only | SIL OFL 1.1 (`fonts/JetBrainsMono-OFL.txt`) |

`cargo metadata` over the lock found no GPL, LGPL, AGPL or MPL package. Licences
outside the plain MIT/Apache set: `libloading` (ISC), `hexf-parse` (CC0-1.0),
Zlib-only packages (`foldhash`, `slotmap`, `zlib-rs`), and two packages
under `(MIT OR Apache-2.0) AND Unicode-3.0` (`unicode-ident`,
`unicode-properties`). A fresh scan of the 164 locked packages found no missing
licence field and no GPL/LGPL/AGPL/MPL. The repo-level
`THIRD-PARTY-NOTICES.md` is generated outside this crate and needs these added
when the crate is wired into the app; the bundled font needs its OFL notice there
too. No code was taken from other terminals' renderers (ideas only).

The alternative considered was `cosmic-text` (MIT OR Apache-2.0), which bundles
discovery, shaping and layout. It lays out text for editors (wrapping, bidi
lines); a terminal wants the opposite, a fixed grid where the shaper only picks
glyphs. Using the three pieces directly keeps the grid in charge.

## The grid is in charge

* Cell width/height are whole physical pixels (`metrics::layout`). Cell origins
  are `col * width`, `row * height`: integers, so cells tile with no seams.
* Glyphs are rasterised at the physical size and blitted at integer offsets.
  There is no subpixel glyph positioning and no subpixel (LCD) antialiasing;
  coverage is greyscale. HiDPI is handled by scaling the font size, not the
  surface.
* Shaper advances are ignored. A glyph goes at the cell origin plus the
  rasteriser bearing plus the shaper's mark offset. A proportional fallback face
  therefore cannot push text off the grid.
* Wide characters come from `Attrs::WIDE_TAIL` in the frame, never from a width
  table here (two tables would disagree). The head cell covers two columns; the
  tail cell is skipped.
* A grapheme cluster comes from `Frame::clusters`; its glyphs (base + marks) all
  start at the cluster's cell.
* Runs of cells with the same bold/italic are shaped as one string per face so
  ligatures and contextual alternates form. A run breaks at blanks, hidden
  cells, code-drawn glyphs and style changes. Colour does not break a run: a
  ligature takes its first cell's colour.
* Box drawing (U+2500..257F except diagonals), block elements (U+2580..259F)
  and Powerline separators E0B0..E0B3 are drawn from the cell size, so they join
  across cells exactly. Approximations: double-line junctions are plain
  overlaps, dashed lines are solid, rounded corners are square.
* Glyph quads are clipped to their run's cells, so a tall glyph can never paint
  over a neighbouring row regardless of draw order. This also clips italic
  overhang.

## Damage to quads

`QuadBuilder::build(frame, state, glyph_source)` keeps a CPU shadow of the GPU
instance buffer: a fixed region per row (`cols * 6` instances), used instances
first, the rest degenerate (zero size). A rebuilt row is one contiguous write
at a known offset, so the bytes sent are countable on the CPU.

A row is rebuilt when:

* it is in `Frame::damage`, and the damage is relative to the frame last drawn
  (`damage.since == last seq`, `since != 0`);
* everything is rebuilt when damage is not relative to the last drawn frame
  (different `since`, `since == 0`, `full`, `seq` going backwards), on resize,
  on a theme or layout change, on first use, or when the atlas epoch changed;
* its cursor or selection rendering differs from last time (these are not in
  frame damage): moving the cursor touches the old and new row, a blink touches
  one row, extending a selection touches only rows whose selected columns
  changed.

`modes.sync_output` holds the frame: nothing is built and the remembered
sequence does not advance, so the release frame's damage still applies.

Adjacent cells with the same background share one quad; underline and strike
merge across neighbours of one colour. Default-background cells emit no quad at
all (the target is cleared to the theme background). A cluster that shapes to
many glyphs can exceed a row's capacity; extras are dropped rather than
overrunning the next row.

Fonts: a used face's parsed shaping face is `'static` and built once, not per
run. Its bytes are not copied: fontdb memory-maps system font files (one
mapping per file, shared by all its faces) and the bundled font is the static
bytes themselves. A process-wide table keeps one handle per distinct byte
range for the life of the process, so many books or faces cost address space
and page cache, not heap; what stays pinned is bounded by the font files
actually used. The mapping is the usual one: a font file rewritten in place by
another process while the app runs could fault (`FontBook::load` carries the
safety note).

Atlas limit: the atlas must hold the glyphs of one frame. If it fills during a
build it is cleared (at most once per frame) and the build repeats; a screen
needing more distinct glyphs than that leaves some glyphs blank, never wrong,
and reports it (`BuildReport::atlas_overflow`; the build itself is valid, so
unchanged frames are not rebuilt, and only an atlas that kept changing under
the build forces a full rebuild next time). A bitmap larger than the atlas can ever hold is left blank without clearing.
`atlas::atlas_size_for(cell_w, cell_h, max_texture_dimension)` sizes the atlas
for about 4096 glyph cells, capped by the device limit; the window layer should
call it and rebuild with a larger atlas when `atlas_overflow` is set.

## GPU layer

* One pipeline, one draw call per frame target: instanced quads (6 vertices,
  no vertex buffer). `Instance` is 32 bytes: position, size, atlas rectangle,
  RGBA tint, flags.
* Solid rectangles sample a reserved 2 x 2 white block in the atlas, so
  backgrounds, underlines and cursors use the same pipeline as glyphs.
* Glyph masks are stored as white with coverage in alpha and tinted in the
  shader; colour bitmaps (emoji) are stored as RGBA and drawn as-is.
* Sampling is `textureLoad` on integer texels (no filtering), blending is
  premultiplied (One, OneMinusSrcAlpha), the target should be a non-sRGB format
  so the theme's bytes are written unchanged. A window surface that only
  offers sRGB formats needs a non-sRGB view format. `Renderer::new` panics on
  an sRGB format, so pick a non-sRGB surface format or list a non-sRGB entry in
  the surface's `view_formats` and render to that view.
* Uploads: instance rows that were rebuilt, and atlas rectangles written since
  the last sync (adjacent ones merged). The instance buffer is recreated only
  when the grid grew; the atlas texture is never reallocated.
* `reference::composite` is the CPU twin of the shader. The golden scene A is
  compared exactly with an image from an independent script; where an adapter
  exists the GPU render is compared within tolerance.

### Winit integration point

A window layer (not in this PR) owns a `winit` window and a `wgpu::Surface`.
On `RedrawRequested`:

1. take the latest `Frame` for this consumer;
2. `let report = builder.build(&frame, &state, &mut engine);`
3. if `report.held`, or nothing changed (`report.rows` empty and no pending
   atlas rectangles), do not present;
4. `renderer.sync(&builder, &report, engine.atlas_mut());`
5. acquire the surface texture, `renderer.render(&view, size, theme.bg, builder.draw_count())`,
   present.

On resize: reconfigure the surface, then the grid size changes the frame size;
the builder sees the new dimensions and rebuilds everything. On scale-factor
change: recompute `layout(...)`, call `builder.set_layout` and
`engine.set_layout`.

### Frame pacing: present on damage only

There is no continuous render loop. A redraw is requested only when something
visible changed:

* a new frame arrived with damage;
* the cursor blink timer ticked (one row);
* the selection, focus or theme changed;
* the window was exposed or resized.

Frames that arrive faster than the display refresh coalesce: only the newest
frame is built, and because damage is relative to the last frame this consumer
drew, nothing is lost. Present with `PresentMode::Fifo` (vsync) so a burst of
output cannot spin the GPU. While `sync_output` is set nothing is presented.
An idle terminal does no GPU work at all.

## Accessibility (design only)

Screen readers: AccessKit (Apache-2.0 / MIT) with its winit adapter.

* A `Window` node containing one `Terminal` node.
* One text-run child per visible row, in order. The row text comes from the
  frame (`Frame::text` per cell, WIDE_TAIL cells skipped, trailing blanks
  trimmed). Per character it gives lengths and cell rectangles from
  `geometry::cell_rect`, so a reader can locate and magnify text.
* The cursor is the text selection (anchor = focus) in its row's node at the
  character index of the cursor cell. A real selection maps to anchor and focus
  across row nodes.
* New output is announced through a polite live region fed from the lines that
  scrolled in, not by republishing the whole tree. Only rows in `Damage`
  produce node updates, so a screen reader's cost tracks the renderer's.
* Alt-screen programs (full-screen TUIs) republish rows on damage the same way;
  announcing every change would be unusable, so announcements are limited to
  the focused line and explicit notifications (bell, title change).

To verify by hand with VoiceOver/NVDA once a window exists.

## Input (design only)

### IME

Winit `Window::set_ime_allowed(true)` while the terminal has focus. The IME
candidate window is placed with `set_ime_cursor_area(position, size)` using the
physical-pixel rectangle `geometry::cursor_rect(layout, row, col, cols, shape)`
(for placement use the Block rect even for bar/underline cursors, and refresh
it whenever the cursor moves). `Ime::Preedit(text, range)` is drawn inline at
the cursor as an underlined overlay and is never sent to the PTY; only
`Ime::Commit(text)` is, as UTF-8 (wrapped in bracketed-paste markers only if the
program enabled them and the text is multi-line).

### Key encoding

Chosen per key event from `Frame::modes`:

* Legacy: printable keys as UTF-8; Ctrl+letter as C0; Alt as an ESC prefix;
  arrows and Home/End as `CSI A..D`/`SS3 A..D` by `app_cursor_keys` (DECCKM);
  keypad by `app_keypad` (DECKPAM); function keys `SS3 P..S`, `CSI n ~`;
  modifiers as `CSI 1 ; <mod+1> <final>`.
* xterm modifyOtherKeys (`CSI > 4 ; 2 m`): ambiguous modified keys become
  `CSI 27 ; <mod+1> ; <code> ~`. `Modes` has no field for it; the core track
  should add `modify_other_keys: u8`.
* Kitty keyboard protocol when `modes.kitty_keyboard != 0`: `CSI <code> ; <mod+1> : <event> ; <text> u`. The flag bits (1 disambiguate, 2 event types, 4 alternate
  keys, 8 all keys as escapes, 16 associated text) fit the existing `u8`.
  Release and repeat events only when flag 2 is set. A pushed/popped stack is
  the emulator's concern; the encoder reads the current flags.
* `focus_events`: `CSI I` / `CSI O` on focus change.
* `bracketed_paste`: wrap pasted text in `CSI 200 ~` ... `CSI 201 ~`, stripping
  any embedded `CSI 201 ~`.

### Mouse reporting

Reported only when `modes.mouse != Off`, in `modes.mouse_encoding`:

* Default (X10/normal): `CSI M <b+32> <x+32> <y+32>`; coordinates above 223
  cannot be expressed, so drop the event.
* UTF-8: same, with coordinates as UTF-8 above 95.
* SGR: `CSI < b ; x ; y M` for press and `m` for release; no coordinate limit.
* Button bits: 0/1/2 left/middle/right, 3 release (non-SGR), 64 wheel (+0 up,
  +1 down), +4 shift, +8 alt/meta, +16 ctrl, +32 motion.
* `Press` reports presses only; `Normal` adds releases; `Drag` adds motion with
  a button held; `Any` adds all motion. Cell coordinates come from pixel
  positions divided by the cell layout, 1-based.
* The contract has no pixel-coordinate mode (1016); add it to `MouseEncoding`
  if wanted. Shift held bypasses reporting so the user can select text.

### Bell and reduced motion

* Bell: a short visual flash of the background (one `RenderState` tint for
  ~100 ms) plus an optional audible bell; both off by user setting.
* When the operating system's reduce-motion setting is on: no cursor blink
  (`cursor_on` stays true), no bell flash (a static title/badge indicator
  instead), no animated scrolling.

### Font fallback

`FontBook::choose(ch, style)`: the primary family's face for the style if it has
the glyph; otherwise the best covering face among all loaded ones (matching
weight and slant first, then monospaced). Results are cached per
(char, style). Which face has which character comes from a per-face coverage
index (sorted codepoint ranges read from the `cmap` once, binary search per
lookup, checked against the font parser's own `glyph_index`), so a lookup never
parses a font. `FontBook::index_fallbacks` builds the index for every face; call
it at startup off the frame path (the book is plain data and `Send`, so it can
move to a worker thread and back), otherwise each face is indexed lazily the
first time a character is missing from the primary font. Opening a fallback
face the first time (mapping and parsing it) still happens on whichever thread
first draws a character from it; resolving the characters of new output ahead
of the frame (`choose` on a worker, results cached) is the integration
point if that ever shows up in a frame time. When no face has the character the primary face's missing-glyph
box is drawn. Emoji use colour bitmap (CBDT/sbix) or colour outline (COLR)
strikes and are area-resampled to the cell height. Bold and italic missing from
a face are synthesised (embolden, 14 degree skew).

## What CI can run (probe results)

`tests/gpu_probe.rs` enumerates every backend on each runner:

* ubuntu-latest: no adapter (Vulkan and GL libraries cannot be loaded). A CI
  change outside this crate could add `libvulkan1` and `mesa-vulkan-drivers`
  (lavapipe software Vulkan) to the Terminal crates job; this is untested.
* macos-15: Metal, "Apple Paravirtual device", device opens.
* windows-2022: DX12, "Microsoft Basic Render Driver" (WARP, software), device
  opens.

The golden test renders on the GPU where one exists and is skipped (and says so
in the log) where none does. The CPU reference and the WGSL validation run
everywhere.

## What is not proven here

* Real system fonts, emoji, CJK and any glyph from a face other than the bundled
  one: only the selection policy and the swash/rustybuzz path with the bundled
  font run in tests.
* Visual quality of text (no hinting, greyscale AA), colour emoji scaling, and
  how it looks at fractional HiDPI scales.
* The GPU path on Linux: CI has no adapter there (see PERF.md/PR notes). The
  shader is validated by naga and its maths by the CPU reference, not executed.
* IME, VoiceOver/NVDA and key/mouse encoding: design only.
* Right-to-left text (shaping is forced left-to-right).

## Hand test list once a window exists

1. Real GPU: text sharp, no seams between cells, box drawing joins, colours
   match the theme on a non-sRGB and an sRGB surface.
2. Real fonts: install a CJK font and an emoji font; check fallback, wide
   alignment, colour emoji size, combining marks, ligatures.
3. HiDPI: 1x, 2x and a fractional scale (1.25, 1.5); drag between displays.
4. IME: Japanese/Chinese/Korean composition, candidate window under the cursor.
5. VoiceOver (macOS) and NVDA/Narrator (Windows): row navigation, cursor,
   live output.
6. Input: modifier keys in a kitty-protocol program and a legacy one; mouse in
   vim/tmux/htop; paste with bracketed paste.
7. Idle power: an idle terminal should cause no redraws.

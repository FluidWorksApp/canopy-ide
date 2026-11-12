//! Frame + damage -> instance buffer, rebuilding only the rows that changed.
//!
//! The builder keeps a CPU shadow of the GPU instance buffer: one fixed-size
//! region per row (`cols * INSTANCES_PER_COL` instances), used instances first.
//! A rebuilt row is one contiguous write at a known offset, so what a frame
//! uploads is countable on the CPU. Rows are drawn in buffer order and glyphs
//! are clipped to their cells, so a later row can never be painted over by an
//! earlier one's overhang.
//!
//! What counts as a changed row:
//! * rows in the frame's damage, when the damage is relative to the frame this
//!   builder last drew;
//! * every row when the damage is not relative to that frame (`since` differs or
//!   is 0, the sequence went backwards, `full`), when the grid was resized, when
//!   the theme or layout changed, or when the glyph atlas may have overwritten
//!   glyphs this buffer refers to;
//! * rows whose cursor or selection rendering differs from last time, because
//!   those are not in the frame's damage.
//!
//! A frame in synchronized-output mode (`modes.sync_output`) is held: nothing is
//! rebuilt and the remembered sequence does not advance.

use crate::color::{resolve_cell, Rgb, Theme};
use crate::frame::{Attrs, Cell, CursorShape, Frame};
use crate::geometry::{cell_rect, cursor_rect, strike_rect, underline_rect, PxRect, Selection};
use crate::glyphs::{FontStyle, GlyphSource, PlacedGlyph, TextCell};
use crate::instance::Instance;
use crate::metrics::CellLayout;
use crate::procedural;

/// Capacity per column. A cell can need a background, a few glyphs (a cluster
/// can shape to several), underline, strike and cursor parts; extras past the
/// row capacity are dropped, never overrun into the next row.
pub const INSTANCES_PER_COL: usize = 6;

/// Instances reserved after the grid for the overlay (IME preedit): a
/// background, up to this minus two glyphs, and an underline.
pub const OVERLAY_INSTANCES: usize = 256;

/// Text drawn over the grid without being in the frame, for example an IME
/// preedit. Setting or clearing it rewrites only the overlay region.
#[derive(Clone, Copy, Debug)]
pub struct Overlay<'a> {
    pub row: u16,
    pub col: u16,
    /// Cells as for `GlyphSource::shape_run`; cells past the right edge of the
    /// grid are dropped.
    pub cells: &'a [TextCell<'a>],
    pub style: FontStyle,
}

struct OverlayState {
    row: u16,
    col: u16,
    cells: Vec<(String, u8)>,
    style: FontStyle,
}

/// What changes how a frame looks without being in the frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RenderState {
    pub selection: Option<Selection>,
    /// Blink phase: false hides the cursor.
    pub cursor_on: bool,
    /// Window focus: an unfocused block cursor is drawn hollow.
    pub focused: bool,
}

impl Default for RenderState {
    fn default() -> Self {
        RenderState {
            selection: None,
            cursor_on: true,
            focused: true,
        }
    }
}

/// A run of instances in the buffer to write to the GPU.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InstanceRange {
    /// First instance index.
    pub start: usize,
    pub len: usize,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BuildReport {
    /// The frame was in synchronized output; nothing was built.
    pub held: bool,
    /// Every row was rebuilt.
    pub full: bool,
    /// Rows rebuilt, ascending.
    pub rows: Vec<u16>,
    /// Ranges of `instances()` the GPU copy must be updated with.
    pub uploads: Vec<InstanceRange>,
    /// Visible (non-degenerate) instances written for the rebuilt rows.
    pub quads: usize,
    /// The glyph atlas was too small for this screen: some glyphs were left
    /// blank (never drawn wrong). The window layer should build a larger atlas
    /// (`atlas::atlas_size_for`). If the atlas also kept changing under the
    /// build, the next build is full.
    pub atlas_overflow: bool,
}

impl BuildReport {
    pub fn upload_bytes(&self) -> usize {
        self.uploads
            .iter()
            .map(|r| r.len * std::mem::size_of::<Instance>())
            .sum()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CursorSnap {
    row: u16,
    col: u16,
    cols: u16,
    shape: CursorShape,
    focused: bool,
}

#[derive(Clone, Copy)]
struct CellDraw {
    fg: Rgb,
    bg: Rgb,
    bg_drawn: bool,
    attrs: u16,
}

#[derive(Default)]
struct Scratch {
    draws: Vec<CellDraw>,
    out: Vec<Instance>,
    text: String,
    /// (start, end, cols, col) per cell of the current run.
    ranges: Vec<(usize, usize, u8, u16)>,
    placed: Vec<PlacedGlyph>,
    /// Cursor parts, appended after the row is truncated so a crowded row
    /// loses glyphs before it loses its cursor.
    cursor: Vec<Instance>,
}

pub struct QuadBuilder {
    layout: CellLayout,
    theme: Theme,
    cols: u16,
    rows: u16,
    instances: Vec<Instance>,
    row_used: Vec<usize>,
    last_seq: Option<u64>,
    needs_full: bool,
    prev_cursor: Option<CursorSnap>,
    prev_selection: Option<Selection>,
    epoch: u64,
    scratch: Scratch,
    /// Reused every build so a quiet frame allocates nothing.
    dirty: Vec<bool>,
    /// Surface pixel position of the grid's top-left corner.
    origin: (u32, u32),
    overlay: Option<OverlayState>,
    overlay_used: usize,
}

impl QuadBuilder {
    pub fn new(layout: CellLayout, theme: Theme) -> Self {
        QuadBuilder {
            layout,
            theme,
            cols: 0,
            rows: 0,
            instances: Vec::new(),
            row_used: Vec::new(),
            last_seq: None,
            needs_full: true,
            prev_cursor: None,
            prev_selection: None,
            epoch: 0,
            scratch: Scratch::default(),
            dirty: Vec::new(),
            origin: (0, 0),
            overlay: None,
            overlay_used: 0,
        }
    }

    pub fn set_layout(&mut self, layout: CellLayout) {
        if layout != self.layout {
            self.layout = layout;
            self.needs_full = true;
        }
    }

    pub fn set_theme(&mut self, theme: Theme) {
        if theme != self.theme {
            self.theme = theme;
            self.needs_full = true;
        }
    }

    /// Where the grid's top-left corner sits on the surface, in physical
    /// pixels (padding, or a viewport inside a larger window). Everything the
    /// builder emits is shifted by it; the area outside the grid shows the
    /// render clear colour. Changing it rebuilds every row. Positions from
    /// `geometry` (for example `cursor_rect` for IME placement) are relative
    /// to the grid: add the origin.
    pub fn set_origin(&mut self, x: u32, y: u32) {
        if (x, y) != self.origin {
            self.origin = (x, y);
            self.needs_full = true;
        }
    }

    pub fn origin(&self) -> (u32, u32) {
        self.origin
    }

    pub fn layout(&self) -> &CellLayout {
        &self.layout
    }

    pub fn theme(&self) -> &Theme {
        &self.theme
    }

    /// The whole shadow buffer; `BuildReport::uploads` indexes into it.
    pub fn instances(&self) -> &[Instance] {
        &self.instances
    }

    /// Instances to draw: the whole buffer (unused slots are degenerate).
    pub fn draw_count(&self) -> u32 {
        self.instances.len() as u32
    }

    /// Sequence of the last frame built, if any.
    pub fn last_seq(&self) -> Option<u64> {
        self.last_seq
    }

    fn grid_len(&self) -> usize {
        self.cols as usize * self.rows as usize * INSTANCES_PER_COL
    }

    /// Draws `overlay` (or removes the current one) over the grid and returns
    /// the one range of `instances()` to upload, if anything changed. No row is
    /// rebuilt and the frame is not touched, so a preedit that changes on every
    /// keystroke costs one small write. Call after a `build` has sized the grid
    /// (before that it does nothing); a resize drops the overlay. The next
    /// full build redraws it (origin or atlas changes move it), and its
    /// upload is in that build's report.
    pub fn set_overlay(
        &mut self,
        overlay: Option<Overlay<'_>>,
        glyphs: &mut dyn GlyphSource,
    ) -> Option<InstanceRange> {
        if self.instances.len() <= self.grid_len() {
            return None;
        }
        self.overlay = overlay
            .filter(|o| o.row < self.rows && o.col < self.cols)
            .map(|o| OverlayState {
                row: o.row,
                col: o.col,
                cells: o
                    .cells
                    .iter()
                    .map(|c| (c.text.to_owned(), c.cols))
                    .collect(),
                style: o.style,
            });
        self.emit_overlay(glyphs)
    }

    fn emit_overlay(&mut self, glyphs: &mut dyn GlyphSource) -> Option<InstanceRange> {
        let grid = self.grid_len();
        let prev = self.overlay_used;
        let mut out: Vec<Instance> = Vec::new();
        if let Some(o) = self.overlay.take() {
            let avail = self.cols - o.col;
            let (mut kept, mut span) = (0usize, 0u16);
            for (_, w) in &o.cells {
                if span + *w as u16 > avail {
                    break;
                }
                span += *w as u16;
                kept += 1;
            }
            if kept > 0 {
                let cells: Vec<TextCell<'_>> = o.cells[..kept]
                    .iter()
                    .map(|(t, w)| TextCell {
                        text: t.as_str(),
                        cols: *w,
                    })
                    .collect();
                let mut starts = Vec::with_capacity(kept);
                let mut c = o.col;
                for (_, w) in &o.cells[..kept] {
                    starts.push(c);
                    c += *w as u16;
                }
                let span_rect = cell_rect(&self.layout, o.row, o.col, span);
                out.push(Instance::solid(span_rect, self.theme.bg));
                let mut placed = Vec::new();
                glyphs.shape_run(o.style, &cells, &mut placed);
                for g in placed.iter().take(OVERLAY_INSTANCES - 2) {
                    let Some(&gcol) = starts.get(g.cell as usize) else {
                        continue;
                    };
                    let origin = cell_rect(&self.layout, o.row, gcol, 1);
                    let x = origin.x + g.left;
                    let y = origin.y + self.layout.baseline as i32 - g.top;
                    if let Some(i) =
                        Instance::glyph(g.rect, x, y, self.theme.fg, g.color, span_rect)
                    {
                        out.push(i);
                    }
                }
                out.push(Instance::solid(
                    underline_rect(&self.layout, o.row, o.col, span),
                    self.theme.fg,
                ));
                if self.origin != (0, 0) {
                    let (ox, oy) = (self.origin.0 as f32, self.origin.1 as f32);
                    for i in out.iter_mut().filter(|i| !i.is_empty()) {
                        i.pos[0] += ox;
                        i.pos[1] += oy;
                    }
                }
            }
            self.overlay = Some(o);
        }
        let used = out.len();
        self.instances[grid..grid + used].copy_from_slice(&out);
        let written = used.max(prev);
        for slot in &mut self.instances[grid + used..grid + written] {
            *slot = Instance::EMPTY;
        }
        self.overlay_used = used;
        (written > 0).then_some(InstanceRange {
            start: grid,
            len: written,
        })
    }

    fn row_capacity(&self) -> usize {
        self.cols as usize * INSTANCES_PER_COL
    }

    fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
        let total = cols as usize * rows as usize * INSTANCES_PER_COL + OVERLAY_INSTANCES;
        self.instances = vec![Instance::EMPTY; total];
        self.overlay = None;
        self.overlay_used = 0;
        self.row_used = vec![0; rows as usize];
        self.prev_cursor = None;
        self.prev_selection = None;
    }

    fn cursor_snap(&self, frame: &Frame, state: &RenderState) -> Option<CursorSnap> {
        let c = frame.cursor;
        if !c.visible || !state.cursor_on || c.row >= frame.rows || c.col >= frame.cols {
            return None;
        }
        let wide = frame
            .cell(c.row, c.col + 1)
            .is_some_and(|n| n.attrs.has(Attrs::WIDE_TAIL));
        Some(CursorSnap {
            row: c.row,
            col: c.col,
            cols: if wide { 2 } else { 1 },
            shape: c.shape,
            focused: state.focused,
        })
    }

    /// Builds what changed since the last call. See the module docs.
    pub fn build(
        &mut self,
        frame: &Frame,
        state: &RenderState,
        glyphs: &mut dyn GlyphSource,
    ) -> BuildReport {
        if frame.modes.sync_output {
            return BuildReport {
                held: true,
                ..Default::default()
            };
        }
        let expected = frame.cols as usize * frame.rows as usize;
        if frame.cells.len() != expected {
            // A malformed frame: draw nothing rather than index out of range.
            return BuildReport::default();
        }
        glyphs.begin_frame();

        let resized = (frame.cols, frame.rows) != (self.cols, self.rows);
        if resized {
            self.resize(frame.cols, frame.rows);
        }
        let cursor = self.cursor_snap(frame, state);
        let mut dirty = std::mem::take(&mut self.dirty);
        dirty.clear();
        dirty.resize(frame.rows as usize, false);

        let mut full = self.needs_full
            || resized
            || frame.damage.full
            || self.last_seq.is_none()
            || frame.damage.since == 0
            || glyphs.epoch() != self.epoch;
        match self.last_seq {
            Some(last) if !full => {
                if frame.seq == last {
                    // The same frame again: its damage was already drawn.
                } else if frame.seq < last || frame.damage.since != last {
                    full = true;
                } else {
                    for &(a, b) in &frame.damage.rows {
                        let (lo, hi) = (a.min(b), a.max(b));
                        for r in lo..=hi.min(frame.rows.saturating_sub(1)) {
                            if r < frame.rows {
                                dirty[r as usize] = true;
                            }
                        }
                    }
                }
            }
            _ => {}
        }
        if !full {
            self.mark_overlay_rows(&mut dirty, cursor, state, frame.cols, frame.rows);
        }

        let mut report = BuildReport::default();
        let mut settled = false;
        for _ in 0..3 {
            let epoch_before = glyphs.epoch();
            let rows: Vec<u16> = if full {
                (0..frame.rows).collect()
            } else {
                (0..frame.rows).filter(|&r| dirty[r as usize]).collect()
            };
            report = BuildReport {
                held: false,
                full,
                rows,
                uploads: Vec::new(),
                quads: 0,
                atlas_overflow: false,
            };
            let rows = std::mem::take(&mut report.rows);
            for &row in &rows {
                self.build_row(frame, row, state, cursor, glyphs, &mut report);
            }
            report.rows = rows;
            if glyphs.epoch() == epoch_before {
                settled = true;
                break;
            }
            // The atlas overwrote glyphs while building: rows built earlier in
            // this pass may point at stale texels, so build everything again.
            full = true;
        }
        if report.full && self.overlay.is_some() {
            // A full build moved or invalidated what the overlay points at.
            let before = glyphs.epoch();
            report.uploads.extend(self.emit_overlay(glyphs));
            if glyphs.epoch() != before {
                settled = false;
            }
        }
        let overflowed = glyphs.overflowed();
        if !settled || overflowed {
            report.atlas_overflow = true;
        }
        if resized && !self.instances.is_empty() {
            // The renderer may keep a larger buffer from before; unwritten slots
            // would still hold old instances, so rewrite the whole thing.
            report.uploads = vec![InstanceRange {
                start: 0,
                len: self.instances.len(),
            }];
        }
        self.epoch = glyphs.epoch();
        self.last_seq = Some(frame.seq);
        // If the atlas never settled, rows may still point at overwritten
        // texels: rebuild everything next time rather than trust them. A
        // settled build that overflowed is valid (blank glyphs, correct
        // rects), so it is not rebuilt, or a full screen would thrash.
        self.needs_full = !settled;
        self.prev_cursor = cursor;
        self.prev_selection = state.selection;
        self.dirty = dirty;
        report
    }

    fn mark_overlay_rows(
        &self,
        dirty: &mut [bool],
        cursor: Option<CursorSnap>,
        state: &RenderState,
        cols: u16,
        rows: u16,
    ) {
        if cursor != self.prev_cursor {
            for snap in [self.prev_cursor, cursor].into_iter().flatten() {
                if (snap.row as usize) < dirty.len() {
                    dirty[snap.row as usize] = true;
                }
            }
        }
        if state.selection != self.prev_selection {
            for row in 0..rows {
                let old = self.prev_selection.and_then(|s| s.cols_on(row, cols));
                let new = state.selection.and_then(|s| s.cols_on(row, cols));
                if old != new {
                    dirty[row as usize] = true;
                }
            }
        }
    }

    fn build_row(
        &mut self,
        frame: &Frame,
        row: u16,
        state: &RenderState,
        cursor: Option<CursorSnap>,
        glyphs: &mut dyn GlyphSource,
        report: &mut BuildReport,
    ) {
        let cap = self.row_capacity();
        let mut scratch = std::mem::take(&mut self.scratch);
        scratch.out.clear();
        scratch.cursor.clear();
        emit_row(
            &self.layout,
            &self.theme,
            frame,
            row,
            state,
            cursor,
            glyphs,
            &mut scratch,
        );
        let keep = cap.saturating_sub(scratch.cursor.len());
        scratch.out.truncate(keep);
        let cursor_parts = std::mem::take(&mut scratch.cursor);
        scratch
            .out
            .extend(cursor_parts.iter().copied().take(cap - scratch.out.len()));
        scratch.cursor = cursor_parts;
        if self.origin != (0, 0) {
            let (ox, oy) = (self.origin.0 as f32, self.origin.1 as f32);
            for i in scratch.out.iter_mut().filter(|i| !i.is_empty()) {
                i.pos[0] += ox;
                i.pos[1] += oy;
            }
        }
        let used = scratch.out.len();
        let prev_used = self.row_used[row as usize];
        let base = row as usize * cap;
        self.instances[base..base + used].copy_from_slice(&scratch.out);
        let written = used.max(prev_used);
        for slot in &mut self.instances[base + used..base + written] {
            *slot = Instance::EMPTY;
        }
        self.row_used[row as usize] = used;
        report.quads += scratch.out.iter().filter(|i| !i.is_empty()).count();
        if written > 0 {
            report.uploads.push(InstanceRange {
                start: base,
                len: written,
            });
        }
        self.scratch = scratch;
    }
}

fn style_of(attrs: Attrs) -> FontStyle {
    FontStyle {
        bold: attrs.has(Attrs::BOLD),
        italic: attrs.has(Attrs::ITALIC),
    }
}

fn is_blank(cell: &Cell) -> bool {
    cell.cluster == 0 && (cell.ch == ' ' || cell.ch == '\0')
}

fn cell_text<'a>(frame: &'a Frame, cell: &Cell, buf: &'a mut [u8; 4]) -> &'a str {
    if cell.cluster != 0 {
        if let Some(t) = frame.clusters.get(cell.cluster as usize) {
            if !t.is_empty() {
                return t.as_str();
            }
        }
    }
    cell.ch.encode_utf8(buf)
}

#[allow(clippy::too_many_arguments)]
fn emit_row(
    layout: &CellLayout,
    theme: &Theme,
    frame: &Frame,
    row: u16,
    state: &RenderState,
    cursor: Option<CursorSnap>,
    glyphs: &mut dyn GlyphSource,
    s: &mut Scratch,
) {
    let cols = frame.cols;
    let selection = state.selection.and_then(|sel| sel.cols_on(row, cols));
    let cursor_here = cursor.filter(|c| c.row == row);
    let block_cursor = cursor_here.filter(|c| c.shape == CursorShape::Block && c.focused);

    // 1. Resolve every cell's colours and attributes.
    s.draws.clear();
    for col in 0..cols {
        let cell = frame.cell(row, col).copied().unwrap_or_default();
        if cell.attrs.has(Attrs::WIDE_TAIL) && col > 0 {
            let head = s.draws[col as usize - 1];
            s.draws.push(head);
            continue;
        }
        let r = resolve_cell(theme, &cell);
        let mut d = CellDraw {
            fg: r.fg,
            bg: r.bg,
            bg_drawn: r.bg_drawn,
            attrs: cell.attrs.0,
        };
        if selection.is_some_and(|(a, b)| col >= a && col < b) {
            d.bg = theme.selection_bg;
            d.bg_drawn = true;
            if let Some(fg) = theme.selection_fg {
                d.fg = fg;
            }
        }
        if block_cursor.is_some_and(|c| col >= c.col && col < c.col + c.cols) {
            d.fg = d.bg;
            d.bg = theme.cursor;
            d.bg_drawn = true;
        }
        s.draws.push(d);
    }
    // A block cursor on a wide character covers both halves (the tail copies
    // the head), but the cursor loop above ran per column: re-apply to tails.
    if let Some(c) = block_cursor {
        for col in c.col..(c.col + c.cols).min(cols) {
            let d = &mut s.draws[col as usize];
            d.bg = theme.cursor;
            d.bg_drawn = true;
        }
    }

    // 2. Backgrounds, merging neighbouring cells of one colour.
    let mut col = 0u16;
    while col < cols {
        let d = s.draws[col as usize];
        if !d.bg_drawn {
            col += 1;
            continue;
        }
        let start = col;
        while col < cols && s.draws[col as usize].bg_drawn && s.draws[col as usize].bg == d.bg {
            col += 1;
        }
        s.out.push(Instance::solid(
            cell_rect(layout, row, start, col - start),
            d.bg,
        ));
    }

    // 3. Glyphs.
    let mut col = 0u16;
    while col < cols {
        let cell = *frame.cell(row, col).unwrap();
        let d = s.draws[col as usize];
        if cell.attrs.has(Attrs::WIDE_TAIL) || is_blank(&cell) || cell.attrs.has(Attrs::HIDDEN) {
            col += 1;
            continue;
        }
        if cell.cluster == 0 && procedural::is_procedural(cell.ch) {
            if let Some(rect) = glyphs.procedural(cell.ch) {
                let origin = cell_rect(layout, row, col, 1);
                if let Some(i) = Instance::glyph(rect, origin.x, origin.y, d.fg, false, origin) {
                    s.out.push(i);
                }
            }
            col += 1;
            continue;
        }
        // A run of cells with one style, shaped together so ligatures form.
        let style = style_of(cell.attrs);
        s.text.clear();
        s.ranges.clear();
        let run_start = col;
        while col < cols {
            let c = *frame.cell(row, col).unwrap();
            if c.attrs.has(Attrs::WIDE_TAIL) {
                col += 1;
                continue;
            }
            if is_blank(&c)
                || c.attrs.has(Attrs::HIDDEN)
                || style_of(c.attrs) != style
                || (c.cluster == 0 && procedural::is_procedural(c.ch))
            {
                break;
            }
            let wide = frame
                .cell(row, col + 1)
                .is_some_and(|n| n.attrs.has(Attrs::WIDE_TAIL));
            let mut buf = [0u8; 4];
            let t = cell_text(frame, &c, &mut buf);
            let a = s.text.len();
            s.text.push_str(t);
            s.ranges
                .push((a, s.text.len(), if wide { 2 } else { 1 }, col));
            col += if wide { 2 } else { 1 };
        }
        let run_end = col;
        let cells: Vec<TextCell<'_>> = s
            .ranges
            .iter()
            .map(|&(a, b, cols, _)| TextCell {
                text: &s.text[a..b],
                cols,
            })
            .collect();
        s.placed.clear();
        glyphs.shape_run(style, &cells, &mut s.placed);
        for g in &s.placed {
            let Some(&(_, _, _, gcol)) = s.ranges.get(g.cell as usize) else {
                continue;
            };
            let origin = cell_rect(layout, row, gcol, 1);
            // Clip to the whole run horizontally: a ligature can be anchored on
            // its last cell and reach back (negative bearing) over earlier ones.
            let run_origin = cell_rect(layout, row, run_start, 1);
            let clip = PxRect {
                x: run_origin.x,
                y: origin.y,
                w: (run_end - run_start) as u32 * layout.width,
                h: layout.height,
            };
            let x = origin.x + g.left;
            let y = origin.y + layout.baseline as i32 - g.top;
            let fg = s.draws[gcol as usize].fg;
            if let Some(i) = Instance::glyph(g.rect, x, y, fg, g.color, clip) {
                s.out.push(i);
            }
        }
    }

    // 4. Underline and strike, merging neighbours of one colour.
    for (flag, rect_of) in [
        (
            Attrs::UNDERLINE,
            underline_rect as fn(&CellLayout, u16, u16, u16) -> PxRect,
        ),
        (
            Attrs::STRIKE,
            strike_rect as fn(&CellLayout, u16, u16, u16) -> PxRect,
        ),
    ] {
        let has = |d: &CellDraw| d.attrs & flag != 0 && d.attrs & Attrs::HIDDEN == 0;
        let mut col = 0u16;
        while col < cols {
            let d = s.draws[col as usize];
            if !has(&d) {
                col += 1;
                continue;
            }
            let start = col;
            while col < cols && has(&s.draws[col as usize]) && s.draws[col as usize].fg == d.fg {
                col += 1;
            }
            s.out.push(Instance::solid(
                rect_of(layout, row, start, col - start),
                d.fg,
            ));
        }
    }

    // 5. Cursor parts that are not a recoloured cell.
    if let Some(c) = cursor_here {
        if c.shape != CursorShape::Block {
            s.cursor.push(Instance::solid(
                cursor_rect(layout, row, c.col, c.cols, c.shape),
                theme.cursor,
            ));
        } else if !c.focused {
            let r = cursor_rect(layout, row, c.col, c.cols, CursorShape::Block);
            let t = layout.underline_thickness.max(1).min(r.w).min(r.h);
            let edges = [
                PxRect { h: t, ..r },
                PxRect {
                    y: r.y + (r.h - t) as i32,
                    h: t,
                    ..r
                },
                PxRect { w: t, ..r },
                PxRect {
                    x: r.x + (r.w - t) as i32,
                    w: t,
                    ..r
                },
            ];
            for e in edges {
                s.cursor.push(Instance::solid(e, theme.cursor));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atlas::Rect;
    use crate::frame::{Color, Cursor, Damage};

    fn layout() -> CellLayout {
        CellLayout {
            width: 8,
            height: 16,
            baseline: 12,
            underline_top: 14,
            underline_thickness: 1,
            strike_top: 8,
            strike_thickness: 1,
            font_px: 14,
        }
    }

    /// A glyph source with no fonts: every non-blank cell becomes one 6x10
    /// glyph, which makes counts and positions easy to predict.
    #[derive(Default)]
    struct Stub {
        epoch: u64,
        shape_calls: usize,
        frames: usize,
        big: bool,
        overflow: bool,
    }

    impl GlyphSource for Stub {
        fn begin_frame(&mut self) {
            self.frames += 1;
        }
        fn epoch(&self) -> u64 {
            self.epoch
        }
        fn overflowed(&mut self) -> bool {
            std::mem::take(&mut self.overflow)
        }
        fn procedural(&mut self, _ch: char) -> Option<Rect> {
            Some(Rect {
                x: 100,
                y: 100,
                w: 8,
                h: 16,
            })
        }
        fn shape_run(
            &mut self,
            _style: FontStyle,
            cells: &[TextCell<'_>],
            out: &mut Vec<PlacedGlyph>,
        ) {
            self.shape_calls += 1;
            for (i, c) in cells.iter().enumerate() {
                if !c.text.trim().is_empty() {
                    out.push(PlacedGlyph {
                        cell: i as u16,
                        rect: if self.big {
                            Rect {
                                x: 20,
                                y: 20,
                                w: 14,
                                h: 30,
                            }
                        } else {
                            Rect {
                                x: 10,
                                y: 10,
                                w: 6,
                                h: 10,
                            }
                        },
                        left: 1,
                        top: 11,
                        color: false,
                    });
                }
            }
        }
    }

    fn text_frame(lines: &[&str], seq: u64) -> Frame {
        let cols = lines.iter().map(|l| l.chars().count()).max().unwrap() as u16;
        let mut f = Frame::blank(cols, lines.len() as u16);
        f.seq = seq;
        f.cursor.visible = false;
        for (r, line) in lines.iter().enumerate() {
            for (c, ch) in line.chars().enumerate() {
                f.cells[r * cols as usize + c].ch = ch;
            }
        }
        f
    }

    fn damaged(mut f: Frame, since: u64, rows: &[(u16, u16)]) -> Frame {
        f.damage = Damage {
            since,
            full: false,
            rows: rows.to_vec(),
        };
        f
    }

    fn builder() -> QuadBuilder {
        QuadBuilder::new(layout(), Theme::default())
    }

    #[test]
    fn the_origin_shifts_every_quad_and_a_change_rebuilds_everything() {
        let f = with_cursor(text_frame(&["ab", "cd"], 1), 1, 1, CursorShape::Bar);
        let mut plain = builder();
        plain.build(&f, &RenderState::default(), &mut Stub::default());
        let mut shifted = builder();
        shifted.set_origin(10, 20);
        shifted.build(&f, &RenderState::default(), &mut Stub::default());
        let mut seen = 0;
        for (a, b) in plain.instances().iter().zip(shifted.instances()) {
            if a.is_empty() {
                assert!(b.is_empty());
                continue;
            }
            seen += 1;
            assert_eq!([b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]], [10.0, 20.0]);
            assert_eq!((a.size, a.uv, a.color), (b.size, b.uv, b.color));
        }
        assert!(seen >= 5, "glyphs and the cursor were compared");
        // Same frame again: nothing to do, until the origin moves.
        let again = damaged(f.clone(), 1, &[]);
        let r = shifted.build(&again, &RenderState::default(), &mut Stub::default());
        assert!(r.rows.is_empty());
        shifted.set_origin(0, 0);
        let r = shifted.build(&again, &RenderState::default(), &mut Stub::default());
        assert!(r.full);
        assert_eq!(shifted.instances(), plain.instances());
    }

    #[test]
    fn an_overlay_draws_on_top_without_rebuilding_a_row() {
        let f = text_frame(&["abcd", "efgh"], 1);
        let mut b = builder();
        let mut g = Stub::default();
        b.build(&f, &RenderState::default(), &mut g);
        let grid = 2 * 4 * INSTANCES_PER_COL;
        let cells = [
            TextCell { text: "x", cols: 1 },
            TextCell { text: "y", cols: 1 },
        ];
        let o = Overlay {
            row: 1,
            col: 1,
            cells: &cells,
            style: FontStyle::default(),
        };
        let r = b.set_overlay(Some(o), &mut g).unwrap();
        assert_eq!(r.start, grid);
        // Background, two glyphs, underline.
        assert_eq!(r.len, 4);
        let bg = b.instances()[grid];
        assert_eq!((bg.pos, bg.size), ([8.0, 16.0], [16.0, 16.0]));
        let same = damaged(f.clone(), 1, &[]);
        let rep = b.build(&same, &RenderState::default(), &mut g);
        assert!(rep.rows.is_empty() && rep.uploads.is_empty());
        // A full rebuild redraws it, with the upload in the report.
        b.set_origin(5, 0);
        let rep = b.build(&same, &RenderState::default(), &mut g);
        assert!(rep.full);
        assert!(rep.uploads.iter().any(|u| u.start == grid && u.len == 4));
        assert_eq!(b.instances()[grid].pos, [13.0, 16.0]);
        // Cells past the right edge are dropped; clearing blanks the region.
        let wide = [TextCell { text: "z", cols: 1 }; 9];
        let o = Overlay { cells: &wide, ..o };
        b.set_overlay(Some(o), &mut g);
        assert_eq!(b.instances()[grid].size, [24.0, 16.0]);
        let r = b.set_overlay(None, &mut g).unwrap();
        assert_eq!(r.start, grid);
        assert!(b.instances()[grid..].iter().all(|i| i.is_empty()));
        assert!(b.set_overlay(None, &mut g).is_none());
    }

    #[test]
    fn the_first_frame_builds_every_row() {
        let mut b = builder();
        let mut g = Stub::default();
        let f = text_frame(&["ab", "cd", "ef"], 1);
        let r = b.build(&f, &RenderState::default(), &mut g);
        assert!(r.full);
        assert_eq!(r.rows, vec![0, 1, 2]);
        assert_eq!(r.quads, 6, "one glyph per letter, no backgrounds");
    }

    #[test]
    fn an_unchanged_frame_produces_zero_quads_and_zero_uploads() {
        let mut b = builder();
        let mut g = Stub::default();
        let f = text_frame(&["ab", "cd"], 1);
        b.build(&f, &RenderState::default(), &mut g);
        // The producer sends the same frame again with nothing damaged.
        let again = damaged(f.clone(), 1, &[]);
        let r = b.build(&again, &RenderState::default(), &mut g);
        assert!(!r.full);
        assert!(r.rows.is_empty());
        assert_eq!(r.quads, 0);
        assert!(r.uploads.is_empty());
        assert_eq!(r.upload_bytes(), 0);
        // And a newer seq with empty damage is also free.
        let newer = damaged(text_frame(&["ab", "cd"], 2), 1, &[]);
        let r = b.build(&newer, &RenderState::default(), &mut g);
        assert_eq!((r.quads, r.rows.len()), (0, 0));
        assert_eq!(b.last_seq(), Some(2));
    }

    #[test]
    fn a_one_row_change_rebuilds_only_that_row() {
        let mut b = builder();
        let mut g = Stub::default();
        b.build(
            &text_frame(&["abc", "def", "ghi"], 1),
            &RenderState::default(),
            &mut g,
        );
        let f = damaged(text_frame(&["abc", "dXf", "ghi"], 2), 1, &[(1, 1)]);
        let r = b.build(&f, &RenderState::default(), &mut g);
        assert!(!r.full);
        assert_eq!(r.rows, vec![1]);
        assert_eq!(r.quads, 3);
        assert_eq!(r.uploads.len(), 1);
        let cap = 3 * INSTANCES_PER_COL;
        assert_eq!(r.uploads[0].start, cap, "row 1's region");
        assert!(r.uploads[0].len <= cap);
        // Only that row's shaping ran.
        assert_eq!(g.shape_calls, 3 + 1);
    }

    #[test]
    fn damage_ranges_are_inclusive_and_may_be_reversed_or_out_of_range() {
        let mut b = builder();
        let mut g = Stub::default();
        b.build(
            &text_frame(&["a", "b", "c", "d"], 1),
            &RenderState::default(),
            &mut g,
        );
        let f = damaged(text_frame(&["a", "b", "c", "d"], 2), 1, &[(2, 1), (3, 60)]);
        let r = b.build(&f, &RenderState::default(), &mut g);
        assert_eq!(r.rows, vec![1, 2, 3]);
    }

    #[test]
    fn damage_relative_to_another_frame_forces_a_full_rebuild() {
        let mut b = builder();
        let mut g = Stub::default();
        b.build(&text_frame(&["a", "b"], 5), &RenderState::default(), &mut g);
        // since does not name the frame we drew.
        let wrong = damaged(text_frame(&["a", "b"], 9), 7, &[(0, 0)]);
        assert!(b.build(&wrong, &RenderState::default(), &mut g).full);
        // since = 0 means no baseline.
        let none = damaged(text_frame(&["a", "b"], 10), 0, &[(0, 0)]);
        assert!(b.build(&none, &RenderState::default(), &mut g).full);
        // A sequence that goes backwards is a different stream.
        let back = damaged(text_frame(&["a", "b"], 3), 10, &[(0, 0)]);
        assert!(b.build(&back, &RenderState::default(), &mut g).full);
        // Explicit full damage.
        let mut f = text_frame(&["a", "b"], 4);
        f.damage.full = true;
        assert!(b.build(&f, &RenderState::default(), &mut g).full);
    }

    #[test]
    fn a_resize_rebuilds_everything_and_resizes_the_buffer() {
        let mut b = builder();
        let mut g = Stub::default();
        b.build(
            &text_frame(&["ab", "cd"], 1),
            &RenderState::default(),
            &mut g,
        );
        let f = damaged(text_frame(&["abc", "def", "ghi"], 2), 1, &[(0, 0)]);
        let r = b.build(&f, &RenderState::default(), &mut g);
        assert!(r.full);
        assert_eq!(
            b.instances().len(),
            3 * 3 * INSTANCES_PER_COL + OVERLAY_INSTANCES
        );
    }

    #[test]
    fn a_resize_uploads_the_whole_buffer_so_no_stale_instances_survive_a_shrink() {
        let mut b = builder();
        let mut g = Stub::default();
        b.build(
            &text_frame(&["abc", "def", "ghi"], 1),
            &RenderState::default(),
            &mut g,
        );
        let r = b.build(
            &text_frame(&["ab", "cd"], 2),
            &RenderState::default(),
            &mut g,
        );
        assert!(r.full);
        assert_eq!(
            r.uploads,
            vec![InstanceRange {
                start: 0,
                len: 2 * 2 * INSTANCES_PER_COL + OVERLAY_INSTANCES
            }]
        );
    }

    #[test]
    fn a_theme_or_layout_change_forces_a_rebuild() {
        let mut b = builder();
        let mut g = Stub::default();
        let f = text_frame(&["ab"], 1);
        b.build(&f, &RenderState::default(), &mut g);
        let same = damaged(text_frame(&["ab"], 1), 1, &[]);
        assert!(!b.build(&same, &RenderState::default(), &mut g).full);
        let mut theme = Theme::default();
        theme.fg = [1, 2, 3];
        b.set_theme(theme);
        assert!(b.build(&same, &RenderState::default(), &mut g).full);
        let mut l = layout();
        l.width = 9;
        b.set_layout(l);
        assert!(b.build(&same, &RenderState::default(), &mut g).full);
    }

    #[test]
    fn a_glyph_atlas_eviction_forces_a_full_rebuild() {
        let mut b = builder();
        let mut g = Stub::default();
        b.build(
            &text_frame(&["ab", "cd"], 1),
            &RenderState::default(),
            &mut g,
        );
        g.epoch += 1; // the atlas overwrote texels
        let f = damaged(text_frame(&["ab", "cd"], 2), 1, &[(0, 0)]);
        let r = b.build(&f, &RenderState::default(), &mut g);
        assert!(r.full, "undamaged rows may now point at overwritten glyphs");
    }

    /// Bumps its epoch during shaping, as an atlas that clears mid-build does.
    struct Bumpy {
        epoch: u64,
        /// Bump on every shape call (never settles) instead of just once.
        always: bool,
        pending: bool,
    }

    impl GlyphSource for Bumpy {
        fn begin_frame(&mut self) {}
        fn epoch(&self) -> u64 {
            self.epoch
        }
        fn procedural(&mut self, _: char) -> Option<Rect> {
            None
        }
        fn shape_run(&mut self, _: FontStyle, cells: &[TextCell<'_>], out: &mut Vec<PlacedGlyph>) {
            if self.always || self.pending {
                self.epoch += 1;
                self.pending = false;
            }
            for (i, _) in cells.iter().enumerate() {
                out.push(PlacedGlyph {
                    cell: i as u16,
                    rect: Rect {
                        x: 1,
                        y: 1,
                        w: 4,
                        h: 4,
                    },
                    left: 0,
                    top: 8,
                    color: false,
                });
            }
        }
    }

    #[test]
    fn an_epoch_change_during_the_build_gives_a_full_rebuild_then_quiet() {
        let mut b = builder();
        let mut g = Bumpy {
            epoch: 0,
            always: false,
            pending: true,
        };
        let r = b.build(
            &text_frame(&["ab", "cd"], 1),
            &RenderState::default(),
            &mut g,
        );
        assert!(r.full && !r.atlas_overflow, "settled on the second pass");
        let next = damaged(text_frame(&["ab", "cd"], 1), 1, &[]);
        let r = b.build(&next, &RenderState::default(), &mut g);
        assert!(r.rows.is_empty(), "the recorded epoch is the settled one");
    }

    #[test]
    fn a_settled_overflow_is_reported_but_not_rebuilt_every_frame() {
        let mut b = builder();
        let mut g = Stub {
            overflow: true,
            ..Stub::default()
        };
        let f = text_frame(&["ab", "cd"], 1);
        let r = b.build(&f, &RenderState::default(), &mut g);
        assert!(r.atlas_overflow);
        let again = damaged(text_frame(&["ab", "cd"], 1), 1, &[]);
        let r = b.build(&again, &RenderState::default(), &mut g);
        assert!(!r.atlas_overflow);
        assert!(!r.full && r.rows.is_empty(), "no rebuild for a valid build");
    }

    #[test]
    fn an_epoch_that_never_settles_is_reported_and_the_next_build_is_full() {
        let mut b = builder();
        let mut g = Bumpy {
            epoch: 0,
            always: true,
            pending: false,
        };
        let f = text_frame(&["ab", "cd"], 1);
        let r = b.build(&f, &RenderState::default(), &mut g);
        assert!(r.atlas_overflow);
        let next = damaged(text_frame(&["ab", "cd"], 1), 1, &[]);
        g.always = false;
        let r = b.build(&next, &RenderState::default(), &mut g);
        assert!(r.full, "rows of an unsettled build are not trusted");
        assert!(!r.atlas_overflow);
    }

    #[test]
    fn a_crowded_row_loses_glyphs_before_it_loses_its_cursor() {
        struct Many;
        impl GlyphSource for Many {
            fn begin_frame(&mut self) {}
            fn epoch(&self) -> u64 {
                0
            }
            fn procedural(&mut self, _: char) -> Option<Rect> {
                None
            }
            fn shape_run(&mut self, _: FontStyle, _: &[TextCell<'_>], out: &mut Vec<PlacedGlyph>) {
                for _ in 0..8 {
                    out.push(PlacedGlyph {
                        cell: 0,
                        rect: Rect {
                            x: 1,
                            y: 1,
                            w: 3,
                            h: 3,
                        },
                        left: 0,
                        top: 8,
                        color: false,
                    });
                }
            }
        }
        let mut b = builder();
        let mut f = text_frame(&["a"], 1);
        f.cells[0].bg = Color::Rgb(1, 1, 1);
        f.cells[0].attrs = Attrs(Attrs::UNDERLINE);
        let f = with_cursor(f, 0, 0, CursorShape::Bar);
        b.build(&f, &RenderState::default(), &mut Many);
        let row = &b.instances()[..INSTANCES_PER_COL];
        let last = row[INSTANCES_PER_COL - 1];
        let rgb = |i: &Instance| {
            let c = i.color.to_le_bytes();
            [c[0], c[1], c[2]]
        };
        assert_eq!(rgb(&last), Theme::default().cursor);
        assert_eq!(last.size, [1.0, 16.0], "the bar survived");
        assert_eq!(rgb(&row[0]), [1, 1, 1], "background kept");
    }

    #[test]
    fn a_synchronized_output_frame_is_held() {
        let mut b = builder();
        let mut g = Stub::default();
        b.build(&text_frame(&["ab"], 1), &RenderState::default(), &mut g);
        let mut f = damaged(text_frame(&["XX"], 2), 1, &[(0, 0)]);
        f.modes.sync_output = true;
        let r = b.build(&f, &RenderState::default(), &mut g);
        assert!(r.held && r.rows.is_empty() && r.quads == 0);
        assert_eq!(b.last_seq(), Some(1), "the held frame is not remembered");
        // The release frame is relative to the frame we still hold.
        f.modes.sync_output = false;
        let r = b.build(&f, &RenderState::default(), &mut g);
        assert!(!r.full);
        assert_eq!(r.rows, vec![0]);
    }

    #[test]
    fn a_malformed_frame_draws_nothing() {
        let mut b = builder();
        let mut g = Stub::default();
        let mut f = text_frame(&["ab"], 1);
        f.cells.pop();
        let r = b.build(&f, &RenderState::default(), &mut g);
        assert!(r.rows.is_empty() && r.quads == 0);
    }

    #[test]
    fn neighbouring_cells_of_one_background_share_a_quad() {
        let mut b = builder();
        let mut g = Stub::default();
        let mut f = text_frame(&["    "], 1);
        for c in 0..3 {
            f.cells[c].bg = Color::Rgb(9, 9, 9);
        }
        f.cells[3].bg = Color::Rgb(7, 7, 7);
        let r = b.build(&f, &RenderState::default(), &mut g);
        assert_eq!(r.quads, 2, "a run of three plus one");
        let i = b.instances()[0];
        assert_eq!(i.size, [24.0, 16.0]);
    }

    #[test]
    fn a_wide_character_has_one_glyph_and_a_two_cell_background() {
        let mut b = builder();
        let mut g = Stub::default();
        let mut f = Frame::blank(4, 1);
        f.seq = 1;
        f.cells[1] = Cell {
            ch: '世',
            bg: Color::Rgb(1, 2, 3),
            ..Cell::default()
        };
        f.cells[2] = Cell {
            ch: '\0',
            attrs: Attrs(Attrs::WIDE_TAIL),
            ..Cell::default()
        };
        let r = b.build(&f, &RenderState::default(), &mut g);
        assert_eq!(r.quads, 2, "one background spanning two cells + one glyph");
        let bg = b.instances()[0];
        assert_eq!((bg.pos[0], bg.size[0]), (8.0, 16.0));
    }

    #[test]
    fn a_cluster_is_shaped_from_its_full_text() {
        struct Spy(Vec<String>);
        impl GlyphSource for Spy {
            fn begin_frame(&mut self) {}
            fn epoch(&self) -> u64 {
                0
            }
            fn procedural(&mut self, _: char) -> Option<Rect> {
                None
            }
            fn shape_run(
                &mut self,
                _: FontStyle,
                cells: &[TextCell<'_>],
                _: &mut Vec<PlacedGlyph>,
            ) {
                self.0.extend(cells.iter().map(|c| c.text.to_string()));
            }
        }
        let mut b = builder();
        let mut f = Frame::blank(3, 1);
        f.seq = 1;
        f.clusters.push("e\u{301}".into());
        f.cells[0] = Cell {
            ch: 'e',
            cluster: 1,
            ..Cell::default()
        };
        f.cells[1].ch = 'x';
        let mut spy = Spy(Vec::new());
        b.build(&f, &RenderState::default(), &mut spy);
        assert_eq!(spy.0, vec!["e\u{301}".to_string(), "x".to_string()]);
    }

    #[test]
    fn ligature_runs_are_shaped_together_and_break_on_style_and_blanks() {
        let mut b = builder();
        let mut g = Stub::default();
        let mut f = text_frame(&["=>  ->"], 1);
        f.cells[4].attrs = Attrs(Attrs::BOLD);
        b.build(&f, &RenderState::default(), &mut g);
        // "=>" | (blanks) | "-" regular? cell 4 is bold, cell 5 regular.
        assert_eq!(g.shape_calls, 3);
    }

    #[test]
    fn procedural_glyphs_fill_exactly_their_cell() {
        let mut b = builder();
        let mut g = Stub::default();
        let f = text_frame(&["─█"], 1);
        let r = b.build(&f, &RenderState::default(), &mut g);
        assert_eq!(r.quads, 2);
        assert_eq!(g.shape_calls, 0, "never sent to the shaper");
        let i = b.instances()[0];
        assert_eq!((i.pos, i.size), ([0.0, 0.0], [8.0, 16.0]));
    }

    #[test]
    fn an_overhanging_glyph_never_leaves_its_cell() {
        let mut b = builder();
        let mut g = Stub {
            big: true,
            ..Default::default()
        };
        let f = text_frame(&["a", "b"], 1);
        b.build(&f, &RenderState::default(), &mut g);
        for (row, base) in [(0u16, 0usize), (1, INSTANCES_PER_COL)] {
            let i = b.instances()[base];
            assert!(i.pos[0] >= 0.0 && i.pos[0] + i.size[0] <= 8.0);
            assert!(
                i.pos[1] >= row as f32 * 16.0 && i.pos[1] + i.size[1] <= (row + 1) as f32 * 16.0
            );
        }
    }

    #[test]
    fn a_ligature_anchored_on_a_later_cell_may_reach_back_over_earlier_ones() {
        struct Lig;
        impl GlyphSource for Lig {
            fn begin_frame(&mut self) {}
            fn epoch(&self) -> u64 {
                0
            }
            fn procedural(&mut self, _: char) -> Option<Rect> {
                None
            }
            fn shape_run(&mut self, _: FontStyle, _: &[TextCell<'_>], out: &mut Vec<PlacedGlyph>) {
                // One wide glyph on the second cell with a negative bearing.
                out.push(PlacedGlyph {
                    cell: 1,
                    rect: Rect {
                        x: 0,
                        y: 0,
                        w: 14,
                        h: 10,
                    },
                    left: -6,
                    top: 11,
                    color: false,
                });
            }
        }
        let mut b = builder();
        let f = text_frame(&["ab"], 1);
        b.build(&f, &RenderState::default(), &mut Lig);
        let i = b.instances()[0];
        assert_eq!(
            i.pos[0], 2.0,
            "starts inside the first cell, not clipped to the second"
        );
        assert_eq!(i.size[0], 14.0);
    }

    #[test]
    fn hidden_and_blank_cells_draw_no_glyph() {
        let mut b = builder();
        let mut g = Stub::default();
        let mut f = text_frame(&["a b"], 1);
        f.cells[2].attrs = Attrs(Attrs::HIDDEN);
        let r = b.build(&f, &RenderState::default(), &mut g);
        assert_eq!(r.quads, 1);
    }

    #[test]
    fn underline_and_strike_merge_across_cells() {
        let mut b = builder();
        let mut g = Stub::default();
        let mut f = text_frame(&["   "], 1);
        for c in 0..3 {
            f.cells[c].attrs = Attrs(Attrs::UNDERLINE | Attrs::STRIKE);
        }
        let r = b.build(&f, &RenderState::default(), &mut g);
        assert_eq!(r.quads, 2, "one underline and one strike over three cells");
        let u = b.instances()[0];
        assert_eq!((u.pos[1], u.size[0], u.size[1]), (14.0, 24.0, 1.0));
    }

    fn with_cursor(mut f: Frame, row: u16, col: u16, shape: CursorShape) -> Frame {
        f.cursor = Cursor {
            row,
            col,
            shape,
            visible: true,
        };
        f
    }

    #[test]
    fn moving_the_cursor_touches_only_the_old_and_new_rows() {
        let mut b = builder();
        let mut g = Stub::default();
        let rows = ["ab"; 6];
        let f = with_cursor(text_frame(&rows, 1), 1, 0, CursorShape::Block);
        b.build(&f, &RenderState::default(), &mut g);
        // Same content, nothing damaged, cursor moved from row 1 to row 4.
        let f2 = damaged(
            with_cursor(text_frame(&rows, 1), 4, 1, CursorShape::Block),
            1,
            &[],
        );
        let r = b.build(&f2, &RenderState::default(), &mut g);
        assert_eq!(r.rows, vec![1, 4]);
    }

    #[test]
    fn a_blinking_cursor_redraws_one_row() {
        let mut b = builder();
        let mut g = Stub::default();
        let f = with_cursor(text_frame(&["ab", "cd", "ef"], 1), 2, 0, CursorShape::Bar);
        b.build(&f, &RenderState::default(), &mut g);
        let off = RenderState {
            cursor_on: false,
            ..Default::default()
        };
        let r = b.build(&damaged(f.clone(), 1, &[]), &off, &mut g);
        assert_eq!(r.rows, vec![2]);
        let r = b.build(&damaged(f.clone(), 1, &[]), &RenderState::default(), &mut g);
        assert_eq!(r.rows, vec![2]);
    }

    #[test]
    fn a_block_cursor_recolours_its_cell_and_an_unfocused_one_is_hollow() {
        let mut b = builder();
        let mut g = Stub::default();
        let theme = Theme::default();
        let f = with_cursor(text_frame(&["a"], 1), 0, 0, CursorShape::Block);
        b.build(&f, &RenderState::default(), &mut g);
        let bg = b.instances()[0];
        assert_eq!(bg.color.to_le_bytes()[..3], theme.cursor);
        let glyph = b.instances()[1];
        assert_eq!(
            glyph.color.to_le_bytes()[..3],
            theme.bg,
            "text inverts to the background"
        );

        let unfocused = RenderState {
            focused: false,
            ..Default::default()
        };
        let r = b.build(&damaged(f.clone(), 1, &[]), &unfocused, &mut g);
        assert_eq!(r.rows, vec![0]);
        // glyph + four edge rects, no filled background.
        assert_eq!(r.quads, 5);
    }

    #[test]
    fn cursor_shapes_each_add_one_part() {
        for shape in [CursorShape::Bar, CursorShape::Underline] {
            let mut b = builder();
            let mut g = Stub::default();
            let f = with_cursor(text_frame(&[" "], 1), 0, 0, shape);
            let r = b.build(&f, &RenderState::default(), &mut g);
            assert_eq!(r.quads, 1, "{shape:?}");
        }
    }

    #[test]
    fn a_hidden_cursor_draws_nothing() {
        let mut b = builder();
        let mut g = Stub::default();
        let mut f = with_cursor(text_frame(&[" "], 1), 0, 0, CursorShape::Block);
        f.cursor.visible = false;
        assert_eq!(b.build(&f, &RenderState::default(), &mut g).quads, 0);
    }

    #[test]
    fn extending_a_selection_touches_only_the_rows_that_changed() {
        let mut b = builder();
        let mut g = Stub::default();
        let rows = ["abcd"; 6];
        let f = text_frame(&rows, 1);
        let sel = |end_row: u16| RenderState {
            selection: Some(Selection {
                start: (1, 1),
                end: (end_row, 2),
                block: false,
            }),
            ..Default::default()
        };
        b.build(&f, &sel(2), &mut g);
        let r = b.build(&damaged(f.clone(), 1, &[]), &sel(4), &mut g);
        // Row 2 changes from "up to col 2" to the whole row; rows 3 and 4 are new.
        assert_eq!(r.rows, vec![2, 3, 4]);
        let r = b.build(&damaged(f.clone(), 1, &[]), &RenderState::default(), &mut g);
        assert_eq!(
            r.rows,
            vec![1, 2, 3, 4],
            "clearing redraws what was selected"
        );
    }

    #[test]
    fn selected_cells_use_the_selection_colour() {
        let mut b = builder();
        let mut g = Stub::default();
        let theme = Theme::default();
        let f = text_frame(&["abc"], 1);
        let state = RenderState {
            selection: Some(Selection {
                start: (0, 0),
                end: (0, 1),
                block: false,
            }),
            ..Default::default()
        };
        b.build(&f, &state, &mut g);
        let bg = b.instances()[0];
        assert_eq!(bg.size, [16.0, 16.0]);
        assert_eq!(bg.color.to_le_bytes()[..3], theme.selection_bg);
    }

    #[test]
    fn rebuilding_a_row_with_fewer_quads_clears_the_leftovers() {
        let mut b = builder();
        let mut g = Stub::default();
        b.build(&text_frame(&["abc"], 1), &RenderState::default(), &mut g);
        let r = b.build(
            &damaged(text_frame(&["a  "], 2), 1, &[(0, 0)]),
            &RenderState::default(),
            &mut g,
        );
        assert_eq!(r.quads, 1);
        let visible = b.instances().iter().filter(|i| !i.is_empty()).count();
        assert_eq!(visible, 1, "stale instances from the old row must be wiped");
        // The upload covers the old extent so the GPU copy is wiped too.
        assert_eq!(r.uploads[0].len, 3);
    }

    #[test]
    fn rows_never_overrun_their_region() {
        let mut b = builder();
        let mut g = Stub::default();
        // 1 column: capacity is INSTANCES_PER_COL. Pile on decorations + cursor.
        let mut f = text_frame(&["a", "b"], 1);
        f.cells[0].attrs = Attrs(Attrs::UNDERLINE | Attrs::STRIKE);
        f.cells[0].bg = Color::Rgb(1, 1, 1);
        let f = with_cursor(f, 0, 0, CursorShape::Bar);
        b.build(&f, &RenderState::default(), &mut g);
        assert_eq!(
            b.instances().len(),
            2 * INSTANCES_PER_COL + OVERLAY_INSTANCES
        );
        // Row 1 starts with its own glyph, untouched by row 0.
        assert!(!b.instances()[INSTANCES_PER_COL].is_empty());
    }
}
